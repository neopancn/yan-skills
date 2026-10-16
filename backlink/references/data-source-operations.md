# Shared dashboard collection details

Panel launch, quota, and Semrush overview collection details. Read when using the shared dashboard. Paths and pointers are relative to `backlink/SKILL.md`.

<panel-launch>
Both live behind one shared-account panel, and launching through the launcher is
mandatory — a deep link into the tool origin before the launcher runs lands on
`about:blank`.
<cmd>node scripts/tools-share-open.mjs --tool semrush</cmd>
Both entry points are **optional overrides**, not prerequisites.
`lib-tools-share.mjs` ships a `DEFAULT_DASHBOARD` and loads the Skill's
gitignored `.env`, so the scripts run with neither variable set — an earlier
revision of this file called them required, which sent a tester hunting for
configuration that was already there. Set them only to point at a different
dashboard:
<cmd><![CDATA[
export TOOLS_SHARE_DASHBOARD_URL="https://<your-authorized-dashboard>"
export TOOLS_SHARE_APP_ORIGIN="https://<origin-the-dashboard-launches-into>"
]]></cmd>
The launched application sits on a different host from the dashboard entry
point, so the second cannot be derived from the first.

All of these share one launcher, `lib-tools-share.mjs`. **Do not write a second
one.** The launch sequence was once copied inline into `similarweb-query.mjs`
(before that script moved off the panel to the Pro JSON API) and omitted three of
the four known traps, failing with a generic "unavailable" whose real cause
differed every time.

**Check the subscription expiry before planning around it** — it is short-dated,
the scripts print it, and they warn inside 7 days.

**Budget the whole recon against the quota printed at launch.** Reusing a
session skips the launcher, which is the point, and the side effect is that the
quota text never re-renders — so no reused-session call prints a fresh reading.
A rule like "stop at 80%" cannot be enforced mid-run; decide the size of the
run up front.

**同一任务、同一工具固定传同一个 `--session`，零值复查也不新建，整批完成后只关一次。**
`launchTool()` 会优先复用已经停在目标工具 origin 的 session，但调用方仍必须固定传入同名；
重复打开 dashboard 可能被面板计作新的客户端登录，不能用换 session 代替复查。

**Raise your shell timeout before a batch, not after it fails.** A panel launch
costs 20–40s and each report ~15s, so five domains or a dozen keywords in one
call runs for minutes and a two-minute default kills it mid-flight. The scripts
write incrementally so nothing is lost, but the run still has to be restarted.

**每个节点是一个不同的共享账号，会分别用完每日报告限额。** 2026-08-27 实测：默认节点跑
Semrush 报表返回「已达到每日报告限额」，换到 `节点2`（一个当天还没被用满的账号）之后同一份
报表立刻跑通。**这张被限额的页面照样渲染完整的表头**——所有列名都在，只有表体被换成了那句
限额提示——所以任何只认表头就判定"页面就绪"的检查都会通过，然后把一张空表当成真实数据。

**目前只有 `semrush-report.mjs` 会自动识别这句提示**。⚠️ 一条更早的复核说这里「当前是死代码」，
2026-08-28 重新核对源码后**撤回**：那条判断说的是更早的一个版本（`if (loaded.capture?.bodyText
&& QUOTA_BLOCKED.test(...))`，而限额页上 `capture` 恒为 null，所以那个分支确实到不了）；
现在的代码在 `!loaded.capture` 时走 `diagnoseUnrendered`，**当场重读一次页面**，翻页路径上
也有同一条检查，两条都可达，`--self-test` 也真的驱动了它们。真正的缺陷是另一个：判据方向反了
——它原来在**整页**里搜这句话，而限额页会照常渲染完整列头，供应商改文案 / A/B / 帮助气泡
里出现同一句话都会两个方向都误判。现已改成绑**表体区**：`filledCells === 0` **且**这句提示
出现在表体区自己的文字里；表体区定位不到时报 `quota-suspected`，不冒充确诊。
即便如此也不要假设脚本会替你挡住限额。`semrush-overview.mjs`、`semrush-batch.mjs`、
`semrush-keyword.mjs` 等其余脚本完全没有这项检测。**在这条被自动化补上之前，读表前必须自己
在表体文字里找一遍「已达到每日报告限额」**，出现了就是节点问题，换节点重跑，不是这个域名
没数据——不要假设脚本会替你发现。

<cmd><![CDATA[
node scripts/tools-share-node.mjs list --tool semrush                    # 只读，不点「打开」，不耗配额
node scripts/tools-share-node.mjs probe --tool semrush --nodes 1,2,3     # 逐个真的启动，看哪个能用
]]></cmd>

`probe` 只回答"这个节点现在能不能进去"，**不回答"这个节点会不会被限额"**——面板卡片上的
「API 今日配额 N%」与单份报表的「每日报告限额」是不是同一个配额口径没有验证过,同一次
`probe --nodes 1,2` 实测两个节点读到的配额百分比完全相同，说明那读数很可能是账号维度、
不是节点维度的,不要拿它当预测。真正会不会被限额，只有实际跑报表看有没有弹出那句提示才知道。

**镜像补丁把 `document.referrer` 的 getter 换掉了（gmitm.env.js reverseUrl），
referrer 为空时读它直接抛 `Cannot read properties of undefined (reading
'charAt')`，整条 eval 报废。** 任何页内 eval 读 `document.referrer` 必须包
try/catch —— opencli 的 `pressure.mjs` 配额探针就依赖这条读取，2026-08-30 实测
中招。

**平台方定性（2026-08-30，用户与客服确认）：面板公告里的自动化禁令针对的是攻击性
脚本 / API 轰炸，正常的面板读取不在禁止之列。** 此前判决书里「需上报的风险」条目
就此降级为已解决；但节制节奏保留 —— 单会话串行、请求间 30s 级间隔，这不再是风控
避险，而是省配额的纪律。

**semrush-overview.mjs：整页抓取与完成判定（2026-09-13 重写）**

- **覆盖**：域名概览整页 23 个区块——AI 可见度卡片、SEO 8 宫格（含「流量比例」
  「付费关键词」）、按国家/地区、主要引用来源、SERP 排名分布、流量/关键词趋势图、
  自然搜索研究 6 块、广告研究 4 块、反向链接 6 块。区块靠**标题文字+位置**识别，
  不靠 class 名（每次发版都变的哈希）。
- **两个证人**：接口证人（`/dpa/rpc` 的 JSON-RPC 响应，会话级网络捕获+页内钩子；
  趋势图逐点日/月序列只在这里有）+ DOM 证人（穿透 shadow DOM 的文本 token 流，只
  证明区块渲染成了什么终态）。缺一不可：只看接口会把「rpc 全 200 但报表模块没
  挂载」误判成功；只看 DOM 拿不到趋势序列。
- **每区块终态**：`data` / `empty`（合法空态）/ `locked`（付费墙，同样要网络静默）/
  `absent`（滚到底、网络静默、≥2 次复读仍未出现、SEO 卡片已渲染、**排在它后面的区块确实
  渲染了**、全程没有 hidden 读数、接口无数据，证据写明）；非终态
  `loading` / `not-found` / `not-rendered`（接口有数但 DOM 没渲染，即空白页事故
  形态）/ `conflict`（DOM 空但接口有数，两证人打架不下结论）。
- **完成判定**（同一轮都过才行）：DOM 一路——每个区块到终态、报表区无占位元素
  （Skeleton/Spin/Loader/Placeholder、`aria-busy`、`role=progressbar`）、已滚到
  底；网络一路——CDP 捕获的 `/dpa/rpc` 累计发出数=资源计时完成数、drain 无在途、
  页内钩子在途为 0、最后一个 rpc 返回距今 ≥ quiet 窗口（默认 4s）。**超时后一律
  `incomplete`，不存在「看起来齐了」的超时输出**。
- **页面级口径（2026-09-13 起）**：不传 `--db` 默认**全球库**（`scope: "global"`），
  传 `--db xx` 才是该国。`judgeScope()` 要 **DOM + 接口两个证人**才给 confirmed：
  全球 = 落地 URL 无 db、国家 pill 暴露 `aria-checked` 且全部为 false、「全世界」按钮存在
  （它本身**没有**选中态属性，只能反证），**并且**接口趋势最新点的关键词数严格大于每一个
  单国家行；国家 xx = pill 选中或 URL db=xx，**并且**趋势关键词数等于 xx 行。明确反例判
  mismatch，证据不齐判 unverified；非 confirmed 记 `scope-&lt;verdict&gt;` 阻断。
- **区块级口径**：「自然搜索研究」「广告研究」两个分组标题旁有**独立的国家徽标**，跟随账号级
  「最近一次显式选择的国家」，与页头选择器脱钩（实测全球页面上它们显示过别的国家）。
  每个区块输出自己的 `scope`，顶层汇总 `sectionScopes`（分组 top / organic / ads / backlinks
  各自 expected / actual / verdict）。研究分组的期望口径 = `--organic-db xx`；没传且 `--db xx`
  ⇒ xx；**没传且请求全球 ⇒ unpinned**：不切换国家、不猜代表国家，如实标出页面显示的国家
  并记 `section-scope-unpinned` 阻断——切换会改写同账号共享状态，猜错比不给更坏。
  传 `--organic-db xx` 时先显式访问一次 `/analytics/organic/overview/?db=xx` 钉住账号状态，
  这次改写记进输出 `accountStateWrites`。徽标缺失 ⇒ unverified（**广告研究**可用接口补位：
  「主要付费搜索竞争对手」查询里本域名自身那一行的 organicPositions 唯一匹配某国行，见
  `rpcScopeWitness().adsMatches`；2026-09-14 实测更正——这条查询属于广告分组，旧版错给了自然分组，
  自然分组现在只认徽标）；运行中徽标变过 ⇒ mismatch；
  反链分节的过滤条应为「全世界」。任一分组非 confirmed ⇒ 记 `section-scope-*` 阻断。
- **接口响应体两个来源**：扩展每条命令先用 2 秒探针检查调试器，页面加载忙时探针超时就 detach +
  attach，重连前已收到响应头的请求再也取不到 body（实测 21 条里 16 条 status 200、body 为空）。
  所以报表导航后、新 document 一可执行就注入页内钩子（fetch/XHR 完成时 clone 响应文本），与 CDP
  捕获按 JSON-RPC id 合并对账：合起来的不同响应数少于资源计时完成数 ⇒ `rpc-bodies-missing(n/m)`
  阻断；同一响应两边内容不同 ⇒ `rpc-body-conflict`；钩子注入前就发出的请求计 `preHookRequests`，
  只能靠 CDP 补。网络闸门看「请求完成」，结构化数据看「拿到响应体」，两件事分开判。
- **趋势序列按口径挑**：同一次加载里有两套趋势——页面级一套（最新点与 SEO 卡片显示的关键词数、
  自然流量对得上）和研究分组一套（最新点等于分组国家的国家行）。流量/关键词趋势图、SEO 附加值、
  页面级口径证人用页面级那套；「按意图」用研究分组那套。序列身份是**复合键**（最新点关键词数 +
  自然流量），关键词数撞车时先用流量区分；仍分不开（例如卡片流量那一刻读不到）就**不猜**——相关区块
  不用接口数据，并记 `trend-series-ambiguous` 阻断，不会 complete。
- **交叉校验纳入阻断**：SEO 卡片 DOM 显示值与接口数据不一致记 `seo-crosscheck-mismatch`；「按意图」
  逐行对账（关键词数、流量都按页面缩写精度比较——数据量大的站点关键词数也显示成 K/M），不一致记 `intent-crosscheck-mismatch`，接口给了数据
  但 DOM 一行都读不出记 `intent-crosscheck-unverified`——证明不了接口数据就是页面上那个挂件画的那套，
  就不在 complete 输出里交出去。
- **给其它脚本复用的导出**：`trendContextFromText`（只吃 innerText 的页面级趋势匹配）、
  `armNetworkCapture` / `drainRpcWitness`（依赖注入：调用方传入 opencli 与 evalPage，lib 不直接开浏览器），
  另有 `crossCheckIntent`、`accountRpcBodies`、`rpcScopeWitness`、`judgeScope`。
- **定点等待**：固定步长滚动走完后，对仍未到终态的区块滚到它自己的标题 / 所属分组大标题 /
  前面最近的标题，停下等待，不行再 0.3 屏小步挪最多 6 次；仍见证不到就保持非终态。
  终态缓存只收直接观测到的终态，区块再次被观测为非终态时作废。
- **区块定位**：标题正则只许开头锚定或全等（旧的只锚结尾写法曾让「按意图」抢到关键词表的「意图」列头，
  关键词表自己的段落被截短）；同一分组内按页面顺序单调定位；标题在自己段落之外还命中别的 token 记
  `section-locate-conflict` 阻断；表格类区块「已渲染」至少要 3 个含数字的 token。清单外的挂件标题
  （如「文字广告样本」）只当段落边界。测试逐条检查 23 个标题正则不命中常见列头。
- **到底与滚动轨迹**：只有「到底判据成立且页高连续两次不变」退出滚动循环才记到过底，步数或时限耗尽
  记 `scroll-exhausted` 阻断；做判定的那次读数必须停在最终底部（定点等待把页面留在中段时先滚回底部）
  且可见，否则记 `last-read-not-at-bottom` / `last-read-hidden`。每次读数的 scrollY、视口高、页高、
  可见性、视口内区块标题写进 `readiness.scrollTrace`（保留首尾与变化点）；懒加载探针
  （IntersectionObserver 创建/回调/相交次数、scroll 与 wheel 监听和事件数）写进 `readiness.lazyLoadProbe`。
  每次滚动后补派发 scroll 事件（opencli 没有可信滚轮输入，`browser scroll` 也是页面 JS）。
- **输出**：`status` = complete/incomplete/unavailable（旧 `inconclusive` 已
  移除）。新增 `db`（null=全球）、`scope`、`scopeEvidence`、`paidKeywords`、
  `trafficShare`；旧 8 键含义不变，complete 时装进 `metrics`，否则装进
  `unconfirmedMetrics`（显式 `undefined`）。另有 `sections`、`completeness`
  （`blockers` 含 `scope-*`、标签页转 hidden 时的 `tab-hidden-during-run`——懒
  加载区块可能再没挂载）、`readiness`、`notCovered`、`quotaDisplay`。AS 恰好为
  0 且无等级徽标视为占位值（2026-08-23 事故的直接修复）。
- **虚拟屏幕模式（2026-09-14 实跑确认）**：不传 `--window` 时默认 `virtual-display`——持锁后先把
  本 session 的 opencli 独立窗口（`--window isolated`）移到名字匹配「虚拟 / Virtual」的非主屏上、
  `tab select` 选中并读回 `visibilityState` 再导航；实跑整页全部区块到终态、读数全程 visible、
  前台应用抽样全程不是 Chrome、`activations: 0`。输出顶层与 `readiness` 下都有 `automationWindow`。
  检测不到虚拟屏幕（或 `--automation-display off`）才回退为下面这套 `active` + 限次 `open -a`，
  stderr 提示「未检测到虚拟屏幕，回退为抢焦点（最多 N 次）」。运行期间不要把自己的标签页拖进
  自动化窗口。配置与回退细节见 references/authorized-data-sources.md 的「虚拟屏幕模式」。
- **驱动层事实（2026-09-14 更新窗口/激活策略；以下为无虚拟屏幕时的回退路径）**：默认 `--window active`（此前是
  `foreground`；`active` 同样能避免 hidden，但不像 `foreground` 那样把 Chrome 应用整个
  raise 到 OS 前台——显式传其它值原样透传，`--activate-chrome false` 时禁止解出
  `foreground`，会被降级成 `active`）；导航走 `location.href` 而非
  `opencli browser open`（后者让报表模块不挂载，接口却照常 200），并在导航后轮询新 document
  尽早注入钩子；CDP 只在页面静默时 drain。窗口**被别的应用遮挡**时标签页仍会读成 hidden
  （macOS 的窗口遮挡检测），`active` 救不回这种情况，opencli 的 CDP 透传白名单里也没有
  bringToFront / 焦点模拟，所以脚本侧仍用 `open -a "Google Chrome"` 抬前台兜底：报表导航前
  一次、每次 hidden 读数之后补一次，但**整次运行不超过 `--max-activations`（默认 3）次**
  （`--activate-chrome false` 整体关闭这条 OS 级抬前台；次数、时间戳、原因都记进
  `readiness.visibilityActions.{activations, activationLog, activationCapReached, hint}`）；
  用满上限后不再抬，仍然 hidden 就保留 tab-hidden 阻断，`hint` 字段会提示"运行期间请保持
  Chrome 窗口可见（未被遮挡/可放在副屏或虚拟屏幕）"。反向链接明细的行里没有数字，已渲染
  判据是至少 2 个 URL token。
  flags：`--domain --db --organic-db --subdomain --node --window --automation-display --activate-chrome --chrome-app
  --max-activations(3) --timeout(150s) --interval(2.5s) --quiet-ms(4000) --step-timeout(15s)
  --settle(6) --pin-settle(10) --out --evidence-dir`。
- **自然 / 付费分辨与结构化区块（2026-09-14 数据丰富站点实跑后）**：
  - 主判据是请求体里的 JSON-RPC 方法名（页内钩子按白名单只记 `method` 与少数口径参数）：自然 `organic.*`、
    付费 `adwords.*`；DOM 行只做交叉校验——方法名选中的那条首行不在页面、另一条的首行在，就判
    `ambiguous-organic-vs-paid` 保持非终态。付费关键词行多出广告字段（广告位、标题、描述、显示网址），
    按字段形状单独归类，即使没有方法名也不会混进自然关键词表。
  - 钩子也解析非字符串请求体（`fetch(Request)`、Blob、字节数组、URLSearchParams），只额外记类型名
    `reqBodyType`；证据快照 `rpcSummary` 列出每条响应的 kind / 方法名 / 白名单参数 / 行数 / 字段名，不含数值。
  - 广告研究 4 块、两个排名分布、关键主题改为接口结构化输出：主要付费关键词（含广告文案）、主要付费
    搜索竞争对手（排除本域名自身行，带总数）、竞争排名图谱（付费，含自身点，x=付费关键词数、y=付费流量）；
    排名分布取研究分组那套趋势最新点的 11 档直方图，**合计必须等于同一行的关键词总数**，否则
    `distribution-total-mismatch` 非终态；关键主题解锁后给主题名、关键词数、流量、搜索量、页面数。
  - SEO 卡片「自然流量」对应接口 `traffic`（自然 + SERP 精选），不是 `organicTraffic`——小站两者几乎相等，
    大站差近一成。输出 `organicTraffic` 取卡片口径，另给 `organicTrafficExclSerpFeatures`；页面级趋势序列也按这个字段匹配卡片。
- **明确不覆盖**（写进 `notCovered`）：顶部「增长审核/按国家地区比较」Tab、按国家
  表的谷歌 Tab 视图、各表「查看详情」完整分页（走 `semrush-report.mjs`）、图表粒度切换、
  排名分布 11 档与图上档位标签的对应（原样给出并标 `bucketLabelsVerified:false`）、SERP 排名分布圆环逐项数值（只有 DOM 百分比）。

判据细节见 `scripts/lib-semrush-overview.mjs` 与 `tests/semrush-overview-readiness.test.mjs`。

Everything else about cards, quota, and the traps is in
<ref file="references/authorized-data-sources.md"/>.
</panel-launch>
