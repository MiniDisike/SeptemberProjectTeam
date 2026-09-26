'use strict'
/*
 * role-voices —— R42 的**硬机制**：角色（子代理）自己说的话，逐字落到
 * `<工程根>\角色发言\`，让用户**点进去就能读到原话**，而不是只从主代理的转述里猜。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么要有这个文件（用户逐字，R42）
 *   「做一个硬机制，每个项目默认开一个文件夹放这些不需要放入上下文，
 *     但你可以阅读，我也可以点入阅读的文件夹。」
 * 病根（用户逐字）：「（用户原话已隐去 —— 公开版不留逐字）」
 * ⇒ 「主代理是唯一信息通道」本身就是缺陷。转述是本项目明令禁止的东西，
 *   所以这里**不解决"转述得更好"**，而是把**原话本身**放到一个用户能直接读的地方。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 它**不做**什么（这几条和"做什么"一样重要）
 *   1. 它**不进上下文**：没有 systemPrompt 段、没有 runtime context、没有 steer/send、
 *      没有任何一条消息通道被它碰过。它只往磁盘写，用户/模型要读时自己去 `read`。
 *      （自检 `role-voices.selftest.mjs` 把本插件挂到假 ctx 上，把注册到的东西全列出来，
 *        逐条证明里面没有上下文相关的东西。）
 *   2. 它**不润色、不截断、不总结**：写进正文的字节与模型输出逐字节相同，
 *      正文 sha256 同时记在头部，任何人都能复核（自检里就是这么复核的）。
 *   3. 它**不靠主代理**：挂的是子代理自己的**结束事件**（硬 hook），
 *      主代理记不记得、想不想转述，都不影响落盘。
 *   4. 它**不静默吞失败**：工程根推不出 / 目录不可写 / 正文为空，
 *      一律落到 `<fallbackDir>\role-voices-failures.jsonl` + `console.error`
 *      +（归档目录可用时）`INDEX.md` 里一行 `⚠ 归档失败`。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠ 形态为什么是 CommonJS 的 `module.exports`，而不是 `export const name`
 *   宿主加载器（`@deepseek-ai/dsh-cordis-plugin-loader`）用 `await import(name)` 取模块
 *   （`lib/index.js:270-283`），再用 `unwrapExports` 做 `exports.default ?? exports` 归一
 *   （`:746-751`）—— 两种形态它都认。但 `name:` 写的是**绝对路径的 `.js`**，
 *   而工程目录一直到盘根**没有任何 package.json**（实测为 false），
 *   所以 Node 把 `.js` 当 CommonJS：`export` 语法会直接 SyntaxError。
 *   证据不是推理：同目录的 `warden-watch.js` 就是 `module.exports = { name, inject, apply }`，
 *   而它**确实被这个 profile 加载着**（`%DSH_HOME%\profiles\web\cordis.patch.yml:12-14`）。
 *   ⇒ 用被证明能跑的那个形态；`name` / `inject` / `apply` 仍然是模块级具名导出
 *     （cjs-module-lexer 认得 `module.exports = {...}` 这种字面量）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 依据（都是读源码核过的，不是猜的）
 *   · 子代理识别：`agent.session.header.origin === 'subagent'`，主会话**没有** `origin`
 *     （`dsh-subagent\lib\index.js:502-513` 的 `childSessionMeta`；
 *      `dsh-session\lib\index.js:790` 校验 `origin` 只能是 `"subagent"`）。
 *   · 结束事件都带 `agent`：`dsh-agent\lib\index.js:209-213` 的 `fused(payload) = {...payload, agent}`。
 *     ⚠ **这一层依赖要说清（F7）**：`agent/status` 的 **payload 本身只有 `{status}`**
 *     （emit 点逐字是 `dsh-agent-loop\lib\index.js:781` 的
 *     `this.dispatch.emit("agent/status", { status })` —— **里面没有 `agent`**），
 *     `agent` 是 `agentEvents()` 在派发时用 `fused()` **注入**的
 *     （`dsh-agent\lib\index.js:209-213`，`emit` 走 `:215-220`）。
 *     ⇒ 监听器里能拿到 `payload.agent`，靠的是**这一层注入**，不是 emit 点自己带的。
 *       审查实测：`emit('agent/status', {status:'idle'})` 逐字照 emit 点 ⇒ **0 条归档**；
 *       补上 `agent` ⇒ **1 条**。所以本插件的 4 个 hook **必须走 `ctx.on` 收派发后的 payload**，
 *       绝不能自己伪造/转发 payload（那样 `agent` 就是 undefined，4 个 hook 一起静默失效）。
 *   · `agent/turn-stopping`（`dsh-agent-loop\lib\index.js:967`，`dispatch.serial`）、
 *     `agent/status`（`:781`，payload `{status}`，取值 `'idle' | 'running'`，`:773`）、
 *     `agent/error`（`:863`）、`agent/disposed`（`dsh-agent\lib\index.js:513-518`）。
 *     ⚠ 这四个都是 emit/serial，**不需要 `next()`**（`cordis\lib\index.js:280-294`）；
 *       只有 waterfall 事件才要 `next`（`:317-325`）——所以这里不碰 next。
 *   · 会话读取：`session.seq`（= 日志长度，`dsh-session\lib\index.js:1130`）、
 *     `session.eventAt(seq)`（0 基，`:1096`）、`session.inheritedEventCount`（`:1006`）、
 *     每条事件带 `time`（`:1185`）。
 *   · 助手消息：`assistant/message`，形状 `{turn, step, message:{role:'assistant',content:[...]}, ...}`
 *     （`dsh-agent-loop\lib\index.js:1050-1064`；`dsh-session\lib\index.js:928-949` 校验）。
 *     文本块是 `{type:'text', text}`（`dsh-llm\lib\index.js:79-81`）。
 *   · "最后的助手消息"的口径**照抄官方的主规则，但没有实现官方的流式兜底**：
 *     官方 `AssistantOutputFold`（`dsh-subagent\lib\index.js:158-221`）
 *     = **最后一条 content 非空**的 `assistant/message`；官方 `collect()`（`:203-210`）
 *     在**一条 assistant/message 都没有**的时候还有一条**流式文本兜底**
 *     （把 `assistant/message` / `assistant/attempt` 的 `data.stream` 累积成 `partial`，
 *     `:184-197`，最后合成一个 `{type:'text'}` 块）。
 *     ⚠ **本插件没有实现那条兜底** —— 这里只看得见会话事件，拿不到 transport 层
 *     推给 `pushText()` 的原始文本。所以"没有任何 assistant/message"时，
 *     本插件的结论是**不归档 + 记一行 `no-assistant-message` 失败**，
 *     而不是拿别的东西凑一段正文出来。
 *   · ★ **只看子代理自己的事件**（这条是 R42 返工 F1 的判据）：
 *     官方喂给 `collect()` 的是 `child.session.snapshotEvents(boundary)`，
 *     而 `boundary = child.session.seq` 是在 `start` 那一刻记下的
 *     （`dsh-subagent\lib\index.js:336-343`）—— 也就是**只吃子代理自己的事件**。
 *     fork 出来的子代理是**带 seed 建的**（`dsh-subagent-fork-in-process\lib\index.js:48-51`
 *     把 `seed` 交给 `startInProcessRun`）⇒ `header.isSeeded = true`、
 *     `inheritedEventCount = seed.length`（`dsh-session\lib\index.js:1006` 字段 /
 *     `:1081-1085` 赋值 / `:1583-1591` fork 时传值）。
 *     ⇒ 往父会话前缀里扫，就会把**主代理**那条 `assistant/message` 当成"角色发言"
 *       归档、还署上角色名 —— 这正是 F1。下界与"下界拿不到"的处理见 `ownEventRange`。
 *   · 角色名：子代理会话里有一条 `subagent/descriptor` 事件，字段 `{version,mode,provider,label}`，
 *     `label` 就是派它时给的 `description`（例如「审查」）——
 *     `dsh-subagent\lib\index.js:1301-1315 / 1393-1412`，
 *     写入点 `dsh-subagent-in-process-driver\lib\index.js:139-148,178`；
 *     工具 schema 里 `description` 是 `required: true`（`dsh-tool-subagent\lib\index.js:402-406`），
 *     所以正常情况下一定有值。**第一条 descriptor 权威**（`:1413-1417`），取到就返回。
 *   · 工程根判法：**照抄** `warden.mjs` 里 `findProjectRootVia` 的判法
 *     （向上找 `.git`；退路是最近的装着 `.warden` 的那一层；都没有就用 start 自己）。
 *     本文件**只读参考**，一个字节都没改那个文件。
 *     ⚠ 那份实现在"`.warden` 就在 start 自己身上"和"什么都没找到"两种情况下
 *       **都返回 `via:'self'`**（`:210` vs `:212`）—— 两种事实被压成了同一个字符串。
 *       为了能如实回答"工程根到底推出来了没有"，这里额外多返回一个 `found` 字段
 *       （`'git' | 'warden' | null`），`root`/`via` 的取值与 warden.mjs **逐条一致**。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

/** 归档目录名（R42 逐字：「每个项目默认开一个文件夹」）。 */
const DIR_NAME = '角色发言'
const README_NAME = 'README.md'
const INDEX_NAME = 'INDEX.md'
/** 落盘失败的台账（在 fallbackDir 里；**不在**工程里，避免"写不进去还往里写"）。 */
const FAIL_NAME = 'role-voices-failures.jsonl'
/**
 * 正文分隔线。**这一行的下一字节起就是角色原话**，一个字节都没有被改过。
 * 选一个不可能出现在正文里的形状（全角括号 + 固定文案），
 * 这样"正文 = 分隔线之后的全部字节"是一条无歧义的判据。
 */
const BODY_SEP = '--- 逐字正文开始（以下与角色说出的那段话逐字节相同：未润色 / 未截断 / 未总结 / 未重排） ---'
/** 短标题上限（R42 逐字：「别超过 40 字」）。按**码点**截，不会把 emoji 劈成半个。 */
const TITLE_MAX = 40
/** 角色名段上限（文件名要能一眼看，太长的 label 截断）。 */
const ROLE_MAX = 24
const INDEX_HEADER = '| 时间 | 角色 | 标题 | 字节 | 文件 |\n| --- | --- | --- | --- | --- |\n'
/** 用来判断"这份 INDEX.md 是不是本插件写的表"。 */
const INDEX_TABLE_SEP = '| --- | --- | --- | --- | --- |'
/**
 * ★ 已有 INDEX.md 但**不是**本插件的表时，只**追加**一个分节，绝不改写已有内容。
 *
 * 为什么需要这一条（真实场景，不是假想）：`<工程根>\角色发言\` 可能已经存在，
 * 里面可能已经有一份**别人/手工**写的 INDEX.md（例如"从会话日志手工归档的存量"，
 * 格式是标题 + 项目符号列表）。本插件只会**追加**，于是两套格式会挤在一个文件里。
 * 只追加一个分节标记 + 表头，至少让"哪几行是自动归档的"一眼看得出，
 * 而**已有内容一个字节都不动** —— 不许因为自动化而毁掉用户手工攒的东西。
 */
const INDEX_SECTION_MARK = '<!-- role-voices 自动归档（下表）从这里开始；以上内容由别处/手工产生，本插件未改动 -->'

/**
 * 挂的四个事件。**为什么是四个而不是一个**：子代理"结束"在 DSH 里有多个可观察边界，
 * 只挂一个的话，任何一条路径没走到就整条线静默失效（本 skill 反复踩过的坑）。
 * 四个都有 `payload.agent`，都会经过 `archive()` 里同一道 `origin === 'subagent'` 硬过滤
 * 和同一份去重表 —— 多挂只是多几次"看一眼就返回"，不会重复归档。
 */
const HOOKS = [
  ['agent/turn-stopping', (p) => (p && p.agent) || null, 'turn-stopping'],
  ['agent/status', (p) => (p && p.status === 'idle' && p.agent) || null, 'status:idle'],
  ['agent/error', (p) => (p && p.agent) || null, 'error'],
  ['agent/disposed', (p) => (p && p.agent) || null, 'disposed'],
]

// ────────────────────────────────────────────────────────────────────────────
// 纯函数区（自检直接调这些，跑的是同一条代码路径）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 工程根判法 —— 与 `warden.mjs:195-213` 的 `findProjectRootVia` **同一条约定**：
 *   1. 从 start 往上，第一个有 `.git` 的目录 ⇒ `{root, via:'git'}`；
 *   2. 一路没有 `.git`，退而取**最近的**装着 `.warden` 的那一层
 *      ⇒ 若那一层就是 start 自己，`via:'self'`；否则 `via:'ancestor-warden'`；
 *   3. 都没有 ⇒ `{root: start, via:'self'}`。
 * 额外返回 `found`（`'git' | 'warden' | null`）—— 因为上面第 2 条的 `self`
 * 与第 3 条的 `self` 是**同一个字符串**，光看 `via` 分不出"找到了"还是"没找到"。
 * 本插件必须能如实回答"工程根推出来了没有"，所以把这件事单独说出来。
 *
 * @param {string} start 起点目录（子代理会话的 `header.cwd`）。
 * @returns {{root:string, via:'git'|'ancestor-warden'|'self', found:'git'|'warden'|null}}
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
 *   · 控制字符 → 空格；
 *   · Windows 非法字符 `\ / : * ? " < > |` → 删掉；
 *   · 空白串 → 单个 `_`（避免空格把 markdown 链接切断）；
 *   · 去掉开头的 `.`/`_` 和结尾的 `.`（Windows 不允许结尾点）；
 *   · 按**码点**截到 max。
 * 不换词、不改写、不加省略号。
 *
 * @param {unknown} s 原文。
 * @param {number} max 码点上限。
 * @returns {string} 可安全用作文件名/表格单元格的一段文字（可能为空串）。
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

/** 会话 id 的短尾巴（`session-ccc30000-…-000000000000` → `00000000`）。 */
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
 * ★★ **子代理自己那段事件的下界** —— R42 返工 F1 的修法，整个插件只有这一处算它。
 *
 * 为什么必须有下界（官方口径，不是推理）：
 *   · 官方取"最终助手消息"喂进去的是 `child.session.snapshotEvents(boundary)`，
 *     `boundary` 在 `start` 时等于 `child.session.seq`（`dsh-subagent\lib\index.js:336-343`）
 *     ⇒ **只吃子代理自己的事件**，一个字节的父会话前缀都不吃。
 *   · fork 出来的子代理是**带 seed 建的**（`dsh-subagent-fork-in-process\lib\index.js:48-51`）
 *     ⇒ `header.isSeeded = true`、`inheritedEventCount = seed.length`
 *     （`dsh-session\lib\index.js:1583-1591`；字段在 `:1006`，赋值在 `:1081-1085`）。
 *   · 所以从 `total-1` 一路扫到 0 是**错的**：它会走进被继承的父会话前缀，
 *     把**主代理**那条 `assistant/message` 当成"角色发言"归档 + 署角色名 + 写 INDEX。
 *     审查的夹具实测过（`inheritedEventCount=3`，前缀一条主代理的话，子代理自己零发言
 *     ⇒ 归档正文 === 主代理那句话）。修法就是下界取 `Math.max(0, inheritedEventCount)`。
 *
 * ★ **这个下界不是我编的，它就是官方对"自己的事件"的定义**：
 *   `dsh-session\lib\index.js:1114-1128` —— `ownEvents()` 逐字是
 *   `this.snapshotEvents(this.inheritedEventCount)`，`isOwnSeq(seq)` 逐字是
 *   `seq >= this.inheritedEventCount && seq < this.seq`。
 *   本函数返回的 `[from, total)` 与这两条**逐字同构**（`from = max(0, inheritedEventCount)`，
 *   `total = seq`）。⇒ 用 `ownEvents()` 会拿到的正是这一段，一个事件不多、一个不少。
 *
 * ⚠ **下界拿不到时怎么办**：**不归档**，并如实记一行失败（`own-bound-unknown`）。
 *   绝不退回 0 —— 退回 0 就是上面那条洞本身（"拿不到"和"没有前缀"是两件事，
 *   压成同一个 0 就等于把主代理的话又放进来）。
 *   实证：`dsh-session\lib\index.js:1081` 是 `SessionLogOffset(suppliedInheritedEventCount ?? 0)`，
 *   也就是**真的 `Session` 实例上这个字段永远是数字**（无 seed 时是 0）。
 *   所以"拿不到"只可能出现在**不是 Session 的会话样对象**上 —— 那时宁可拒收。
 *
 * @param {object} session 子代理会话（`agent.session`）。
 * @returns {{ok:true, from:number, total:number}
 *          |{ok:false, reason:'session-unreadable'|'own-bound-unknown'|'own-bound-inconsistent', detail:string}}
 */
function ownEventRange(session) {
  if (!session || typeof session.eventAt !== 'function') {
    return { ok: false, reason: 'session-unreadable', detail: '会话没有 eventAt()，读不了事件' }
  }
  const total = Number(session.seq)
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, reason: 'session-unreadable', detail: 'session.seq 不是正数：' + JSON.stringify(session.seq) }
  }
  const raw = session.inheritedEventCount
  if (raw === undefined || raw === null || raw === '') {
    return {
      ok: false,
      reason: 'own-bound-unknown',
      detail: 'session.inheritedEventCount 拿不到（' + JSON.stringify(raw) + '）——'
        + '无法确定"子代理自己那段事件"从哪开始；退回 0 会把被继承的父会话前缀当成它自己的发言',
    }
  }
  const inherited = Number(raw)
  if (!Number.isFinite(inherited) || inherited < 0) {
    return { ok: false, reason: 'own-bound-unknown', detail: 'session.inheritedEventCount 不是非负有限数：' + JSON.stringify(raw) }
  }
  const from = Math.max(0, inherited)
  if (from > total) {
    return {
      ok: false,
      reason: 'own-bound-inconsistent',
      detail: 'inheritedEventCount=' + from + ' 比事件总数 seq=' + total + ' 还大（会话自相矛盾）',
    }
  }
  return { ok: true, from: from, total: total }
}

/**
 * 子代理会话里**第一条** `subagent/descriptor` 的 `label`（= 派它时给的 `description`）。
 * 「第一条权威」是官方口径（`dsh-subagent\lib\index.js:1413-1417`）：
 * 建立它的 provider 只会写一条，后来的同型事件不许改写已声明的组成。
 * 从 `ownEventRange` 的下界起扫（fork 出来的子代理，前面是父会话的事件，不是它的）；
 * 下界拿不到 ⇒ 返回空串（**不猜**，让 `roleName()` 退回短 id）。
 *
 * @returns {string} label；拿不到就是空串。
 */
function subagentLabel(session) {
  const range = ownEventRange(session)
  if (!range.ok) return ''
  for (let i = range.from; i < range.total; i++) {
    const ev = session.eventAt(i)
    if (ev && ev.type === 'subagent/descriptor') {
      const label = ev.data && ev.data.label
      return typeof label === 'string' ? label : ''
    }
  }
  return ''
}

/**
 * 这个子代理**最后一条 content 非空**的 `assistant/message` —— 口径照抄官方
 * `AssistantOutputFold` 的**主规则**（`dsh-subagent\lib\index.js:184-188`）：
 * 空 content 的消息只是记 usage 的，不覆盖先前输出。
 * ⚠ **官方那条流式文本兜底没有实现**（见文件头注释）；一条都没有 ⇒ 返回 `null`。
 *
 * ★ **只扫子代理自己的那段**（`ownEventRange`）：从 `total-1` 往回扫到**下界**为止，
 *   **绝不**扫进被继承的父会话前缀 —— 否则会把主代理的话当成角色发言（F1）。
 *   下界拿不到 ⇒ 返回 `null`（调用方 `archive()` 会因此拒收并记一行失败，不会误归档）。
 *
 * @param {object} session 子代理会话。
 * @param {{ok:true,from:number,total:number}|undefined} [range] 已经算好的下界（省一次重算）。
 * @returns {{seq:number, event:object, content:Array}|null}
 */
function lastAssistantMessage(session, range) {
  const r = range === undefined ? ownEventRange(session) : range
  if (!r || !r.ok) return null
  for (let i = r.total - 1; i >= r.from; i--) {
    const ev = session.eventAt(i)
    if (!ev || ev.type !== 'assistant/message') continue
    const content = ev.data && ev.data.message && ev.data.message.content
    if (Array.isArray(content) && content.length > 0) return { seq: i, event: ev, content: content }
  }
  return null
}

/**
 * 正文 = 该消息里所有 `{type:'text'}` 块的 `text` **原样首尾相接**。
 * 不插分隔符、不 trim、不换行归一 —— 任何一个"顺手"的动作都会破坏逐字性。
 * 非文本块（工具调用等）不进正文（那不是"角色说的话"），但**块构成会记在头部**，不隐藏。
 */
function textOf(content) {
  let out = ''
  if (!Array.isArray(content)) return out
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text
  }
  return out
}

/** 内容块构成，例如 `text×2, tool-call×1`（头部如实披露，避免"只贴了文本"看起来像截断）。 */
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
 * 短标题：正文**首行**（首行为空时退到第一条非空行），去掉开头的 markdown 标题井号，
 * 再按非法字符规则洗一遍，最多 40 字。
 * ⚠ 只对**标题**做这一步；正文一个字节都不动。
 */
function titleOf(text) {
  const lines = String(text).split(/\r?\n/)
  let line = lines.length > 0 ? lines[0] : ''
  if (line.trim() === '') {
    for (const l of lines) {
      if (l.trim() !== '') { line = l; break }
    }
  }
  const t = sanitizeSegment(line.replace(/^#+\s*/, ''), TITLE_MAX)
  return t === '' ? '无标题' : t
}

/** 角色名：descriptor.label → agent.label/meta.label/description → 短 id。 */
function roleName(agent, session, header) {
  const id = String((header && header.id) || (agent && agent.id) || '')
  const candidates = [
    ['subagent/descriptor.label', subagentLabel(session)],
    ['agent.label', agent && agent.label],
    ['agent.meta.label', agent && agent.meta && agent.meta.label],
    ['agent.description', agent && agent.description],
  ]
  for (const [from, raw] of candidates) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const name = sanitizeSegment(raw, ROLE_MAX)
    if (name !== '') return { name: name, from: from }
  }
  const name = sanitizeSegment(shortId(id), ROLE_MAX)
  return { name: name === '' ? 'unknown' : name, from: 'short-id' }
}

/** markdown 链接目标：CJK 保持原样，但 `# ? ( ) [ ] < >` 与空格必须编码，否则链接会被切断。 */
function linkSafe(name) {
  return encodeURI(String(name)).replace(/[#?()[\]<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** 表格单元格里的 `|` 必须转义，否则一行的标题会把整张表切坏。 */
function cell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** 归档文件的完整文本：头部 + 分隔线 + **逐字正文**（结尾不额外加换行 —— 最后一个字节就是原话最后一个字节）。 */
function renderArchive(meta, body) {
  const lines = [
    '# 角色发言 · 逐字归档',
    '',
    '- 时间: ' + formatHuman(meta.at) + '（' + new Date(meta.at).toISOString() + '）',
    '- 角色: ' + meta.role,
    '- 角色来源: ' + meta.roleFrom,
    '- 短 id: ' + meta.shortId,
    '- agent id: ' + meta.agentId,
    '- 会话 id: ' + meta.sessionId,
    '- 工程根: ' + meta.root + '（via ' + meta.via + '）',
    '- 归档键: ' + meta.key,
    '- 来源: ' + meta.source,
    '- 子代理自己的事件: seq ' + meta.ownFrom + '..' + (meta.ownTotal - 1)
      + '（inheritedEventCount=' + meta.inheritedEventCount + '；更小的 seq 是被继承的父会话前缀，不是它的发言）',
    '- 助手消息: assistant/message @ seq ' + meta.seq + '（time=' + meta.eventTime + '）',
    '- 内容块: ' + meta.blocks,
    '- 正文字节: ' + meta.bodyBytes,
    '- 正文 sha256: ' + meta.bodySha,
    '',
    BODY_SEP,
    '',
  ]
  return lines.join('\n') + body
}

/** 分隔线之后的**全部字节** = 逐字正文。自检与任何复核都用这一个函数，保证口径只有一份。 */
function extractBody(fileText) {
  const i = String(fileText).indexOf(BODY_SEP)
  if (i < 0) return null
  return String(fileText).slice(i + BODY_SEP.length + 1)
}

// ────────────────────────────────────────────────────────────────────────────
// 目录 / 落盘
// ────────────────────────────────────────────────────────────────────────────

function readmeText(dirName) {
  return [
    '# 角色发言 · 这是什么',
    '',
    '这是 **R42** 要的那个文件夹：**角色（子代理）自己说的话，逐字落在这里**。',
    '放在这里的意思是 —— 它**不进 AI 的上下文**（不占 token、不被转述），',
    '但**你（人）可以随时点进来读原话**。',
    '',
    '> 用户原话（R42）：',
    '> 「做一个硬机制，每个项目默认开一个文件夹放这些不需要放入上下文，',
    '> 但你可以阅读，我也可以点入阅读的文件夹。」',
    '',
    '## 谁写的、什么时候写',
    '',
    '一个常驻 host 插件：`role-voices.js`（`task-warden\\plugin\\`）。',
    '它挂在子代理（`agent.session.header.origin === \'subagent\'`）的**结束事件**上：',
    '`agent/turn-stopping` / `agent/status`(idle) / `agent/error` / `agent/disposed`。',
    '子代理一结束就落盘 —— **主代理不参与**，也不需要它记得去写。',
    '',
    '## 文件名怎么读',
    '',
    '    YYYY-MM-DD_HHMMSS__<角色名或短id>__<短标题>.md',
    '',
    '- 时间 = 那段话本身的时间（`assistant/message` 事件的 `time`），不是写盘时间；',
    '- 角色名 = 子代理自己会话里 `subagent/descriptor` 的 `label`',
    '  （就是派它时给的 `description`，例如「审查」）；拿不到就退回短 id；',
    '- 短标题 = 正文首行，去掉文件名非法字符，最多 40 个字；',
    '- 同一秒、同角色、同标题的两条发言不会互相覆盖：第二条起加 `-2` / `-3`。',
    '',
    '## 每个文件里有什么',
    '',
    '一段头部（时间 · 角色 · agent id · 工程根 · 归档键 · 来源 · 内容块构成 · 正文字节 · 正文 sha256），',
    '然后一行分隔线：',
    '',
    '    ' + BODY_SEP,
    '',
    '**分隔线以下的每一个字节就是角色说出的原文** —— 没有润色、没有截断、没有总结、没有重排。',
    '文件的最后一个字节，就是角色说的最后一个字节。',
    '把分隔线之后的字节做 sha256，应当与头部的「正文 sha256」完全相同。',
    '',
    '## INDEX.md',
    '',
    '一行一条：`时间 · 角色 · 标题 · 字节 · 文件链接`。',
    '`字节` = 归档文件的完整字节数（含头部）。',
    '写不进去的失败也会在这里留一行（`⚠ 归档失败`），不会被吞掉。',
    '',
    '## 不进上下文',
    '',
    '这个文件夹**不会被注入** systemPrompt / runtime context / 任何消息通道 ——',
    '插件里没有任何一处往上下文写东西。',
    '自检 `role-voices.selftest.mjs` 会把插件挂到假 ctx 上，',
    '列出它注册过的全部东西，逐条证明里面没有上下文相关的注册。',
    '',
  ].join('\n')
}

/**
 * 建目录 + README + INDEX（幂等；同一个根只做一次）。失败**不抛**，把原因交回调用方去如实记账。
 *
 * INDEX.md 的三种情况：
 *   ① 不存在 → 建一份带表头的空表；
 *   ② 存在、且已经是本插件的表（含表头分隔线）→ 什么都不做；
 *   ③ 存在、但是**别的格式**（手工存量等）→ **只追加**一个分节标记 + 表头，
 *      已有内容一个字节都不动（见 `INDEX_SECTION_MARK` 的注释）。
 */
function ensureArchiveDir(dir, dirName) {
  fs.mkdirSync(dir, { recursive: true })
  const readmePath = path.join(dir, README_NAME)
  if (!fs.existsSync(readmePath)) fs.writeFileSync(readmePath, readmeText(dirName), 'utf8')
  const indexPath = path.join(dir, INDEX_NAME)
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, INDEX_HEADER, 'utf8')
    return
  }
  let existing = ''
  try { existing = fs.readFileSync(indexPath, 'utf8') } catch (e) { existing = '' }
  if (existing.includes(INDEX_TABLE_SEP)) return
  fs.appendFileSync(indexPath, '\n' + INDEX_SECTION_MARK + '\n' + INDEX_HEADER, 'utf8')
}

/**
 * 写归档文件，**永不覆盖**：用 `wx` 独占创建，撞名就退到 `-2` / `-3`。
 * 返回真正落盘的文件名。
 */
function writeArchiveFile(dir, baseName, text) {
  const stem = baseName.replace(/\.md$/, '')
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

function indexLine(meta, fileName, bytes) {
  return '| ' + formatHuman(meta.at)
    + ' | ' + cell(meta.role)
    + ' | ' + cell(meta.title)
    + ' | ' + bytes
    + ' | [' + cell(meta.title) + '](' + linkSafe(fileName) + ') |\n'
}

function indexFailLine(rec) {
  return '| ' + formatHuman(Date.parse(rec.at) || Date.now())
    + ' | ⚠ 归档失败 | ' + cell(rec.reason + (rec.detail ? '：' + rec.detail : ''))
    + ' | - | - |\n'
}

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
// ────────────────────────────────────────────────────────────────────────────
// 插件本体
// ────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ `inject` 是**空的**，这是刻意的：
 *   Cordis 的 `inject` 是**硬依赖** —— 声明了却缺席，**整个插件**进 `waiting`。
 *   本插件**一个服务都不需要**（只读 `agent.session` 和写磁盘，都是普通对象/Node 内置），
 *   所以没有任何理由把它的生死绑在别人的加载顺序上。
 *   （确实要用可选服务时，正确写法是 `ctx.get('name')`，不是往 `inject` 里塞名字。）
 */
const name = 'role-voices'
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
  const dirName = typeof cfg.dirName === 'string' && cfg.dirName !== '' ? cfg.dirName : DIR_NAME
  const fallbackDir = typeof cfg.fallbackDir === 'string' && cfg.fallbackDir !== ''
    ? cfg.fallbackDir
    : (function () { try { return os.tmpdir() } catch (e) { return process.cwd() } })()
  const failPath = path.join(fallbackDir, FAIL_NAME)

  /** 已成功归档的「归档键」= `<agentId>#<assistant-message-seq>`。 */
  const seen = new Set()
  /** 已**如实记过**失败的归档键（同一个失败不刷屏；但换了消息 seq 就是新键，会重新尝试）。 */
  const reported = new Set()
  /** 已建好 README/INDEX 的归档目录。 */
  const ensured = new Set()
  const disposers = []

  /**
   * 如实记一次失败。**三个出口都试**，因为三条路各自会瞎：
   *   ① `<fallbackDir>\role-voices-failures.jsonl` —— 结构化、可机检（路径推不出时唯一能落的）；
   *   ② `console.error` —— 有人看 host stderr 就能立刻看到；
   *   ③ 归档目录可用时再往 `INDEX.md` 记一行 —— **用户点进去就看得到**。
   * 任何一步失败都绝不抛：记不上账不能反过来把轮次搞坏。
   */
  function report(key, info) {
    if (key) reported.add(key)
    const rec = Object.assign({ at: new Date().toISOString(), plugin: name }, info)
    let sinkOk = false
    try {
      fs.mkdirSync(fallbackDir, { recursive: true })
      fs.appendFileSync(failPath, JSON.stringify(rec) + '\n', 'utf8')
      sinkOk = true
    } catch (e) {
      try { console.error('[role-voices] 连失败台账都写不进去：' + String((e && e.message) || e)) } catch (e2) { /* 算了 */ }
    }
    try {
      console.error('[role-voices] 归档失败：' + JSON.stringify(rec))
    } catch (e) { /* 算了 */ }
    if (rec.dir) {
      try { fs.appendFileSync(path.join(rec.dir, INDEX_NAME), indexFailLine(rec), 'utf8') } catch (e) { /* 目录不可用，前面两路已经记过 */ }
    }
    return sinkOk
  }

  /**
   * ★★ **硬 hook 的落点**：子代理的结束事件直接进这里。
   * 主代理不参与、也不需要它知道 —— 这条路走的是 DSH 自己的事件派发。
   */
  function archive(agent, source) {
    let agentId = ''
    let key = ''
    try {
      if (!agent || typeof agent !== 'object') return
      const session = agent.session
      if (!session || typeof session !== 'object') return
      const header = session.header
      /**
       * ★ **硬过滤**：`origin === 'subagent'` 才算角色。
       * 主会话的 header **没有** `origin`（`dsh-session:790` 只允许它等于 `"subagent"`），
       * 所以主代理自己的回合边界在这里一眼就被挡掉 —— 一个字节都不写。
       */
      if (!header || header.origin !== 'subagent') return

      agentId = String(agent.id || header.id || '')
      /**
       * ★★ F1：**先算"子代理自己那段事件"的下界**，再拿最后一条助手消息。
       *   下界拿不到 ⇒ `picked` 必定为 null，而下面会走 `own-bound-*` 那条**拒收 + 记失败**；
       *   绝不退回 0（退回 0 就是"把主代理的话当成角色发言"那条洞）。
       */
      const range = ownEventRange(session)
      const picked = range.ok ? lastAssistantMessage(session, range) : null
      key = agentId + '#' + (range.ok ? (picked ? picked.seq : '-1') : 'own-bound')
      if (seen.has(key) || reported.has(key)) return

      const cwd = typeof header.cwd === 'string' && header.cwd.trim() !== ''
        ? header.cwd
        : (function () { try { return process.cwd() } catch (e) { return '' } })()
      const base = {
        agentId: agentId,
        sessionId: String(header.id || ''),
        cwd: String(cwd || ''),
        source: source,
        key: key,
      }

      if (base.cwd === '') {
        report(key, Object.assign({}, base, { reason: 'no-cwd', detail: '会话 header.cwd 缺失且 process.cwd() 也拿不到' }))
        return
      }

      const probe = findProjectRootVia(base.cwd)
      if (probe.found === null) {
        /**
         * ★ **工程根推不出** ⇒ 明确记一行失败，**不许静默吞**。
         * 判据 = 从 `cwd` 一路向上**既没有 `.git` 也没有 `.warden`** ⇒ 这不是任何工程的根，
         * 在这里凭空造一个 `角色发言\` 就是当年"`.warden` 落到容器目录上、
         * 两个项目读到对方守则"那一类事故的同构版本。宁可拒收并说清，也不撒野。
         */
        report(key, Object.assign({}, base, {
          reason: 'project-root-not-found',
          detail: '从 cwd 向上既没有 .git 也没有 .warden（via=' + probe.via + '）',
          start: base.cwd,
          root: probe.root,
          via: probe.via,
        }))
        return
      }

      const root = probe.root
      const dir = path.join(root, dirName)
      try {
        if (!ensured.has(dir)) {
          ensureArchiveDir(dir, dirName)
          ensured.add(dir)
        }
      } catch (e) {
        report(key, Object.assign({}, base, {
          reason: 'archive-dir-unusable',
          detail: String((e && e.message) || e),
          root: root,
          via: probe.via,
          dir: dir,
        }))
        return
      }

      const at = picked && Number.isFinite(picked.event.time) ? picked.event.time : Date.now()
      const role = roleName(agent, session, header)
      const short = sanitizeSegment(shortId(agentId), ROLE_MAX) || 'unknown'

      /**
       * ★★ F1 的拒收口：**"子代理自己那段事件"的下界拿不到** ⇒ 不归档。
       *   不退回 0，也不猜 —— 退回 0 就会走进被继承的父会话前缀，
       *   把主代理的 `assistant/message` 当成角色发言归档（审查实测过）。
       *   失败原因逐字区分：`own-bound-unknown`（字段拿不到）/
       *   `own-bound-inconsistent`（下界比日志还长）/ `session-unreadable`（读不了事件）。
       */
      if (!range.ok) {
        report(key, Object.assign({}, base, {
          reason: range.reason,
          detail: range.detail,
          root: root, via: probe.via, dir: dir, role: role.name,
        }))
        return
      }

      if (!picked) {
        report(key, Object.assign({}, base, {
          reason: 'no-assistant-message',
          detail: '这个子代理**自己那段事件**（seq ' + range.from + '..' + (range.total - 1)
            + '）里没有任何 content 非空的 assistant/message'
            + (range.from > 0 ? '（前面 seq 0..' + (range.from - 1) + ' 是被继承的父会话前缀，不算它的发言）' : ''),
          root: root, via: probe.via, dir: dir, role: role.name,
          ownFrom: range.from, ownTotal: range.total,
        }))
        return
      }

      const blocks = blockSummary(picked.content)
      const text = textOf(picked.content)
      if (text === '') {
        report(key, Object.assign({}, base, {
          reason: 'no-text-blocks',
          detail: '最后一条助手消息里没有 text 块（内容块：' + blocks + '）',
          root: root, via: probe.via, dir: dir, role: role.name, seq: picked.seq, blocks: blocks,
        }))
        return
      }

      const title = titleOf(text)
      const bodyBytes = Buffer.byteLength(text, 'utf8')
      const meta = {
        at: at,
        role: role.name,
        roleFrom: role.from,
        shortId: short,
        agentId: agentId,
        sessionId: base.sessionId,
        root: root,
        via: probe.via,
        key: key,
        source: source,
        ownFrom: range.from,
        ownTotal: range.total,
        inheritedEventCount: Number(session.inheritedEventCount),
        seq: picked.seq,
        eventTime: at,
        blocks: blocks,
        bodyBytes: bodyBytes,
        bodySha: sha256(text),
        title: title,
      }
      const text2 = renderArchive(meta, text)
      let fileName
      try {
        fileName = writeArchiveFile(dir, formatStamp(at) + '__' + role.name + '__' + title + '.md', text2)
      } catch (e) {
        report(key, Object.assign({}, base, {
          reason: 'archive-write-failed',
          detail: String((e && e.message) || e),
          root: root, via: probe.via, dir: dir, role: role.name, seq: picked.seq,
        }))
        return
      }
      const bytes = Buffer.byteLength(text2, 'utf8')
      try {
        fs.appendFileSync(path.join(dir, INDEX_NAME), indexLine(meta, fileName, bytes), 'utf8')
      } catch (e) {
        // 文件已经落盘了，这条不算"没归档"，但索引缺一行必须说出来
        report(key, Object.assign({}, base, {
          reason: 'index-append-failed',
          detail: String((e && e.message) || e),
          root: root, via: probe.via, dir: dir, role: role.name, seq: picked.seq, file: fileName,
        }))
      }
      seen.add(key)
    } catch (e) {
      /**
       * 兜底：这条路上任何未预期的抛错都**不许静默**。
       * ⚠ 也绝不往外抛 —— 本插件是看守，不是被看守的东西；
       *   它的异常绝不能反过来把子代理的结束流程搞坏。
       */
      report(key || (agentId + '#?'), {
        reason: 'archive-threw',
        detail: String((e && e.message) || e),
        stack: String((e && e.stack) || '').slice(0, 600),
        agentId: agentId,
        source: source,
      })
    }
  }

  for (const [evName, pick, label] of HOOKS) {
    /**
     * ⚠ 装不上就**抛**（让加载器把 "failed to apply loader entry" 报出来），
     *   而不是悄悄退化成"永不归档" —— 一个静默失效的看守比没有看守更坏。
     *   `ctx.on` 返回 disposer，并且它本身就是挂在当前 fiber 上的 effect
     *   （`cordis\lib\index.js:335-345`），fiber 卸载时自动摘除。
     */
    disposers.push(ctx.on(evName, function (payload) {
      archive(pick(payload), label)
    }))
  }

  /**
   * 把"摘除"这件事**显式化**：不依赖框架的 fiber 语义，自己再兜一层。
   * 幂等（重复调用只是再调一次 disposer），所以和 fiber 的自动摘除不冲突。
   */
  ctx.effect(() => () => {
    for (const d of disposers) {
      try { if (typeof d === 'function') d() } catch (e) { /* 摘除失败不该影响卸载 */ }
    }
  }, 'role-voices.dispose-hooks')
}

module.exports = {
  name: name,
  inject: inject,
  apply: apply,
  /**
   * 自检用。**为什么要暴露**：`role-voices.selftest.mjs` 要跑的必须是**同一份代码路径**
   * （工程根判法、逐字正文口径、文件名规则），另抄一份就等于没测。
   * 宿主加载器只取 `name`/`inject`/`apply`（`unwrapExports`），多余字段不影响挂载。
   */
  _internals: {
    DIR_NAME: DIR_NAME,
    README_NAME: README_NAME,
    INDEX_NAME: INDEX_NAME,
    FAIL_NAME: FAIL_NAME,
    BODY_SEP: BODY_SEP,
    TITLE_MAX: TITLE_MAX,
    HOOKS: HOOKS,
    INDEX_HEADER: INDEX_HEADER,
    INDEX_TABLE_SEP: INDEX_TABLE_SEP,
    INDEX_SECTION_MARK: INDEX_SECTION_MARK,
    findProjectRootVia: findProjectRootVia,
    sanitizeSegment: sanitizeSegment,
    shortId: shortId,
    formatStamp: formatStamp,
    formatHuman: formatHuman,
    sha256: sha256,
    subagentLabel: subagentLabel,
    ownEventRange: ownEventRange,
    lastAssistantMessage: lastAssistantMessage,
    textOf: textOf,
    blockSummary: blockSummary,
    titleOf: titleOf,
    roleName: roleName,
    linkSafe: linkSafe,
    renderArchive: renderArchive,
    extractBody: extractBody,
    indexLine: indexLine,
  },
}
