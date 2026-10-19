# Plain-language routing index

Detailed user phrasing and the original route index, preserved for ambiguous requests. Paths and pointers are relative to `backlink/SKILL.md`.

<plain-language-index>
<why>
The `route` rows below are written for someone who already knows what this
Skill contains. **Real asks do not arrive in that shape.** They arrive as one
vague Chinese sentence, from a user who has never seen this file and does not
know that 64 platform pages or 40-odd scripts exist. This table is the
intent→capability index for that sentence: left column is what the user
actually says, right column is the ONE place to open first. Read the whole
table before deciding "this Skill can't do that" — the answer is usually a
file the user could not have named.
</why>
<how-to-read>
One row = one starting point, not a recipe. Open it, then follow its own
pointers. Rows are grouped; within a group the later row is the more specific.
</how-to-read>

<group name="发外链：去哪发、能不能发"><![CDATA[
| 用户大概会这么说 | 从这里开始 |
|---|---|
| 「帮我发点外链」「给我的站搞点外链」（最模糊的那句） | `node scripts/targets-select.mjs --stats` 看现有入口库有什么，再 references/submission-lanes.md 选一个 cohort。**不要**先去搜索引擎找新站 |
| 「有没有不用注册就能发的」「免费的、立刻能发的」 | `data/free-channels.json` 过 `account:"none"` + `status:"live"`，机制看 references/instant-publish.md。目录提交不满足这句话 |
| 「能花钱买吗」「竞品这些链是买的吧」 | references/paid-platforms.md → `data/paid-platforms.json`（按被多少独立站点观察到排） |
| 「把这个站提交到目录站」「提交外链目录」 | references/submission-lanes.md → `scripts/submit-directory.mjs`；真实一轮会遇到什么见 references/directory-run-playbook.md |
| 「这个目标之前摸清楚过，别再走一遍 AI 探查了」「照上次的字段映射直接填」 | references/known-forms.md → `scripts/submit-known.mjs --domain <domain> --project <slug>`，读 `scripts/known-forms/<domain>.json` 的人工字段映射，跳过 inspect-page.mjs 的启发式分类，但 safe-fill.mjs 的活页面校验、release-submit-guard.mjs、终止条件全部照旧 |
| 「去博客评论区留链接」「评论外链」 | `scripts/harvest-commenters.mjs` 先拿到真在评论的域名，再走 screen → submit |
| 「我有 300 个站要批量提」「跑一轮不能中断」 | references/batch-campaign.md。单站循环跑 300 遍是错的（幂等、断点、报表都缺） |
| 「别人给了我一份『500 个免费外链网站』」 | `node scripts/third-party-list-ingest.mjs --blocklist data/network-fingerprints.json`，再读 references/instant-publish.md 的「Reading a third-party list」 |
| 「让 Google / Brave 收录我的新页面」 | references/index-submission.md。它不产生外链，永远不进 placement ledger |
| 「帮我写封外链合作邮件」 | references/outreach-templates.md |
]]></group>

<group name="判断值不值得发：质量、毒性、流量"><![CDATA[
| 用户大概会这么说 | 从这里开始 |
|---|---|
| 「这些外链质量怎么样」「我的外链档案健不健康」 | references/link-quality-rubric.md，模板在 references/analysis-templates.md |
| 「有没有垃圾链要拒绝」「要不要 disavow」「毒性」 | references/link-quality-rubric.md 的毒性部分 + `data/network-fingerprints.json`（网络家族指纹是负面证据，不是投放位） |
| 「这个站看着不行，别发了吧」 | 先读 references/acquisition-doctrine.md **再**否掉。凭 DR 低 / nofollow / 不同题材单方面否掉是本 Skill 明令禁止的 |
| 「这个站有没有人访问」「有没有流量，值不值得提交」 | references/traffic-screen.md → `scripts/similarweb-batch.mjs` 或 `scripts/semrush-batch.mjs`（一次登录、N 个域名、可续跑；只出证据行，不出判决） |
| 「两个工具给的流量对不上」 | `node scripts/traffic-crosscheck.mjs` 只报差异，怎么读这个差异见 references/traffic-screen.md。它不会给「一致/冲突」结论 |
| 「先看看这个页面上写了什么」「这个站收不收费」 | <workflow-ref id="explore"/>；公开页用 `node scripts/page-read.mjs`（只读，出文本片段+截图，不出布尔判决） |
| 「这 150 个站的表单长什么样」「能不能自动填」 | `scripts/probe-submission-targets.mjs` 探路 → `scripts/fingerprint-forms.mjs` 按**表单形状**聚类（一个 adapter 覆盖二十个站）→ `scripts/inspect-page.mjs` 做单站表单普查 |
]]></group>

<group name="看竞品：他的外链和流量是哪来的"><![CDATA[
| 用户大概会这么说 | 从这里开始 |
|---|---|
| 「竞品的外链是从哪来的」 | <ref file="../platforms/semrush/backlink-analytics/OVERVIEW.md"/>（backlinks / refdomains / anchors / backlink-gap 各页能给什么、坑在哪），再决定跑哪个采集 |
| 「谁在给他导流量」「他的推荐流量来源」 | <ref file="../platforms/similarweb/referrals/OVERVIEW.md"/>（incoming / outgoing） |
| 「帮我找一批新机会」「顺着竞品往下挖」 | references/discovery-loop.md + `scripts/discovery-queue.mjs`（递归展开竞品与评论者），挖到的必须并回登记库 |
| 「用 Google 搜索指令挖提交页」「inurl:submit」「write for us 挖投稿站」「搜索指令挖外链」 | references/discovery-loop.md 的「Footprint discovery」一节 → `node scripts/footprint-discover.mjs --keyword "<垂类词>" --preset submit`。`backlink/.env` 有 `SERPER_API_KEY` 时脚本优先走 Serper.dev API（免费层带运算符 query 顶 10 条）；无 key 才回落到 OpenCLI 打开机主已登录的真实 Chrome，这条路线约 4 条运算符 query 起就触发 CAPTCHA，出口 IP 一旦被标记，换独立 profile 也一样被拦（2026-09-12 agent-browser 实测）。anysearch/Tuner/Bing/DuckDuckGo 都不执行 `inurl:`/`intitle:` 运算符；命中 CAPTCHA 就停，不绕过 |
| 「他和我的受众重合吗」 | <ref file="../platforms/similarweb/audience/OVERVIEW.md"/>（三域名韦恩图，一条深链就是一次三方对比） |
]]></group>

<group name="面板取数：我不知道这些平台有什么功能"><![CDATA[
| 用户大概会这么说 | 从这里开始 |
|---|---|
| **「Semrush 能查什么」「这工具有什么功能」「我不知道该看哪个报表」** | **<ref file="../platforms/semrush/OVERVIEW.md"/>** — 平台总览：套餐边界、配额纪律、跨页通用坑、六个板块索引。**任何 Semrush 相关的模糊问题都从这一页开始**，不要凭记忆回答「它有没有这个功能」 |
| **「Similarweb 能查什么」** | **<ref file="../platforms/similarweb/OVERVIEW.md"/>** — 同上，五个板块索引 |
| 「这两个工具我们到底买到了哪些功能 / 哪些还没探过」 | references/semrush-feature-map.md · references/similarweb-feature-map.md（✅ 已实测 / ⬜ 未探索 / ❓ 套餐可能不含，逐工具标注） |
| 「我要查某个具体指标」（自然排名词、付费广告词、外链缺口、关键词聚类、行业榜单、受众画像…） | 先读平台 OVERVIEW 的板块索引 → 板块 OVERVIEW → 目标页的 `PAGE.md`（URL 模板、数据清单、就绪判据、已知坑、验证记录）。规约见 <ref file="../platforms/README.md"/> |
| 「把这个后台的表格给我导出来」「这个 SaaS 没有 API」 | references/harvest.md（**这一节与外链无关也适用**：广告后台、电商后台、任何无 API 报表） |
| 「这表有 1,430 页，只采到第 1 页」「怎么翻页 / 全量导出」 | <ref file="references/pagination-harvest.md"/> + `scripts/harvest-paginated.mjs`（判据全在纯函数层 <ref file="scripts/lib-pagination.mjs"/>：分页器解析、采页计划、断点续跑状态机、行数自检，离线可测）。**先判机制（`--probe`）、再试水 2 页、最后才加量**；`--max-pages` 默认 5，**绝不默认全量**——1,430 页按实测节奏是 4–8 小时且全程占着机器级配额锁 |
| 「打开面板/授权账号在哪」「配额还剩多少」「换个节点」 | references/authorized-data-sources.md → `scripts/tools-share-open.mjs`（唯一的面板启动器）· `scripts/tools-share-node.mjs`（每个 node 是不同的共享账号：配额满了是换 node，不是重试） |
| 「这个页面我们没测过 / 手册里没有」「先勘测一下这页有没有数据」 | `node scripts/ground-truth.mjs --url <url> --out <evidence-dir>` —— 双证人采集：穿透 shadow DOM 的 census + 成对截图。**它只采集，不下结论**；「有数据/空/功能不存在」由你拿两个证人对质后判，见 <law-ref id="every-measurement-needs-two-witnesses"/>。判完把结论写回对应 `PAGE.md` 的验证记录 |
| 「一个域名的总体盘面」「AS / 自然流量 / 引荐域名」 | `scripts/semrush-overview.mjs`；.Trends 的总访问量（唯一能和 Similarweb 对比的数字）走 `scripts/semrush-traffic.mjs`（**默认可见**：先走虚拟屏幕，检测不到才回退前台，见 <law-ref id="hidden-tabs-do-not-hydrate"/>） |
]]></group>

<group name="收尾与自查"><![CDATA[
| 用户大概会这么说 | 从这里开始 |
|---|---|
| 「上次发的那些到底发出去没有」「有没有真的挂上链接」 | <workflow-ref id="verify"/> + `node scripts/ledger.mjs`。目录站说「已收录」不算，`rel_verified` 才算 |
| 「现在做到哪一步了」「还剩多少没提」 | `node scripts/ledger.mjs stats` |
| 「浏览器又抢我标签页了」「页面读回来的不是我打开的那个」 | references/browser-runtime.md（★★ 任何浏览器动作前先读），动手前跑 `node scripts/health.mjs` |
| 「我要提交表单了」「可以点提交吗」 | references/safety-policy.md。**standing authorization（2026-10-20）：调用本 skill 即授权端到端提交**——free/open/captcha-free 目标直接填+点提交+记台账；只有 CAPTCHA/付费/注册墙才 staged 人工（`release-submit-guard.mjs --human-handoff`），验证码永远不解 |
| 「实际跑起来会卡在哪」 | references/field-notes.md（真实阻塞点）· references/directory-run-playbook.md（真实一轮的意外） |
]]></group>
</plain-language-index>

<route ask="Somewhere I can post without registering">
  `data/free-channels.json` filtered to `account: "none"` and `status: "live"`,
  then <ref file="references/instant-publish.md"/> for that class's mechanics.
  Directory submission does NOT satisfy this ask; burning a campaign discovering
  that is the common failure.
</route>
<route ask="What paid options exist / where did this competitor buy its links">
  <ref file="references/paid-platforms.md"/>, then `data/paid-platforms.json`
  sorted by how many independent sites were observed using each.
</route>
<route ask="Find me new opportunities">
  <ref file="references/discovery-loop.md"/> — merge whatever you harvest back
  into the registry.
</route>
<route ask="Where can I submit this site">
  `node scripts/targets-select.mjs --stats`, then one cohort at a time per
  <ref file="references/submission-lanes.md"/>.
</route>
<route ask="Is this link profile any good">
  <ref file="references/link-quality-rubric.md"/>
</route>
<route ask="Get these numbers out of a dashboard with no API">
  <ref file="references/harvest.md"/>
</route>
<route ask="Here are 300 directories, submit to them / a campaign that must survive interruption">
  <ref file="references/batch-campaign.md"/>. The single-target loop is correct
  per target and wrong per campaign.
</route>
<route ask="Someone published a list of backlink sites, is it useful">
  `scripts/third-party-list-ingest.mjs --blocklist data/network-fingerprints.json`
  to normalise, diff, and preserve known network-family exclusions, then the
  "Reading a third-party list" section of
  <ref file="references/instant-publish.md"/>.
</route>
<route ask="Submit our pages to Brave / another engine, why is our index count low">
  <ref file="references/index-submission.md"/>. It publishes no link, so it never
  enters the placement ledger.
</route>
<route ask="Should we post here at all — off-topic host, low DR, known nofollow">
  <ref file="references/acquisition-doctrine.md"/> BEFORE rejecting anything.
</route>
<route ask="Just open this page and tell me what is on it">
  <workflow-ref id="explore"/> — still OpenCLI, still a script.
</route>
<query-the-data>
Query the data rather than reading JSON by eye.
<cmd><![CDATA[
node -e 'const d=require("./data/free-channels.json");console.log(d.channels.filter(c=>c.account==="none"&&c.status==="live").map(c=>`${c.id}\t${c.kind}`).join("\n"))'
node scripts/paid-platform-registry.mjs list --min-sites 2
]]></cmd>
</query-the-data>
