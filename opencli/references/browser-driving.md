# 现场驱动浏览器

要在页面上真的做事——点、填、等、读、传文件——时读这一篇。
只是把数据取回来，读 [`data-extraction.md`](data-extraction.md)。
会话名和标签页归属的问题，读 [`session-laws.md`](session-laws.md)。

**这条 CLI 的第一读者是 agent，不是人。** 动作命令通常返回结构化信封；eval/open/screenshot 等输出各异，
明确告诉你匹配到了什么、有多确信、没匹配上该怎么办。**靠信封判断，不要猜。**

## 目录

- [目标契约](#target)
- [绑定用户已经打开的标签页](#bind)
- [命令表](#commands)
- [compound 表单控件](#compound)
- [成本表](#cost)
- [配方](#recipes)
- [跨源 iframe 与扩展注入面板](#oopif)
- [坑](#pitfalls)
- [排障速查](#troubleshooting)

---

<a id="target"></a>
## 目标契约

```
<target> ::= <数字 ref> | <CSS 选择器>
```

- **数字 ref** —— `state` / `find` 给的 `[N]`。便宜，能扛住轻微 DOM 漂移，
  因为 CLI 给每个打过标的元素做了指纹。
- **CSS 选择器** —— `querySelectorAll` 接受的一切。写操作时必须唯一，
  否则配 `--nth <n>`。

**拿到 ref 之后优先用 ref。** 手写的 CSS 选择器会在站点第一次重渲染时失效。

### 成功信封

```json
{ "clicked": true, "target": "3", "matches_n": 1, "match_level": "exact" }
```

| `match_level` | 含义 | 你该怎么办 |
|---|---|---|
| `exact` | 指纹在标签 + 强 ID 上完全一致，最多一处软漂移 | 继续 |
| `stable` | 标签 + 强 ID 仍一致，软信号（aria-label、role、文本）漂了 | 继续；但如果**点/填了什么**要紧，用 `get value` 或 `state` 复核 |
| `reidentified` | 原 ref 已经不在了；CLI 按指纹找到唯一存活元素并重新打标 | **在往下链更多写操作之前，先确认打中的是对的元素** |

### 结构化错误码

**按 `code` 分支，不要匹配人类可读的消息。**

| code | 含义 |
|---|---|
| `not_found` | 数字 ref 已不在 DOM 里。重新 `state` |
| `stale_ref` | ref 还在，但那个位置的元素换了身份。重新 `state` |
| `invalid_selector` | CSS 被 `querySelectorAll` 拒绝。改选择器 |
| `selector_not_found` | CSS 匹配 0 个。用 `find` 放宽再试 |
| `selector_ambiguous` | 匹配 >1 且没给 `--nth`。加 `--nth` 或收窄 |
| `selector_nth_out_of_range` | `--nth` 超出匹配数 |
| `option_not_found` | `select` 找不到对应 label/value 的选项。**错误信封里带 `available: string[]`**，是真实选项列表 |
| `not_a_select` | 对非 `<select>` 元素调了 `select` |

目标类错误常常还带 `error.candidates: string[]`（建议的选择器）。

---

<a id="bind"></a>
## 绑定用户已经打开的标签页

```bash
opencli browser gmail bind      # 把当前 Chrome 标签页绑到这个会话
opencli browser gmail state
opencli browser gmail unbind    # 解绑，不关标签页
```

绑定**从不拥有**用户窗口，也**从不关闭**用户标签页。标签页被关掉或变成不可调试时
它会 fail closed。切到另一个真实标签页后要重新 `bind`。

- 绑定会话**允许导航**——绑定本身就代表 agent 对那个标签页的显式所有权。
- 绑定会话**禁止标签页变更**（`tab new` / `tab select` / `tab close`）。
  想让 OpenCLI 管标签页生命周期，用自有会话。
- 绑定会话**没有空闲关闭计时器**，一直有效直到 `unbind`、标签页关闭、
  窗口关闭或守护进程重启。

**什么时候该 bind**：用户已经手动登录好、手动定位好的页面（SSO 流程、
需要人先选对账号或工作区的后台）。这比让 agent 从零走一遍登录流程可靠得多。

---

<a id="commands"></a>
## 命令表

### 观察

| 命令 | 用途 |
|---|---|
| `state` | 快照：带 `[N]` ref 的文本树、滚动提示、隐藏可交互元素提示，以及 date/select/file 的 `compounds (N):` 边车 |
| `state --source ax` | 无障碍树快照。自定义控件、portal、iframe 内容在普通 `state` 里难以辨认时用。AX ref 能按 role/name/nth 救回 React 重渲染导致的 stale，也能路由同源 iframe |
| `state --compare-sources` | 只出指标的 DOM vs AX 对比（数量和体积，不含页面文本），用来判断某个站该不该默认走 AX |
| `find --css <sel> [--limit N]` | 跑一次 CSS 查询，每个匹配返回 `{nth, ref, tag, role, text, attrs, visible, compound?}`。会给上次快照没打标的匹配分配 ref。已知选择器时比 `state` 便宜 |
| `find --role button --name Save` | 语义定位查询。也支持 `--label` / `--text` / `--testid`。控件有可访问标签时优先于裸 CSS |
| `frames` | 列出跨源 iframe 目标，索引传给 `eval --frame`。**需要扩展 ≥ 1.1.0**，低于它一律返回 `[]` 且不报错 |
| `frames --debug` | 同上，外加 `debug` 块（`treeChildCount` / `autoAttachError` / `getTargetsError` / `attachedEventCount` / `domFrameUrls`），用来判断卡在哪一层。**需要 CLI ≥ 1.9.0** |
| `screenshot [path]` | 视口 PNG。不给路径就输出 base64 |
| `screenshot --annotate [path]` | 视觉 ref 地图：刷新 DOM ref 并把可见的 `[N]` 叠在图上。图标按钮、图表、纯视觉布局时用 |

### 读取（只读）

| 命令 | 返回 |
|---|---|
| `get title` / `get url` | 纯文本 |
| `get text\|value\|attributes <target> [--nth N]` | `{value, matches_n, match_level}` |
| `get text --role option --name Travel` | 语义定位读取，不需要先 `state` |
| `get html [--selector <css>] [--as html\|json] [--depth N] [--children-max N] [--text-max N]` | 原始 HTML，或结构化树。JSON 节点是 `{tag, attrs, text, children[], compound?}`，截断情况报在 `truncated: {...}` |

### 交互

| 命令 | 说明 |
|---|---|
| `click <target> [--nth N]` | 返回 `{clicked, target, matches_n, match_level}` |
| `click --role button --name Submit` | 语义点击。**写操作要求唯一匹配**；定位歧义时返回候选而不是点第一个 |
| `hover` / `focus` / `dblclick` | 悬停菜单、focus/blur 副作用、双击 |
| `check` / `uncheck` | 确保勾选框/单选/aria-checked 处于某状态，返回 `{checked, changed, ...}`。**状态要紧时优先于盲点 `click`**。单选按钮不能直接 uncheck，去选同组的另一个 |
| `upload [target] <file...>` | 经 CDP 给 `input[type=file]` 挂本地文件，返回 `{uploaded, files, file_names, multiple?, accept?}` |
| `drag [source] [target]` | 基于鼠标事件的拖拽。原生 HTML5 `dataTransfer` 落点可能需要站点专属兜底 |
| `type [target] <text>` | 先点再打。返回里 **`autocomplete: true` 表示打完弹出了联想框，值还没提交**——通常要 `keys Enter` 或点一下建议项 |
| `fill [target] <text>` | 对 input / textarea / contenteditable 做精确替换并校验，返回 `{filled, verified, text, actual}`。要「设进去并确认」而不是模拟键盘时用这个 |
| `select [target] <option>` | 先按 label 再按 value 匹配**原生 `<select>`**。自定义下拉不要用它 |
| `keys <key>` | `Enter`、`Escape`、`Tab`、`Control+a`……作用在焦点元素上 |
| `scroll <direction> [--amount px]` | `up` / `down`，默认 500 |

### 等待

```bash
wait selector "<css>" [--timeout ms]
wait text "<substring>" [--timeout ms]
wait xhr "<url 片段>" [--timeout ms]
wait download [pattern] [--timeout ms]
wait time <seconds>
```

默认超时 10000 ms。SPA 路由、登录跳转、懒加载列表在 `state`/`get` 之前都需要 `wait`。

> `wait time` 已修复。batch 中用 `{ cmd: 'wait', args: { seconds: 6 } }` 按秒等待；
> 本仓库的 `sleepStep(seconds)` 生成该步骤，回归测试在 `backlink/tests/opencli-wait.test.mjs`。
> 能用 selector、text 或 xhr 判断页面就绪时，仍优先等待对应条件。

`wait download` 需要扩展 1.0.8+。尽量传窄一点的文件名或 URL 片段（如 `receipt.pdf`）；
空 pattern 会等超时窗口内的下一次下载。成功返回
`{downloaded, filename, url, state, elapsedMs}`。

---

<a id="compound"></a>
## compound 表单控件

每个 date/time、select、file 输入都带一个 `compound` 字段。**用它，不要正则猜属性。**

**日期族**：`{control: "date"|"time"|"datetime-local"|"month"|"week", format: "YYYY-MM-DD",
current, min, max}`。`format` 是具体模板串——就按这个格式打进去。

**select**：`{control: "select", multiple, current, options: [{label, value, selected}], options_total}`。
`options[]` 最多 50 条，但 **`current` 永远是对的**（它扫全部选项算出来，
不是从截断列表读的）。如果 `options_total` 大于列表长度、而你要的选项不在里面，
直接 `select <target> "<label>"`——CLI 匹配的是活 DOM，不是那个截断列表。

**file**：`{control: "file", multiple, current: [...], accept}`。
不要凭空编文件路径；告诉用户要传什么时尊重 `accept`。

compound 出现在三个地方：`find --css` 的每条匹配上、`get html --as json` 的节点上、
`state` 快照的 `compounds (N):` 边车里（按数字 ref 索引）。

---

<a id="cost"></a>
## 成本表

每次调用都要想 payload 大小。预算是有原因的。

| 命令 | 大致成本 | 什么时候用 |
|---|---|---|
| `state` | 中（有内部预算上限） | 每个页面的第一次调用、每次导航之后、需要 ref 时 |
| `find --css` | 小 | 已经知道选择器 |
| `get title` / `get url` | 极小 | 步骤之间的 sanity check |
| `get text/value/attributes` | 极小 | 验证某一个字段 |
| `get html`（原始） | 可能巨大 | 无界页面上避免。一定要配 `--selector` |
| `get html --as json --depth 3 --children-max 20` | 中 | 需要推理结构而不是取某个字段 |
| `screenshot` | 大 | 只在页面确实是视觉性的时候（验证码、图表） |
| `extract` | 每块中等 | 长文阅读，按 `next_start_char` 循环 |
| `network` | 小 | 第一眼看接口 |
| `network --detail <key>` | 视情况 | 取一条 body |
| `network --raw` | 巨大 | 只在 `--filter` 已经收窄之后 |
| `eval "JSON.stringify(...)"` | 可控 | 上面都不合适时的定点提取 |

**经验法则：每次页面切换一次 `state`，每个后续查询一次 `find`，每个动作一次
`get`/`click`/`type`。** 如果你的计划在一个页面上要 >10 次调用，
你大概是在爬而不是在交互——考虑 `extract` 或 `network`。

---

<a id="recipes"></a>
## 配方

### 填一个登录表单

```bash
S="login-acme"
opencli browser "$S" open "https://example.com/login"
opencli browser "$S" state                          # 找到 email / password / submit 的 [N]
opencli browser "$S" type 4 "me@example.com"
opencli browser "$S" type 5 "hunter2"
opencli browser "$S" get value 4                    # 验证：联想框会吃字符
opencli browser "$S" click 6
opencli browser "$S" wait selector "[data-testid=account-menu]" --timeout 15000
opencli browser "$S" state                          # 登录后页面的新鲜 ref
```

> 凭据本身不该由 agent 代填。这个配方用于用户自己提供、或已经保存在浏览器里的场景；
> 需要输入密码时把页面开好交给用户点，见 SKILL.md 的「人机验证」。

### 自定义 React 下拉（Radix / shadcn / MUI）

```bash
opencli browser "$S" state                  # 找到触发器 ref
opencli browser "$S" state --source ax      # 触发器/选项不清楚时看 combobox/listbox/option 名字
opencli browser "$S" click 7                # 点触发器
opencli browser "$S" state --source ax      # portal/listbox 打开后重新取 ref
opencli browser "$S" click 12               # 点选项
opencli browser "$S" get text 7             # 验证可见的已选标签
```

**不要对这类控件用 `select`**——它只服务原生 `<select>`。
自定义下拉一律 `state → 点触发器 → state → 点选项 → 验证`。

### 跨源 iframe

见下面专门的 [跨源 iframe 与扩展注入面板](#oopif) 一节。

`state --source ax` 仍然可能拿不到跨源 iframe 内容，或者无法把动作路由进去；
那种情况一律走 `frames` + `eval --frame`。

---

<a id="oopif"></a>
## 跨源 iframe 与扩展注入面板

**2026-09-11 起跨源 iframe 是真能用的**（扩展 1.1.0 / CLI 1.9.0，见
[`our-fork.md`](our-fork.md)）。在那之前 `frames` 对任何跨源 iframe 都返回 `[]`，
`eval --frame N` 永远 out of range——**静默的，没有报错**。
所以遇到 `frames` 为空，第一件事是查扩展版本，不是怀疑页面。

**需要扩展 ≥ 1.1.1；1.1.0 在面板反复开合后 `eval` 会静默落回主页面**（见
[`our-fork.md`](our-fork.md) 的「已知回归与修复」一节）。

```bash
opencli browser "$S" frames
# -> [{"index": 0, "url": "https://aitdk.com/", ...}]
opencli browser "$S" eval '(() => document.querySelectorAll("[role=tab]").length)()' --frame 0
opencli browser "$S" frames --debug     # 空了就看这个，定位卡在哪一层
```

### 浏览器扩展的侧边面板就是一个普通跨源 iframe

这条能省掉一整套错误做法。**别人家的浏览器扩展注入的侧边面板，
通常是 content script 在 shadow root 里放的一个 `<iframe src="https://<厂商域>/">`**
（AITDK SEO 扩展是 `plasmo-csui#aitdk-csui` 的 shadowRoot 内、带 `credentialless`）。

它是一个普通 https 页面。于是：

- `frames` 能列出它，`eval --frame N` 能直接读它的 DOM；
- **不需要读剪贴板**，也**不需要按坐标点击截图里的按钮**。

坐标点击和剪贴板是上一代做法，在这里是纯粹的绕路。

### 扩展热键：`browser keys` 触发不了，要派发合成事件

扩展热键（AITDK 是 `Alt+D`，底层是 hotkeys-js 监听 `document` 的 keydown）
**用 `browser keys "Alt+d"` 触发不了**——那条走 CDP `Input.dispatchKeyEvent`，
到不了扩展那一层。要用 `eval` 自己派发：

```bash
opencli browser "$S" eval '(()=>{for(const t of ["keydown","keyup"]){document.dispatchEvent(new KeyboardEvent(t,{key:"d",code:"KeyD",keyCode:68,which:68,altKey:true,bubbles:true}))}return true})()'
```

**面板是 toggle，派发前先查状态**，否则连发两次等于开了又关。
判据用 iframe 的 `getBoundingClientRect().width > 0`。

### iframe 里的 React 按钮：`.click()` 无效

Radix Tabs 这类组件监听的是 pointer 事件，`element.click()` 什么都不会发生。
要派发完整序列：

```js
for (const t of ["pointerdown","mousedown","pointerup","mouseup","click"]) {
  el.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true, button:0}));
}
```

### 恢复面板绝不 reload 页面

**reload 之后新 iframe 是在 load 阶段附着的，实测拿不到 `eval --frame` 的 target，
opencli 会静默退回主页面执行。** 症状很阴——你在"iframe 里"找按钮，找到的是宿主页
的同名按钮，脚本一路绿着跑完，结果全错。

面板没了只用 toggle 关再开，不要 reload。

### 这一节的其他前提

- **`eval` 体一律包 IIFE**（见[坑](#pitfalls)）。eval 上下文跨调用持续，
  顶层 `const` 会 `already been declared`，**在 iframe 上下文里同样成立**。
- **脚本里的固定间隔用 `sleepStep()`**——它生成 batch 的原生 wait 步骤，见[等待](#commands)。
- **实测参考实现**：`~/.claude/skills/rankup/scripts/aitdk-opencli.sh`，
  跑完 15 个 section 用 2 分 08 秒。要驱动别家扩展面板时照着它改，比从零写快得多。

---

<a id="pitfalls"></a>
## 坑

- **不要用 `eval "document.forms[0].submit()"` 提交表单**——现代站点用 JS handler 拦截，
  这个调用会被静默丢弃。要么按 ref `click` 提交按钮，要么（如果知道 GET URL）直接 `open`。
- **`eval` 体一律包 IIFE。** 本环境 eval 上下文跨调用持续，重复声明会抛错，
  **而且那次调用根本没执行**。
- **不要跨页面切换复用 ref。** 先 `wait` 新状态再重新 `state`。
  旧 ref 要么 404，要么更糟——`reidentified` 到新页面上一个形状相似的元素。
- **`match_level: reidentified` 是警告不是错误。** 动作确实执行了，
  但如果后面还要链五个依赖它的写操作，先用 `get text` / `get value` 确认。
- **预算感知的命令会静默截断。** `get html --as json` 默认预算会返回 `truncated: {...}`。
  下游需要完整子树就调大 `--depth` / `--children-max`，或者收窄选择器。
- **`type` 返回 `autocomplete: true` 不是错误**，是联想框开着、值还没提交。
- **截图是给人看的，不是给 agent 看的。** 除非页面确实是视觉性的，
  用 `state` + `find`——截图烧 token 而且很少给出 agent 能据以行动的信号。
- **写操作之后如果要紧，一定验证。** `type` 之后 `get value`，`select` 之后 `get value`。
  联想控件、React 受控输入、掩码字段都会静默吃字符，CLI 替你检测不了。

---

<a id="troubleshooting"></a>
## 排障速查

| 症状 | 修法 |
|---|---|
| 刚 `state` 完就 `selector_not_found` | 页面变了。`wait selector "..."` 再重试 |
| 每条命令都 `stale_ref` | 你在复用上一个页面的 ref。重新 `state` |
| `click` 成功但没反应 | 命中的多半是一个装饰性包装元素，它把点击从真正的目标那里偷走了。用更窄的 `find --css` 打内层元素 |
| `type` 看起来打完了但值不对 | 联想框、掩码输入，或 React 受控重渲染。`get value` 验证，加 `keys Enter` 或重打 |
| `get html` 输出巨大 | 加 `--selector` + `--as json --depth 3 --children-max 20 --text-max 200` |
| 网络缓存像是过期了 | 调小 `--ttl` 或等它过期。缓存在 `~/.opencli/cache/browser-network/` |
| `frames` 返回 `[]`，但页面上明明有跨源 iframe | **先看扩展版本**：`opencli doctor` 的 Extension 行 < 1.1.0 就是没有 OOPIF 支持，而它是静默的。够版本了再跑 `frames --debug` 看卡在哪一层 |
| `eval --frame N` 读到的像是宿主页的 DOM | 页面 reload 过，新 iframe 拿不到 target，opencli 静默退回主页面。用 toggle 恢复面板，不要 reload。见[跨源 iframe 与扩展注入面板](#oopif) |
| `frames`/`contexts` 都对，`eval --frame`/`--context` 还是读到主页面，面板反复开合后必现 | 扩展 1.1.0 的已知回归（OOPIF context 缓存按 tabId 撞号）。升级扩展到 ≥ 1.1.1 并在 `chrome://extensions` reload；命中会报 `frame_not_attached`。见[`our-fork.md`](our-fork.md) |
| 读回来的页面根本不是你导航的那个 | 会话撞名。见 [`session-laws.md`](session-laws.md) 的诊断顺序 |
| `doctor` 红、连不上、`session_not_found` | 见 [`troubleshooting.md`](troubleshooting.md) |


## 验收三铁律

1. 只用 OpenCLI 驱动本机真实 Chrome；不用 Playwright、Firefox/Nightly、headless 或沙箱浏览器。
2. 固定动作做成脚本，stdout 只给摘要和失败点；截图必须给路径，不能输出 base64 或整页 state。入口见 [`../scripts/accept.mjs`](../scripts/accept.mjs)，所有自有会话在 finally close。
3. 缺口必须标记：新扩展支持导航前 console/pageerror 捕获，console 输出 `captureSupported/startedAt`；模板捕获可用时报告真实错误并使验收失败。新扩展支持 `viewport set <width> <height>`（DPR=1）及 `viewport reset`，open 前设置，后续交互/eval/截图保持，close 释放。模板探测后验证顶层读数；旧扩展不支持或探测失败时明确记录原因，回退同源 iframe 固定宽度，在同一 eval 内测 innerWidth/scrollWidth；旧 console 空数组标 `consoleCaptureSupported:false`，不能当“无错误”。iframe 不覆盖顶层导航或禁止嵌入的页面，两条路径均等待字体和图片；不模拟触摸/UA。外域阻断暂缺，`--forbid-external` 仅检测并记录已完成的 Resource Timing 外域资源，发现即失败；不保证覆盖在飞、worker 或完整请求链，不声称阻断。

```bash
node <opencli-skill-dir>/scripts/accept.mjs --url http://localhost:3000/ --url /pricing --widths 1440,390 --height 900 --out /tmp/site-accept --forbid-external
```

`--session` 可指定任务自有名字，默认唯一；`OPENCLI_ACCEPT_CLI=/path/to/dist/src/main.js` 可验证独立构建。退出码反映 pass/fail；artifact JSON 留尺寸和外域记录，console 能力始终单独标记。异步 eval 轮询 URL/可见性带超时，超时明确失败。

batch 的 args 是对象，不是数组：
```json
[
  {"cmd":"open","args":{"url":"http://localhost:3000/"}},
  {"cmd":"wait","args":{"selector":".loaded","timeout":10000}},
  {"cmd":"screenshot","args":{"path":"/tmp/accept.png","width":390,"height":900,"annotate":true}}
]
```
修复版任一步 `ok:false` 或 fill `verified:false` 退出非零；默认继续，`--stop-on-error` 中止，结果的 `index/cmd/error` 定位失败步。旧版可能退出 0，调用方仍须检查结果数组。

安装新构建后用 [`../scripts/live-check.mjs`](../scripts/live-check.mjs) 现场验证 console.error、未捕获异常、1440/390 持续宽度与截图、reset/close 恢复。它会创建本机静态页并操作自有 Chrome 会话；源码检查阶段只 `node --check`，不可当现场通过。
