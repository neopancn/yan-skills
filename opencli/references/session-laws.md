# 会话与租约的四条法律

SKILL.md 里只有法律本身，这里是支撑它们的实测数据、边界，以及「标签页被抢了」的诊断顺序。

多 agent 并行开工前读一遍。单 agent 单页面的活儿，读 SKILL.md 的那张表就够。

## 目录

- [法律 1 —— 一个会话一个标签页](#law-1)
- [法律 2 —— 会话内的多标签页 API 是坏的](#law-2)
- [法律 3 —— 绝不硬编码会话名](#law-3)
- [法律 4 —— 开工前先把 handle 全部拿到](#law-4)
- [后台模式不是无头模式](#background)
- [batch：一次调用跑多步](#batch)
- [adapter 的 `--site-session persistent`](#site-session)
- [「它到底开在哪个窗口」——直接问，别靠看](#which-window)
- [诊断「有东西抢了我的标签页」](#diagnosing)

---

<a id="law-1"></a>
## 法律 1 —— 一个会话一个标签页

`opencli browser <session>` 是一个**单页抽象**。一个会话名恰好拥有一个标签页。
不同名字之间永远不会互相偷、切换或污染，每个会话的 `tab list` 只看得到自己那一个。

2026-08-25 在 OpenCLI 1.8.7 本地源码复测：守护进程会串行保护同一
profile + surface + session 的写操作。第二个并发写在本机排队，每 2 秒检查一次，
前一个结束后自动执行；排队期间没有请求到达 Chrome 或目标网站，因此外层 Agent 不会
收到 `session_busy` 后自行重试。默认最多排 10 分钟，超时才终止并明确要求不要立即重试。
读可并行；混合 batch 只要含写操作，整批就按写处理。锁只覆盖**同时写**，不改变会话的
单页语义：顺序或交替使用同名 session 仍复用同一个标签页，后一次导航会覆盖前一次页面。

**边界：这不是账号限速器。** 站点账号级并发、请求频率和冻结策略不在 OpenCLI
session 锁内；数据源脚本仍需按账号加全局锁与自身的退避策略。

### 例外：配额站要**故意**共用一个会话名

上面那条边界有一个可以白嫖的角度。有些站（Semrush、Similarweb）**同时加载**
会触发上限——实测 2026-08-28，Semrush 大约 3 个标签页同时 load 就出问题，
一个个开、隔几秒则没事。受限的是**导航事件**，不是标签页存在。

既然同名会话的写本来就会排队，那把配额站的会话名**固定成站点名**
（`semrush-nav` / `similarweb-nav`），串行就白来了：十个 agent 拿到同一个名字，
daemon 排成一队，站点那边永远只看到一个标签页在一页页地翻。

法律 1 防的是「读到别人的页面」。共用名字之所以在这里仍然安全，是因为配额站上
一次访问被要求打包成**一个 batch**（`openAndExtract`），而混合 batch 含写就整批
按写处理——整包是原子的，中途没人插得进来。所以这不是违反法律 1，是用它的
锁语义换串行。规则表在 SKILL.md 的「配额站：法律 1 的唯一例外」。

反例（这就是它要防的事）：2026-08-28 一次扇出让 19 个 `tm-*` 会话同时压在
同一个 Semrush 报表上，因为扇出的单位是 agent，而资源是页面。

2026-08-19 在 opencli 1.8.6 上实测：

```bash
opencli browser isoA open https://example.com/
opencli browser isoB open https://example.org/
opencli browser isoA open https://example.net/
# isoA -> https://example.net/    isoB -> https://example.org/
```

`isoB` 完全没有被 `isoA` 的第二次导航影响，两边的 `tab list` 也互相看不见。

2026-08-21 在三个并发 agent 下复测——这才是真正要紧的场景。
三个 agent 各拿一个独立会话名，**跨 agent 抢占 0 次**（4 轮 × 3 个页面）。
三个 agent 共用名字 `work`，抢占次数分别是 3、12、2，其中一个**每一次读都读错**。

**所以 N 个页面需要 N 个会话名。** 这是本文件里最吃重的一条，
而且它和大多数人带着的直觉是反的。

```bash
# 正确：三个页面，三个名字
opencli browser recon-sw-notion  open "https://..."
opencli browser recon-sw-figma   open "https://..."
opencli browser recon-sem-rival  open "https://..."
```

### 法律 1 保护的是标签页身份，不是站点的服务端状态

**这是一个真实的边界，不写清楚会让人以为「名字分开了就安全了」。**

所有会话共用**同一个 Chrome profile、同一份 cookie、同一个登录身份**。
如果目标站把「当前选中的项目/工作区/客户」存在**服务端会话**里，
那么任意一个标签页切换选择，**其它标签页刷新后也会跟着变**——
会话名分得再开也拦不住，因为冲突根本不在标签页那一层。

判据：在站点里切换目标之后，**URL 变不变？**

| 观察 | 含义 | 能不能并行 |
|---|---|---|
| URL 里带着目标标识（`/project/abc/report`） | 目标由 URL 决定 | **能**，一页一会话即可 |
| URL 不变，靠界面里的下拉切换 | 目标很可能在服务端会话里 | **不能盲目并行**，先验证 |

验证方法：开两个会话切到不同目标，然后**回头刷新第一个**，看它还是不是原来那个。
是 → 安全；变了 → 只能串行，或者给每个目标单独一个浏览器 profile。

并行读取之前，**每次读都先自证身份**：`get url` 加上一处页面内的目标锚点
（域名、项目名），确认读到的确实是你要的那个。
不同客户的后台长得一模一样，**污染了看起来完全正常**——这正是它危险的地方。

---

<a id="law-2"></a>
## 法律 2 —— 会话内的多标签页 API 是坏的

不要用 `tab new`、`tab select`、`open --tab` 在一个会话名下面攥住好几个页面。
三个都会失败，而且每一个都是**静默**失败——命令报成功，下一次读回来的是错误的页面。

2026-08-21 在 opencli 1.8.6 上实测：

| 调用 | 文档里的意图 | 实际行为 |
|---|---|---|
| `tab new <url>` | 开一个标签页并返回 id | 确实开了也返回了 id，但会话之后**只跟踪它最新的那个标签页**，更早的 id 从 `tab list` 里消失 |
| `tab select <id>` | 让后续调用都作用在那个标签页上 | 返回 `{"selected": ...}` 成功，**对读取没有任何影响** |
| `open <url> --tab <id>` | 导航那个标签页 | 反而**新开一个标签页**，被指名的那个原封不动 |
| `get url` | 读当前页面 | **`get` 根本不接受 `--tab`**，它总是读全局活动标签页 |

`--tab` 被 `open`、`state`、`extract`、`find`、`click` 接受，被 `get` 和 `tab` 拒绝。
一次运行如果在一个会话里攥着好几个页面、又用 `get url` 确认自己在哪，
它没有任何办法是对的。

**不要过度矫正。** 在法律 1 之下一个会话只有一个页面，没有什么需要消歧，
**普通的 `get url` 是安全的**——它是最简单的确认读取。三个独立测试者都点名这一段
最容易被误读，其中一个差点为了遵守一条根本不适用的规则，
把 `--tab` id 一路穿过整个任务。

只有当你**确实**在一个会话里有好几个页面时才用 `state --tab <id>`，
而法律 1 说你不该走到那一步。

一次三 agent 运行的可观测损害：用户的 Chrome 从 11 个标签页涨到 30 个，全是孤儿，
CLI 一个都寻址不到。事后重建显示：`tab new` 创建的三个标签页从未被导航过，
`open --tab` 又凭空变出三个，会话最后只认得其中一个。

`state` 默认走 `--source ax`（无障碍树快照：紧凑的 `[N]role "name"` 格式，
比完整 DOM 省很多 token）。需要完整 DOM 树时显式传 `--source dom`。

---

<a id="law-3"></a>
## 法律 3 —— 绝不硬编码会话名

「另一个任务抢了我的标签页」通常不是 CLI 在轮询调度，
而是**两个任务挑了同一个会话名**。并发写现在会自动排队，
但顺序或交替复用同名会话仍不会报错，因为那本来就是同一个标签页。

这类碰撞最常见的来源就是文档本身。`opencli browser --help` 开篇第一个例子是
`opencli browser work open https://x.com`，于是每个照抄例子的 agent 都落在 `work` 上。
**预期到这一点**：一个读完这些法律、然后去翻 `--help` 找语法的 agent，
会亲眼看到工具示范它刚刚被警告过的那个反模式。相信法律。

### 名字需要两个区分部分，很容易只做了一半

后缀把你的任务和别的 agent 分开，它**不能**把你自己的几个页面分开。
按法律 1，三个页面的活儿需要三个名字，所以 `probe-$$` 复用三次
遵守了本条法律的字面，却破坏了法律 1。两处都要变：
`probe-p1-$$`、`-p2-$$`、`-p3-$$`。

### `$$` 在 Bash tool 里每次都不一样

| 场景 | 行为 | 正确做法 |
|---|---|---|
| **Node 脚本**（一个进程跑完全程） | 整个生命周期同一个 PID，安全 | `` `ahs-${process.pid}` `` |
| **Claude Code 的 Bash tool** | **每次调用都是新进程，PID 不同**——第一条命令 `open` 的会话名和第二条 `eval` 的对不上，`eval` 对着一个空白新标签页执行 | 用描述性字面常量，或 `S=$(uuidgen \| cut -c1-8)` 存进文件再读回 |

已验证事故（2026-08-23）：sub agent 用 `S="naver-bs-$$"` 连续调用 OpenCLI，
每条命令都创建了新会话（新空白标签页），上一条打开的页面被遗弃。
agent 看到的永远是空白页，以为页面没加载好而不断重试，最终泄漏 9 个会话。

### JS 里用 `defaultSession()`，不要手搓后缀

```js
import { defaultSession, validateSession } from "<opencli-skill-dir>/scripts/opencli-core.mjs";
const session = flags.session ? validateSession(flags.session) : defaultSession("recon-work");
```

后缀解析顺序：`OPENCLI_SESSION_SUFFIX` → `CLAUDE_CODE_SESSION_ID` →
`CLAUDE_CODE_HOST_SESSION_ID` → pid。

**绝不要直接用 HOST id**：它是每个桌面应用宿主一个，被宿主内所有对话共享，
等于把同一个标签页交给并行任务。`CLAUDE_CODE_SESSION_ID` 是每个对话一个，
而对话才是真正并发运行的单位。实测环境里两者同时存在：

```
CLAUDE_CODE_SESSION_ID=8bbc2d3d-...        每对话
CLAUDE_CODE_HOST_SESSION_ID=local_55a8...  整个应用共享
```

**Sub agent 继承父进程环境**，所以一个对话里派出的多个 agent 会解析到同一个默认值。
把浏览器活儿扇出给并行 agent 时，**必须**给每个 agent 一个显式 `--session`
或不同的 `OPENCLI_SESSION_SUFFIX`。

### 名字要描述工作

`recon-pricing-<后缀>` 胜过 `s1`。会话名是唯一存在的标识符，
一个唯一但无意义的名字仍然回答不了「这是谁的标签页」。

**每个会话一个 Chrome 标签页组，组名就是会话名**（我们的 fork，扩展 1.0.33 起）：
`opencli browser recon-pricing …` 的标签页在 `OpenCLI: recon-pricing` 组里。adapter 会话也分组，
运行时起的 `site:<x>` / `site:<x>:<uuid>` 显示为 `OpenCLI: <x>`（`opencli reddit …` → `OpenCLI: reddit`）。
同一会话 `tab new` 出来的标签页进同一个组，别的会话永远不会被并进来。

**用法：一个任务 = 一个会话 = 一个组。** 人看标签栏就知道哪一组是哪件事的，
收工 `close` 整组一起消失。`opencli browser sessions` 每行还报 `groupId` / `groupTitle` /
`windowFallbackReason`（`-f json` 同名字段），不用去浏览器里数。
跑 Chrome Web Store 的官方扩展则没有分组——这个特性需要我们的扩展。

### 收工要还租约

```bash
opencli browser <session> close
```

留着不关的会话，在用户的 Chrome 里看起来和别人正在做的活儿一模一样。

---

<a id="law-4"></a>
## 法律 4 —— 开工前先把 handle 全部拿到

每一个测试过的 driver 都有同一个竞态窗口：**创建页面到握住稳定 handle 之间那一段**。
两次独立运行都恰好在这个缝里丢了页面——其中一个 agent 的两个页面都在它创建完成之前
就被覆盖了，因为一个没有既有 handle 的裸 `open` 会解析到那一瞬间共享的「当前」概念上。

所以**一次性把要用的会话全部开好、把每个 handle 都捕获下来，然后才进工作循环**。
把创建和使用交错在一起，正是把理论竞态变成可复现竞态的做法。

---

<a id="background"></a>
## 后台模式不是无头模式

默认给每个会话加后台模式。标志位置在**会话名和子命令之间**：

```bash
opencli browser <session> <command>
```

放在会话名**前面**会报 `unknown command: <你的会话名>`，读起来像装坏了，其实是语法错。
放在子命令**后面**也能工作——2026-08-21 复测过，CLI 自己的 `--help`
第二个例子就是这个尾置形式。

> 本文件早先的版本声称两个位置都会失败。一位测试者用一条命令证伪了它，
> 然后说周围那些法律因此变得更难相信了——这是正确的反应，
> 也是这条更正被写出来而不是悄悄改掉的原因。
> 统一用中置形式，但不要把尾置形式当成别人脚本里的 bug。

后台模式跑的是用户真实的、已登录的 Chrome。会话内实测探针：

| 探针 | 值 |
|---|---|
| `navigator.webdriver` | `false` |
| UA 含 `Headless` | 否 |
| `navigator.plugins.length` | 5 |
| `document.visibilityState` | `hidden`，`document.hasFocus()` 为 `false`（2026-09-03 实测，background 模式在用户窗口里开的非活动标签页）。**页面按后台标签页被节流**：依赖 rAF / `visibilitychange` 的页面（PageSpeed 网页版、部分图表）在这种标签页里跑不完，见 rankup `pagespeed.mjs` 头注 |
| `window.outerWidth × outerHeight` | 1364 × 806 |

所以「后台模式会触发站点的反爬」不是真问题——每一项无头特征都读负。
**没有任何理由为了「看起来更像人」去用前台。**

### 前台模式确实会打断用户——旧结论已被推翻（2026-08-23 修订）

**这里原来写的是「两种模式都不抢焦点」。那个结论是错的，因为量错了东西。**

2026-08-21 那次测量在每次导航前后检查的是**最前端应用**，宿主应用确实一直保持在最前，
于是判定两种模式无差异。**但用户被打断的地方不是应用切换，是标签页切换。**

2026-08-23 补测了活动标签页索引，结论完全相反：

| 模式 | 最前端应用 | 用户的活动标签页 | 标签数 |
|---|---|---|---|
| `--window background` | 不变（宿主应用在最前） | **不变** | 开时 +1，`close` 后回到基线 |
| `--window foreground` | 不变（宿主应用仍在最前） | **被切走**（实测从第 1 个跳到第 3 个） | +1 |

也就是说，前台模式的 raise + select 里，**select 那一半是真的会执行的**——
用户正在看的那一页被换掉了，而 macOS 层面的应用焦点没动，所以只查前台应用的测量看不见它。

**规矩：dedicated 是默认值。** CLI、扩展与 JS 封装默认使用不抢焦点的专用窗口；有副屏时由扩展放到副屏。`--window background` 仅在调用方显式选择时复用用户窗口。

**`--window foreground` 只有一个正当用途：把一件必须由用户亲手做完的事交给他**
（验证码、短信验证码、他明确说要看着）。那种时候你本来就是要他的注意力。
除此之外一律不用——包括调 adapter 时「方便看最终页面」，那用 `--keep-tab true`
把标签页留着，用户想看自己切过去；要机器看就用 `screenshot` / `state`，
两者在后台模式下都正常工作。

**自动化默认用 `--window dedicated` 离开用户窗口**；`isolated` 仍可显式指定，
不要为此去用前台。

`background` 对 `opencli browser` 与 adapter 命令（`opencli <site> …`）**都**复用用户当前的
normal 窗口（扩展 1.0.33 起；此前 adapter 每次自己开一个窗口）。只有借不到 normal 窗口才新建，
`sessions` 那行会带 `[new window: <reason>]`：`no-normal-window`（一个普通窗口都没开）、
`all-incognito`（只有无痕窗口，登录态不是用户的，不借）、`all-owned`（只剩我们自己建的窗口）、
`query-failed`（问 Chrome 有哪些窗口这步失败）。browser 与 adapter 都借不到时只建一个替身窗口共用。

`isolated` 隔离的是**用户 vs 自动化**，不是会话之间：isolated 会话落在自动化自己的独立窗口里，
多个 isolated 会话共用那一个独立窗口，各自仍是自己的标签页组。会话之间的隔离靠会话名，就是上面四条法律。
（2026-08-24 复测于扩展 1.0.30：两个 isolated 会话并存、都可读、
`windowId` 同为那个独立窗口，与用户窗口不同。）

后台模式本身是干净的：实测 `open` / `eval` / `screenshot` / `click` / `type` 全程，
页面侧 `document.hasFocus()` 恒为 `false`、`visibilityState` 恒为 `hidden`，
用户的活动标签页索引不变。

**曾经的一个坑（2026-08-23 修好）**：`--window isolated` 当时**不新开窗口**，
行为与 `background` 一模一样，于是这里一度写着「没办法把 agent 的标签页挪出用户窗口」。

它值得留在这里，因为坏法很典型——**四层各自静默地否决同一个功能**：

1. 运行时白名单只认 `foreground|background` 两个值，`isolated` 一路通过 CLI 解析、
   传到扩展、然后被那个 `if` 丢掉。标志「生效」了，行为是默认值，**零报错**。
2. 「这个窗口是不是我自己的」靠猜（全是非 http 页面就算我的），
   于是用户随手开的一个只有 `chrome://newtab` 的空窗口被认成了容器。
3. 窗口终于建对了，**分组收敛**又去认领用户窗口里那个规范分组，把标签页搬了回去。
4. 挑「用户在哪个窗口」用的是 `getAll().find(w => w.focused)`，
   而 **Chrome 不在最前面时所有窗口的 `focused` 都是 false**——agent 从终端驱动它时
   永远如此，于是回退到「列表里最后一个」，随机挑。

每一层都不报错，所以每修一层都以为好了。**判据：一个标志「不生效但也不报错」时，
不要只查它最表层的实现，沿着整条链路每一层都问一遍「这里会不会把它悄悄丢掉」。**

**同一个功能后来又坏过第二次，坏法同构**（扩展 1.0.27，2026-08-24 修好）：
第一个 isolated 会话正常拿到独立窗口，**开第二个时，第一个整条会话从 `sessions` 蒸发**，
再访问 `session_not_found`，而创建第二个的那一方毫无报错。跨 agent 一样会踩。
还有一处：adapter 命令走的是 CLI 里**另一份白名单**，它只列了两个值，
于是 `opencli <site> <cmd> --window isolated` 报「must be one of: foreground, background」，
而紧挨着的 help 文案却在宣传 isolated——同一个标志、两条代码路径、两套答案。

**所以这个自查每次都值得做**：`--window isolated` 起的会话，
它在 `opencli browser sessions` 里的 `windowId` 应该与默认模式会话的不同，
默认模式那行**不该有** `[new window: …]`；并发场景下再确认一次**先开的那个还在 `sessions` 里**。

如果有人报告屏幕「一直在跳」，先查有没有人用了前台；排除之后再怀疑
几个任务在写同一个共享页面——那看起来像抖动，实际是法律 1 被违反了。

---

<a id="batch"></a>
## batch：一次调用跑多步

`opencli browser <session> batch` 在一次 CLI 调用里执行多个浏览器操作，
复用同一条 Page 连接，省掉每条命令各付一次的连接 → 解析 → 拆除开销。

```bash
opencli browser <session> batch --commands '[
  {"cmd": "open",  "args": ["https://example.com"]},
  {"cmd": "wait",  "args": ["selector", ".loaded"]},
  {"cmd": "state", "args": []}
]'
```

支持 `open`、`state`、`click`、`type`、`fill`、`eval`、`wait`、`extract`、
`screenshot`、`scroll`、`find`、`keys`、`hover`、`select`、`back`。

输出是 `{cmd, index, ok, result?, error?}` 数组。默认遇错继续，
`--stop-on-error` 改为首次失败即停。输入可以走 `--commands <json>` 或 stdin 管道。

**什么时候用 batch，什么时候顺序调用：**

- **固定序列**（open → wait → eval）：一律 batch。`opencli-core.mjs` 的
  `openAndEval()` 封装了最常见的那一种。
- **条件逻辑**（每一步决定下一步）：顺序调用才对。比如面板启动需要先读状态，
  再决定是重试、切节点还是继续。
- **持续交互**（调用方攥着会话，随时间发命令）：顺序调用。

batch 跑在 CLI/守护进程层，**不需要**重新构建的扩展，官方商店版扩展也能用。

---

<a id="site-session"></a>
## adapter 的 `--site-session persistent`

adapter 命令（`opencli <site> <cmd>`）的会话名不是你起的，是运行时起的：

| 模式 | 会话名 | 每次调用做什么 |
|---|---|---|
| `ephemeral`（默认） | `site:<x>:<uuid>`，每次一个新的 | 新开一个标签页，按 COOKIE 策略**先导航到站点根**再跑命令，结束后关掉（`--keep-tab true` 则留到 30s idle） |
| `persistent` | `site:<x>`，固定 | 复用同一个标签页；**已在该域内就跳过站点根的预导航**（命令自己指定的路径仍会去），直接跑 |

对同一站点连着调十次默认模式，用户看到的是标签栏里一个接一个冒出来又消失、
每个都先刷一遍首页的标签页——像「一直在刷新首页」。**批量调用同一站点一律加
`--site-session persistent`**：一个标签页、一个 `OpenCLI: <x>` 组、不重复导航。

持久标签页**按设计保留**，不随命令结束关闭。`opencli browser site:<x> close` 关不掉它——
那条关的是 browser surface 下同名的租约，adapter surface 的 `site:<x>` 是另一把钥匙
（租约键 = surface + 会话名）。它留到用户自己关标签页，或主线收工时的 `cleanup`。

---

<a id="which-window"></a>
## 「它到底开在哪个窗口」——直接问，别靠看

```bash
opencli browser sessions
#  recon-pricing   browser  owned  win379220956  https://example.com/
#  bulk-harvest    browser  owned  win379221782  https://panel.example.com/
```

**`windowId` 是所有标签页归属问题的最终落点**：两个会话共用一个 windowId
就是共用一个窗口，这通常就是全部故事。

**不要用操作系统那一侧的工具（AppleScript、窗口截图）当尺子。** 2026-08-23 实测：
一台机器上同时跑着两个 Chrome 进程（其中一个是别的脚本起的 headless），
`tell application "Google Chrome"` 数出来 1 个窗口 1 个标签页，
而同一时刻扩展握着 3 个活标签页分布在 2 个窗口里。**两边看的根本不是同一个 Chrome。**
扩展的视角才是自动化真正作用的那个，所以问扩展。

想知道用户此刻在哪个窗口：`opencli browser <临时名> bind` 绑一下他的当前标签页，
读它的 windowId，再 `unbind`。默认模式新开的会话应该落在同一个 windowId 上。

<a id="diagnosing"></a>
## 诊断「有东西抢了我的标签页」

按这个顺序往下走，它是按「哪一条最常是真凶」排的。

1. **两个任务共用了一个会话名。** 用 `opencli browser <session> tab list` 确认——
   它应该只显示你自己开的标签页。修法是给每个任务一个不同的、描述性的名字。
2. **一个会话被要求攥住好几个页面。** 在代码路径里找 `tab new`、`tab select`、
   `open --tab`。按法律 1 修：一页一会话。
3. **一次无法指名目标的读取。** `get url` 没有 `--tab`。换成 `state --tab <id>`，
   或者靠法律 1 让会话只有一个页面。
4. **握住 handle 之前就开工了。** 见法律 4。
5. **到这一步才该怀疑站点或 CLI。**

`opencli browser sessions` 列出当前全部活跃租约。**排查时先跑它**——
它会直接告诉你有没有别人的名字在里面。

`opencli browser cleanup` 释放**全部**租约并关掉它们的标签页。
**它是主线专用**：sub agent 跑它会把兄弟 agent 正在用的标签页一起关掉，
而那些 agent 只会看到自己的页面莫名其妙不见了——一个比会话撞名更难查的故障。
并行扇出时，每个 agent 只 `close` 自己的会话，`cleanup` 留给父级在全部收工之后跑。

**如果 `eval` 返回的是一个你没有导航过去的页面，几乎总是成因 1 或 2。**
导航报成功、紧接着读到别人的 document，就是这个签名。
