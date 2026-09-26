'use strict'
/*
 * branch-guard —— R44「支线守门员」的**硬闸**那一半。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 这个文件要治的病（用户逐字，R44）：「（用户原话已隐去 —— 公开版不留逐字）」（追加：「正好这些都写成代码。」）
 *
 * 实测现状（不是猜的）：
 *   · `warden.mjs:2807/2811` 里支线守门员**自己写着** `【信号】只提醒不拦` —— 那是**提示词**；
 *   · `warden.mjs:2810` 把失衡**只渲染成一行字**写进 `.warden/MAP.md`；
 *   · 同文件 `warden.mjs:2974` 留着自认的洞：
 *     「重审永远先排热门支线 → 冷支线永远排不上队 = **用流程把冷支线静默丢掉**。」
 *     ⚠ **行号更正（S5，2026-09-24 审查核出）**：上一版这里写的是 `:1844` —— 那是**另一段**
 *     （`DUTY.jsonl` 的注释）。实测 `grep -n '冷支线永远排不上队'` ⇒ **唯一命中 `2974`**；
 *     自检 ㉔ 现在把这一行号钉住（逐字存在 + 行号 = 实测行号）。
 *   ⇒ **计算已经有了，缺的是"拦"。** 本文件把 `{kind:'deny', reason}` 接到
 *     `tools/pre-execute` 上（形状照 `plugin/warden-watch.js:489-524` 抄）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 判据**逐字**取自 `warden.mjs` 的 `renderMap()`（只读、不许改那个文件），见 DESIGN.md §2：
 *   · `renderMap` 的失衡判据（`warden.mjs:2710`）：`d.lastRound === null || d.gap >= 3`
 *     → 本文件的 `STALE_GAP = 3`，**同一个数**；
 *   · `gap = maxRound - lastRound`（`warden.mjs:2692`）；
 *   · "动过"的判据（`warden.mjs:2663-2665`）：子项的 `[R#]` 命中 ROUNDS 的 `requirement`
 *     **或**子项的 `关键词` 出现在 ROUNDS 的 `delivered`/`why` 里 —— 一模一样；
 *   · "判不了就说判不了"（`warden.mjs:2684-2696`）：没挂 R# 也没关键词 ⇒ `basis=false`，
 *     **不算被丢**（那是账本没记，不是产品没做）。
 *   ★ 本文件**只加了一个触发前提**（不是换标准）：必须同时存在"正在被细化的热支线"
 *     且被丢的 ≥ 2 条，才动手拦 —— `renderMap` 只列出来，它不拦。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 三条硬约束（写死在代码里，不是靠自觉）：
 *   ① fail-open：判据/IO/解析任何一步出错 ⇒ **放行**（`preToolDecision` 的 try/catch）。
 *      误拦 = 用户干活被卡 = 比不拦更坏。
 *   ② 非写工具**零 IO 放行**（`read`/`glob`/`grep`/`todo`/`present`/…）—— 拦它们会死锁。
 *   ③ 补救的路**永不拦**：`.warden/**` 下的账本文件、以及任何 `node …warden.mjs …` 命令。
 *   ④ ★ **印在理由里给人抄的东西，必须逐字可抄、且真的存在**（本单最有价值的产出）：
 *      · `--req <R#>` **不硬编** —— 从**触发闸门的那本账**的 `SPEC.md` 里查（`findGuardReq`）；
 *        查不到 ⇒ **不印 `--req`**。理由：`R#` **不跨账**（同号不同物）—— 实测
 *        同一对需求号在**两本不同的账**里指的是**两条不同的需求**（一本里是「界面要显示」，
 *        另一本里是别的东西）。硬编一个号 = 指到**另一条需求**。
 *      · 理由里出现的每一条 `warden.mjs <子命令>` 都必须在该文件的命令表里**真的存在**
 *        （`missingWardenCommands()`，自检 ⑲ 拿真理由 + 一个负控钉住）。
 *        **上一版在这里印过 `node warden.mjs branch park` —— 那条命令 grep 0 处，是假出路。**
 *      · 理由里**不印**"三条硬规矩"（那是 R43 的 `handover-gate.js` 的事）；自检 ㉕ 钉住这一点，
 *        免得以后有人凭记忆抄进来、又把引号抄成弯引号（权威源 `派单模板.md` 用的是 U+0022）。
 *   ⑤ 归属口径**不许只印一个数**（`caliberSpread()`）：并集 / 只用 `[R#]` / 只用关键词
 *      三个"被丢下"的条数一起印 —— 判据对口径极敏感，见 DESIGN §3.2。
 *
 * ★ 这是**减速带，不是路障**（如实描述，不自夸）：默认 `MAX_DENIES=2` 次/会话、
 *   两次之间至少 `COOLDOWN_MS=60s`；之后一律放行。理由里逐字写着这条出路。
 *   ⇒ 它拦得住的是「**无声地**继续细化」；拦不住「再试一次」。
 *   要真正的路障，得先补上 DESIGN.md §6 那笔账（ROUNDS.jsonl 的 `branch` 字段）。
 *
 * ★ 不进模型上下文：本文件**只**用 `ctx.on` / `ctx.effect`（见 `apply`），
 *   从不碰 systemPrompt / context / 消息通道；诊断只写 stderr + 临时区 JSONL。
 *   `selftest.mjs` 用例 ⑧ 用 Proxy 录下对 `ctx` 的**每一次**访问来证明这一点。
 */

const nodeFs = require('fs')
const nodePath = require('path')
const nodeOs = require('os')

// ============================================================ 判据参数（可调，见 DESIGN §3）
/**
 * 为什么是这几个数（不是拍的）——见 DESIGN.md §3 的完整理由，这里给一行版：
 *   STALE_GAP 3     ：**照抄 `warden.mjs:2710`**，不许自己另定一个数（否则就是两套标准）。
 *   HOT_GAP 2       ：`renderMap` 把 gap≤0 叫"本轮"。放到 2 是因为一轮可能只记一条需求，
 *                     支线在"本轮/上一轮/上上轮"都算还在手上 —— 放宽热支线只会**减少**误拦。
 *   MIN_DROPPED 2   ：只丢 1 条时"失衡"的证据太薄（可能就是那一轮没轮到它）⇒ 不拦。
 *   WINDOW 6        ：最近 6 轮 = 用户说的"最近一段时间"。6 轮是本账本的常见一轮粒度。
 *   MIN_COVERAGE .5 ：最近 6 轮里至少 3 轮能归属到某条支线，否则"只碰了一条"推不出来 ⇒ 放行。
 *   MAX_DENIES 2 / COOLDOWN 60s：减速带的"软"度；见上面 ★。
 */
const DEFAULT_CFG = {
  STALE_GAP: 3,
  HOT_GAP: 2,
  MIN_DROPPED: 2,
  WINDOW: 6,
  MIN_COVERAGE: 0.5,
  /**
   * ③「冷支线不许被流程饿死」的两条腿（满足任一条即算"被饿死"）——**实测逼出来的**：
   *   只写"窗口里碰到的全是热支线"（腿 A）在**本账本当前状态下不成立**：
   *   实测某账本第 96~101 轮碰了 {K,M,C,V} 四条，K 不热 ⇒ 腿 A 挂。
   *   ⚠ **措辞不许说成"永远不成立"（S6，2026-09-24 审查）**：审查自造夹具腿 A 能真；
   *   而且同一本真账本上，K 的唯一命中来自 round 97 的**关键词子串**（`[R#]` 命中 0）——
   *   把那次关键词命中拿掉，touched 就变成 {M,C,V} ⊆ 热 ⇒ 腿 A 立刻为真。
   *   可那本账的真相是 **26 条支线里 23 条被丢下（并集口径 88%，三个口径见 caliberSpread）**，
   *   最近 6 轮只碰了其中 4 条（15%）。那正是 R44 说的"别的支线被忽视" ⇒ 补一条**集中度**腿 B。
   */
  CONCENTRATION: 0.25,   // 最近 W 轮碰过的支线 ≤ 全项目的 25%
  DROPPED_FRAC: 0.5,     // 且**过半**支线被丢下（项目级忽视，不是"这一轮没轮到它"）
  MAX_DENIES: 2,
  COOLDOWN_MS: 60000,
  DETAIL_MAX: 25,          // 逐条点名的详列上限；超出部分仍**逐条列 id**，只是压成一行
  ALLOW_ANCESTOR_LEDGER: false,  // 祖先账本默认**关**（本机踩过"两个项目读到对方守则"）
}
/**
 * ⚠ **减速带的放大（S4，2026-09-24 审查实测，如实写出来）**：
 *   `state.denies` / `state.lastDenyAt` **按 sessionId 分桶** ⇒ `MAX_DENIES=2` 是**每会话**的预算。
 *   真形状下"6 个子代理并行" = **6 个 sessionId** ⇒ 最多 **2N = 12 次**减速带，**不是 2 次**。
 *   自检 ⑤ 原来用**同一个 sessionId**（只看到 ≤2），⑤b 补上真形状（6 个 sessionId ⇒ 断言 2N）。
 *   这不是"判据坏了"，是"预算是每会话的"；但它意味着**并行度会线性放大摩擦**，写在 DESIGN §3.3。
 */

/** 会被本闸门看的工具（写文件）。**不含** read/glob/grep/todo/present —— 见约束②。 */
const WRITE_TOOLS = ['edit', 'write']
/** shell 类：只有命令里出现**写动作**才多看一眼（照 `gate.mjs:234` 的形状）。 */
const SHELL_TOOLS = ['pwsh', 'bash', 'sh', 'shell', 'run', 'exec', 'cmd']
const WRITE_HINTS = /(>>|>|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Clear-Content|tee\b|sed\s+-i|truncate|dd\s|chmod\s|echo\s.*>)/i
/** 记账/看图命令 = 补救的路 ⇒ 永不拦（否则"叫你记账"变成死结）。 */
const LEDGER_CMD = /warden\.mjs/i
const PATH_FIELDS = ['file_path', 'filePath', 'path', 'filename', 'target_file', 'notebook_path']

// ============================================================ 小工具
function deBom(s) { return String(s == null ? '' : s).replace(/^\uFEFF/, '') }

function readText(fs, p) {
  try { return fs.readFileSync(p, 'utf8') } catch (e) { return '' }
}

/** 路径归一（反斜杠→斜杠、折叠、小写）——照 `gate.mjs:468` 的教训：只做①会让 `D://x` ≠ `D:/x`。 */
function normPath(s) {
  return String(s == null ? '' : s).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase()
}

function isInside(child, root, path) {
  let c, r
  try { c = normPath(path.resolve(String(child))); r = normPath(path.resolve(String(root))) } catch (e) { return false }
  if (!c || !r) return false
  return c === r || c.startsWith(r + '/')
}

/** 这个路径是不是落在某个 `.warden/` 里（= 账本自己 ⇒ 补救路）。 */
function isUnderWarden(p) {
  return /(^|\/)\.warden(\/|$)/.test(normPath(p))
}

// ============================================================ 解析：ARCH.md（逐字照 warden.mjs:2586）
/**
 * 只读地**复刻** `warden.mjs` 的 `parseArch`（同一个正则、同一套先后次序）。
 * 为什么不 `import` 那个文件：它是 400 KB 的 CLI 主模块，import 会跑它的顶层代码；
 * 而且每个工具调用都 import 一次 = 性能事故。这里是**同判据的最小副本**。
 */
function parseArch(text) {
  const lines = deBom(text).split(/\r?\n/)
  const branches = []
  let cur = null
  let inItems = false
  for (const raw of lines) {
    const line = raw.trim()
    const h = /^##\s+([A-Z])\s*[·:：]\s*(.*)$/.exec(line)
    if (h) {
      cur = { id: h[1], title: h[2].trim(), reqs: [], items: [] }
      branches.push(cur)
      inItems = false
      continue
    }
    if (!cur) continue
    if (/^-\s*子项\s*[:：]?\s*$/.test(line)) { inItems = true; continue }
    const item = /^-\s*(.+)$/.exec(line)
    if (inItems && item) {
      const body = item[1].trim()
      const reqs = [...body.matchAll(/\[(R\d+)\]/g)].map((x) => x[1])
      const kw = /关键词\s*[:：]\s*(\S+)/.exec(body)
      cur.items.push({ reqs, keyword: kw ? kw[1] : null })
      continue
    }
    const kv = /^-\s*需求\s*[:：]\s*(.*)$/.exec(line)
    if (kv) cur.reqs = kv[1].split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)
  }
  return { branches }
}

// ============================================================ 解析：ROUNDS.jsonl
function parseRounds(text) {
  const out = []
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const l = raw.trim()
    if (!l || l.startsWith('#')) continue
    try { const o = JSON.parse(l); if (o && typeof o === 'object') out.push(o) } catch (e) { /* 坏行跳过 */ }
  }
  return out
}

// ============================================================ 解析：SPEC.md（**只为查 `--req` 用**）
/**
 * 把 `SPEC.md` 切成需求块：`## R<n> · <标题>` 起，到下一个二级标题为止。
 * 为什么需要它：`R#` **不跨账**（同号不同物）。硬编 `--req R44` 会在别的账里指到**另一条需求** ——
 * 实测同一对需求号在**两本不同的账**里指的是**两条不同的需求**（一本里是「**界面要显示**」，
 * 另一本里是别的东西）。所以 `--req` 必须**从触发闸门的那本账里查**。
 */
function parseSpecReqs(text) {
  const out = []
  let cur = null
  for (const raw of deBom(text).split(/\r?\n/)) {
    const line = raw.trim()
    const h = /^##\s+(R\d+)\s*[·:：]\s*(.*)$/.exec(line)
    if (h) { cur = { id: h[1], title: h[2].trim(), body: '' }; out.push(cur); continue }
    if (/^##\s/.test(line)) { cur = null; continue }      // 别的二级标题 ⇒ 当前块结束
    if (cur) cur.body += line + '\n'
  }
  return out
}

/** 语义判据（**保守**）：同时出现"支线守门员"与"不许无限细化/被忽视/静默丢掉/反饥饿/只提醒不拦"才算。 */
const GUARD_REQ_STRONG = /支线守门员/
const GUARD_REQ_MARK = /(无限细化|不断细化|被忽视|静默丢掉|反饥饿|饿死|只提醒不拦)/

/**
 * 从**触发闸门的那本账**的 `SPEC.md` 里查出"支线守门员"那条需求号。
 * ★ 判据：必须**恰好一条**候选。0 条（那本账里没有这条需求）或 >1 条（分不清是哪条）
 *   ⇒ 返回 `null` ⇒ **理由里不印 `--req`**，改印"去那本账里找对应的需求号"。
 *   **宁可不印，不许印错** —— 印错的号会让模型把这一轮记到另一条需求上（本工程最贵的错）。
 */
function findGuardReq(specText) {
  const hits = parseSpecReqs(specText).filter((r) => {
    const blob = r.title + '\n' + r.body
    return GUARD_REQ_STRONG.test(blob) && GUARD_REQ_MARK.test(blob)
  })
  return hits.length === 1 ? hits[0].id : null
}

// ============================================================ 硬自检：理由里的命令必须真的存在
/**
 * 把理由文本里"逐字可抄"的 `warden.mjs <子命令>` 抽出来。
 * 只认**紧跟在 `warden.mjs` 后面**的那个词 —— 散文里提到 `warden.mjs` 后面跟中文不会命中。
 */
function extractWardenCommands(text) {
  const out = []
  const re = /warden\.mjs"?\s+([a-z][a-z0-9-]*)/g
  let m
  while ((m = re.exec(String(text == null ? '' : text))) !== null) out.push(m[1])
  return [...new Set(out)]
}

/** `warden.mjs` 里**真实存在**的子命令表 —— 从源码的命令分派处（`cmd === 'x'`）读出来，不另抄一份。 */
function knownWardenCommands(srcText) {
  const set = new Set()
  const re = /cmd === '([a-z][a-z0-9-]*)'/g
  let m
  while ((m = re.exec(String(srcText == null ? '' : srcText))) !== null) set.add(m[1])
  return set
}

/**
 * ★ **本单最有价值的产出**：印在 deny 理由里的每一条命令，必须在本机真的存在。
 * 返回**找不到的那些**（空数组 = 全部存在）。上一版在这里印过
 * `node warden.mjs branch park --branch A --why "有意先放着"`，而 `branch park` 在
 * `warden.mjs` 里 **grep 0 处** —— 「逐字可抄」印了跑不了的东西，**比不印更坏**。
 */
function missingWardenCommands(reason, srcText) {
  const known = knownWardenCommands(srcText)
  if (!known.size) return ['<读不到 warden.mjs 的命令表>']   // 输入为 0 ⇒ 不许报"全都在"（A6）
  return extractWardenCommands(reason).filter((c) => !known.has(c))
}

/** 读 `warden.mjs` 源码（**只为了核命令表**）。找不到 ⇒ 返回 null（**fail-open，不拦**）。 */
function readWardenSrc(fs, path, env, state) {
  const cands = []
  try { if (env && env.WARDEN_MJS) cands.push(String(env.WARDEN_MJS)) } catch (e) { /* 算了 */ }
  try { cands.push(path.join(nodeOs.homedir(), '.dsh', 'skills', 'task-warden', 'warden.mjs')) } catch (e) { /* 算了 */ }
  for (const p of cands) {
    let sig = '-'
    try { sig = statSig(fs, p) } catch (e) { sig = '-' }
    if (sig === '-') continue
    const c = state && state.wardenSrc
    if (c && c.sig === sig) return c.text
    const text = readText(fs, p)
    if (!text) continue
    if (state) state.wardenSrc = { sig, text }
    return text
  }
  return null
}

// ============================================================ 解析：MAP.md（真实格式见 DESIGN §1）
/**
 * `MAP.md` 的真表格（本机实测）：
 *   | 支线 | 覆盖 | 进度 | 子项 | 最近动过 | 归属 |
 *   | **A · 鼠标刷的出墨规则** | █████░░░░░ 1✅ 0⚠️ 1❌ | | | 第 1 轮（89 轮前） | 用户原话 ✅ |
 * `最近动过` 这一格有 5 种形态，全部要认（老版本 warden.mjs 写的是「从未动过」，
 * 新版本改成了「判断不了」/「账本里没记过」—— 见 `warden.mjs:2685-2696`）：
 *   ① 第 N 轮（M 轮前）   ② 第 N 轮（本轮）   ③ **从未动过**
 *   ④ **判断不了**（没挂 R#、没关键词）  ⇒ basis=false，**不算被丢**
 *   ⑤ **账本里没记过**（有判据、但没有任何一轮命中） ⇒ basis=true，算被丢
 */
function parseMapTable(text) {
  const branches = []
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((s) => s.trim())
    if (cells.length < 7) continue
    const m = /^\*{0,2}\s*([A-Z])\s*·\s*(.*?)\s*\*{0,2}$/.exec(cells[1])
    if (!m) continue                                   // 表头 / 分隔行在这里被滤掉
    const id = m[1]
    const title = m[2]
    const cov = cells[2] || ''
    const recentCell = cells[5] || ''

    const cm = /(\d+)\s*✅\s*(\d+)\s*⚠️\s*(\d+)\s*❌/.exec(cov)
    const done = cm ? Number(cm[1]) : null
    const part = cm ? Number(cm[2]) : null
    const none = cm ? Number(cm[3]) : null

    let lastRound = null
    let gap = null
    let basis = true
    const rm = /第\s*(\d+)\s*轮/.exec(recentCell)
    if (rm) lastRound = Number(rm[1])
    const gm = /（\s*(\d+)\s*轮前\s*）/.exec(recentCell)
    if (gm) gap = Number(gm[1])
    else if (/（\s*本轮\s*）/.test(recentCell)) gap = 0
    if (/判断不了/.test(recentCell)) { basis = false; lastRound = null; gap = null }
    else if (/从未动过|账本里没记过|从没被碰过/.test(recentCell)) { lastRound = null; gap = null }

    branches.push({
      id, title, lastRound, gap, basis,
      items: done != null && part != null && none != null ? done + part + none : null,
      none, done, part,
      keywords: [],                                    // MAP.md 不记关键词 ⇒ 无法做"冷支线豁免"
      source: 'map',
    })
  }
  const maxRound = branches.reduce((m, b) => Math.max(m, b.lastRound == null ? 0 : b.lastRound), 0)
  return { branches, maxRound }
}

// ============================================================ 活判据：ARCH.md + ROUNDS.jsonl
/**
 * 一个子项"动过"的轮次 —— 逐字照 `warden.mjs:2663-2666`。
 * `mode` 是**归属口径**（只影响"被丢下"这个数字怎么算，见 `caliberSpread`）：
 *   `union`（默认，= `renderMap` 的口径）：挂了 `[R#]` 命中 **或** 关键词子串命中，取并集；
 *   `reqOnly`：只用 `[R#]`；`kwOnly`：只用关键词子串。
 * ⚠ 为什么要这个参数：判据对口径**极敏感**，而且窗口里的归属实测**全靠关键词子串**（`[R#]` 命中 0）。
 *   只印一个数 = 把口径藏起来，那正是本单要治的病（③）。
 */
function hitRoundsOf(item, rounds, mode) {
  const m = mode || 'union'
  const reqRounds = m === 'kwOnly' ? [] : rounds.filter((r) => item.reqs.includes(String(r.requirement)))
  const kwHits = (m === 'reqOnly' || !item.keyword)
    ? []
    : rounds.filter((r) => `${r.delivered == null ? '' : r.delivered} ${r.why == null ? '' : r.why}`.includes(item.keyword))
  return [...new Set([...reqRounds, ...kwHits].map((r) => Number(r.round)))]
    .filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
}

/** 支线级聚合 —— 逐字照 `warden.mjs:2657-2707`（`mode` 见 `hitRoundsOf`）。 */
function liveBranches(arch, rounds, mode) {
  const maxRound = rounds.reduce((m, r) => Math.max(m, Number(r.round) || 0), 0)
  const branches = []
  for (const b of arch.branches) {
    let lastRound = null
    let judgeable = 0
    let total = 0
    let none = 0
    const keywords = []
    for (const it of b.items) {
      total += 1
      if (it.reqs.length || it.keyword) judgeable += 1
      if (it.keyword) keywords.push(it.keyword)
      const nums = hitRoundsOf(it, rounds, mode)
      if (nums.length) lastRound = Math.max(lastRound == null ? 0 : lastRound, nums[nums.length - 1])
      else none += 1                                     // 照 renderMap 的 `none`：有判据但没命中
    }
    const gap = lastRound === null ? null : maxRound - lastRound
    branches.push({
      id: b.id, title: b.title, lastRound, gap,
      /**
       * ⚠ **S9 的极小分歧（如实写在代码里，别在理由里说成"完全一致"）**：
       *   `renderMap` 的 `stale`（`warden.mjs:2710`）**不带 basis 过滤** ——
       *   `d.lastRound === null || d.gap >= 3`，所以"判断不了"（整条支线没挂 R#、没关键词）**也算失衡**；
       *   而本闸门的 `dropped` 多一个 `b.basis &&` ⇒ **判断不了的不算被丢**。
       *   另外 `items` 为空（`total === 0`）的支线：`renderMap` 走
       *   `unjudgeable === total && total > 0` 为假 ⇒ 判"账本里没记过"（**算**失衡）；
       *   本闸门 `basis = judgeable > 0` ⇒ `false` ⇒ **不算被丢**。
       *   两处都是本闸门**更窄**（少拦、不误拦），方向是 fail-open，符合约束①。
       */
      basis: judgeable > 0,
      items: total,
      none,
      unjudgeable: total > 0 && judgeable === 0,
      keywords: [...new Set(keywords)],
      source: 'arch',
    })
  }
  return { branches, maxRound }
}

/**
 * ③ **归属口径的三个数**（`union` / `reqOnly` / `kwOnly`）—— 一起印，**不许只印一个**。
 * 实测（审查 2026-09-24，真账本，26 条支线、maxRound=101）：
 *   union 23/26 = **88.5%** · reqOnly 24/26 = **92.3%** · kwOnly 25/26 = **96.2%**
 *   ⇒ 那个 **88% 的头条数字是"关键词子串"口径推出来的**（窗口里 97→K、99→M 两处归属
 *     **全靠关键词**，`[R#]` 命中 **0**；96/98/101 三轮**归属不到任何支线**）。
 *   ⚠ 上面这三个数是**那一版账本**的数（活语料，会变）—— 所以这里**现算**，不写死。
 */
function caliberSpread(arch, rounds, parked, cfg) {
  const total = arch.branches.length
  const count = (mode) => {
    const lb = liveBranches(arch, rounds, mode)
    return lb.branches.filter((b) => !(parked && parked.has(b.id))
      && b.basis && (b.lastRound === null || b.gap >= cfg.STALE_GAP)).length
  }
  return { total, union: count('union'), reqOnly: count('reqOnly'), kwOnly: count('kwOnly') }
}

/** 口径 → 一行人话（理由里逐条印；**每个数后面都跟着它的口径**）。 */
function caliberLines(cs) {
  if (!cs || !cs.total) return []
  const pct = (n) => `${n}/${cs.total} = ${(n / cs.total * 100).toFixed(1)}%`
  return [
    `归属口径（判据对它**极敏感**，所以三个都印 —— 本闸门用的是①）：`,
    `  ① 并集（挂了 [R#] **或** 关键词子串命中）＝ ${pct(cs.union)}   ← 本闸门用的就是它`,
    `  ② 只用 [R#] ＝ ${pct(cs.reqOnly)}`,
    `  ③ 只用关键词子串 ＝ ${pct(cs.kwOnly)}`,
    `  ⚠ 上面①这个数**是关键词子串推出来的**：窗口里能归属到的轮次实测**全靠关键词**（[R#] 命中 0），`,
    `    归属不到的轮次会被当成"没碰任何支线" —— 这就是 DESIGN §6 那笔账（ROUNDS 的 branch 字段）要治的。`,
  ]
}

/** 最近 W 轮到底碰了哪几条支线 —— 这是 ③「冷支线不许被流程饿死」的正判据。 */
function windowTouched(arch, rounds, W, maxRound) {
  const from = maxRound - W + 1
  const win = rounds.filter((r) => Number(r.round) >= from)
  const touched = new Set()
  let attributed = 0
  for (const r of win) {
    let hit = false
    for (const b of arch.branches) {
      for (const it of b.items) {
        const byReq = it.reqs.includes(String(r.requirement))
        const byKw = it.keyword
          ? `${r.delivered == null ? '' : r.delivered} ${r.why == null ? '' : r.why}`.includes(it.keyword)
          : false
        if (byReq || byKw) { touched.add(b.id); hit = true }
      }
    }
    if (hit) attributed += 1
  }
  return {
    touched: [...touched],
    attributed,
    winSize: win.length,
    coverage: win.length ? attributed / win.length : 0,
    from,
  }
}

// ============================================================ 账本发现（工程根）
/**
 * 从 start 往上，**收集每一个带 `.warden` 的目录**（最近优先）。
 * ⚠ 这里**故意**不照抄 `gate.mjs:304 findProjectRoot`（它要求 `.git` 与 `.warden` 同一层）。
 *   实测某账本：支线图所在的那一层**没有 `.git`**
 *   —— 照 gate 的判据这里直接返回 null ⇒ 支线闸永远不工作。
 *   跨项目串账本的风险用另外两道拦：`pickLedger` 的 `isInside` + 祖先账本默认关。
 */
function findLedgerChain(start, fs, path) {
  const chain = []
  let d = path.resolve(String(start))
  for (;;) {
    try { if (fs.existsSync(path.join(d, '.warden'))) chain.push(d) } catch (e) { return chain }
    const up = path.dirname(d)
    if (up === d) return chain
    d = up
  }
}

function hasBranchMap(root, fs, path) {
  const w = path.join(root, '.warden')
  try { return fs.existsSync(path.join(w, 'ARCH.md')) || fs.existsSync(path.join(w, 'MAP.md')) } catch (e) { return false }
}

/** 最近的那一本（**走到第一本就停**）—— 稳态快路，见 pickLedger 的性能注释。 */
function findNearestLedger(start, fs, path) {
  let d = path.resolve(String(start))
  for (;;) {
    try { if (fs.existsSync(path.join(d, '.warden'))) return d } catch (e) { return null }
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}

/**
 * ★ 性能取舍（实测，见 DESIGN §7）：本机 `fs.existsSync` ≈ **85 µs/次**（Windows + Defender），
 *   `statSync` ≈ 32 µs/次 ⇒ "找账本 + 看有没有支线图"这 3~5 次 `existsSync` 才是大头，
 *   **不是我这几行判据**。所以按目录做一个 **5 秒 TTL** 的缓存：
 *   稳态每次写调用只剩 3 次 `statSync`（≈100 µs），比不缓存快 ~6 倍。
 *   **取舍（如实说）**：`.warden` / `ARCH.md` / `MAP.md` 在 5 秒内**新建**的话，
 *   最多 5 秒后才被认出来 —— 代价是"刚建好账本的那 5 秒里闸门还不生效"（fail-open 方向，安全）。
 */
const ROOT_TTL_MS = 5000
function resolveLedgerNear(dir, fs, path, state, nowMs) {
  let key = ''
  try { key = normPath(path.resolve(String(dir))) } catch (e) { key = String(dir) }
  const c = state && state.roots
  if (c) {
    const h = c.get(key)
    if (h && nowMs - h.at < ROOT_TTL_MS) return h.val
  }
  const near = findNearestLedger(dir, fs, path)
  const val = { near, hasMap: near ? hasBranchMap(near, fs, path) : false }
  if (c) c.set(key, { at: nowMs, val })
  return val
}

/** 显式外部账本：env `BRANCH_GUARD_LEDGER`（`;` 分隔）+ env `BRANCH_GUARD_SCOPE`，
 *  或最近账本里的 `.warden/BRANCH-GUARD.json`（`{"extraLedgers":[{"root":…,"scope":…}]}`）。
 *  为什么要这条：**本单不许改任何已存在的文件** ⇒ 我不能往 `.warden/config.json` 里加配置；
 *  env 是今天就能用、且不落盘的那条路（见 DESIGN §6）。 */
function extraLedgers(fs, path, env, nearestRoot) {
  const out = []
  const envv = env && env.BRANCH_GUARD_LEDGER
  const scope = (env && env.BRANCH_GUARD_SCOPE) || null
  if (envv) {
    for (const p of String(envv).split(';').map((s) => s.trim()).filter(Boolean)) {
      const root = p.replace(/[\\/]\.warden[\\/]?$/i, '')
      out.push({ root: path.resolve(root), scope: scope ? path.resolve(scope) : null })
    }
  }
  if (nearestRoot) {
    try {
      const f = path.join(nearestRoot, '.warden', 'BRANCH-GUARD.json')
      if (fs.existsSync(f)) {
        const j = JSON.parse(readText(fs, f) || '{}')
        for (const e of (j && j.extraLedgers) || []) {
          if (typeof e === 'string') out.push({ root: path.resolve(e), scope: null })
          else if (e && e.root) out.push({ root: path.resolve(e.root), scope: e.scope ? path.resolve(e.scope) : null })
        }
      }
    } catch (e2) { /* 配置坏了 ⇒ 当没有 */ }
  }
  return out
}

/**
 * 选出"用哪一本账"。返回 `{root, via, nearest, scope}` 或 `null`。
 * `via` ∈ nearest | ancestor | extra —— **理由里会原样打出来**（账本来源必须可追）。
 */
function pickLedger(absTargets, bases, fs, path, cfg, env, state, nowMs) {
  const extrasEnv = extraLedgers(fs, path, env, null)
  const needAncestor = !!(cfg.ALLOW_ANCESTOR_LEDGER || extrasEnv.length)

  let sawNearest = null
  for (const a of absTargets) {
    let near = null
    let hasMap = false
    try {
      const r = resolveLedgerNear(path.dirname(a), fs, path, state, nowMs)
      near = r.near; hasMap = r.hasMap
    } catch (e) { near = null; hasMap = false }
    if (near && !sawNearest) sawNearest = near
    if (near && isInside(a, near, path) && hasMap) {
      return { root: near, via: 'nearest', nearest: near, scope: null }
    }
    if (!needAncestor) continue
    // 慢路：往上找"更外面那一本有支线图的"
    let chain = []
    try { chain = findLedgerChain(path.dirname(a), fs, path) } catch (e) { chain = [] }
    for (const r of chain) {
      if (r === near) continue
      if (!isInside(a, r, path)) continue
      if (!hasBranchMap(r, fs, path)) continue
      if (cfg.ALLOW_ANCESTOR_LEDGER) return { root: r, via: 'ancestor', nearest: near, scope: null }
      // ★ 有祖先账本但**没被允许** ⇒ 不用它，但**必须继续往下试**（显式外部账本）。
      //   实测洞：这里原来写 `return null` —— 于是"工程自己的 .warden 没有支线图、
      //   祖先有一份"这个**唯一真实布局**会让外部账本那条路永远跑不到，形同虚设。
      break
    }
  }

  const nearestRoot = sawNearest || (function () {
    for (const b of bases) {
      try { const r = resolveLedgerNear(b, fs, path, state, nowMs); if (r.near) return r.near } catch (e) { /* 下一个 */ }
    }
    return null
  })()

  for (const e of extraLedgers(fs, path, env, nearestRoot)) {
    if (!hasBranchMap(e.root, fs, path)) continue
    if (absTargets.length) {
      if (e.scope && !absTargets.some((a) => isInside(a, e.scope, path))) continue
      if (!absTargets.some((a) => isInside(a, e.root, path))) continue
    }
    return { root: e.root, via: 'extra', nearest: nearestRoot, scope: e.scope || null }
  }
  // ③ 有账本、但**没有支线图** —— 与"根本没有账本"分开报（诊断要能分清，见自检③b）
  if (nearestRoot) return { root: null, via: 'no-map', nearest: nearestRoot, scope: null }
  return null
}

// ============================================================ 解析：BRANCH-PARKED.jsonl
/**
 * 「有意先放着」的账 —— 一行一条 `{"branch":"A","why":"…","at":"…"}`。
 * ⚠ **写侧今天不存在**（`warden.mjs` 没有 `branch park`，本单不许改它）——
 *   所以这是给下一单**预留的读侧**：写侧一补上，被 park 的支线立刻不再触发 deny。
 *   为什么要预留：拒绝理由里给的"出路"如果永远跑不通，那条出路就是**假出路**
 *   （本 skill 反复防的"给了命令却没人能跑"）。
 */
function parseParked(text) {
  const set = new Set()
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const l = raw.trim()
    if (!l || l.startsWith('#')) continue
    try {
      const o = JSON.parse(l)
      if (o && o.branch) set.add(String(o.branch).trim().toUpperCase())
    } catch (e) { /* 坏行跳过 */ }
  }
  return set
}

// ============================================================ 载入支线（带 mtime 缓存）
function statSig(fs, p) {
  try { const s = fs.statSync(p); return s.size + ':' + s.mtimeMs } catch (e) { return '-' }
}

/**
 * 稳态成本：**4~5 次 statSync**（本版 +1：`SPEC.md`，只为查 `--req`）；只有账本真变了才重新解析（见 DESIGN §7 的实测数字）。
 */
function loadBranches(root, fs, path, cache) {
  const wdir = path.join(root, '.warden')
  const archPath = path.join(wdir, 'ARCH.md')
  const roundsPath = path.join(wdir, 'ROUNDS.jsonl')
  const mapPath = path.join(wdir, 'MAP.md')
  const parkedPath = path.join(wdir, 'BRANCH-PARKED.jsonl')
  const specPath = path.join(wdir, 'SPEC.md')
  const sig = [statSig(fs, archPath), statSig(fs, roundsPath), statSig(fs, mapPath),
    statSig(fs, parkedPath), statSig(fs, specPath)].join('|')
  const hit = cache && cache.get(root)
  if (hit && hit.sig === sig) return hit.val

  let val
  const parked = statSig(fs, parkedPath) !== '-' ? parseParked(readText(fs, parkedPath)) : new Set()
  // ★ `--req` 从**触发闸门的那本账**里查（见 findGuardReq）；查不到就是 null ⇒ 理由里不印 `--req`。
  const specText = statSig(fs, specPath) !== '-' ? readText(fs, specPath) : ''
  const guardReq = specText ? findGuardReq(specText) : null
  const common = { parked, specPath, hasSpec: !!specText, guardReq }
  const archSig = statSig(fs, archPath)
  if (archSig !== '-') {
    const arch = parseArch(readText(fs, archPath))
    const rounds = statSig(fs, roundsPath) !== '-' ? parseRounds(readText(fs, roundsPath)) : []
    const live = liveBranches(arch, rounds)
    val = Object.assign({}, common, {
      ok: live.branches.length > 0,
      why: live.branches.length ? '' : 'arch-no-branches',
      source: 'arch', arch, rounds,
      branches: live.branches, maxRound: live.maxRound,
      archPath, mapPath, roundsPath, parkedPath,
    })
  } else if (statSig(fs, mapPath) !== '-') {
    const m = parseMapTable(readText(fs, mapPath))
    val = Object.assign({}, common, {
      ok: m.branches.length > 0,
      why: m.branches.length ? '' : 'map-no-branches',
      source: 'map', arch: null, rounds: null,
      branches: m.branches, maxRound: m.maxRound,
      archPath, mapPath, roundsPath, parkedPath,
    })
  } else {
    val = Object.assign({}, common, {
      ok: false, why: 'no-arch-no-map', source: 'none', arch: null, rounds: null,
      branches: [], maxRound: 0, archPath, mapPath, roundsPath, parkedPath,
    })
  }
  if (cache) cache.set(root, { sig, val })
  return val
}

// ============================================================ 理由文本
function lastActivityText(b) {
  if (b.lastRound === null) {
    return b.basis
      ? '**从没被碰过**（账本里从头到尾没有记过它）'
      : '**判断不了**（没挂 R#、没关键词）'
  }
  return b.gap === 0 ? `最后在第 ${b.lastRound} 轮动过（本轮）` : `最后在第 ${b.lastRound} 轮动过（${b.gap} 轮前）`
}
function shortActivity(b) {
  if (b.lastRound === null) return b.basis ? '从没被碰过' : '判断不了'
  return b.gap === 0 ? `第 ${b.lastRound} 轮(本轮)` : `${b.gap} 轮前`
}
function subItemsText(b) {
  if (b.items == null) return ''
  if (b.none == null) return ` · 共 ${b.items} 条子项`
  return ` · ${b.items} 条子项里 ${b.none} 条在账本里找不到动过的痕迹`
}

function buildReason(o) {
  const { cfg, dropped, hotIds, branches, starve, ledger, rawTarget, source, sid, used, env, parked } = o
  const wardenCmd = `node "${pathJoin(nodeOs.homedir(), '.dsh', 'skills', 'task-warden', 'warden.mjs')}"`
  const L = []
  L.push('[task-warden · 支线守门员] 先别动：这一轮要写的 `' + (rawTarget || '(没点名路径)') + '` 落在**正在被细化的支线**上，')
  L.push('而下面这些支线已经被丢下了 —— **逐条点名**（判据与 `node warden.mjs map` 一致 **+ 一条更窄的排除**：')
  L.push(`gap ≥ ${cfg.STALE_GAP} 轮 **或** 账本里从没记过；本闸门额外把"**判断不了**"（没挂 R#、没关键词）的支线`)
  L.push('排除在外 —— 那是账本没记，不是产品没做，见 DESIGN §3.4 的 S9）：')
  L.push('')
  const show = dropped.slice(0, cfg.DETAIL_MAX)
  for (let i = 0; i < show.length; i += 1) {
    const b = show[i]
    L.push(`  ${i + 1}. ${b.id} · ${b.title} —— ${lastActivityText(b)}${subItemsText(b)}`)
  }
  if (dropped.length > show.length) {
    L.push(`  …其余 ${dropped.length - show.length} 条同样被丢下，逐条点名：`
      + dropped.slice(cfg.DETAIL_MAX).map((b) => `${b.id}（${shortActivity(b)}）`).join('、'))
  }
  L.push('')
  if (parked && parked.size) {
    L.push(`（已按 \`.warden/BRANCH-PARKED.jsonl\` 排除 ${parked.size} 条"有意先放着"：${[...parked].join('、')}）`)
  }
  const hotText = [...hotIds].map((id) => {
    const b = branches.find((x) => x.id === id)
    return `${id} · ${b ? b.title : ''}`
  }).join('、')
  if (starve.kind === 'window') {
    L.push(`正在被细化的支线（最近 ${starve.winSize} 轮里**只碰了 ${starve.touched.length} 条**，`
      + `能归属的轮次 ${Math.round(starve.coverage * 100)}%；全项目 ${starve.total} 条里被丢下 ${dropped.length} 条 `
      + `= ${Math.round(starve.droppedFrac * 100)}%；命中的判据腿 = ${starve.limb}）：${hotText}`)
    // ★ ③ 口径：**不许只印一个数**（`starve.droppedFrac` 只是"并集"口径那一个）
    for (const line of caliberLines(o.calibers)) L.push(line)
  } else {
    L.push(`正在被细化的支线（MAP.md 只记"最近一次活动"，没有"哪几轮动过" ⇒ `
      + `退化成**代理判据**：只认"恰好 1 条还热"）：${hotText}`)
  }
  L.push(`被丢下的共 ${dropped.length} 条（本行是计数，上面已逐条点名）。`)
  L.push('')
  // ---- ① `--req` 从**触发闸门的那本账**里查，不硬编（R# 不跨账：同号不同物）
  L.push('三条出路，**逐字可抄**（每一条都在本机真的存在 —— 自检 ⑲ 拿 `warden.mjs` 的命令表逐条核；')
  L.push('印一条跑不了的东西比不印更坏）：')
  L.push('  1) 给这一轮记账，并说明哪条先放着：')
  if (o.guardReq) {
    L.push(`     ${wardenCmd} record --req ${o.guardReq} --status in_progress --why "继续 <热支线>，<被丢的字母> 有意先放着"`)
    L.push(`     （\`--req ${o.guardReq}\` 是从**这本账**的 \`${o.specPath}\` 里**查出来的**，不是硬编的。）`)
  } else {
    L.push(`     ⚠ **不印 \`--req\`**：这本账的 \`${o.specPath}\` 里**查不到**"支线守门员 / 支线不许无限细化"那条需求`)
    L.push('       （或者查到不止一条，分不清是哪条）。**R# 不跨账：同号不同物** —— 硬编一个号会指到')
    L.push('       **另一条需求**（实测：同一个号在**另一本账**里指的是**另一条需求**，比如「界面要显示」）。')
    L.push(`     先看那本账的需求号：\`${wardenCmd} report\`（或直接读 \`${o.specPath}\` 里的 \`## R# · 标题\`），`)
    L.push(`     再补 \`--req <那本账里的 R#>\`：`)
    L.push(`     ${wardenCmd} record --req <那本账里的 R#> --status in_progress --why "继续 <热支线>，<被丢的字母> 有意先放着"`)
  }
  L.push('  2) 先看一眼支线总图（哪几条被丢了、丢了几轮）：')
  L.push(`     ${wardenCmd} map`)
  L.push('  3) 这一轮改成去动**被丢的那条支线**（那正是本闸门要的）')
  L.push('')
  L.push('★ 这是**减速带不是路障**（如实说，不自夸）：本会话最多拦 '
    + `${cfg.MAX_DENIES} 次、两次之间至少隔 ${Math.round(cfg.COOLDOWN_MS / 1000)} 秒，之后一律放行。`)
  L.push('  永远不拦的两类：① `.warden/` 下的账本文件；② 任何 `node …warden.mjs …` 命令（那是补救的路）。')
  L.push('  数据不足时（推不出账本 / 没有 ARCH.md·MAP.md / 最近轮次归属不到支线）一律放行，只记一行日志。')
  L.push('')
  L.push(`账本来源：${ledger.root}（via=${ledger.via}${ledger.scope ? `，scope=${ledger.scope}` : ''}`
    + `${ledger.via === 'ancestor' ? '　⚠ 祖先账本，不是本工程的' : ''}`
    + `${ledger.via === 'extra' && !ledger.scope ? '　⚠ 外部账本且**没限定作用范围**' : ''}）`)
  L.push(`判据数据：${source === 'arch' ? `ARCH.md + ROUNDS.jsonl（活算，maxRound=${o.maxRound}）` : 'MAP.md（渲染快照，可能落后）'}`
    + `${env && env.BRANCH_GUARD_ALLOW_ANCESTOR ? ' · ALLOW_ANCESTOR=1' : ''}`)
  L.push(`本次是本会话第 ${used} 次拒绝（session=${sid}，上限 ${cfg.MAX_DENIES}）。`)
  /**
   * ★ **节流之后是静默的 —— 如实写出来，不假装它还在看着你**（S7，2026-09-24 审查）。
   *   第 MAX_DENIES+1 次起走 `allow('throttled')`：只有 stderr（+ 临时区一行日志，且有每进程上限），
   *   **模型与用户都看不见**。要做到"第 3 次也可见"得走**界面通道**，
   *   而那需要 client 半边 + 改 `cordis.patch.yml`（本单两样都不许碰，见 DESIGN §6 账 5）。
   *   能做的、也在做的：在**最后一次出声**的时候把这件事说清楚。
   */
  if (used >= cfg.MAX_DENIES) {
    L.push(`★ 这是本会话**最后一次**出声：第 ${cfg.MAX_DENIES + 1} 次起本闸门**只写 stderr（宿主控制台），`)
    L.push('  模型与用户都看不见**（"节流之后静默"如实写在这里 —— 不假装它还在看着你）。')
  }
  return L.join('\n')
}

function pathJoin() {
  return nodePath.join.apply(nodePath, arguments)
}

// ============================================================ 判定主体
function allow(why, note) {
  const o = { kind: 'allow', why }
  if (note) o.note = note
  return o
}

/**
 * 纯判据：**只做判定，不兜异常**（自检要能看到它抛）。
 * `input = { toolName, toolArgs, cwd?, cwds?, sessionId? }`，返回 `{kind:'allow'|'deny', why?, note?, reason?}`。
 */
function decide(input, deps) {
  deps = deps || {}
  const fs = deps.fs || nodeFs
  const path = deps.path || nodePath
  const env = deps.env || process.env
  const cfg = Object.assign({}, DEFAULT_CFG, deps.cfg || {})
  if (env && env.BRANCH_GUARD_ALLOW_ANCESTOR === '1') cfg.ALLOW_ANCESTOR_LEDGER = true
  const state = deps.state || { denies: new Map(), lastDenyAt: new Map(), cache: new Map(), roots: new Map() }
  if (!state.roots) state.roots = new Map()
  if (!state.cache) state.cache = new Map()
  if (!state.denies) state.denies = new Map()
  if (!state.lastDenyAt) state.lastDenyAt = new Map()
  if (state.wardenSrc === undefined) state.wardenSrc = null   // `warden.mjs` 源码缓存（只为了核命令表）
  const nowMs = Date.now()   // ★ 缓存 TTL 用**真钟**（不用 deps.now，免得自检的合成时间戳把缓存算成过期）
  const now = Number.isFinite(deps.now) ? deps.now : nowMs

  const toolName = String((input && input.toolName) || '')
  const isWrite = WRITE_TOOLS.includes(toolName)
  const isShell = SHELL_TOOLS.includes(toolName)
  // 约束②：非写工具**零 IO** 直接放行（read/glob/grep/todo/present/… 全在这里）
  if (!isWrite && !isShell) return allow('not-a-write-tool')

  const args = (input && input.toolArgs) || {}
  let text = ''
  try { text = typeof args === 'string' ? args : JSON.stringify(args) } catch (e) { text = '' }

  if (isShell) {
    if (LEDGER_CMD.test(text)) return allow('ledger-cmd')      // 补救路
    if (!WRITE_HINTS.test(text)) return allow('no-write-hint')  // 只读命令 ⇒ 不多看一眼
  }

  // ---- 目标路径
  const bases = []
  if (Array.isArray(input && input.cwds)) for (const b of input.cwds) if (typeof b === 'string' && b) bases.push(b)
  if (input && typeof input.cwd === 'string' && input.cwd) bases.push(input.cwd)
  try { if (process.cwd()) bases.push(process.cwd()) } catch (e) { /* 拿不到就算了 */ }
  if (!bases.length) bases.push('.')

  const rawTargets = []
  if (isWrite) {
    for (const k of PATH_FIELDS) {
      const v = args && args[k]
      if (typeof v === 'string' && v.trim()) rawTargets.push(v.trim())
    }
  } else {
    const re = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)[^\s"'`;|)>]+/g
    let m
    while ((m = re.exec(text)) !== null) rawTargets.push(m[0])
  }

  const absTargets = []
  for (const raw of rawTargets) {
    try {
      if (path.isAbsolute(raw)) absTargets.push(path.normalize(raw))
      else for (const b of bases) absTargets.push(path.resolve(b, raw))
    } catch (e) { /* 坏路径跳过 */ }
  }

  // 约束③：账本自己的文件永不拦
  for (const a of absTargets) if (isUnderWarden(a)) return allow('remedy-path')

  // ---- 选账本
  const ledger = pickLedger(absTargets, bases, fs, path, cfg, env, state, nowMs)
  if (!ledger) {
    return allow('no-ledger', 'no-ledger' + (isWrite ? '' : '(shell)'))
  }
  if (!ledger.root) {
    // 有账本、但没有支线图（实测：真工程 `…\spatial-draw\.warden` 就是这个状态）
    return allow('no-branch-ledger', `no-branch-ledger@${ledger.nearest}`)
  }

  const led = loadBranches(ledger.root, fs, path, state.cache)
  if (!led.ok) {
    return allow('no-branch-ledger', `no-branch-ledger:${led.why}@${ledger.root}`)
  }
  const branches = led.branches

  // 数据不足：有支线图、但**一轮 ROUNDS 都没有** ⇒ 分不出"热"和"冷" ⇒ 放行 + **留一行**（不静默）
  if (led.source === 'arch' && (!led.rounds || led.rounds.length === 0)) {
    return allow('no-rounds', `no-rounds@${ledger.root}`)
  }

  // ---- 判据① 被丢的支线（**逐字照 renderMap**：gap ≥ STALE_GAP 或 lastRound === null）
  //      再减掉 `BRANCH-PARKED.jsonl` 里"有意先放着"的那几条（写侧待下一单补，读侧已就位）
  const parked = led.parked || new Set()
  const dropped = branches.filter((b) => !parked.has(b.id)
    && b.basis && (b.lastRound === null || b.gap >= cfg.STALE_GAP))
  if (dropped.length < cfg.MIN_DROPPED) return allow('few-dropped')

  // ---- 判据② 有没有"正在被细化的热支线"
  const hotIds = new Set(branches.filter((b) => b.gap !== null && b.gap <= cfg.HOT_GAP).map((b) => b.id))
  if (!hotIds.size) return allow('no-hot-branch')

  // ---- 判据③ 冷支线不许被流程饿死
  let starve = null
  if (led.source === 'arch' && led.arch && led.rounds) {
    const w = windowTouched(led.arch, led.rounds, cfg.WINDOW, led.maxRound)
    if (w.winSize === 0) return allow('window-empty', 'window-empty')
    if (w.coverage < cfg.MIN_COVERAGE) return allow('low-coverage', `low-coverage:${w.coverage.toFixed(2)}`)
    if (w.touched.length === 0) return allow('window-unattributed', 'window-unattributed')
    const total = branches.length
    // 腿 A：窗口里碰到的**全部**都是热支线（字面意义："全都在同一条支线上细化"）
    const limbA = w.touched.every((id) => hotIds.has(id))
    // 腿 B：集中度 —— 最近 W 轮只碰了全项目的一小块，且**过半**支线被丢下
    const cap = Math.max(1, Math.floor(total * cfg.CONCENTRATION))
    const limbB = w.touched.length <= cap && dropped.length >= Math.ceil(total * cfg.DROPPED_FRAC)
    if (!limbA && !limbB) return allow('window-not-narrow')
    starve = {
      kind: 'window', touched: w.touched, winSize: w.winSize, coverage: w.coverage,
      limb: limbA ? 'A-narrow' : 'B-concentration', total, droppedFrac: total ? dropped.length / total : 0,
    }
  } else {
    // MAP.md 只有"最近一次活动"，没有"哪几轮动过" ⇒ 退化成代理判据，并且**理由里明说**
    if (hotIds.size !== 1) return allow('map-only-multi-hot')
    starve = { kind: 'map-proxy', touched: [...hotIds], winSize: null, coverage: null }
  }

  // ---- 判据④ 冷支线豁免：这一笔明显是在动"被丢的"那条 ⇒ 放行（那正是本闸门要的）
  const hay = (text + ' ' + absTargets.join(' ')).toLowerCase()
  const hitIds = branches.filter((b) => (b.keywords || []).some((kw) => kw && String(kw).length >= 2 && hay.includes(String(kw).toLowerCase())))
    .map((b) => b.id)
  if (hitIds.length && !hitIds.some((id) => hotIds.has(id))) return allow('cold-branch-work')

  // ---- 判据⑤ 减速带（不是路障）
  const sid = String((input && input.sessionId) || '-')
  const used = state.denies.get(sid) || 0
  if (used >= cfg.MAX_DENIES) return allow('throttled', `throttled:max:${used}`)
  const last = state.lastDenyAt.get(sid) || 0
  if (now - last < cfg.COOLDOWN_MS) return allow('throttled', 'throttled:cooldown')
  state.denies.set(sid, used + 1)
  state.lastDenyAt.set(sid, now)

  let reason = buildReason({
    cfg, dropped, hotIds, branches, starve, ledger, source: led.source,
    rawTarget: rawTargets[0] || '', maxRound: led.maxRound, sid, used: used + 1, env,
    parked: led.parked,
    guardReq: led.guardReq || null, hasSpec: !!led.hasSpec, specPath: led.specPath,
    /**
     * ★ ③ 口径三个数**在这里现算**（不在 `loadBranches` 里缓存）：它依赖 `cfg.STALE_GAP`，
     *   而 `loadBranches` 的缓存键只有"文件指纹"、不含 cfg ⇒ 放那儿会在换 cfg 时给出**陈旧口径**。
     *   代价：只在**判成 deny 的那一次**算（每次 ≤1 ms，见 DESIGN §7）；MAP 源算不出来 ⇒ null。
     */
    calibers: (led.source === 'arch' && led.arch && led.rounds)
      ? caliberSpread(led.arch, led.rounds, led.parked, cfg) : null,
  })
  /**
   * ★ ④ 最后一道自检 —— **运行时也做一遍**，不只靠自检套件：
   *   印在理由里的每一条 `warden.mjs <子命令>` 必须在本机真的存在；不存在就把这件事
   *   **印在理由末尾**。⚠ **不改判定**（fail-open 硬约束①）：看守自己发现"文案里有假出路"，
   *   不该让工具调用失败 —— 它只该把这句话摆到看得见的地方。
   *   `warden.mjs` 读不到 ⇒ **一个字都不加**（宁可不说，不许瞎说）。
   */
  const wardenSrc = readWardenSrc(fs, path, env, state)
  if (wardenSrc) {
    const miss = missingWardenCommands(reason, wardenSrc)
    if (miss.length) {
      reason += '\n\n⚠ **[branch-guard 自身缺陷] 上面这些命令在本机 `warden.mjs` 的命令表里找不到：'
        + miss.join('、') + '** —— 别照着抄，去报告（自检 ⑲ 会红）。'
    }
  }
  const out = { kind: 'deny', reason, why: 'branch-imbalance', note: `deny:${dropped.length}d/${hotIds.size}h` }
  return out
}

/**
 * 插件只调这一个：**任何异常都变成 allow**（fail-open 硬约束）。
 * 中间件绝不能因为看守自己坏了而让工具调用失败 —— 照 `gate.mjs:499` 的契约。
 */
function preToolDecision(input, deps) {
  try {
    return decide(input, deps)
  } catch (e) {
    try { console.error('[branch-guard] 判据出错，放行（fail-open）：' + String((e && e.message) || e)) } catch (e2) { /* 连 console 都没了也要放行 */ }
    return allow('error')
  }
}

// ============================================================ 诊断（**不进模型上下文**）
/**
 * ★ 观测的**成本控制**（S8，2026-09-24 审查实测）：`%TEMP%\branch-guard-debug.jsonl`
 *   原来是**每次写调用都 append 一行、无上限、无轮转**（审查实测 1640 B / 14 行）。
 *   为什么它会涨：`no-ledger` / `no-branch-ledger` 是**每一次写调用**都会产生的 note
 *   （在一个"工程自己没有支线图"的目录里干活 = 每个 edit 一行）⇒ 一天几万行。
 *   照 `preset-roles/team-guard.mjs:1747` 那条先例（"**每进程只写一行**，不给它添噪音"）做成**有界**：
 *     · 非拒绝事件（allow + note）：**每进程最多 `LOG_MAX_ALLOW` 行**；
 *     · 拒绝事件：每进程最多 `LOG_MAX_DENY` 行（它本来就被 `MAX_DENIES`×会话数 限住，这里只是防病态）。
 *   `stderr` **不设上限**（它只落在宿主控制台，不落盘、不增长）—— 所以封顶之后仍可在控制台追。
 */
const LOG_MAX_ALLOW = 3
const LOG_MAX_DENY = 20

/** 造一个**有界** logger；`write` 可注入（自检 ㉓ 用它，**不碰真的临时区文件**）。 */
function makeDefaultLog(write) {
  const sink = typeof write === 'function' ? write : function (line) {
    nodeFs.appendFileSync(nodePath.join(nodeOs.tmpdir(), 'branch-guard-debug.jsonl'), line, 'utf8')
  }
  let allowLines = 0
  let denyLines = 0
  return function defaultLog(obj) {
    const isDeny = !!obj && obj.ev === 'deny'
    try {
      const capped = isDeny ? denyLines >= LOG_MAX_DENY : allowLines >= LOG_MAX_ALLOW
      if (!capped) {
        if (isDeny) denyLines += 1; else allowLines += 1
        sink(JSON.stringify(obj) + '\n')
      }
    } catch (e) { /* 观测自己坏了绝不许影响工具调用 */ }
    try { console.error('[branch-guard] ' + JSON.stringify(obj)) } catch (e) { /* 算了 */ }
  }
}
const defaultLog = makeDefaultLog()

const VERSION = '1.0.0-loadmark'

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
// ============================================================ 插件
module.exports = {
  name: 'branch-guard',
  /**
   * ★ **空**：本插件不依赖任何服务（`ctx.get()` 一次都不调）。
   *   为什么必须空：`inject` 非空时 Cordis 会把它挂进 waiting 直到服务出现 ——
   *   支线闸只是"看盘 + 返回 deny"，拿不到任何服务也必须能跑（自检用例 ⑥ 钉住）。
   */
  inject: [],
  apply(ctx) {
    /* ★ 加载即留痕：**整个插件生命周期里只写这一次**（不在任何热路径上）。
     *   写失败静默降级（`markPluginLoaded*` 内部已经吞掉所有异常）。
     *   位置选在 `apply()` 最前面：宿主调用 `apply` 本身就等于"这个插件加载成功了"，
     *   所以留痕不该等任何后续步骤 —— 哪怕下面任何一行抛了，留痕也已经如实写下。
     *   ⚠ **第 3 个实参 `hostId` 故意不传**（旧稿写 `ctx && ctx.id`）：读 `ctx.id` 会在 `ctx` 的
     *     Proxy 上留下一次 `GET(id)`，与「对 `ctx` 的调用**只有** `ctx.on` 与 `ctx.effect`」那条
     *     硬契约（`handover-gate.js:40`）**直接冲突**（实测：自检的 ㉔/㉔b 因此变红）。
     *     `hostId` 是可选参数 ⇒ 不传就**整个键都不出现**，留痕照常工作。 */
    markPluginLoadedWithRetry('branch-guard', VERSION)

    const state = { denies: new Map(), lastDenyAt: new Map(), cache: new Map() }
    const deps = { state, log: defaultLog, cfg: DEFAULT_CFG }

    const handler = function (exec, next) {
      let d = null
      try {
        const agent = exec && exec.agent
        const sess = agent && agent.session
        const hdr = sess && sess.header
        d = preToolDecision({
          toolName: exec && exec.name,
          toolArgs: exec && exec.arguments,
          // ⚠ `exec.cwd` **不存在**（实测：`dsh-tools` 全文 0 处 `cwd`，见 warden-watch.js:507-513）
          //   ⇒ 读同一份数据的真字段 `agent.session.header.cwd`。
          cwd: (hdr && hdr.cwd) || undefined,
          cwds: [hdr && hdr.cwd, (function () { try { return process.cwd() } catch (e) { return undefined } })()].filter(Boolean),
          sessionId: (sess && (sess.id || sess.sessionId)) || undefined,
        }, deps)
      } catch (e) {
        d = null   // 看守自己坏了 → 放行
      }
      try {
        if (d && d.note) {
          defaultLog({
            at: new Date().toISOString(), ev: d.kind, why: d.why, note: d.note,
            tool: String((exec && exec.name) || ''), pid: process.pid,
          })
        }
      } catch (e) { /* 日志坏了不影响判定 */ }
      if (d && d.kind === 'deny' && typeof d.reason === 'string' && d.reason) {
        return Promise.resolve({ kind: 'deny', reason: d.reason })
      }
      return next()
    }

    // ★ 本插件对 ctx 的**全部**调用就是这两行：`on`（挂前置闸）+ `effect`（可逆）。
    //   没有 systemPrompt / context / 消息通道 —— 自检用例 ⑧ 用 Proxy 逐次录下来证明。
    const off = ctx.on('tools/pre-execute', handler)
    if (typeof ctx.effect === 'function') {
      try {
        ctx.effect(function () {
          return function () { try { if (typeof off === 'function') off() } catch (e) { /* 已摘 */ } }
        })
      } catch (e) { /* effect 挂了就只靠 ctx.on 的 fiber 作用域自动摘 */ }
    }
  },
  // ---- 给自检用的导出（插件运行时不碰这些）
  decide,
  preToolDecision,
  parseArch,
  parseMapTable,
  parseRounds,
  parseParked,
  parseSpecReqs,
  findGuardReq,
  extractWardenCommands,
  knownWardenCommands,
  missingWardenCommands,
  readWardenSrc,
  hitRoundsOf,
  liveBranches,
  caliberSpread,
  caliberLines,
  makeDefaultLog,
  LOG_MAX_ALLOW,
  LOG_MAX_DENY,
  windowTouched,
  loadBranches,
  pickLedger,
  findLedgerChain,
  findNearestLedger,
  hasBranchMap,
  buildReason,
  lastActivityText,
  DEFAULT_CFG,
  WRITE_TOOLS,
  SHELL_TOOLS,
}
