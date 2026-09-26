# report-spill —— 设计说明（判据 / 边界 / 已知风险）

> 文件：`<WORKSPACE>\task-warden\plugin\report-spill.js`
> 自检：`<WORKSPACE>\task-warden\plugin\report-spill.selftest.mjs`
> 本单：`P-M26`（R26）。上一版新建了这 3 个文件（.js / .selftest.mjs / .DESIGN.md）；
> **本单（R26 返工）只改了这 3 个文件**，`plugin\` 下另外 28 个文件 sha256 **0 处改动**
> （见 §12 证据索引与返工报告里的对拍表）。

---

## 0. 返工的原因（审查判决，逐字）

> **①`SUBAGENT_TOOLS` 漏了本部署默认 preset 的三个真实名字** —— `settings.yaml` 写
> `agent-presets.default: roles`，`<HOME>\.dsh\.agent-presets\roles\agent.cordis.yml:244,262,297`
> 逐字 `toolName: subagent_liaison / subagent_direction / subagent_coder`，端到端实测全部
> `not-subagent-tool`、0 个新文件；
> **②就算名字对上也不触发**：四个 enabled 行都是 `backgroundMode: continuable`，
> `dsh-tool-subagent\lib\index.js:360` 逐字 `runInBackground = request.run_in_background ?? options.continuable`，
> `:486` 后台渲染成 `started subagent ${id}` —— 工具结果原样就是 `started subagent <uuid>`
> （**52 字符** << 6000）；正文走的是 `dsh-subagent\lib\index.js:675 kind:"subagent-settled"` 的**通知**，
> 本插件没挂那条通道。今天唯一能越过 6000 的是 `workflow`(≤5e4)/`ralph`(≤16384)，恰被它刻意排除。

**一句话**：上一版**硬约束全过，但它一次都不会触发，今天省的 token = 0**。
⇒ 本单只做三件事：**补齐工具名**、**挂上真正会响的那条通道**、**给 `角色发言\` 定上限**；
外加**重新定阈值**、**收 workflow/ralph**、**补风险与删重复**。

## 1. 一句话

**子代理回给主代理的报告太长时，把正文逐字节落盘到 `<工程根>\角色发言\`，
只把「头 1200 + 尾 600 + 绝对路径」放回上下文。** 两条通道：
**A `tools/post-execute`（工具结果本身就装着报告时）** 与
**B `agent/pre-step`（默认后台模式的结算通知 —— 本单新增，默认模式下唯一会响的那条）**。

## 2. 为什么要做（用户原话，逐字）

> 「我问个问题，现在的上下文中，还有哪些板块是可用省略掉不每次进行上下文填充的。」
> 「**立即进行，并让每个窗口都是如此。**」

用户给的读数：上下文已用 **79%**，`~790K / 1M`；面板三行 =
系统提示词 ~4.7K · 工具定义 ~9.7K · **对话消息 ~450K**。

⇒ **要治的是「对话消息」**。其中**最肥、最重复的一类 = 子代理回给主代理的长报告**。

⚠ 用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」「**提示词越多越让它跑偏**」。
⇒ 本插件**一个字的提示词都不加**：它不改 systemPrompt、不写 context、不发 steer、
不往 messages 里塞任何东西。它改的是**工具结果的字节**与**消息的字节**，那是代码层面的硬动作。

## 3. 它做什么

### 3.0 两条通道（为什么必须两条）

`dsh-tool-subagent` 的 `backgroundMode: continuable`（本部署默认 preset 的四行都是）下：

| 模型怎么调 | 走哪条路 | 报告在哪 | 本插件哪条通道接得住 |
|---|---|---|---|
| `run_in_background: true`（**默认**） | `dsh-tool-subagent\lib\index.js:525-533` → `startContinuable()`；工具结果 = `started subagent <uuid>`（`:486`，**52 字符**） | **结算通知**（user 消息） | **通道 B** |
| `run_in_background: false` | `:557` → `subagents.start()`（one-shot 前台）；工具结果 = 全文 | **工具结果** | 通道 A |
| `workflow` / `ralph` | 自己的 `render` → `[{type:'text'}]` | **工具结果** | 通道 A |

⇒ 两条通道**互斥**（同一次调用只走一条），不会重复落盘 —— 这也是**不需要按正文去重**的理由。

### 3.1 通道 A 的钩子

```
ctx.on('tools/post-execute', handler, { prepend: true })
```

先例（做法照抄，代码不是照抄）：`…\node_modules\@deepseek-ai\dsh-spill-policy\lib\index.js:155`。

它是 **waterfall**：`handler(exec, result, next)`。**必须 `await next()`** —— 依据 `dsh-tools\lib\index.js:3378`：

```js
const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
```

不调 `next()` 就把后面那些监听器（spill-policy 等）的层拆了 —— 那不是"加一层"。

### 3.2 通道 A 的触发条件（**三条同时满足**，缺一条 ⇒ 原样返回**同一个** decision 对象，净效果 0）

| # | 判据 | 依据 |
|---|---|---|
| 1 | `exec.name` ∈ `SPILL_TOOLS`（7 个子代理工具 + 2 个编排器，见 §3.3） | **核过的名字，不是猜的** |
| 2 | `exec.parent === undefined` | 只管**主代理**收的那一份。`dsh-tools\lib\index.js:1218` 逐字 `parent: exec.token`（PTC 嵌套子调用才有）⇒ 顶层调用是 `undefined`；嵌套的一律不动（与 spill-policy 同一判据） |
| 3 | 结果文本长度 **> 阈值**（默认 **4000 字符**，可覆盖） | 见 §4 |

另外四条**否决**判据（任一命中 ⇒ 不动）：

- `decision.kind !== 'accept'`（含 `block`）；
- `Object.hasOwn(decision, 'value')` —— 值替换与内容替换在 `dsh-tools:3389` 里**互斥**，不许同时动；
- `result.isError === true` —— 失败结果不落盘（错误信息本来就该被看见）；
- 结果里有**任何非 text 块** ⇒ `flattenPlainText` 返回 `undefined` ⇒ 不动
  （口径与 `dsh-spill-policy` 的 `flattenPlainText` 逐字一致）。

### 3.3 ★ 子代理工具名是怎么核出来的（本单补齐；可复跑）

```
<HOME>\.dsh\settings.yaml:226-227
  → agent-presets:
      default: roles

<HOME>\.dsh\.agent-presets\roles\agent.cordis.yml  —— 里**所有** toolName: 的值，一个不漏：
  :232  toolName: subagent
  :244  toolName: subagent_liaison        ← ★ 上一版漏的
  :262  toolName: subagent_direction      ← ★ 上一版漏的
  :297  toolName: subagent_coder          ← ★ 上一版漏的
  :324  toolName: subagent_fork
  :334  toolName: subagent_codex          （该行 disabled: true）
  :343  toolName: subagent_claude_code    （该行 disabled: true）
```

⇒ `SUBAGENT_TOOLS` = **7 个**。disabled 的两行名字同族、同一份 `dsh-tool-subagent` 产生
⇒ 一起收进来，将来启用不必再改这个文件。

**编排器（本单新收）** `ORCHESTRATOR_TOOLS = ['workflow', 'ralph']`，形状核过：

```
dsh-tool-workflow\lib\index.js:226-229
  render: (args, value) => [{ type: "text", text: renderResult(args.meta.name, value.agentsStarted, value.result, maxResultChars) }]
dsh-tool-ralph\lib\index.js:320-323
  render: (_args, value) => [{ type: "text", text: renderResult(value.result, resolved.maxResultChars) }]
```

⇒ 工具结果 = `[{type:'text'}]`，正是 `flattenPlainText` 认得的那种。
它们自己的截断上限：workflow `maxResultChars: 5e4`（`dsh-tool-workflow\lib\index.js:23`）、
ralph `maxResultChars: 16384`（`dsh-tool-ralph\lib\index.js:22`）——
**在官方那条 50000 字节的 spill-policy 线之下**，官方机制基本不会替它们落盘。

⚠ **这是与框架/preset 的耦合**：换了名字这里就得跟着改。漂了**不会静默**：
自检 ③ 逐条钉死这 9 个名字，自检 ㉒ 拿**真 preset 文件**对拍（文件在就必对得上）。

### 3.4 ★★ 通道 B：`agent/pre-step`（本单的核心修法）

```
ctx.on('agent/pre-step', preStepHandler, { prepend: true })
```

**为什么是这里**（逐条带出处）：

1. 事件形状（waterfall）—— `dsh-agent\lib\types\runtime-types.d.ts:313-319` 逐字：
   ```ts
   'agent/pre-step'(this: Scoped<Agent>, payload: {
       agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal;
   }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
   ```
   文档逐字：「Reject a proposed step or **replace the messages that enter it**.」
2. 派发点 —— `dsh-agent-loop\lib\index.js:894-901` 逐字：
   ```js
   const decision = await this.dispatch.waterfall("agent/pre-step", {
       messages: claimed, ...position, signal
   }, () => Promise.resolve({ kind: "enter", messages: context === void 0 ? claimed : [...claimed, context] }));
   ```
3. ★ **换得动，而且是"落在盘上、模型真正看到"的那一份** —— `dsh-agent-loop\lib\index.js:1028` 逐字：
   ```js
   if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", message, { surfaceOp: "append" });
   ```
   进入这一步的消息**才**被写进会话日志 ⇒ 换掉 `decision.messages` 就是换掉持久化的那一份（不是显示层改写）。
4. 那条结算通知从哪来 —— `dsh-subagent\lib\index.js:1244-1259` 的 `notifySettlement()`
   → `createSettlementMessage()`（`:661-681`）逐字：
   ```js
   return createUserMessage({
       content: [{ type: "text", text: summary },
                 ...terminal.output === void 0 ? [{ type: "text", text: "It left no closing message." }]
                                               : [{ type: "text", text: "Its closing message:" }, ...terminal.output]],
       source: { kind: "subagent-settled", form: "notice", summary: boundContextSummary(summary), senderSessionId: childId }
   });
   ```
5. `terminal.output` 就是子代理**最后一条 content 非空的 `assistant/message`**
   （`dsh-subagent\lib\index.js:158-221` 的 `AssistantOutputFold`）
   ⇒ **与 R42（role-voices）读的是同一份文本**（它读 `lastAssistantMessage`）。

**解析判据**（`noticeReport()`，纯函数、零 IO）—— 按 **text 块的序位**，不按 content 下标：

| 位置 | 是什么 | 怎么处理 |
|---|---|---|
| 第 0 个 text 块 | summary（`Background subagent <id> finished …`） | **不动**（带 id 与结局，是有用的小信息） |
| 第 1 个 text 块 | marker | 必须**逐字**是 `'Its closing message:'`；是 `'It left no closing message.'` ⇒ **安静跳过**；**认不出来 ⇒ 不动 + 记一行** `notice-unknown-marker`（绝不猜） |
| 第 2 个 text 块起 | **正文** | 逐字节相接 = 报告正文 |

**替换动作**（`replaceNoticeReport()`）：第一个正文块的位置放替换串，其余正文块删掉；
**其它块（summary / marker / reasoning / tool-call）原样留在原位**（同一个对象引用）。

⚠ **非 text 块不进正文、也不被替换** —— 它们留在上下文里原样不动。
实测（口径见 §4）：323 份真实结算通知里 154 份带 `reasoning` 块，这些块只占通知文本量的 **6.2%**。
⇒ 主代理上下文里唯一被换掉的，就是**被逐字节落盘的那一段正文**：**"不许丢信息"这条是真的成立**。

**解析判据的实测支撑**：323 份真实通知里，块 1 的文案分布是
`"Its closing message:"` × **318** / `"It left no closing message."` × **5**，**无一例外**；
`content` 的形状分布：`text,text,text` ×162、`text,text,reasoning,text` ×142、其余 19 份（含 `tool-call`）。

### 3.5 动作（两条通道共用同一条代码路径）

**① 正文逐字节落盘**（`wx` 独占创建，撞名退 `-2`/`-3`，**永不覆盖**）：

```
<工程根>\角色发言\<YYYY-MM-DD_HHMMSS>__报告__<第三段>.md
  第三段 = 工具名（通道 A） | 子代理会话短 id（通道 B；通知里没有工具名，只有 senderSessionId）
```

文件 = 一小段头部（时间 · **通道** · 工具 · 会话 id · agent id · 调用 id · **子代理会话** · 工程根+via ·
阈值 · 头尾/省略数 · 正文字节 · **正文 sha256** · **内容块构成**） + 一行分隔线 + **原文逐字节**。
**文件的最后一个字节就是报告结果的最后一个字节**（结尾不加换行）。
分隔线之后的全部字节 = 正文，用 `extractBody()` 取 —— 口径只有一份，自检与任何复核都走它。

**② 换回去的内容**（用户点名的格式，**逐字符对照**过）：

```
[完整报告 <N> 字符已落盘（原文逐字节在盘上）：<绝对路径>]

<前 1200 字符>

…（中间省略 <M> 字符）…

<后 600 字符>
```

**③ 返回**：

- 通道 A：`{ kind:'accept', content:[{type:'text',text:<上面的串>}], ...(原 decision 有 additionalContexts ? {additionalContexts: 原样那一个} : {}) }`
- 通道 B：`{ ...原 decision, messages: <新数组> }` —— 只换那一条通知的 `content`，
  `source` 等其余字段**原样保留**；没换到任何东西时**原样返回同一个 decision 对象**。

⚠ 通道 A 的 **`additionalContexts` 必须原样转发** —— `dsh-tools\lib\index.js:3390`：

```js
const additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts];
```

"原样"= **同一个数组对象**，不是复制、不是过滤；原来没有这个键就**不许凭空造一个空数组**（自检 ⑩）。

### 3.6 ★ `角色发言\` 有界（本单新增）

审查判「现在是只增不减（0 处删除/轮转）」⇒ 现在**用代码定上限**：

```
DEFAULT_KEEP_REPORTS = 200        （config.keepReports > env DSH_REPORT_SPILL_KEEP > 200）
0 / off / false / no  ⇒ 关掉轮转（keep = 0）—— ⚠ 是"不轮转"，不是"删光"
```

- **什么时候跑**：每次**落盘成功之后**、返回替换串之前（失败只记一行，绝不影响本次落盘与换回）。
- **删谁**：只删 `listReportFiles()` 认出来的名字 —— 正则 `^\d{4}-\d{2}-\d{2}_\d{6}__报告__[^\\/:*?"<>|]*\.md$`。
  role-voices 的 `__<角色名>__` 归档、用户的 69 份手工存量、`INDEX.md` / `README.md`、
  以及**任何子目录**（例如 `角色发言\2026-09-24\`）**一个都不匹配**。
- **只扫这一层**（`readdirSync(dir)`，不进子目录）；只删 `statSync().isFile()` 为真的项。
- **`protect`**：刚写下去的那个文件名**永不删**（哪怕它按字典序排在最前，例如同秒的 `-2.md`）。
- **为什么是 200**：实测全部 374 份会话归档里**会被 4000 阈值命中的报告一共 123 份** ⇒
  200 给"现有全部历史 + 之后一段时间的增量"留了余量，不会一上线就开删；
  体积按 p75（6110 字符正文 ≈ 8 KB/份含头部）算 ≈ **1.6 MB**，可以忽略。

## 4. 阈值为什么是 4000（**本单重新定**）

| 口径 | 值 |
|---|---|
| 默认 | **4000 字符** |
| 优先级 | `config.maxChars` > 环境变量 `DSH_REPORT_SPILL_MAX_CHARS` > 默认 |
| 关掉 | `config.off = true` / `DSH_REPORT_SPILL_OFF=1` / 阈值写 `0`·`off`·`false`·`no` |

**为什么必须重定**：上一版 6000 的推理建立在"工具结果通道"上，而那条通道在默认后台模式下一次都不会响
（§0 审查判决②）—— 定它没有意义。

**新依据（量出来的，不是拍的）**：

1. **固定开销 = 通知行（含路径 ~210 字符）+ 头 1200 + 尾 600 ≈ 2010 字符**。
   口径：**净省 ≥ 一份固定开销**才算划算 ⇒ 阈值 ≈ 2 × 2010 ≈ **4000**。
2. **实测分布**（口径见下）：323 份真实结算通知的正文
   **min 0 · p10 449 · p25 1166 · p50 2389 · p75 6110 · p90 9086 · p99 17451 · max 34798** 字符。
3. **拐点计算**（同一批样本）：

   | 阈值 | 触发 | 合计省（字符） | 每多收一份的边际收益 |
   |---|---|---|---|
   | 2000 | 183/323 | 802,074 | — |
   | 3000 | 149/323 | 788,528 | +34 份，13,546（**397/份**，低于固定开销） |
   | **4000** | **123/323** | **750,029** | +26 份，38,499（**1481/份**） |
   | 6000 | 82/323 | 632,986 | +41 份，117,043（2854/份） |

   ⇒ 从 4000 再降到 3000，每多收一份只多省 ~400 字符（**低于 2010 的固定开销**）——
   **4000 就是拐点**：它以上每份都明显划算，它以下边际收益掉到固定开销之下。
4. **官方那条线在 8192**（`dsh-base\cordis.patch.yml` 的 `tool-result-pruner`
   `thresholdChars: 8192 / headChars: 4096 / tailChars: 1024`）—— 但那条**只吃工具结果，
   不吃结算通知**（通知是 user 消息）。⇒ **通知这条通道官方没有任何机制覆盖**，本插件是唯一的；
   4000 比 8192 早一步是有意的。

⚠ **"字符"的口径 = 码点（code point）**，不是 UTF-16 码元、不是字节。
一个 emoji 算 1（`String.length` 会算 2）。理由：用户说的"字符"= 人眼看到的一个字。
自检 ①⑤b 用 `'😀'.repeat(8000)` 钉死这条：通知行写 `8000`（不是 `16000`），
且头/尾**不会**把一个代理对劈成半个。

⚠ **实测口径（可复跑）**：`<DSH_HOME>\sessions\**\session.v3.jsonl.zstd` 按魔数 `28 B5 2F FD` 切帧、
逐帧 `zstdDecompressSync`，取 `type === 'user/message' && data.source.kind === 'subagent-settled'`；
正文 = `data.content` 里**第 2 个 text 块之后**的全部 text 块逐字相接（与 `noticeReport()` 同一判据）。
样本：**374 个会话文件 / 323 份通知**（2026-09-24 读数）。**活语料上的数字带时间戳。**

### ⚠ 阈值必须"真的在起作用" —— 判定性对照（自检 ⑰）

同一份 **3000 字符**的报告（默认阈值下的"短报告"）：

| 口径 | 结果 |
|---|---|
| 默认 4000 | **不换**（原样同一个对象，落盘 0 个文件） |
| **副本**：把源码里 `const DEFAULT_MAX_CHARS = 4000` 改成 `1`（真写一份副本文件到 tmp 再 require） | **换**（落盘 1 个文件，正文仍逐字节相同） |
| 调回默认（用原插件） | **不换**（文件数仍是 1，没新增） |
| `config.maxChars = 1` | **换** |
| `env DSH_REPORT_SPILL_MAX_CHARS=1` | **换** |
| `env DSH_REPORT_SPILL_MAX_CHARS=0` | **关**（原样不动） |
| `env DSH_REPORT_SPILL_OFF=1` | **关** |

## 5. 工程根判法（照抄 role-voices，**不另发明**）

```
1. 从 start 往上，第一个有 .git 的目录           ⇒ {root, via:'git',            found:'git'}
2. 一路没有 .git，退而取最近的装着 .warden 的那一层 ⇒ {root, via:'self'|'ancestor-warden', found:'warden'}
3. 都没有                                        ⇒ {root: start, via:'self',    found: null}
```

- `start` = **会话的 `header.cwd`**（通道 A 读 `exec.agent.session.header.cwd`，
  通道 B 读 `payload.agent.session.header.cwd` —— 读法照抄 `warden-watch.js`；
  `exec.cwd` **不存在**，那是死字段）；拿不到就退 `process.cwd()`。
- 这段实现**照抄** `role-voices.js` 的 `findProjectRootVia`（它又是照抄 `warden.mjs:195-213`）。
- `found === null` ⇒ **落盘这一步不做**，原样放行 + 记一行 `project-root-not-found`。
  判据 = 从 cwd 一路向上**既没有 `.git` 也没有 `.warden`**。

### ⚠ 已知风险：**两份实现会漂**

`role-voices.js` 里一份、本文件里一份。**为什么不 `require` 过来**：`role-voices.js` 是插件模块，
`require` 它会连带执行其顶层并暴露 `_internals`；插件之间互相 require 会把"谁挂谁"变成隐式依赖，
一处加载失败就连带另一处静默失效。⇒ 代价就是**会漂**。

**漂了要能被抓住**：自检 ⑱ 是**对拍** —— 8 个夹具（`PROJ` / `PROJ2` / `PROJ/角色发言` / `PROJ/.git` /
`NOROOT` / `LAB` / `<WORKSPACE>` / `<WORKSPACE>\task-warden`）上，两份实现的结果必须**逐字段相同**。

## 6. 它和 R42（`role-voices.js`）的关系：**同一个文件夹，同名不同物**

| | R42 · `role-voices.js` | 本单 · `report-spill.js` |
|---|---|---|
| 落盘的是什么 | **角色原话**（子代理最后一条 `assistant/message`） | **给主代理的报告**（通知/工具结果里的那段文本） |
| 触发点 | 子代理**自己的结束事件**（`agent/turn-stopping` / `agent/status` idle / `agent/error` / `agent/disposed`） | **父代理侧**的 `agent/pre-step`（通道 B）+ `tools/post-execute`（通道 A） |
| 文件名 | `…__<角色名或短id>__<短标题>.md` | `…__报告__<工具名 或 子代理短id>.md` |
| 分隔线 | role-voices 的 `BODY_SEP`（措辞：**角色说出的那段话**） | 本文件的 `BODY_SEP`（措辞：**子代理回给主代理的结果文本**） |
| 头部首行 | `# 角色发言 · 逐字归档` | `# 报告落盘 · 逐字归档（report-spill）` |
| INDEX.md / README.md | 写 | **不写**（见 §7） |

★ **读取口径复用 role-voices 的形状**（`textOf` / `blockSummary` 那一套判据；§3.4 第 5 条也确认
`terminal.output` 与它的 `lastAssistantMessage` 是同一份文本），
但**触发通道必须不同**：role-voices 挂的子代理结束事件只能**看到**那段文本、**改不动**主代理收到的东西；
本插件要的是"换回去"，所以必须挂在**父代理侧的 `agent/pre-step`** 上。**复用形状，不复用挂点。**

**机械判据有三条**（不用读内容、不用猜）：① 文件名第二段是 `报告` 还是角色名；
② 分隔线那一行的**措辞**（两份是**不同的字符串**，刻意如此）；③ 头部首行。
⚠ **改分隔线等于改判据** —— 自检 ⑤ 会跟着红。
⚠ 两者**不会互相覆盖**（都用 `wx` 独占创建 + 撞名退 `-2`/`-3`，自检 ⑭ 有正控），
且本插件的轮转**只删自己的文件**（§3.6、自检 ㉑）。

## 7. 它**不**做什么（明确的边界）

- **不改 `cordis.patch.yml`** —— 挂载由主代理另开一单（本单只交付文件）。
- **不碰 `role-voices.js` / `warden.mjs` / 任何 lab / 任何别的插件 / 任何 `.warden\*`**。
- **不写 `INDEX.md` / `README.md`**：那两个文件是 role-voices 的产物（它有自己的表头与分节标记）。
  往同一份 INDEX.md 里塞一行**形状不同**的记录，会把它的表切坏 —— 那是在改别人的行为。
  ⇒ 报告文件的发现方式是**目录列表 + 文件名**（时间 + `报告` + 第三段）。
- **不进上下文**：对 ctx 只调用 `on` / `effect` / `logger` 三样（自检 ④ 把插件挂到假 ctx 上，
  列出它碰过的全部键，逐条证明 ⊆ `{on, effect, logger}`）。
- **不加任何提示词**（用户逐字要求）。
- **不碰 `.warden\`**：失败台账写在 `os.tmpdir()`。
- **不做摘要/润色/重排**：换回去的串里的头/尾就是原文的头/尾。
- **不碰非本插件的文件**：轮转只认 `REPORT_FILE_RE`，只扫归档目录**这一层**。

## 8. 硬约束 ↔ 机检判据对照表

| 硬约束 | 机检判据（自检编号） |
|---|---|
| **不许丢信息**：正文逐字节在盘上 | ⑤ / ⑤b / ⑭ / ⑮ / **⑳(a)** / ⑳(f)：`extractBody(文件) === 原始文本`（`===` 逐字节）且 `sha256` 相同；头部记的 sha256 与实测相同 |
| **通道 B 真的换得动，且只换该换的** | ⑳(a)：返回新对象；summary / marker / reasoning **同一对象引用**；正文块被换成"头+尾+路径"；⑳(b)(c)(d)(e)(f)(g) 六条负控 |
| **可逆** | ⑯：**先只调 effect 的 disposer** ⇒ 监听器 0 个、effect 0 个；第二个夹具走框架直接 dispose；反控：摘净后 `handler()`/`preStep()` 抛、目录不新增文件 |
| **fail-open** | ⑫（`角色发言` 是个文件 ⇒ `mkdir` 炸）/ ⑬（工程根推不出）：**没有抛**、返回**同一个** decision 对象、content 一字未动、台账各记一行 |
| **零上下文注入** | ④：碰过的 ctx 键 ⊆ `{on, effect, logger}`；且没有 `systemPrompt`/`context`/`messages`/`steer`/`prompt`/`get`/`provide`；没有 `read-unknown` |
| **不碰 `.warden\`** | ⑫：台账路径断言 `!startsWith(<工程根>)`，且落在 tmpdir |
| **非目标工具零 IO** | ⑦：5 个非目标工具 × 40000 字符 ⇒ fs 调用 **0 次**；**正控**：同一个 spy 在目标工具长报告上必须数到 >0；⓪：spy 本身有正控。**⑲b**：通道 B 对非通知消息（400000 字符）⇒ fs **0 次** |
| **性能 < 5 µs/次** | ⑲ / ⑲b：5 次读数 + 中位（见 §9） |
| **触发条件三条 + 四条否决** | ③（纯函数层逐条）/ ⑤⑥⑦⑧⑨⑪（端到端各一条） |
| **工具名单不许漏** | ③（9 个名字逐条 + 审查点名那三个）/ **㉒**（拿真 preset 文件对拍所有 `toolName:`） |
| **`additionalContexts` 转发** | ⑩：**同一个数组对象**（`===`）+ 负控（原来没有就不许造空数组） |
| **阈值真的在起作用** | ⑰：(a)–(h) 八条对照，含**真改副本常量**那一档 |
| **`角色发言\` 有界且不误删** | ㉑：keep=2 时只剩 2 份；role-voices 归档 / `INDEX.md` / `README.md` / 子目录 / 名字形状不对的文件**全部健在**；㉑b `protect` 生效；㉑c `keep=0` 关掉；㉑d 纯函数负控 |
| **工程根判法不许漂** | ⑱：与 `role-voices.js` 的 `findProjectRootVia` 在 8 个夹具上**逐字段对拍** |
| **导出形状对加载器正确** | ⓪b：`{name:'report-spill', inject:[], apply:[Function:2], _internals}` |

## 9. 性能读数（自检 ⑲ / ⑲b，可复跑）

**跑与跑之间会飘**，所以这里只给**区间**与口径；**精确的 5 个读数与中位**以那一次的自检输出为准。

| 场景 | 中位（本单那一次） | fs 调用 |
|---|---|---|
| 通道 A · 非目标工具 `read`，结果 120 字符 | **0.386 µs** | **0** |
| 通道 A · 非目标工具 `read`，结果 400000 字符 | **0.399 µs** | **0** |
| 通道 B · 非通知消息（400000 字符的 user 消息） | **1.947 µs** | **0** |
| 纯 `decide()` 单次（200000 次平均） | **0.0456 µs** | 0 |

口径：通道 A 每次读数 = 2000 次 `await handler(...)` 的平均（`next()` 返回已 resolve 的
`{kind:'accept'}`），先预热 300 次；每档 5 个读数取中位；`ITER*ROUNDS = 10000` 次调用里 fs 计数为 0。
**结果从 120 → 400000 字符没有量级变化** ⇒ 证明非目标工具**根本没扫正文**（工具名一关就返回了）。
通道 B 同理：非 `subagent-settled` 的消息在 `src.kind` 那一关就返回，一次 IO 都没有。

## 10. 怎么跑自检 / 怎么挂载 / 怎么关掉

### 跑自检（**必须**把 `DSH_HOME` 指到镜像 —— 缺一样就 exit 2）

```powershell
$env:DSH_HOME='<WORKSPACE>\task-warden\.warden\patches\P-M26\work\mirror-dsh-home'; node <WORKSPACE>\task-warden\plugin\report-spill.selftest.mjs
```

镜像必须含：

```
<DSH_HOME>\skills\task-warden\warden.mjs
<DSH_HOME>\skills\task-warden\bill.mjs
<DSH_HOME>\skills\task-warden\selftest.mjs
<DSH_HOME>\skills\task-warden\experiments\lab\      （目录）
```

⚠ 这条门槛**故意做成硬门槛**（exit 2 + 打印该怎么跑）："测的时候环境不对"必须是**跑出来的红**。
`--keep` 保留夹具（`%TEMP%\report-spill-lab`）用于端到端演示。

### 挂载（**本单不做**，交给主代理）

在 `%DSH_HOME%\profiles\web\cordis.patch.yml` 的 `insert` 列表里加一行：

```yaml
    - id: report-spill
      name: <WORKSPACE>/task-warden/plugin/report-spill.js
```

⚠ 两条实测过的坑（写在那个 yml 自己的注释里）：
增删 insert 行是 **live** 的；但**改这个 `.js` 的代码要重启 DSH** 才生效（模块被 import 缓存住）。
⇒ **本单的修法要生效，主代理必须重启 DSH 进程**（本单的端到端证据是用 `--patch` 起的新进程验的，见 §11.8）。

### 关掉（三条路，任选）

1. 从 `cordis.patch.yml` 里删掉那两行；
2. 环境变量 `DSH_REPORT_SPILL_OFF=1`；
3. 环境变量 `DSH_REPORT_SPILL_MAX_CHARS=0`（0 **必须**当"关"）。

（另：`DSH_REPORT_SPILL_KEEP=0` 只关掉轮转，不影响落盘。）

## 11. 已知风险（不藏）

### ★ 两条最要紧的（本单补）

1. **触发面漏名字 ⇒ 整个插件静默失效**（**上一版就是这样死的**）。
   本部署默认 preset 的工具名是**运行时从 `agent.cordis.yml` 读出来的**，不是常量：
   加了新角色（新 `toolName:`）而这里没跟 ⇒ 那个角色的一切报告**一次都不会落盘**，
   而且**没有任何报错**（`decide()` 直接 `not-spill-tool` 返回，零 IO、零日志）。
   **兜住它的判据**：自检 ③ 钉死 9 个名字 + 自检 ㉒ 拿**真 preset 文件**对拍。
   ⚠ 但 ㉒ 只在文件存在时才对拍（换机器/换 DSH_HOME 就跳过）——
   **跳过 ≠ 通过**，输出里会明说"没对拍"。
2. **后台模式让"工具结果"这条通道整条失效**（**上一版就是这样死的**）。
   `backgroundMode: continuable` ⇒ `runInBackground` 默认 `true` ⇒ 工具结果只有
   `started subagent <uuid>`（52 字符），正文在**结算通知**里。
   本版靠通道 B 接住了它；**兜住它的判据**：自检 ⑳(a) 端到端 + 本单在真 DSH 进程里的端到端读数。
   ⚠ **通道 B 依赖两个框架细节**（`source.kind === 'subagent-settled'` 与块 1 的逐字文案）；
   任一变了，通道 B 会退化成"认不出来 ⇒ 不动 + 记一行 `notice-unknown-marker`"——
   **它会响**（台账 + logger），但不再省 token。**这是本插件最脆的一处耦合**。

### 其余

3. **工程根判法有两份实现，会漂** —— 自检 ⑱ 对拍兜住（漂了就红）。见 §5。
4. **`角色发言\` 是"两个写入者一个目录"** —— role-voices（角色原话）与 report-spill（给主代理的报告）。
   文件名/分隔线/头部三处都不同（§6），且都用 `wx` 独占创建 ⇒ **不会互相覆盖**；
   轮转只删自己的文件（§3.6）。但目录里两种文件混在一起，**人**要按文件名区分。
5. **报告文件没有索引** —— 不写 INDEX.md（§7）。发现方式只有目录列表。
   如果用户觉得"翻不到"，需要主代理决定要不要单开一份索引。
6. **同 `callId` 重放缓存上限 1024 条**（FIFO 淘汰）—— 超过之后同一次调用被问第二遍会**再落一份文件**
   （不是丢信息，是多一份）。真实路径上 `post-execute` 每次 dispatch 只跑一次，这条是防御性的。
   通道 B 没有这个问题：消息被 `inbox.claim()` 取走一次就没了，不会重复进 pre-step。
7. **`--keep` 之外的夹具每次自检都删**（`%TEMP%\report-spill-lab`）—— 想在真机上留证据必须 `--keep`。
8. **本单的代码还没在"常驻挂载"下生效** —— 端到端证据是用 `dsh --profile headless --patch <夹具>`
   在**真 DSH 进程**里跑出来的（真派子代理 / 真落盘 / 真换回），
   但**跑 web profile 的那个常驻进程仍加载着旧模块**（Node import 缓存）。
   ⇒ **要让用户真正受益，主代理必须重启 DSH**（§10）。"没重启"和"重启了"是两件事，不许混。

## 12. 证据索引

| 证据 | 位置 |
|---|---|
| 自检完整输出（**266 条断言，PASS 266 / FAIL 0，exit 0**） | `<WORKSPACE>\task-warden\.warden\patches\P-M26\R26-返工报告.md`（逐字贴了关键几行） |
| 返工前后 `plugin\` 下 31 个文件的 sha256 对拍 | 返工报告 §6（只列未变的 28 个 + 变了的 3 个） |
| 本单正文报告 | `<WORKSPACE>\task-warden\.warden\patches\P-M26\R26-返工报告.md` |
| `DSH_HOME` 镜像（跑自检用） | `<WORKSPACE>\task-warden\.warden\patches\P-M26\work\mirror-dsh-home\` |
| 上一版的证据索引 | `<WORKSPACE>\task-warden\.warden\patches\P-M26\R26-报告.md` |
