#!/usr/bin/env node
/**
 * similarweb-query.mjs —— 查一个域名的 Similarweb 报表（**官方 Pro 的同源 JSON API**）。
 *
 * 数据来源是用户自己的 **pro.similarweb.com**，不是哥飞的共享面板（sim.3ue.co）。
 * 面板那条通道的登录态早在 2026-10-13 就失效了，而且它需要把报表**渲染出来**再
 * 从 DOM 里抠数——于是整个脚本长出了一大堆只服务于渲染的机制：等锚点、滚动到底、
 * 盯 document.hidden、抓页面自己显示的窗口文案跟请求的窗口比对、窗口不一致就拒绝
 * 收数……这些机制本身没错，但它们的存在理由（渲染）已经没有了。
 *
 * Pro 的每条报表背后都是一条**同源 JSON API**。实测（2026-10-13，全程在已登录的
 * Pro 页上下文里 fetch，不渲染、不滚动、不读 DOM）：
 *   - 字段比 DOM 表更多（M49 国家 id、Affinity、KwVolume、ExclusiveAudience…）；
 *   - 窗口由 API 自己钉死（`isWindow=true&latest=28d|6m`），**不需要日期运算**，
 *     也就不存在「页面渲染出来的窗口跟请求的不一致」这一类问题——那条判据随面板
 *     一起删掉了，不再产出 windowMatchesRequest / scope-mismatch / unconfirmed*；
 *   - 取数不依赖页面可见，所以窗口默认 `background`（不抢焦点、不占用户屏幕）。
 *
 * 【三条纪律】
 * 1. **同源 fetch 只在 lib-similarweb-pro.mjs 里发**——SPA 头、登录态落点断言、
 *    HTML/403 的解释都在那儿（漏一个头就是 CloudFront 403，且返回 HTML 而不是
 *    JSON，症状是「这个站没数据」）。
 * 2. **失败要能一眼分清真因**：错误码把「HTTP != 200 / 返回 HTML（登录态失效）/
 *    body 不是 JSON」分开，别让人对着「拿到 0 行」去猜。
 * 3. **窗口与口径写进输出**：`windowRequested` 是请求的口径，`windowLabel` 是同一
 *    件事的可读说法，`country: 999` = Worldwide。所有报表都是 Worldwide + 所有
 *    流量（webSource=Total），这一份脚本没有国家/设备筛选参数——实测能加，但
 *    当前需求不需要，就不留空开关。
 *
 * 用法：
 *   node scripts/similarweb-query.mjs --domain example.com
 *   node scripts/similarweb-query.mjs --domain example.com --report channels --out out.json
 *   node scripts/similarweb-query.mjs --domain example.com --report site-keywords --traffic-tab paid
 *   node scripts/similarweb-query.mjs --domain example.com --report audience-overlap --compare adobe.com,figma.com
 *   node scripts/similarweb-query.mjs --domain example.com --report audience-demographics --gender male --age 35-44
 *   node scripts/similarweb-query.mjs --self-test
 *
 * 参数：
 *   --domain <d>            必填（--self-test 与 --help 时不需要）
 *   --report <r>            performance（默认）| channels | similar-sites | audience-geo
 *                           | site-keywords | audience-interests | audience-overlap
 *                           | audience-demographics
 *   --traffic-tab <t>       仅 site-keywords：organic（默认）| paid。**没有 total**——
 *                           实测 API 只认 SourceType=Organic|Paid，传别的（含 All、
 *                           省略）一律 400 `Only 'Organic' and 'Paid' SourceTypes
 *                           are allowed`，所以 CLI 里不留一个必然失败的 total 选项。
 *   --compare <d1,d2[,d3]>  仅 audience-overlap：要跟主域名放在一起比对的域名。
 *                           不传时**报错退出**，不去猜「页面默认会选哪几个相似站」——
 *                           猜错了就是拿别人的受众数据当成你的。
 *   --gender <g>            仅 audience-demographics：female（默认）| male
 *   --age <a>               仅 audience-demographics：18-24（默认）| 25-34 | 35-44 |
 *                           45-54 | 55-64 | 65+（映射到 API 的 ageBuckets=区间下界，
 *                           见 AGE_BUCKETS 旁注）
 *   --out <file>            落盘 JSON
 *   --profile <id>          持有 Pro 登录态的 Browser Bridge profile（默认 msht4gxm）
 *   --session <name>        忽略：similarweb 是配额站，会话名固定 similarweb-nav
 *   --window <mode>         标签页窗口模式（默认 background）——同源 fetch 不依赖渲染
 *   --wait <s>              打开落地页后等几秒（默认 8）
 *   --timeout <ms>          单次 eval 超时（默认 60000）
 *   --keep-open             跑完保留标签页
 *   --self-test             离线自检
 *   --help                  本说明
 *
 * 【输出契约——调用方在读，改动前先看这里】
 *   - `status`：ok | no-data（API 明说没有这个站的收录）| unavailable（这次没取到）
 *   - `metrics.*`（仅 performance）：totalVisits / monthlyVisits / windowLabel /
 *     globalRank / countryRank / industryRank / bounceRatePercent / pagesPerVisit /
 *     visitDuration（`HH:MM:SS`）
 *   - `channels.*`（仅 channels）：totalFromChannels / sharePercent / visits
 *   - `rawText`：本次取数的纯文本摘要（窗口行 + 设备占比行 + 关键数值），
 *     traffic-crosscheck.mjs 用它判窗口与设备占比——**别改成 JSON 摘要**
 *   - `url` / `report` / `domain` / `retrievedAt`：证据与溯源
 */
import { writeFile } from 'node:fs/promises';
import {
  closeSession, parseFlags, printJson, required, resolveSession, showHelpIfRequested,
} from './opencli-core.mjs';
import {
  openSimilarwebPro, resolveSimilarwebProProfile, SIMILARWEB_PRO_ORIGIN, swProRequest,
} from './lib-similarweb-pro.mjs';

const ORIGIN = SIMILARWEB_PRO_ORIGIN;
/** Similarweb 的 Worldwide。所有报表都钉在这个口径上。 */
const COUNTRY = '999';
const COUNTRY_LABEL = 'Worldwide';
/** 单页上限。API 的 pageSize 到 100 就打住，读全了没有由 rowsRead/totalCount 说清。 */
const PAGE_SIZE = 100;

/** 渠道名——跟 API 返回的 key 逐字一致（实测：Data.Total.<域>.<渠道名>）。 */
const CHANNEL_KEYS = [
  'Direct', 'Search - Organic', 'Search - Paid', 'Referrals', 'Display Ads',
  'Social - Organic', 'Social - Paid', 'Gen AI', 'Email', 'Affiliates',
];

const flags = parseFlags(process.argv.slice(2));
showHelpIfRequested(flags, import.meta.url);

/**
 * 报表定义。`windowSeg` 是请求里写死的窗口段（API 自己解释，脚本不做日期运算）：
 *   - 28d → 近 28 天（performance / channels / similar-sites / site-keywords）
 *   - 6m  → 近 6 个月（受众四张表：地理/兴趣/重叠/人口特征）
 */
const REPORTS = {
  performance: { windowSeg: '28d' },
  channels: { windowSeg: '28d' },
  'similar-sites': { windowSeg: '28d' },
  'audience-geo': { windowSeg: '6m' },
  'site-keywords': { windowSeg: '28d' },
  'audience-interests': { windowSeg: '6m' },
  'audience-overlap': { windowSeg: '6m' },
  'audience-demographics': { windowSeg: '6m' },
};

/** `isWindow=true&latest=<seg>`：窗口由 API 自己钉死，传什么 from/to 都不改结果。 */
const windowParam = (seg) => `isWindow=true&latest=${seg}`;

/**
 * 人口特征的年龄组 → API 的 `ageBuckets`。
 * **实测（2026-10-13，canva.com）：把 ageBuckets 依次设成 18/25/35/45/55/65，
 * 六次返回的 UniqueVisitorsRatio 各不相同**，说明这个参数就是年龄组的判别符；
 * 命名规则取区间下界（18-24→18、25-34→25…），跟页面默认落在 18 一致。
 */
const AGE_BUCKETS = {
  '18-24': '18', '25-34': '25', '35-44': '35', '45-54': '45', '55-64': '55', '65+': '65',
};
const GENDERS = new Set(['female', 'male']);

/* ------------------------------------------------------------------ *
 * URL 拼装（纯函数，--self-test 覆盖）
 * ------------------------------------------------------------------ */

const q = (params) => Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
const enc = encodeURIComponent;

/** 站点头部（排名/行业/标题/主流量国）。**它不随窗口变**，所以不带窗口参数。 */
export function headerUrl(domain) {
  return `${ORIGIN}/api/WebsiteOverview/getheader?${q({ keys: enc(domain), mainDomainOnly: 'true', includeCrossData: 'true' })}`;
}

/** 总访问量（窗口内累计）。 */
export function visitsUrl(domain, seg) {
  return `${ORIGIN}/widgetApi/WebsiteOverview/EngagementVisits/Table?${q({
    country: COUNTRY, timeGranularity: 'Monthly', includeSubDomains: 'true', keys: enc(domain), webSource: 'Total',
  })}&${windowParam(seg)}`;
}

/** 参与度概览：跳出率/页数每访问/平均访问时长/月均访问量。 */
export function engagementUrl(domain, seg) {
  return `${ORIGIN}/widgetApi/WebsiteOverview/EngagementOverview/Table?${q({
    country: COUNTRY, webSource: 'Total', includeSubDomains: 'true', timeGranularity: 'Monthly', keys: enc(domain),
  })}&${windowParam(seg)}`;
}

/** 桌面/移动占比（饼图，返回绝对访问数，占比由脚本自己算）。 */
export function deviceUrl(domain, seg) {
  return `${ORIGIN}/widgetApi/WebsiteOverview/EngagementDesktopVsMobileVisits/PieChart?${q({
    country: COUNTRY, includeSubDomains: 'true', timeGranularity: 'Monthly', keys: enc(domain), webSource: 'Total',
  })}&${windowParam(seg)}`;
}

/** 访问趋势（逐月绝对访问数）——单条 XHR，不是从 SVG 折线里读数。 */
export function trendUrl(domain, seg) {
  return `${ORIGIN}/widgetApi/WebsiteOverview/EngagementVisits/Graph?${q({
    country: COUNTRY, timeGranularity: 'Monthly', includeSubDomains: 'true', keys: enc(domain), webSource: 'Total',
  })}&${windowParam(seg)}`;
}

/** 渠道分布（饼图）：Data.Total.<域>.<渠道名> = 该渠道的访问数。 */
export function channelsUrl(domain, seg) {
  return `${ORIGIN}/widgetApi/MarketingMixTotal/TrafficSourcesOverview/PieChart?${q({
    country: COUNTRY, includeSubDomains: 'true', timeGranularity: 'Monthly', keys: enc(domain),
  })}&${windowParam(seg)}`;
}

/** 相似站（Spotlight）：Domain / Affinity / Rank / Category / HasAdsense。 */
export function similarSitesUrl(domain, seg) {
  return `${ORIGIN}/widgetApi/WebsiteCompetitors/SimilarSites/Table?${q({
    country: COUNTRY, includeSubDomains: 'true', keys: enc(domain), orderBy: enc('Affinity desc'), timeGranularity: 'Monthly', pageSize: PAGE_SIZE,
  })}&${windowParam(seg)}`;
}

/** 地理分布：Country 是 M49 数字 id，国家名在同响应的 Filters.country[] 里。 */
export function geoUrl(domain, seg) {
  return `${ORIGIN}/widgetApi/WebsiteGeography/Geography/Table?${q({
    country: COUNTRY, includeSubDomains: 'true', webSource: 'Total', timeGranularity: 'Monthly', orderBy: enc('TotalShare desc'), keys: enc(domain), pageSize: PAGE_SIZE,
  })}&${windowParam(seg)}`;
}

/** 自然/付费搜索词。SourceType 只认 Organic|Paid（实测，见 --traffic-tab 帮助）。 */
export function keywordsUrl(domain, seg, sourceType) {
  return `${ORIGIN}/widgetApi/SearchKeywordsV2/WebsitePerformance/Table?${q({
    country: COUNTRY, includeSubDomains: 'true', keys: enc(domain), webSource: 'Total', SourceType: sourceType, pageSize: PAGE_SIZE, timeGranularity: 'Monthly',
  })}&${windowParam(seg)}`;
}

/** 受众兴趣（行业分布 + 话题词云 + 相关站点榜，一条端点全给）。 */
export function interestsUrl(domain, seg) {
  return `${ORIGIN}/api/websiteanalysis/GetAudienceInterestsTable?${q({
    key: enc(domain), isWWW: 'false', country: COUNTRY, webSource: 'Total', selectedTab: 'audienceInterests', orderBy: enc('RelevancyScore desc'),
  })}&${windowParam(seg)}`;
}

/** 受众重叠：Data 里同时给出各站受众规模、两两/三三重叠规模与独占受众。 */
export function overlapUrl(keys, seg) {
  return `${ORIGIN}/widgetApi/WebAudienceOverlap/AudienceOverlap/Data?${q({
    includeSubDomains: 'true', keys: keys.map(enc).join('%2C'), country: COUNTRY, webSource: 'Total', timeGranularity: 'Monthly',
  })}&${windowParam(seg)}`;
}

/** 人口特征：Sectors 给性别/年龄大盘，Buckets 给「性别×年龄组」这一格的参与度。 */
export function demographicsUrls(domain, seg, { gender, age }) {
  const male = gender === 'male';
  return {
    sectors: `${ORIGIN}/widgetApi/DemographicSegments/Sectors/Table?${q({
      country: COUNTRY, webSource: 'Total', includeSubDomains: 'true', keys: enc(domain),
    })}&${windowParam(seg)}`,
    bucket: `${ORIGIN}/widgetApi/DemographicSegments/Buckets/Table?${q({
      country: COUNTRY, webSource: 'Total', includeSubDomains: 'true', keys: enc(domain), ageBuckets: AGE_BUCKETS[age],
      maleData: String(male), femaleData: String(!male),
    })}&${windowParam(seg)}`,
  };
}

/* ------------------------------------------------------------------ *
 * 纯解析/换算（--self-test 覆盖）
 * ------------------------------------------------------------------ */

/**
 * 数字归一化。**null/undefined/空串必须原样落成 null**——`Number(null)` 是 0，
 * 少了这一层，「没有这个值」会被写成「值是 0」（本仓库反复吃过这个亏，
 * `difficulty: 0` 与 `latestZeroClicks: null` 是同一件事的两面）。
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => (n === null ? null : Number(n.toFixed(2)));

/** API 的 0~1 比例 → 百分比。**缺值仍然是 null**（`?? 0` 会把「没有」写成「0%」）。 */
const pct = (v) => { const n = num(v); return n === null ? null : round2(n * 100); };

/**
 * 秒 → `HH:MM:SS`。字段名沿用 `visitDuration`，老契约（traffic-crosscheck 的
 * `durationToSeconds`）认 `^\d{1,3}(:\d{2}){1,2}$`，这里给的是更规整的那种。
 */
export function formatDuration(seconds) {
  const s = num(seconds);
  if (s === null || s < 0) return null;
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * 渠道绝对数 → 本仓库一直在用的 `channels` 形状。
 * **占比一律由绝对值现算**，不去 API 里找另一个百分比字段——两处百分比来源不同
 * 就会有对不上的时候，而绝对数是唯一的原始事实。
 */
export function channelShares(visits) {
  const clean = {};
  for (const key of CHANNEL_KEYS) {
    if (visits?.[key] !== undefined) clean[key] = num(visits[key]);
  }
  const total = Object.values(clean).reduce((a, v) => a + (v || 0), 0);
  const sharePercent = {};
  if (total > 0) {
    for (const [k, v] of Object.entries(clean)) {
      if (v !== null) sharePercent[k] = round2((v / total) * 100);
    }
  }
  return { totalFromChannels: total || null, sharePercent, visits: clean };
}

/** `2026-09-01` → `Sep 2026`；认不出的原样返回 null，不猜。 */
export function monthLabel(isoKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoKey ?? ''));
  if (!m) return null;
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const idx = Number(m[2]) - 1;
  return names[idx] ? `${names[idx]} ${m[1]}` : null;
}

/** 桌面/移动饼图 → 两个占比。分母是两者之和，缺失或被拦时返回 null（不写 0）。 */
export function deviceShares(pie) {
  const desktop = num(pie?.Desktop);
  const mobile = num(pie?.['Mobile Web']);
  if (desktop === null || mobile === null || desktop + mobile <= 0) {
    return { desktopSharePercent: null, mobileSharePercent: null };
  }
  return {
    desktopSharePercent: round2((desktop / (desktop + mobile)) * 100),
    mobileSharePercent: round2((mobile / (desktop + mobile)) * 100),
  };
}

/** 地理表 → 行；国家名从同响应的 Filters.country 映射（id 可能是数字也可能是字符串）。 */
export function mapGeoRows(payload) {
  const names = new Map((payload?.Filters?.country ?? []).map((c) => [String(c.id), c.text ?? null]));
  return (payload?.Data ?? []).map((r) => ({
    countryId: r?.Country ?? null,
    country: names.get(String(r?.Country)) ?? null,
    sharePercent: pct(r?.Share),
    usersSharePercent: pct(r?.UsersShare),
    changePercent: r?.Change === undefined || r.Change === null ? null : pct(r.Change),
    avgVisitDuration: formatDuration(r?.AvgVisitDuration),
    pagesPerVisit: num(r?.PagePerVisit),
    bounceRatePercent: pct(r?.BounceRate),
    rank: num(r?.Rank),
  }));
}

/** 相似站表 → 行。Category 原样保留（`A~B` 这种带父类的形态是 API 自己的编码）。 */
export function mapSimilarSites(payload) {
  return (payload?.Data ?? []).map((r) => ({
    domain: r?.Domain ?? null,
    affinity: num(r?.Affinity),
    rank: num(r?.Rank),
    category: r?.Category ?? null,
    hasAdsense: Boolean(r?.HasAdsense),
  }));
}

/** 搜索词表 → 行。位置是 `[{Key,Value}]`，取本域那一条。 */
export function mapKeywordRows(payload, domain) {
  const position = (list) => {
    const hit = (list ?? []).find((p) => p?.Key === domain);
    return hit && Number.isFinite(Number(hit.Value)) && Number(hit.Value) > 0 ? Number(hit.Value) : null;
  };
  return (payload?.Data ?? []).map((r) => ({
    searchTerm: r?.SearchTerm ?? null,
    kwVolume: num(r?.KwVolume),
    cpc: num(r?.CPC),
    totalVisits: num(r?.TotalVisits),
    totalSharePercent: pct(r?.TotalShare),
    changePercent: r?.Change === undefined || r.Change === null ? null : pct(r.Change),
    positionOrganic: position(r?.PositionOrganic),
    positionPaid: position(r?.PositionPaid),
  }));
}

/**
 * 受众兴趣 → 行 + 行业分布 + 话题词云。
 * `Categories`/`Topics` 的 `Value` 是 0~1 的比例，输出统一成百分比。
 */
export function mapInterests(payload, domain) {
  const rows = (payload?.Records ?? []).map((r) => ({
    domain: r?.Domain ?? null,
    category: r?.Category ?? null,
    overlapPercent: pct(r?.Overlap),
    relevancyScore: num(r?.RelevancyScore),
    relevancyRank: num(r?.RelevancyRank),
    rank: num(r?.Rank),
    hasAdsense: Boolean(r?.HasAdsense),
  }));
  const pick = (list) => (list ?? []).map((x) => ({
    name: x?.Name ?? null,
    sharePercent: pct(x?.Value),
    ...(x?.Count === undefined ? {} : { sites: num(x.Count) }),
  })).filter((x) => x.name);
  return {
    totalCount: num(payload?.TotalCount),
    rows,
    rowsRead: rows.length,
    categories: pick(payload?.Categories?.[domain] ?? Object.values(payload?.Categories ?? {})[0]),
    topics: pick(payload?.Topics),
  };
}

/** 人口特征大盘：FemalesRatio 原样保留（API 只给这一个性别比例，male 由读者自己减）。 */
function mapSectors(node) {
  const ratios = node?.AgeRatios ?? {};
  return {
    femalesRatioPercent: pct(node?.FemalesRatio),
    ageRatiosPercent: Object.fromEntries(
      Object.entries(ratios).map(([k, v]) => [k, pct(v)]),
    ),
  };
}

function mapBucket(node) {
  return {
    uniqueVisitorsRatioPercent: pct(node?.UniqueVisitorsRatio),
    competitiveShare: num(node?.CompetitiveShare),
    pagesPerVisit: num(node?.PagesPerVisit),
    bounceRatePercent: pct(node?.BounceRate),
    avgVisitDuration: formatDuration(node?.Duration),
  };
}

/** 同响应的 `{<域>: {...}}` 里取本域那一条（Key 可能是域本身，也可能是别的域）。 */
const nodeFor = (payload, domain) => payload?.[domain] ?? Object.values(payload ?? {})[0] ?? {};

/** 趋势图 `Data.<域>.Total` 是数组套数组，摊平后逐月给。 */
function mapTrend(node, domain) {
  const series = node?.[domain]?.Total ?? Object.values(node ?? {})[0]?.Total;
  const flat = (Array.isArray(series) ? series : []).flat();
  return flat
    .map((p) => ({ period: p?.Key ?? null, monthLabel: monthLabel(p?.Key), visits: num(p?.Value) }))
    .filter((p) => p.period);
}

/* ------------------------------------------------------------------ *
 * 各报表取数
 * ------------------------------------------------------------------ */

/** 每个取数函数返回 `{ fields, rawText, urls, noData }`——形状统一，主流程只管拼装。 */
const ok = (fields, rawText, urls, noData = false) => ({ fields, rawText, urls, noData });

async function reportPerformance({ session, domain, seg, profile, timeoutMs }) {
  const urls = {
    header: headerUrl(domain), visits: visitsUrl(domain, seg), engagement: engagementUrl(domain, seg),
    device: deviceUrl(domain, seg), trend: trendUrl(domain, seg),
  };
  const opt = { profile, timeoutMs };
  const [header, visits, engagement, device, trend] = await Promise.all([
    swProRequest(session, urls.header, { ...opt, what: 'getheader' }),
    swProRequest(session, urls.visits, { ...opt, what: 'EngagementVisits/Table' }),
    swProRequest(session, urls.engagement, { ...opt, what: 'EngagementOverview/Table' }),
    swProRequest(session, urls.device, { ...opt, what: 'EngagementDesktopVsMobileVisits/PieChart' }),
    swProRequest(session, urls.trend, { ...opt, what: 'EngagementVisits/Graph' }),
  ]);
  const h = nodeFor(header, domain);
  const v = (visits?.Data ?? [])[0] ?? {};
  const e = (engagement?.Data ?? [])[0] ?? {};
  const totalVisits = num(v.TotalVisits);
  // **「没有这个站的收录」= 没有总访问量，且排名为 0/缺**——不是「流量为 0」。
  const noData = totalVisits === null && !(num(h.globalRanking) > 0);
  // 饼图类端点把结果包在 `Data.<域>` 里（表类端点直接是 `Data[]`，头部是 `{<域>: …}`）——
  // 三种形状各不相同，取错一层就是「占比读成 null」。
  const shares = deviceShares(device?.Data?.[domain] ?? {});
  const trendMonths = mapTrend(trend?.Data, domain);
  const months = trendMonths.filter((p) => p.monthLabel).map((p) => p.monthLabel);
  const metrics = {
    totalVisits,
    monthlyVisits: num(e.AvgMonthVisits),
    windowLabel: `Last 28 days`,
    globalRank: num(h.globalRanking) > 0 ? num(h.globalRanking) : null,
    countryRank: num(h.highestTrafficCountryRanking),
    industryRank: num(h.categoryRanking),
    bounceRatePercent: pct(e.BounceRate),
    pagesPerVisit: num(e.PagesPerVisit),
    visitDuration: formatDuration(e.AvgVisitDuration),
  };
  const rawText = [
    domain,
    metrics.windowLabel,
    months.length >= 2 ? `${months[0]} - ${months[months.length - 1]}` : null,
    shares.desktopSharePercent === null ? null : `Desktop ${shares.desktopSharePercent}%`,
    shares.mobileSharePercent === null ? null : `Mobile Web ${shares.mobileSharePercent}%`,
  ].filter(Boolean).join('\n');
  return ok({
    metrics,
    siteHeader: {
      title: h.title ?? null, description: h.description ?? null,
      category: h.category ?? null, categoryRanking: num(h.categoryRanking),
      topCountryId: h.highestTrafficCountry ?? null,
      topCountryRanking: num(h.highestTrafficCountryRanking),
      employeeRange: h.employeeRange ?? null,
      yearFounded: h.yearFounded ?? null,
    },
    deviceSplit: shares,
    trendGraph: trendMonths,
  }, rawText, urls, noData);
}

async function reportChannels({ session, domain, seg, profile, timeoutMs }) {
  const urls = { channels: channelsUrl(domain, seg) };
  const payload = await swProRequest(session, urls.channels, { profile, timeoutMs, what: 'TrafficSourcesOverview/PieChart' });
  const byChannel = payload?.Data?.Total?.[domain] ?? {};
  const channels = channelShares(byChannel);
  const noData = channels.totalFromChannels === null;
  const rawText = [
    domain, 'Last 28 days',
    ...CHANNEL_KEYS.filter((k) => channels.visits[k] !== undefined)
      .map((k) => `${k} ${channels.visits[k]}`),
  ].filter(Boolean).join('\n');
  return ok({ channels }, rawText, urls, noData);
}

async function reportSimilarSites({ session, domain, seg, profile, timeoutMs }) {
  const urls = { similarSites: similarSitesUrl(domain, seg) };
  const payload = await swProRequest(session, urls.similarSites, { profile, timeoutMs, what: 'SimilarSites/Table' });
  const rows = mapSimilarSites(payload);
  return ok({
    similarSites: { rows, rowsRead: rows.length, totalCount: num(payload?.TotalCount) },
  }, [domain, 'Last 28 days', rows[0]?.domain ?? null].filter(Boolean).join('\n'), urls, rows.length === 0);
}

async function reportAudienceGeo({ session, domain, seg, profile, timeoutMs }) {
  const urls = { geo: geoUrl(domain, seg) };
  const payload = await swProRequest(session, urls.geo, { profile, timeoutMs, what: 'WebsiteGeography/Geography/Table' });
  const rows = mapGeoRows(payload);
  return ok({
    geo: { rows, rowsRead: rows.length, totalCount: num(payload?.TotalCount), country: COUNTRY, countryLabel: COUNTRY_LABEL },
  }, [domain, 'Last 6 months', rows[0]?.country ?? null].filter(Boolean).join('\n'), urls, rows.length === 0);
}

async function reportSiteKeywords({ session, domain, seg, profile, timeoutMs, trafficTab }) {
  const sourceType = trafficTab === 'paid' ? 'Paid' : 'Organic';
  const urls = { keywords: keywordsUrl(domain, seg, sourceType) };
  const payload = await swProRequest(session, urls.keywords, { profile, timeoutMs, what: `SearchKeywordsV2 (${sourceType})` });
  const rows = mapKeywordRows(payload, domain);
  return ok({
    keywords: { sourceType, rows, rowsRead: rows.length, totalCount: num(payload?.TotalCount) },
  }, [domain, 'Last 28 days', rows[0]?.searchTerm ?? null].filter(Boolean).join('\n'), urls, rows.length === 0);
}

async function reportAudienceInterests({ session, domain, seg, profile, timeoutMs }) {
  const urls = { interests: interestsUrl(domain, seg) };
  const payload = await swProRequest(session, urls.interests, { profile, timeoutMs, what: 'GetAudienceInterestsTable' });
  const interests = mapInterests(payload, domain);
  return ok({ audienceInterests: interests },
    [domain, 'Last 6 months', interests.rows[0]?.domain ?? null].filter(Boolean).join('\n'), urls, interests.rows.length === 0);
}

async function reportAudienceOverlap({ session, domain, seg, profile, timeoutMs, compare }) {
  const keys = [domain, ...compare];
  const urls = { overlap: overlapUrl(keys, seg) };
  const payload = await swProRequest(session, urls.overlap, { profile, timeoutMs, what: 'WebAudienceOverlap/AudienceOverlap/Data' });
  const data = payload?.OverlapData ?? {};
  const sizes = Object.entries(data.Data ?? {}).map(([k, v]) => ({ domains: k.split(','), audienceSize: num(v) }));
  const exclusive = Object.entries(data.ExclusiveAudience ?? {}).map(([k, v]) => ({
    domains: k.split(','),
    exclusive: Object.entries(v ?? {}).map(([other, n]) => ({ vsDomains: other.split(','), audienceSize: num(n) })),
  }));
  const trend = Object.entries(data.Graph ?? {}).map(([k, series]) => ({
    domains: k.split(','),
    months: (series ?? []).map((p) => ({ period: p?.Key ?? null, monthLabel: monthLabel(p?.Key), visits: num(p?.Value) })),
  }));
  return ok({
    audienceOverlap: { keys, audienceSizes: sizes, exclusiveAudience: exclusive, trend, rowsRead: sizes.length },
  }, [domain, 'Last 6 months', keys.join(' / ')].filter(Boolean).join('\n'), urls, sizes.length === 0);
}

async function reportAudienceDemographics({ session, domain, seg, profile, timeoutMs, gender, age }) {
  const urls = demographicsUrls(domain, seg, { gender, age });
  const [sectors, bucket] = await Promise.all([
    swProRequest(session, urls.sectors, { profile, timeoutMs, what: 'DemographicSegments/Sectors/Table' }),
    swProRequest(session, urls.bucket, { profile, timeoutMs, what: 'DemographicSegments/Buckets/Table' }),
  ]);
  const sectorsNode = nodeFor(sectors, domain);
  const bucketNode = nodeFor(bucket, domain);
  const empty = Object.keys(sectorsNode).length === 0 && Object.keys(bucketNode).length === 0;
  return ok({
    audienceDemographics: {
      gender, age, ageBucket: AGE_BUCKETS[age],
      sectors: mapSectors(sectorsNode),
      bucket: mapBucket(bucketNode),
    },
  }, [domain, 'Last 6 months', `${gender} ${age}`].join('\n'), urls, empty);
}

const RUNNERS = {
  performance: reportPerformance,
  channels: reportChannels,
  'similar-sites': reportSimilarSites,
  'audience-geo': reportAudienceGeo,
  'site-keywords': reportSiteKeywords,
  'audience-interests': reportAudienceInterests,
  'audience-overlap': reportAudienceOverlap,
  'audience-demographics': reportAudienceDemographics,
};

/* ------------------------------------------------------------------ *
 * --self-test（离线，不连浏览器）
 * ------------------------------------------------------------------ */

function runSelfTest() {
  const assertEqual = (label, actual, expected) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`similarweb-query self-test failed [${label}]\n  actual:   ${a}\n  expected: ${e}`);
  };
  // 1) 窗口参数由 API 自己钉死——URL 里必须带 isWindow/latest，且不做日期运算。
  if (!visitsUrl('a.com', '28d').includes('isWindow=true&latest=28d')
    || !geoUrl('a.com', '6m').includes('isWindow=true&latest=6m')) {
    throw new Error('self-test failed [window]: isWindow/latest missing');
  }
  // 2) 域名必须编码（路径里带 / 或大小写混写的域名很常见）。
  if (!headerUrl('a.com/b').includes(`keys=${encodeURIComponent('a.com/b')}`)) throw new Error('self-test failed [enc]');
  // 3) 三个受众 tab 的端点各自可寻址。
  if (!interestsUrl('a.com', '6m').includes('selectedTab=audienceInterests')) throw new Error('self-test failed [interests]');
  if (!overlapUrl(['a.com', 'b.com'], '6m').includes('keys=a.com%2Cb.com')) throw new Error('self-test failed [overlap]');
  const dem = demographicsUrls('a.com', '6m', { gender: 'male', age: '35-44' });
  if (!dem.bucket.includes('ageBuckets=35') || !dem.bucket.includes('maleData=true&femaleData=false')) {
    throw new Error(`self-test failed [demographics]: ${dem.bucket}`);
  }
  // 4) 时长换算：秒 → HH:MM:SS（老契约认这个形状）。
  assertEqual('duration', formatDuration(336.86), '00:05:37');
  assertEqual('duration-null', formatDuration(null), null);
  // 5) 渠道占比由绝对数现算；缺一个渠道不写 0。
  const ch = channelShares({ Direct: 552304729.945, 'Search - Organic': 183331513.321, 'Gen AI': 13326394.569 });
  assertEqual('channel-total', ch.totalFromChannels, 552304729.945 + 183331513.321 + 13326394.569);
  if (Math.abs(ch.sharePercent.Direct - 73.73) > 0.5) throw new Error(`self-test failed [share]: ${JSON.stringify(ch.sharePercent)}`);
  if ('Search - Paid' in ch.visits) throw new Error('self-test failed [channel-absent]: 缺失的渠道不许被写成 0');
  // 6) 设备占比：分母是两者之和；任一侧缺失就整体 null，不写 0。
  assertEqual('device', deviceShares({ Desktop: 731840347.24, 'Mobile Web': 148891942.51 }), { desktopSharePercent: 83.09, mobileSharePercent: 16.91 });
  assertEqual('device-missing', deviceShares({ Desktop: 1 }), { desktopSharePercent: null, mobileSharePercent: null });
  // 7) 月份标签只认 ISO 月度 key，认不出就 null（不猜）。
  assertEqual('month', monthLabel('2026-09-01'), 'Sep 2026');
  assertEqual('month-bad', monthLabel('Sep 2026'), null);
  // 8) 地理行的国家名从 Filters 映射（id 可能是数字也可能是字符串）。
  const geo = mapGeoRows({ Data: [{ Country: 840, Share: 0.17, UsersShare: 0.18, Rank: 53 }], Filters: { country: [{ id: '840', text: 'United States' }] } });
  assertEqual('geo-name', geo[0].country, 'United States');
  assertEqual('geo-share', geo[0].sharePercent, 17);
  // 9) 关键词位置：本域那一条为 -1（无排名）时必须落 null，不许被当成第 1 名。
  const kw = mapKeywordRows({ Data: [{ SearchTerm: 'x', KwVolume: 100, PositionOrganic: [{ Key: 'a.com', Value: -1 }], TotalShare: 0.05 }] }, 'a.com');
  assertEqual('kw-position', kw[0].positionOrganic, null);
  assertEqual('kw-share', kw[0].totalSharePercent, 5);
  // 10) 兴趣：Records 与 Topics/Categories 的 0~1 比例都要变成百分比。
  const it = mapInterests({ Records: [{ Domain: 'b.com', Overlap: 0.84348, RelevancyRank: 1 }], Topics: [{ Name: 'news', Value: 0.0104 }], Categories: { 'a.com': [{ Name: 'Games', Count: 3, Value: 0.08 }] }, TotalCount: 10 }, 'a.com');
  assertEqual('interests-overlap', it.rows[0].overlapPercent, 84.35);
  assertEqual('interests-topic', it.topics[0].sharePercent, 1.04);
  assertEqual('interests-cat-sites', it.categories[0].sites, 3);
  // 11) 受众 tab 的性别/年龄参数只认白名单，别让拼错的值得出一个必然失败的请求。
  assertEqual('age-buckets', AGE_BUCKETS['65+'], '65');
  assertEqual('genders', [...GENDERS].sort(), ['female', 'male']);
  console.log('similarweb-query self-test: PASS');
}

if (flags['self-test']) { runSelfTest(); process.exit(0); }

// 参数校验必须在连浏览器之前做完——拼错的 --report/--traffic-tab 不该等到落地之后才失败。
if (flags.report !== undefined && !(flags.report in REPORTS)) {
  console.error(`--report must be one of: ${Object.keys(REPORTS).join(', ')}`);
  process.exit(2);
}
if (flags['traffic-tab'] !== undefined && !['organic', 'paid'].includes(String(flags['traffic-tab']))) {
  console.error("--traffic-tab must be organic or paid（total 在 API 上不存在：只认 SourceType=Organic|Paid）");
  process.exit(2);
}
if (flags.gender !== undefined && !GENDERS.has(String(flags.gender))) {
  console.error(`--gender must be one of: ${[...GENDERS].join(', ')}`);
  process.exit(2);
}
if (flags.age !== undefined && !(String(flags.age) in AGE_BUCKETS)) {
  console.error(`--age must be one of: ${Object.keys(AGE_BUCKETS).join(', ')}`);
  process.exit(2);
}

const domain = String(required(flags, 'domain')).trim().toLowerCase().replace(/^www\./, '');
const report = flags.report ?? 'performance';
const { windowSeg } = REPORTS[report];
const profile = resolveSimilarwebProProfile(flags);
const evalTimeoutMs = Number(flags.timeout || 60_000);
const keepOpen = Boolean(flags['keep-open']);
// 同源 fetch 不依赖页面渲染，所以默认用不抢焦点的 background。
const windowMode = typeof flags.window === 'string' && flags.window ? flags.window : 'background';
const trafficTab = String(flags['traffic-tab'] || 'organic');
const gender = String(flags.gender || 'female');
const age = String(flags.age || '18-24');
const compare = String(flags.compare ?? '').split(',').map((s) => s.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean);
if (report === 'audience-overlap' && !compare.length) {
  console.error('--compare <d1,d2[,d3]> is required for --report audience-overlap：'
    + '重叠表必须有第二个域名，脚本不去猜「页面默认会选哪几个相似站」。');
  process.exit(2);
}
// 配额站纪律：会话名固定 similarweb-nav（见 opencli-core 的 QUOTA_SITES）。
const session = resolveSession(flags, 'similarweb-query', 'similarweb');

const base = {
  version: 2,
  source: 'Similarweb official Pro (pro.similarweb.com) same-origin JSON API',
  retrievedAt: new Date().toISOString(),
  domain,
  report,
  session,
  country: Number(COUNTRY),
  countryLabel: COUNTRY_LABEL,
  windowRequested: windowSeg,
};

let output;
try {
  // 落地一次 + 断言落点在官方站：profile 用错 / 登录态失效在这里当场抛，
  // 不用等每一张表都返回 HTML 才发现。
  await openSimilarwebPro(session, null, { profile, windowMode, wait: Number(flags.wait || 8), timeoutMs: evalTimeoutMs });
  const result = await RUNNERS[report]({
    session, domain, seg: windowSeg, profile, timeoutMs: evalTimeoutMs, trafficTab, gender, age, compare,
  });
  output = {
    ...base,
    status: result.noData ? 'no-data' : 'ok',
    // 这份 JSON 里所有数值都来自 API 原始响应；urls 记下这次到底查了哪几条端点（证据）。
    url: result.urls[Object.keys(result.urls)[0]],
    urls: result.urls,
    // API 明说了「没有这个站的收录」——**观测事实，不是失败**，别和「这次没取到」混为一谈。
    noDataTextObserved: result.noData,
    ...result.fields,
    rawText: result.rawText,
  };
} catch (error) {
  output = {
    ...base,
    status: 'unavailable',
    // 三类成因三个码：HTTP != 200（接口/套餐）、返回 HTML（登录态失效/WAF）、别的。
    error: {
      code: /\bHTTP \d{3}\b/.test(error.message) ? 'http_error'
        : /返回的是 HTML/.test(error.message) ? 'session_or_waf_html'
          : 'query_failed',
      message: String(error?.message || error).slice(0, 500),
    },
    rawText: null,
  };
  process.exitCode = 1;
} finally {
  if (!keepOpen) await closeSession(session);
}

if (typeof flags.out === 'string') {
  await writeFile(flags.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}
printJson(output);
