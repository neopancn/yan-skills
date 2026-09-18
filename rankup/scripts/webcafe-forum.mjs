#!/usr/bin/env node
/**
 * webcafe-forum.mjs —— new.web.cafe（哥飞社区论坛）全站取数。
 *
 * 官方 Skill 暂无论坛全集、悬赏投票榜与完整群聊原文的等价能力。
 * 依据：2026-09-30 官方目录与 knowledge_search(kind=chat) 实试，仅返回哥飞发言节选，
 * knowledge_read 只给相关段落、群聊去昵称；不能替代 message_list 原始字段。
 * 本日旧 bounties HTTP、chat-search 登录浏览器均成功，后者50条上限。
 * 旧论坛请求未显示工具箱每日配额扣费；正文仍受会员/解锁权限限制，不等于全部免费。
 * 本脚本与工具箱使用不同站点和数据接口。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 【一句话】给一个 URL 就能把那个页面的内容取回来，新发的也一样：
 *
 *     node webcafe-forum.mjs get https://new.web.cafe/ask/bounty/fd0wrgx7fh
 *
 * 认不出的 URL 会退回通用抓取（SSR 正文），所以站方新增页面类型也不会当场失效。
 *
 * 【为什么要有 --transport，以及为什么默认是 auto】
 * 这个站**匿名不会 401**：同一个端点匿名照样返回 200 和完整数组，只是把正文换成空串。
 * 实测 `/api/ask/bounty/fd0wrgx7fh`：匿名 80,941 字节 / 23 条答案 / 正文 **0 字**，
 * 已登录 140,491 字节 / 23 条答案 / 正文 **19,651 字**。
 * 所以「能不能拿到」不是看状态码，要看正文空不空——判据封在 webcafe-transport.mjs 里。
 *
 *   auto     默认。先走免费匿名 HTTP，**发现正文被抹掉了才动用浏览器**。
 *   http     强制匿名。零依赖、可并发、分享给别人零门槛。**只要元数据就用这个。**
 *   browser  强制走用户已登录的 Chrome（页面内 fetch，脚本全程不碰 Cookie）。
 *
 * 【用法】
 *   node webcafe-forum.mjs get <url>                      # 万能入口，自动路由
 *   node webcafe-forum.mjs bounty <uid>                   # 悬赏详情（含答案正文）
 *   node webcafe-forum.mjs bounties [--status ...] [--pages 3]
 *   node webcafe-forum.mjs rounds [--sort smart] [--pages 3]
 *   node webcafe-forum.mjs featured
 *   node webcafe-forum.mjs experiences [--pages 3]
 *   node webcafe-forum.mjs experience <id>
 *   node webcafe-forum.mjs whoami                         # 浏览器里是不是登录态
 *
 * 【通用选项】
 *   --transport auto|http|browser   见上（默认 auto）
 *   --session <名>                  opencli 会话名；默认按并发单位自动派生，别写死
 *   --json                          输出原始 JSON
 *   --out <文件>                    落盘（.jsonl 走 JSON Lines）
 *   --md                            输出 Markdown（悬赏/经验详情用，适合直接读）
 *   -h, --help
 *
 * 依赖：无 token。browser 传输需要 opencli + 已登录的 Chrome。
 * 已验证日期：2026-08-24
 *
 * 【已知坑，都是实测踩出来的】
 *   - **匿名降级是静默的。** 拿到 200、拿到 23 条、拿到作者名和 content_len，
 *     只有正文是空的。不检查 `visible` 就会把「没登录」写成「这条答案是空的」。
 *   - **正文为空有四个原因，只有一个是登录能解决的**。脚本把判据原文放在
 *     `access_evidence`（viewer 字段 / status / 各计数 / 解锁价），并按它给一个
 *     `suggested_access` **建议**（不是判决——站点改字段语义时 evidence 仍真，
 *     suggested 会陪着错，存疑看 evidence 与截图）：
 *       `full`          拿全了
 *       `anonymous`     没登录 → 加 --transport browser（唯一一个开浏览器有用的情况）
 *       `sealed`        悬赏还在 funding/collecting/open/answering 阶段，
 *                       答案对**所有人**封存（答题期防抄袭）。登录和付钱都没用，等状态推进。
 *       `needs-unlock`  要花钱解锁。**本脚本绝不自动解锁**，由你在网页上手动决定。
 *     把 `sealed` 误判成「你没登录」，会把人推去点那个要花钱的按钮——所以这四种必须分开。
 *   - **`hasUnlocked` 不是判据，`canSeeAll` 才是。** 实测 fd0wrgx7fh：
 *     `hasUnlocked:false` 但 `canSeeAll:true`（因为本人是答题者之一），照样看全文。
 *     拿 `hasUnlocked` 判会误导你去重复付一次钱。
 *   - **`_fen` 结尾的字段单位是分**（1/100 元）：`pool_fen:30000` 是 300 元。
 *     当成元会把奖池说大 100 倍。
 *   - 经验/话题页**没有内容 API**，是服务端渲染，只能从 HTML 里抠。这条路上的
 *     降级判据藏在 RSC payload 里（`markdown` 被抹成空串），传输层看不见，
 *     所以 auto 的升级逻辑在 `fetchProps(path, ctx, gated)` 里另写了一份。
 *     实测 `/experiences` 首条：匿名 **0 字**，auto 升级后 **219 字**。
 *   - **`topics` 列表项没有 `markdown` 字段**（登录也没有），它的「正文为空」不是降级，
 *     要正文得 `topic <uid>` 逐条取。对它套用列表降级判据会每页白开一次浏览器。
 */

// 双证人化改造 2026-08-30（截图链路已实盘验证）：正文可见性输出
// access_evidence + suggested_access；取数失败 die 前 dump 现场到 .rankup/evidence/。
import { writeFileSync, mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  BASE,
  getJson,
  getHtml,
  sessionName,
  closeSession,
  whoami as apiWhoami,
  browserPost,
  browserGet,
  sleep,
  ensureLoggedIn,
} from "./webcafe-transport.mjs";
import { propsFromHtml, isLoginPage } from "./webcafe-rsc.mjs";
import { opencliRun } from "./lib-opencli.mjs";
import { newEvidenceDir, captureScene, writeManifest } from "./lib-scene.mjs";

/* ─────────────────────────────── 参数 ─────────────────────────────── */

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") && !(a === "-h")) {
      out._.push(a);
      continue;
    }
    if (a === "-h") {
      out.help = true;
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[body] = true;
    else {
      out[body] = next;
      i++;
    }
  }
  return out;
}

const die = (m) => {
  console.error(`错误：${m}`);
  process.exit(1);
};

/**
 * 取数失败的退出出口（双证人化 2026-08-30，截图链路已实盘验证）：
 * die 之前把手里最后的证据 dump 进 `.rankup/evidence/webcafe-forum-<ts>/`——
 * 响应状态、props/HTML/原文片段进 extra.json；ctx.session 存在（走过浏览器
 * transport）时再补一张截图。旧版只留一句结论文案，「没拿到」到底是 401、
 * 改版还是解析失配，事后无从对质。
 */
function dumpAndDie(ctx, stopReason, msg, payload) {
  try {
    const dir = newEvidenceDir("webcafe-forum");
    captureScene({
      dir,
      tag: `fail-${stopReason}`,
      screenshot: ctx?.session
        ? (p) => opencliRun(["browser", ctx.session, "screenshot", p], { stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 })
        : undefined,
      extra: payload,
    });
    writeManifest(dir, {
      script: "webcafe-forum",
      stopReason,
      transport: ctx?.transport ?? null,
      finishedAt: new Date().toISOString(),
    });
    console.error(`现场已落盘：${dir}（状态码 / 原文片段${ctx?.session ? " / 截图" : ""}，判读以它们为准）`);
  } catch (e) {
    console.error(`（取证失败：${String(e?.message || e).slice(0, 200)}）`);
  }
  die(msg);
}

/* ───────────────────────── 降级判据（每个端点一条） ───────────────────────── */

/**
 * 「这份数据被**匿名**降级了吗」——只有这一种情况开浏览器才有用。
 *
 * **不是看状态码**（这个站降级时返回 200），也**不是只看正文空不空**：
 * 正文空有三个完全不同的原因，只有第一个是登录能解决的。
 * 判错的代价不对称——把「答题期封存」误判成「你没登录」，
 * 会把人推去点那个**要花钱**的解锁按钮。
 */
const gatedBounty = (j) => {
  const b = j?.bounty;
  if (!b) return false;
  if (b.viewer?.isLoggedIn) return false; // 已登录还空，那就不是登录的问题
  if (b.kind === "collect") return (b.collect?.option_count || 0) > 0 && !(b.collect?.board || []).length;
  return (b.answers || []).some((a) => (a.content_len || 0) > 0 && !a.visible);
};

/**
 * 正文为什么看不到——四种，处置方式完全不同。
 *
 * 双证人化改造（2026-08-30）：本函数不再只回一个判决词。它先把**判据本身**
 * （服务端 `bounty.viewer` 的原始字段、status、各计数、解锁价）原样收进
 * `evidence`，再基于这些字段给一个 `suggestedAccess`——那是**建议**不是判决：
 * 站点改了 viewer 字段语义时，evidence 还是真的，suggested 会陪着错。
 * 判读者对 suggested 存疑时，看 evidence 与 `--transport browser` 的截图对质。
 */
function classifyAccess(b) {
  const v = b?.viewer || {};
  const answers = b?.answers || [];
  const evidence = {
    kind: b?.kind ?? null,
    status: b?.status ?? null,
    // loginSeen：服务端说这次请求带没带登录态（viewer.isLoggedIn 原样转录）。
    loginSeen: v.isLoggedIn ?? null,
    canSeeAll: v.canSeeAll ?? null,
    answerCount: answers.length,
    visibleAnswerCount: answers.filter((a) => a.visible).length,
    hiddenNonEmptyAnswerCount: answers.filter((a) => (a.content_len || 0) > 0 && !a.visible).length,
    boardLength: (b?.collect?.board || []).length,
    optionCount: b?.collect?.option_count ?? null,
    // paywallSeen：这一场有没有标价（解锁价 > 0 就是有付费墙的迹象，不等于必须付）。
    paywallSeen: (b?.unlock_price || 0) > 0,
    unlockPriceYuan: yuan(b?.unlock_price),
    rawExcerpt: JSON.stringify({ viewer: v, status: b?.status, kind: b?.kind }).slice(0, 400),
  };
  const suggest = (suggestedAccess, note) => ({ suggestedAccess, note, evidence });
  // 征集型（kind:collect）的内容在 collect.board[]，不在 answers[]。
  // 两种 kind 的「有没有内容」判据不同，混用会把 588 条的榜单判成空。
  if (b?.kind === "collect") {
    if (evidence.boardLength) return suggest("full", "");
    const n = evidence.optionCount || 0;
    if (!n) return suggest("no-answers", "这个征集还没有条目");
    if (!v.isLoggedIn) {
      return suggest("anonymous", `榜单有 ${n} 条，但匿名拿到的 board 是空数组（HTTP 仍是 200）。加 --transport browser 重跑。`);
    }
    return suggest("sealed", `榜单有 ${n} 条，但这个征集处于「${b.status}」阶段，榜单要到「已开榜」(open) 才对外可见。等状态推进。`);
  }
  if (!answers.length) return suggest("no-answers", "这个悬赏还没有答案");
  if (v.canSeeAll) return suggest("full", "");
  if (!v.isLoggedIn) {
    return suggest("anonymous", "匿名只给元数据，正文被抹成空串（HTTP 仍是 200）。加 --transport browser 用已登录的浏览器重跑。");
  }
  // 已登录还看不到：要么整场还封着，要么这一场要花钱解锁。
  if (["funding", "collecting", "open", "answering"].includes(b.status)) {
    return suggest("sealed", `这个悬赏处于「${b.status}」阶段，答案对**所有人**封存（答题期防抄袭），等它进入 voting 再取。这不是登录或付费能解决的。`);
  }
  return suggest("needs-unlock", `需要解锁才能看正文，解锁价 ${yuan(b.unlock_price)} 元。**本脚本绝不会自动解锁**——要不要花这笔钱由你决定，在网页上手动点。`);
}

/** 列表类端点匿名就是全的，没有降级概念。给个恒 false 免得调用方漏传。 */
const notGated = () => false;

/* ─────────────────────────────── 工具 ─────────────────────────────── */

const yuan = (fen) => (typeof fen === "number" ? (fen / 100).toFixed(2) : "");

function writeOut(file, data) {
  const p = resolve(process.cwd(), file);
  mkdirSync(dirname(p), { recursive: true });
  const body = p.endsWith(".jsonl")
    ? (Array.isArray(data) ? data : [data]).map((r) => JSON.stringify(r)).join("\n") + "\n"
    : JSON.stringify(data, null, 2) + "\n";
  writeFileSync(p, body);
  return p;
}

const w = (s) =>
  [...String(s)].reduce(
    (n, c) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffe6]/.test(c) ? 2 : 1),
    0,
  );
const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - w(s)));
const clip = (s, max) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  if (w(s) <= max) return s;
  let o = "", c = 0;
  for (const ch of s) {
    const cw = w(ch);
    if (c + cw > max - 1) break;
    o += ch;
    c += cw;
  }
  return o + "…";
};

function table(rows, cols) {
  if (!rows.length) return console.log("(无结果)");
  const cells = rows.map((r) => cols.map((c) => clip(r[c.key], c.max ?? 40)));
  const ws = cols.map((c, i) => Math.max(w(c.label), ...cells.map((r) => w(r[i]))));
  console.log(cols.map((c, i) => pad(c.label, ws[i])).join("  "));
  console.log(ws.map((n) => "-".repeat(n)).join("  "));
  for (const r of cells) console.log(r.map((v, i) => pad(v, ws[i])).join("  "));
}

/** 拿不全就必须说出来，并且说清是哪一种拿不全，不许静默返回半份数据。 */
function warnAccess(cls, res) {
  if (cls.suggestedAccess === "full" || cls.suggestedAccess === "no-answers") return;
  console.error(`\n⚠️  正文未取到（suggested: ${cls.suggestedAccess}）：${cls.note}`);
  console.error(`   判据原文：${cls.evidence.rawExcerpt}`);
  if (res?.upgradeError) console.error(`   自动升级到浏览器失败：${res.upgradeError}`);
}

/* ─────────────────────────────── 命令 ─────────────────────────────── */

async function cmdBounty(uid, args, ctx) {
  if (!uid) die("用法：webcafe-forum.mjs bounty <uid>");
  const res = await getJson(`/api/ask/bounty/${encodeURIComponent(uid)}`, {
    ...ctx,
    gated: gatedBounty,
  });
  const b = res.json?.bounty;
  if (!b) {
    dumpAndDie(ctx, "no-bounty-data", `没拿到悬赏数据（HTTP ${res.status}）`, {
      status: res.status,
      transport: res.transport,
      jsonExcerpt: JSON.stringify(res.json ?? null).slice(0, 2000),
    });
  }

  const cls = classifyAccess(b);
  const out = {
    uid: b.uid,
    url: `${BASE}/ask/bounty/${b.uid}`,
    title: b.title,
    question: b.content,
    status: b.status,
    // suggested_access 是脚本按 viewer 字段给的**建议**；判据原文在 access_evidence，
    // 两者不一致时以 evidence（和浏览器截图）为准。
    suggested_access: cls.suggestedAccess,
    access_note: cls.note,
    access_evidence: cls.evidence,
    kind: b.kind,
    pool_yuan: yuan(b.pool_fen),
    unlock_price_yuan: yuan(b.unlock_price),
    unlock_count: b.unlock_count,
    investor_count: (b.investors || []).length,
    answer_count: (b.answers || []).length,
    answering_expire_at: b.answering_expire_at,
    voting_expire_at: b.voting_expire_at,
    transport: res.transport,
    // kind:collect 的内容**不在 answers[] 里**，在 collect.board[]。
    // 不处理这一支会对着一个 588 条的榜单报「0 条答案」——空结果且不报错。
    board: (b.collect?.board || []).map((r) => ({
      rank_by_votes: 0,
      votes: r.vote_count,
      text: r.display_text,
      domain: r.site_domain,
      name: r.site_name || r.site_name_by_name || "",
      notes: (r.submitters || []).map((s) => s.note).filter(Boolean),
      submitters: (r.submitters || []).map((s) => s.name),
      note1: (r.submitters || []).map((s) => s.note).filter(Boolean)[0] || "",
    })).sort((x, y) => (y.votes || 0) - (x.votes || 0)).map((r, i) => ({ ...r, rank_by_votes: i + 1 })),
    option_count: b.collect?.option_count ?? null,
    submitter_count: b.collect?.submitter_count ?? null,
    answers: (b.answers || [])
      .map((a) => ({
        uid: a.uid,
        author: a.answerer_name,
        rank: a.rank,
        votes: a.vote_count,
        score: a.score,
        likes: a.like_count,
        tip_yuan: yuan(a.tip_total_fen),
        chars: a.content_len,
        visible: a.visible,
        content: a.content || "",
        created_at: a.created_at,
      }))
      .sort((x, y) => (y.votes || 0) - (x.votes || 0)),
  };

  if (args.out) console.error(`已写入 ${writeOut(args.out, out)}`);
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else if (args.md) console.log(bountyMd(out));
  else {
    console.log(`${out.title}\n${out.url}`);
    console.log(
      `奖池 ${out.pool_yuan} 元 · ${out.investor_count} 人投资 · ${out.answer_count} 条答案 · 解锁价 ${out.unlock_price_yuan} 元 × ${out.unlock_count} 次\n`,
    );
    if (out.board.length) {
      table(out.board, [
        { key: "rank_by_votes", label: "#", max: 4 },
        { key: "votes", label: "票", max: 5 },
        { key: "domain", label: "域名", max: 30 },
        { key: "note1", label: "提交者理由", max: 60 },
      ].map((c) => c));
      console.error(`\n榜单共 ${out.board.length} 条，${out.submitter_count} 人提交`);
      warnAccess(cls, res);
      return out;
    }
    table(out.answers, [
      { key: "author", label: "作者", max: 14 },
      { key: "votes", label: "票", max: 5 },
      { key: "likes", label: "赞", max: 5 },
      { key: "tip_yuan", label: "打赏", max: 7 },
      { key: "chars", label: "字数", max: 6 },
      { key: "content", label: "正文", max: 60 },
    ]);
  }
  warnAccess(cls, res);
  return out;
}

function bountyMd(o) {
  const L = [`# ${o.title}`, ``, `来源：${o.url}`, ``, `> ${o.question}`, ``];
  L.push(
    `奖池 **${o.pool_yuan} 元**，${o.investor_count} 人投资，${o.answer_count} 条答案。`,
    ``,
  );
  if (o.suggested_access !== "full") L.push(`> ⚠️ 正文未取到（suggested: ${o.suggested_access}）：${o.access_note}`, ``);
  for (const a of o.answers) {
    L.push(`## ${a.author}（${a.votes} 票 · ${a.chars} 字）`, ``, a.content || "_（正文未取到）_", ``);
  }
  return L.join("\n");
}

async function cmdBounties(args, ctx) {
  const pages = Number(args.pages || 1);
  const status = args.status === undefined || args.status === true ? "" : args.status;
  const rows = [];
  for (let p = 1; p <= pages; p++) {
    const res = await getJson(
      `/api/ask/bounty/list?status=${encodeURIComponent(status)}&mine=&page=${p}`,
      { ...ctx, gated: notGated },
    );
    const list = pickList(res.json);
    if (!list.length) break;
    for (const b of list) {
      rows.push({
        uid: b.uid,
        title: b.title,
        status: b.status,
        pool_yuan: yuan(b.pool_fen),
        answers: b.answer_count ?? b.answers_count ?? "",
        investors: b.investor_count ?? "",
        url: `${BASE}/ask/bounty/${b.uid}`,
      });
    }
  }
  emitRows(rows, args, [
    { key: "uid", label: "uid", max: 12 },
    { key: "pool_yuan", label: "奖池", max: 8 },
    { key: "answers", label: "答案", max: 5 },
    { key: "status", label: "状态", max: 8 },
    { key: "title", label: "标题", max: 46 },
  ]);
  return rows;
}

async function cmdRounds(args, ctx) {
  const pages = Number(args.pages || 1);
  const sort = args.sort === undefined || args.sort === true ? "smart" : args.sort;
  const rows = [];
  for (let p = 1; p <= pages; p++) {
    const res = await getJson(`/api/ask/publicRounds?page=${p}&sort=${encodeURIComponent(sort)}`, {
      ...ctx,
      gated: notGated,
    });
    const list = pickList(res.json);
    if (!list.length) break;
    rows.push(...list.map(flatten));
  }
  emitRows(rows, args, inferCols(rows));
  return rows;
}

async function cmdFeatured(args, ctx) {
  const res = await getJson(`/api/ask/featured`, { ...ctx, gated: notGated });
  const rows = pickList(res.json).map(flatten);
  emitRows(rows, args, inferCols(rows));
  return rows;
}

/** 列表端点的数组藏在哪个键下各不相同，别写死。 */
function pickList(j) {
  if (Array.isArray(j)) return j;
  for (const k of ["list", "items", "data", "rounds", "bounties", "results", "records"]) {
    if (Array.isArray(j?.[k])) return j[k];
  }
  if (j?.data && typeof j.data === "object") {
    for (const k of Object.keys(j.data)) if (Array.isArray(j.data[k])) return j.data[k];
  }
  for (const k of Object.keys(j || {})) if (Array.isArray(j[k])) return j[k];
  return [];
}

/** 嵌套对象压平成一层，方便表格显示；数组只留长度。 */
function flatten(o, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) out[key] = `[${v.length}]`;
    else if (v && typeof v === "object") Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

/** 未知结构的列表，挑几列有信息量的显示。 */
function inferCols(rows) {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]);
  const prefer = ["uid", "id", "title", "name", "status", "created_at"];
  const picked = [...prefer.filter((k) => keys.includes(k))];
  for (const k of keys) {
    if (picked.length >= 6) break;
    if (!picked.includes(k) && !/image|avatar|url|content/i.test(k)) picked.push(k);
  }
  return picked.map((k) => ({ key: k, label: k, max: k === "title" ? 46 : 16 }));
}

function emitRows(rows, args, cols) {
  if (args.out) console.error(`已写入 ${writeOut(args.out, rows)}`);
  if (args.json) return console.log(JSON.stringify(rows, null, 2));
  table(rows, cols);
  console.error(`\n共 ${rows.length} 条`);
}

async function cmdWhoami(args, ctx) {
  const s = ctx.session || sessionName();
  const j = await apiWhoami(s);
  const user = j?.user || null;
  if (args.json) return console.log(JSON.stringify(j, null, 2));
  if (!user) console.log("未登录（浏览器里没有 new.web.cafe 的会话）");
  else console.log(`已登录：${user.name || user.display_name || user.id || JSON.stringify(user)}`);
  return j;
}


/* ─────────────────── SSR 内容：经验 / 帖子 / 教程（无 API） ─────────────────── */

/**
 * 这三块**没有内容 API**，只能解析 RSC。两条硬规则，违反都不报错：
 *
 *   1. **分页只认路径段 `/xxx/<N>`。`?page=N` 被静默忽略**——返回第 1 页，
 *      HTTP 200 且字节数与第 1 页完全相同。用 `?page=` 翻页的脚本会把第 1 页抓 N 遍。
 *   2. **终止判据用 `pageData.totalPage`，不要用 `pagination`**——后者是页码按钮的
 *      滑动窗口（第 1 页是 [1..6]，第 10 页会变成 [5..10]），当成总页数会早停。
 *      也不要只判 404：实测专栏翻页越界返回的是 **308**，不是 404。
 */
/**
 * `gated(props)` 是 **auto 档在 SSR 页面上唯一的升级判据**，缺了它 auto 就是 http。
 *
 * 这条路径和 JSON 那条**不能共用判据**：`getHtml` 只看得见 HTML 字符串，而降级的
 * 特征（`markdown` 被抹成空串）要解析完 RSC 才看得出来。所以判据只能落在这里，
 * 不能塞进 transport 层——塞进去就得把 4M 字的专栏页解析两遍。
 *
 * **不传 `gated` 的调用点必须是「本来就没有正文」的页面**（专栏列表、专栏内文章列表）。
 * 给一个有正文的页面漏传 `gated`，后果不是报错，是 auto 静默退化成 http 拿回空正文。
 */
async function fetchProps(path, ctx, gated) {
  const { html, status, transport } = await getHtml(path, ctx);   // ctx.rsc 会透传下去
  const props = propsFromHtml(html);
  if (!props) throw new Error(`解析 RSC 失败（HTTP ${status}）：${path}`);
  // 登录页长得像一个正常的空页面，必须在这里挡掉，否则它会一路变成「这篇没有正文」。
  if (isLoginPage(props)) throw new Error(`被重定向到登录页（限流或会话失效）：${path}`);
  if (ctx.transport !== "auto" || transport !== "http" || !gated || !gated(props)) return props;

  try {
    const br = await getHtml(path, { ...ctx, transport: "browser" });
    const bp = propsFromHtml(br.html);
    if (isLoginPage(bp)) throw new Error(`浏览器侧也被重定向到登录页（限流或会话失效）：${path}`);
    if (bp) return bp;
    console.error(`（auto 升级到浏览器后解析失败，退回匿名结果：${path}）`);
  } catch (e) {
    // **限流必须穿透，不能退回「匿名结果」。** 退回去就是拿一个空正文当答案，
    // 而调用方分不出「这篇没内容」和「你被挡了」——本轮 503 条假空就是这么来的。
    // 其它升级失败（浏览器没开、桥断了）才允许降级返回，那种情况正文本来也拿不到。
    if (/登录页/.test(e.message)) throw e;
    console.error(`（auto 想升级到浏览器但失败了：${e.message}；下面是匿名结果，正文可能是空的）`);
  }
  return props;
}

/** 列表页降级判据：元数据齐全但**没有任何一条**有正文。 */
const listBlank = (props) => !(props.topicListInit || []).some((t) => (t.markdown || "").length);
/** 详情页降级判据：正文被抹成空串。 */
const detailBlank = (props) => !((props.detailInit || {}).markdown || "").length;

const firstPage = (p) => [].concat(p ?? 1)[0]; // 第 1 页是数字 1，第 2 页起是字符串数组 ["2"]

/** 经验和帖子是同一套结构的两条独立流（uid 无交集），详情页互为别名。 */
async function cmdList(kind, args, ctx, quiet = false) {
  const base = kind === "experiences" ? "/experiences" : "/topics";
  const want = Number(args.pages || 1);
  const rows = [];
  let total = null;
  for (let p = 1; p <= want; p++) {
    // topics 的列表项**根本没有 markdown 字段**，对它用 listBlank 会每页都白开一次浏览器。
    const props = await fetchProps(p === 1 ? base : `${base}/${p}`, ctx, kind === "experiences" ? listBlank : null);
    total = props.pageData?.totalPage ?? total;
    const list = props.topicListInit || [];
    if (!list.length) break;
    for (const t of list) {
      rows.push({
        uid: t.uid,
        title: t.title,
        author: t.user_name,
        reads: t.read_count,
        likes: t.like_count,
        replies: t.reply_count,
        favs: t.favorite_count,
        tips: t.tip_amount,
        vip: t.is_vip,
        created_at: t.created_at,
        chars: (t.markdown || "").length,
        markdown: t.markdown || "",
        url: `${BASE}/${kind === "experiences" ? "experience" : "topic"}/${t.uid}`,
      });
    }
    if (total && p >= total) break;
  }
  // **只有 experiences 的列表项带 markdown；topics 的列表项根本没有这个字段。**
  // 所以「正文为空」在这两条流上含义不同，不能共用一句提示：
  // 对 topics 说「你没登录」是错的，它登录了也不会在列表里给正文。
  const gotBody = rows.some((r) => r.chars > 0);
  const listHasBody = kind === "experiences";
  if (quiet) return rows;   // bodies 调用时不打 722 行表格
  emitRows(rows, args, [
    { key: "uid", label: "uid", max: 12 },
    { key: "author", label: "作者", max: 12 },
    { key: "reads", label: "阅读", max: 6 },
    { key: "likes", label: "赞", max: 4 },
    { key: "chars", label: "字数", max: 6 },
    { key: "title", label: "标题", max: 44 },
  ]);
  if (total) console.error(`（共 ${total} 页）`);
  if (!gotBody && listHasBody) {
    console.error(
      `\n⚠️  正文全为空：经验有**登录墙**（元数据匿名可见，markdown 匿名恒为空串）。` +
        (ctx.transport === "auto"
          ? `\n   auto 已经试过浏览器了还是空——说明浏览器里也不是登录态，先跑 whoami 确认。`
          : `\n   加 --transport auto 重跑——登录后**列表页就直接带全文**，10 个请求拿完全部 91 条。`),
    );
  } else if (!listHasBody) {
    console.error(
      `\n提示：帖子列表**不含正文**（列表项里根本没有 markdown 字段，登录也没有）。` +
        `\n   要正文用 \`topic <uid>\` 逐条取。`,
    );
  }
  return rows;
}

/** 详情：/experience/<uid> 与 /topic/<uid> 是同一个页面的两个别名。 */
async function cmdDetail(kind, uid, args, ctx) {
  if (!uid) die(`用法：webcafe-forum.mjs ${kind} <uid>`);
  const props = await fetchProps(`/${kind}/${uid}`, ctx, detailBlank);
  const d = props.detailInit || {};
  const out = {
    uid: d.uid || uid,
    url: `${BASE}/${kind}/${uid}`,
    title: d.title,
    author: d.user_name,
    created_at: d.created_at,
    reads: d.read_count,
    likes: d.like_count,
    replies: d.reply_count,
    chars: (d.markdown || "").length,
    markdown: d.markdown || "",
  };
  if (args.out) console.error(`已写入 ${writeOut(args.out, out)}`);
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else if (args.md) console.log(`# ${out.title}\n\n来源：${out.url}（${out.author}）\n\n${out.markdown}`);
  else {
    console.log(`${out.title}\n${out.url}（${out.author} · ${out.reads} 阅读 · ${out.likes} 赞）\n`);
    console.log(out.markdown || "(正文为空)");
  }
  if (!out.chars) {
    console.error(
      ctx.transport === "auto"
        ? `\n⚠️  正文为空，且 auto 已经用浏览器重取过一次——浏览器里可能也不是登录态，跑 whoami 确认。`
        : `\n⚠️  正文为空：这类内容有登录墙，加 --transport auto 重跑。`,
    );
  }
  return out;
}

/**
 * 批量把一整条流的**正文**取下来（列表只给元数据，正文要逐条打详情页）。
 *
 * **为什么必须能续跑**：722 条 × 每条一次带登录态的请求，中途任何一次网络抖动、
 * 用户手动关掉标签页、机器休眠，都会让整批白跑。所以落盘用 **JSON Lines 追加**，
 * 重跑时先把已有文件里的 uid 读进来跳过——**这是唯一让「跑了 600 条挂了」不等于
 * 「从头再来」的写法**。
 *
 * **不做并发。** 底层是在用户那一个已登录标签页里执行 in-page fetch，
 * 开 N 个会话就是在用户的 Chrome 里开 N 个标签页；而单会话下这条路径不需要导航，
 * 实测每条 1~2 秒，串行完全够用。**为了快一点去占用户的浏览器是不划算的交易。**
 *
 * 单条失败**故意不写盘**——不写就等于没做过，下次续跑自然会重试它。
 * 写一条「失败占位」看着更完整，实际是把失败固化成了成功。
 */
async function cmdBodies(kind, args, ctx) {
  if (!["topics", "experiences"].includes(kind)) die("bodies 只支持 topics / experiences");
  const detail = kind === "topics" ? "topic" : "experience";
  const out = args.out;
  if (!out || out === true) die(`用法：webcafe-forum.mjs bodies ${kind} --out <文件.jsonl> [--pages N]`);

  const done = new Set();
  if (existsSync(out)) {
    for (const line of readFileSync(out, "utf8").split("\n")) {
      if (!line.trim()) continue;
      // **只有拿到正文才算完成。** 把空正文也记成已完成，等于把一次限流失败
      // 固化成「这篇本来就没内容」，续跑永远不会再碰它——这正是本轮踩到的坑。
      try { const o = JSON.parse(line); if (o.uid && o.chars > 0) done.add(o.uid); } catch { /* 坏行跳过 */ }
    }
    console.error(`续跑：${out} 里已有 ${done.size} 条，跳过。`);
  }

  // **详情页强制走浏览器。** 这两条流的详情页 100% 有登录墙，auto 会先发一次匿名请求、
  // 看到空正文再升级——那一次匿名请求是**必然白发的**，722 条就是 722 次纯浪费，
  // 而且它和浏览器请求同源同 IP，一起算进站点的速率账里。
  // rsc:true 是关键——正文是客户端二次取的，普通 GET 会拿到一个「看起来完整」
  // 但不含 markdown 的整页 HTML，然后被记成「这篇没有正文」。
  // --via nav：真实导航，慢但走站点的正常路径；默认仍是页面内 fetch（快）。
  const via = args.via === true ? "nav" : args.via;
  if (via && via !== "nav" && via !== "fetch") die(`--via 只能是 nav / fetch，收到 "${via}"`);
  const detailCtx = { ...ctx, transport: "browser", rsc: via !== "nav", via };
  const rows = await cmdList(kind, { ...args, json: false, out: null, pages: args.pages || 99 }, ctx, true);
  const todo = rows.filter((r) => !done.has(r.uid));
  console.error(`列表 ${rows.length} 条，待取正文 ${todo.length} 条。`);

  // 站点对持续的详情页请求会限流——**方式是重定向到登录页，不是 429**。
  // 所以要两手：请求之间留间隔，以及连续撞墙就停，别拿 700 次失败去换一个必然的结论。
  const delay = Number(args.delay ?? 700);
  const FUSE = 5;
  const MAX_RELOGIN = Number(args.maxRelogin ?? 12);
  let ok = 0, empty = 0, streak = 0, relogins = 0;

  /** 连撞 FUSE 次之后的统一处置：重登一次。返回 false 表示该收工了。 */
  async function tryRelogin(i) {
    if (relogins >= MAX_RELOGIN) {
      console.error(
        `\n连撞 ${FUSE} 次，且本轮已重登 ${relogins} 次仍无改善——停在 ${i + 1}/${todo.length}。` +
          `\n这时候多半不是登录问题（站点自己在报错，或改了渲染方式）。已取到的都在 ${out} 里。`,
      );
      return false;
    }
    console.error(`  连撞 ${FUSE} 次 → 第 ${relogins + 1} 次自动重新登录……`);
    try {
      const r = await ensureLoggedIn(ctx.session);
      relogins++;
      console.error(r.relogged ? `  ✓ 已重新登录，继续` : `  会话本来就在，另有成因`);
      return true;
    } catch (e) {
      console.error(`  ✗ 自动重登失败：${e.message}\n  已取到的都在 ${out} 里，稍后用同一条命令续跑。`);
      return false;
    }
  }
  for (let i = 0; i < todo.length; i++) {
    const r = todo[i];
    if (i) await sleep(delay);
    try {
      const props = await fetchProps(`/${detail}/${r.uid}`, detailCtx, detailBlank);
      const d = props.detailInit || {};
      const md = d.markdown || "";
      appendFileSync(out, JSON.stringify({
        uid: r.uid, url: r.url, title: r.title, author: r.author,
        created_at: r.created_at, reads: r.reads, likes: r.likes, replies: r.replies,
        chars: md.length, markdown: md,
      }) + "\n");
      md.length ? ok++ : empty++;
      // **空正文也要计入熔断。** 之前熔断只数「被踢到登录页」这种会抛错的情况，
      // 而匿名态下站点返回的是一个**合法但正文为空**的页面——不抛错，于是熔断
      // 永远不触发，528 条空行就这么一路写完了。同一个坑连踩三次都是这个原因：
      // **有报错的失败会被拦住，没报错的失败不会。**
      if (md.length) { streak = 0; continue; }
      if (++streak < FUSE) continue;

      // **掉线是这个站的常态，不是异常。** 实测第一轮撑约 100 条、重登后约 20 条，
      // 所以重新登录必须是取数循环里的一步，而不是让人回来手点的终止条件。
      streak = 0;
      // 重登成功就把这批重排到队尾——它们是被踢下线连累的，不是真的没内容。
      const batch = todo.slice(Math.max(0, i - FUSE + 1), i + 1);
      if (!(await tryRelogin(i))) break;
      todo.push(...batch);
    } catch (e) {
      console.error(`  \u2717 ${r.uid}：${e.message}`);
      // 解析失败和被踢到登录页，**在处置上是同一件事**：都说明这条链路现在取不到东西。
      // 之前只给「空正文」那条路接了自动重登，这条路照旧直接停——于是重登逻辑写好了
      // 却从没被触发过。两个熔断只治一个，等于没治。
      if (++streak < FUSE) continue;
      streak = 0;
      if (!(await tryRelogin(i))) break;
    }
    if ((i + 1) % 25 === 0 || i === todo.length - 1) {
      console.error(`  ${i + 1}/${todo.length}（有正文 ${ok}，空 ${empty}）`);
    }
  }
  console.error(`完成：${ok} 条有正文，${empty} 条为空，自动重登 ${relogins} 次 → ${out}`);
  return { total: rows.length, fetched: ok, empty };
}

/**
 * 教程是三层：`/tutorials`（专栏列表）→ `/tutorial/<columnUid>`（专栏内文章）
 * → `/tutorial/detail/<articleUid>`（文章正文）。
 *
 * **两个坑**：`/tutorial/<articleUid>` 不报错，它会把文章 uid 当专栏 uid，
 * 返回一个 200 的空壳专栏页；文章必须走 `/tutorial/detail/<uid>`。
 * 以及 `/tutorials` 的 `tutorialTopicPageData.totalPage` 是够不着的（路由上限被
 * 专栏的 totalPage 卡死），要拿全部文章只能按专栏逐个下钻。
 */
async function cmdTutorials(args, ctx) {
  const props = await fetchProps("/tutorials", ctx);
  // 字段名和别处不一样：专栏用 `name` 不是 `title`，用 `topic_count` 不是 article_count，
  // 而且**列表里没有 total_words**（那个只在专栏页的 columnInfo 里）。照抄别处会全拿到 undefined。
  const rows = (props.tutorialList || []).map((c) => ({
    uid: c.uid,
    title: c.name,
    articles: c.topic_count,
    paid: c.is_paid,
    price_yuan: c.is_paid ? yuan(c.price) : "",
    url: `${BASE}/tutorial/${c.uid}`,
  }));
  emitRows(rows, args, [
    { key: "uid", label: "uid", max: 12 },
    { key: "articles", label: "文章", max: 6 },
    { key: "paid", label: "付费", max: 5 },
    { key: "price_yuan", label: "价格", max: 7 },
    { key: "title", label: "专栏", max: 40 },
  ]);
  return rows;
}

async function cmdTutorial(uid, args, ctx) {
  if (!uid) die("用法：webcafe-forum.mjs tutorial <columnUid>");
  const want = Number(args.pages || 1);
  const rows = [];
  let info = null;
  for (let p = 1; p <= want; p++) {
    let props;
    try {
      props = await fetchProps(p === 1 ? `/tutorial/${uid}` : `/tutorial/${uid}/${p}`, ctx);
    } catch {
      break; // 越界时站方返回 308 而不是 404，解析失败就是到底了
    }
    info = props.columnInfo || info;
    const list = props.tutorialListInit || [];
    if (!list.length) break;
    rows.push(
      ...list.map((t) => ({
        uid: t.uid,
        title: t.title,
        created_at: t.created_at,
        url: `${BASE}/tutorial/detail/${t.uid}`,
      })),
    );
  }
  if (info) {
    console.error(
      `专栏「${info.name || info.title || uid}」：${info.topic_count ?? info.article_count} 篇 / ${info.total_words ?? "?"} 字 / 付费=${info.is_paid}`,
    );
  }
  emitRows(rows, args, [
    { key: "uid", label: "uid", max: 12 },
    { key: "created_at", label: "时间", max: 20 },
    { key: "title", label: "标题", max: 50 },
  ]);
  return rows;
}

async function cmdTutorialDetail(uid, args, ctx) {
  if (!uid) die("用法：webcafe-forum.mjs tutorial-detail <articleUid>");
  const props = await fetchProps(`/tutorial/detail/${uid}`, ctx, detailBlank);
  const d = props.detailInit || {};
  const out = {
    uid,
    url: `${BASE}/tutorial/detail/${uid}`,
    title: d.title,
    author: d.user_name,
    can_view: props.canViewTutorial,
    chars: (d.markdown || "").length,
    markdown: d.markdown || "",
  };
  if (args.out) console.error(`已写入 ${writeOut(args.out, out)}`);
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else if (args.md) console.log(`# ${out.title}\n\n来源：${out.url}\n\n${out.markdown}`);
  else console.log(`${out.title}\n${out.url}\n\n${out.markdown || "(正文为空)"}`);
  if (!out.chars) {
    console.error(
      `\n⚠️  正文为空（canViewTutorial=${out.can_view}）：教程有登录墙。` +
        (ctx.transport === "auto"
          ? `auto 已经用浏览器重取过一次，仍为空——先跑 whoami 确认登录态。`
          : `加 --transport auto 重跑。`),
    );
  }
  return out;
}

/* ─────────────────────────────── 站内搜索 ─────────────────────────────── */

/**
 * **搜索必须登录，而且没有 JSON 端点。**
 *   - 匿名访问 `/search?q=` 一律 **307 跳回首页**（站内其它页面匿名都是 200，只有它被网关掉）。
 *   - 登录后也**不打任何 `/api/*search*`**，结果是 Server Component 直出 HTML。
 *   - **加 `RSC: 1` 头是陷阱**：返回 200 和 5 万多字节，但里面**没有任何搜索结果**。
 *     必须走普通 HTML。
 *   - 覆盖 `/experience/` 与 `/topic/`，**不覆盖悬赏**（搜「悬赏」返回 0 条）。
 *     别拿它替代 `bounties` 的遍历。
 *   - 页面上三个复选框（完全匹配 / 大小写敏感 / 不搜索群聊总结）**不进 URL**，
 *     纯客户端状态，脚本控制不了。默认是模糊、不敏感、**且排除群聊总结**
 *     ——群聊内容要单独走 `chat-search`。
 */
async function cmdSearch(q, args, ctx) {
  if (!q) die('用法：webcafe-forum.mjs search "关键词"');
  const session = ctx.session;
  const want = Number(args.pages || 1);
  const rows = [];
  let total = null;
  for (let p = 1; p <= want; p++) {
    const r = await browserGet(`/search?q=${encodeURIComponent(q)}&page=${p}`, {
      session,
      accept: "text/html",
    });
    if (/^3/.test(String(r.status)) || !r.text) {
      dumpAndDie(ctx, "search-redirected", "搜索请求返回重定向或空正文。最常见成因是浏览器里没有登录 new.web.cafe（搜索匿名不可用）——是不是这个成因，看现场截图。", {
        status: r.status,
        page: p,
        textLen: (r.text || "").length,
        textHead: (r.text || "").slice(0, 500),
      });
    }
    if (total === null) {
      const m = r.text.match(/共有\s*(\d+)\s*条结果/);
      total = m ? Number(m[1]) : null;
    }
    const hrefs = [...r.text.matchAll(/href="(\/(?:experience|topic|tutorial)\/[A-Za-z0-9/_-]+)"/g)].map(
      (m) => m[1],
    );
    const uniq = [...new Set(hrefs)];
    if (!uniq.length) break;
    for (const h of uniq) rows.push({ path: h, url: BASE + h, page: p });
    if (total !== null && p * 30 >= total) break;
  }
  if (total !== null) console.error(`共有 ${total} 条结果（每页 30，本次取了 ${args.pages || 1} 页）`);
  emitRows(rows, args, [
    { key: "page", label: "页", max: 4 },
    { key: "url", label: "URL", max: 60 },
  ]);
  return rows;
}

/* ────────────────────── 群聊归档搜索（哥飞.ai 的语料） ────────────────────── */

/**
 * `/messages` 是「哥飞的朋友们」14 个微信群的完整聊天记录归档，
 * **也就是站内那个「哥飞.ai」助手的底层知识库**——助手回答里的
 * `<chat_cite msg_id="...">` 引用指向的就是这里的原始消息。
 *
 * **所以想要那批素材，不必去问 AI**：直接搜归档拿到的是原文，
 * 不经过模型转述、不消耗任何对话额度。
 *
 * 端点是 POST，但语义是检索（参数放 body），见 transport 里 browserPost 的说明。
 *
 * **硬上限 50 条，且完全静默**：传 `limit:200` / `page:2` 不报错、不生效，
 * 返回的 50 条与不传时逐条相同。要拿更多只能**换关键词**或**按 room_id 逐群缩小**。
 */
const READ_ONLY_POST = new Set(["/api/community/message/search-message"]);

async function cmdChatSearch(kw, args, ctx) {
  if (!kw) die('用法：webcafe-forum.mjs chat-search "关键词"');
  const path = "/api/community/message/search-message";
  if (!READ_ONLY_POST.has(path)) die("该端点不在只读白名单里"); // 防止以后被改成写端点
  const body = {
    room_id: args.room === undefined || args.room === true ? "all" : args.room,
    keyword: kw,
    case_sensitive: Boolean(args["case-sensitive"]),
    exact_match: Boolean(args.exact),
    content_only: true,
  };
  const r = await browserPost(path, body, { session: ctx.session });
  if (r.status === 401) die("群聊归档搜索需要登录——浏览器里没有 new.web.cafe 的会话。");
  const j = JSON.parse(r.text);
  const rows = (j.message_list || []).map((m) => ({
    at: m.pub_time,
    who: m.sender_nickname,
    group: m.group_name,
    msgid: m.msgsvrid,
    text: m.msg_content,
  }));
  emitRows(rows, args, [
    { key: "at", label: "时间", max: 19 },
    { key: "who", label: "发言人", max: 12 },
    { key: "group", label: "群", max: 14 },
    { key: "text", label: "内容", max: 70 },
  ]);
  if (rows.length === 50) {
    console.error(
      `\n⚠️  正好 50 条 = 撞到硬上限了（服务端固定 50，传 limit/page 会被静默忽略）。` +
        `\n   要拿更多请换更具体的关键词，或用 --room <room_id> 逐群缩小。`,
    );
  }
  return rows;
}

/* ───────────────────────── 付费问答（round，不是 bounty） ───────────────────────── */

/**
 * **round 和 bounty 是两套产品，别混。** round 是 1 对 1 付费提问
 * （提问者付钱给某个专家），bounty 是众筹悬赏（多人凑钱、多人竞答）。
 *
 * 一个 round = 一问一答**一轮**；同一个 `root_uid` 下 `seq` 递增就是追问。
 * **详情端点吃的是 `root_uid` 不是列表里的 `uid`**——`seq>1` 的行两者不同，
 * 用错会 404 或者拿到别的线程。
 *
 * 付费墙只挡**一个字段** `answer_content`；其余元数据（含 `answer_char_count`
 * 和 31 字 `answer_teaser`）匿名全给。
 */
async function cmdQuestion(rootUid, args, ctx) {
  if (!rootUid) die("用法：webcafe-forum.mjs question <root_uid>");
  const res = await getJson(`/api/ask/question/${encodeURIComponent(rootUid)}`, {
    ...ctx,
    gated: (j) => (j?.thread?.rounds || []).some((r) => !r.unlocked),
  });
  const th = res.json?.thread;
  if (!th) {
    dumpAndDie(ctx, "no-question-data", `没拿到问答数据（HTTP ${res.status}）`, {
      status: res.status,
      transport: res.transport,
      jsonExcerpt: JSON.stringify(res.json ?? null).slice(0, 2000),
    });
  }
  const rows = (th.rounds || []).map((r) => ({
    seq: r.seq,
    uid: r.uid,
    price_yuan: yuan(r.price), // 注意：price 没有 _fen 后缀，单位却也是分
    unlocks: r.unlock_count,
    likes: r.like_count,
    tips_yuan: yuan(r.tip_total),
    chars: r.answer_char_count,
    unlocked: r.unlocked,
    question: r.question_content,
    answer: r.answer_content || r.answer_teaser || "",
  }));
  if (args.out) console.error(`已写入 ${writeOut(args.out, rows)}`);
  if (args.json) return console.log(JSON.stringify(rows, null, 2));
  console.log(`${th.asker?.name || "?"} → ${th.expert?.name || "?"}（${rows.length} 轮）\n`);
  for (const r of rows) {
    console.log(`── 第 ${r.seq} 轮 · ${r.price_yuan} 元 · ${r.unlocks} 人围观 · ${r.chars} 字`);
    console.log(`问：${r.question}`);
    console.log(`答：${r.answer}${r.unlocked ? "" : "  ←（未解锁，这是 31 字预览）"}\n`);
  }
  return rows;
}


/* ────────────────────────────── 哥飞.ai（站内） ────────────────────────────── */

/**
 * **和 `seo.web.cafe/chat/` 不是同一个东西。** 站内导航「AI 工具」下并列三条：
 *   `/chat`（哥飞.ai，本节）与工具箱数据是不同用途；调研与 review 改用官方 gefei Skill。
 *
 * 【它的知识库就是群聊归档——这条决定了你该用哪条路】
 * 助手回答里带 `<chat_cite msg_id="...">` 引用，点开跳到 `/messages` 的**微信群原始消息**。
 * 也就是说它的语料 = `chat-search` 能直接搜的那批归档。
 * **要素材就用 `chat-search`**：拿到的是原文、不经模型转述、不消耗任何额度。
 * 调研综合使用官方 knowledge_ask；这里保留显式站内对话与历史读取用途。
 *
 * 【计费：读侧看不出来，所以本脚本默认不发消息】
 * 把 `/chat` 加载的全部 29 个 chunk 扫过 `今日|剩余|次数|额度|咖啡豆|上限|quota` 等，
 * **没有任何配额文案，页面上也没有计数器**——不像 seo.web.cafe/chat 会明写「今日已用 N/M」。
 * 服务端到底扣不扣额度，从只读侧无法证实。
 * 所以 `ask` 需要显式加 `--send` 才会真的发出去，默认只做 dry-run 打印将要发送的内容。
 */
async function cmdAiSessions(args, ctx) {
  const r = await browserGet("/api/ai/sessions", { session: ctx.session });
  if (r.status === 401) die("哥飞.ai 需要登录——浏览器里没有 new.web.cafe 的会话。");
  const j = JSON.parse(r.text);
  const rows = (Array.isArray(j) ? j : j.sessions || []).map((x) => ({
    session_id: x.session_id,
    created_at: x.created_at,
    preview: x.preview || "",
  }));
  emitRows(rows, args, [
    { key: "created_at", label: "时间", max: 20 },
    { key: "session_id", label: "session_id", max: 36 },
    { key: "preview", label: "首条提问", max: 50 },
  ]);
  return rows;
}

/** 读回一整条对话。**历史是免费的**，不产生任何新的调用。 */
async function cmdAiHistory(id, args, ctx) {
  if (!id) die("用法：webcafe-forum.mjs ai-history <session_id>（用 ai-sessions 查）");
  const r = await browserGet(`/api/ai/sessions/${id}/messages`, { session: ctx.session });
  if (r.status === 401) die("哥飞.ai 需要登录。");
  const j = JSON.parse(r.text);
  const msgs = (Array.isArray(j) ? j : j.messages || []).map((m) => ({
    seq: m.sequence_order,
    role: m.role,
    at: m.timestamp,
    content: m.content,
  }));
  if (args.out) console.error(`已写入 ${writeOut(args.out, msgs)}`);
  if (args.json) return console.log(JSON.stringify(msgs, null, 2));
  for (const m of msgs) {
    console.log(`\n── ${m.role === "user" ? "问" : "答"}（#${m.seq}）`);
    console.log(m.content);
  }
  console.error(`\n共 ${msgs.length} 条消息`);
  return msgs;
}

/**
 * 向哥飞.ai 提问。**默认 dry-run**，要真发必须显式 `--send`。
 * 理由见本节顶部：计费无法从读侧证实，而且多数场景 `chat-search` 是更好的选择。
 *
 * `--session-id` 复用一条已有会话（不新建）；不给就必须显式 `--new`，
 * 那会 POST `/api/ai/sessions` 真的建一条新会话。
 */
async function cmdAsk(question, args, ctx) {
  if (!question) die('用法：webcafe-forum.mjs ask "问题" --send [--session-id <id>]');
  const sid = args["session-id"];
  if (!args.send) {
    console.log("【dry-run，没有真的发出去】");
    console.log(`会话：${sid || "（未指定，需要 --new 才会新建）"}`);
    console.log(`问题：${question}`);
    console.error(
      `\n要真的发送请加 --send。\n` +
        `提示：如果你只是想要群聊里的原始素材，用 \`chat-search "${question}"\` 更好——` +
        `拿到原文、不经模型转述、不消耗额度。`,
    );
    return null;
  }
  if (!sid && !args.new) die("要发送必须给 --session-id <id>（复用已有会话），或显式 --new（新建会话）。");
  let sessionId = sid;
  if (!sessionId) {
    const c = await browserPost("/api/ai/sessions", {}, { session: ctx.session });
    sessionId = JSON.parse(c.text).session_id;
    console.error(`已新建会话 ${sessionId}`);
  }
  const r = await browserPost("/api/ai/chat", { session_id: sessionId, message: question }, { session: ctx.session });
  if (r.status === 401) die("哥飞.ai 需要登录。");
  // 返回是裸的 `data: {json}` 行协议（不是标准 SSE 头）。逐行 parse，按序拼 delta。
  const parts = [];
  const meta = [];
  for (const line of r.text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const body = line.slice(5).trim();
    if (!body || body === "[DONE]") continue;
    try {
      const o = JSON.parse(body);
      if (typeof o.content === "string") parts.push(o.content);
      else if (typeof o.delta === "string") parts.push(o.delta);
      else if (typeof o.text === "string") parts.push(o.text);
      else meta.push(o);
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  const answer = parts.join("");
  const out = { session_id: sessionId, question, answer, meta };
  if (args.out) console.error(`已写入 ${writeOut(args.out, out)}`);
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else console.log(answer || "(没有解析出正文，用 --json 看原始事件)");
  if (meta.length) console.error(`\n事件元数据：${JSON.stringify(meta).slice(0, 400)}`);
  return out;
}

/**
 * 逃生舱：直接打任意 `/api/...` 路径，带上同一套 transport 开关。
 *
 * 站里还有一批端点数据量小、没必要各写一条命令（`/api/ask/home` 首页聚合、
 * `/api/ask/experts` 122 位专家、`/api/ask/activity` 30 条动态、
 * `/api/showcase/list` 8 条广告位、`/api/community/random-recommend` 10 条随机帖），
 * 以及**以后站方新增的任何端点**。有这条就不用为了试一个新端点改代码。
 *
 * **只发 GET。** 要发 POST 的检索端点走 `chat-search`（那条有白名单）。
 */
async function cmdApi(path, args, ctx) {
  if (!path) die('用法：webcafe-forum.mjs api /api/ask/home');
  if (!path.startsWith("/")) path = "/" + path;
  const res = await getJson(path, { ...ctx, gated: notGated });
  if (args.out) console.error(`已写入 ${writeOut(args.out, res.json)}`);
  console.log(JSON.stringify(res.json, null, 2));
  console.error(`\n（HTTP ${res.status}，经由 ${res.transport}）`);
  return res.json;
}

/* ────────────────────────── 万能入口：get <url> ────────────────────────── */

/**
 * URL → 命令的路由表。**认不出就退回通用 SSR 抓取**，
 * 这样站方新增页面类型时不会当场失效，只是拿到的结构粗一些。
 */
const ROUTES = [
  // 顺序有讲究：更长的路径要排在更短的前面，否则 /tutorial/detail/<id> 会被
  // /tutorial/<id> 抢先匹配，然后**静默**返回一个空壳专栏页（HTTP 200，不报错）。
  { re: /\/ask\/bounty\/([a-z0-9]+)/i, run: (m, a, c) => cmdBounty(m[1], a, c) },
  { re: /\/ask\/bounty\/?(?:\?|$)/i, run: (m, a, c) => cmdBounties(a, c) },
  { re: /\/ask\/rounds\/?(?:\?|$)/i, run: (m, a, c) => cmdRounds(a, c) },
  { re: /\/ask\/q\/([a-z0-9]+)/i, run: (m, a, c) => cmdQuestion(m[1], a, c) },
  { re: /\/tutorial\/detail\/([a-z0-9]+)/i, run: (m, a, c) => cmdTutorialDetail(m[1], a, c) },
  { re: /\/tutorials\/?(?:\?|$)/i, run: (m, a, c) => cmdTutorials(a, c) },
  { re: /\/tutorial\/([a-z0-9]+)/i, run: (m, a, c) => cmdTutorial(m[1], a, c) },
  { re: /\/experiences\b/i, run: (m, a, c) => cmdList("experiences", a, c) },
  { re: /\/topics\b/i, run: (m, a, c) => cmdList("topics", a, c) },
  { re: /\/experience\/([a-z0-9]+)/i, run: (m, a, c) => cmdDetail("experience", m[1], a, c) },
  { re: /\/topic\/([a-z0-9]+)/i, run: (m, a, c) => cmdDetail("topic", m[1], a, c) },
  { re: /\/search\?.*\bq=([^&]+)/i, run: (m, a, c) => cmdSearch(decodeURIComponent(m[1]), a, c) },
];

async function cmdGet(url, args, ctx) {
  if (!url) die("用法：webcafe-forum.mjs get <url>");
  if (!/^https?:\/\//i.test(url)) url = BASE + (url.startsWith("/") ? url : "/" + url);
  for (const r of ROUTES) {
    const m = url.match(r.re);
    if (m) return r.run(m, args, ctx);
  }
  return cmdPage(url, args, ctx);
}

/**
 * 通用页面抓取：没有专用 API 的页面走这条。
 * 这个站是 Next.js App Router，正文在 RSC flight payload（`self.__next_f`）里，
 * 不在普通 DOM 属性里。所以先拼 flight，再退回可见文本。
 */
async function cmdPage(url, args, ctx) {
  const { html, status } = await getHtml(url, ctx);
  const text = extractReadable(html);
  const out = {
    url,
    status,
    title: (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "",
    links: [...new Set((html.match(/\/(?:experience|topic|tutorial|ask)\/[A-Za-z0-9/_-]+/g) || []))],
    text,
  };
  if (args.out) console.error(`已写入 ${writeOut(args.out, out)}`);
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`${out.title}\n${url}\n`);
    console.log(out.text.slice(0, 4000));
    if (out.text.length > 4000) console.error(`\n（正文 ${out.text.length} 字，已截断；用 --json 或 --out 取全文）`);
    console.error(`\n站内链接 ${out.links.length} 条`);
  }
  return out;
}

/**
 * 从 Next.js 的 RSC flight payload 里拼出可读正文。
 *
 * flight 是 `self.__next_f.push([1,"<转义过的分片>"])` 一串，拼起来才是完整流；
 * **单独看任何一片都可能把一个字符串从中间切断**，所以必须先全部拼接再解析。
 */
function extractReadable(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,\s*"((?:\\.|[^"\\])*)"\]\)/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      chunks.push(JSON.parse(`"${m[1]}"`));
    } catch {
      /* 拼不出来的片跳过，不要让一片坏的毁掉整篇 */
    }
  }
  const flight = chunks.join("");
  // flight 里正文以 JSON 字符串形式散落，抽出足够长的中文/英文段落即可。
  const found = [];
  const sre = /"((?:[^"\\]|\\.){40,})"/g;
  let s;
  while ((s = sre.exec(flight))) {
    let v;
    try {
      v = JSON.parse(`"${s[1]}"`);
    } catch {
      continue;
    }
    if (/^https?:\/\//.test(v)) continue;
    if (/^[\w$./-]+$/.test(v)) continue; // 模块路径、chunk 名
    if (!/[\u4e00-\u9fa5]|\s/.test(v)) continue;
    found.push(v);
  }
  const seen = new Set();
  return found.filter((v) => (seen.has(v) ? false : seen.add(v))).join("\n\n");
}

/* ─────────────────────────────── main ─────────────────────────────── */

const HELP = `webcafe-forum.mjs —— new.web.cafe（哥飞社区论坛）全站取数

  get <url>              万能入口：给任意站内 URL，自动路由到对应取法

  悬赏问答（有 JSON API，元数据匿名可拿）
  bounty <uid>           悬赏详情。kind=answer 给答案正文；kind=collect 给榜单+提交理由
  bounties               悬赏列表   --status funding|answering|collecting|voting|settled|open
  rounds                 公开付费问答 --sort smart|latest|tips|likes|unlocks|price --pages <n>
  question <root_uid>    一条问答线程的全部轮次（吃 root_uid，不是列表里的 uid）
  featured               首页精选

  内容（无 API，解析服务端渲染；正文需登录）
  experiences            经验列表 --pages <n>   （共 10 页 / 91 条）
  topics                 帖子列表 --pages <n>   （共 37 页 / 722 条）
  experience|topic <uid> 详情（两者互为别名）
  tutorials              教程专栏列表（40 个专栏）
  tutorial <columnUid>   某专栏下的文章 --pages <n>
  tutorial-detail <uid>  教程文章正文

  检索（都必须登录）
  search "词"            站内搜索 --pages <n>（30/页；**不覆盖悬赏**）
  chat-search "词"       哥飞的朋友们微信群归档（哥飞.ai 的语料）--room <id> --exact
  bodies <topics|experiences> --out <f.jsonl> [--pages N]
                         批量取整条流的**正文**（列表只给元数据）。JSON Lines 追加，
                         **可续跑**：重跑自动跳过**已取到正文**的 uid（空的会重试）。
                         串行、默认间隔 700ms（--delay）；连续 5 条空正文即熔断
                         --via nav 改走**真实导航**（2~4 秒/条，但和用户手点同一条路）
  whoami                 浏览器里是不是登录态
  api <path>             逃生舱：直接打任意 /api/... （GET），带同一套 transport
                         例：api /api/ask/home · /api/ask/experts · /api/ask/activity

  哥飞.ai（站内 /chat，**不是** seo.web.cafe 那个）
  ai-sessions            列出你的历史对话
  ai-history <id>        读回一整条对话（免费，不产生新调用）
  ask "问题"             提问。**默认 dry-run**，要真发加 --send
                         --session-id <id> 复用已有会话 / --new 新建

通用选项
  --transport auto|http|browser   默认 auto：先匿名 HTTP，正文被抹掉才动浏览器
  --session <名>                  opencli 会话名，默认自动派生（别写死）
  --json                          原始 JSON
  --md                            Markdown（详情类命令）
  --out <文件>                    落盘（.jsonl 走 JSON Lines）
  -h, --help

注意：匿名不会 401——它返回 200 和完整条目，只把正文抹成空串。
      正文取不到时脚本会在 stderr 说明是哪一种（anonymous / sealed / needs-unlock），
      并在 --json 输出里带 suggested_access + access_evidence 字段。**脚本绝不会自动解锁（那要花钱）。**`;

async function main() {
  const args = parseArgs();
  const cmd = args._[0];
  if (args.help || !cmd) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const ctx = {
    transport: args.transport === undefined || args.transport === true ? "auto" : args.transport,
    session: args.session === undefined || args.session === true ? sessionName() : args.session,
  };
  if (!["auto", "http", "browser"].includes(ctx.transport)) {
    die(`--transport 只能是 auto / http / browser，收到 "${ctx.transport}"`);
  }

  const ownSession = args.session === undefined || args.session === true;
  try {
    switch (cmd) {
      case "get": await cmdGet(args._[1], args, ctx); break;
      case "bodies": await cmdBodies(args._[1], args, ctx); break;
      case "bounty": await cmdBounty(args._[1], args, ctx); break;
      case "bounties": await cmdBounties(args, ctx); break;
      case "rounds": await cmdRounds(args, ctx); break;
      case "featured": await cmdFeatured(args, ctx); break;
      case "whoami": await cmdWhoami(args, ctx); break;
      case "api": await cmdApi(args._[1], args, ctx); break;
      case "question": await cmdQuestion(args._[1], args, ctx); break;
      case "experiences": await cmdList("experiences", args, ctx); break;
      case "topics": await cmdList("topics", args, ctx); break;
      case "experience": await cmdDetail("experience", args._[1], args, ctx); break;
      case "topic": await cmdDetail("topic", args._[1], args, ctx); break;
      case "tutorials": await cmdTutorials(args, ctx); break;
      case "tutorial": await cmdTutorial(args._[1], args, ctx); break;
      case "tutorial-detail": await cmdTutorialDetail(args._[1], args, ctx); break;
      case "search": await cmdSearch(args._[1], args, ctx); break;
      case "chat-search": await cmdChatSearch(args._[1], args, ctx); break;
      case "ai-sessions": await cmdAiSessions(args, ctx); break;
      case "ai-history": await cmdAiHistory(args._[1], args, ctx); break;
      case "ask": await cmdAsk(args._[1], args, ctx); break;
      case "page": await cmdPage(args._[1], args, ctx); break;
      default: die(`未知命令 "${cmd}"。跑 -h 看用法。`);
    }
  } finally {
    // 自己派生的会话自己收；用户显式指定的会话是他的，不要替他关。
    if (ownSession) await closeSession(ctx.session);
  }
}

main().catch((e) => {
  console.error(`失败：${e.message}`);
  process.exit(1);
});
