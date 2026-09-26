'use strict'
/*
 * report-spill —— 子代理回给主代理的**长报告**落盘，只把「头 + 尾 + 文件路径」放回上下文。
 *
 * 为什么要有这个文件（用户原话，逐字）：「（用户原话已隐去 —— 公开版不留逐字）」
 *   「**立即进行，并让每个窗口都是如此。**」
 * 背景读数（用户给的）：上下文已用 79%（~790K / 1M）；面板三行 =
 *   系统提示词 ~4.7K · 工具定义 ~9.7K · **对话消息 ~450K**。
 * ⇒ 要治的是「对话消息」。其中**最肥、最重复的一类 = 子代理回给主代理的长报告**。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ R26 返工（2026-09-24）—— 上一版"一次都不会触发"，这一版修的就是这个
 * ════════════════════════════════════════════════════════════════════════════
 * 审查的判决（逐字，本单的锚）：
 *   「①`SUBAGENT_TOOLS` 漏了本部署默认 preset 的三个真实名字 … 端到端实测全部
 *     `not-subagent-tool`、0 个新文件；②就算名字对上也不触发：四个 enabled 行都是
 *     `backgroundMode: continuable`，`dsh-tool-subagent\lib\index.js:360` 逐字
 *     `runInBackground = request.run_in_background ?? options.continuable`，`:486`
 *     后台渲染成 `started subagent ${id}` —— 工具结果原样就是 `started subagent <uuid>`
 *     （**52 字符** << 6000）；正文走的是 `dsh-subagent\lib\index.js:675
 *     kind:"subagent-settled"` 的**通知**，本插件没挂那条通道。」
 *
 * 两条修法（**都在这一版里**）：
 *   ① 名字补齐 —— `SUBAGENT_TOOLS` 从 4 个 → **7 个**（逐字抄本部署默认 preset 里**所有** `toolName:` 的值）。
 *   ② **挂上真正会响的那条通道** —— `ctx.on('agent/pre-step', …)`（waterfall），
 *      它拿到的 `payload.messages` 里就有那条 `source.kind === 'subagent-settled'`
 *      的结算通知；**换掉它的正文块**就换掉了主代理真正收到的东西。
 *      证据链见下面「两条通道」一节，逐条带 `文件:行号`。
 *
 * ── 它到底做什么（两条通道，同一条落盘代码路径）────────────────────────────
 *
 *   【通道 A】`tools/post-execute`（先例：`dsh-spill-policy\lib\index.js:155`）
 *     waterfall：`handler(exec, result, next)`；**必须 `await next()`**
 *     （`dsh-tools\lib\index.js:3378`）。命中的是**工具结果本身就装着报告**的那种调用：
 *       · 子代理工具 + `run_in_background: false` ⇒ `dsh-tool-subagent\lib\index.js:557`
 *         走 `subagents.start()`（one-shot 前台），工具结果 = 全文；
 *       · `workflow` / `ralph` ⇒ 它们自己的 `render` 就是
 *         `[{type:'text', text: renderResult(...)}]`（`dsh-tool-workflow\lib\index.js:226-229`、
 *         `dsh-tool-ralph\lib\index.js:320-323`），整份结果都在工具结果里。
 *
 *   【通道 B】`agent/pre-step`（★ 本单新增，**默认后台模式唯一会响的那条**）
 *     `dsh-agent\lib\types\runtime-types.d.ts:313-319` 逐字是 waterfall：
 *       `'agent/pre-step'(payload:{agent,messages,turn,step,signal}, next) => Promise<PreStepDecision>`
 *     文档逐字：「Reject a proposed step or **replace the messages that enter it**.」
 *     派发点 `dsh-agent-loop\lib\index.js:894-901`：
 *       `const decision = await this.dispatch.waterfall("agent/pre-step", {messages: claimed, ...}, () => Promise.resolve({kind:'enter', messages: …}))`
 *     ★ **这一层是"真的改得动"的关键**：进入这一步的消息**才**被写进会话日志 ——
 *       `dsh-agent-loop\lib\index.js:1028` 逐字
 *       `if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", message, { surfaceOp: "append" })`。
 *       ⇒ 我们在 pre-step 换掉的字节，就是**落在盘上、也是模型真正看到的那一份**（不是"显示层"的改写）。
 *
 *     那条结算通知本身：`dsh-subagent\lib\index.js:1244-1259` 的 `notifySettlement()`
 *     → `createSettlementMessage()`（`:661-681`）→ 内容逐字是
 *       `[{type:'text',text:<summary>}, {type:'text',text:'Its closing message:'}, ...terminal.output]`
 *     （没有 output 时第二块是 `'It left no closing message.'`），
 *     `source` 逐字 `{kind:'subagent-settled', form:'notice', summary, senderSessionId: childId}`。
 *     `terminal.output` 就是子代理**最后一条 content 非空的 `assistant/message`**
 *     （`dsh-subagent\lib\index.js:158-221` 的 `AssistantOutputFold`）——
 *     **与 R42（role-voices）读的是同一份文本**（它读 `lastAssistantMessage`）。
 *
 * ── 与 R42（role-voices.js）的关系 ─────────────────────────────────────────
 *   **同一个文件夹，同名不同物**（文件名第二段、分隔线措辞、头部首行三处不同）。
 *   ⚠ 读取口径**复用 role-voices 的形状**（`textOf`/`blockSummary`/`ownEventRange` 那套判据），
 *     但**触发通道必须不同**：role-voices 挂的是**子代理自己的结束事件**
 *     （`agent/turn-stopping` / `agent/status` / `agent/error` / `agent/disposed`），
 *     它只能**看到**那段文本、**改不动**主代理收到的东西；本插件要的是"换回去"，
 *     所以挂在**父代理侧的 `agent/pre-step`** 上。⇒ 复用形状，不复用挂点。
 *
 * ── 硬约束（每条都有机检判据，见 report-spill.selftest.mjs）────────────────
 *   · **不许丢信息**：正文逐字节在盘上；自检断言 `extractBody(文件) === 原始文本` 且 sha256 相同。
 *   · **可逆**：`ctx.on` 的 disposer 收进 `disposers`，`ctx.effect` 再兜一层。
 *   · **fail-open**：落盘失败 ⇒ **原样放行** + 记一行。宁可上下文大，也**不许**让一次工具调用失败。
 *   · **零上下文注入**：对 ctx 只调用 `on` / `effect` / `logger` 三样。
 *     （它改的是**消息的字节**与**工具结果的字节**，不是提示词。用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」。）
 *   · **不碰 `.warden\`**（那是账本）：只写 `角色发言\`；失败台账写在 `os.tmpdir()`。
 *   · **`角色发言\` 有界**：写完就按 `keepReports` 轮转，**只删本插件自己的报告文件**
 *     （文件名正则严判），绝不碰 role-voices 的归档、绝不碰用户的手工存量、绝不碰子目录。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

// ────────────────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────────────────

/** ★ 刻意复用 R42 的 `角色发言\` —— 用户"点进去读"只有一个地方。 */
const DIR_NAME = '角色发言'
/** 文件名里的第二段：`…__报告__<第三段>.md`。**R42 那一段是角色名**，这就是区分点之一。 */
const FILE_TAG = '报告'

/** 换回去时保留的**头**字符数（用户逐字要求：`<前 1200 字符>`）。 */
const HEAD_CHARS = 1200
/** 换回去时保留的**尾**字符数（用户逐字要求：`<后 600 字符>`）。 */
const TAIL_CHARS = 600
/**
 * 触发阈值：正文**超过**这么多字符才落盘（默认 4000）。
 *
 * ★ 这个值是本单**重新定**的（上一版 6000 的推理建立在"工具结果通道"上，
 *   而那条通道在默认后台模式下一次都不会响 —— 定它没意义）。新依据是**量出来的**：
 *
 *   · 换回去的固定开销 = 通知行（含路径，~210 字符）+ 头 1200 + 尾 600 ≈ **2010 字符**。
 *   · 口径：**净省 ≥ 一份固定开销**才算划算 ⇒ 阈值 ≈ 2 × 2010 ≈ **4000**。
 *   · 实测分布（口径逐字写在下一条）：323 份真实结算通知的正文
 *     p50 = 2389 · p75 = 6110 · p90 = 9086 · max = 34798 字符。
 *     阈值 4000 ⇒ 触发 **123/323**（38%），合计省 **750,029** 字符；
 *     降到 3000 只多省 38,515（多 26 份，平均 1481/份 < 固定开销）⇒ **4000 就是拐点**。
 *   · 官方那条线在 8192（`dsh-base\cordis.patch.yml` 的 `tool-result-pruner`
 *     `thresholdChars: 8192`）—— 但那条只吃**工具结果**，**不吃结算通知**（通知是 user 消息）。
 *     ⇒ 通知这条通道**官方没有任何机制覆盖**，本插件是唯一的；4000 比 8192 早一步是有意的。
 *
 * ⚠ 实测口径（可复跑）：`<DSH_HOME>\sessions\**\session.v3.jsonl.zstd` 逐帧 zstd 解，
 *   取 `type === 'user/message' && data.source.kind === 'subagent-settled'`；
 *   正文 = `data.content` 里**第 2 个 text 块之后**的全部 text 块逐字相接（口径与 noticeReport 一致）。
 *   样本：374 个会话文件 / 323 份通知（2026-09-24 读数）。
 */
const DEFAULT_MAX_CHARS = 4000
/** 覆盖阈值的环境变量名。 */
const ENV_MAX_CHARS = 'DSH_REPORT_SPILL_MAX_CHARS'
/** 总开关环境变量：`1`/`true`/`on` ⇒ 本插件一次都不落盘（等于停用，但监听器还在，可观测）。 */
const ENV_OFF = 'DSH_REPORT_SPILL_OFF'

/**
 * ★ `角色发言\` 的上限：**最多保留最新的这么多份报告**（本插件自己的报告文件）。
 *
 * 为什么必须有：审查判「现在是只增不减（0 处删除/轮转）」—— 一个只涨不落的目录迟早失控。
 * 为什么是 200：
 *   · 实测口径同上：全部 374 份会话归档里，**会被 4000 阈值命中的报告一共 123 份** ⇒
 *     200 给"现有全部历史 + 之后一段时间的增量"留了余量，不会一上线就开删。
 *   · 体积：p75 正文 6110 字符 ≈ 8 KB/份（含头部）⇒ 200 份 ≈ **1.6 MB**，可以忽略。
 *   · 它**只删本插件自己写的报告文件**（`REPORT_FILE_RE` 严判名字），
 *     role-voices 的 `__<角色名>__` 归档、用户的 69 份手工存量、`INDEX.md`/`README.md`、
 *     以及任何子目录（例如 `角色发言\2026-09-24\`）**一个都不碰**。
 *   · 本插件**不写 INDEX.md / README.md**（那是 role-voices 的产物），所以轮转也不需要维护索引。
 */
const DEFAULT_KEEP_REPORTS = 200
/** 覆盖保留份数的环境变量名。 */
const ENV_KEEP_REPORTS = 'DSH_REPORT_SPILL_KEEP'

/** 失败台账的文件名（写在 `os.tmpdir()`，**不在工程里**，更不在 `.warden\`）。 */
const FAIL_NAME = 'report-spill-failures.jsonl'

/**
 * ★ **子代理工具名 —— 核过的，不是猜的（本单补齐）。**
 *
 * 核法（可复跑，**列的是本部署默认 preset 里所有 `toolName:` 的值**，一个不漏）：
 *   `settings.yaml` 里 `agent-presets: default: roles` 指到的那份角色 preset：
 *     `:232  toolName: subagent`
 *     `:244  toolName: subagent_liaison`      ← ★ 上一版漏的
 *     `:262  toolName: subagent_direction`    ← ★ 上一版漏的
 *     `:297  toolName: subagent_coder`        ← ★ 上一版漏的
 *     `:324  toolName: subagent_fork`
 *     `:334  toolName: subagent_codex`        （该行 `disabled: true`）
 *     `:343  toolName: subagent_claude_code`  （该行 `disabled: true`）
 *   ⇒ **7 个**。disabled 的两行名字同族、同一份 `dsh-tool-subagent` 产生 ⇒ 一起收进来，
 *     将来启用不必再改这个文件。
 *
 * ⚠ **这是与框架的耦合**：本部署默认 preset 换了名字，这里就得跟着改。
 *   漂了**不会静默** —— 自检 ③ 逐条钉死这 7 个名字，且 ⑳ 会拿真 preset 文件来对拍（读不到就红）。
 */
const SUBAGENT_TOOLS = [
  'subagent',
  'subagent_liaison',
  'subagent_direction',
  'subagent_coder',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
]

/**
 * ★ **编排器工具**（本单收进来的）—— 它们的工具结果**整份就是报告**。
 *
 * 形状核过的（不是猜的）：
 *   `dsh-tool-workflow\lib\index.js:226-229` 逐字
 *     `render: (args, value) => [{ type: "text", text: renderResult(args.meta.name, value.agentsStarted, value.result, maxResultChars) }]`
 *   `dsh-tool-ralph\lib\index.js:320-323` 逐字
 *     `render: (_args, value) => [{ type: "text", text: renderResult(value.result, resolved.maxResultChars) }]`
 *   ⇒ 工具结果 = `[{type:'text'}]`，正是 `flattenPlainText` 认得的那种。
 *   它们自己的截断上限：workflow `maxResultChars: 5e4`（`dsh-tool-workflow\lib\index.js:23`）、
 *   ralph `maxResultChars: 16384`（`dsh-tool-ralph\lib\index.js:22`）——
 *   在**官方那条 50000 字节的 spill-policy 线之下**，所以官方机制基本不会替它们落盘；
 *   本插件按 4000 收，正是审查点名的「今天唯一能越过 6000 的是 workflow(≤5e4)/ralph(≤16384)」。
 */
const ORCHESTRATOR_TOOLS = ['workflow', 'ralph']

/** 通道 A 的命中集合（工具结果通道）。 */
const SPILL_TOOLS = SUBAGENT_TOOLS.concat(ORCHESTRATOR_TOOLS)
const SPILL_TOOL_SET = new Set(SPILL_TOOLS)

/**
 * ★ 通道 B 认的那条通知：`source.kind`。逐字来自
 *   `dsh-subagent\lib\index.js:675` / `lib\types\continuation-messages.js:95`：
 *   `source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: childId }`
 */
const NOTICE_SOURCE_KIND = 'subagent-settled'
/**
 * 结算通知里"正文开始"那一块的逐字文案（块 1）。逐字来自
 *   `dsh-subagent\lib\index.js:667-673`（无 output 时是 `:669` 那一支）：
 *     `{ type: "text", text: "Its closing message:" }` / `{ type: "text", text: "It left no closing message." }`
 * ⚠ 这也是与框架的耦合；**认不出来就不动**（`unknown-marker` 记一行），绝不猜。
 */
const NOTICE_MARKER_CLOSING = 'Its closing message:'
const NOTICE_MARKER_NONE = 'It left no closing message.'

/**
 * 正文分隔线。**这一行的下一字节起就是报告原文**，一个字节都没有被改过。
 *
 * ⚠ 措辞与 `role-voices.js` 的 `BODY_SEP` **故意不同** —— 这是把两类文件
 *   分开的机械判据之一。**改这一行等于改判据**，自检会跟着红。
 */
const BODY_SEP = '--- 报告逐字正文开始（以下与子代理回给主代理的结果文本逐字节相同：未润色 / 未截断 / 未总结 / 未重排） ---'

/** 换回去那行通知的**逐字形状**（用户点名的格式，不许改写）。 */
const NOTICE_HEAD = '[完整报告 '
const NOTICE_MID = ' 字符已落盘（原文逐字节在盘上）：'
const NOTICE_TAIL = ']'
/** 省略标记的逐字形状。 */
const OMIT_HEAD = '…（中间省略 '
const OMIT_TAIL = ' 字符）…'

/** 同一个 `callId` 的重放缓存上限（防止 Map 无限长）。 */
const CALLID_CACHE_MAX = 1024

/**
 * ★ **本插件自己的报告文件名** —— 轮转只删匹配这一条的名字。
 *   形状：`YYYY-MM-DD_HHMMSS__报告__<第三段>.md`（第三段 = 工具名 或 子代理短 id），
 *   撞名退 `-2` / `-3`。**严判**：多一个字符都不删。
 */
const REPORT_FILE_RE = /^\d{4}-\d{2}-\d{2}_\d{6}__报告__[^\\/:*?"<>|]*\.md$/

// ────────────────────────────────────────────────────────────────────────────
// 纯函数区（自检直接调这些，跑的是同一条代码路径）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 工程根判法 —— 与 `role-voices.js` 的 `findProjectRootVia`（它又是照抄
 * `warden.mjs:195-213`）**同一条约定**，本文件是**第二份实现**：
 *   1. 从 start 往上，第一个有 `.git` 的目录 ⇒ `{root, via:'git', found:'git'}`；
 *   2. 一路没有 `.git`，退而取**最近的**装着 `.warden` 的那一层
 *      ⇒ 那一层就是 start 自己时 `via:'self'`，否则 `via:'ancestor-warden'`；`found:'warden'`；
 *   3. 都没有 ⇒ `{root: start, via:'self', found: null}`。
 *
 * ⚠ **为什么照抄而不是 require 过来**：`role-voices.js` 是个**插件模块**，
 *   `require` 它会连带执行它的顶层（并暴露 `_internals`）；插件之间互相 require
 *   会把"谁挂谁"变成隐式依赖，一处加载失败就连带另一处静默失效。
 *   ⇒ 代价是**两份实现会漂**。这是**已知风险**，写进 DESIGN.md，不藏。
 *   自检里有一条**对拍**断言（⑱）：同一个夹具下，本文件与 role-voices 的
 *   `_internals.findProjectRootVia` 结果必须逐字段相同（漂了就红）。
 */
function findProjectRootVia(start) {
  const abs = path.resolve(String(start))
  let d = abs
  let wardenOwner = null
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return { root: d, via: 'git', found: 'git' }
    if (!wardenOwner && fs.existsSync(path.join(d, '.warden'))) wardenOwner = d
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  if (wardenOwner) {
    return {
      root: wardenOwner,
      via: path.resolve(wardenOwner) === abs ? 'self' : 'ancestor-warden',
      found: 'warden',
    }
  }
  return { root: abs, via: 'self', found: null }
}

/**
 * 把一段文字洗成能进文件名的形状。**只做"非法字符"这一件事**：
 * 控制字符 → 空格；Windows 非法字符 `\ / : * ? " < > |` → 删掉；
 * 空白串 → 单个 `_`；去掉开头的 `.`/`_` 与结尾的 `.`；按**码点**截到 max。
 * 不换词、不改写、不加省略号。（口径与 role-voices 的同名函数一致。）
 */
function sanitizeSegment(s, max) {
  let out = String(s === null || s === undefined ? '' : s)
  out = out.replace(/[\u0000-\u001f\u007f]/g, ' ')
  out = out.replace(/[\\/:*?"<>|]/g, '')
  out = out.replace(/\s+/g, '_')
  out = out.replace(/^[._]+/, '')
  out = out.replace(/\.+$/, '')
  const chars = Array.from(out)
  if (chars.length > max) out = chars.slice(0, max).join('')
  return out.replace(/[._]+$/, '')
}

/** 会话 id 的短尾巴（`session-ccc30000-…-000000000000` → `00000000`）。口径同 role-voices。 */
function shortId(id) {
  const s = String(id || '')
  const m = /([0-9a-fA-F]{8})\s*$/.exec(s)
  if (m) return m[1]
  const tail = s.replace(/[^0-9A-Za-z]/g, '')
  return tail.slice(-8) || 'unknown'
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 本地时间 `YYYY-MM-DD_HHMMSS`（文件名用）。 */
function formatStamp(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
}

/** 本地时间 `YYYY-MM-DD HH:MM:SS`（给人看）。 */
function formatHuman(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * **码点长度**。为什么不用 `String.length`：那是 UTF-16 码元数，
 * 一个 emoji（代理对）会被算成 2。用户说的"字符"= 人眼看到的一个字，
 * 也就是**码点**。⇒ 本插件的 N / M / 阈值口径**统一是码点**。
 * 不分配数组（大报告 450K 字符也不会造一个 450K 的数组）。
 */
function cpLength(s) {
  const str = String(s)
  let n = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

/** 从头取 count 个**码点**（不会把一个代理对劈成半个）。 */
function cpSliceHead(s, count) {
  const str = String(s)
  if (count <= 0) return ''
  let i = 0
  let n = 0
  while (i < str.length && n < count) {
    const c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    i++
    n++
  }
  return str.slice(0, i)
}

/** 从尾取 count 个**码点**（从后往前走，不整篇分配）。 */
function cpSliceTail(s, count) {
  const str = String(s)
  if (count <= 0) return ''
  let i = str.length
  let n = 0
  while (i > 0 && n < count) {
    i--
    const c = str.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
      const p = str.charCodeAt(i - 1)
      if (p >= 0xd800 && p <= 0xdbff) i--
    }
    n++
  }
  return str.slice(i)
}

/**
 * 全 text 块压成一个字符串；**只要有一个非 text 块就返回 `undefined`**。
 * 口径与 `dsh-spill-policy\lib\index.js` 的 `flattenPlainText` 逐字一致：
 * 通道 A 只懂"最终格式化文本"，不懂工具内部 ⇒ 混了别的东西就不碰。
 */
function flattenPlainText(content) {
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return undefined
    text += block.text
  }
  return text
}

/**
 * 内容块里所有 `{type:'text'}` 的 `text` **原样首尾相接**（不插分隔符、不 trim）。
 * 口径**照抄 role-voices 的 `textOf`**（R42 的读取形状）。
 */
function textOfBlocks(content) {
  let out = ''
  if (!Array.isArray(content)) return out
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text
  }
  return out
}

/** 内容块构成，例如 `text×2, reasoning×1`（头部如实披露）。口径同 role-voices 的 `blockSummary`。 */
function blockSummary(content) {
  if (!Array.isArray(content) || content.length === 0) return '(空)'
  const counts = new Map()
  for (const b of content) {
    const t = b && typeof b.type === 'string' && b.type !== '' ? b.type : 'unknown'
    counts.set(t, (counts.get(t) || 0) + 1)
  }
  return Array.from(counts.entries()).map(([t, n]) => t + '×' + n).join(', ')
}

/**
 * ★★ **通道 B 的解析器（纯函数，零 IO）**：从一条结算通知的 `content` 里取出"报告正文"。
 *
 * 通知的形状（`dsh-subagent\lib\index.js:661-681` 逐字）：
 *   `[ {text:<summary>}, {text:'Its closing message:'}, ...terminal.output ]`
 *   `terminal.output` = 子代理最后一条 content 非空的 `assistant/message` 的 content
 *   ⇒ 里面可能夹着 `reasoning` / `tool-call` 块（**实测 323 份通知里 154 份有 reasoning 块**）。
 *
 * 判据（**按 text 块的序位，不按 content 的下标** —— 中间可能夹非 text 块）：
 *   · 第 0 个 text 块 = summary（**不动它**：它带子代理 id 与结局，是有用的小信息）；
 *   · 第 1 个 text 块 = marker，**必须逐字**是 `'Its closing message:'`（认不出 ⇒ 不动、记一行）；
 *     若逐字是 `'It left no closing message.'` ⇒ 本来就没有报告，**安静跳过**（不是失败）；
 *   · 第 2 个 text 块起 = **正文**，逐字节相接。
 *
 * ⚠ **非 text 块（reasoning / tool-call）不进正文、也不被替换** ——
 *   它们留在原处原样不动（实测只占通知正文的 6.2%），所以"不许丢信息"这条是**真的成立**：
 *   主代理上下文里唯一被换掉的，就是被逐字节落盘的那一段正文。
 *
 * @returns {{ok:true, body:string, markerIdx:number, reportIdx:number[], blocks:string}
 *          |{ok:false, reason:string, silent:boolean, detail?:string}}
 */
function noticeReport(content) {
  if (!Array.isArray(content)) return { ok: false, reason: 'no-content', silent: false, detail: 'content 不是数组' }
  const textIdx = []
  for (let i = 0; i < content.length; i++) {
    const b = content[i]
    if (b && b.type === 'text' && typeof b.text === 'string') textIdx.push(i)
  }
  if (textIdx.length === 0) return { ok: false, reason: 'no-summary-block', silent: false, detail: '一个 text 块都没有' }
  if (textIdx.length < 2) return { ok: false, reason: 'no-marker-block', silent: false, detail: '只有 1 个 text 块，没有 marker' }
  const markerIdx = textIdx[1]
  const marker = content[markerIdx].text
  if (marker === NOTICE_MARKER_NONE) return { ok: false, reason: 'no-closing-message', silent: true }
  if (marker !== NOTICE_MARKER_CLOSING) {
    return { ok: false, reason: 'unknown-marker', silent: false, detail: '块 1 的文案不认识：' + JSON.stringify(String(marker).slice(0, 60)) }
  }
  const reportIdx = textIdx.slice(2)
  if (reportIdx.length === 0) return { ok: false, reason: 'no-report-block', silent: true }
  let body = ''
  for (const i of reportIdx) body += content[i].text
  return { ok: true, body: body, markerIdx: markerIdx, reportIdx: reportIdx, blocks: blockSummary(content) }
}

/**
 * 把正文块换成一段替换串：**第一个正文块的位置**放替换串，其余正文块删掉，
 * 其它块（summary / marker / reasoning / tool-call）**原样留在原位**。
 * 不修改传入的块对象（未动的块是同一个对象引用，替换块是新造的）。
 */
function replaceNoticeReport(content, replacementText, reportIdx) {
  const drop = new Set(reportIdx.slice(1))
  const first = reportIdx[0]
  const out = []
  for (let i = 0; i < content.length; i++) {
    if (i === first) { out.push({ type: 'text', text: replacementText }); continue }
    if (drop.has(i)) continue
    out.push(content[i])
  }
  return out
}

function noticeFor(n, absPath) {
  return NOTICE_HEAD + n + NOTICE_MID + absPath + NOTICE_TAIL
}

function markerFor(omitted) {
  return OMIT_HEAD + omitted + OMIT_TAIL
}

/**
 * ★ **通道 A 的纯函数判据：三条触发条件**。**一次 IO 都没有**
 * （这是"非目标工具零 IO"的判据所在）。
 *
 * 判据顺序是刻意的：`Set.has` → `undefined` 比较 → 布尔 → 长度，
 * 越便宜越靠前；`flattenPlainText` / `cpLength`（会扫全篇）只在前面全过了才跑。
 *
 * @returns {{spill:boolean, reason:string, text?:string, n?:number, tool?:string}}
 */
function decide(exec, result, decision, maxChars) {
  if (!exec || typeof exec !== 'object') return { spill: false, reason: 'no-exec' }
  if (exec.parent !== undefined) return { spill: false, reason: 'nested-call' }
  const tool = typeof exec.name === 'string' ? exec.name : ''
  if (!SPILL_TOOL_SET.has(tool)) return { spill: false, reason: 'not-spill-tool' }
  if (!decision || decision.kind !== 'accept') return { spill: false, reason: 'not-accept' }
  if (Object.prototype.hasOwnProperty.call(decision, 'value')) return { spill: false, reason: 'value-replacement' }
  if (result && result.isError === true) return { spill: false, reason: 'is-error-result' }
  const content = decision.content !== undefined ? decision.content : (result ? result.content : undefined)
  const text = flattenPlainText(content)
  if (text === undefined) return { spill: false, reason: 'non-text-block' }
  const n = cpLength(text)
  if (!(n > maxChars)) return { spill: false, reason: 'under-threshold', n: n, tool: tool }
  return { spill: true, reason: 'over-threshold', text: text, n: n, tool: tool }
}

/**
 * 造"换回去的内容"。**纯函数**（除了传入的 absPath 已经算好）。
 *
 * 逐字形状（用户点名的）：
 *   `[完整报告 N 字符已落盘（原文逐字节在盘上）：<绝对路径>]\n\n<前 1200 字符>\n\n…（中间省略 M 字符）…\n\n<后 600 字符>`
 *
 * 两条守卫（都会导致"不换"，理由如实返回）：
 *   · `nothing-to-omit`：文本短到连 头1200+尾600 都放不下 ⇒ 没有"中间"可省；
 *   · `not-smaller`：拼出来的替换串**不比原文短** ⇒ 换了反而更肥，那就不换。
 *     这两条只在"阈值被调到很小"时才会命中；默认阈值 4000 > 2010 时永远走不到。
 *     文本不够 1800 字符时头/尾按比例收缩（正常情况仍是逐字的 1200 / 600）。
 *
 * @returns {{ok:true, text:string, n:number, head:number, tail:number, omitted:number}
 *          |{ok:false, reason:'nothing-to-omit'|'not-smaller', n:number}}
 */
function buildReplacement(text, absPath) {
  const n = cpLength(text)
  const notice = noticeFor(n, absPath)
  // 省略标记的长度上界：M ≤ n ⇒ M 的位数 ≤ n 的位数。
  const reserve = notice.length + 3 * 2 + markerFor(n).length
  const avail = n - reserve
  if (avail < 3) return { ok: false, reason: 'nothing-to-omit', n: n }
  let head
  let tail
  if (avail >= HEAD_CHARS + TAIL_CHARS) {
    head = HEAD_CHARS
    tail = TAIL_CHARS
  } else {
    head = Math.max(1, Math.round(avail * HEAD_CHARS / (HEAD_CHARS + TAIL_CHARS)))
    if (head > avail) head = avail
    tail = avail - head
  }
  const omitted = n - head - tail
  if (omitted < 1) return { ok: false, reason: 'nothing-to-omit', n: n }
  const headText = cpSliceHead(text, head)
  const tailText = cpSliceTail(text, tail)
  const parts = [notice, headText, markerFor(omitted)]
  if (tailText !== '') parts.push(tailText)
  const out = parts.join('\n\n')
  if (cpLength(out) >= n) return { ok: false, reason: 'not-smaller', n: n }
  return { ok: true, text: out, n: n, head: head, tail: tail, omitted: omitted }
}

/**
 * 落盘文件的完整文本：头部 + 分隔线 + **逐字正文**
 * （结尾不额外加换行 —— 文件的最后一个字节就是报告最后一个字节）。
 */
function renderSpillFile(meta, body) {
  return [
    '# 报告落盘 · 逐字归档（report-spill）',
    '',
    '- 落盘时间: ' + formatHuman(meta.at) + '（' + new Date(meta.at).toISOString() + '）',
    '- 通道: ' + meta.channel,
    '- 工具: ' + meta.tool,
    '- 会话 id: ' + meta.sessionId,
    '- agent id: ' + meta.agentId,
    '- 工具调用 id: ' + meta.callId,
    '- 子代理会话: ' + meta.senderSessionId,
    '- 工程根: ' + meta.root + '（via ' + meta.via + '）',
    '- 触发阈值: > ' + meta.maxChars + ' 字符（本次 ' + meta.n + ' 字符）',
    '- 头/尾保留: ' + meta.head + ' + ' + meta.tail + ' 字符；中间省略 ' + meta.omitted + ' 字符',
    '- 正文字节: ' + Buffer.byteLength(body, 'utf8'),
    '- 正文 sha256: ' + sha256(body),
    '- 内容块: ' + meta.blocks,
    '- 正文口径: 码点计数；正文 = 分隔线之后的全部字节，逐字节等于子代理回给主代理的那段报告文本',
    '',
    BODY_SEP,
    '',
  ].join('\n') + body
}

/** 分隔线之后的**全部字节** = 逐字正文。自检与任何复核都用这一个函数，保证口径只有一份。 */
function extractBody(fileText) {
  const i = String(fileText).indexOf(BODY_SEP)
  if (i < 0) return null
  return String(fileText).slice(i + BODY_SEP.length + 1)
}

/**
 * 阈值解析。优先级：`config.maxChars` > 环境变量 > 默认 4000。
 * 关掉的两条路：`config.off === true`，或环境变量 `DSH_REPORT_SPILL_OFF` 为真值，
 * 或阈值写成 `0` / `off` / `false`（**0 必须显式当"关"** ——
 * 否则 `n > 0` 会让每一份结果都被换，正好反了）。
 *
 * @returns {{maxChars:number, source:string, off:boolean}}
 */
function resolveMaxChars(cfg, env) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const e = env && typeof env === 'object' ? env : {}
  if (c.off === true) return { maxChars: Infinity, source: 'config.off', off: true }
  const offRaw = String(e[ENV_OFF] === undefined || e[ENV_OFF] === null ? '' : e[ENV_OFF]).trim().toLowerCase()
  if (offRaw === '1' || offRaw === 'true' || offRaw === 'on' || offRaw === 'yes') {
    return { maxChars: Infinity, source: 'env:' + ENV_OFF, off: true }
  }
  const raw = c.maxChars !== undefined ? c.maxChars : e[ENV_MAX_CHARS]
  const from = c.maxChars !== undefined ? 'config.maxChars' : 'env:' + ENV_MAX_CHARS
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { maxChars: DEFAULT_MAX_CHARS, source: 'default', off: false }
  }
  const s = String(raw).trim().toLowerCase()
  if (s === '0' || s === 'off' || s === 'false' || s === 'no') {
    return { maxChars: Infinity, source: from + '(off)', off: true }
  }
  const v = Number(s)
  if (!Number.isFinite(v) || v < 0) {
    // 写坏了不许静默变成"永不落盘"以外的行为 —— 退回默认，并把来源说出来
    return { maxChars: DEFAULT_MAX_CHARS, source: 'default(invalid ' + from + '=' + JSON.stringify(raw) + ')', off: false }
  }
  return { maxChars: v, source: from, off: false }
}

/**
 * 保留份数解析。优先级：`config.keepReports` > 环境变量 > 默认 200。
 * `0` / `off` / `false` / `no` ⇒ **关掉轮转**（`keep = 0`）——
 * ⚠ **0 的含义是"不轮转"，不是"删光"**（名字里带 keep，别读反）。
 *
 * @returns {{keep:number, source:string}} keep = 0 表示不做轮转
 */
function resolveKeepReports(cfg, env) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const e = env && typeof env === 'object' ? env : {}
  const raw = c.keepReports !== undefined ? c.keepReports : e[ENV_KEEP_REPORTS]
  const from = c.keepReports !== undefined ? 'config.keepReports' : 'env:' + ENV_KEEP_REPORTS
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { keep: DEFAULT_KEEP_REPORTS, source: 'default' }
  }
  const s = String(raw).trim().toLowerCase()
  if (s === '0' || s === 'off' || s === 'false' || s === 'no') return { keep: 0, source: from + '(off)' }
  const v = Number(s)
  if (!Number.isFinite(v) || v < 1) {
    return { keep: DEFAULT_KEEP_REPORTS, source: 'default(invalid ' + from + '=' + JSON.stringify(raw) + ')' }
  }
  return { keep: Math.floor(v), source: from }
}

/**
 * 写落盘文件，**永不覆盖**：`wx` 独占创建，撞名退到 `-2` / `-3`。
 * （与 role-voices 的同名函数同一口径；"同一秒同一工具的两份报告"不许互相吃掉。）
 * @returns {string} 真正落盘的文件名
 */
function writeSpillFile(dir, baseName, text) {
  const stem = String(baseName).replace(/\.md$/, '')
  for (let n = 1; n <= 999; n++) {
    const name = n === 1 ? stem + '.md' : stem + '-' + n + '.md'
    try {
      fs.writeFileSync(path.join(dir, name), text, { encoding: 'utf8', flag: 'wx' })
      return name
    } catch (e) {
      if (e && e.code === 'EEXIST') continue
      throw e
    }
  }
  throw new Error('too many name collisions for ' + baseName)
}

/**
 * 列出目录里**本插件自己的**报告文件名（升序 = 时间序，因为名字以时间戳开头）。
 * **只扫这一层，不进子目录**；只认 `REPORT_FILE_RE`，且必须是**普通文件**。
 * 目录读不了 ⇒ 返回 `null`（调用方如实记账，绝不猜）。
 */
function listReportFiles(dir) {
  let names
  try { names = fs.readdirSync(dir) } catch (e) { return null }
  const out = []
  for (const n of names) {
    if (!REPORT_FILE_RE.test(n)) continue
    let st
    try { st = fs.statSync(path.join(dir, n)) } catch (e) { continue }
    if (!st.isFile()) continue
    out.push(n)
  }
  out.sort()
  return out
}

/**
 * ★ **轮转：只保留最新的 keep 份**。`protect`（刚写下去的那个文件名）**永不删**。
 *
 * 安全边界（每一条都是刻意的）：
 *   · 只删 `listReportFiles()` 认出来的名字 —— role-voices 的 `__<角色名>__` 归档、
 *     用户的 69 份手工存量、`INDEX.md` / `README.md`、任何子目录**一个都不匹配**；
 *   · 只删**普通文件**（`statSync().isFile()`）；
 *   · 单个删除失败只记进 `failed`，**不抛**（轮转是清理，不是功能）；
 *   · `keep <= 0` ⇒ 直接返回"关掉"，一个字节都不动。
 *
 * @returns {{ok:boolean, reason?:string, kept:number, deleted:string[], failed:Array}}
 */
function pruneReports(dir, keep, protect) {
  const res = { ok: true, kept: 0, deleted: [], failed: [] }
  if (!(typeof keep === 'number' && Number.isFinite(keep) && keep > 0)) {
    res.ok = false
    res.reason = 'keep-disabled'
    return res
  }
  const names = listReportFiles(dir)
  if (names === null) {
    res.ok = false
    res.reason = 'dir-unreadable'
    return res
  }
  let remaining = names.length
  for (const n of names) {
    if (remaining <= keep) break
    if (protect !== undefined && n === protect) continue
    try {
      fs.unlinkSync(path.join(dir, n))
      res.deleted.push(n)
      remaining--
    } catch (e) {
      res.failed.push({ name: n, error: String((e && e.message) || e) })
    }
  }
  res.kept = remaining
  return res
}

// ────────────────────────────────────────────────────────────────────────────
// 插件本体
// ────────────────────────────────────────────────────────────────────────────

/* ------------------------------------------------------------ 加载即留痕（★本文件是 6 份的「同款」母本） */
/**
 * ★★ **加载即留痕**（需求 R9 的后半句：「装完能验证真的加载了」）。
 *
 * 要解决的问题：5 个插件装上之后，**公开用户没有任何可机械验证的手段**证明它们真的跑起来了。
 *   现状是"看效果"—— 而看守类插件在正常情况下**本就不该有任何可见效果**（fail-open、不欠账就一个字不说）
 *   ⇒ 「它没加载」与「它加载了但今天没话说」在用户眼里**长得一模一样**（这正是本项目反复防的
 *   「没查到 ≠ 查了没问题」：分不开，就等于没有证据）。
 *
 * 所以：**被宿主加载并 apply() 时，往同一个文件里写自己那一条**。
 *
 * ── 统一落点（6 个插件写**同一份文件**，不许各写各的）────────────────────────
 *   `<落点目录>/PLUGIN-LOADED.json` —— 一个 JSON 文档，`plugins` 是 map，key = 插件 id：
 *   { "schema":1, "updatedAt":"…", "plugins": { "context-dedup": {…}, "role-voices": {…}, … } }
 *   为什么是"一个 map"而不是 6 个文件：用户**一条命令**就能看到"哪几个加载了"；
 *   6 个文件就得 `dir` 六次再自己数，等于把"能验证"退回给用户。
 *
 * ── 落点目录**运行期派生**（公开包硬要求：**一个作者机路径都不许有**）──────────
 *   多级兜底，顺序即优先级（前一个写得进去就用前一个，**第一个能写的胜出**）：
 *     ① `$WARDEN_PLUGIN_LEDGER`   —— 显式指定目录（测试 / 非标准安装位置）
 *     ② `$DSH_HOME/plugin-ledger` —— `DSH_HOME` 是 DSH 自己注入的环境变量，**换用户就跟着变**
 *     ③ `<os.homedir()>/.dsh/plugin-ledger` —— 退到 DSH 的默认家目录
 *        （`DSH_HOME` 没设时 DSH 本身就是用这个默认值；与 `plugin-io.js` 的
 *         `resolveWardenMjs` / `warden-watch.js` 的 `resolveWardenMjs` **同款三级口径**，
 *         只是把"读"换成"写"，并多一级 `tmpdir`）
 *     ④ `<os.tmpdir()>/dsh-plugin-ledger` —— 上两级都写不进去时兜底
 *        （`warden-watch.js:106-108` 实测记过：前几个候选哪一个能写取决于进程沙箱根，
 *          临时区两边都写得进去）
 *   一处作者机路径都没有：**每一段都是 `os`/`process.env` 现推的**，
 *   推不出来就**往下一级退**，退到底还不行就**静默放弃**（见下）。
 *
 * ── 为什么选这一族目录（而不是工程根 `.warden/`）────────────────────────────
 *   · 「装完能不能用」是**机器级事实**，不是某个工程的事实 —— 同一个插件会被好几个工程用到；
 *     写进工程根 ⇒ 换个工程就得再查一遍，且"没写"分不清是没加载还是这个工程没跑过。
 *   · 插件沙箱实测**写不进任意路径**（`warden-watch.js:106-108` 那条），
 *     而 `$DSH_HOME` / 家目录 / 临时区是**插件进程真写得进去**的地方。
 *   · 全部落在**用户自己的家目录/临时区**，不进任何仓库 ⇒ 不会被误推送到公开仓库。
 *
 * ── 隐私（硬约束）───────────────────────────────────────────────────────
 *   **只写 4 样**：插件 id / 版本串 / ISO 时间戳 / pid。
 *   ⚠ **不写宿主实例 id**（旧稿写"5 样"、含 Cordis 的 `ctx.id`）：见下面 `hostId` 那条 ——
 *   读 `ctx.id` 会破坏「对 `ctx` 只有 on/effect」的访问面约束，**本包一律不传**。
 *   **绝不写**：工程路径、会话 id、用户名、环境变量值、任何用户内容。
 *   ⚠ 那个 `via` 值是**回落第几级**的标签，形如 `3·home` —— 是**来源标签、不是路径**，
 *     它本身不含家目录字面量（路径只在内存里，不落盘）。
 *
 * ── fail-open（硬约束）──────────────────────────────────────────────────
 *   写失败/目录不可写 ⇒ **静默降级、绝不抛**。这 6 个插件都是看守，
 *   **自己坏了不许让用户的操作失败**，也不许因为"留痕失败"就在屏幕上吵闹。
 *
 * ── 不许在热路径上加同步 IO ─────────────────────────────────────────────
 *   只在 `apply()` 里调**一次**。**不要**每次工具调用都写 —— 那是每秒几十次的
 *   `mkdirSync`+`readFileSync`+`writeFileSync`，会把看守变成性能问题。
 *   （`context-dedup` 自己在 `apply()` 里另有一条 `flushStatus()`，那是**另一个文件、
 *     另一个用途**，本函数与它无关，也不共用任何状态。）
 *
 * ⚠⚠ **同款实现**：`context-dedup.js` / `role-voices.js` / `handover-gate.js` / `branch-guard.js` /
 *   `report-spill.js` / `warden-watch.js` —— **这 6 份里的本段逐字节相同**（含本注释；
 *   不点名"母本是哪一个"，因为点名表写死后在本文件里会把自己也列进"另外几份"，读着自相矛盾）。
 *   可复算：`node _ledger_samecheck.mjs` 应打印 `distinct implementations: 1`，
 *   函数代码段 sha256 前缀 `4489b155…`（**注释段自己不报 sha**：报了就会因为写进 sha 而自我失效）。
 *   ⚠ 因文件而异的**不在这里**，在**调用点**：用 `name` 还是写死 id、用 `VERSION` 还是复用 `PLUGIN_VERSION`。
 *   **为什么复制 6 份而不是抽一个公共模块**：`warden-watch.js:54-57` 已经写明这个坑 ——
 *   `plugin-io.js` 顶层直接干活并 `process.exit`，**不是可以安全引入的纯函数模块**；
 *   引一个公共文件还会多出"装上去了但那个文件没随包走"的新静默失败面（本包**已经**因为漏发
 *   `plugin-io.js` 踩过一次，见 `warden-watch.js:27-29`）。
 *   ⇒ 宁可 6 份逐字复制，也不新增一个可缺席的依赖 —— 但**口径必须只有一套**：
 *     改这里的任何一行，**另外 5 份都要跟着改**（注释首行点名"与谁同款"就是为这个）。
 *
 * @param {string} pluginId 这个插件自己的 id（与 `name` 同一个字面量，**不是**会话 id）
 * @param {string} version  这个插件自己的版本串
 * @param {*}      hostId   宿主注入的插件实例 id（Cordis 的 `ctx.id`），没有就不写这个键。
 *   ⚠ **本包一律不传它**（6 个调用点都不传）：读 `ctx.id` 会在 Proxy 上留一次 `GET(id)`，
 *   与「对 `ctx` 的调用**只有** `ctx.on` 与 `ctx.effect`」那条硬契约冲突（`handover-gate.js:40`）。
 *   这个形参**保留**是为了公共实现段 6 份逐字相同、且将来宿主若改用别的方式提供实例 id 时不必改签名。
 */
function markPluginLoaded(pluginId, version, hostId) {
  try {
    const osx = require('os')
    const pathx = require('path')
    const fsx = require('fs')

    /* ── ① 派生落点目录（多级兜底；**一个作者机路径都没有**） ── */
    const cands = []
    if (process.env.WARDEN_PLUGIN_LEDGER) {
      cands.push({ dir: String(process.env.WARDEN_PLUGIN_LEDGER), src: 'env:WARDEN_PLUGIN_LEDGER' })
    }
    if (process.env.DSH_HOME) {
      cands.push({ dir: pathx.join(String(process.env.DSH_HOME), 'plugin-ledger'), src: 'DSH_HOME' })
    }
    try { cands.push({ dir: pathx.join(osx.homedir(), '.dsh', 'plugin-ledger'), src: 'home' }) } catch (e) { /* 取不到家目录就退下一级 */ }
    try { cands.push({ dir: pathx.join(osx.tmpdir(), 'dsh-plugin-ledger'), src: 'tmpdir' }) } catch (e) { /* 连临时区都没有就只剩前几级 */ }

    const FILE = 'PLUGIN-LOADED.json'
    const now = new Date().toISOString()
    /* ⚠ 只记这几样；`pid` 用来区分"这次启动是哪个进程加载的"（重启后 pid 变、at 变） */
    const mine = { id: String(pluginId), version: String(version), at: now, pid: process.pid }
    /* 宿主给的实例 id：**有才写**（没有就整个键都不出现，不写 null 噪音） */
    try { if (hostId !== undefined && hostId !== null && String(hostId) !== '') mine.hostId = String(hostId) } catch (e) { /* 算了 */ }

    for (let i = 0; i < cands.length; i++) {
      const c = cands[i]
      try {
        fsx.mkdirSync(c.dir, { recursive: true })
        const p = pathx.join(c.dir, FILE)

        /* ── ② 读旧文档（**读不动就当空文档**：读失败绝不许变成写失败） ── */
        let doc = null
        try {
          const parsed = JSON.parse(fsx.readFileSync(p, 'utf8'))
          /* 只有"真的是个普通对象"才复用；数组/字符串/数字都当坏档重建 */
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed
        } catch (e) { doc = null }
        if (doc === null) doc = {}
        /* `plugins` 是放各插件记录的 map；顶层其他键（schema/更新时间）原样保留 */
        if (!doc.plugins || typeof doc.plugins !== 'object' || Array.isArray(doc.plugins)) doc.plugins = {}

        doc.schema = 1
        doc.updatedAt = now
        doc.plugins[String(pluginId)] = mine

        /* ── ③ 原子写：先写 `.tmp` 再 `renameSync` ──
         *   为什么：6 个插件**几乎同时** apply（同一次 compose 的 6 条 insert），
         *   直接 `writeFileSync` 有互相读到"写了一半"的窗口 ⇒ 可能整个 map 被截断。
         *   rename 在同一卷上是原子的 ⇒ 读者永远读到"完整的上一版或完整的新版"。
         *   ⚠ 这里**不跨进程加锁**：跨进程锁要建锁文件，锁文件自己就是新的静默失败面
         *   （进程崩了就永久锁死）。实测这个窗口的后果是"某一条留痕丢了"，
         *   而**丢了就是没记录** —— 正是我们要的诚实降级：不会伪造"加载了"。
         *   （调用点用 `markPluginLoadedWithRetry` **再读一次**、必要时重写一轮来收敛。） */
        const tmp = p + '.' + process.pid + '.tmp'
        fsx.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
        fsx.renameSync(tmp, p)
        return { ok: true, path: p, via: (i + 1) + '·' + c.src }
      } catch (e) { /* 这一级不可写 ⇒ 换下一级；**绝不抛** */ }
    }
    return { ok: false, path: null, via: null }
  } catch (e) {
    /* 连 require/os 都炸了 —— 那更不能影响主功能 */
    return { ok: false, path: null, via: null }
  }
}

/**
 * 调用点的**收敛重试**：6 个插件几乎同时 apply，有可能互相覆盖（见上面 ③ 的说明）。
 * 这里只补一件事：**写完再读一次，自己那条不在就再写一轮**（最多 2 轮）。
 * 目的不是"保证万无一失"，而是把"同时加载 6 个"这个常见情形的漏记压到实测为零；
 * 仍然失败就**静默算了**（漏记 = 没记录，不伪造"加载了"）。
 * 与 `markPluginLoaded` 一样：**绝不抛**，也**只在 apply() 里调用一次**。
 */
function markPluginLoadedWithRetry(pluginId, version, hostId) {
  for (let round = 0; round < 2; round++) {
    const r = markPluginLoaded(pluginId, version, hostId)
    if (!r.ok) return r
    try {
      const doc = JSON.parse(require('fs').readFileSync(r.path, 'utf8'))
      if (doc && doc.plugins && doc.plugins[String(pluginId)]) return r
    } catch (e) { /* 读不动就再来一轮 */ }
  }
  return markPluginLoaded(pluginId, version, hostId)
}

/**
 * 本插件自己的版本串 —— ★ **只给上面那条"加载即留痕"用**，不参与任何判定。
 * 为什么要有它：留痕记录必须能回答"我看到的这条是**哪个版本**写的"
 * （不然升级之后没法分辨"新版本没加载"和"旧版本还活着"）。
 * 改这个文件里任何**会影响行为**的东西时，请一并把它 +1（口径：语义化版本 `MAJOR.MINOR.PATCH`）。
 */
/**
 * ⚠ `inject` 是**空的**，这是刻意的（与 role-voices 同一条理由）：
 *   Cordis 的 `inject` 是**硬依赖** —— 声明了却缺席，**整个插件**进 `waiting`。
 *   本插件一个服务都不需要（只读 `exec.agent.session` / `payload.agent.session`，只用 Node 内置），
 *   所以没有任何理由把它的生死绑在别人的加载顺序上。
 */
const name = 'report-spill'

const VERSION = '1.0.0-loadmark'
const inject = []

function apply(ctx, config) {
  /* ★ 加载即留痕：**整个插件生命周期里只写这一次**（不在任何热路径上）。
   *   写失败静默降级（`markPluginLoaded*` 内部已经吞掉所有异常）。
   *   位置选在 `apply()` 最前面：宿主调用 `apply` 本身就等于"这个插件加载成功了"，
   *   所以留痕不该等任何后续步骤 —— 哪怕下面任何一行抛了，留痕也已经如实写下。
   *   ⚠ **第 3 个实参 `hostId` 故意不传**（旧稿写 `ctx && ctx.id`）：读 `ctx.id` 会在 `ctx` 的
   *     Proxy 上留下一次 `GET(id)`，与「对 `ctx` 的调用**只有** `ctx.on` 与 `ctx.effect`」那条
   *     硬契约（`handover-gate.js:40`）**直接冲突**（实测：自检的 ㉔/㉔b 因此变红）。
   *     `hostId` 是可选参数 ⇒ 不传就**整个键都不出现**，留痕照常工作。 */
  markPluginLoadedWithRetry(name, VERSION)

  const cfg = config && typeof config === 'object' ? config : {}
  const resolved = resolveMaxChars(cfg, process.env)
  const maxChars = resolved.maxChars
  const keepResolved = resolveKeepReports(cfg, process.env)
  const keepReports = resolved.off ? 0 : keepResolved.keep
  const dirName = typeof cfg.dirName === 'string' && cfg.dirName !== '' ? cfg.dirName : DIR_NAME
  const fallbackDir = typeof cfg.fallbackDir === 'string' && cfg.fallbackDir !== ''
    ? cfg.fallbackDir
    : (function () { try { return os.tmpdir() } catch (e) { return process.cwd() } })()
  const failPath = path.join(fallbackDir, FAIL_NAME)

  /** 同一个 `callId` 的重放：再问一次就返回**同一份**替换串，**不再写第二个文件**。 */
  const byCallId = new Map()
  const disposers = []

  function logWarn(msg) {
    try { if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[report-spill] ' + msg) } catch (e) { /* 日志自己坏了不许影响工具调用 */ }
  }

  /**
   * 如实记一次失败。**两个出口**：
   *   ① `ctx.logger.warn` —— 有人看 host stderr 就能看到；
   *   ② `<os.tmpdir()>\report-spill-failures.jsonl` —— 结构化、可机检。
   *      ⚠ 刻意**不写进工程、不写进 `.warden\`** —— 落盘失败往往正是"写不进去"，
   *        再往那个写不进去的地方记账就是二次事故。
   * 任何一步失败都绝不抛。
   */
  function reportFailure(rec) {
    const row = Object.assign({ at: new Date().toISOString(), plugin: name, maxCharsSource: resolved.source, keepReportsSource: keepResolved.source }, rec)
    logWarn(JSON.stringify(row))
    try {
      fs.mkdirSync(fallbackDir, { recursive: true })
      fs.appendFileSync(failPath, JSON.stringify(row) + '\n', 'utf8')
    } catch (e) { /* 连台账都写不进去：logger 那一行已经记过了 */ }
    return row
  }

  /**
   * ★★ **两条通道共用的那一条落盘路径**（口径只有一份，自检与复核都走它）。
   *
   * fail-open 是**结构上**保证的：任何一步不成立 ⇒ 返回 `{ok:false, reason}`，
   * 调用方**原样放行**；本函数**从不抛**（唯一的 try 在写盘那一小段）。
   *
   * @param {{text:string, tool:string, channel:string, tag:string, session:object,
   *          sessionId:string, agentId:string, callId:string, senderSessionId:string, blocks:string}} req
   * @returns {{ok:true, absPath:string, replacement:string, n:number, head:number, tail:number, omitted:number}
   *          |{ok:false, reason:string, detail?:string}}
   */
  function spillOne(req) {
    const header = req.session && req.session.header
    const cwd = header && typeof header.cwd === 'string' && header.cwd.trim() !== ''
      ? header.cwd
      : (function () { try { return process.cwd() } catch (e) { return '' } })()
    if (cwd === '') {
      reportFailure({ reason: 'no-cwd', detail: '会话 header.cwd 缺失且 process.cwd() 也拿不到', tool: req.tool, channel: req.channel, n: cpLength(req.text), callId: req.callId })
      return { ok: false, reason: 'no-cwd' }
    }

    const probe = findProjectRootVia(cwd)
    if (probe.found === null) {
      /**
       * 工程根推不出 ⇒ **落盘这一步不做**，原样放行 + 记一行。
       * 判据 = 从 cwd 一路向上**既没有 `.git` 也没有 `.warden`**。
       * 在这里凭空造一个 `角色发言\` 就是"账本落到容器目录上"那一类事故的同构版本。
       */
      reportFailure({
        reason: 'project-root-not-found',
        detail: '从 cwd 向上既没有 .git 也没有 .warden（via=' + probe.via + '）',
        start: cwd, root: probe.root, via: probe.via, tool: req.tool, channel: req.channel, n: cpLength(req.text), callId: req.callId,
      })
      return { ok: false, reason: 'project-root-not-found' }
    }

    const root = probe.root
    const dir = path.join(root, dirName)
    const tagSafe = sanitizeSegment(req.tag, 24) || 'subagent'
    const at = Date.now()
    const fileName = formatStamp(at) + '__' + FILE_TAG + '__' + tagSafe + '.md'
    const absPath = path.join(dir, fileName)

    /**
     * 先算替换串（纯函数）。`not-smaller` / `nothing-to-omit` ⇒ 不落盘、原样放行：
     * 换了反而更肥的时候，"落盘"这件事对用户没有任何好处，只会多一堆文件。
     */
    const built = buildReplacement(req.text, absPath)
    if (!built.ok) {
      reportFailure({ reason: 'replacement-' + built.reason, detail: '替换串不成立 ⇒ 不落盘、原样放行', tool: req.tool, channel: req.channel, n: built.n, callId: req.callId, dir: dir })
      return { ok: false, reason: 'replacement-' + built.reason }
    }

    const meta = {
      at: at,
      channel: req.channel,
      tool: req.tool,
      sessionId: req.sessionId,
      agentId: req.agentId,
      callId: req.callId,
      senderSessionId: req.senderSessionId,
      root: root,
      via: probe.via,
      maxChars: maxChars === Infinity ? 'off' : maxChars,
      n: built.n,
      head: built.head,
      tail: built.tail,
      omitted: built.omitted,
      blocks: req.blocks === undefined ? '(未知)' : req.blocks,
    }
    let written
    try {
      fs.mkdirSync(dir, { recursive: true })
      written = writeSpillFile(dir, fileName, renderSpillFile(meta, req.text))
    } catch (e) {
      /** ★ fail-open 的核心那一条：落盘失败 ⇒ **原样放行**，绝不让工具调用失败。 */
      reportFailure({
        reason: 'spill-write-failed',
        detail: String((e && e.message) || e),
        tool: req.tool, channel: req.channel, n: built.n, callId: req.callId, root: root, via: probe.via, dir: dir, file: fileName,
      })
      return { ok: false, reason: 'spill-write-failed' }
    }

    const finalPath = path.join(dir, written)
    const built2 = buildReplacement(req.text, finalPath)
    if (!built2.ok) {
      // 撞名改了路径之后重算居然不成立（理论上到不了）⇒ 文件已经写下去了，如实记一行并放行
      reportFailure({ reason: 'replacement-' + built2.reason + '-after-rename', detail: '文件已落盘但替换串不成立', tool: req.tool, channel: req.channel, n: built2.n, callId: req.callId, file: written })
      return { ok: false, reason: 'replacement-' + built2.reason + '-after-rename' }
    }

    /**
     * ★ **轮转**（`角色发言\` 有界）。放在落盘**成功之后**、返回之前：
     *   轮转失败只是"目录没被清理"，**绝不影响这次落盘与换回**（所以只记账、不返回失败）。
     */
    if (keepReports > 0) {
      const pr = pruneReports(dir, keepReports, written)
      if (!pr.ok) {
        reportFailure({ reason: 'prune-' + pr.reason, detail: '轮转没做成（不影响本次落盘）', dir: dir, keepReports: keepReports, keepReportsSource: keepResolved.source })
      } else {
        if (pr.deleted.length > 0) logWarn('pruned ' + pr.deleted.length + ' old report(s) in ' + dir + '（保留最新 ' + keepReports + '）')
        if (pr.failed.length > 0) reportFailure({ reason: 'prune-unlink-failed', detail: JSON.stringify(pr.failed).slice(0, 400), dir: dir })
      }
    }

    logWarn('spilled ' + built2.n + ' chars of ' + req.tool + ' [' + req.channel + '] -> ' + finalPath
      + '（保留头 ' + built2.head + ' + 尾 ' + built2.tail + '，省略 ' + built2.omitted + '）')
    return { ok: true, absPath: finalPath, replacement: built2.text, n: built2.n, head: built2.head, tail: built2.tail, omitted: built2.omitted }
  }

  /**
   * ★★ **通道 A 的落点**（`tools/post-execute`，waterfall）。
   * fail-open 是**结构上**保证的：整个函数体包在一个 try/catch 里，
   * **只有**成功走到最后才返回"换过的" decision，其余每一条路都 `return decision`。
   */
  async function handler(exec, result, next) {
    // ⚠ 必须先 next()：这是 waterfall，后面还有别的监听器（spill-policy 等）。
    //   不 next 就把别人的层拆了 —— 那不是"加一层"。
    const decision = await next()
    /**
     * 防御：`next()` 理论上必定给回一个对象（`dsh-tools\lib\index.js:3378` 的兜底是
     * `{kind:'accept'}`）。万一上游某个监听器返回了 undefined，这里**原样返回那个
     * undefined** 会让 `postExecute` 在 `decision.additionalContexts` 上抛错 ——
     * 一次成功的工具调用会因为本插件而失败。所以退回**框架自己的那个兜底值**。
     */
    if (decision === undefined || decision === null) return { kind: 'accept' }
    try {
      const d = decide(exec, result, decision, maxChars)
      if (!d.spill) return decision

      const callId = exec && exec.callId !== undefined && exec.callId !== null ? String(exec.callId) : ''
      const cached = callId === '' ? undefined : byCallId.get(callId)
      if (cached !== undefined && cached.n === d.n && cached.tool === d.tool) {
        // 同一次调用被 post-execute 问了第二遍 ⇒ 复用同一份，**零 IO**
        return accept(decision, cached.replacement)
      }

      const agent = exec && exec.agent
      const session = agent && agent.session
      const header = session && session.header
      const r = spillOne({
        text: d.text,
        tool: d.tool,
        channel: 'tools/post-execute',
        tag: d.tool,
        session: session,
        sessionId: String((header && header.id) || ''),
        agentId: String((agent && agent.id) || ''),
        callId: callId,
        senderSessionId: '',
        blocks: '(工具结果)',
      })
      if (!r.ok) return decision

      if (callId !== '') {
        byCallId.set(callId, { n: d.n, tool: d.tool, replacement: r.replacement, file: r.absPath })
        if (byCallId.size > CALLID_CACHE_MAX) {
          const oldest = byCallId.keys().next()
          if (!oldest.done) byCallId.delete(oldest.value)
        }
      }
      return accept(decision, r.replacement)
    } catch (e) {
      /**
       * 兜底：这条路上任何未预期的抛错都**不许静默**，也**绝不外抛**。
       * 外抛的话 `dsh-tools\lib\index.js:3375` 会把它变成 `isError` ——
       * 一次成功的工具调用会因为本插件坏了而失败，那是不可接受的。
       */
      try {
        reportFailure({
          reason: 'spill-threw',
          detail: String((e && e.message) || e),
          stack: String((e && e.stack) || '').slice(0, 600),
          tool: (exec && exec.name) || '', callId: (exec && exec.callId) || '',
        })
      } catch (e2) { /* 算了 */ }
      return decision
    }
  }

  /**
   * ★★ **通道 B 的落点**（`agent/pre-step`，waterfall）—— 默认后台模式下**唯一会响的那条**。
   *
   * 为什么是这里：进入这一步的消息**才**被写进会话日志
   * （`dsh-agent-loop\lib\index.js:1028`），所以换掉 `decision.messages` 里的那条结算通知，
   * 就等于换掉了**主代理真正收到、且永久留在盘上**的那份字节。
   *
   * 只碰 `message.source.kind === 'subagent-settled'` 的消息；其余消息**一个字节都不动**，
   * 并且"什么都没换"时**原样返回同一个 decision 对象**（净效果 0）。
   */
  async function preStepHandler(payload, next) {
    const decision = await next()
    if (decision === undefined || decision === null) return decision
    try {
      if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      const msgs = decision.messages
      let out = null
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]
        if (!m || typeof m !== 'object') continue
        const src = m.source
        if (!src || src.kind !== NOTICE_SOURCE_KIND) continue

        const parsed = noticeReport(m.content)
        if (!parsed.ok) {
          /**
           * 形状不认识 ⇒ **不动、记一行**（"认不出来"和"没有报告"是两件事，不许压成一个静默）。
           * 而 `no-closing-message` / `no-report-block` 是**正常情况**（子代理没留收尾话），
           * 安静跳过 —— 否则每一次都会在台账里刷一行。
           */
          if (!parsed.silent) {
            reportFailure({
              reason: 'notice-' + parsed.reason,
              detail: parsed.detail || '',
              channel: 'agent/pre-step',
              senderSessionId: String(src.senderSessionId || ''),
            })
          }
          continue
        }

        const n = cpLength(parsed.body)
        if (!(n > maxChars)) continue

        const agent = payload && payload.agent
        const session = agent && agent.session
        const header = session && session.header
        const senderSessionId = String(src.senderSessionId || '')
        const r = spillOne({
          text: parsed.body,
          tool: NOTICE_SOURCE_KIND,
          channel: 'agent/pre-step',
          tag: sanitizeSegment(shortId(senderSessionId), 24) || 'subagent',
          session: session,
          sessionId: String((header && header.id) || ''),
          agentId: String((agent && agent.id) || ''),
          callId: senderSessionId === '' ? '' : senderSessionId + '#' + n,
          senderSessionId: senderSessionId,
          blocks: parsed.blocks,
        })
        if (!r.ok) continue

        const newContent = replaceNoticeReport(m.content, r.replacement, parsed.reportIdx)
        // ★ 其它字段（尤其 `source`）**原样保留** —— 只换 content。
        const newMsg = Object.assign({}, m, { content: newContent })
        if (out === null) out = msgs.slice()
        out[i] = newMsg
      }
      if (out === null) return decision
      return Object.assign({}, decision, { messages: out })
    } catch (e) {
      /**
       * 兜底：绝不外抛 —— 本插件是看守，不是被看守的东西；
       * 它的异常绝不能反过来把主代理的一步搞坏。
       */
      try {
        reportFailure({
          reason: 'pre-step-threw',
          detail: String((e && e.message) || e),
          stack: String((e && e.stack) || '').slice(0, 600),
          channel: 'agent/pre-step',
        })
      } catch (e2) { /* 算了 */ }
      return decision
    }
  }

  /**
   * 换过的 decision。**`additionalContexts` 原样转发** ——
   *   `dsh-tools\lib\index.js:3390` 把它并进最终结果；吞掉它就等于把内层 decision
   *   挂的 contexts 丢了。只有"原来有"才带上，避免给本来没有的结果凭空加一个空数组。
   */
  function accept(decision, text) {
    return Object.assign(
      { kind: 'accept', content: [{ type: 'text', text: text }] },
      decision && decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
    )
  }

  /**
   * ⚠ 装不上就**抛**（让加载器把 "failed to apply loader entry" 报出来），
   *   而不是悄悄退化成"永不落盘" —— 一个静默失效的机制比没有机制更坏。
   *   `ctx.on` 返回 disposer，它本身就是挂在当前 fiber 上的 effect
   *   （`cordis\lib\index.js:335-345`），fiber 卸载时自动摘除。
   */
  disposers.push(ctx.on('tools/post-execute', handler, { prepend: true }))
  disposers.push(ctx.on('agent/pre-step', preStepHandler, { prepend: true }))

  /** 把"摘除"这件事**显式化**：不依赖框架的 fiber 语义，自己再兜一层（幂等）。 */
  ctx.effect(() => () => {
    for (const d of disposers) {
      try { if (typeof d === 'function') d() } catch (e) { /* 摘除失败不该影响卸载 */ }
    }
    byCallId.clear()
  }, 'report-spill.dispose-hooks')
}

module.exports = {
  name: name,
  inject: inject,
  apply: apply,
  /**
   * 自检用。**为什么要暴露**：`report-spill.selftest.mjs` 要跑的必须是**同一份代码路径**
   * （触发判据、码点口径、替换串形状、工程根判法、落盘规则、轮转规则），另抄一份就等于没测。
   * 宿主加载器只取 `name`/`inject`/`apply`（`unwrapExports`），多余字段不影响挂载。
   */
  _internals: {
    DIR_NAME: DIR_NAME,
    FILE_TAG: FILE_TAG,
    HEAD_CHARS: HEAD_CHARS,
    TAIL_CHARS: TAIL_CHARS,
    DEFAULT_MAX_CHARS: DEFAULT_MAX_CHARS,
    ENV_MAX_CHARS: ENV_MAX_CHARS,
    ENV_OFF: ENV_OFF,
    DEFAULT_KEEP_REPORTS: DEFAULT_KEEP_REPORTS,
    ENV_KEEP_REPORTS: ENV_KEEP_REPORTS,
    FAIL_NAME: FAIL_NAME,
    SUBAGENT_TOOLS: SUBAGENT_TOOLS,
    ORCHESTRATOR_TOOLS: ORCHESTRATOR_TOOLS,
    SPILL_TOOLS: SPILL_TOOLS,
    NOTICE_SOURCE_KIND: NOTICE_SOURCE_KIND,
    NOTICE_MARKER_CLOSING: NOTICE_MARKER_CLOSING,
    NOTICE_MARKER_NONE: NOTICE_MARKER_NONE,
    REPORT_FILE_RE: REPORT_FILE_RE,
    BODY_SEP: BODY_SEP,
    NOTICE_HEAD: NOTICE_HEAD,
    NOTICE_MID: NOTICE_MID,
    NOTICE_TAIL: NOTICE_TAIL,
    OMIT_HEAD: OMIT_HEAD,
    OMIT_TAIL: OMIT_TAIL,
    CALLID_CACHE_MAX: CALLID_CACHE_MAX,
    findProjectRootVia: findProjectRootVia,
    sanitizeSegment: sanitizeSegment,
    shortId: shortId,
    formatStamp: formatStamp,
    formatHuman: formatHuman,
    sha256: sha256,
    cpLength: cpLength,
    cpSliceHead: cpSliceHead,
    cpSliceTail: cpSliceTail,
    flattenPlainText: flattenPlainText,
    textOfBlocks: textOfBlocks,
    blockSummary: blockSummary,
    noticeReport: noticeReport,
    replaceNoticeReport: replaceNoticeReport,
    noticeFor: noticeFor,
    markerFor: markerFor,
    decide: decide,
    buildReplacement: buildReplacement,
    renderSpillFile: renderSpillFile,
    extractBody: extractBody,
    resolveMaxChars: resolveMaxChars,
    resolveKeepReports: resolveKeepReports,
    writeSpillFile: writeSpillFile,
    listReportFiles: listReportFiles,
    pruneReports: pruneReports,
  },
}
