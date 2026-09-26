'use strict'
/* ============================================================================
 * context-dedup —— 上下文上传过滤（「相同」整块去重 + 「相似」按行去重）
 *
 * 需求 R41（用户逐字）：「（用户原话已隐去 —— 公开版不留逐字）」
 * 用户当面选定：
 *   · 范围 = 两者都做：① 新读到的实时去重 ＋ ② 对当前上下文做一次清理
 *   · 「相似」只按行做重叠剔除（整块相同的行省略、差异行照推）⇒ 信息零损失
 *
 * 这是**代码**，不是提示词。全篇没有一句"提醒模型注意"——只有 hook、声明、返回值。
 *
 * ------------------------------------------------------------------ 两条胳膊
 * ① 实时（tools/post-execute，prepend:true）
 *    在结果进上下文**之前**换掉它的 content。形状照抄 DSH 自己的 dsh-spill-policy
 *    （含 `{prepend:true}`、`Object.hasOwn(decision,'value')` 的绕行、
 *     `exec.parent !== void 0` 的嵌套跳过、`additionalContexts` 的转交）。
 * ② 清理（agent/pre-step）
 *    遍历 session.surface.nodes，对**当前上下文里**还没被处理过的 tool/result 节点
 *    做同一套判定；要换就按 DSH 自己的 dsh-compaction-tool-result-pruner 的写法换：
 *    先 append('compaction/prune', {...})，再 append('tool/result', {...},
 *    { surfaceOp: { op:'replace', startSeq, endSeq }, sourceEventSeqs:[seq] })。
 *    替换必须**更小**（原代码里有这条断言，这里也有）。
 *
 * ---------------------------------------------------------------- 零信息损失
 * · 「相同」档：整块换成一行指引，但**只在第一份还活在 surface 上时**才省略
 *   （硬约束 5）。原文可由"上文里那份"逐字节取回。
 * · 「相似」档：**每个被省略的行都留一个占位符 `[dup:<块号>:<行号>]`**，行号指向
 *   **第一个真正把该行推上去的那个块**里的原始行号。于是"省略后的内容 + 上文里
 *   已有的那些行"逐行拼回去 == 原文（逐字节）。这条在 selftest 里是一条**断言**。
 * · 「改完文件再读一遍必须照旧全文推」：指纹按**内容**算（归一化后 sha256）。
 *
 * --------------------------------------------------------------- 可逆 / 隔离
 * · 所有副作用都在 apply() 里通过 ctx.effect + ctx.on 注册，dispose / 重载时干净摘掉。
 * · 所有集合按**会话**隔离（state 以 session.header.id 为键）。
 *
 * 挂载方式见 context-dedup.DESIGN.md；本文件**不**自行挂载（不碰 cordis.patch.yml）。
 * ==========================================================================*/

const crypto = require('crypto')
const path = require('path')
const fs = require('fs')

/* ------------------------------------------------------------------ 插件形状 */
/** Cordis 插件名（loader 诊断用）。 */
const name = 'context-dedup'
/**
 * 不声明硬依赖：本插件监听事件，不调用任何服务的方法。
 * 可选服务（tokenMeter / toolResultPruner）一律走 ctx.get() 并在缺失时降级。
 */
const inject = []

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
 *   **只写 5 样**：插件 id / 版本串 / ISO 时间戳 / pid / 宿主给的插件实例 id（Cordis 的 `ctx.id`，
 *   它是 DSH 内部的**插件实例名**，**不是会话 id**，这一侧也从不读会话）。
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
 * @param {*}      hostId   宿主注入的插件实例 id（Cordis 的 `ctx.id`），没有就不写这个键
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
const VERSION = '1.0.0-loadmark'

/* -------------------------------------------------------------------- 默认值 */
const DEFAULTS = Object.freeze({
  /** 只处理够大的结果：小于它就整块不动（换指引反而更费 token）。 */
  minChars: 512,
  /** 「非平凡行」的长度下限（按 trim 后的字符数）。 */
  minLineChars: 12,
  /** 行索引的条数上限，超了按插入顺序 FIFO 淘汰（只影响节省率，不影响正确性）。 */
  maxIndexedLines: 200000,
  /** 是否开启 ② 清理那一档。 */
  cleanup: true,
  /**
   * 是否开启「相似」那一档（按行重叠剔除）。
   * 置 false ⇒ 只剩「逐字节相同」那一档：内容只要变了一个字节就**照旧全文推**。
   * 默认 true —— 这是用户当面选定的"相似档"。
   */
  similar: true,
})
const KNOWN_KEYS = Object.freeze(['minChars', 'minLineChars', 'maxIndexedLines', 'cleanup', 'similar'])

/* -------------------------------------------------------------------- 记号 */
/** 「相同」档换上去的指引行（用户给的格式，逐字照抄）。 */
const GUIDANCE_RE = /^\[与第 (\d+) 次 ([\s\S]+?) 的结果逐字节相同，已省略 (\d+) 字符；原文在上下文里\]$/
/** 「相似」档的头部。 */
const HEADER_RE = /^\[(\d+) 行与第 (\d+) 次 ([\s\S]+?) 重复已省略\]$/
/** 「相似」档逐行占位符。 */
const MARKER_RE = /^\[dup:(\d+):(\d+)\]$/
/** 只要文本里**任何位置**出现占位符形状就放弃"相似"档（防重建歧义）。 */
const MARKER_ANY_RE = /\[dup:\d+:\d+\]/
/** 未知工具名时的占位（清理档遇到的、插件装载之前就已经在上下文里的结果）。 */
const UNKNOWN_TOOL = '(未知工具)'

/* ------------------------------------------------------------------ 小工具 */
/**
 * 归一化：只把行尾 CRLF / CR 统一成 LF。
 * **故意不做别的**（不 trim、不去空行）—— 否则"归一化"就变成有损的了。
 */
function normalizeNewlines(text) {
  return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n')
}

/**
 * 内容指纹：**归一化行尾之后**的 sha256（十六进制）。
 * 归一化只做一件事：CRLF / CR -> LF。
 *
 * ⚠ **这不是零字节损失**：CRLF 的那份与 LF 的那份会被判成"相同" ⇒ 省掉之后，
 *   从上下文里取回的是 **LF 的那一份**（自检 T15 把这条行为固定下来）。
 * ⚠ **出处别记错**：这条归一化写在**任务书**里
 *   （`角色发言\2026-09-24\2026-09-24_6b995737_你是 实现工程师 。本单要新.md:86`
 *    的「逐字节相同（归一化后指纹相同）」）——
 *   **用户 R41 的逐字原话里没有这句**（`.warden/SPEC.md:565` 只有「可否增加一个功能…」）。
 * ⇒ 本档的不变量精确表述是「**归一化行尾后**逐字节相同」；除行尾之外，
 *   任何字节差异都会改变指纹（selftest 里有这条负控）。
 */
function fpOf(text) {
  return crypto.createHash('sha256').update(normalizeNewlines(text), 'utf8').digest('hex')
}

/** Unicode 码点数（不分配数组，大字符串也不炸内存）。 */
function cpLen(s) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

/** 把 ContentBlock[] 压成一个字符串；只要有一块不是 text 就返回 undefined（照 spill-policy）。 */
function flattenText(content) {
  if (!Array.isArray(content)) return undefined
  let out = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') return undefined
    out += block.text
  }
  return out
}

/** 是不是我们自己写上去的记号行（指引 / 头部 / 占位符）。 */
function isOurMarkerLine(line) {
  return GUIDANCE_RE.test(line) || HEADER_RE.test(line) || MARKER_RE.test(line)
}

/** 这段文本是不是我们自己换上去的（看第一行）。 */
function isOurOutput(text) {
  const nl = text.indexOf('\n')
  const first = nl === -1 ? text : text.slice(0, nl)
  return GUIDANCE_RE.test(first) || HEADER_RE.test(first)
}

/**
 * 「非平凡行」的判定 —— 只有非平凡行才允许被按行省略。
 * 平凡（trivial）= 一定会被原样推上去：
 *   · trim 后长度 < minLineChars（含空行、短行、以及我们自己的占位符）
 *   · trim 后不含任何"实义字符"（数字/拉丁字母/希腊/西里尔/CJK/假名/谚文）
 *     ⇒ 纯括号、纯大括号、纯分隔线（----、====、****）、纯标点都算平凡
 * ⚠ 判定用 trim 后的形态，但**索引的键是原样行文本** —— 否则重建出来的缩进会和
 *   原文不一致，那就成了有损的（见 decideRewrite 里的说明）。
 */
const MEANINGFUL_RE = /[0-9A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
function isTrivialLine(line, minLineChars) {
  const t = line.trim()
  if (t.length < minLineChars) return true
  if (!MEANINGFUL_RE.test(t)) return true
  return false
}

/** 深冻结（等价于 @deepseek-ai/dsh-llm 的 freezeMessage 内部那一步）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

let freezeMessageFn
let freezeMessageProbed = false
/**
 * 取真正的 freezeMessage（@deepseek-ai/dsh-llm）。
 * ⚠ 实测：从本文件所在目录 `require('@deepseek-ai/dsh-llm')` 是 **MODULE_NOT_FOUND**
 *   （该包只装在 DSH 自己的 node_modules 里）。所以这里**先试真的**，拿不到就退回
 *   本地等价实现 —— dsh-llm 的实现逐字是 `deepFreeze(structuredClone(message))`，
 *   本地这份与它同构。这样插件在任何 cwd 下都起得来，且不引第三方依赖。
 */
function loadFreezeMessage() {
  if (freezeMessageProbed) return freezeMessageFn
  freezeMessageProbed = true
  try {
    const mod = require('@deepseek-ai/dsh-llm')
    if (mod && typeof mod.freezeMessage === 'function') freezeMessageFn = mod.freezeMessage
  } catch (error) {
    freezeMessageFn = undefined
  }
  return freezeMessageFn
}

/** 冻结一份替换后的消息。 */
function freezeMessageLike(message) {
  const real = loadFreezeMessage()
  if (real !== undefined) return real(message)
  return deepFreeze(structuredClone(message))
}

/**
 * 记一条日志。日志坏了**绝不许**影响主流程 —— 所以整个函数体裹在 try 里。
 * （apply 里的 `log` 与 sweepSession 里的悬空告警共用这一个。）
 */
function logVia(ctx, level, message) {
  try {
    if (ctx !== undefined && ctx !== null && ctx.logger !== undefined && ctx.logger !== null && typeof ctx.logger[level] === 'function') ctx.logger[level](message)
  } catch (error) {
    /* 算了 */
  }
}

/* ------------------------------------------------------------------ 配置解析 */
function resolveConfig(raw) {
  const cfg = raw === undefined || raw === null ? {} : raw
  if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('context-dedup: config must be an object')
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_KEYS.includes(key)) throw new Error(`context-dedup: unknown config key "${key}" (allowed: ${KNOWN_KEYS.join(', ')})`)
  }
  const minChars = cfg.minChars === undefined ? DEFAULTS.minChars : cfg.minChars
  const minLineChars = cfg.minLineChars === undefined ? DEFAULTS.minLineChars : cfg.minLineChars
  const maxIndexedLines = cfg.maxIndexedLines === undefined ? DEFAULTS.maxIndexedLines : cfg.maxIndexedLines
  const cleanup = cfg.cleanup === undefined ? DEFAULTS.cleanup : cfg.cleanup
  const similar = cfg.similar === undefined ? DEFAULTS.similar : cfg.similar
  if (!Number.isInteger(minChars) || minChars < 1) throw new Error(`context-dedup: minChars must be a positive integer (got ${minChars})`)
  if (!Number.isInteger(minLineChars) || minLineChars < 1) throw new Error(`context-dedup: minLineChars must be a positive integer (got ${minLineChars})`)
  if (!Number.isInteger(maxIndexedLines) || maxIndexedLines < 1) throw new Error(`context-dedup: maxIndexedLines must be a positive integer (got ${maxIndexedLines})`)
  if (typeof cleanup !== 'boolean') throw new Error(`context-dedup: cleanup must be a boolean (got ${typeof cleanup})`)
  if (typeof similar !== 'boolean') throw new Error(`context-dedup: similar must be a boolean (got ${typeof similar})`)
  return Object.freeze({ minChars, minLineChars, maxIndexedLines, cleanup, similar })
}

/* ================================================================== 状态 ===== */
/**
 * 一个会话一份 state。
 *
 * **永久**表（只在会话销毁时随 state 一起删；块号单调、跨 sweep 稳定 ——
 * 这是占位符 `[dup:块号:行号]` 在任意次重建之后依然指得对的原因）：
 *   blocks           块号 -> 块记录
 *   textFpToBlock    "此刻在上下文里的那段文本"的指纹 -> 块号（用来认 surface 节点）
 *   dupIndex         **原文**指纹 -> 那个"逐字节原样推上去"的块号（整块去重查它）
 *   toolNameByCallId callId -> 工具名（tool/result 事件里没有工具名，只能这么学）
 *   toolOccurrence   工具名 -> 已登记块数（算"第 N 次"）
 *   stats            省了多少（可机检）
 *
 * 每次 sweep **重建**的表（它们描述"此刻上下文里有什么"）：
 *   idx.liveDup    原文指纹 -> 还活着的原样块号
 *   idx.liveBlocks 还活着的块号
 *   idx.lineOwner  原样行文本 -> { blockId, lineNo }（第一个真正把它推上去的块）
 */
function newState() {
  return {
    blocks: new Map(),
    textFpToBlock: new Map(),
    dupIndex: new Map(),
    toolNameByCallId: new Map(),
    toolOccurrence: new Map(),
    blockCounter: 0,
    lineKeys: [],
    idx: null,
    built: false,
    gen: -1,
    nodeCount: -1,
    lastToolResultSeq: -1,
    sweptAtToolResultSeq: -1,
    stats: {
      dupBlocks: 0,
      similarBlocks: 0,
      charsBefore: 0,
      charsAfter: 0,
      savedChars: 0,
      savedTokenEstimate: 0,
      sweeps: 0,
      armRewrites: 0,
      cleanupRewrites: 0,
      skippedOwnerGuard: 0,
      /**
       * **悬空 owner 计数**（① 的真记账）：我们写下的记号行（指引 / 占位符）还留在
       * 上下文里，但它指向的原文**已经不在**了（owner 被 compaction / 体积剪枝搬走）。
       * 每检出**一个**这样的节点 +1（同一批悬空在又一次全量重建时会被再记一次 ⇒
       * 它是"检出次数（单调累加）"，不是瞬时表；引用条数进日志）。
       * 判据与记账见 `auditOurOutput` / `sweepSession` 末尾；正控见自检 T23。
       */
      danglingOwner: 0,
      /**
       * **本趟 sweep 检出的悬空条数**（瞬时键，与上面的累加键成对）。
       * 每趟 sweep **入口**清零，按这一趟真正走到的结果重算。
       *
       * 为什么要两个键：累加数**只增不减**，回答不了"**此刻**上下文里有没有假话、有几条"；
       * 瞬时键回答"**最近这一趟**核出几条"。两个都留是因为它们回答的是两个不同的问题。
       *
       * ⚠ **口径别误读**（这一条必须一起读）：
       *   · 它只统计**这一趟 sweep 真正访问到的**记号行。**全量重建**那一趟访问全部节点
       *     ⇒ 此刻它 = "整个 surface 上的悬空条数"；**增量**那一趟只访问新增节点、
       *     **早退**那一趟一个节点都不访问。
       *   · 早退（surface 自上次 walk 之后没有任何变化）也**会**在入口清零
       *     ⇒ `danglingOwnerNow === 0` 的含义是"**这一趟没检出**"，
       *     **不是**"此刻一定没有假话"。
       *   · 判"此刻"：`> 0` ⇒ **一定有**；`=== 0` ⇒ 看这一趟是否真的走过（全量重建那趟才是完整的）。
       *     历史面看 `danglingOwner`，事实面看 `log('warn', …)`。
       * 判定性对照见自检 **T23**（健康 0/0 → evict 2/2 → 再跑一趟 0/2）。
       */
      danglingOwnerNow: 0,
    },
  }
}

function freshIndex() {
  return { liveDup: new Map(), liveBlocks: new Set(), lineOwner: new Map() }
}

function nextBlockId(st, toolName) {
  st.blockCounter += 1
  const blockId = st.blockCounter
  const occ = (st.toolOccurrence.get(toolName) || 0) + 1
  st.toolOccurrence.set(toolName, occ)
  return { blockId, occurrence: occ }
}

/** 登记一个"逐字节原样进了上下文"的块（它是整块去重的候选 owner）。 */
function registerVerbatim(st, text, toolName) {
  const fp = fpOf(text)
  const { blockId, occurrence } = nextBlockId(st, toolName)
  const rec = {
    blockId,
    originalFp: fp,
    emittedTextFp: fp,
    toolName,
    occurrence,
    chars: cpLen(text),
    verbatim: true,
  }
  st.blocks.set(blockId, rec)
  st.textFpToBlock.set(fp, blockId)
  st.dupIndex.set(fp, blockId)
  return rec
}

/** 登记一个"我们改写过、推上去的是另一段文本"的块（只能当行 owner，不能当整块 owner）。 */
function registerRewritten(st, originalFp, outputText, toolName) {
  const outFp = fpOf(outputText)
  const { blockId, occurrence } = nextBlockId(st, toolName)
  const rec = {
    blockId,
    originalFp,
    emittedTextFp: outFp,
    toolName,
    occurrence,
    /* chars 记的是**进上下文的那份**的大小：owner 护栏比的是"体积剪枝会不会挖到它"，
       而体积剪枝看的就是 surface 上这份。 */
    chars: cpLen(outputText),
    verbatim: false,
  }
  st.blocks.set(blockId, rec)
  st.textFpToBlock.set(outFp, blockId)
  return rec
}

/**
 * 把一段文本里"确实进了上下文"的非平凡行登记成行索引（第一个登记者即 owner）。
 * `lineNo` = 该行在**这个块实际推上去的那份文本**里的 1-based 行号 ——
 * 因为读者（模型）手上有的就是那份文本，重建时按它取行才对得上。
 */
function indexNodeText(idx, rec, text, cfg, st) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isOurMarkerLine(line)) continue
    if (isTrivialLine(line, cfg.minLineChars)) continue
    if (!idx.lineOwner.has(line)) {
      idx.lineOwner.set(line, { blockId: rec.blockId, lineNo: i + 1 })
      st.lineKeys.push(line)
    }
  }
  if (st.lineKeys.length > cfg.maxIndexedLines) {
    const over = st.lineKeys.length - cfg.maxIndexedLines
    for (let i = 0; i < over; i++) idx.lineOwner.delete(st.lineKeys[i])
    st.lineKeys.splice(0, over)
  }
}

/* ============================================================== 判定核心 ===== */
/**
 * 对一个**新到的**文本做判定。**只查"它上面有什么"**，绝不查它自己 ——
 * 这条是"重建时不会把自己判成自己的重复"的根本保证。
 *
 * @returns null（不动）| {kind:'dup',...} | {kind:'similar',...}
 */
function decideRewrite(text, idx, cfg, opts) {
  const selfBlockId = opts.selfBlockId
  const guardChars = opts.guardChars
  const blocks = opts.blocks
  const stats = opts.stats
  const chars = cpLen(text)

  /* ---- 档一：「相同」（逐字节，归一化后指纹相同） ---- */
  const fp = fpOf(text)
  const hit = idx.liveDup.get(fp)
  /* ⚠ 加固（③）：`liveDup` 里那个 owner 必须同时被 `liveBlocks` corroborate。
     两者只在"块被撤出 liveBlocks、却还留在 liveDup 里"时分叉 —— 而那正是唯一
     能让"原文在上下文里"变成假话的分叉（撤出时 liveDup 的删除是有条件的）。
     少省一点，绝不写假话。 */
  if (hit !== undefined && hit !== selfBlockId && idx.liveBlocks.has(hit)) {
    const rec = blocks.get(hit)
    if (rec !== undefined && rec.verbatim === true) {
      if (guardChars <= 0 || rec.chars <= guardChars) {
        const guide = `[与第 ${rec.occurrence} 次 ${rec.toolName} 的结果逐字节相同，已省略 ${chars} 字符；原文在上下文里]`
        const guideChars = cpLen(guide)
        if (guideChars < chars) {
          return {
            kind: 'dup',
            text: guide,
            ownerBlockId: hit,
            omittedLines: 0,
            charsBefore: chars,
            charsAfter: guideChars,
          }
        }
      } else if (stats !== undefined) {
        stats.skippedOwnerGuard += 1
      }
    }
  }

  /* ---- 档二：「相似」（按行做重叠剔除） ---- */
  /* cfg.similar === false ⇒ 这一档整体关掉：内容变一个字节就照旧全文推。 */
  if (cfg.similar !== true) return null
  /* 防重建歧义：原文里只要出现占位符形状，就整块照推（不省这一块，但绝不猜错）。 */
  if (MARKER_ANY_RE.test(text)) return null

  const lines = text.split('\n')
  const kept = new Array(lines.length)
  const ownerCount = new Map()
  let omitted = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isTrivialLine(line, cfg.minLineChars)) {
      kept[i] = line
      continue
    }
    /* 键是**原样行文本**（不 trim）：这样重建出来才和原文逐字节一致。 */
    const own = idx.lineOwner.get(line)
    if (own !== undefined && own.blockId !== selfBlockId) {
      const rec = blocks.get(own.blockId)
      if (rec === undefined || !idx.liveBlocks.has(own.blockId)) {
        /* ⚠ 加固（③）：owner 必须**此刻确实活着**（与档一同一条理由）。
           这一行原样推；这**不是**体积护栏放弃的，所以不记 skippedOwnerGuard。 */
      } else if (guardChars <= 0 || rec.chars <= guardChars) {
        const ph = `[dup:${own.blockId}:${own.lineNo}]`
        /* 只有"占位符比原行短"才省 —— 否则省了反而更费 token。 */
        if (cpLen(line) > cpLen(ph)) {
          kept[i] = ph
          omitted += 1
          ownerCount.set(own.blockId, (ownerCount.get(own.blockId) || 0) + 1)
          continue
        }
      } else if (stats !== undefined) {
        stats.skippedOwnerGuard += 1
      }
    }
    kept[i] = line
  }
  if (omitted === 0) return null

  /* 头部里的"第 N 次 <tool>"取**贡献省略行最多**的那个 owner（并列取块号小的）。 */
  let bestBlockId = -1
  let bestN = -1
  for (const entry of ownerCount) {
    const bid = entry[0]
    const n = entry[1]
    if (n > bestN || (n === bestN && bestBlockId !== -1 && bid < bestBlockId)) {
      bestN = n
      bestBlockId = bid
    }
  }
  const best = blocks.get(bestBlockId)
  const ownerTool = best === undefined ? UNKNOWN_TOOL : best.toolName
  const ownerOcc = best === undefined ? 1 : best.occurrence
  const header = `[${omitted} 行与第 ${ownerOcc} 次 ${ownerTool} 重复已省略]`
  const newText = `${header}\n${kept.join('\n')}`
  const newChars = cpLen(newText)
  if (newChars >= chars) return null

  return {
    kind: 'similar',
    text: newText,
    ownerBlockId: bestBlockId,
    omittedLines: omitted,
    charsBefore: chars,
    charsAfter: newChars,
  }
}

/* ============================================================ 体积剪枝护栏 == */
/**
 * pruner（`@deepseek-ai/dsh-compaction-tool-result-pruner`）的**默认阈值**，
 * 逐字取自它自己的 `DEFAULTS.thresholdChars`（该包 `lib/index.js:11`）。
 *
 * ⚠ 这是"取不到服务"时的兜底，**不是 0**：在本文件里 `guardChars = 0` 的含义是
 *   "**不设限**"（判定条件写的是 `guardChars <= 0 || rec.chars <= guardChars`）
 *   ⇒ 兜底写 0 就等于**把护栏整个关掉**。而"取不到服务" ≠ "一定没有剪枝"：
 *   这两种语义**不许**被合成一个 0。单向更安全 —— 宁可少省一点，
 *   **绝不写一句"原文在上下文里"的假话**（护栏失效时用户损失的是：那一份结果的
 *   中段被永久换成 `[... tool result middle pruned ...]`，而上下文里只留一行假话）。
 */
const PRUNER_DEFAULT_THRESHOLD_CHARS = 8192

/**
 * 若 DSH 的 toolResultPruner（按大小剪中间那档）**在线**，它随时可能把某个 owner
 * 块的中间挖掉 —— 那时我们的"原文在上下文里"就成了假话。所以：它在线时，只对
 * **不会被它剪到**的 owner 省略（owner 进上下文那份的字符数 <= 它的阈值）。
 *
 * 取不到服务 / 服务没有可用阈值 / 读取抛错 ⇒ 一律退回 `PRUNER_DEFAULT_THRESHOLD_CHARS`
 * （8192），**不是 0**（0 = 不设限 = 护栏失效）。阈值现读现用，改它的配置不用重启本插件。
 * 自检 T17（看得见剪枝器）+ T22（看不见剪枝器 ⇒ 兜底 8192）三条控都跑。
 */
function ownerGuardChars(ctx) {
  try {
    const pruner = ctx.get('toolResultPruner')
    if (pruner === undefined || pruner === null) return PRUNER_DEFAULT_THRESHOLD_CHARS
    const cfg = pruner.config
    if (cfg !== undefined && cfg !== null && Number.isInteger(cfg.thresholdChars) && cfg.thresholdChars > 0) return cfg.thresholdChars
    return PRUNER_DEFAULT_THRESHOLD_CHARS
  } catch (error) {
    return PRUNER_DEFAULT_THRESHOLD_CHARS
  }
}

/* ============================================================ ① 实时那一档 == */
/** 从 exec 上取所属会话（照 spill-policy 的 ownerSessionId）。 */
function ownerSession(exec) {
  return exec && exec.agent && exec.agent.session
}

/* ================================================= 悬空 owner 的判定与记账 == */
/**
 * 一条**指引行**指向的 owner 块 —— 按指引自己报出来的「第 N 次 <tool>」去找。
 *
 * ⚠ 为什么**不**靠 `textFpToBlock`：**指引文本永远不在那张表里**。
 *   我们只把"内容块"登记进 `textFpToBlock`；指引行是"指向别处的一行字"，
 *   从来没被登记过（实测：`textFpToBlock.has(fpOf(指引文本)) === false`，
 *   而 `textFpToBlock.has(fpOf(原文)) === true`）。
 *   ⇒ 照字面写"isOurOutput 但 textFpToBlock 查不到就记悬空"，会把**每一条健康的
 *     指引行**都记成悬空。判据必须是"它**指向**的那个 owner 还在不在"。
 * @returns 块记录，或 undefined（指引指向的块根本不存在）
 */
function ownerOfGuidance(st, text, lookup) {
  const m = GUIDANCE_RE.exec(text)
  if (m === null) return undefined
  const occurrence = Number(m[1])
  const toolName = m[2]
  /* 有查表就用查表（O(1)）；没有就现扫（O(块数)）。sweep 会传查表，见 buildGuidanceOwnerLookup。 */
  if (lookup !== undefined && lookup !== null) return lookup.get(`${toolName}\u0000${occurrence}`)
  for (const rec of st.blocks.values()) {
    if (rec.verbatim === true && rec.toolName === toolName && rec.occurrence === occurrence) return rec
  }
  return undefined
}

/**
 * `"<工具名>\u0000<第几次>"` → **原样块**记录。
 * 一趟 sweep 只建**一次**（O(块数)），之后每条指引行查它是 O(1) ——
 * 否则"每条记号行都扫一遍全部块"会变成 O(记号行数 × 块数)。
 * （`(toolName, occurrence)` 是唯一的：`nextBlockId` 对每次登记都递增 occurrence 计数器。）
 */
function buildGuidanceOwnerLookup(st) {
  const lookup = new Map()
  for (const rec of st.blocks.values()) {
    if (rec.verbatim === true) lookup.set(`${rec.toolName}\u0000${rec.occurrence}`, rec)
  }
  return lookup
}

/** 一段文本里所有占位符 `[dup:B:L]` 指向的块号（去重）。 */
function markerBlockIds(text) {
  const out = new Set()
  for (const line of text.split('\n')) {
    const m = MARKER_RE.exec(line)
    if (m !== null) out.add(Number(m[1]))
  }
  return out
}

/**
 * 核一遍"我们写下的这条记号行，此刻还能不能取回原文"（① 的**真**记账）。
 *
 * 悬空的三种形状（同根因：owner 被 compaction / 体积剪枝搬走，而记号行还在）：
 *   · 指引行指向的 owner 块在 `blocks` 里**找不到**（那个"第 N 次 <tool>"没了）；
 *   · 指引行指向的 owner 块**不在 `idx.liveBlocks` 里**（§7.3：原文已不在上下文里）；
 *   · 「相似」档的占位符 `[dup:B:L]` 指向的块 B 不在 `idx.liveBlocks` 里
 *     （**同样是 §7.3**：owner 被搬走后，那一份里的每个占位符都取不回任何一行）。
 * 没有悬空时**保持 0**（正控见自检 T23）。
 *
 * @returns {{dangling: boolean, refs: number}} refs = 悬空的引用条数（指引算 1 条；
 *   「相似」档按**取不回的那些占位符**计）。⚠ `stats.danglingOwner` 记的是**节点数**
 *   （每个悬空节点 +1，见 sweepSession 末尾），refs 只进日志，不进 stats。
 */
function auditOurOutput(st, idx, text, lookup) {
  const nl = text.indexOf('\n')
  const first = nl === -1 ? text : text.slice(0, nl)
  if (GUIDANCE_RE.test(first)) {
    const owner = ownerOfGuidance(st, text, lookup)
    if (owner === undefined) return { dangling: true, refs: 1 }
    if (!idx.liveBlocks.has(owner.blockId)) return { dangling: true, refs: 1 }
    return { dangling: false, refs: 0 }
  }
  /* 剩下的只可能是「相似」档的头部 —— `isOurOutput` 只认这两种形状。 */
  let refs = 0
  for (const blockId of markerBlockIds(text)) {
    if (!idx.liveBlocks.has(blockId) || st.blocks.get(blockId) === undefined) refs += 1
  }
  return { dangling: refs > 0, refs }
}

/**
 * 走一遍当前 surface，做两件事：
 *   (a) 重建/续建"此刻上下文里有什么"的索引；
 *   (b) 对**还没被实时档处理过**的 tool/result 节点做同一套判定，该换就换。
 *
 * 增量为什么安全：`surface.replaceGeneration` 只在**位置替换**时变。gen 没变 ⇒
 * surface 只增不改 ⇒ 前 nodeCount 个节点原样有效，索引可以续用。
 */
function sweepSession(session, st, ctx, cfg) {
  /* 瞬时键：每趟 sweep **入口**清零（含早退那一趟 —— 口径见 newState 里 danglingOwnerNow 的注释）。 */
  if (st !== undefined && st !== null && st.stats !== undefined && st.stats !== null) st.stats.danglingOwnerNow = 0
  if (session === undefined || session === null) return null
  if (typeof session.eventAt !== 'function') return null
  const surface = session.surface
  if (surface === undefined || surface === null || !Array.isArray(surface.nodes)) return null

  const gen = surface.replaceGeneration
  const nodes = surface.nodes

  /* 便宜的先退出：gen 没变、也没有新的 tool/result 落盘 ⇒ 什么都不用做。 */
  if (st.built === true && st.gen === gen && st.lastToolResultSeq === st.sweptAtToolResultSeq) {
    return { swept: 0, rewritten: 0, charsRemoved: 0, skipped: true }
  }

  let idx
  let start
  if (st.built === true && st.gen === gen && st.idx !== null && st.nodeCount <= nodes.length) {
    idx = st.idx
    start = st.nodeCount
  } else {
    idx = freshIndex()
    st.idx = idx
    st.lineKeys = []
    start = 0
  }

  const guardChars = ownerGuardChars(ctx)
  const pending = []
  let rewritten = 0
  let charsRemoved = 0
  /**
   * 这一趟 walk 里**已经出现过**的指纹。
   * 它区分两种"指纹已经认识"的场面：
   *   · 这个指纹是**本次 walk 里更早的某个节点**推上去的 ⇒ 当前节点是它的重复，
   *     `selfBlockId` 必须留空（否则会把自己的 owner 当成自己排除掉 —— 这正是
   *     "插件装载前就有的重复永远清不掉"那个 bug）；
   *   · 这个块是**实时档在上一轮就登记好的**（本次 walk 之前）⇒ 它就是这个节点
   *     自己的块，行索引里已经有它自己的行 ⇒ 必须排除自己。
   */
  const walkedFp = new Set()
  /**
   * 这一趟 walk 里见到的、**我们自己的输出**节点（指引行 / 「相似」档头部+占位符）。
   * 走完之后统一核一次"它指向的那个 owner 此刻还在不在" —— 见 `auditOurOutput`。
   * 为什么放到走完之后：`liveBlocks` 要等整趟走完（含落盘那一轮）才反映"落盘后的现实"。
   */
  const ourNodes = []

  for (let i = start; i < nodes.length; i++) {
    const seq = nodes[i]
    const ev = session.eventAt(seq)
    if (ev === undefined || ev === null) continue

    /* tool/result 事件里没有工具名 —— 顺手从 assistant/message 的 tool-call 块学。 */
    if (ev.type === 'assistant/message') {
      harvestToolNames(st, ev)
      continue
    }
    if (ev.type !== 'tool/result') continue

    const block = ev.data && ev.data.message && ev.data.message.content && ev.data.message.content[0]
    if (block === undefined || block === null || block.isError === true) continue
    if (ev.data.error !== undefined) continue
    const text = flattenText(block.content)
    if (text === undefined) continue
    const fp = fpOf(text)

    /* 我们自己换上去的节点：按它**实际推上去的行**重建索引，然后放过。 */
    if (isOurOutput(text)) {
      const bid = st.textFpToBlock.get(fp)
      if (bid !== undefined) {
        const rec = st.blocks.get(bid)
        markLive(idx, st, bid, rec)
        indexNodeText(idx, rec, text, cfg, st)
      }
      ourNodes.push({ seq, text })
      continue
    }

    const callId = ev.data.message.source && ev.data.message.source.callId
    const knownBid = st.textFpToBlock.get(fp)
    let rec
    let createdHere = false
    if (knownBid === undefined) {
      const toolName = (typeof callId === 'string' && st.toolNameByCallId.get(callId)) || UNKNOWN_TOOL
      rec = registerVerbatim(st, text, toolName)
      createdHere = true
    } else {
      rec = st.blocks.get(knownBid)
    }
    if (rec === undefined) continue
    markLive(idx, st, rec.blockId, rec)

    /* 本次 walk 里更早出现过同一个指纹 ⇒ 这个节点是重复，owner 不是"自己"。 */
    const isRepeatInWalk = walkedFp.has(fp)
    walkedFp.add(fp)
    const selfBlockId = isRepeatInWalk ? -1 : rec.blockId

    if (rec.verbatim === false) {
      /* 这个块推上去的是改写过的文本；而此刻节点文本不是我们的记号形状
         ⇒ 只能按原文位置索引，且不再重判（上次没落成，再判一次只会来回抖）。 */
      indexNodeText(idx, rec, text, cfg, st)
      continue
    }

    if (cfg.cleanup === true && cpLen(text) >= cfg.minChars) {
      const decision = decideRewrite(text, idx, cfg, {
        selfBlockId,
        guardChars,
        blocks: st.blocks,
        stats: st.stats,
      })
      if (decision !== null) {
        pending.push({ seq, ev, decision, rec, fp, createdHere })
        continue
      }
    }
    indexNodeText(idx, rec, text, cfg, st)
  }

  /* 先判定、后落盘：判定用的是"落盘之前的 surface"，这正是"第一份还在不在"的真值。 */
  for (const item of pending) {
    const applied = applyReplacement(session, item.seq, item.ev, item.decision.text, ctx)
    if (applied === null) {
      /* 落盘被拒（或没有变小）：把这一块按**原样**补进索引，绝不让它消失。 */
      indexNodeText(idx, item.rec, flattenText(item.ev.data.message.content[0].content) || '', cfg, st)
      continue
    }
    /* 这个节点现在装的是改写后的文本 ⇒ 原文不再完整地在上下文里了。
       ⚠ 只有当这个块**是本次为这个节点建的**时才把它撤出 live 集合 ——
         如果它其实是更早那个 owner 的块（本次 walk 里发现节点是重复），
         那个 owner 还好端端地在 surface 上，撤了它会让后面的重复再也省不掉。 */
    if (item.createdHere === true) {
      idx.liveBlocks.delete(item.rec.blockId)
      if (idx.liveDup.get(item.fp) === item.rec.blockId) idx.liveDup.delete(item.fp)
    }

    if (item.decision.kind === 'similar') {
      const outRec = registerRewritten(st, item.fp, item.decision.text, item.rec.toolName)
      markLive(idx, st, outRec.blockId, outRec)
      indexNodeText(idx, outRec, item.decision.text, cfg, st)
    }
    rewritten += 1
    charsRemoved += applied.charsBefore - applied.charsAfter
    st.stats.cleanupRewrites += 1
    recordSavings(st, item.decision.kind, applied.charsBefore, applied.charsAfter)
  }

  /* ---- ① 悬空 owner 的**真**记账 ----------------------------------------
     走完之后再核：此刻 `liveBlocks` 已经反映"落盘后的现实"，于是"记号行还在、
     它指向的 owner 已经不在了"这件事第一次变得**可机检**。
     ⚠ 这是**加记账**，不是加提示词：没有任何一句"提醒模型注意"，只有计数 + 日志。
     ⚠ 口径：记的是**悬空节点数**（每个悬空节点 +1）。两个键同时 +1：
        `danglingOwner` = 历史累计（只增）；`danglingOwnerNow` = 本趟检出（入口已清零）。
        同一批悬空在**又一次全量重建**时会被再记一次 ⇒ 累加键是"检出次数（单调累加）"，
        不是"此刻有几条"的瞬时表；悬空的**引用条数**（例如「相似」档那份里 29 个占位符
        全部取不回）进日志。 */
  /* 只有这一趟真的见到记号行时才建查表（建一次 O(块数)，之后每条指引 O(1)）。 */
  const guidanceLookup = ourNodes.length === 0 ? undefined : buildGuidanceOwnerLookup(st)
  for (const node of ourNodes) {
    const audit = auditOurOutput(st, idx, node.text, guidanceLookup)
    if (audit.dangling !== true) continue
    st.stats.danglingOwner += 1
    st.stats.danglingOwnerNow += 1
    logVia(ctx, 'warn', `context-dedup: 悬空 owner —— seq ${node.seq} 上还留着记号行，但它指向的原文已不在上下文里（${audit.refs} 处引用取不回）：${JSON.stringify(node.text.slice(0, 80))}`)
  }

  st.built = true
  st.nodeCount = nodes.length
  st.sweptAtToolResultSeq = st.lastToolResultSeq
  st.stats.sweeps += 1
  /* 落盘之后 surface 的 gen 变了 —— 记**新的**那个，索引描述的正是落盘后的现实。 */
  st.gen = session.surface === undefined || session.surface === null ? gen : session.surface.replaceGeneration
  return { swept: nodes.length - start, rewritten, charsRemoved, skipped: false }
}

/** 把一个块标成"此刻活着"，原样块同时进整块去重表。 */
function markLive(idx, st, blockId, rec) {
  idx.liveBlocks.add(blockId)
  if (rec !== undefined && rec !== null && rec.verbatim === true && !idx.liveDup.has(rec.originalFp)) {
    idx.liveDup.set(rec.originalFp, blockId)
  }
}

/** 从 assistant/message 的 tool-call 块学 callId -> 工具名。 */
function harvestToolNames(st, ev) {
  const message = ev.data && ev.data.message
  const content = message && message.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') {
      st.toolNameByCallId.set(block.id, block.name)
    }
  }
}

/**
 * 把 surface 上的一个 tool/result 节点换成更小的文本。
 * 写法逐条照抄 DSH 自己的 dsh-compaction-tool-result-pruner：
 *   先 compaction/prune（把被遮蔽的节点定价），再 tool/result + surfaceOp.replace。
 * @returns { replacementSeq, charsBefore, charsAfter } 或 null（不许换）
 */
function applyReplacement(session, seq, ev, newText, ctx) {
  const block = ev.data.message.content[0]
  const before = cpLen(flattenText(block.content) || '')
  const after = cpLen(newText)
  /* 替换必须是"更小"的 —— 原代码里有这条断言，这里也守住。 */
  if (!(after < before)) return null

  let tokenCount
  try {
    const meter = ctx.get('tokenMeter')
    if (meter !== undefined && meter !== null && typeof meter.estimateMessage === 'function') {
      tokenCount = meter.estimateMessage(ev.data.message)
    }
  } catch (error) {
    tokenCount = undefined
  }
  if (typeof tokenCount !== 'number' || !Number.isFinite(tokenCount)) tokenCount = Math.ceil(before / 4)

  const message = freezeMessageLike({
    ...ev.data.message,
    content: [{ ...block, content: [{ type: 'text', text: newText }] }],
  })

  session.append('compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount: tokenCount,
  })
  const replacement = session.append('tool/result', { ...ev.data, message }, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],
  })
  return {
    replacementSeq: replacement === undefined || replacement === null ? undefined : replacement.seq,
    charsBefore: before,
    charsAfter: after,
  }
}

/** 记一笔"省了多少"（字符是精确的；token 是估算）。 */
function recordSavings(st, kind, before, after) {
  const saved = before - after
  st.stats.charsBefore += before
  st.stats.charsAfter += after
  st.stats.savedChars += saved
  st.stats.savedTokenEstimate += Math.max(0, Math.round(saved / 4))
  if (kind === 'dup') st.stats.dupBlocks += 1
  else st.stats.similarBlocks += 1
}

/* ================================================================= apply ===== */
/**
 * 每个 apply 实例一条读数记录，供 readStats / statsAll 读取。
 * 用 Set（不是 WeakMap）：WeakMap 不可枚举，而"可机检地报出省了多少"必须能枚举。
 * 记录在 dispose 时移除，所以不会长期占着 ctx。
 */
const statsRegistry = new Set()

function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig)
  const byId = new Map()
  const byObject = new WeakMap()

  /* ★ 加载即留痕：**整个插件生命周期里只写这一次**（不在任何热路径上）。
   *   写失败静默降级（`markPluginLoaded*` 内部已经吞掉所有异常）。
   *   位置选在 `apply()` 最前面：宿主调用 `apply` 本身就等于"这个插件加载成功了"，
   *   所以留痕不该等任何后续步骤 —— 哪怕下面 `resolveConfig` 抛了，留痕也已经如实写下。 */
  markPluginLoadedWithRetry(name, VERSION, ctx && ctx.id)

  let lastStatusWriteAt = 0
  const STATUS_PATH = path.join(__dirname, 'context-dedup.status.json')
  function flushStatus() {
    try {
      const now = Date.now()
      if (now - lastStatusWriteAt < 3000) return
      lastStatusWriteAt = now
      const sessions = []
      for (const entry of byId) {
        sessions.push(Object.assign({ sessionId: entry[0] }, entry[1].stats))
      }
      fs.writeFileSync(STATUS_PATH, JSON.stringify({
        enabled: true,
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        sessionCount: sessions.length,
        sessions,
      }, null, 2), 'utf8')
    } catch (e) { /* 状态文件写坏不影响主流程 */ }
  }
  flushStatus()

  function stateFor(session) {
    const id = session && session.header && session.header.id
    if (typeof id === 'string' && id.length > 0) {
      let st = byId.get(id)
      if (st === undefined) {
        st = newState()
        byId.set(id, st)
      }
      return st
    }
    let st = byObject.get(session)
    if (st === undefined) {
      st = newState()
      byObject.set(session, st)
    }
    return st
  }

  function log(level, message) {
    logVia(ctx, level, message)
  }

  /* 所有副作用都挂在这一个 effect 上：dispose / 重载时一次性摘干净。 */
  ctx.effect(() => {
    const offs = []

    /* ---- ① 实时：结果进上下文之前换掉它（prepend，照 spill-policy） ---- */
    offs.push(ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      try {
        if (decision === undefined || decision === null || decision.kind !== 'accept') return decision
        if (Object.hasOwn(decision, 'value')) return decision
        /* 嵌套 / 复合调用不处理（照 spill-policy）：那些不走模型上下文这一路。 */
        if (exec === undefined || exec === null || exec.parent !== void 0) return decision
        /* 硬约束 ②：失败的结果一律不动。 */
        if (result === undefined || result === null || result.isError === true) return decision

        const session = ownerSession(exec)
        if (session === undefined || session === null) return decision
        const st = stateFor(session)

        const text = flattenText(decision.content !== undefined ? decision.content : result.content)
        if (text === undefined) return decision
        const chars = cpLen(text)
        /* 硬约束 ③：只处理够大的（小结果换指引反而更费 token）。 */
        if (chars < cfg.minChars) return decision

        /* 索引必须"此刻仍然有效"：surface 被谁换过位置（gen 变了）就这一轮不判，
           等下一次 pre-step 的 sweep 重建。宁可少省，绝不错省。 */
        const gen = session.surface === undefined || session.surface === null ? -1 : session.surface.replaceGeneration
        if (st.built !== true || st.gen !== gen || st.idx === null) return decision

        const toolName = typeof exec.name === 'string' && exec.name ? exec.name : UNKNOWN_TOOL
        if (typeof exec.callId === 'string' && exec.callId) st.toolNameByCallId.set(exec.callId, toolName)

        const decisionOut = decideRewrite(text, st.idx, cfg, {
          selfBlockId: -1,
          guardChars: ownerGuardChars(ctx),
          blocks: st.blocks,
          stats: st.stats,
        })

        const fp = fpOf(text)

        if (decisionOut === null) {
          /* 没有任何可省的：**一个字节都不改**，原样把 decision 交回去。
             但仍要把这一份登记进索引 —— 同一轮里后面的相同结果才能省。
             ⚠ 只有当"已有的那个块确实还活着且是原样的"时才跳过登记；否则
               这一段内容在索引里就没有主，后面的重复就再也省不掉。 */
          const knownBid = st.textFpToBlock.get(fp)
          const knownRec = knownBid === undefined ? undefined : st.blocks.get(knownBid)
          if (knownRec === undefined || knownRec.verbatim !== true || !st.idx.liveBlocks.has(knownRec.blockId)) {
            const rec = registerVerbatim(st, text, toolName)
            markLive(st.idx, st, rec.blockId, rec)
            indexNodeText(st.idx, rec, text, cfg, st)
          }
          return decision
        }

        if (decisionOut.kind === 'dup') {
          /* 整块被换掉：这一段内容**不再完整地在上下文里**，不登记新块。
             owner 的那份本来就在 surface 上，会被 sweep 认到，不用在这里动。 */
          st.stats.armRewrites += 1
          recordSavings(st, 'dup', decisionOut.charsBefore, decisionOut.charsAfter)
          log('info', `context-dedup: 整块相同，省略 ${decisionOut.charsBefore - decisionOut.charsAfter} 字符（${toolName}）`)
          flushStatus()
          return {
            kind: 'accept',
            content: [{ type: 'text', text: decisionOut.text }],
            ...(decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {}),
          }
        }

        /* 「相似」：推上去的是改写后的文本 —— 登记成一个只能当行 owner 的块。 */
        const outRec = registerRewritten(st, fp, decisionOut.text, toolName)
        markLive(st.idx, st, outRec.blockId, outRec)
        indexNodeText(st.idx, outRec, decisionOut.text, cfg, st)
        st.stats.armRewrites += 1
        recordSavings(st, 'similar', decisionOut.charsBefore, decisionOut.charsAfter)
        log('info', `context-dedup: 按行相似，省略 ${decisionOut.charsBefore - decisionOut.charsAfter} 字符（${toolName}）`)
        flushStatus()
        return {
          kind: 'accept',
          content: [{ type: 'text', text: decisionOut.text }],
          ...(decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {}),
        }
      } catch (error) {
        /* 我们自己坏了 ⇒ 放行原样结果（绝不让一次工具调用因为本插件而失败）。 */
        log('warn', `context-dedup: post-execute 判定失败，原样放行：${String(error && error.message ? error.message : error)}`)
        return decision
      }
    }, { prepend: true }))

    /* ---- 落盘观测：记住最后一个 tool/result 的 seq（sweep 靠它便宜地早退） ---- */
    offs.push(ctx.on('session/event', (session, event) => {
      try {
        if (event === undefined || event === null || event.type !== 'tool/result') return
        const st = stateFor(session)
        st.lastToolResultSeq = event.seq
      } catch (error) {
        /* 观测坏了不影响主流程 */
      }
    }))

    /* ---- ② 清理：每个 step 之前，对当前上下文做一次 ---- */
    if (cfg.cleanup === true) {
      offs.push(ctx.on('agent/pre-step', async (payload, next) => {
        try {
          const session = payload && payload.agent && payload.agent.session
          if (session !== undefined && session !== null) {
            const st = stateFor(session)
            const out = sweepSession(session, st, ctx, cfg)
            if (out !== null && out.rewritten > 0) {
              log('info', `context-dedup: 清理当前上下文，改写 ${out.rewritten} 个结果，省 ${out.charsRemoved} 字符`)
              flushStatus()
            }
          }
        } catch (error) {
          log('warn', `context-dedup: 清理失败，放行：${String(error && error.message ? error.message : error)}`)
        }
        return next()
      }))
    }

    /* ---- 会话销毁 ⇒ 立刻丢掉它的全部集合（按会话隔离 + 不留垃圾） ---- */
    offs.push(ctx.on('session/disposed', (session) => {
      try {
        const id = session && session.header && session.header.id
        if (typeof id === 'string') byId.delete(id)
      } catch (error) {
        /* 算了 */
      }
    }))

    return () => {
      try { fs.writeFileSync(STATUS_PATH, JSON.stringify({ enabled: false, updatedAt: new Date().toISOString(), pid: process.pid, sessionCount: 0, sessions: [] }, null, 2), 'utf8') } catch (e) { /* dispose 写状态失败不影响清理 */ }
      for (const off of offs) {
        try {
          off()
        } catch (error) {
          /* dispose 自己不许抛 */
        }
      }
    }
  }, 'context-dedup: post-execute / session-event / pre-step / session-disposed')

  /* 把读数登记进模块级注册表（自检 / 运维可机检地读到"省了多少"）。 */
  ctx.effect(() => {
    const holder = { byId, byObject, stateFor }
    statsRegistry.add(holder)
    return () => {
      statsRegistry.delete(holder)
    }
  }, 'context-dedup: stats registry')
}

/* --------------------------------------------------------------- 对外读数 -- */
/** 某个会话省了多少（没这个会话就返回 null）。 */
function readStats(session) {
  const id = session && session.header && session.header.id
  for (const holder of statsRegistry) {
    if (typeof id === 'string' && id.length > 0) {
      if (holder.byId.has(id)) return Object.assign({ sessionId: id }, holder.byId.get(id).stats)
      continue
    }
    if (holder.byObject.has(session)) return Object.assign({ sessionId: null }, holder.byObject.get(session).stats)
  }
  return null
}

/** 本进程里所有会话的读数。 */
function statsAll() {
  const out = []
  for (const holder of statsRegistry) {
    for (const entry of holder.byId) out.push(Object.assign({ sessionId: entry[0] }, entry[1].stats))
  }
  return out
}

/* ------------------------------------------------------------ 自检用的出口 -- */
/**
 * 自检需要在不挂载真 DSH 的前提下调用内部件。
 * 这些导出**只**给 context-dedup.selftest.mjs 用；运行时没有任何人依赖它们。
 */
const __internals = {
  DEFAULTS,
  PRUNER_DEFAULT_THRESHOLD_CHARS,
  resolveConfig,
  cpLen,
  fpOf,
  normalizeNewlines,
  flattenText,
  isTrivialLine,
  isOurMarkerLine,
  isOurOutput,
  decideRewrite,
  indexNodeText,
  freshIndex,
  newState,
  registerVerbatim,
  registerRewritten,
  markLive,
  sweepSession,
  applyReplacement,
  recordSavings,
  ownerGuardChars,
  ownerOfGuidance,
  buildGuidanceOwnerLookup,
  markerBlockIds,
  auditOurOutput,
  logVia,
  freezeMessageLike,
  statsRegistry,
  GUIDANCE_RE,
  HEADER_RE,
  MARKER_RE,
  MARKER_ANY_RE,
}

module.exports = {
  name,
  inject,
  apply,
  readStats,
  statsAll,
  __internals,
}
