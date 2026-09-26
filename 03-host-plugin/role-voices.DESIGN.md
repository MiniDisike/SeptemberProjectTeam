# role-voices · 设计说明（R42）

> 本文件是 `role-voices.js` 的**设计依据**，不是需求本身。需求原话在下面第 0 节。
>
> ---
>
> **R42 返工（审查判决 `bad`）改了哪四处** —— 边界与证据都在第 9 节：
>
> | # | 文件 | 改了什么 |
> | --- | --- | --- |
> | ① | `plugin\role-voices.js` | **F1**：扫描加"子代理自己那段事件"的**下界**（`ownEventRange`）；下界拿不到 ⇒ **拒收 + 记一行失败**，**绝不退回 0**。**F6**：注释如实说明**未实现**官方的流式文本兜底。**F7**：把 `agent/status` 的 payload 不带 `agent`、靠 `fused()` 注入这一层依赖写进依据。 |
> | ② | `plugin\role-voices.selftest.mjs` | **F4/F5**：假 ctx 的 `dispose()` 改成**只调注册时交回来的 disposer**（旧夹具无条件清空 listeners/effects ⇒ ⑦ 那两条断言是**假绿**）；加 ⑦b 反控 + ⑭（F1 fork 负控/正控）+ ⑮（F3 段序）。 |
> | ③ | `plugin\role-voices.DESIGN.md` | 本文件：第 1/2/3/5/7/8/9/10 节按上面三处如实更新。 |
> | ④ | `角色发言\INDEX.md` | **F3**：两段**对调**（手工存量在前、自动归档在**最后**）；「时间」列从文件名日期改成**每份文件 `| 开始 |` 行的精确到秒时间**（69/69 取到，0 行缺失）。⚠ **69 份日志本身一个字节都没动**（sha256 变化数 = 0，见第 9 节）。 |

---

## 0. 需求与病根（用户逐字）

**R42（SPEC）**

> 「做一个硬机制，每个项目默认开一个文件夹放这些不需要放入上下文，但你可以阅读，我也可以点入阅读的文件夹。」

**病根（用户逐字）**

> 「角色说的话到现在我没看到过，之前就算被AI改掉也还要显示三个，但现在一个都看不到了，**我全程只看到你说的，没有别的信息来源**。」

**⇒ 「主代理是唯一信息通道」这件事本身就是缺陷。** 角色说了什么，用户只能看到主代理的转述，
或者干脆看不到 —— 而转述正是本项目明令禁止的东西。

所以本插件的目标**不是**"让主代理转述得更准"，而是**把原话本身放到用户能直接读的地方**。
它一个字节都不进上下文，只往磁盘写。

---

## 1. 一句话形状

```
子代理结束事件（硬 hook）
      │
      ▼
 origin === 'subagent' ?  ──否──▶ 直接返回（主会话一个字节都不写）
      │是
      ▼
 ★ 先算「子代理自己那段事件」的下界 = max(0, session.inheritedEventCount)   ← F1
      │拿不到 ──▶ 拒收 + 记一行失败（own-bound-unknown），**绝不退回 0**
      ▼
 在 [下界, seq-1] 这一段里取「最后一条 content 非空的 assistant/message」
      │
      ▼
 正文 = 该消息所有 {type:'text'} 块的 text 原样首尾相接（不 trim / 不插字符）
      │
      ▼
 写 <工程根>\角色发言\<YYYY-MM-DD_HHMMSS>__<角色>__<短标题>.md   +  追加一行 INDEX.md
```

**没有主代理参与的任何一步。** 主代理不知道有这个插件，也不需要知道。

---

## 2. 硬 hook 落在哪一行 —— 为什么"主代理不参与也会落盘"

| 位置 | 内容 |
| --- | --- |
| `role-voices.js` | `apply()` 里 `for (const [evName, pick, label] of HOOKS) disposers.push(ctx.on(evName, …))` |
| 具体行 | 见文件内 `// ★★ **硬 hook 的落点**` 那一行下面的 `function archive(agent, source)`，以及 `apply()` 末尾的 `for (const [evName, pick, label] of HOOKS)` 循环 |
| 挂的 4 个事件 | `agent/turn-stopping` / `agent/status`(idle) / `agent/error` / `agent/disposed` |

**为什么这样就能"主代理不参与"**：这 4 个事件是 **DSH 自己的 agent 循环**发出来的，
不是主代理"记得去调"的：

- `agent/turn-stopping` —— `dsh-agent-loop\lib\index.js:967`，`this.dispatch.serial("agent/turn-stopping", {turn, signal})`，
  在每个回合的边界**由循环自己发**；
- `agent/status` —— 同文件 `:781`，`setPhase()` 里状态从 `running` 变 `idle` 时发；
- `agent/error` —— 同文件 `:863`，`throwError()` 里发；
- `agent/disposed` —— `dsh-agent\lib\index.js:513-518`，agent 从注册表摘掉时发。

每个 payload 都被 `dsh-agent\lib\index.js:209-213` 的 `fused()` 注入了 `agent` 本身
（`fused = (payload) => ({...payload, agent})`），所以监听器**直接拿到那个子代理对象**，
不需要任何查表、不需要主代理上报、也不需要问任何服务。

### 2.1 ⚠ F7：这一层 `agent` 是**注入**的，emit 点自己**不带**

这条依赖必须单独写清楚，因为**看 emit 点的行号会看漏它**：

| 事件 | emit 点原样 | payload 里有 `agent` 吗 |
| --- | --- | --- |
| `agent/status` | `dsh-agent-loop\lib\index.js:781`：`this.dispatch.emit("agent/status", { status })` | **没有** —— 字面上只有 `{status}` |
| `agent/turn-stopping` | 同文件 `:967`：`await this.dispatch.serial("agent/turn-stopping", { turn, signal })` | **没有** |
| `agent/error` | 同文件 `:863`（`throwError()` 里） | **没有** |
| `agent/disposed` | `dsh-agent\lib\index.js:513-518` | **没有** |

`agent` 是 `agentEvents(ctx, agent)` 返回的**派发器**在派发那一刻加的：
`fused = (payload) => ({...payload, agent})`（`dsh-agent\lib\index.js:209-213`），
`emit` 走 `:215-220`（`this.ctx.emit(...)` 之前先 `fused(payload)`）。

**审查的实测（原样照 emit 点）**：`emit('agent/status', {status:'idle'})` ⇒ **0 条归档**；
把 `agent` 补进 payload ⇒ **1 条**。

⇒ 两个后果，都写进代码：
1. 本插件的 4 个 hook **必须走 `ctx.on` 收"派发之后"的 payload** —— 那一层才有 `agent`；
2. 插件里**绝不许自己伪造/转发 payload**（那样 `agent` 就是 `undefined`，
   4 个 hook 会**一起静默失效**）。`archive()` 第一句就是 `if (!agent || typeof agent !== 'object') return`，
   而"一个子代理都没归档"这件事在正控 ⑩ 里是**期望行为**，所以这种失效**不会自己叫**——
   这正是为什么要把这层依赖写在依据里，而不是留在"读代码时以为 emit 点带了"。

**为什么挂 4 个而不是 1 个**：子代理"结束"在 DSH 里有多个可观察边界。
只挂一个的话，任何一条路径没走到（比如回合被 abort、或驱动层直接 dispose），
整条线就**静默失效** —— 而"静默失效的看守比没有看守更坏"。4 个都经过同一道
`origin === 'subagent'` 硬过滤和同一份去重表，多挂只是多几次"看一眼就返回"。

**硬过滤那一行**：

```js
if (!header || header.origin !== 'subagent') return
```

主会话的 header **没有** `origin`（`dsh-session\lib\index.js:790` 只允许它等于 `"subagent"`，
主会话是 `delegationDepth: 0` 且无 `origin`）—— 所以主代理自己的回合边界在这里一眼被挡掉。

---

## 3. 关键事实与出处（都是读源码核过的）

| 事实 | 出处 |
| --- | --- |
| 子代理判据 `header.origin === 'subagent'` | `dsh-subagent\lib\index.js:502-513`（`childSessionMeta`）、`dsh-session\lib\index.js:790` |
| 事件 payload 带 `agent`（**注入的，emit 点不带**） | `dsh-agent\lib\index.js:209-213`（`fused()`）、`:215-220`（`emit`）；见第 2.1 节 |
| ★ **官方只吃"子代理自己的事件"** | `dsh-subagent\lib\index.js:336-343`：`start` 时记 `boundary = child.session.seq`，`capture` 时 `const own = child.session.snapshotEvents(boundary)` |
| ★ **fork 子代理 = 带 seed 建 ⇒ `inheritedEventCount = seed.length`** | `dsh-subagent-fork-in-process\lib\index.js:48-51`（`startInProcessRun(request, {seed})`）；`dsh-subagent-in-process-driver\lib\index.js:185`（`inheritedEventCount: activationBoundary`）；`dsh-session\lib\index.js:1006`（字段）/`:1081-1085`（赋值，`?? 0`）/`:1583-1591`（fork 传值） |
| 4 个事件都在 emit/serial 上，**不需要 `next()`** | `cordis\lib\index.js:280-294`（emit/serial 直接 `cb(...args)`）；只有 waterfall 才传 next（`:317-325`） |
| `agent.status ∈ 'idle'｜'running'` | `dsh-agent-loop\lib\index.js:773` |
| 会话读取 `seq` / `eventAt(seq)` / `inheritedEventCount` / 事件带 `time` | `dsh-session\lib\index.js:1130` / `:1096` / `:1006` / `:1185` |
| 助手消息形状 `{turn, step, message:{role:'assistant', content:[…]}}` | `dsh-agent-loop\lib\index.js:1050-1064`；`dsh-session\lib\index.js:928-949` 校验 |
| 文本块 `{type:'text', text}` | `dsh-llm\lib\index.js:79-81` |
| "最后一条助手消息"的**官方主规则** | `dsh-subagent\lib\index.js:184-188` 的 `AssistantOutputFold.push()`：`assistant/message` 且 `content.length > 0` ⇒ 覆盖候选；空 content 的只记 usage |
| ⚠ **官方还有一条"流式文本兜底"，本插件没有实现**（F6） | `dsh-subagent\lib\index.js:189`（`pushText(joinAssistantStreamText(event.data.stream))`）、`:195-197`（`partial`）、`:203-210`（`collect()`：一条 message 都没有时返回 `[{type:'text', text: partial.join('')}]`） |
| 角色名来源：`subagent/descriptor` 的 `label` | `dsh-subagent\lib\index.js:1301-1315`（`DESCRIPTOR_BASE_KEYS` 含 `label`）、`:1393-1412`（`snapshotSubagentDescriptor`）、`:1413-1417`（**第一条权威**）；写入点 `dsh-subagent-in-process-driver\lib\index.js:139-148,178` |
| `label` 正常情况下一定有 | 工具 schema 里 `description` 是 `required: true`：`dsh-tool-subagent\lib\index.js:402-406` |
| 工程根判法 | **照抄** `warden.mjs:195-213` 的 `findProjectRootVia`（只读参考，未改该文件） |

---

## 4. 三个设计决策（都与"照抄约定"有关，值得单独说）

### 4.1 工程根：照抄约定，但**多返回一个 `found`**

`warden.mjs:210` 和 `:212` 这两种**不同的事实**返回了**同一个字符串**：

```js
if (wardenOwner) return { root: wardenOwner, via: path.resolve(wardenOwner) === abs ? 'self' : 'ancestor-warden' };
return { root: abs, via: 'self' };          // ← 也是 'self'
```

⇒ `.warden` 就在起点自己身上（找到了）和"一路什么都没有"（没找到）**都是 `via:'self'`**。
光看 `via` 分不出"工程根推出来了"还是"推不出来"。

本插件的 `findProjectRootVia` **`root` / `via` 的取值与 warden.mjs 逐条一致**，
额外返回一个 `found: 'git' | 'warden' | null`。`found === null` 才是"推不出"。

**`found === null` 时拒收**（而不是就地撒一个 `角色发言\`）：
那正是当年"`.warden` 落到容器目录上、两个项目读到对方守则"那一类事故的同构版本。
拒收时**如实记一行失败**，不静默（第 6 节）。

### 4.2 角色名：用 `subagent/descriptor.label`，不是猜的

第一版想过用 `header.agentPreset`。查了源码之后否掉：`agentPreset` 是**预设名**
（例如 `standard` / `roles`），不是角色名 —— 同一个预设下的所有子代理会拿到同一个"角色名"，
那是**误导**，比"短 id"更坏。

真正对的是 `subagent/descriptor` 事件里的 `label`，它就是派子代理时给的 `description`
（例如「审查」「资料员」），而且**就落在子代理自己的会话日志里**，不需要问任何服务。

取值顺序（都拿不到才退到短 id）：
`subagent/descriptor.label` → `agent.label` → `agent.meta.label` → `agent.description` → 短 id。

### 4.3 模块形态：为什么是 `module.exports` 而不是 `export const name`

任务书写的是 `export const name` / `export const inject` / `export function apply`。
本文件用的是 `module.exports = { name, inject, apply }`。**理由是一条实证链，不是偏好**：

1. 宿主加载器取模块的方式：`cordis-plugin-loader\lib\index.js:270-283`
   —— `if (this.ctx.loader.internal) return await this.ctx.loader.internal.import(name, baseUrl, {})`，
   否则 `await import(name)`；再经 `unwrapExports`（`:746-751`）做 `exports.default ?? exports` 归一。
2. **实测**：纯 Node 的 `import('<WORKSPACE>/task-warden/plugin/warden-watch.js')` **直接抛**
   `Only URLs with a scheme in: file, data, and node are supported by the default ESM loader.
   On Windows, absolute paths must be valid file:// URLs. Received protocol 'd:'`
   ⇒ 这个 profile 走的**必然是 `loader.internal`** 那条路（不是 Node 默认 ESM 加载器）。
3. 那个 `loader.internal` 的实现，我在随包发布的 `lib/*.js` 里**没找到**（见第 8 节）。
   所以"它认不认 ESM 语法"**没有证据**。
4. 唯一**有证据**能过那条路的形态，是同目录的 `warden-watch.js`：
   `module.exports = { name, inject, apply }` —— 它正被
   `%DSH_HOME%\profiles\web\cordis.patch.yml:12-14` 挂着，而且活着。
5. 而且 CJS 形态**并不损失具名导出**：实测
   `await import('file:///<WORKSPACE>/task-warden/plugin/role-voices.js')`
   → `Object.keys(m) === ["apply","default","inject","name"]`，
   `m.name === "role-voices"`、`m.inject === []`、`typeof m.apply === "function"`。
   cjs-module-lexer 认得 `module.exports = {…}` 这种字面量，
   **`name` / `inject` / `apply` 仍然是模块级具名导出**。

⇒ 选**被证明能挂上的那个**。这是一条**偏差**，报告里单列（第 7 节）。

---

## 5. 逐字性是怎么保证的（可机器复核）

- 正文 = `content.filter(b => b.type === 'text').map(b => b.text).join('')`
  —— **不加分隔符、不 trim、不换行归一**。任何一个"顺手"的动作都会破坏逐字性。
- 文件布局固定：

  ```
  <头部若干行>
  <空行>
  --- 逐字正文开始（…） ---
  <正文，到文件结尾，不补换行>
  ```

  ⇒ **文件的最后一个字节，就是角色说的最后一个字节**。
  ⇒ 正文 = 分隔线之后的**全部字节**，`extractBody()` 是唯一口径（自检与复核共用它）。
- 头部同时记 `- 正文字节:` 和 `- 正文 sha256:`，任何人可以独立复核。
- 非文本块（工具调用等）**不进正文**（那不是"角色说的话"），
  但**块构成记在头部**（`- 内容块: text×1, tool-call×2`）——
  **不隐藏**，所以"只贴了文本"这件事一眼看得出，不会看起来像截断。

### 5.1 INDEX.md 是**只追加**的（不许毁掉已有内容）

`<工程根>\角色发言\INDEX.md` 的三种情况：

| 情况 | 行为 |
| --- | --- |
| 不存在 | 建一份带表头的空表 |
| 已存在、且已经是本插件的表（含 `\| --- \| --- \| --- \| --- \| --- \|`） | 什么都不做 |
| 已存在、但是**别的格式** | **只追加**一行分节标记 + 表头；已有内容**一个字节都不动** |

为什么要有第三种：这个文件夹**可能已经存在**，里面可能已经有一份**手工**写的 INDEX.md
（本机 `<WORKSPACE>\task-warden\角色发言\INDEX.md` 见 8.3）。
只追加分节，至少让"哪几行是自动归档的"一眼看得出 ——
**不许因为自动化而毁掉用户手工攒的东西**。

#### 5.1.1 ⚠ F3：插件只**往文件末尾**追加 —— 所以"自动段"必须排在**最后**

插件的写入是 `fs.appendFileSync(path.join(dir, INDEX_NAME), indexLine(...))` ——
**它只会往整个文件的末尾追加，不会插进任何一段的中间**。

于是当 `INDEX.md` 是**一份统一表格、两段都用同一个表头**时，
第二种情况命中（`existing.includes(INDEX_TABLE_SEP)` ⇒ 插件**什么都不插**），
新行就落在**整个文件的最末尾**。审查拿真的 `INDEX.md` 实测过：

```
自动归档行落在第几行(1基): 108 / 共 109
「① 自动归档」段表头在第 17 行；手工存量段第一行在第 39 行
分节标记出现次数: 0
```

⇒ 新行掉到了 69 行手工存量**下面**，不在自动段里。**这是文件布局问题，不是代码问题。**

**主代理定的修法（已执行）**：把 `INDEX.md` 的两段**对调** ——
**① 手工存量在前、② 自动归档在最后**，并且让文件的**最后一个字节是自动段的表头分隔线 + 一个换行**
（`| --- | --- | --- | --- | --- |\n`）。这样"末尾追加"就自然落在自动段的表里。

对调前后的行号分布（实测，`node` 脚本逐行数出来的）：

| | 段序（小节标题行） | 两个表头分隔线 | 69 行数据 | 末行 | 总行数 |
| --- | --- | --- | --- | --- | --- |
| **对调前** | 第 7 行 ① 自动归档 · 第 22 行 ② 手工存量 | 17 / 37 | 39..107 | 第 107 行（一条数据行） | 107 |
| **对调后** | 第 12 行 ① 手工存量 · 第 100 行 ② 自动归档 | 29 / **111** | 30..98 | 第 111 行 = **表头分隔线** | 111 |

拿**真的对调后的 `INDEX.md` 的副本**让插件追加一行（真文件不碰）：

```
① 手工存量段标题在第 12 行
② 自动归档段标题在第 100 行
两个表头分隔线在第 [29,111] 行（最后一个 = 111）
插件追加的新行在第 112 行
新行紧跟在最后一个分隔线之后 ? true
新行在「② 自动归档」段里 ? true
分节标记出现次数: 0
69 行手工存量是否仍是「新行之前」的完整前缀 ? true
```

**为什么不去改插件的写入方式**（例如"按分节插入"）：那要把 `appendFileSync` 换成
"读全文 → 找段 → 重写全文"，等于**每次归档都要重写整个 INDEX**（现在 22 KB，
但存量会涨），而且一旦中间失败就可能**毁掉用户手工攒的内容**。
把段序排对是**零风险、零代价**的，所以选它。

⚠ **这个约定是文件侧的，不是代码侧的**：插件的代码里**没有任何一处**知道"哪一段是自动段"。
如果以后有人把自动段挪回前面，F3 会**原样复发**（自检 ⑮ 会在**夹具**层面抓住形状错误，
但抓不住真文件被改回去 —— 那是"文件布局漂移"，见第 8 节只报告项）。

### 5.2 ★ F1：只扫**子代理自己**的那段事件（下界 = `inheritedEventCount`）

**病根**：`lastAssistantMessage` 原来从 `total-1` 一路扫到 **0**，**没有下界**。

**为什么必须有下界（官方口径，不是推理）**：

| 步 | 事实 | 出处 |
| --- | --- | --- |
| 1 | 官方取最终输出时喂进去的是**子代理自己的事件**：`boundary = child.session.seq`（在 `start` 时记下），`capture` 时 `const own = child.session.snapshotEvents(boundary)` | `dsh-subagent\lib\index.js:336-343` |
| 2 | fork 出来的子代理是**带 seed 建的** ⇒ `header.isSeeded = true`、`inheritedEventCount = seed.length` | `dsh-subagent-fork-in-process\lib\index.js:48-51`；`dsh-session\lib\index.js:1583-1591` |
| 3 | ⇒ 从 `total-1` 扫到 0 会走进**被继承的父会话前缀**，把**主代理**那条 `assistant/message` 当成"角色发言"归档 + 署角色名 + 写 INDEX | 审查夹具实测：`inheritedEventCount=3`、前缀放一条主代理的话、子代理自己零 `assistant/message` ⇒ 归档文件数 1，正文 === 主代理那句话 |
| 4 | ★ **这个下界就是官方对"自己的事件"的定义**：`ownEvents()` 逐字是 `this.snapshotEvents(this.inheritedEventCount)`；`isOwnSeq(seq)` 逐字是 `seq >= this.inheritedEventCount && seq < this.seq` | `dsh-session\lib\index.js:1114-1128` |

⇒ `ownEventRange()` 返回的 `[from, total)`（`from = max(0, inheritedEventCount)`、`total = seq`）
与官方第 4 条**逐字同构**：`ownEvents()` 会拿到的正是这一段，一个事件不多、一个不少。

**修法**：下界 = `Math.max(0, inheritedEventCount)`，两个扫描器
（`subagentLabel` / `lastAssistantMessage`）共用同一个 `ownEventRange(session)`。

**下界拿不到时怎么办（本单自己判的，理由在下面）**：**拒收 + 记一行失败**，**绝不退回 0**。

- 退回 0 = 上面那条洞本身。"拿不到下界"和"没有前缀"是**两件不同的事实**，
  压成同一个 `0` 就是把主代理的话又放进来 —— 这正是 F1 的机制。
- 实证"拿不到"在真 `Session` 上不会发生：`dsh-session\lib/index.js:1081` 是
  `SessionLogOffset(suppliedInheritedEventCount ?? 0)`，`:1085` 无条件赋值
  ⇒ **真 `Session` 实例上这个字段永远是数字**（无 seed 时就是 `0`）。
  所以"拿不到"只可能出现在**不是 `Session` 的会话样对象**上 —— 那时宁可拒收。
- 失败原因逐字区分，方便定位：
  `session-unreadable`（读不了事件）/ `own-bound-unknown`（字段拿不到，含 `null`/`undefined`/非数/负数）
  / `own-bound-inconsistent`（下界比 `seq` 还大）。
- `subagentLabel` 同样受这条约束：下界拿不到 ⇒ 返回空串（**不猜**），`roleName()` 退回短 id。

**另外两处相关改动**：
- `no-assistant-message` 的 detail 现在会写出**自己那段事件的区间**
  （`seq 3..4`）并说明"前面 seq 0..2 是被继承的父会话前缀，不算它的发言"；
- 归档文件头部新增一行
  `- 子代理自己的事件: seq 3..5（inheritedEventCount=3；更小的 seq 是被继承的父会话前缀，不是它的发言）`
  —— 让**每一份归档文件自己**就能证明它只吃了子代理的事件。

**判定性实验**（自检 ⑭，负控 + 正控成对，原样输出见第 10 节）：

```
[证据 ⑭] 夹具：seq=5  inheritedEventCount=3  前缀 = seq 0..2（seq 1 是主代理的 assistant/message），子代理自己 = seq 3..4
[证据 ⑭] 旧口径（从 total-1 扫到 0）命中：{"seq":1,"text":"★这是主代理（父会话）说的话，不是子代理说的★"}
[证据 ⑭] 新口径（下界 = inheritedEventCount = 3）命中：null
[证据 ⑭ 负控] 归档文件数: 0
[证据 ⑭ 正控] 归档文件：["2026-09-24_190305__审查__★这是子代理自己说的★.md"]
[证据 ⑭ 正控] 正文 === 子代理自己那句话 ? true
[证据 ⑭ 正控] 正文 === 主代理那句话 ? false
```

---

## 6. 失败如实（三条出口，一条都不许静默）

`report()` 一次尝试三个出口，因为三条路各自会瞎：

| 出口 | 什么时候有用 |
| --- | --- |
| `<fallbackDir>\role-voices-failures.jsonl`（默认 `%TEMP%`） | 结构化、可机检；**工程根推不出时唯一能落的** |
| `console.error` | 有人看 host stderr 就立刻看得到 |
| `<工程根>\角色发言\INDEX.md` 里一行 `⚠ 归档失败` | 归档目录可用时，**用户点进去就看得到** |

覆盖的失败原因：`no-cwd` / `project-root-not-found` / `archive-dir-unusable` /
`session-unreadable` / **`own-bound-unknown`** / **`own-bound-inconsistent`**（后三条是 F1 返工新增）/
`no-assistant-message` / `no-text-blocks` / `archive-write-failed` / `index-append-failed` / `archive-threw`。

⚠ **`own-bound-*` 这一族必须存在**：F1 的病根就是"下界拿不到时**没有**如实说出来"。
它们把"我不知道子代理的事件从哪开始"这件事变成一行**能被机检的失败记录**，
而不是退化成"看起来归档成功了、其实归档的是主代理的话"。

⚠ **本插件绝不往外抛**：它是看守，不是被看守的东西 ——
它的异常绝不能反过来把子代理的结束流程搞坏。
所以 `archive()` 整段包在 `try/catch` 里，兜底也**必须**记一条 `archive-threw`（不许吞）。

**唯一的例外是 `ctx.on` 装不上**：那时**故意让它抛**，
让加载器把 `failed to apply loader entry …` 报出来 ——
悄悄退化成"永不归档"比没有看守更坏。

---

## 7. 性能与消耗（用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」）

| 场景 | 代价 |
| --- | --- |
| **主代理每次回合边界**（最常见的调用） | 3 次属性读取（`agent.session.header.origin`）后返回。**零 IO、零分配**。微秒级。 |
| 子代理的后续事件（第 2/3/4 次触发） | 一次 `Map/Set` 查键 + 一次从尾部往回扫 `assistant/message`（正常 1~3 步命中；**下界 = `inheritedEventCount`，不会扫进父会话前缀**）。**零 IO**。 |
| **每个子代理结束时的真实写入**（一次） | ① 归档文件 1 个：头部（约 400~900 B）+ 正文（= 原话长度）；② `INDEX.md` 追加 1 行（约 150~250 B）。**合计 2 次小写入**。 |
| 目录初始化 | 每个工程根**只做一次**（`ensured` 集合）：1 次 `mkdir` + 2 次 `existsSync`。 |
| 失败路径 | 1 次 JSONL 追加（+ 可用时 1 行 INDEX）。只在失败时发生。 |
| 进程内存 | 每个子代理一条 key 字符串。会话结束/进程退出即释放。 |

**不做的取舍（都是为了省）**：
- **不做 boot 时扫描/回放**：进程刚起来时注册表里没有任何子代理，回放只会带来"重启后重复归档"的风险。
- **不做目录扫描去重**：去重只需要覆盖"同一个 agent 的同一批事件"，
  而那批事件只可能来自**本进程**（agent id 全局唯一，不存在两个进程同时报同一个 agent 的结束）。
  ⇒ 用进程内 `Set`，**省掉每次归档前扫一遍目录的 O(N) IO**。
  代价如实说明：**去重的作用域是进程生命周期**；因为没有任何"回放旧 agent"的入口，重启不会重复归档。
- **不在 boot 时建文件夹**（懒建）：只在**真的有东西要落**的那一刻建。
  ⇒ 正控成立：**没有任何子代理 ⇒ 一个文件都不建**（`README.md` / `INDEX.md` 也不建）。
  替代方案（`ensureOnBoot`）被否掉，因为 boot 时 `process.cwd()` 是**会话工作区**，
  不一定是工程根 —— 在错误的目录上建文件夹正是要防的事。
- **不注册定时器、不监听文件、不 spawn 子进程、不调用任何服务。**

**量的口径**（`proj` 夹具实测）：一条 135 B 的发言 ⇒ 归档文件 **904 B**、`INDEX.md` **200 B**、
`README.md`（每个工程只建一次）**2574 B**。头部固定开销约 770 B —— 这是"可复核"的价钱
（时间 / 角色 / 来源 / agent id / 工程根 / 归档键 / 内容块 / 字节 / sha256）。

---

## 8. 发现别处也得改 / 查不到的（⚠ 标题第一版写的是"只报告，没有改" —— 返工后 8.3 是**已执行**的 F3）

### 8.1 要挂载它，必须动一个已存在的文件（本单不许改，故**未改**）

`<HOME>\.dsh\profiles\web\cordis.patch.yml` 里现有的 `insert:` 块下面加一行：

```yaml
    - id: role-voices
      name: <WORKSPACE>/task-warden/plugin/role-voices.js
```

- 加在**同一个** `insert:` 列表里即可（那一块已经有 `warden-watch` / `group-chat-host`）。
- ⚠ 该文件自己第 7-11 行写着实测结论：**`patchReload: live` 不会重载模块代码**。
  改这个 patch 文件本身是 live 的（增删 insert 行立即生效），但**改插件代码必须重启 DSH**。
- **本单没有碰这个文件**（它是"已存在的文件"，硬规矩第 1 条禁止）。

### 8.2 没查到的东西（明确写"没查到"，写清卡在哪一步）

1. **`ctx.loader.internal` 的实现没查到。**
   `cordis-plugin-loader\lib\index.js:274` 会走 `this.ctx.loader.internal.import(name, baseUrl, {})`，
   但我在 `@deepseek-ai/dsh/node_modules/@deepseek-ai/*/lib/*.js` 全树里搜
   `loader.internal\s*=` **零命中**，搜 `internal:` 赋值也只有无关命中。
   卡在：不知道它是谁设的，因此**无法离线验证** ESM 语法的 `.js` 能不能过它。
   → 这正是第 4.3 节选 CJS 的直接原因（有证据的那个）。
2. **没有实测"挂上去之后真的收到事件"。**
   卡在硬规矩第 1 条：验证这件事**必须**改 `cordis.patch.yml`（或重启 DSH），两样都禁止。
   所以本单的证据强度是：**事件名/字段/派发方式全部读源码核对过**，
   + **插件逻辑用假 ctx 端到端跑过**，
   但**"在真 DSH 里挂载并收到真子代理的结束事件"这一步没有做**。
   这一步留给能改 patch 文件的那一单（一行，见 8.1）。
3. **`agent.label` / `agent.meta.label` 是否存在，没查到。**
   `dsh-tool-subagent` 把 `args.description` 传给了 `jobs.start({label})` /
   `subagents.startContinuable({label})`（`:510,529,540`），但**没有**放进 `agents.create()` 的 meta。
   所以我在 `roleName()` 里把它们**当候选试**（存在就用，不存在就跳过），
   真正有证据的那一条是 `subagent/descriptor.label`。
4. **没查到 `README.md` 会不会被别的工具当成上下文读进去。**
   本插件自己不读它、也不注入它。若将来有别的插件去扫工程里的 `.md`，那是另一件事，
   需要在那一侧设闸 —— 本单范围外，只登记。

### 8.3 `<WORKSPACE>\task-warden\角色发言\` 的现状（R42 返工后）

**这一节在第一版里写的是"只报告、没有改"；返工改了 `INDEX.md` 一个文件，所以如实改写。**

本机事实（返工后实测）：

- `<WORKSPACE>\task-warden\角色发言\` 在 **2026-09-24 19:37** 已经存在（**早于本单开工**）。
- 里面是**手工归档的存量**：`2026-09-24\` 子目录 = **69 份** `2026-09-24_<短id>_<提示词首行>.md`
  （整份会话日志，不是"最后一条助手消息"），外加一份 `2026-09-24\INDEX-存量.md`（原格式索引的存档）。
- `INDEX.md` **已经是一份统一表格**（不是第一版说的"项目符号列表"—— 那句话当时就过期了，
  现在按实测改写）：两段，都是 `| 时间 | 角色 | 标题 | 字节 | 文件 |` 表头。

**R42 返工对这个文件做了什么**（这是本单**唯一**动过的已存在文件）：

| 动作 | 之前 | 之后 |
| --- | --- | --- |
| 段序 | ① 自动归档（第 7 行）→ ② 手工存量（第 22 行） | ① 手工存量（第 12 行）→ ② 自动归档（第 100 行） |
| 「时间」列 | 69 行全是 `2026-09-24`（从**文件名**取，文件名只有日期） | 69 行是**每份文件 `| 开始 |` 行**的精确到秒时间（例 `2026-09-24 19:20:57`）；69/69 取到，0 行缺失 |
| 末行 | 第 107 行 = 一条数据行（追加会掉在表外） | 第 111 行 = **表头分隔线**（追加自然落在自动段表里） |
| 69 行数据 | — | **除「时间」格以外的字节逐行相同**（脚本逐行核对：0 行差异）；**69 份日志本身 sha256 变化数 = 0** |

**没有动的**：`2026-09-24\` 下 69 份日志 + `INDEX-存量.md` 一个字节都没碰；
`README.md` 也没建（插件是懒建的，本单没有在真工程里跑过插件）。

**仍然存在的"两套东西不一致"**（人决定，本单不替人定）：

| 维度 | 存量（手工） | 本插件（自动） |
| --- | --- | --- |
| 粒度 | 整份会话日志（含提示词、工具调用） | **最后一条助手消息的正文**（逐字） |
| 目录 | `<角色发言>\2026-09-24\` 子目录 | `<角色发言>\` 根 |
| 文件名 | `2026-09-24_<短id>_<提示词首行>.md` | `YYYY-MM-DD_HHMMSS__<角色>__<短标题>.md` |
| 段 | `INDEX.md` 的 ① 手工存量段 | `INDEX.md` 的 ② 自动归档段（**在最后**，见 5.1.1） |

### 8.4 ⚠ 只报告：F3 的约定是**文件侧**的，代码抓不住"段序被改回去"

插件代码里**没有任何一处**知道"哪一段是自动段"。自检 ⑮ 会在**夹具**层面盯住
"新行必须落在最后一段的表里"，但它**抓不住真 `INDEX.md` 被谁改回原来的段序** ——
那时 F3 会原样复发（新行掉到 69 行手工存量下面）。

**这一条本单没有做成代码闸**（也不该在插件的写入路径上加"找段插入"：
那要把 `appendFileSync` 换成读全文+重写全文，每次归档重写整个 INDEX，风险更大，见 5.1.1）。
**登记在此，交给下一单**：可选做法是在 `warden.mjs check`（或 `role scan` 之类已有的只读命令）
里加一条**只读**断言：「`INDEX.md` 里 `## ② 自动归档` 的行号 > `## ① 手工存量` 的行号，
且文件最后一个非空行是表头分隔线」。⚠ 那是 `warden.mjs`，**本单不许改**。

---

## 9. 本单的边界（自我约束）

**第一版是"只新建 3 个文件、没有改任何已存在的文件"。返工**（审查判决 `bad`）**破了一次例，
只有一个文件，且已在下面逐条列清。**

- **改了 3 个文件**（都在授权清单内）：`plugin\role-voices.js`、`plugin\role-voices.selftest.mjs`、
  `plugin\role-voices.DESIGN.md`。
- **改了 1 个已存在的文件**：`<WORKSPACE>\task-warden\角色发言\INDEX.md`
  （**F3 段序对调 + 「时间」列精确到秒**，见 5.1.1 / 8.3；**69 行数据除时间格外逐字节未改**）。
  ⚠ **只改了这一个**索引文件 —— 授权清单里写的就是"只改这一个索引文件"。
- **没有改的**（逐个点名）：`warden.mjs`（**F2 只报告，见第 11 节**）、`cordis.patch.yml`、
  `warden-watch.js`、`plugin\` 下任何别的文件、`preset-roles\`、`experiments\lab\`、
  `.warden\`（真账本 `<WORKSPACE>\.warden`）、以及 `角色发言\2026-09-24\` 下的
  **69 份日志 + `INDEX-存量.md`**（sha256 变化数 = 0）。
- **没有用"加提示词"解决任何问题**：本单的实现只有 **hook（`ctx.on`）+ 声明（config/文件布局）+ exit code（自检）**。
  `README.md` 是给**人**看的说明，它**不进任何上下文**（插件里没有任何注入路径）。
- **测东西全在 `%TEMP%`**（`role-voices-lab` 夹具 + `rv-f3-real` 的真 INDEX 副本），
  真文件只在**写最终结果**时被写一次。
- **发现还要改别的文件** ⇒ 停下来只报告，没去改（F2 的 `warden.mjs`，见第 11 节）。

---

## 10. 自检怎么跑

```powershell
node <WORKSPACE>\task-warden\plugin\role-voices.selftest.mjs          # exit 0 = 全过，1 = 有红
node <WORKSPACE>\task-warden\plugin\role-voices.selftest.mjs --keep   # 保留夹具，供 Get-ChildItem -Recurse 看
```

**99 条断言，PASS 99 / FAIL 0，exit 0**（返工前是 70 条）。正控 / 负控成对。覆盖：
归档真的发生 · 文件名与内容符合约定 · **逐字性（sha256 相同）** · **主会话不归档** ·
**★ 只吃子代理自己的事件（⑭：fork 负控 + 正控 + 下界拿不到 ⑭c）** ·
**去重** · **INDEX 字段对** · **不进上下文（列出全部注册项）** ·
**可逆（⑦ 贴摘除前后列表 + ⑦b 夹具反控证明不是假绿）** ·
**失败如实（工程根推不出 / 没有 text 块 / 下界拿不到）** · **正控：没有子代理 ⇒ 一个文件都不建** ·
同秒重名不覆盖 · 标题规则（40 字 / 非法字符 / emoji 不被劈） · 工程根三条路 ·
**已有别人格式的 INDEX.md ⇒ 只追加分节、不改写已有内容（含"重启后不重复插分节"）** ·
**★ ⑮ 统一索引两段同表头 ⇒ 末尾追加必须落在最后一段的表里**。

### 10.1 ⚠ F4/F5：⑦ 那两条断言以前是**假绿**（改的是夹具，不是断言）

旧夹具的 `dispose()` 无条件 `listeners.length = 0` / `effects.length = 0`：

```js
dispose() {
  for (const e of effects.slice().reverse()) e.dispose()
  effects.length = 0                        // ← 不管插件摘没摘，这里都清空
  for (const l of listeners.slice()) { …splice… }   // ← 同上
}
```

⇒ `eq('⑦ dispose 后监听器全摘掉', after.length, 0)` 与
`eq('⑦ dispose 后 effects 也空了', ctxA.effects.length, 0)`
**即使插件什么都不注册、什么都不摘也会 PASS** —— 它们**证明不了可逆性**。

**改法**：假 ctx 的 `dispose()` 改成**只调"注册时交回来的那些 disposer"**（逆序），
**绝不**自己顺手清空两个数组。依据：真 Cordis 里 `ctx.on` 返回的**就是**那个 fiber effect 的
disposer（`cordis\lib\index.js:335-345` 的 `register()` → `this.ctx.fiber.effect(...)`）。

**断言一个字都没有放宽**；改完后那两条**仍然 PASS**（⇒ 说明插件的可逆性本身是真的，
不是夹具替它绿的；审查的独立夹具也证过这一点）。

**再加一条反控（⑦b）**，把"假绿"当场演示出来：往假 ctx 里塞一条
"登记了却没交回 disposer"的旁路记录，然后分别用**旧实现**和**新夹具**跑 `dispose()`：

```
[证据 ⑦b] 新夹具 dispose 日志：[["on:agent/turn-stopping",true]]
⑦b 旧夹具（无条件清空）⇒ 旁路那条也被"清掉"了 —— 这就是假绿        PASS
⑦b 新夹具只调交回来的 disposer ⇒ 旁路那条**留了下来**（假绿已消除）  PASS
```

### 10.2 返工后的原样输出（关键几段）

```
[证据 ⑦] dispose 前监听器：["agent/turn-stopping","agent/status","agent/error","agent/disposed"]
[证据 ⑦] dispose 后监听器：[]
[证据 ⑦] dispose 真正调用过的 disposer：[["on:agent/disposed",true],["on:agent/error",true],["on:agent/status",true],["on:agent/turn-stopping",true],["effect:role-voices.dispose-hooks",null]]

[证据 ⑭] 夹具：seq=5  inheritedEventCount=3  前缀 = seq 0..2（seq 1 是主代理的 assistant/message），子代理自己 = seq 3..4
[证据 ⑭] 旧口径（从 total-1 扫到 0）命中：{"seq":1,"text":"★这是主代理（父会话）说的话，不是子代理说的★"}
[证据 ⑭] 新口径（下界 = inheritedEventCount = 3）命中：null
[证据 ⑭] 新口径算出的下界：{"ok":true,"from":3,"total":5}
[证据 ⑭ 负控] 归档文件数: 0   归档正文: "(没有归档文件)"
[证据 ⑭ 负控] 新增失败记录: 1  {"reason":"no-assistant-message","detail":"这个子代理**自己那段事件**（seq 3..4）里没有任何 content 非空的 assistant/message（前面 seq 0..2 是被继承的父会话前缀，不算它的发言）",…}
[证据 ⑭ 正控] 归档文件: ["2026-09-24_190305__审查__★这是子代理自己说的★.md"]
[证据 ⑭ 正控] 归档正文原样: "★这是子代理自己说的★"
[证据 ⑭ 正控] 正文 === 子代理自己那句话 ? true
[证据 ⑭ 正控] 正文 === 主代理那句话 ? false
[证据 ⑭ 正控] 头部：["- 子代理自己的事件: seq 3..5（inheritedEventCount=3；更小的 seq 是被继承的父会话前缀，不是它的发言）","- 助手消息: assistant/message @ seq 4（time=…）"]
[证据 ⑭c] 下界拿不到时 ownEventRange = {"ok":false,"reason":"own-bound-unknown","detail":"session.inheritedEventCount 拿不到（undefined）…"}
[证据 ⑭c] 归档文件数: 0   失败记录: {"reason":"own-bound-unknown",…}

[证据 ⑮] 段序：自动段标题在第 10 行（手工段在前）；共 15 行
[证据 ⑮] 两个表头分隔线在第 [6,13] 行；最后一个在第 13 行
[证据 ⑮] 自动归档新行落在第 14 行
[证据 ⑮] 分节标记出现次数: 0

合计：99 条断言，PASS 99，FAIL 0
```

---

## 11. ★ F2（**本单不做，只报告**）：`warden.mjs init` 不建 `角色发言\`

SPEC R42 的必须②逐字是「**`warden.mjs init` 与插件都要能建**」。
但现在 `ensureSkeleton`（`<HOME>\.dsh\skills\task-warden\warden.mjs:418-444`）
**只建 `.warden\` 下那 5 个文件**，不建 `<工程根>\角色发言\`。

**为什么本单不做**：`warden.mjs` 正在被另一单（P-M19）改，本单碰它会撞车。

**可执行规格（交给下一单）** —— 要改的行与改法：

1. **新增一个函数**（放在 `ensureSkeleton` 旁边，约 `warden.mjs:444` 之后），
   逐字照抄 `role-voices.js` 的 `findProjectRootVia` 口径**只用它已经算出来的 `root`**，
   不要重新推根（`init` 里已经有 root）：

   ```js
   /** R42 必须②：init 也要能建 <工程根>\角色发言\（与插件同一份目录名常量）。 */
   const ROLE_VOICES_DIR = '角色发言'
   function ensureRoleVoicesDir(root) {
     const dir = path.join(root, ROLE_VOICES_DIR)
     fs.mkdirSync(dir, { recursive: true })
     return dir
   }
   ```

2. **在 `ensureSkeleton` 的末尾（`:444` 那一行之前/之后）加一行调用**，
   并把结果如实打印进 `init` 的输出（现在 `init` 会打印它建了什么）：

   ```js
   const roleVoicesDir = ensureRoleVoicesDir(root)      // ← 新增
   ```

   `root` 用 `ensureSkeleton` 已经在用的那个工程根变量（**别用 `process.cwd()`** ——
   第 8.2 节那条"在错误的目录上建文件夹"的坑就是这个）。

3. **`check` 里的对应项**：`SPEC.md` 的必须②如果被 `check` 逐条核，就要加一条
   「`<工程根>\角色发言\` 存在（或"插件可建"已被证明）」—— ⚠ **本单没有读 `check` 的
   R42 断言是怎么写的**，所以**这一步只登记、不给行号**（没查到，见第 12 节）。

⚠ **本单没有改 `warden.mjs`**：上面只有规格，没有执行。

---

## 12. 查不到的（返工新增）

1. **`warden.mjs check` 里 R42「必须②」那条断言具体写在哪一行、怎么判 —— 没查到。**
   卡在：本单授权清单禁止改 `warden.mjs`，我也**没有去通读它**（那是 P-M19 的在改文件，
   通读容易把"我以为的行号"写进文档，反而制造 A7 那类过期事实）。
   所以第 11 节第 3 步只给了规格、**没给行号**。
2. **没有实测"在真 DSH 里挂载并收到真子代理的结束事件"**（与第一版同）。
   卡在：要验证必须改 `cordis.patch.yml`（或重启 DSH），两者都不在授权清单里。
   返工后新增的证据强度是：**fork 形状的会话夹具端到端跑过**
   （⑭ 负控/正控 + ⑭c），但**真 DSH 里的真 fork 子代理**这一步仍然没做。
