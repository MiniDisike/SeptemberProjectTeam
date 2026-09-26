/**
 * R43 自检：`node handover-gate.selftest.mjs` → **exit 0 = 全过 / exit 1 = 有红**。
 *
 * 硬约束（派单逐字）：
 *   · **不碰真工程、真账本**：所有夹具建在 `%TEMP%` 下（`fs.mkdtempSync(os.tmpdir(), …)`），
 *     跑完删掉。唯一碰真盘的一处是**只读**验证"认不认得出本工程那份交接"
 *     （`<候选根>/交接-<日期>.md`）—— 只 `existsSync`/`readdirSync`/`statSync`。
 *
 *   ★ **公开版（脱敏后）的两条铁律**（R43 公开包事故）：
 *     ① 上面那个"本工程"**不许写成作者机的绝对路径** —— 一律**运行期派生**
 *        （见下面 `pickProjectRoot()`：从 `__dirname` 往上找 `.git` / `.warden`）。
 *        公开包里它会**找不到**，那时如实报"本机没有可对照的真工程"（SKIP），**不崩、不假装通过**。
 *     ② **没有一份"权威源"是必然存在的**（`派单模板.md` 就不在公开包里）。
 *        ⇒ 凡读外部权威源一律**先探存在、再 try/catch**；读不到就报成
 *        **有理由的 SKIP/FAIL**，把"因为找不到 X"印出来。
 *        **绝不许**把"读不到"悄悄当成"读过了/核过了"（本项目 A6：没查到 ≠ 查了没问题）。
 *   · **正控 + 负控成对**：每条"拦住了"旁边都有一条"不该拦的没被拦"。
 *   · **不依赖 DSH**：不 import 任何 `@deepseek-ai/*`，只用 node 标准库 + 真 fs。
 *
 * 怎么算"过了"：每条 case 一个 `check()`，末尾打印逐条 PASS/FAIL，exit code 报总结果。
 * 另外**原样打印**：第一次 write 被 deny 的 reason 全文、写闸的 steer 调用、对 ctx 的调用清单。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
/** ★ 本文件所在目录（**运行期派生**，不写作者机路径）—— 下面所有"本工程"路径都由它推 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mod = require('./handover-gate.js')
const I = mod._internals

/* ==========================================================================
 * ★★ R43 **返工**加的两个"真相源"设置（这一段必须在任何 install 之前）
 * ========================================================================== */

/**
 * ① 逃生阀环境变量：本套自检**显式钉住**默认值 `on`，跑完恢复原值。
 *    为什么必须钉：`steerEnabled()` 现在**每次现读** `process.env`（(6) 的修法），
 *    所以别的 shell 里设过 `WARDEN_HANDOVER_STEER=off` 会让本套自检**静默少测**。
 */
const ENV_STEER = 'WARDEN_HANDOVER_STEER'
const ENV_STEER_SAVED = process.env[ENV_STEER]
process.env[ENV_STEER] = 'on'

/**
 * ② **权威源**：三条硬规矩第 2 条的**唯一**来源 —— 自检里**不许另抄一遍**。
 *   旧稿在自检里另抄了一份期望值，于是"第一版抄成 ASCII 被 ㉓ 抓出来"之后，
 *   修的人把**正确的 ASCII 改成弯引号**、又把错的字符写进期望值 ⇒ **假绿**。
 *   现在 ㉓ 读这个文件、机器抽取那一行，与 `HARD_RULES[1]` 逐字 `===`。
 *
 * ★★ **公开版（脱敏后）的修法**：路径**运行期派生**，**不再写作者机的绝对路径**。
 *
 *   病因（R43 公开包事故，实测）：旧稿写的是 `'D:\\<用户>\\<工作区>\\task-warden\\派单模板.md'`；
 *   脱敏规则（`publish/make-public.mjs:95`）把 `D:\<用户>\<工作区>` 换成 `<WORKSPACE>` ⇒
 *   公开版里变成 `'<WORKSPACE>\\task-warden\\派单模板.md'` —— 一个**语法完全合法、
 *   但永远不存在的路径**。随后 `:490` 那句 `fs.readFileSync(AUTH_SOURCE, 'utf8')`
 *   **没有 try/catch** ⇒ `ENOENT` 抛栈、进程退出，**连 PASS/FAIL 汇总都印不出来**。
 *
 *   现在的两级解析（**按可靠性从高到低**，与 `plugin-io.js` 的 `resolveWardenMjs` 同一套思路）：
 *     ① `TASK_WARDEN_ROOT` 环境变量 —— 显式指定（测试 / 非标准安装位置）
 *     ② 从 `__dirname` 往上找第一个**装着 `派单模板.md`** 的目录
 *        （公开包里自检装在 `<包根>\plugin\`，而 `派单模板.md` **根本不发** ⇒ 这里返回 null）
 *   都推不出来 ⇒ `AUTH_SOURCE = null`，**不是**随便拼一个路径去撞。
 *
 * ⚠ `派单模板.md` **不在公开包里**（见本单任务书："依赖未发布的私有文件"）。
 *   所以公开环境下这一组断言**必然核不了**。那就**如实报 SKIP**（见下面 ㉓ 那一组），
 *   **不许**改成"读不到就当通过"，**也不许**因为读不到就让整个进程崩掉 ——
 *   后面还有 90 多条与它无关的断言要印出来。
 */
function pickProjectRoot() {
  const up = []
  if (process.env.TASK_WARDEN_ROOT) up.push(String(process.env.TASK_WARDEN_ROOT))
  let d = __dirname
  for (let i = 0; i < 6; i++) {                 // 走到盘根就停（`path.dirname` 到根后不再变）
    up.push(d)
    const parent = path.dirname(d)
    if (parent === d) break
    d = parent
  }
  for (const c of up) {
    try { if (fs.existsSync(path.join(c, '派单模板.md'))) return c } catch (e) { /* 换下一个 */ }
  }
  return null
}
/** 权威源所在的那一层工程根；公开环境下为 `null`（**这是正常结果，不是错误**） */
const AUTH_ROOT = pickProjectRoot()
const AUTH_SOURCE = AUTH_ROOT ? path.join(AUTH_ROOT, '派单模板.md') : null
/** 抽取规则**只有这一条**：剥掉行首的 markdown 标题装饰（`## ⚠ `），其余一个字符都不动 */
const AUTH_HEADING = /^#{1,6}\s+\u26A0\s+(.*)$/
/** 列表项装饰（只为把"为什么不是 L53"打印成证据，**不参与判定**） */
const AUTH_BULLET = /^-\s+\u26A0\s+\*\*/

/** 把字符串打成码点串（证据用；中文一字一码点，长但可逐字核） */
function cps(s) {
  return Array.from(String(s === undefined || s === null ? '' : s))
    .map((ch) => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
    .join(' ')
}
function countOf(s, ch) {
  let n = 0
  for (const c of String(s === undefined || s === null ? '' : s)) if (c === ch) n += 1
  return n
}

/* ------------------------------------------------------------------ 测试台 */

let fails = 0
let passes = 0
let skips = 0
const rows = []

function check(no, title, ok, extra) {
  if (ok) passes += 1; else fails += 1
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${no}  ${title}${extra ? '  —— ' + extra : ''}`)
  return !!ok
}

/**
 * ★ **SKIP**：这条断言**核不了**（前置输入不存在），**不是**"核过了"。
 *   为什么不记 FAIL：那会把"公开包里没有这份输入"报成"插件坏了" —— 假红。
 *   为什么不记 PASS：那就是 A6 的病（把"核不了"当"核过了"）。
 *   ⇒ 单独一档，**逐条印出原因**，且**不进 `fails`**（不影响退出码）。
 *   ⚠ 用它的地方必须**同时**保证：核不了时**那条断言连 PASS 都没机会出现**
 *     （见 ㉓ 那一组：整组用 `if (!AUTH_READ.ok) skipGroup(...)` 短路）。
 */
function skip(no, title, why) {
  skips += 1
  rows.push(`SKIP  ${no}  ${title}${why ? '  —— ' + why : ''}`)
}

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'r43-handover-selftest-'))
process.on('exit', () => {
  try { fs.rmSync(BASE, { recursive: true, force: true }) } catch (e) { /* 清不掉就算了 */ }
  try {
    if (ENV_STEER_SAVED === undefined) delete process.env[ENV_STEER]
    else process.env[ENV_STEER] = ENV_STEER_SAVED
  } catch (e) { /* 恢复不了就算了 */ }
})

/** 造一个工程夹具：`.git` + `.warden` + 交接文件（mtime 可控） */
function mkProject(name, o) {
  const root = path.join(BASE, name)
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.mkdirSync(path.join(root, '.warden'), { recursive: true })
  for (const h of (o && o.handovers) || []) {
    const p = path.join(root, h.name)
    fs.writeFileSync(p, h.content === undefined ? '# 交接\n' : h.content, 'utf8')
    if (h.mtime) { const t = new Date(h.mtime); fs.utimesSync(p, t, t) }
  }
  for (const f of (o && o.files) || []) {
    const p = path.join(root, f)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'x\n', 'utf8')
  }
  return root
}

/** 假 agent（官方字段：`agent.session.header.id` / `.cwd`；**R43 返工**加 `phase.turn` 兜底源） */
function fakeAgent(sid, cwd, o) {
  const a = {
    session: { header: { id: sid, cwd: cwd } },
    steers: [],
    /** `dsh-agent-loop\lib\index.js:766-769` 的 phase 形状（`:930` `phase.turn = turn`） */
    phase: { kind: 'running', turn: (o && o.turn !== undefined) ? o.turn : 1 },
  }
  if (!o || o.steer !== false) a.steer = (m) => { a.steers.push(m); return true }
  return a
}

/**
 * 假 ctx —— 用 **Proxy** 把"插件到底碰了 ctx 的哪些属性"全部记下来。
 * 这是"不进上下文"那条硬约束的**证据**：插件只许碰 `on` / `effect`，
 * 碰任何别的东西（`systemPrompt` / `context` / `provide` / `set` / …）都会进 `touched`。
 */
function makeFakeCtx() {
  const touched = []
  const listeners = new Map()
  const effects = []
  const raw = {
    on(name, fn) {
      touched.push({ api: 'on', name: name })
      const arr = listeners.get(name) || []
      arr.push(fn)
      listeners.set(name, arr)
      const disp = () => {
        const a = listeners.get(name) || []
        const i = a.indexOf(fn)
        if (i >= 0) { a.splice(i, 1); return true }
        return false
      }
      return disp
    },
    effect(execute, label) {
      touched.push({ api: 'effect', label: label })
      const d = execute()
      effects.push(d)
      return () => { try { d() } catch (e) { /* 摘不掉 */ } }
    },
  }
  const ctx = new Proxy(raw, {
    get(t, prop) {
      if (prop === 'on' || prop === 'effect') return t[prop]
      if (typeof prop === 'symbol') return undefined
      touched.push({ api: 'GET', name: String(prop) })
      return undefined
    },
    set(t, prop) { touched.push({ api: 'SET', name: String(prop) }); return true },
  })
  return { ctx, touched, listeners, effects }
}

/** 复刻 `dsh-tools\lib\index.js:3116` 的 waterfall 形状（cordis 的 `next()` 链） */
function makeWaterfall(listeners) {
  return async function run(exec) {
    const cbs = (listeners || []).slice()
    const inner = () => Promise.resolve({ kind: 'allow' })
    const next = () => (cbs.shift() || inner)(exec, next)
    return next()
  }
}

/** 复刻 `dsh-tools\lib\index.js:3127-3138`：deny ⇒ 派发前 materialize 成 isError 结果 */
function materialize(decision) {
  const denialReason = decision.kind === 'allow' ? undefined : decision.reason
  if (denialReason === undefined) return { isError: false, content: [{ type: 'text', text: 'ok' }] }
  return { isError: true, error: { message: denialReason }, content: [{ type: 'text', text: `Error: ${denialReason}` }] }
}

const L = path.join(BASE, '_log', 'gate.jsonl')
fs.mkdirSync(path.dirname(L), { recursive: true })

/** 起一个装载好的实例（每个 case 各自独立，避免互相污染） */
function boot(opts) {
  const h = makeFakeCtx()
  const state = mod.install(h.ctx, Object.assign({ logPath: L }, opts || {}))
  return {
    h, state,
    wf: makeWaterfall(h.listeners.get('tools/pre-execute')),
    /** R43 返工新增的第 4 条监听：`agent/pre-step`（waterfall，payload 里带 turn） */
    wfPreStep: makeWaterfall(h.listeners.get('agent/pre-step')),
  }
}

/** 喂一次工具结果（走真实的 tools/result 监听器） */
function fireResult(h, exec, result) {
  for (const fn of (h.listeners.get('tools/result') || [])) fn(exec, result)
}
/** 喂一次回合收尾（走真实的 agent/turn-stopping 监听器） */
function fireTurnStopping(h, payload) {
  for (const fn of (h.listeners.get('agent/turn-stopping') || [])) fn(payload)
}
const OK_RESULT = { isError: false, content: [{ type: 'text', text: 'ok' }] }
const ERR_RESULT = { isError: true, error: { message: 'boom' }, content: [{ type: 'text', text: 'Error: boom' }] }

function execOf(name, args, agent) { return { name: name, arguments: args, agent: agent } }
function writeExec(file, agent) { return execOf('write', { file_path: file }, agent) }
function readExec(file, agent) { return execOf('read', { file_path: file }, agent) }
function shellExec(cmd, agent) { return execOf('pwsh', { command: cmd }, agent) }

/* ==========================================================================
 * 一、交接文件解析（R43 ③ / R40 ②）
 * ========================================================================== */

// ① `交接.md` 首选
const P_BASE = mkProject('p_base', { handovers: [{ name: '交接.md' }, { name: '交接-2026-09-24.md' }] })
const r1 = I.resolveHandover(P_BASE, {})
check('①', '`交接.md` 是首选（哪怕还有别的交接件）', r1.ok && r1.picked === '交接.md', r1.picked)

// ② 日期优先于 mtime —— 这是"最新"的口径，必须钉住
//    夹具故意反着造：09-24 那份 mtime 是 2020 年（更旧），09-01 那份 mtime 是现在（更新）
const P_LATEST = mkProject('p_latest', {
  handovers: [
    { name: '交接-2026-09-01.md', mtime: '2026-09-24T10:00:00Z' },
    { name: '交接-2026-09-24.md', mtime: '2020-01-01T00:00:00Z' },
    { name: '交接-做成DSH插件.md', mtime: '2026-09-24T11:00:00Z' },
  ],
})
const r2 = I.resolveHandover(P_LATEST, {})
const mtimeWinner = I.listHandovers(P_LATEST, {}).slice().sort((a, b) => b.mtime - a.mtime)[0].name
check('②', '`交接-*.md` 取**日期最新**的一份（日期优先于 mtime）',
  r2.ok && r2.picked === '交接-2026-09-24.md', 'picked=' + r2.picked)
check('②b', '**负控**：纯按 mtime 会挑错人 ⇒ 说明"日期优先"这条口径真的在起作用',
  mtimeWinner !== '交接-2026-09-24.md', '纯 mtime 会选 ' + mtimeWinner)

// ③ 名字里没有可解析的 ISO 日期 ⇒ 退回 mtime
const P_MTIME = mkProject('p_mtime', {
  handovers: [
    { name: '交接-甲.md', mtime: '2020-01-01T00:00:00Z' },
    { name: '交接-乙.md', mtime: '2026-09-24T00:00:00Z' },
  ],
})
const r3 = I.resolveHandover(P_MTIME, {})
check('③', '没有 ISO 日期时退回 mtime 最新', r3.ok && r3.picked === '交接-乙.md', 'picked=' + r3.picked)

// ④ **只读**验证：认得出本工程真实的那一份（派单点名要求）
//
// ★★ **公开版的修法**：`REAL_ROOT` **运行期派生**，不再写作者机绝对路径。
//   病因：旧稿是 `'D:\\<用户>\\<工作区>\\task-warden'` ⇒ 脱敏后变成 `'<WORKSPACE>\\task-warden'`
//   ⇒ 公开用户机器上这个目录**必然不存在**，④ 从"正控"退化成一个**假红**。
//
//   现在的做法：`__dirname` 就是自检所在目录；公开包里它在 `<包根>\plugin\`，
//   那一层就是"本工程"。往上 6 层里取第一个**真的有 `交接-*.md`** 的那层当 `REAL_ROOT`。
//   ⚠ **找不到就报 SKIP**（如实说"本机没有可对照的真工程"），**不改成恒真、也不报假红**。
//   ⚠ 为什么不是 FAIL：这条要核的是"`resolveHandover` 认得出**本机真实那份**交接"。
//     公开用户机器上**本来就没有**作者的交接文件 —— 那是"没有可核的对象"，不是插件错了。
function pickRealRoot() {
  let d = __dirname
  for (let i = 0; i < 6; i++) {
    try {
      if (I.listHandovers(d, {}).length > 0) return d
    } catch (e) { /* 这一层读不了，往上走 */ }
    const parent = path.dirname(d)
    if (parent === d) break
    d = parent
  }
  return null
}
const REAL_ROOT = pickRealRoot()
const REAL_HANDOVER = REAL_ROOT ? I.resolveHandover(REAL_ROOT, {}).path : null
const r4 = REAL_ROOT ? I.resolveHandover(REAL_ROOT, {}) : null
if (!REAL_ROOT) {
  skip('④', '认得出本工程真实交接（**只读**，一个字节都没动）',
    '**核不了**：从 `' + __dirname + '` 往上 6 层都没有 `交接.md` / `交接-*.md` '
    + '⇒ 本机（公开包里必然如此）**没有可对照的真工程交接**（这不是"核过了"）')
} else {
  check('④', '认得出本工程真实交接（**只读**，一个字节都没动）',
    !!(r4 && r4.ok && I.pathKey(r4.path) === I.pathKey(REAL_HANDOVER)),
    'root=' + REAL_ROOT + ' picked=' + (r4 ? r4.picked : '(无)') + ' how=' + (r4 ? r4.how : '(无)'))
}

/* ==========================================================================
 * 二、读闸（硬）—— 没读过交接之前不许改盘
 * ========================================================================== */

const P1 = mkProject('p1', { handovers: [{ name: '交接.md', content: '# 交接\n' }] })
const SID = 'session-selftest-1'
const AG = fakeAgent(SID, P1)
const TARGET = path.join(P1, 'src', 'a.js')
fs.mkdirSync(path.dirname(TARGET), { recursive: true })
fs.writeFileSync(TARGET, 'x\n', 'utf8')

// ⑤ 没读过 ⇒ write 被 deny，reason 里有可抄的绝对路径 + 三条硬规矩逐字
const B1 = boot()
const d1 = await B1.wf(writeExec(TARGET, AG))
const hPath = path.join(P1, '交接.md')
check('⑤', '没读过交接 ⇒ 第一次 `write` 被 deny', d1.kind === 'deny', 'kind=' + d1.kind)
check('⑤b', 'deny 的 reason 里逐字给出**可抄的绝对路径**', String(d1.reason).includes(hPath), hPath)
check('⑤c', 'deny 的 reason 里逐字带上**三条硬规矩**',
  I.HARD_RULES.every((r) => String(d1.reason).includes(r)),
  I.HARD_RULES.map((r, i) => (String(d1.reason).includes(r) ? '#' + (i + 1) + 'ok' : '#' + (i + 1) + 'MISSING')).join(' '))
check('⑤d', 'deny 的 reason 里说清「模型自称读过不算」', String(d1.reason).includes('模型自己说'))
check('⑤e', 'deny 的 reason 里给出补法（read 那条绝对路径）', String(d1.reason).includes('用 `read` 打开'))

// ⑥ **死锁负控**：read 自己不被拦（否则永远读不了交接）
const d2 = await B1.wf(readExec(hPath, AG))
check('⑥', '**负控（死锁）**：`read` 自己**不被拦**', d2.kind === 'allow', 'kind=' + d2.kind)

// ⑦ 负控：其它只读/记账类工具不被拦
const others = [
  ['glob', { pattern: '**/*.js' }], ['grep', { pattern: 'x', path: P1 }],
  ['todo_write', { todos: [] }], ['present', { files: [{ path: TARGET }] }],
  ['read_image', { file_path: path.join(P1, 'a.png') }], ['skill', { name: 'task-warden' }],
]
const otherKinds = []
for (const [n, a] of others) otherKinds.push(n + '=' + (await B1.wf(execOf(n, a, AG))).kind)
check('⑦', '**负控**：`glob`/`grep`/`todo_write`/`present`/`read_image`/`skill` 全不被拦',
  otherKinds.every((s) => s.endsWith('=allow')), otherKinds.join(' '))

// ⑧ ★ **R43 返工（S5）改了契约**：旧稿"只读 shell 不被拦"是**按关键词**判的，
//    于是 `pwsh -Command "node -e \"fs.writeFileSync(...)\""` 既不触发读闸也不触发写闸
//    ⇒ 能整条绕过 R43 改工程文件。现在：**未读交接 ⇒ 整个 shell 类都拒**。
const SHELL_PROBES = ['Get-Content "D:/x/交接.md"', 'node --check handover-gate.js', 'git status', 'ls -la', 'node --check x.js 2>&1']
const unreadShell = []
for (const c of SHELL_PROBES) unreadShell.push((await B1.wf(shellExec(c, AG))).kind)
check('⑧', '★ **未读交接 ⇒ 整个 shell 类都拒**（连 `git status`/`Get-Content` 这种只读命令也拒；S5 的修法）',
  unreadShell.every((k) => k === 'deny'), unreadShell.join(' '))
check('⑧a', '拒的理由里给出**可抄的交接绝对路径**，并说清"读交接不需要 shell"（所以不死锁）',
  String((await B1.wf(shellExec(SHELL_PROBES[0], AG))).reason).includes(hPath))
// ⑧b **负控（死锁）**：读过交接之后，只读 shell 放行（否则连看一眼都做不到）
const B8 = boot()
fireResult(B8.h, readExec(hPath, AG), OK_RESULT)
const roShell = []
for (const c of SHELL_PROBES) roShell.push((await B8.wf(shellExec(c, AG))).kind)
check('⑧b', '**负控（死锁）**：读交接**之后**，只读 shell 放行（含 `2>&1` 这条曾经会误命中的写法）',
  roShell.every((k) => k === 'allow'), roShell.join(' '))

// ⑨ 正控：成功 read 交接之后 ⇒ 放行
fireResult(B1.h, readExec(hPath, AG), OK_RESULT)
const d3 = await B1.wf(writeExec(TARGET, AG))
check('⑨', '**正控**：成功 read 交接之后 ⇒ `write` 放行', d3.kind === 'allow', 'kind=' + d3.kind)

// ⑩ 负控：read **失败**不算读过
const B10 = boot()
fireResult(B10.h, readExec(hPath, AG), ERR_RESULT)
const d10 = await B10.wf(writeExec(TARGET, AG))
check('⑩', '**负控**：`read` 失败（isError:true）**不算读过** ⇒ 仍 deny', d10.kind === 'deny', 'kind=' + d10.kind)

// ⑪ 负控：read 了别的文件不算读过
const B11 = boot()
fireResult(B11.h, readExec(TARGET, AG), OK_RESULT)
const d11 = await B11.wf(writeExec(TARGET, AG))
check('⑪', '**负控**：`read` 了**别的文件**不算读过 ⇒ 仍 deny', d11.kind === 'deny', 'kind=' + d11.kind)

// ⑫ 负控：读的是**旧的那份**交接 ⇒ 不算；且 reason 给的是**最新那份**的绝对路径
const B12 = boot()
fireResult(B12.h, readExec(path.join(P_LATEST, '交接-2026-09-01.md'), fakeAgent('s12', P_LATEST)), OK_RESULT)
const d12 = await B12.wf(writeExec(path.join(P_LATEST, 'src', 'b.js'), fakeAgent('s12', P_LATEST)))
check('⑫', '**负控**：读了**旧的那份**交接不算读过（R40② 要的是最新那份）',
  d12.kind === 'deny' && String(d12.reason).includes(path.join(P_LATEST, '交接-2026-09-24.md')),
  'kind=' + d12.kind)

// ⑬ 豁免：交接文件本身永远可写（否则"没读过 ⇒ 不许改盘"会把补救动作也拦死 = 死锁）
const B13 = boot()
const d13 = await B13.wf(writeExec(hPath, AG))
check('⑬', '**负控（死锁）**：交接文件本身**可写**（两条闸的共同豁免）', d13.kind === 'allow', 'kind=' + d13.kind)
const d13b = await B13.wf(execOf('edit', { file_path: path.join(P1, '交接-2026-01-01.md') }, AG))
check('⑬b', '豁免按**名字 + 工程根**判：根下的 `交接-*.md` 也算豁免项', d13b.kind === 'allow', 'kind=' + d13b.kind)

// ⑭ 交接文件不存在 ⇒ 拒绝 + 记一行失败（**我选的就是这条**，钉住）
const P_NO = mkProject('p_no_handover', { files: ['src/c.js'] })
const B14 = boot()
const d14 = await B14.wf(writeExec(path.join(P_NO, 'src', 'c.js'), fakeAgent('s14', P_NO)))
check('⑭', '交接文件不存在 ⇒ **拒绝**（fail-closed，不是放行）', d14.kind === 'deny', 'kind=' + d14.kind)
check('⑭b', 'reason 里说清「**这个工程里没有交接文件**」（与"没读到"分开）',
  String(d14.reason).includes('这个工程里没有交接文件'))
check('⑭c', 'reason 里给出应当新建的那条**绝对路径**',
  String(d14.reason).includes(path.join(P_NO, '交接.md')))
check('⑭d', '**记了一行失败**（`handover-missing`，不静默）',
  B14.state.failures.some((f) => f.ev === 'handover-missing'),
  JSON.stringify(B14.state.failures.map((f) => f.ev)))

// ⑮ 工程根推不出 ⇒ 不静默（记一行失败 + 放行）
const P_ORPHAN = path.join(BASE, 'orphan', 'sub')
fs.mkdirSync(P_ORPHAN, { recursive: true })
const orphanVia = I.findProjectRootVia(P_ORPHAN, {})
const B15 = boot()
const d15 = await B15.wf(writeExec(path.join(P_ORPHAN, 'z.js'), fakeAgent('s15', P_ORPHAN)))
check('⑮', '工程根推不出 ⇒ `via` 真的是 `unresolved`（先证明夹具本身成立）',
  orphanVia.root === null && orphanVia.via === 'unresolved', JSON.stringify(orphanVia))
check('⑮b', '推不出 ⇒ **记一行失败**（`root-unresolved`）**且不静默**',
  B15.state.failures.some((f) => f.ev === 'root-unresolved'),
  JSON.stringify(B15.state.failures.map((f) => f.ev)))
check('⑮c', '推不出 ⇒ 放行（"推不出"没有参照物；取舍写在 DESIGN.md 里）', d15.kind === 'allow', 'kind=' + d15.kind)

// ⑯ 祖先 .warden（静默路）⇒ 记一行失败
const ANC = path.join(BASE, 'anc')
fs.mkdirSync(path.join(ANC, '.warden'), { recursive: true })
const ANC_SUB = path.join(ANC, 'sub')
fs.mkdirSync(ANC_SUB, { recursive: true })
const ancVia = I.findProjectRootVia(ANC_SUB, {})
const B16 = boot()
await B16.wf(writeExec(path.join(ANC_SUB, 'y.js'), fakeAgent('s16', ANC_SUB)))
check('⑯', '祖先 `.warden` 这条路被标成 `ancestor-warden`（先证明夹具成立）',
  ancVia.via === 'ancestor-warden' && I.pathKey(ancVia.root) === I.pathKey(ANC), JSON.stringify(ancVia))
check('⑯b', '`ancestor-warden` ⇒ **记一行失败**（"落在谁的账本上"可查）',
  B16.state.failures.some((f) => f.ev === 'root-via-ancestor-warden'),
  JSON.stringify(B16.state.failures.map((f) => f.ev)))

/* ==========================================================================
 * 三、写闸（硬）—— 改过文件却没更新交接
 * ========================================================================== */

const P2 = mkProject('p2', { handovers: [{ name: '交接.md' }], files: ['src/a.js', 'src/b.js'] })
const SID2 = 'session-selftest-2'
const AG2 = fakeAgent(SID2, P2)
const H2 = path.join(P2, '交接.md')
const B2 = boot()
// 先满足读闸
fireResult(B2.h, readExec(H2, AG2), OK_RESULT)

// ⑰ 一轮里改过文件 + 没更新交接 ⇒ turn-stopping 建立欠账 ⇒ 下一次改盘动作被 deny
await B2.wf(writeExec(path.join(P2, 'src', 'a.js'), AG2))
fireResult(B2.h, writeExec(path.join(P2, 'src', 'a.js'), AG2), OK_RESULT)
await B2.wf(writeExec(path.join(P2, 'src', 'b.js'), AG2))
fireResult(B2.h, writeExec(path.join(P2, 'src', 'b.js'), AG2), OK_RESULT)
fireTurnStopping(B2.h, { turn: 1, agent: AG2 })
const dirtyRow = B2.state.turns[B2.state.turns.length - 1]
check('⑰', '收尾时认出"改了 2 个文件却没更新交接"',
  dirtyRow && dirtyRow.ev === 'dirty' && dirtyRow.dirty === 2, JSON.stringify(dirtyRow && { ev: dirtyRow.ev, dirty: dirtyRow.dirty }))
const d17 = await B2.wf(writeExec(path.join(P2, 'src', 'a.js'), AG2))
check('⑰b', '**写闸真的拦住**：下一轮第一次改盘动作被 deny', d17.kind === 'deny', 'kind=' + d17.kind)
check('⑰c', 'deny 理由里有"上一轮改了 N 个文件" + 逐字路径 + 三条硬规矩',
  String(d17.reason).includes('上一轮改了 2 个文件')
  && String(d17.reason).includes(path.join(P2, 'src', 'a.js'))
  && I.HARD_RULES.every((r) => String(d17.reason).includes(r)),
  'len=' + String(d17.reason).length)
check('⑰d', 'deny 理由里说清"这条路拦得住、turn-stopping 拦不住"',
  String(d17.reason).includes('serial') && String(d17.reason).includes('nextStep'))
check('⑰e', '写闸也拦 **shell 写动作**（同一道闸，不只有 write/edit）',
  (await B2.wf(shellExec('Set-Content -Path "D:/x/y.txt" -Value hi', AG2))).kind === 'deny')
check('⑰f', '**负控**：写闸下，交接文件本身仍可写（补救可达）',
  (await B2.wf(writeExec(H2, AG2))).kind === 'allow')

// ⑱ 写闸的收尾侧：steer **真的被调用**（阻止收尾的代码证据）
check('⑱', '**阻止收尾**：`agent.steer()` 真的被调用（`:973` 的 break 因此不成立）',
  AG2.steers.length === 1, 'steers=' + AG2.steers.length)
const steerMsg = AG2.steers[0]
const steerText = steerMsg && steerMsg.content && steerMsg.content[0] && steerMsg.content[0].text
check('⑱b', 'steer 文本里给出交接的**绝对路径** + "这不是提醒"的机制说明',
  !!steerText && steerText.includes(H2) && steerText.includes('不是"提醒"'), String(steerText || '').slice(0, 60))

// ⑲ 防环：同一回合第二次收尾不再 steer；每会话上限 2
fireResult(B2.h, writeExec(path.join(P2, 'src', 'a.js'), AG2), OK_RESULT)
fireTurnStopping(B2.h, { turn: 1, agent: AG2 })
const afterCap = B2.state.turns[B2.state.turns.length - 1]
check('⑲', '**防环**：同一回合第二次收尾不再 steer（`turn-cap`）',
  afterCap && afterCap.steered === false && afterCap.why === 'turn-cap',
  JSON.stringify(afterCap && { steered: afterCap.steered, why: afterCap.why }))
check('⑲b', '**防环**：每会话 steer 上限 = 2（I60 事故的教训，硬上限）',
  AG2.steers.length === 1 && B2.state.steers.get(SID2) === 1,
  'steers=' + AG2.steers.length + ' counter=' + B2.state.steers.get(SID2))

// ⑳ 正控：改文件 **且** 更新交接 ⇒ 欠账清掉、不拦
const B20 = boot()
fireResult(B20.h, readExec(H2, AG2), OK_RESULT)
fireResult(B20.h, writeExec(path.join(P2, 'src', 'a.js'), AG2), OK_RESULT)
fireResult(B20.h, writeExec(H2, AG2), OK_RESULT)          // ← 更新了交接
fireTurnStopping(B20.h, { turn: 1, agent: AG2 })
const cleanRow = B20.state.turns[B20.state.turns.length - 1]
check('⑳', '**正控**：改了文件**且**更新了交接 ⇒ 收尾不记账、不 steer',
  cleanRow && cleanRow.ev === 'clean' && AG2.steers.length === 1,
  JSON.stringify(cleanRow && { ev: cleanRow.ev, handoverTouched: cleanRow.handoverTouched }))
check('⑳b', '**正控**：欠账没建立 ⇒ 下一次改盘动作放行',
  (await B20.wf(writeExec(path.join(P2, 'src', 'a.js'), AG2))).kind === 'allow')

// ㉑ 失败写（isError:true）不算脏
const B21 = boot()
fireResult(B21.h, readExec(H2, AG2), OK_RESULT)
fireResult(B21.h, writeExec(path.join(P2, 'src', 'a.js'), AG2), ERR_RESULT)
fireTurnStopping(B21.h, { turn: 1, agent: AG2 })
const lastRow21 = B21.state.turns[B21.state.turns.length - 1]
check('㉑', '**负控**：失败的写（`isError:true`）不算脏 ⇒ 不建立欠账',
  !lastRow21 || lastRow21.ev !== 'dirty', JSON.stringify(lastRow21 || null))

// ㉒ 写闸的欠账**只能**靠写交接来清
const B22 = boot()
fireResult(B22.h, readExec(H2, AG2), OK_RESULT)
fireResult(B22.h, writeExec(path.join(P2, 'src', 'a.js'), AG2), OK_RESULT)
fireTurnStopping(B22.h, { turn: 1, agent: AG2 })
await B22.wf(writeExec(path.join(P2, 'src', 'a.js'), AG2))     // 被拦（欠账在）
fireResult(B22.h, writeExec(H2, AG2), OK_RESULT)              // 写交接 ⇒ 清
check('㉒', '**写闸的解锁方式只有一条**：把交接真的写下去',
  (await B22.wf(writeExec(path.join(P2, 'src', 'a.js'), AG2))).kind === 'allow')

/* ==========================================================================
 * 四、契约：三条硬规矩逐字 / 不进上下文 / 可逆
 * ========================================================================== */

/**
 * ㉓ 三条硬规矩与**权威源**逐条逐字比对。
 *
 * ★★ R43 返工的核心修法：**期望值从权威源机器抽取，不在自检里另抄一遍**。
 *   旧稿在这里又抄了一份 `EXPECTED_RULES`，于是"第一版抄成 ASCII 被 ㉓ 抓出来"之后，
 *   修的人把**正确的 ASCII 改成了弯引号 U+201C/U+201D**，并把**错的字符**写进这份期望值
 *   ⇒ 58/58 里含一条**假绿**（这正是 A5「不许拿听上去合理的解释代替核实」的现场）。
 *
 * ★★ 第二次返工（R44 的复核 agent 报回来的）：**三条里没有一条是逐字**：
 *   · 第 2 条：引号抄错（弯引号 vs ASCII）—— 上面那条；
 *   · 第 1 条：**权威源是两行**（L13 错写法 + L14 正写法），**两行里都没有 U+3000**；
 *     实现却用 **U+3000 把两行拼成了一行**，旧注释还把结论写成"权威源里两个引号之间是全角空格"
 *     —— **那是拼的时候自己加的**。⇒ 不是抄错字符，是**改写结构**。
 *   · 第 3 条：**压缩句**（权威源 L22 只到"指到镜像"，没有"（否则 lab 会跑真原件）。"）。
 *
 * 取哪些行、为什么（**必须写清**）：
 *   · **L13 / L14**：第 1 条在权威源里就是这两行（§〇「逐字抄，不许改写」围栏块里）。
 *     ⇒ `HARD_RULES[0]`/`[1]`，**照两行**，**不拼**（㉓g/㉓h 专门钉这件事）。
 *   · **L18**：第 2 条，在同一个围栏块里 ⇒ `HARD_RULES[2]`。
 *   · **L22**：第 3 条，同一个围栏块里的标题行 ⇒ `HARD_RULES[3]`。
 *   · **不取 L53**：那是"标准结构"示例里的列表项，措辞**少一个「来」**、
 *     且带 `- ⚠ **…**` 装饰 —— 两行措辞不同，能逐字对上的只有 L18（㉓e 钉住）。
 *   · 抽取规则**只有一条**：有行首 markdown 标题装饰（`## ⚠ ` / `## ⚠⚠ `）就剥掉，
 *     **其余一个字符都不动**（不拼接、不加 U+3000、不剥 `**`、不改引号、不补句号）。
 *   · 行号写死 = **漂移探测**：权威源被改动了行数 ⇒ 这里变红，人来复核（fail-closed）。
 *
 * ★★ **公开版的修法**：这一段**不再无条件 `readFileSync`**。
 *   旧稿那句 `fs.readFileSync(AUTH_SOURCE, 'utf8')` **没有 try/catch** ⇒ 公开版里
 *   `AUTH_SOURCE` 是 `<WORKSPACE>\task-warden\派单模板.md`（脱敏产物，永远不存在）
 *   ⇒ `ENOENT` 抛栈、进程退出、**一条 PASS/FAIL 都印不出来**（R43 公开包事故，已实测）。
 *
 *   现在：读得到 ⇒ 照旧逐字核；**读不到 ⇒ 这一组报 SKIP 并写明"因为找不到 X"**。
 *   ⚠ 为什么是 **SKIP 而不是 FAIL**：这条断言要核的是"插件里的硬规矩 == 权威源里的原话"。
 *     公开包里**权威源根本不发**（`publish/make-public.mjs` 的 ADD/REFRESH 清单里没有它），
 *     所以这不是"插件错了"，而是"**这份输入在公开包里不存在**"。
 *     把它报成 FAIL 会让公开用户看到一片红，误以为插件坏了 —— 那是**假红**。
 *     SKIP **不进 `fails`**（退出码不受影响），但**逐条印出来**，
 *     并且**绝不放行**：下面 ㉓ 那一组在 `AUTH_TEXT === null` 时**一条都不判 PASS**。
 *   ⚠⚠ 这里的 SKIP **不等于通过**：它印的是"**核不了**（因为找不到 派单模板.md）"。
 *     把"核不了"当"核过了"正是本项目 A6 的病，这里明写出来防它。
 */
const AUTH_READ = (function () {
  if (!AUTH_SOURCE) return { ok: false, text: null, why: '本机（或本包）里找不到 `派单模板.md` —— 从 `' + __dirname + '` 往上 6 层都探过了；也可用 TASK_WARDEN_ROOT 显式指定' }
  try {
    return { ok: true, text: fs.readFileSync(AUTH_SOURCE, 'utf8'), why: null }
  } catch (e) {
    return { ok: false, text: null, why: '读 ' + AUTH_SOURCE + ' 失败：' + (e && e.code ? e.code : String(e)) }
  }
})()
const AUTH_TEXT = AUTH_READ.ok ? AUTH_READ.text : null
const AUTH_LINES = (AUTH_TEXT === null ? [] : AUTH_TEXT.split(/\r?\n/))
/** 1-based 行号：第 1 条 = 两行（L13 错写法 / L14 正写法）；第 2 条 = L18；第 3 条 = L22 */
const AUTH_RULE_LINES = [13, 14, 18, 22]
const extractAuthLine = (n) => {
  const l = AUTH_LINES[n - 1]
  if (typeof l !== 'string') return null
  const m = AUTH_HEADING.exec(l)
  return m ? m[1] : l
}
const AUTH_RULES = AUTH_RULE_LINES.map(extractAuthLine)
const authLine53 = AUTH_LINES[52]
const AUTH_RULE2_ALT = (typeof authLine53 === 'string')
  ? authLine53.replace(AUTH_BULLET, '').replace(/\*\*$/, '')
  : null

/**
 * ★★ 权威源整组（㉓ 及其 9 个分条）：**先看输入在不在**。
 *
 *   `AUTH_READ.ok === false`（公开包里必然如此：`派单模板.md` 不发）⇒
 *   **整组一条都不进 `check()`**，全部走 `skip()` 并把原因逐字印出来。
 *
 *   ⚠ 这里**刻意不做**"读不到就用别的期望值兜住"—— 那样就是拿自检自己当权威源，
 *     正是 ㉓ 当初要防的"假绿"（旧稿的期望值抄错过一次）。
 *   ⚠ 也**刻意不把** `I.HARD_RULES` 本身当期望值 —— 那会让这条断言恒真（A6 的变体）。
 */
if (!AUTH_READ.ok) {
  const WHY = '**核不了**：' + AUTH_READ.why + '（这不是"核过了"—— 权威源不在，本组一条都没核）'
  skip('㉓', '★★ 三条硬规矩与权威源**逐条逐字**相同（按 L13/L14/L18/L22 机器抽取后逐条 `===`，自检里没另抄）', WHY)
  skip('㉓a', '抽出来的**就是那三条**：第 1 条含"错写法/正写法"，第 2 条含"不许用/加提示词/解决任何问题"，第 3 条含"DSH_HOME/镜像"', WHY)
  skip('㉓b', '★ **全角空格 U+3000 一个都不许有**（旧稿正是用它把第 1 条的两行拼成了一行）', WHY)
  skip('㉓c', '★ 第 2 条引号是 **ASCII U+0022**；**弯引号 U+201C / U+201D 一个都不许有**', WHY)
  skip('㉓e', '**选 L18 是有理由的**：L53（标准结构里的列表项）与 L18 **措辞不同** ⇒ 逐字对不上的只有 L53', WHY)
  skip('㉓f', '权威源自己**没有**弯引号版本（`U+201C加提示词U+201D` 在整个文件里不存在）', WHY)
  skip('㉓g', '★ **第 1 条照权威源的两行**（L13 错写法行 + L14 正写法行 各自 `===` 原行，连行尾注与对齐空格都不动）', WHY)
  skip('㉓i', '**负控（证明 ㉓b 不是恒真）**：把两行按旧稿的拼法拼起来 ⇒ 上面那条判据**必须为假**', WHY)
  // ⚠ ㉓d / ㉓h **不依赖权威源**（它们只核插件自己 `HARD_RULES` / `rulesBlock()` 的形状）
  //   ⇒ 这两条**照旧真跑**，不降级。降级它们才是"为了让文件变绿而削弱检查"。
} else {
check('㉓', '★★ 三条硬规矩与权威源**逐条逐字**相同（按 L13/L14/L18/L22 机器抽取后逐条 `===`，自检里没另抄）',
  I.HARD_RULES.length === 4 && AUTH_RULES.every((r) => typeof r === 'string') && I.HARD_RULES.every((r, i) => r === AUTH_RULES[i]),
  I.HARD_RULES.map((r, i) => (r === AUTH_RULES[i] ? '#' + (i + 1) + 'ok' : '#' + (i + 1) + 'DIFF')).join(' '))
check('㉓a', '抽出来的**就是那三条**：第 1 条含"错写法/正写法"，第 2 条含"不许用/加提示词/解决任何问题"，第 3 条含"DSH_HOME/镜像"',
  !!AUTH_RULES[0] && AUTH_RULES[0].includes('错写法') && !!AUTH_RULES[1] && AUTH_RULES[1].includes('正写法')
  && !!AUTH_RULES[2] && AUTH_RULES[2].includes('不许用') && AUTH_RULES[2].includes('加提示词') && AUTH_RULES[2].includes('解决任何问题')
  && !!AUTH_RULES[3] && AUTH_RULES[3].includes('DSH_HOME') && AUTH_RULES[3].includes('镜像'))
check('㉓b', '★ **全角空格 U+3000 一个都不许有**（旧稿正是用它把第 1 条的两行拼成了一行）',
  !I.HARD_RULES.some((r) => r.includes('\u3000')) && !AUTH_RULES.some((r) => r && r.includes('\u3000'))
  && !AUTH_TEXT.includes('\u3000'),
  'HARD_RULES 里 U+3000 数=' + I.HARD_RULES.filter((r) => r.includes('\u3000')).length
  + '；权威源全文里 U+3000 数=' + countOf(AUTH_TEXT, '\u3000'))
check('㉓c', '★ 第 2 条引号是 **ASCII U+0022**；**弯引号 U+201C / U+201D 一个都不许有**',
  countOf(I.HARD_RULES[2], '\u0022') === 2
  && countOf(I.HARD_RULES[2], '\u201C') === 0 && countOf(I.HARD_RULES[2], '\u201D') === 0
  && countOf(AUTH_RULES[2] || '', '\u0022') === 2
  && countOf(AUTH_RULES[2] || '', '\u201C') === 0 && countOf(AUTH_RULES[2] || '', '\u201D') === 0,
  'U+0022×' + countOf(I.HARD_RULES[2], '\u0022') + ' / U+201C×' + countOf(I.HARD_RULES[2], '\u201C')
  + ' / U+201D×' + countOf(I.HARD_RULES[2], '\u201D'))
}
check('㉓d', '每条 deny 理由里的硬规矩是**整行原样**（4 行一行不漏，不是被润色过的版本）',
  I.rulesBlock().split('\n').filter((l) => I.HARD_RULES.includes(l)).length === 4)
if (AUTH_READ.ok) {
check('㉓e', '**选 L18 是有理由的**：L53（标准结构里的列表项）与 L18 **措辞不同** ⇒ 逐字对不上的只有 L53',
  !!AUTH_RULE2_ALT && AUTH_RULE2_ALT !== AUTH_RULES[2] && AUTH_RULE2_ALT.includes('加提示词'),
  'L53 抽取=' + JSON.stringify(AUTH_RULE2_ALT))
check('㉓f', '权威源自己**没有**弯引号版本（`U+201C加提示词U+201D` 在整个文件里不存在）',
  !AUTH_TEXT.includes('\u201C加提示词\u201D'))
check('㉓g', '★ **第 1 条照权威源的两行**（L13 错写法行 + L14 正写法行 各自 `===` 原行，连行尾注与对齐空格都不动）',
  I.HARD_RULES[0] === AUTH_LINES[12] && I.HARD_RULES[1] === AUTH_LINES[13],
  'L13 len=' + (AUTH_LINES[12] || '').length + ' L14 len=' + (AUTH_LINES[13] || '').length)
}
check('㉓h', '★ **旧稿"拼出来的那一行"已经不存在**（`只改你点名的文件」` + U+3000 这个形态在插件里 0 命中）',
  !JSON.stringify(I.HARD_RULES).includes('只改你点名的文件\u3000')
  && !JSON.stringify(I.HARD_RULES).includes('只改你点名的文件」\u3000')
  && !I.rulesBlock().includes('\u3000'))
if (AUTH_READ.ok) {
check('㉓i', '**负控（证明 ㉓b 不是恒真）**：把两行按旧稿的拼法拼起来 ⇒ 上面那条判据**必须为假**',
  (AUTH_LINES[12] + '\u3000' + AUTH_LINES[13]).includes('\u3000'))
}

// ㉔ 不进上下文：对 ctx 的每一次调用都列出来，并证明没有 systemPrompt / context / 消息通道
//    ⚠ 走 `mod.apply()`（Cordis 真正调的那条路），这样 `ctx.effect` 那次调用也会被记下来。
const B24 = makeFakeCtx()
mod.apply(B24.ctx)
const apis = B24.touched.map((t) => t.api + (t.name ? '(' + t.name + ')' : t.label ? '(' + t.label + ')' : ''))
/**
 * ⚠ 这里第一版写错过：我把 `'tool'`/`'tools'` 也放进了禁词表，而**事件名本身**就叫
 *   `tools/pre-execute` ⇒ 假红。教训：禁词表要盯"**ctx 的属性名**"，
 *   不是"参数里出现的字符串"。现在只盯属性名（`t.api === 'GET'|'SET'` 的那些），
 *   事件名单独用 ㉔c 断言"只有这 3 条"。
 */
const FORBIDDEN_PROPS = ['systemprompt', 'context', 'provide', 'message', 'channel', 'prompt', 'register', 'emit', 'waterfall', 'serial', 'steer', 'service', 'set', 'get', 'inject', 'tools', 'tool', 'approval', 'storage', 'shell']
const forbiddenHits = B24.touched.filter((t) => (t.api === 'GET' || t.api === 'SET') && FORBIDDEN_PROPS.some((f) => String(t.name).toLowerCase().includes(f)))
check('㉔', '对 `ctx` 的访问**只有** `on(...)` 与 `effect(...)`（Proxy 逐次记录，无遗漏）',
  B24.touched.every((t) => t.api === 'on' || t.api === 'effect'),
  'apis=' + JSON.stringify(apis))
check('㉔b', '**没有任何** systemPrompt / runtime context / 消息通道注册（ctx 属性一个都没碰）',
  B24.touched.every((t) => t.api === 'on' || t.api === 'effect') && forbiddenHits.length === 0,
  'forbidden-props-touched=' + JSON.stringify(forbiddenHits))
check('㉔c', '只注册了 **4** 条监听（pre-execute / result / turn-stopping / pre-step）+ 1 个 effect',
  B24.touched.filter((t) => t.api === 'on').length === 4
  && B24.touched.filter((t) => t.api === 'on').map((t) => t.name).sort().join(',') === 'agent/pre-step,agent/turn-stopping,tools/pre-execute,tools/result'
  && B24.touched.filter((t) => t.api === 'effect').length === 1,
  JSON.stringify(B24.touched.filter((t) => t.api === 'on').map((t) => t.name)))

// ㉕ 可逆：dispose 后监听器全摘掉
const B25 = makeFakeCtx()
const st25 = mod.install(B25.ctx, { logPath: L })
const before = Array.from(B25.listeners.keys()).map((k) => k + ':' + B25.listeners.get(k).length).sort().join(' ')
mod.uninstall(st25)
const after = Array.from(B25.listeners.keys()).map((k) => k + ':' + B25.listeners.get(k).length).sort().join(' ')
const totalAfter = Array.from(B25.listeners.values()).reduce((n, a) => n + a.length, 0)
check('㉕', '**可逆**：dispose 后监听器**全摘掉**（计数归 0）',
  totalAfter === 0, 'before=[' + before + '] after=[' + after + ']')
check('㉕b', '**可逆**：内存状态也清了（read/cur/pending/steers 全空）',
  st25.read.size === 0 && st25.cur.size === 0 && st25.pending.size === 0 && st25.steers.size === 0)
let uninstallThrew = false
try { mod.uninstall(st25); mod.uninstall(st25) } catch (e) { uninstallThrew = true }
check('㉕c', '**可逆**：重复 dispose 安全（幂等，不抛）', !uninstallThrew)

// ㉖ fail-open：判定体内部抛异常 ⇒ 放行（绝不让看守坏了而让工具调用失败）
const B26 = boot()
const brokenFs = {
  existsSync() { throw new Error('boom-existsSync') },
  statSync() { throw new Error('boom-statSync') },
  readdirSync() { throw new Error('boom-readdirSync') },
  readFileSync() { throw new Error('boom-readFileSync') },
}
const B26b = makeFakeCtx()
mod.install(B26b.ctx, { fs: brokenFs, path: path, logPath: L })
const wf26 = makeWaterfall(B26b.listeners.get('tools/pre-execute'))
const d26 = await wf26(writeExec(TARGET, AG))
check('㉖', '**fail-open**：判据内部炸了 ⇒ 放行（不让一次工具调用因为看守坏了而失败）',
  d26.kind === 'allow', 'kind=' + d26.kind)

/* ==========================================================================
 * 五、端到端：真实 waterfall 形状 + materialize
 * ========================================================================== */

const P3 = mkProject('p3', { handovers: [{ name: '交接.md' }], files: ['src/a.js'] })
const SID3 = 'session-selftest-e2e'
const AG3 = fakeAgent(SID3, P3)
const H3 = path.join(P3, '交接.md')
const T3 = path.join(P3, 'src', 'a.js')
const B3 = boot()
const e2eDeny = materialize(await B3.wf(writeExec(T3, AG3)))
check('㉗', '**端到端**：第一次 `write` 走真实 waterfall ⇒ materialize 出 isError 结果',
  e2eDeny.isError === true && String(e2eDeny.content[0].text).startsWith('Error: '),
  'isError=' + e2eDeny.isError)
const e2eAllow = (await (async () => {
  fireResult(B3.h, readExec(H3, AG3), OK_RESULT)
  return B3.wf(writeExec(T3, AG3))
})())
check('㉗b', '**端到端**：读交接之后同一动作放行（正控）', e2eAllow.kind === 'allow', 'kind=' + e2eAllow.kind)

/* ==========================================================================
 * 六、性能（用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」）
 * ========================================================================== */

const BPERF = boot()
fireResult(BPERF.h, readExec(H3, AG3), OK_RESULT)
const AGP = AG3

function bench(label, n, fn) {
  fn() // 预热
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < n; i++) fn()
  const ns = Number(process.hrtime.bigint() - t0) / n
  return { label: label, n: n, ns: ns, us: ns / 1000 }
}
/** 基准单位：本机一次 `existsSync` 多少钱 —— 用它把"多花多少"翻译成人能判断的话 */
function benchBaseline(n) {
  const p = path.join(BASE, 'p1', '交接.md')
  fs.existsSync(p)
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < n; i++) fs.existsSync(p)
  return Number(process.hrtime.bigint() - t0) / n / 1000
}
const baseExistsUs = benchBaseline(3000)
const perf = [
  bench('非改盘调用（read/glob/grep/todo…）', 20000, () => I.decideWrite(BPERF.state, { toolName: 'read', toolArgs: { file_path: T3 }, sessionId: SID3, cwd: P3 }, {})),
  bench('改盘调用·放行路径（已读交接）', 3000, () => I.decideWrite(BPERF.state, { toolName: 'write', toolArgs: { file_path: T3 }, sessionId: SID3, cwd: P3 }, {})),
  bench('改盘调用·deny 路径（含 ~1 KB 理由拼装）', 3000, () => I.decideWrite(BPERF.state, { toolName: 'write', toolArgs: { file_path: T3 }, sessionId: 'never-read', cwd: P3 }, {})),
]
const asExists = (us) => (us / baseExistsUs).toFixed(1) + ' 次 existsSync'
/**
 * 阈值口径（**先说清凭什么**）：一次真实的改盘工具调用（write/edit 落盘、pwsh 起进程）
 * 是 **ms 级**；本闸在改盘路径上花的是**亚毫秒**。所以阈值定在"远小于一次工具调用的固有开销"，
 * 而不是定一个好看的绝对数：非改盘 5 µs（零 IO 的纯分支）、改盘 5 ms（约一次 write 的固有开销量级）。
 */
check('㉘', '**性能**：非改盘调用是**零 IO** 的纯分支（< 5 µs/次）',
  perf[0].us < 5, perf[0].us.toFixed(3) + ' µs/次，≈ ' + asExists(perf[0].us) + '（本机 1 次 existsSync = ' + baseExistsUs.toFixed(1) + ' µs）')
check('㉘b', '**性能**：改盘调用·放行 < 5 ms/次（只有 write/edit/pwsh 才会走到这里）',
  perf[1].us < 5000, perf[1].us.toFixed(1) + ' µs/次，≈ ' + asExists(perf[1].us))
check('㉘c', '**性能**：改盘调用·deny（拼 ~1 KB 理由）< 5 ms/次',
  perf[2].us < 5000, perf[2].us.toFixed(1) + ' µs/次，≈ ' + asExists(perf[2].us))

/* ==========================================================================
 * 七、★ R43 **返工**的判定性实验（S1 / S2 / (4) / (5) / (6) / (7)）
 *    每条都是"先证明夹具成立 / 再证明旧行为是错的 / 最后证明新行为对"三段式。
 * ========================================================================== */

/* ── S1：子代理改了文件 ⇒ 父会话**必须**看得见（欠账按**工程根**记，不按 sid） ── */
const P_S1 = mkProject('p_s1', { handovers: [{ name: '交接.md' }], files: ['src/sub.js', 'src/parent.js'] })
const H_S1 = path.join(P_S1, '交接.md')
const SUB_FILE = path.join(P_S1, 'src', 'sub.js')
const PAR_FILE = path.join(P_S1, 'src', 'parent.js')
const SID_P = 'session-s1-parent'
const SID_S = 'session-s1-sub'
const AG_P = fakeAgent(SID_P, P_S1, { turn: 1 })
const AG_S = fakeAgent(SID_S, P_S1, { turn: 1 })
const BS1 = boot()
fireResult(BS1.h, readExec(H_S1, AG_P), OK_RESULT)            // 父会话自己也要满足读闸
fireResult(BS1.h, writeExec(SUB_FILE, AG_S), OK_RESULT)       // **父会话一个字节都不改**，改盘全交给子代理
fireTurnStopping(BS1.h, { turn: 1, agent: AG_S })             // 子代理收尾
check('S1a', '子代理收尾后，欠账落在**工程根**上（旧稿按 sid 存 ⇒ 父会话什么都看不见）',
  BS1.state.pending.has(I.pathKey(P_S1)) && !BS1.state.pending.has(SID_S),
  'pending keys=' + JSON.stringify(Array.from(BS1.state.pending.keys())))
const S1_PENDING_KEYS = Array.from(BS1.state.pending.keys())   // 证据：S1d 会把它清掉，先留一份
const dS1 = await BS1.wf(writeExec(PAR_FILE, AG_P))
check('S1b', '★★ **父会话的改盘动作被 deny**（旧稿实测 `E11 {"turnRow":null,"steers":0,"pending":null}`）',
  dS1.kind === 'deny', 'kind=' + dS1.kind)
check('S1c', '父会话拿到的理由里列的是**子代理改过的那个路径**（信息真的传过来了）',
  String(dS1.reason).includes(SUB_FILE))
fireResult(BS1.h, writeExec(H_S1, AG_P), OK_RESULT)           // 父会话写那一份交接 ⇒ 清欠账
check('S1d', '**正控**：父会话写**解析出来的那一份**交接 ⇒ 欠账清、改盘放行',
  !BS1.state.pending.has(I.pathKey(P_S1))
  && (await BS1.wf(writeExec(PAR_FILE, AG_P))).kind === 'allow')

/* ── S2：`cur` 跨回合泄漏 ⇒ 回合 B 被误判 clean（审查实测 E16 的现场） ── */
const P_S2 = mkProject('p_s2', { handovers: [{ name: '交接.md' }], files: ['src/a.js', 'src/b.js'] })
const H_S2 = path.join(P_S2, '交接.md')
const A_S2 = path.join(P_S2, 'src', 'a.js')
const B_S2 = path.join(P_S2, 'src', 'b.js')
const SID_2 = 'session-s2'
const AG_2 = fakeAgent(SID_2, P_S2, { turn: 1 })
const BS2 = boot()
fireResult(BS2.h, readExec(H_S2, AG_2), OK_RESULT)
// 回合 A（turn 1）：改 1 个文件 **并且** 更新了交接 —— 然后**跳过** A 的 turn-stopping
// （`:941` reject / abort / `:945` / `:976` 都会跳过它；旧稿正是靠 `handoverTouched=true` 泄漏）
fireResult(BS2.h, writeExec(A_S2, AG_2), OK_RESULT)
fireResult(BS2.h, writeExec(H_S2, AG_2), OK_RESULT)
AG_2.phase.turn = 2                                  // 回合 B 开始（A 的 turn-stopping 已被跳过）
fireResult(BS2.h, writeExec(B_S2, AG_2), OK_RESULT)  // 回合 B：改了 1 个文件，**没有**更新交接
fireTurnStopping(BS2.h, { turn: 2, agent: AG_2 })
const rowB = BS2.state.turns[BS2.state.turns.length - 1]
check('S2a', '★★ 回合 A 脏且**跳过** turn-stopping、回合 B 改了 1 个文件没写交接 ⇒ 回合 B **不许判 clean**',
  !!rowB && rowB.ev === 'dirty' && rowB.turn === 2,
  JSON.stringify(rowB && { ev: rowB.ev, turn: rowB.turn, dirty: rowB.dirty, why: rowB.why }))
check('S2b', '而且欠账真的建立了（**按工程根**）⇒ 之后的下一次改盘动作被 deny',
  BS2.state.pending.has(I.pathKey(P_S2))
  && (await BS2.wf(writeExec(B_S2, AG_2))).kind === 'deny')

// S2c/S2d：另一条更狠的构造 —— 回合 B **什么都没改**，也必须把 A 的脏账算出来
const P_S2C = mkProject('p_s2c', { handovers: [{ name: '交接.md' }], files: ['src/a.js'] })
const H_S2C = path.join(P_S2C, '交接.md')
const SID_2C = 'session-s2c'
const AG_2C = fakeAgent(SID_2C, P_S2C, { turn: 1 })
const BS2C = boot()
fireResult(BS2C.h, readExec(H_S2C, AG_2C), OK_RESULT)
fireResult(BS2C.h, writeExec(path.join(P_S2C, 'src', 'a.js'), AG_2C), OK_RESULT)   // 回合 A 脏
AG_2C.phase.turn = 2                                                             // A 的 turn-stopping 被跳过
fireTurnStopping(BS2C.h, { turn: 2, agent: AG_2C })                              // 回合 B：什么都没改
const rowB2 = BS2C.state.turns[BS2C.state.turns.length - 1]
check('S2c', '★★ 回合 A 脏（跳过 turn-stopping）、回合 B **什么都没改** ⇒ 回合 B **不许判 clean**',
  !!rowB2 && rowB2.ev === 'dirty' && rowB2.turn === 1,
  JSON.stringify(rowB2 && { ev: rowB2.ev, turn: rowB2.turn, dirty: rowB2.dirty }))
check('S2d', '而且欠账建立了 ⇒ 改盘动作被 deny',
  BS2C.state.pending.has(I.pathKey(P_S2C))
  && (await BS2C.wf(writeExec(path.join(P_S2C, 'src', 'a.js'), AG_2C))).kind === 'deny')

// S2e/S2f：回合号的**主源**是官方事件 `agent/pre-step`（payload 里就带 turn）
const P_S2E = mkProject('p_s2e', { handovers: [{ name: '交接.md' }], files: ['src/a.js'] })
const H_S2E = path.join(P_S2E, '交接.md')
const SID_2E = 'session-s2e'
const AG_2E = fakeAgent(SID_2E, P_S2E, { turn: 1 })
const BS2E = boot()
fireResult(BS2E.h, readExec(H_S2E, AG_2E), OK_RESULT)
fireResult(BS2E.h, writeExec(path.join(P_S2E, 'src', 'a.js'), AG_2E), OK_RESULT)   // turn 1 脏
await BS2E.wfPreStep({ turn: 2, step: 1, agent: AG_2E })                          // 回合 2 开始（官方事件）
check('S2e', '`agent/pre-step` 一到新回合就把上一回合的脏账收尾成欠账（**turn-stopping 被跳过也收**）',
  BS2E.state.pending.has(I.pathKey(P_S2E)) && I.turnOf(BS2E.state, AG_2E, SID_2E) === 2,
  'turn=' + I.turnOf(BS2E.state, AG_2E, SID_2E))
check('S2f', '`turnOf` 的**两个来源**都在用（主源 pre-step / 兜底 `agent.phase.turn`）',
  I.turnOf(BS2E.state, AG_2E, SID_2E) === 2 && I.turnOf(mod.createState(), AG_2E, SID_2E) === 1,
  'pre-step源=' + I.turnOf(BS2E.state, AG_2E, SID_2E) + ' phase兜底=' + I.turnOf(mod.createState(), AG_2E, SID_2E))

/* ── (4) 解锁必须认"解析出来的那一份"；0 字节写要拒 ── */
const P4 = mkProject('p4', { handovers: [{ name: '交接.md' }], files: ['src/a.js'] })
const H4 = path.join(P4, '交接.md')
const A4 = path.join(P4, 'src', 'a.js')
const SID4 = 'session-4'
const AG4 = fakeAgent(SID4, P4, { turn: 1 })
const B4 = boot()
fireResult(B4.h, readExec(H4, AG4), OK_RESULT)
fireResult(B4.h, writeExec(A4, AG4), OK_RESULT)
fireTurnStopping(B4.h, { turn: 1, agent: AG4 })                 // 欠账建立
// S4（顺带）：欠账在时 `present`（声明交付）必须被拦
const d4p = await B4.wf(execOf('present', { files: [{ path: A4, description: 'x' }] }, AG4))
check('S4a', '欠账在时 `present`（声明交付）被拦 —— "不许当完成"必须覆盖"声明交付"',
  d4p.kind === 'deny', 'kind=' + d4p.kind)
const P_S4N = mkProject('p_s4n', { handovers: [{ name: '交接.md' }], files: ['src/a.js'] })
const B4N = boot()
check('S4b', '**负控**：**没有**欠账时 `present` 放行（它不写盘 ⇒ 不该被读闸拦）',
  (await B4N.wf(execOf('present', { files: [{ path: path.join(P_S4N, 'src', 'a.js') }] }, fakeAgent('s4n', P_S4N, { turn: 1 })))).kind === 'allow')
// (4a) 写**无关**的交接件 ⇒ 不清欠账
fireResult(B4.h, writeExec(path.join(P4, '交接-scratch.md'), AG4), OK_RESULT)
check('(4)a', '写无关的 `交接-scratch.md` **不清**欠账（解锁只认解析出来的那一份）',
  B4.state.pending.has(I.pathKey(P4))
  && (await B4.wf(writeExec(A4, AG4))).kind === 'deny')
// (4b) 0 字节写 ⇒ **被拒**
const d4b = await B4.wf(execOf('write', { file_path: H4, content: '' }, AG4))
check('(4)b', '★ **0 字节写交接被拒**（理由说清"0 字节不是补救"）',
  d4b.kind === 'deny' && String(d4b.reason).includes('0 字节'), 'kind=' + d4b.kind)
const d4b2 = await B4.wf(execOf('write', { file_path: H4, content: '   \n  ' }, AG4))
check('(4)b2', '纯空白也算 0 字节（不许拿空格绕过）', d4b2.kind === 'deny', 'kind=' + d4b2.kind)
// (4c) 正控：写**那一份**且有内容 ⇒ 清欠账
fireResult(B4.h, execOf('write', { file_path: H4, content: '# 交接\n做了什么\n' }, AG4), OK_RESULT)
check('(4)c', '**正控**：写**解析出来的那一份**交接（有内容）⇒ 欠账清、改盘放行',
  !B4.state.pending.has(I.pathKey(P4))
  && (await B4.wf(writeExec(A4, AG4))).kind === 'allow')

/* ── (5) 未读交接 ⇒ **整个 shell 类**都拒（那条 `node -e fs.writeFileSync` 必须被拦） ── */
const P5 = mkProject('p5', { handovers: [{ name: '交接.md' }], files: ['src/a.js'] })
const H5 = path.join(P5, '交接.md')
const SID5 = 'session-5'
const AG5 = fakeAgent(SID5, P5, { turn: 1 })
const B5 = boot()
const EVIL = 'pwsh -Command "node -e \\"require(\'fs\').writeFileSync(\'D:/x/y.txt\',\'hi\')\\""'
check('(5)a', '**先证明夹具成立**：这条命令**不命中** `WRITE_HINTS`（旧稿正是因此既不触发读闸也不触发写闸）',
  !I.WRITE_HINTS.test(EVIL), 'hint=' + I.WRITE_HINTS.test(EVIL))
const d5 = await B5.wf(shellExec(EVIL, AG5))
check('(5)b', '★★ 未读交接时那条 pwsh **被拦**（S5 的修法：整个 shell 类，不赌关键词）',
  d5.kind === 'deny', 'kind=' + d5.kind)
check('(5)c', '拒的理由说清"为什么整个类都拒"+"读交接不需要 shell"（不死锁）',
  String(d5.reason).includes('整个类') && String(d5.reason).includes('读交接**不需要** shell'))
fireResult(B5.h, readExec(H5, AG5), OK_RESULT)
check('(5)d', '**如实**：读过交接之后同一条命令**放行** —— 关键词启发式仍然认不出它（这是已知洞，不装）',
  (await B5.wf(shellExec(EVIL, AG5))).kind === 'allow')

/* ── (6) 口径改事实：日志落点 / steer **每次现读**环境变量 ── */
const P6 = mkProject('p6', { handovers: [{ name: '交接.md' }] })
const st6 = mod.createState()
const lp6 = I.resolveLogPath(st6, P6, {}, {})
check('(6)a', '不给 `logPath` 时落点是 `<root>\\.warden\\HANDOVER-GATE.jsonl`（**事实口径**：插件**会写盘**）',
  I.pathKey(lp6) === I.pathKey(path.join(P6, '.warden', 'HANDOVER-GATE.jsonl')), 'logPath=' + lp6)
const P6B = path.join(BASE, 'p6_novarden')
fs.mkdirSync(P6B, { recursive: true })
const lp6b = I.resolveLogPath(mod.createState(), P6B, {}, {})
check('(6)b', '`.warden` 不存在 ⇒ 退回 `%TEMP%`，而且**绝不 mkdir**（本地没有 `.warden`）',
  I.pathKey(lp6b) === I.pathKey(path.join(os.tmpdir(), 'handover-gate.jsonl'))
  && !fs.existsSync(path.join(P6B, '.warden')), 'logPath=' + lp6b)
const P6S = mkProject('p6s', { handovers: [{ name: '交接.md' }], files: ['src/a.js'] })
const H6S = path.join(P6S, '交接.md')
const SID6 = 'session-6-steer'
const AG6 = fakeAgent(SID6, P6S, { turn: 1 })
const B6 = boot()                                   // 不显式传 steer ⇒ 走**现读环境变量**那条路
fireResult(B6.h, readExec(H6S, AG6), OK_RESULT)
fireResult(B6.h, writeExec(path.join(P6S, 'src', 'a.js'), AG6), OK_RESULT)
process.env[ENV_STEER] = 'off'                      // ★ **install 之后**才关
fireTurnStopping(B6.h, { turn: 1, agent: AG6 })
const row6off = B6.state.turns[B6.state.turns.length - 1]
check('(6)c', '★ `WARDEN_HANDOVER_STEER=off` 在 **install 之后**改也立刻生效（旧稿 install 时读 ⇒ 要重启 DSH）',
  !!row6off && row6off.ev === 'dirty' && row6off.steered === false && row6off.why === 'steer-off'
  && AG6.steers.length === 0,
  JSON.stringify(row6off && { steered: row6off.steered, why: row6off.why }) + ' steers=' + AG6.steers.length)
process.env[ENV_STEER] = 'on'                       // 现读 ⇒ 不用重装就恢复
fireResult(B6.h, writeExec(path.join(P6S, 'src', 'a.js'), AG6), OK_RESULT)
fireTurnStopping(B6.h, { turn: 1, agent: AG6 })
const row6on = B6.state.turns[B6.state.turns.length - 1]
check('(6)d', '把环境变量改回 `on` ⇒ **同一个实例**下一次收尾就 steer（热开关，不是重启开关）',
  !!row6on && row6on.steered === true && AG6.steers.length === 1,
  JSON.stringify(row6on && { steered: row6on.steered, why: row6on.why }) + ' steers=' + AG6.steers.length)
// ★★ **公开版的修法**：`DESIGN_PATH` **运行期派生**（`__dirname` 同级），
//   不再写作者机的 `'D:\\<用户>\\<工作区>\\task-warden\\plugin\\handover-gate.DESIGN.md'`
//   （脱敏后是 `<WORKSPACE>\task-warden\plugin\...` ⇒ `:836` 那句无保护的
//    `readFileSync` **又是一次 ENOENT 抛栈**，旧稿连这里都到不了就死在 `:490` 了）。
//   ⚠ 读不到 ⇒ **SKIP 并写明"因为找不到 X"**，绝不静默当成通过（A6）。
//     `handover-gate.DESIGN.md` **是**随包发布的（在 `03-host-plugin/` 里），
//     但万一某个发行形态只发 `.js` 不发 `.md`，这里也不该崩。
const DESIGN_PATH = path.join(__dirname, 'handover-gate.DESIGN.md')
const DESIGN_READ = (function () {
  try { return { ok: true, text: fs.readFileSync(DESIGN_PATH, 'utf8'), why: null } }
  catch (e) { return { ok: false, text: null, why: '读 ' + DESIGN_PATH + ' 失败：' + (e && e.code ? e.code : String(e)) } }
})()
if (!DESIGN_READ.ok) {
  skip('(6)e', 'DESIGN 口径已改成事实：token 上限 / 日志落点 / 绝不 mkdir / 每次现读 四处都在',
    '**核不了**：' + DESIGN_READ.why + '（这不是"核过了"）')
} else {
  const designText = DESIGN_READ.text
  check('(6)e', 'DESIGN 口径已改成事实：token 上限 / 日志落点 / 绝不 mkdir / 每次现读 四处都在',
    designText.includes('≤488 token') && designText.includes('HANDOVER-GATE.jsonl')
    && designText.includes('绝不 mkdir') && designText.includes('每次现读'))
}

/* ── (6)f/(6)g ★★ 会话格式 v4：steer 消息的 `source.kind` 必须是**产出者自有**的 ──
 *   为什么钉在这里：旧稿 `{kind:'plugin', plugin:'handover-gate'}` 在 **v4 会话**上会被
 *   `SessionFormatError` 拒收 —— 而且是在**写盘那一步**（`agent.steer()` 落进
 *   `agent/inbox/spliced`，v4 的 `assertV4SourceRowAdmission()` 明确校验这一族的
 *   `inserted[].source`）⇒ **整条消息一个字都不落盘、整个回合以 error 收尾**。
 *   判据逐字取自装机包（`resources\app.asar` → `lib/types/message-sources.js`）：
 *     `if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string"
 *         || value["kind"].length === 0 || value["kind"] === "plugin") throw …`
 *   v3→v4 迁移对**第三方插件**的改写 = `producerKind()` 的兜底 `plugin:${plugin}`，
 *   且 `rewritePluginSource` 在只有 2 个键时**只留 `kind`**、把 `plugin` 字段丢掉。
 */
function v4SourceKindOk(source) {
  const value = source
  if (!(value && typeof value === 'object' && !Array.isArray(value))) return false
  if (typeof value.kind !== 'string' || value.kind.length === 0 || value.kind === 'plugin') return false
  return true
}
const steerSrc = AG6.steers[0] && AG6.steers[0].source
check('(6)f', '★★ v4：steer 的 `source.kind` = `plugin:handover-gate`（非空、**不是** `"plugin"`）',
  v4SourceKindOk(steerSrc) && steerSrc.kind === 'plugin:handover-gate',
  'source=' + JSON.stringify(steerSrc) + ' v4SourceKindOk=' + v4SourceKindOk(steerSrc))
check('(6)g', 'v4：不再留 `plugin` 身份字段（迁移产物只留 `kind`）',
  !!steerSrc && !Object.prototype.hasOwnProperty.call(steerSrc, 'plugin'),
  'keys=' + JSON.stringify(steerSrc && Object.keys(steerSrc)))
/* ★★ 负控（这一条才证明上面两条**不是恒真**）：同一条判据必须**拒掉**旧写法。 */
const NC_SRC = [
  { name: '旧稿 {kind:plugin, plugin:handover-gate}', v: { kind: 'plugin', plugin: 'handover-gate' }, want: false },
  { name: '空串 kind', v: { kind: '' }, want: false },
  { name: 'kind 不是字符串', v: { kind: 7 }, want: false },
  { name: 'source 不是对象', v: 'plugin', want: false },
  { name: 'source 缺失', v: undefined, want: false },
  { name: '正控：迁移产物', v: { kind: 'plugin:handover-gate' }, want: true },
]
const ncBad = NC_SRC.filter((c) => v4SourceKindOk(c.v) !== c.want)
check('(6)h', '★ 负控：v4 判据**拒掉**旧写法（5 条反例）+ 收下迁移产物（1 条正控）',
  ncBad.length === 0,
  ncBad.length ? ('判据不成立：' + JSON.stringify(ncBad.map((c) => c.name))) : ('6/6 符合，含 ' + NC_SRC.length + ' 条'))

/* ── (7) S10：名字里不补零的日期也要认（否则静默退回 mtime） ── */
const P10 = mkProject('p10', {
  handovers: [
    { name: '交接-2026-9-24.md', mtime: '2020-01-01T00:00:00Z' },
    { name: '交接-2026-09-01.md', mtime: '2026-09-24T10:00:00Z' },
  ],
})
const r10 = I.resolveHandover(P10, {})
const mtime10 = I.listHandovers(P10, {}).slice().sort((a, b) => b.mtime - a.mtime)[0].name
check('S10a', '`交接-2026-9-24.md`（不补零）**被认成日期**（旧稿退回 mtime ⇒ 会挑错人）',
  r10.ok && r10.picked === '交接-2026-9-24.md', 'picked=' + r10.picked)
check('S10b', '**负控**：纯按 mtime 会挑 `交接-2026-09-01.md` ⇒ 说明日期识别真的在起作用',
  mtime10 !== '交接-2026-9-24.md', '纯 mtime 会选 ' + mtime10)
check('S10c', '非法月/日（`交接-2026-99-99.md`）**不算**日期；合法的不补零写成补零键',
  I.dateOfHandoverName('交接-2026-99-99.md') === '' && I.dateOfHandoverName('交接-2026-9-24.md') === '20260924',
  'ok=' + I.dateOfHandoverName('交接-2026-9-24.md') + ' bad=' + JSON.stringify(I.dateOfHandoverName('交接-2026-99-99.md')))

/* ── S5（顺带）：`result===undefined` 不当成功；`exec.agent` 缺席不再共用 `anonymous` 桶 ── */
const P_S5 = mkProject('p_s5', { handovers: [{ name: '交接.md' }], files: ['src/a.js'] })
const H_S5 = path.join(P_S5, '交接.md')
const A_S5 = path.join(P_S5, 'src', 'a.js')
const SID_5 = 'session-s5'
const AG_5 = fakeAgent(SID_5, P_S5, { turn: 1 })
const B5S = boot()
fireResult(B5S.h, readExec(H_S5, AG_5), undefined)          // 形状不认识
check('S5a', '★ `result===undefined` **不算**成功（旧稿 `!(result && result.isError===true)` 会当成功）',
  !I.resultIsOk(undefined) && !I.resultIsOk(null) && I.resultIsOk({ isError: false })
  && (await B5S.wf(writeExec(A_S5, AG_5))).kind === 'deny',
  'resultIsOk(undefined)=' + I.resultIsOk(undefined))
check('S5b', '并记了一行失败 `result-shape-unknown`（不许静默）',
  B5S.state.failures.some((f) => f.ev === 'result-shape-unknown'))
const B5T = boot()
fireResult(B5T.h, readExec(H_S5, undefined), OK_RESULT)     // **无 agent** 的 read
check('S5c', '★ 无 agent 的 read **不记"已读"**，并记一行失败 `agent-missing`',
  B5T.state.read.size === 0 && B5T.state.failures.some((f) => f.ev === 'agent-missing'),
  'read.size=' + B5T.state.read.size)
const d5t = await B5T.wf(execOf('write', { file_path: A_S5 }, undefined))
check('S5d', '**负控**：无 agent 的写仍然被读闸拒（旧稿：一次无 agent 的 read 会解锁所有无 agent 调用）',
  d5t.kind === 'deny' && String(d5t.reason).includes('读不到会话身份'), 'kind=' + d5t.kind)

/* ==========================================================================
 * 原样输出
 * ========================================================================== */

console.log('')
console.log('==================== R43 handover-gate 自检 ====================')
for (const r of rows) console.log(r)
console.log('----------------------------------------------------------------')
console.log(`夹具根（%TEMP% 下，跑完自动删）：${BASE}`)
console.log(`PASS ${passes} / FAIL ${fails} / SKIP ${skips} / 共 ${passes + fails + skips}`)
if (skips) {
  console.log(`⚠ 有 ${skips} 条 **SKIP** —— 那是"**核不了**"，**不是**"核过了"：`)
  for (const r of rows) if (r.startsWith('SKIP')) console.log('  ' + r)
  console.log('  （SKIP 的前置输入不在本包/本机里；它**不进 exit code**，但也**绝不算通过**。）')
}
console.log('')
console.log('---- 性能（每次工具调用多花多少） ----')
console.log(`  本机基准：1 次 fs.existsSync = ${baseExistsUs.toFixed(1)} µs`)
for (const p of perf) console.log(`  ${p.label}：${p.us.toFixed(3)} µs/次（n=${p.n}，≈ ${asExists(p.us)}）`)
console.log('')
console.log('---- 计数（原始读数：拦了几次 / 放了几次） ----')
console.log('  读闸实例 B1：' + JSON.stringify(B1.state.stats))
console.log('  B1 的 deny 记录：' + JSON.stringify(B1.state.denies.map((d) => d.gate + '/' + d.tool)))
console.log('  写闸实例 B2：' + JSON.stringify(B2.state.stats))
console.log('  B2 的 deny 记录：' + JSON.stringify(B2.state.denies.map((d) => d.gate + '/' + d.tool)))
console.log('  B2 的回合记录：' + JSON.stringify(B2.state.turns.map((t) => t.ev + '(steered=' + t.steered + ',why=' + t.why + ')')))
console.log('  读闸实例 B1 的已读集合：' + JSON.stringify(Array.from(B1.state.read.entries()).map(([k, v]) => k + ' -> ' + Array.from(v).length + ' 条')))
console.log('')
console.log('---- 对 ctx 的每一次调用（证明不进上下文） ----')
console.log('  ' + JSON.stringify(apis))
console.log('')
console.log('---- 端到端：第一次 write 被 deny 的 reason 全文 ----')
console.log('<<<<<<<<<<<<<<<<<<<< reason begin >>>>>>>>>>>>>>>>>>>>')
console.log(String(d1.reason))
console.log('<<<<<<<<<<<<<<<<<<<<< reason end >>>>>>>>>>>>>>>>>>>>>')
console.log('')
console.log('---- 端到端：materialize 出来的模型可见错误（前 200 字） ----')
console.log('  ' + String(e2eDeny.content[0].text).slice(0, 200).replace(/\n/g, '\n  '))
console.log('')
console.log('---- 写闸：steer 原文（阻止收尾的代码证据） ----')
console.log('<<<<<<<<<<<<<<<<<<<< steer begin >>>>>>>>>>>>>>>>>>>>')
console.log(String(steerText))
console.log('<<<<<<<<<<<<<<<<<<<<< steer end >>>>>>>>>>>>>>>>>>>>>')
console.log('')
console.log('---- ★★ 权威源比对：三条硬规矩**逐条**（码点逐字，证据） ----')
if (!AUTH_READ.ok) {
  // ⚠ 这一段**不是**"证据"，是**如实报告"没拿到证据"**。不许印成"逐字 === true"那种样子。
  console.log('  权威源：**没找到**（这一段核不了，上面 ㉓ 一组已报 SKIP）')
  console.log('  为什么：' + AUTH_READ.why)
  console.log('  本文件所在目录：' + __dirname)
  console.log('  解析方式：① 环境变量 TASK_WARDEN_ROOT ② 从本文件所在目录往上 6 层找装着 `派单模板.md` 的那层')
  console.log('  ⚠ `派单模板.md` **不在公开包里** —— 公开用户看不到下面这些逐字比对，那是**正常的**，')
  console.log('     但**不等于**"三条硬规矩没问题"：**这一组根本没核**。要核，请设 TASK_WARDEN_ROOT。')
} else {
console.log('  权威源：' + AUTH_SOURCE)
console.log('  取的行（1-based）：' + JSON.stringify(AUTH_RULE_LINES) + '  ← 第 1 条 = **两行**（L13 错写法 / L14 正写法）；第 2 条 = L18；第 3 条 = L22')
for (let i = 0; i < AUTH_RULE_LINES.length; i++) {
  const n = AUTH_RULE_LINES[i]
  console.log('  --- #' + (i + 1) + '  L' + n + ' ---')
  console.log('    L' + n + ' 原文        ：' + JSON.stringify(AUTH_LINES[n - 1]))
  console.log('    机器抽取后       ：' + JSON.stringify(AUTH_RULES[i]))
  console.log('    抽取结果码点     ：' + cps(AUTH_RULES[i]))
  console.log('    HARD_RULES[' + i + '] 码点：' + cps(I.HARD_RULES[i]))
  console.log('    逐字 ===         ：' + (I.HARD_RULES[i] === AUTH_RULES[i]))
  console.log('    U+0022 / U+201C / U+201D 次数（抽取）：'
    + countOf(AUTH_RULES[i], '\u0022') + ' / ' + countOf(AUTH_RULES[i], '\u201C') + ' / ' + countOf(AUTH_RULES[i], '\u201D')
    + '  （插件）：' + countOf(I.HARD_RULES[i], '\u0022') + ' / ' + countOf(I.HARD_RULES[i], '\u201C') + ' / ' + countOf(I.HARD_RULES[i], '\u201D'))
  console.log('    U+3000 次数（抽取 / 插件）：' + countOf(AUTH_RULES[i], '\u3000') + ' / ' + countOf(I.HARD_RULES[i], '\u3000'))
}
console.log('  权威源全文 U+3000 次数（**必须是 0**，旧稿那句"权威源里是全角空格"是假的）：' + countOf(AUTH_TEXT, '\u3000'))
console.log('  旧稿"拼出来的一行"在插件里还有没有：' + JSON.stringify(I.HARD_RULES).includes('只改你点名的文件\u3000'))
console.log('  为什么不取 L53：L53 原文  ：' + JSON.stringify(authLine53))
console.log('                  L53 抽取  ：' + JSON.stringify(AUTH_RULE2_ALT) + '  ← 与 L18 **措辞不同**（少一个「来」）')
console.log('  权威源自己有没有弯引号版本：' + AUTH_TEXT.includes('\u201C加提示词\u201D'))
console.log('  ⚠ 同一个东西现在有几份：权威源=派单模板.md（**唯一权威**）；插件 handover-gate.js（**机器核对**）；'
  + 'preset-roles/team-guard.mjs:701-709（**改写版，本单不许碰，未核对**）—— 见 DESIGN §5.1')
}
console.log('')
console.log('---- ★ R43 返工：S1/S2 的欠账与分桶（原始读数） ----')
console.log('  S1 欠账键（应为**工程根**，不是子会话 sid）：' + JSON.stringify(S1_PENDING_KEYS) + '（S1d 之后已清）')
console.log('  S2 回合行（B 不许是 clean）      ：' + JSON.stringify(BS2.state.turns.map((t) => t.ev + '@turn' + t.turn + '(dirty=' + t.dirty + ',why=' + t.why + ')')))
console.log('  S2c 回合行（B 什么都没改）        ：' + JSON.stringify(BS2C.state.turns.map((t) => t.ev + '@turn' + t.turn + '(dirty=' + t.dirty + ')')))
console.log('  (6) steer 热开关两行             ：' + JSON.stringify([row6off, row6on].map((t) => t && (t.ev + '(steered=' + t.steered + ',why=' + t.why + ')'))))
console.log('  (6)a logPath（事实口径）         ：' + lp6)
console.log('  (6)b `.warden` 不存在时的退路     ：' + lp6b)
console.log('')
console.log('---- 失败行（"不许静默失效"的证据） ----')
const allFailures = []
for (const s of [B1, B10, B11, B12, B13, B14, B15, B16, B2, B20, B21, B22, B3, BS1, BS2, BS2C, BS2E, B4, B5, B6, B5S, B5T]) {
  for (const f of s.state.failures) allFailures.push(f.ev + '@' + (f.root || f.base || ''))
}
const uniq = Array.from(new Set(allFailures))
console.log('  ' + (uniq.length ? uniq.join('\n  ') : '(本套自检里没有失败行)'))
console.log('')
console.log(fails === 0 ? '全部通过（exit 0）' : `有 ${fails} 条红（exit 1）`)
console.log('================================================================')

process.exit(fails === 0 ? 0 : 1)
