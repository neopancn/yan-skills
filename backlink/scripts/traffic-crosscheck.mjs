#!/usr/bin/env node
/**
 * traffic-crosscheck.mjs — 把「同一个域名在 Semrush 和 Similarweb 上的流量数字
 * 互相校验」这件事沉淀成脚本。**纯离线**：只吃两份已经生成好的 JSON，自己不抓页面。
 *
 * ──────────────────────────────────────────────────────────────────────
 * 为什么需要它
 * ──────────────────────────────────────────────────────────────────────
 * 在此之前，仓库里三处脚本注释都写着「Semrush 的流量与 Similarweb 不同口径，
 * 不要并列」。那句话**对的是自然搜索口径**（Organic Research / semrush-report.mjs），
 * 但它读起来像「Semrush 根本没有可比的数」——而 Traffic & Market（.Trends）给的
 * 就是同口径的总访问量。这条线以前一直没摸到，所以从没比过。
 *
 * 2026-08-28 实测 `canva.com`，两个平台的总访问量落在 2.4% 以内：
 *
 *   | 指标         | Semrush .Trends（2026年7月，全球） | Similarweb | 差异   |
 *   |--------------|-----------------------------------|------------|--------|
 *   | 总访问量     | 790,000,000                       | 771,400,000| +2.4%  |
 *   | 桌面占比     | 84.26%                            | 82.56%     | +1.7pp |
 *   | 移动占比     | 15.74%                            | 17.44%     | −1.7pp |
 *   | 跳出率       | 30.23%                            | 26.99%     | +3.2pp |
 *   | 页数/访问    | 5.4                               | 6.39       | −15%   |
 *   | **平均访问时长** | **11:02**                     | **05:56**  | **+86%** |
 *
 * 两条结论，本脚本就是它们的执行体：
 *   1. **总访问量可以互相校验。** 两家用完全不同的面板和模型，落在 2.4% 以内。
 *   2. **平均访问时长两家口径不同，不能并列。** 差了近一倍，两家对「一次访问」的
 *      定义不同。这是**指标本身的属性**（不随某一次运行改变），所以脚本对它
 *      `comparable: false` 并原样给两侧数值，**连 diff 都不算**——一个百分比摆在
 *      那里，读者就会拿去用。
 *
 * ──────────────────────────────────────────────────────────────────────
 * 用法
 * ──────────────────────────────────────────────────────────────────────
 *   node traffic-crosscheck.mjs --semrush semrush.json --similarweb sw.json
 *   node traffic-crosscheck.mjs --semrush a.json --similarweb b.json --out cross.json --json
 *   node traffic-crosscheck.mjs --self-test
 *
 * 参数：
 *   --semrush <file>     `semrush-traffic.mjs --out` 的产物
 *   --similarweb <file>  `similarweb-query.mjs --out` 的产物（report=performance）
 *   --out <file> / --json / --help
 *
 * ──────────────────────────────────────────────────────────────────────
 * 本脚本**只出差值，不出判定**（第三波，2026-08-30）
 * ──────────────────────────────────────────────────────────────────────
 * 以前这里有一张 `agree / diverge / conflict` 分档表，阈值写死在代码里：
 * visits ≤15% 算「一致」、>50% 算「冲突」，占比 5pp，页数/访问 25%。那些数字
 * 没有任何一次实测支撑——它们是**当时随手定的**，却被输出成 `verdict` 字段，
 * 读起来像测量结论，还会让 `conflict` 把进程退成非零码。两个面板差 18% 到底
 * 算不算一回事，取决于窗口重合度、口径、这个站的量级和你要拿它干什么，
 * 这是**判断**，不是算术。
 *
 * 现在脚本只做算术：每个指标给 `{semrush, similarweb, diff, diffUnit,
 * diffBasis}`，两侧齐全就叫 `comparable: true`，缺一侧就 `comparable: false`
 * 加缺值原因。**没有 verdict 字段，没有阈值，没有因分歧而来的非零退出码。**
 * 差多少算不算问题，判读指引在
 * `backlink/references/traffic-screen.md` 的「两家数字对不上，先问哪个问题」一节。
 *
 * 相对差一律以 **Similarweb 侧为基**：`(semrush − similarweb) / similarweb × 100`。
 * 上表里的 +2.4% 和 −15% 就是这么算的，脚本和参考表用同一个基，读者不用换算。
 * `orderOfMagnitude: true` 也只是算术事实（一侧是另一侧的 ≥10 倍或 ≤1/10 倍），
 * 不是「有一边错了」的判决。
 *
 * ──────────────────────────────────────────────────────────────────────
 * 本仓库的硬性规则，本文件逐条遵守
 * ──────────────────────────────────────────────────────────────────────
 *  - **`null` 和 `0` 分开。** 任何一侧缺值 → 该指标 `comparable: false`，绝不当成 0。
 *    缺值的指标单独计数并列出 key，免得「没比成」被读成「比过了没问题」。
 *  - **口径限度随结果一起输出**，不只写在注释里：输出带 `caveats` 数组，里面有两侧的
 *    时间窗口（读不到就写 unknown）和「窗口不完全重合时差异会被放大」这句。
 *    实测那次 Semrush 是整月、Similarweb 标的是 `Jul 2026 - Aug 2026` 和
 *    `Last 28 days`，**本来就不完全重合**。
 *  - **域名必须一致才比。** 两份 JSON 的目标域名不同 → 直接拒绝并非零退出。
 *    这不是洁癖：2026-08-28 差点把 engineeringhardware.com 的数据当成 canva.com 记下来。
 *    「就当是同一个」比下去，产出的是一份看起来很像真的假报告。
 *  - 设备占比不在 Similarweb 的 `metrics` 里，只能从 `rawText` 解析。
 *    **能解析就解析，解析不到就 unknown，不猜。**
 *
 * ──────────────────────────────────────────────────────────────────────
 * 两份输入 JSON 的真实字段位置（照代码写，不是照直觉写）
 * ──────────────────────────────────────────────────────────────────────
 *  - semrush-traffic.mjs：指标在 **`parsed` 之下**（不是顶层），域名在顶层 `target`，
 *    时间窗口在顶层 `header.period` / `header.scope` / `header.devices`。
 *    失败时顶层是 `status: 'unavailable'` 且**没有** `parsed`。
 *  - similarweb-query.mjs：指标在 `metrics` 之下，域名在顶层 `domain`（不是 `target`）。
 *    `metrics` 过了 `compact()`，**null 字段是被删掉的**，所以「缺值」表现为键不存在。
 *    `metrics` 只在 `report === 'performance'` 且 `noDataTextObserved` 为假时才存在。
 *    时长是 `visitDuration`，`HH:MM:SS`，且**没有**秒数字段。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseFlags, printJson, showHelpIfRequested } from './opencli-core.mjs';

const flags = parseFlags(process.argv.slice(2));
showHelpIfRequested(flags, import.meta.url);

// ---------- 基础工具 ----------

/** 去掉协议、路径、www.、末尾点，统一小写。两侧域名比对前都要过这里。 */
export function normalizeDomain(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  const host = raw.includes('://') ? (() => { try { return new URL(raw).hostname; } catch { return raw; } })() : raw.split('/')[0];
  return host.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

/**
 * 只接受**有限的数**。`null` / `undefined` / `NaN` / 字符串 → null。
 * 这是 null-vs-0 这条红线的唯一入口：`0` 是合法数值，会原样通过；
 * 缺值走 null，两者在下游走完全不同的分支。
 */
export function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `mm:ss` / `HH:MM:SS` → 秒。不是这个形状就 null，不猜。 */
export function durationToSeconds(text) {
  const s = String(text ?? '').trim();
  if (!/^\d{1,3}(:\d{2}){1,2}$/.test(s)) return null;
  return s.split(':').map(Number).reduce((acc, p) => acc * 60 + p, 0);
}

const round2 = (n) => Number(n.toFixed(2));

// ---------- Similarweb 侧：rawText 里的设备占比 ----------

/**
 * 设备占比不在 `metrics` 里，页面上是「Desktop 82.56% / Mobile Web 17.44%」这种形态。
 * 两种排版都见过：标签和百分比同一行，或者标签一行、百分比在后面一两行。
 *
 * **扫描必须有边界**（这是用事故换来的规矩）：往后最多看 3 行，
 * 碰到另一个已知标签就停，只认整行的百分比。宁可返回 null 让上层判 unknown，
 * 也不要把隔壁的数字抓过来——错报比漏报危险得多。
 */
const DEVICE_LABELS = [
  { key: 'desktopSharePercent', patterns: [/^desktop(?: share)?$/i, /^桌面(?:设备|端|网页)?$/] },
  { key: 'mobileSharePercent', patterns: [/^mobile(?: web| share)?$/i, /^移动(?:网页|设备|端)?$/] },
];
const PERCENT_ONLY = /^([\d.]+)\s*%$/;
const LOOKAHEAD = 3;

export function parseDeviceShares(rawText) {
  const lines = String(rawText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const isLabel = (line) => DEVICE_LABELS.some((d) => d.patterns.some((p) => p.test(line)));
  const found = { desktopSharePercent: null, mobileSharePercent: null };

  for (let i = 0; i < lines.length; i += 1) {
    for (const { key, patterns } of DEVICE_LABELS) {
      if (found[key] !== null) continue;
      // 同一行：`Desktop 82.56%`
      for (const p of patterns) {
        const inline = lines[i].match(new RegExp(`${p.source.replace(/^\^|\$$/g, '')}\\s+([\\d.]+)\\s*%$`, p.flags));
        if (inline) { found[key] = Number(inline[1]); break; }
      }
      if (found[key] !== null) continue;
      // 标签独占一行，值在后面几行内
      if (!patterns.some((p) => p.test(lines[i]))) continue;
      for (let j = i + 1; j <= Math.min(i + LOOKAHEAD, lines.length - 1); j += 1) {
        if (isLabel(lines[j])) break;                    // 撞上下一个标签就停
        const m = lines[j].match(PERCENT_ONLY);
        if (m) { found[key] = Number(m[1]); break; }
      }
    }
  }

  // 两个都拿到了、和却离 100 很远 —— 那多半是抓错了行，整组作废。
  // 抓错的占比比没有占比危险得多：它会一路走到 agree/diverge 的判定里。
  if (found.desktopSharePercent !== null && found.mobileSharePercent !== null) {
    const sum = found.desktopSharePercent + found.mobileSharePercent;
    if (Math.abs(sum - 100) > 5) return { desktopSharePercent: null, mobileSharePercent: null, rejectedSum: round2(sum) };
  }
  return found;
}

/**
 * Similarweb 的时间窗口。总访问量标 `Jul 2026 - Aug 2026`，
 * 参与度指标另标 `Last 28 days (As of Aug 24)`——**这两个窗口本来就不一样**，
 * 所以分开报，不合并成一句「Similarweb 的窗口」。
 */
export function parseSimilarwebWindows(rawText) {
  const text = String(rawText || '');
  const range = text.match(/\b([A-Z][a-z]{2}\.? \d{4})\s*[-–—]\s*([A-Z][a-z]{2}\.? \d{4})\b/);
  const engagement = text.match(/Last \d+ days(?:\s*\(As of [^)]{1,24}\))?/i)
    || text.match(/(?:最近|近)\s*\d+\s*天(?:（[^）]{1,24}）)?/);
  return {
    totalVisits: range ? `${range[1]} - ${range[2]}` : null,
    engagement: engagement ? engagement[0].trim() : null,
  };
}

// ---------- 两侧 → 统一形状 ----------

/** 从 semrush-traffic.mjs 的产物取值。指标在 `parsed` 之下，不在顶层。 */
export function readSemrush(doc) {
  const d = doc || {};
  if (d.status === 'unavailable') {
    return { unavailable: `semrush JSON 的 status 是 unavailable（${d.error?.code || 'no code'}），没有可比的数` };
  }
  const p = d.parsed || {};
  const durationText = typeof p.avgVisitDuration === 'string' ? p.avgVisitDuration : null;
  return {
    provider: 'semrush',
    domain: normalizeDomain(d.target || d.header?.headerTarget),
    retrievedAt: d.retrievedAt ?? null,
    window: [d.header?.period, d.header?.scope, d.header?.devices].filter(Boolean).join(' / ') || null,
    visits: num(p.visits),
    desktopSharePercent: num(p.desktopSharePercent),
    mobileSharePercent: num(p.mobileSharePercent),
    pagesPerVisit: num(p.pagesPerVisit),
    bounceRatePercent: num(p.bounceRatePercent),
    avgVisitDuration: durationText,
    // 上游已经给了秒数；给漏了就自己换算，但**不因此发明一个时长文本**。
    avgVisitDurationSeconds: num(p.avgVisitDurationSeconds) ?? durationToSeconds(durationText),
  };
}

/** 从 similarweb-query.mjs 的产物取值。`metrics` 过了 compact()，缺值 = 键不存在。 */
export function readSimilarweb(doc) {
  const d = doc || {};
  if (d.status === 'unavailable') {
    return { unavailable: `similarweb JSON 的 status 是 unavailable（${d.error?.code || 'no code'}），没有可比的数` };
  }
  // `noDataTextObserved` 是**观测事实**（页面正面渲染了「没有此网站的数据」那句话），
  // 既不是采集失败也不是判决。以前这里把它当成「拒绝互校」的理由——那是替 AI 下判断。
  // 现在只把它当成一条随结果输出的观察：`metrics` 本来就不会存在，各指标自然落成
  // comparable:false，读者看得见「这一侧为什么没有数」。旧文件里的 belowFloor 同义。
  const noDataTextObserved = Boolean(d.noDataTextObserved ?? d.belowFloor);
  const m = d.metrics || {};
  const shares = parseDeviceShares(d.rawText);
  const durationText = typeof m.visitDuration === 'string' ? m.visitDuration : null;
  const windows = parseSimilarwebWindows(d.rawText);
  return {
    provider: 'similarweb',
    domain: normalizeDomain(d.domain),
    retrievedAt: d.retrievedAt ?? null,
    noDataTextObserved,
    window: [
      windows.totalVisits ? `总访问量 ${windows.totalVisits}` : null,
      windows.engagement ? `参与度 ${windows.engagement}` : null,
    ].filter(Boolean).join('；') || null,
    visits: num(m.totalVisits),
    desktopSharePercent: num(shares.desktopSharePercent),
    mobileSharePercent: num(shares.mobileSharePercent),
    deviceShareRejectedSum: shares.rejectedSum ?? null,
    pagesPerVisit: num(m.pagesPerVisit),
    bounceRatePercent: num(m.bounceRatePercent),
    avgVisitDuration: durationText,
    avgVisitDurationSeconds: durationToSeconds(durationText),
  };
}

// ---------- 算差值（**只有算术，没有判定**） ----------

/** 相对差以 Similarweb 侧为基，和 provider-capabilities.md 那张表同一个算法。 */
function relativePercent(semrush, similarweb) {
  if (similarweb === 0) return null;                    // 0 做分母没有意义，不给 Infinity
  return round2(((semrush - similarweb) / similarweb) * 100);
}

// 这两张表只剩「这个指标怎么算差」和「中文标签是什么」。
// 阈值字段（agree / diverge）在第三波删除：差多少算不算问题是判断，不是算术。
const RELATIVE_METRICS = {
  visits: { label: '总访问量' },
  pagesPerVisit: { label: '页数/访问' },
};
const POINT_METRICS = {
  desktopSharePercent: { label: '桌面占比' },
  mobileSharePercent: { label: '移动占比' },
  bounceRatePercent: { label: '跳出率' },
};

/**
 * 一个指标 → 一条**事实记录**。两侧齐全就算差值并标 `comparable: true`；
 * 任何一侧缺值 → `comparable: false` + 缺值原因，绝不填 0、绝不省略。
 * 这里是 null-vs-0 红线唯一会被绕过的地方，所以判空写在最前面，早于一切计算。
 */
function compareMetric(key, a, b) {
  const base = { metric: key, label: (RELATIVE_METRICS[key] || POINT_METRICS[key]).label, semrush: a, similarweb: b };
  if (a === null || b === null) {
    return {
      ...base,
      comparable: false,
      reason: a === null && b === null ? '两侧都没有这个值'
        : a === null ? 'Semrush 侧没有这个值' : 'Similarweb 侧没有这个值',
    };
  }

  if (RELATIVE_METRICS[key]) {
    const rel = relativePercent(a, b);
    if (rel === null) return { ...base, comparable: false, reason: 'Similarweb 侧是 0，相对差无意义（0 是实测值，不是缺值）' };
    // 「一侧是另一侧的 ≥10 倍或 ≤1/10 倍」是算术事实，照报；它**不**等于「有一边错了」。
    const magnitude = a / b >= 10 || a / b <= 0.1;
    return {
      ...base,
      comparable: true,
      diff: rel,
      diffUnit: 'percent',
      diffBasis: '(semrush − similarweb) / similarweb',
      ...(magnitude ? { orderOfMagnitude: true } : {}),
    };
  }

  return {
    ...base,
    comparable: true,
    diff: round2(a - b),
    diffUnit: 'percentage-points',
    diffBasis: 'semrush − similarweb',
  };
}

/**
 * 平均访问时长。**永远 comparable:false，且连 diff 都不算。**
 *
 * 这不是一次运行的判断，是指标本身的属性：两家对「一次访问」的定义不同。
 * 实测两家差 86%（11:02 vs 05:56）。算一个百分比摆在那里，读者就会拿去用，
 * 所以这里只给两侧原值和说明，剩下的交给人判断。
 */
function durationEntry(a, b) {
  return {
    metric: 'avgVisitDuration',
    label: '平均访问时长',
    semrush: a.avgVisitDuration,
    semrushSeconds: a.avgVisitDurationSeconds,
    similarweb: b.avgVisitDuration,
    similarwebSeconds: b.avgVisitDurationSeconds,
    comparable: false,
    reason: 'metric-definition-differs',
    note: '两家对「一次访问」的定义不同（会话超时阈值也可能不同）。2026-08-28 实测 canva.com '
        + '相差 86%（11:02 vs 05:56），窗口不重合解释不了这个量级。不要把两家的时长放进同一张表，'
        + '也不要据此计算差异百分比。',
  };
}

/** 口径限度必须随结果一起输出，不能只写在注释里。 */
function buildCaveats(a, b, extra = []) {
  return [
    `时间窗口 · Semrush：${a.window || 'unknown'}`,
    `时间窗口 · Similarweb：${b.window || 'unknown'}`,
    '两侧窗口不完全重合时，差异会被放大——实测那次 Semrush 是整月、Similarweb 的总访问量标 '
    + '`Jul 2026 - Aug 2026`、参与度标 `Last 28 days`，本来就不重合。不要把全部差异归因于数据源分歧。',
    '这是 Semrush .Trends（Traffic & Market）的总访问量口径，不是 semrush-report.mjs / '
    + 'semrush-overview.mjs 的自然搜索流量，两者不要混用或相加。',
    ...extra,
  ];
}

/**
 * 两侧 → 一份互校报告。域名对不上直接抛，**不产出任何比较结果**。
 */
export function crosscheck(semrushDoc, similarwebDoc) {
  const a = readSemrush(semrushDoc);
  const b = readSimilarweb(similarwebDoc);
  if (a.unavailable) throw new Error(a.unavailable);
  if (b.unavailable) throw new Error(b.unavailable);

  // 域名闸门。查不出域名同样拒绝：「一致」这件事无从验证时，比下去就是在赌。
  if (!a.domain || !b.domain) {
    throw new Error(
      `两份 JSON 至少有一份读不出目标域名（semrush=${a.domain || 'unknown'} / similarweb=${b.domain || 'unknown'}）。`
      + '域名无从核对就不比——semrush 的域名在顶层 `target`，similarweb 的在顶层 `domain`。',
    );
  }
  if (a.domain !== b.domain) {
    throw new Error(
      `域名不一致：semrush=${a.domain}，similarweb=${b.domain}。拒绝互校。`
      + '两个不同站点的数放进同一张表，产出的是一份看起来很像真的假报告。',
    );
  }

  const metrics = [
    compareMetric('visits', a.visits, b.visits),
    compareMetric('desktopSharePercent', a.desktopSharePercent, b.desktopSharePercent),
    compareMetric('mobileSharePercent', a.mobileSharePercent, b.mobileSharePercent),
    compareMetric('bounceRatePercent', a.bounceRatePercent, b.bounceRatePercent),
    compareMetric('pagesPerVisit', a.pagesPerVisit, b.pagesPerVisit),
    durationEntry(a, b),
  ];

  const compared = metrics.filter((m) => m.comparable === true);
  // 「缺值」和「口径本来就不可比」是两回事，分开数，别合成一个 unknown。
  const missing = metrics.filter((m) => m.comparable === false && m.reason !== 'metric-definition-differs');
  const incomparable = metrics.filter((m) => m.reason === 'metric-definition-differs');
  const extraCaveats = [];
  if (b.noDataTextObserved) {
    extraCaveats.push(
      'Similarweb 侧的 JSON 带 `noDataTextObserved: true`：页面正面渲染了「没有此网站的数据」那句话。'
      + '这是**观测事实，不是失败也不是判决**——它意味着什么（低于测量下限？域名写错？镜像抖动？）'
      + '要读 rawText 和现场证据判。本次互校因此拿不到 Similarweb 侧的数。',
    );
  }
  if (b.deviceShareRejectedSum !== null && b.deviceShareRejectedSum !== undefined) {
    extraCaveats.push(
      `Similarweb 的设备占比解析出的两项之和是 ${b.deviceShareRejectedSum}%，偏离 100 过多，`
      + '整组按解析失败作废（记为缺值），没有拿去比。',
    );
  }
  if (missing.length) {
    extraCaveats.push(
      `有 ${missing.length} 个指标因为某一侧缺值而没有差值：${missing.map((m) => m.metric).join('、')}。`
      + '缺值不是 0，也不代表两家一致。',
    );
  }
  extraCaveats.push(
    '本文件只给差值，不给「一致/分歧/冲突」的判定——差多少算不算问题，取决于窗口重合度、'
    + '口径、站点量级和你要拿它干什么。判读指引在 backlink/references/traffic-screen.md '
    + '的「两家数字对不上，先问哪个问题」一节。',
  );

  return {
    version: 1,
    tool: 'traffic-crosscheck',
    generatedAt: new Date().toISOString(),
    domain: a.domain,
    sources: {
      semrush: { provider: 'Semrush Traffic & Market (.Trends)', domain: a.domain, retrievedAt: a.retrievedAt, window: a.window },
      similarweb: { provider: 'Similarweb', domain: b.domain, retrievedAt: b.retrievedAt, window: b.window },
    },
    metrics,
    // 摘要只数事实：算了几条差值、几条因缺值没算、几条口径本来就不可比，
    // 以及这批差值里最大的一个绝对相对差是多少（一个数，不是一个档位）。
    summary: {
      metrics: metrics.length,
      compared: compared.length,
      comparedMetrics: compared.map((m) => m.metric),
      // 「没比成的指标」单独报，免得被读成「比过了没问题」。
      missingValue: missing.length,
      missingValueMetrics: missing.map((m) => m.metric),
      incomparable: incomparable.length,
      incomparableMetrics: incomparable.map((m) => m.metric),
      maxAbsRelativeDiffPercent: (() => {
        const rel = compared.filter((m) => m.diffUnit === 'percent').map((m) => Math.abs(m.diff));
        return rel.length ? Math.max(...rel) : null;
      })(),
      maxAbsPointDiff: (() => {
        const pts = compared.filter((m) => m.diffUnit === 'percentage-points').map((m) => Math.abs(m.diff));
        return pts.length ? Math.max(...pts) : null;
      })(),
      orderOfMagnitudeMetrics: compared.filter((m) => m.orderOfMagnitude).map((m) => m.metric),
    },
    caveats: buildCaveats(a, b, extraCaveats),
  };
}

// ---------- 离线自测 ----------

if (flags['self-test']) {
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push(name);
    if (!ok) throw new Error(`traffic-crosscheck self-test failed at ${name}${detail ? `: ${detail}` : ''}`);
  };

  // 2026-08-28 canva.com 的真实数字，直接照 provider-capabilities.md 那张表建夹具。
  const semrushDoc = {
    version: 1, report: 'traffic-overview', target: 'canva.com',
    retrievedAt: '2026-08-28T00:00:00.000Z',
    header: { headerTarget: 'canva.com', period: '2026年7月', scope: '全球', devices: '所有设备' },
    parsed: {
      visits: 790000000, visitsChangePercent: 4.53,
      desktopSharePercent: 84.26, mobileSharePercent: 15.74,
      uniqueVisitors: 210000000, pagesPerVisit: 5.4,
      avgVisitDuration: '11:02', avgVisitDurationSeconds: 662,
      bounceRatePercent: 30.23,
    },
  };
  const similarwebRaw = [
    'canva.com', 'Jul 2026 - Aug 2026',
    '总访问量', '771.4M',
    '设备分布', 'Desktop 82.56%', 'Mobile Web 17.44%',
    '参与度概览', 'Last 28 days (As of Aug 24)',
    '跳出率', '26.99%', '页面数/访问', '6.39', '访问持续时间', '00:05:56',
  ].join('\n');
  const similarwebDoc = {
    version: 1, report: 'performance', domain: 'canva.com',
    retrievedAt: '2026-08-28T00:00:00.000Z', noDataTextObserved: false,
    metrics: { totalVisits: 771400000, bounceRatePercent: 26.99, pagesPerVisit: 6.39, visitDuration: '00:05:56' },
    rawText: similarwebRaw,
  };

  const report = crosscheck(semrushDoc, similarwebDoc);
  const pick = (key) => report.metrics.find((m) => m.metric === key);

  // 0. **整份报告里不许再出现任何判决词。** 这一条排在最前面，因为它是第三波的核心：
  //    agree/diverge/conflict 与 verdict 字段被彻底删除，脚本只出差值。
  const reportJson = JSON.stringify(report);
  check('no-verdict-vocabulary-anywhere',
    !/"verdict"/.test(reportJson) && !/\bagree\b|\bdiverge\b|\bconflict\b/i.test(reportJson),
    reportJson.slice(0, 400));

  // 1. visits 的差值约 +2.4%，两侧原值照给，comparable 是事实不是评价
  const visits = pick('visits');
  check('visits-diff-is-2.4-percent',
    visits.comparable === true && Math.abs(visits.diff - 2.41) < 0.05
    && visits.diffUnit === 'percent'
    && visits.semrush === 790000000 && visits.similarweb === 771400000,
    JSON.stringify(visits));

  // 设备占比要真的从 rawText 里解析出来，而不是靠 metrics（那里根本没有）
  check('device-shares-parsed-from-rawtext',
    pick('desktopSharePercent').similarweb === 82.56 && pick('mobileSharePercent').similarweb === 17.44,
    JSON.stringify([pick('desktopSharePercent'), pick('mobileSharePercent')]));
  check('point-metrics-report-点差-not-a-band',
    pick('desktopSharePercent').diff === 1.7 && pick('desktopSharePercent').diffUnit === 'percentage-points'
    && pick('mobileSharePercent').diff === -1.7
    && pick('bounceRatePercent').diff === 3.24
    && [pick('desktopSharePercent'), pick('mobileSharePercent'), pick('bounceRatePercent')]
      .every((m) => m.comparable === true && !('verdict' in m)),
    JSON.stringify(report.metrics));
  // 页数/访问：−15%。以前这里会被 25% 阈值判成 agree；现在只有这个数。
  check('pages-per-visit-diff-is-minus-15-percent',
    pick('pagesPerVisit').comparable === true && Math.abs(pick('pagesPerVisit').diff + 15.49) < 0.05,
    JSON.stringify(pick('pagesPerVisit')));

  // 2. 时长永远不可比，且**连 diff 都不给**
  const duration = pick('avgVisitDuration');
  const durationJson = JSON.stringify(duration);
  check('duration-is-incomparable-by-definition',
    duration.comparable === false && duration.reason === 'metric-definition-differs', durationJson);
  check('duration-has-no-diff-at-all',
    !('diff' in duration) && !('diffUnit' in duration), durationJson);
  check('duration-keeps-both-sides',
    duration.semrush === '11:02' && duration.similarweb === '00:05:56'
    && duration.semrushSeconds === 662 && duration.similarwebSeconds === 356
    && typeof duration.note === 'string' && duration.note.length > 0,
    durationJson);
  check('summary-counts-facts-only',
    report.summary.compared === 5 && report.summary.missingValue === 0
    && report.summary.incomparable === 1 && report.summary.incomparableMetrics[0] === 'avgVisitDuration'
    && Math.abs(report.summary.maxAbsRelativeDiffPercent - 15.49) < 0.05
    && report.summary.maxAbsPointDiff === 3.24
    && report.summary.orderOfMagnitudeMetrics.length === 0
    && !('agree' in report.summary) && !('conflict' in report.summary),
    JSON.stringify(report.summary));

  // 3. 一侧 visits 缺失 → comparable:false + 原因，不是 0、不是「一致」
  //    similarweb 的 metrics 过了 compact()，缺值表现为**键不存在**，就照这个形态建夹具。
  const swNoVisits = { ...similarwebDoc, metrics: { bounceRatePercent: 26.99, pagesPerVisit: 6.39, visitDuration: '00:05:56' } };
  const missing = crosscheck(semrushDoc, swNoVisits);
  const missingVisits = missing.metrics.find((m) => m.metric === 'visits');
  check('missing-visits-is-not-comparable-not-zero',
    missingVisits.comparable === false && missingVisits.similarweb === null
    && missingVisits.semrush === 790000000 && !('diff' in missingVisits),
    JSON.stringify(missingVisits));
  check('missing-visits-never-becomes-zero',
    missingVisits.similarweb !== 0 && missing.summary.missingValue === 1
    && missing.summary.missingValueMetrics[0] === 'visits' && missing.summary.compared === 4,
    JSON.stringify(missing.summary));
  check('missing-count-is-reported-separately',
    missing.caveats.some((c) => c.includes('没有差值') && c.includes('visits')),
    JSON.stringify(missing.caveats));
  // 0 必须仍然是一个实测值——不能被 null 检查一起吞掉，也不能被当成缺值报道。
  const swZeroVisits = { ...similarwebDoc, metrics: { ...similarwebDoc.metrics, totalVisits: 0 } };
  const zero = crosscheck(semrushDoc, swZeroVisits).metrics.find((m) => m.metric === 'visits');
  check('zero-is-a-value-not-a-gap',
    zero.similarweb === 0 && zero.comparable === false
    && zero.reason.includes('0 是实测值'),
    JSON.stringify(zero));

  // 4. 域名不同 → 拒绝，且不产出任何比较结果
  let refused = null;
  try {
    crosscheck(semrushDoc, { ...similarwebDoc, domain: 'engineeringhardware.com' });
  } catch (error) { refused = error; }
  check('different-domains-are-refused',
    refused instanceof Error && /域名不一致/.test(refused.message)
    && refused.message.includes('canva.com') && refused.message.includes('engineeringhardware.com'),
    String(refused && refused.message));
  // www. 和大小写不算不同
  check('www-and-case-are-the-same-domain',
    crosscheck({ ...semrushDoc, target: 'WWW.Canva.com' }, similarwebDoc).domain === 'canva.com');
  // 读不出域名同样拒绝——「无从核对」不等于「可以当成一样」
  let noDomain = null;
  try { crosscheck({ ...semrushDoc, target: null, header: {} }, similarwebDoc); } catch (e) { noDomain = e; }
  check('unknown-domain-is-also-refused', noDomain instanceof Error && /读不出目标域名/.test(noDomain.message),
    String(noDomain && noDomain.message));

  // 5. 差一个数量级 → 仍然只是一个差值 + 一个算术标记，**不是判决、不改退出码**
  const swMagnitude = { ...similarwebDoc, metrics: { ...similarwebDoc.metrics, totalVisits: 7900000 } };
  const magnitudeReport = crosscheck(semrushDoc, swMagnitude);
  const magnitude = magnitudeReport.metrics.find((m) => m.metric === 'visits');
  check('order-of-magnitude-is-a-fact-not-a-verdict',
    magnitude.comparable === true && magnitude.orderOfMagnitude === true && magnitude.diff === 9900
    && !('verdict' in magnitude)
    && magnitudeReport.summary.orderOfMagnitudeMetrics[0] === 'visits',
    JSON.stringify(magnitude));
  // 以前的「中间档」（15–50%）现在什么档也不是，就是 +31.67%
  const swMid = { ...similarwebDoc, metrics: { ...similarwebDoc.metrics, totalVisits: 600000000 } };
  const mid = crosscheck(semrushDoc, swMid).metrics.find((m) => m.metric === 'visits');
  check('mid-band-is-just-a-number', mid.comparable === true && Math.abs(mid.diff - 31.67) < 0.05
    && !('verdict' in mid),
    JSON.stringify(mid));
  // 判读指引的去处必须写在结果里，不能只留在注释里
  check('caveats-point-at-the-md',
    report.caveats.some((c) => c.includes('traffic-screen.md')),
    JSON.stringify(report.caveats));

  // 6. caveats 非空，且带两侧窗口
  check('caveats-carry-both-windows',
    Array.isArray(report.caveats) && report.caveats.length >= 3
    && report.caveats.some((c) => c.includes('Semrush') && c.includes('2026年7月'))
    && report.caveats.some((c) => c.includes('Similarweb') && c.includes('Jul 2026 - Aug 2026')
      && c.includes('Last 28 days'))
    && report.caveats.some((c) => c.includes('不完全重合')),
    JSON.stringify(report.caveats));
  // 窗口读不到就写 unknown，不留空、不编
  const noWindow = crosscheck(
    { ...semrushDoc, header: { headerTarget: 'canva.com' } },
    { ...similarwebDoc, rawText: 'canva.com\n总访问量\n771.4M' },
  );
  check('unknown-windows-say-unknown',
    noWindow.caveats[0].endsWith('unknown') && noWindow.caveats[1].endsWith('unknown'),
    JSON.stringify(noWindow.caveats.slice(0, 2)));

  // 设备占比解析：英文同行、中文分行、抓不到、和不到 100 四种形态
  check('device-shares-inline-and-split',
    parseDeviceShares('Desktop 82.56%\nMobile Web 17.44%').desktopSharePercent === 82.56
    && parseDeviceShares('桌面\n82.56%\n移动网页\n17.44%').mobileSharePercent === 17.44,
    JSON.stringify(parseDeviceShares('桌面\n82.56%\n移动网页\n17.44%')));
  check('device-shares-absent-is-null',
    parseDeviceShares('canva.com\n总访问量\n771.4M').desktopSharePercent === null
    && parseDeviceShares('').mobileSharePercent === null);
  check('device-shares-not-summing-to-100-are-dropped',
    parseDeviceShares('Desktop 82.56%\nMobile Web 5%').desktopSharePercent === null,
    JSON.stringify(parseDeviceShares('Desktop 82.56%\nMobile Web 5%')));
  // 标签后面隔着别的标签 → 不许穿过去抓下一个数（lib-similarweb 那起事故的同型防护）
  check('device-share-scan-stops-at-next-label',
    parseDeviceShares('Desktop\nMobile Web\n17.44%').desktopSharePercent === null,
    JSON.stringify(parseDeviceShares('Desktop\nMobile Web\n17.44%')));

  // 上游**采集失败**（status: unavailable）→ 拒绝，不要拿空壳去比
  for (const [name, bad] of [
    ['semrush-unavailable', () => crosscheck({ status: 'unavailable', error: { code: 'x' }, target: 'canva.com' }, similarwebDoc)],
    ['similarweb-unavailable', () => crosscheck(semrushDoc, { status: 'unavailable', error: { code: 'y' }, domain: 'canva.com' })],
  ]) {
    let thrown = null;
    try { bad(); } catch (e) { thrown = e; }
    check(`refuses-${name}`, thrown instanceof Error, String(thrown));
  }

  // 但 `noDataTextObserved` **不是**失败，也不再是拒绝的理由：它是「页面上写了一句话」
  // 这个观测事实。以前这里 throw，等于脚本替 AI 判了「无从互校」。现在照常出报告，
  // Similarweb 侧各指标落成 comparable:false，并在 caveats 里把这句话是什么讲清楚。
  const swNoData = { version: 1, report: 'performance', domain: 'canva.com', noDataTextObserved: true, rawText: 'canva.com\n没有此网站的数据' };
  const noDataReport = crosscheck(semrushDoc, swNoData);
  check('no-data-marker-is-observed-not-refused',
    noDataReport.summary.compared === 0 && noDataReport.summary.missingValue === 5
    && noDataReport.caveats.some((c) => c.includes('noDataTextObserved') && c.includes('观测事实')),
    JSON.stringify(noDataReport.summary));
  // 旧文件里的 belowFloor 读得懂，含义与新名一致
  const legacy = crosscheck(semrushDoc, { version: 1, report: 'performance', domain: 'canva.com', belowFloor: true, rawText: '' });
  check('legacy-below-floor-field-still-parses',
    legacy.caveats.some((c) => c.includes('noDataTextObserved')),
    JSON.stringify(legacy.caveats));

  check('duration-seconds-parsing',
    durationToSeconds('11:02') === 662 && durationToSeconds('00:05:56') === 356
    && durationToSeconds('5.4') === null && durationToSeconds('') === null
    && durationToSeconds(null) === null);
  check('num-keeps-zero-rejects-junk',
    num(0) === 0 && num(1.5) === 1.5 && num(null) === null && num('7') === null
    && num(NaN) === null && num(undefined) === null);

  console.log(`traffic-crosscheck self-test: PASS (${checks.length} checks: ${checks.join(', ')})`);
  process.exit(0);
}

// ---------- 主流程 ----------

const semrushPath = typeof flags.semrush === 'string' ? flags.semrush : null;
const similarwebPath = typeof flags.similarweb === 'string' ? flags.similarweb : null;
if (!semrushPath || !similarwebPath) {
  console.error(
    'traffic-crosscheck.mjs 需要两份已经生成好的 JSON：\n'
    + '  --semrush <file>     semrush-traffic.mjs --out 的产物\n'
    + '  --similarweb <file>  similarweb-query.mjs --out 的产物（report=performance）\n'
    + '本脚本纯离线，自己不抓页面。用 --help 看完整说明。',
  );
  process.exit(2);
}

async function loadJson(path, which) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    throw new Error(`读不到 ${which} 的 JSON（${path}）：${error.message}`);
  }
  try { return JSON.parse(text); } catch (error) {
    throw new Error(`${which} 的 JSON 解析失败（${path}）：${error.message}`);
  }
}

let report;
try {
  const [semrushDoc, similarwebDoc] = await Promise.all([
    loadJson(semrushPath, 'semrush'),
    loadJson(similarwebPath, 'similarweb'),
  ]);
  report = crosscheck(semrushDoc, similarwebDoc);
  report.inputs = { semrush: semrushPath, similarweb: similarwebPath };
} catch (error) {
  // 拒绝的时候**不产出比较结果**：这里只写一个带 status 的壳，metrics 一条都没有。
  // 有 metrics 的输出会被下游当成「比过了」，哪怕里面全是 unknown。
  const refusal = {
    version: 1,
    tool: 'traffic-crosscheck',
    generatedAt: new Date().toISOString(),
    status: 'refused',
    error: { code: 'crosscheck_refused', message: error.message },
    inputs: { semrush: semrushPath, similarweb: similarwebPath },
  };
  if (typeof flags.out === 'string') await writeFile(flags.out, `${JSON.stringify(refusal, null, 2)}\n`, 'utf8');
  console.error(`[refused] ${error.message}`);
  printJson(refusal);
  process.exit(1);
}

if (typeof flags.out === 'string') await writeFile(flags.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
// --json 只影响 stderr 上那行人读摘要；stdout 永远是 JSON，管道下游不因这个 flag 变形。
if (!flags.json) {
  const s = report.summary;
  console.error(
    `[${report.domain}] compared=${s.compared} `
    + `maxRelDiff=${s.maxAbsRelativeDiffPercent === null ? 'n/a' : `${s.maxAbsRelativeDiffPercent}%`} `
    + `maxPointDiff=${s.maxAbsPointDiff === null ? 'n/a' : `${s.maxAbsPointDiff}pp`} `
    + `missing=${s.missingValue}${s.missingValue ? `(${s.missingValueMetrics.join(',')})` : ''} `
    + `incomparable=${s.incomparable}(${s.incomparableMetrics.join(',')})`
    + `${s.orderOfMagnitudeMetrics.length ? ` orderOfMagnitude=${s.orderOfMagnitudeMetrics.join(',')}` : ''}`,
  );
}
printJson(report);
// **不因差异大小改退出码。** 以前 `conflict > 0` 会退出 1，等于脚本替人下了
// 「有一边错了」的判决，还让 CI/管道把一次成功的采集读成失败。退出码只留给
// 「这次互校没跑成」（域名不一致、读不到文件、上游 status=unavailable）——那是事实。
