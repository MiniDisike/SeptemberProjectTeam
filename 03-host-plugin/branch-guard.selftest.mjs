#!/usr/bin/env node
'use strict'
/*
 * branch-guard.selftest.mjs —— R44 硬闸的自检套件。
 *
 * 跑法：`node branch-guard.selftest.mjs`
 * 结果：**exit code 报结果**（0 = 全过；1 = 有 FAIL）。逐条打 PASS/FAIL。
 *
 * 规矩（照任务书）：
 *   · 夹具一律造在 `%TEMP%` 下，**不碰真工程、不碰真账本**（作者机上的 `<workspace>\.warden`、
 *     `<workspace>\task-warden\.warden` —— 就是那两个真账本）—— 全文件只读、从不写那两个目录；
 *     ⚠ 这里**故意不写作者机的真实绝对路径**：脱敏会把 `D:\<用户>\<工作区>` 换成 `<WORKSPACE>`，
 *       而那个占位符**看着就像一条真路径**（公开用户会当成"我这儿应该有这个目录"）。
 *       所以从源头就写成 `<workspace>` 这种**一眼就知道是占位符**的形状。
 *   · **正控 + 负控成对**：每条"要拦"的旁边都有一条"不许拦"；
 *   · 测的是**判据与形状**，不是"我说它拦了"。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BG = require('./branch-guard.js')

/**
 * ★ **权威源**（㉔㉕ 用）：期望值**从盘上读**，**不许在自检里另抄一遍**。
 *   为什么：R43 的审查实测 —— 实现版把「不许用"加提示词"…」的引号抄成了弯引号
 *   （U+201C/U+201D），而**自检又把那个错的字符钉成期望值** ⇒ 58/58 全绿里含一条假绿。
 *   "同一作者在同一处误读、再抄一遍"这件事只能靠**读权威源**破。
 *   ⚠ 读不到 ⇒ 下面那几条断言**一律 FAIL** —— 不许把"核不了"当"核过了"（A6）。
 *
 *   ★ **公开版（脱敏后）改成 SKIP**：`派单模板.md` **不在公开包里**（见 `DISPATCH_TPL` 上面那段），
 *     所以公开环境下这几条**必然核不了**。旧的"一律 FAIL"会让公开用户看到 3 条假红
 *     （他什么都没改，却像插件坏了）；而"读不到就算过"是 A6 的病。
 *     ⇒ 第三档 **SKIP**：逐条印出"**核不了**，因为找不到 X"，**不进 exit code**，也**绝不算通过**。
 *     ⚠ 注意 `WARDEN_MJS`（上面那条）**不**适用这套：它由 `DSH_HOME`/`homedir` 派生，
 *       装了 task-warden 就一定有；它读不到**仍然是 FAIL**（⑲ 那条钉的就是"不许把核不了当核过了"）。
 */
const WARDEN_MJS = [
  process.env.WARDEN_MJS,
  path.join(os.homedir(), '.dsh', 'skills', 'task-warden', 'warden.mjs'),
].filter(Boolean).find((p) => { try { return fs.existsSync(p) } catch (e) { return false } }) || null
const WARDEN_SRC = WARDEN_MJS ? fs.readFileSync(WARDEN_MJS, 'utf8') : ''

/**
 * `派单模板.md` —— 「三条硬规矩」的**唯一权威源**（在工程根，不在自检里重抄）。
 *
 * ★★ **公开版的修法（R43 公开包事故）**：
 *
 *   【旧稿】`path.join(__dirname, '..', '派单模板.md')`
 *     ⇒ `__dirname` 是 `<包根>\03-host-plugin\`（公开包里的目录名），`..` = `<包根>`
 *     ⇒ 实际去读 `<包根>\派单模板.md` —— 而**这个文件不在公开包里**
 *       （`publish/make-public.mjs` 只发 `01-skill` / `02-preset-roles` / `03-host-plugin` 三段，
 *        `派单模板.md` 在仓库根，既不属三段、也不在 `ADD` 清单里）。
 *
 *   【它的 `..` 在新布局下指向哪】——**分两种情况，都对不上**：
 *     · 公开包（`<包根>/03-host-plugin/`）：`..` = `<包根>` ⇒ 要 `<包根>\派单模板.md`，**没有**；
 *     · **平铺进包的 plugin 目录**（任务书问的这条：自检与 `handover-gate.js` 等**平铺**在同一层，
 *       `__dirname` = 那一层本身）：`..` = **那一层的父目录** ⇒ 要 `<父目录>\派单模板.md`，**更没有**。
 *     ⇒ **结论：`..` 这个相对写法在新布局下不成立**，它赌的是"自检装在 `<仓库根>\plugin\` 里"，
 *       而公开包里目录名是 `03-host-plugin`、`派单模板.md` 又不发 ⇒ 无论如何都读不到。
 *
 *   【现在】不再赌相对位置，改成**两级显式解析**（与 `plugin-io.js` 的 `resolveWardenMjs` 同一套）：
 *     ① `TASK_WARDEN_ROOT` 环境变量 —— 显式指定（测试 / 非标准安装位置）
 *     ② 从 `__dirname` **往上 6 层**找第一个真的装着 `派单模板.md` 的目录
 *        （这样无论自检装在 `<仓库根>\plugin\` 还是 `<包根>\03-host-plugin\` 都能找到；
 *         公开包里两层都没有 ⇒ 返回 `null`）
 *   ⇒ `DISPATCH_TPL = null`，**不是**随便拼一个路径去撞（旧稿那正是"把占位符当路径"的同一类错）。
 *
 *   【读不到怎么办】——见下面 ㉕ 那一组：**报有理由的 SKIP**，不崩、不静默通过。
 */
const DISPATCH_TPL = (function () {
  const up = []
  if (process.env.TASK_WARDEN_ROOT) up.push(String(process.env.TASK_WARDEN_ROOT))
  let d = __dirname
  for (let i = 0; i < 6; i++) {
    up.push(d)
    const parent = path.dirname(d)
    if (parent === d) break
    d = parent
  }
  for (const c of up) {
    try { if (fs.existsSync(path.join(c, '派单模板.md'))) return path.join(c, '派单模板.md') } catch (e) { /* 换下一个 */ }
  }
  return null
})()
/**
 * ★ 读权威源：**返回"读没读成 + 为什么"**，不吞错。
 *   旧稿是 `catch (e) { return '' }` —— 读不到与"文件是空的"**分不开**。
 *   现在分开：`ok === false` 时 `why` 说清是哪一步没成。
 *   ⚠ **不许**把 `ok === false` 当成"文件内容为空 ⇒ 断言按设计 FAIL"来糊 —— 那是**假红**；
 *     也不许当成通过 —— 那是 A6。⇒ 单独走 SKIP，并把原因印出来。
 */
const TPL_READ = (function () {
  if (!DISPATCH_TPL) {
    return { ok: false, text: '', why: '本机（或本包）里找不到 `派单模板.md` —— 从 `' + __dirname
      + '` 往上 6 层都探过了；也可用 TASK_WARDEN_ROOT 显式指定' }
  }
  try { return { ok: true, text: fs.readFileSync(DISPATCH_TPL, 'utf8'), why: null } }
  catch (e) { return { ok: false, text: '', why: '读 ' + DISPATCH_TPL + ' 失败：' + (e && e.code ? e.code : String(e)) } }
})()
const TPL_SRC = TPL_READ.text

/**
 * ⚠ 旧稿对这两个文件的三处 `readFileSync` **都没有 try/catch**
 *   （与 `handover-gate.selftest.mjs:490/:836` 同一类病：读不到 ⇒ ENOENT 抛栈、连汇总都印不出来。
 *    实测：把 `branch-guard.DESIGN.md` 删掉再跑，旧稿崩在这一处）。
 *   ⇒ 按本单 A2 的同一条规矩办：**包上，读不到就报 SKIP/FAIL，不许崩**。
 *     · `branch-guard.js` 读不到 ⇒ **FAIL**（它是**被测对象本体**；本体不在，"这套自检跑了"就是假的）
 *     · `branch-guard.DESIGN.md` 读不到 ⇒ **SKIP**（它是**旁证文档**，不在不影响判闸门本身）
 *   ⚠ 声明位置**必须在第一次使用之前**（⑧ 那一组在 371 行附近就要用 `JS_READ`）。
 */
const JS_READ = (function () {
  const p = path.join(__dirname, 'branch-guard.js')
  try { return { ok: true, text: fs.readFileSync(p, 'utf8'), why: null } }
  catch (e) { return { ok: false, text: null, why: '读 ' + p + ' 失败：' + (e && e.code ? e.code : String(e)) } }
})()
const DESIGN2_READ = (function () {
  const p = path.join(__dirname, 'branch-guard.DESIGN.md')
  try { return { ok: true, text: fs.readFileSync(p, 'utf8'), why: null } }
  catch (e) { return { ok: false, text: null, why: '读 ' + p + ' 失败：' + (e && e.code ? e.code : String(e)) } }
})()
const jsSrc = JS_READ.ok ? JS_READ.text : null
const designSrc = DESIGN2_READ.ok ? DESIGN2_READ.text : null

const ROOT = path.join(os.tmpdir(), 'branch-guard-selftest-' + process.pid)
let pass = 0
let fail = 0
let skipN = 0
const failedNames = []
const skippedNames = []

function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; failedNames.push(name); console.log('FAIL  ' + name + (extra ? '   ← ' + extra : '')) }
}
/**
 * ★ **SKIP**：这条断言**核不了**（前置输入不在本包/本机里），**不是**"核过了"。
 *   为什么不记 FAIL：那是**假红**（公开用户没改任何东西，却看到插件像坏了）。
 *   为什么不记 PASS：那是 A6「没查到 ≠ 查了没问题」的病。
 *   ⇒ 单独一档，**逐条印出原因**，**不进 exit code**，但**在汇总里明说"这几条没核"**。
 */
function skip(name, why) {
  skipN += 1
  skippedNames.push(name)
  console.log('SKIP  ' + name + (why ? '   ← ' + why : ''))
}
function section(t) { console.log('\n─── ' + t + ' ' + '─'.repeat(Math.max(0, 68 - t.length))) }

function newState() { return { denies: new Map(), lastDenyAt: new Map(), cache: new Map() } }

function mkFixture(name, files) {
  const d = path.join(ROOT, name)
  for (const rel of Object.keys(files)) {
    const p = path.join(d, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, files[rel], 'utf8')
  }
  fs.mkdirSync(d, { recursive: true })
  return d
}

function mapMd(rows) {
  const L = [
    '【信号 · 支线守门员】 架构总图', '',
    '# 架构总图（总目标 → 支线 → 子项）', '',
    '**总目标**：夹具（不是真工程）', '**归属**：用户原话 ✅逐字', '',
    '| 支线 | 覆盖 | 进度 | 子项 | 最近动过 | 归属 |',
    '|---|---|---|---|---|---|',
  ]
  for (const r of rows) L.push(`| **${r.id} · ${r.title}** | ${r.cov || '██░░░░░░░░ 1✅ 0⚠️ 1❌'} | | | ${r.recent} | 用户原话 ✅ |`)
  return L.join('\n') + '\n'
}

function archMd(branches) {
  const L = ['# 架构（夹具）', '', '- 总目标: 夹具（不是真工程）', '- 归属: 用户原话', '']
  for (const b of branches) {
    L.push(`## ${b.id} · ${b.title}`, `- 需求: ${b.req}`, '- 子项:')
    for (const it of b.items) L.push(`  - ${it.name} [${b.req}] 关键词: ${it.kw}`)
    L.push('')
  }
  return L.join('\n')
}

function roundsJsonl(rows) {
  return rows.map((r) => JSON.stringify({
    round: r.round, requirement: r.req, status: 'in_progress',
    delivered: r.delivered || '', evidence: '', why: r.why || '', plan: '',
    session: 'fixture', at: '2026-01-01T00:00:00.000Z', values: {}, covered: [],
  })).join('\n') + '\n'
}

function countingFs(real) {
  const o = { calls: 0 }
  for (const k of ['existsSync', 'statSync', 'readFileSync', 'readdirSync']) {
    o[k] = function () { o.calls += 1; return real[k].apply(real, arguments) }
  }
  return o
}

const D = (input, deps) => BG.decide(input, Object.assign({ fs, path, env: {}, state: newState() }, deps))

// ══════════════════════════════════════════════════════════════════════════
console.log('branch-guard 自检 —— 夹具根：' + ROOT)
try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch (e) { /* 第一次没有 */ }
fs.mkdirSync(ROOT, { recursive: true })

// ── 夹具 ①：MAP.md 三支线（1 热 + 2 丢）—— 任务书点名要的那一个
/**
 * 夹具账的 `SPEC.md` —— 里面**真的有**"支线守门员"那条需求（R44）。
 * 为什么夹具要带它：`--req <R#>` 现在**不硬编**，是从**触发闸门的那本账**里查出来的；
 * 夹具不带 SPEC ⇒ 查不到 ⇒ 理由里不印 `--req`（那也是一条正控，见 ⑳）。
 */
const SPEC_GUARD = [
  '# SPEC（夹具，不是真工程）',
  '## R1 · 别的需求',
  '- 原话: 夹具',
  '',
  '## R44 · 方向员 / 支线守门员：**不许在一条支线上无限细化**（要硬闸，不是"只提醒不拦"）',
  '- 必须: ① 做成**硬闸**；④ 记账要能支撑判据 —— `ROUNDS.jsonl` 现在 **0 个 `branch` 字段**',
  '- 不要: 把"支线被丢了"做成一条 notice',
  '',
  '## R45 · 另一条无关的',
  '- 原话: 夹具',
].join('\n') + '\n'

const MAP_ROWS = [
  { id: 'C', title: '热支线（一直在细化）', recent: '第 20 轮（本轮）', cov: '██████████ 3✅ 0⚠️ 0❌' },
  { id: 'A', title: '出墨规则', recent: '第 10 轮（10 轮前）', cov: '█░░░░░░░░░ 0✅ 0⚠️ 2❌' },
  { id: 'F', title: '辅助线 / 空间指示', recent: '**从未动过**', cov: '░░░░░░░░░░ 0✅ 0⚠️ 8❌' },
]
const F_MAP = mkFixture('deny-map', {
  '.warden/MAP.md': mapMd(MAP_ROWS),
  '.warden/SPEC.md': SPEC_GUARD,
  'src/x.rs': '// fixture\n',
})

section('① 正控：MAP.md 夹具（1 条在动 + 2 条 10 轮没动）⇒ 必须 deny')
const d1 = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_MAP, 'src', 'x.rs') }, cwd: F_MAP, sessionId: 's1' })
check('① kind === deny', d1.kind === 'deny', 'kind=' + d1.kind + ' why=' + d1.why)
const numbered = d1.kind === 'deny' ? (d1.reason.match(/^\s+\d+\. [A-Z] · /gm) || []).length : 0
check('① 被丢的支线**逐条编号点名**（2 条 ⇒ 2 行，不是只说"N 条没动"）', numbered === 2, 'numbered=' + numbered)
check('① 点名 A · 出墨规则', d1.kind === 'deny' && d1.reason.includes('A · 出墨规则'))
check('① 点名 F · 辅助线 / 空间指示', d1.kind === 'deny' && d1.reason.includes('F · 辅助线 / 空间指示'))
check('① A 说清"最近一次活动是什么时候"（10 轮前）', d1.kind === 'deny' && /A · 出墨规则[^\n]*10 轮前/.test(d1.reason))
check('① F 说清"从没被碰过"', d1.kind === 'deny' && /F · 辅助线[^\n]*从没被碰过/.test(d1.reason))
check('① 给出**逐字可抄**的补救命令（`--req R44` 来自夹具账自己的 SPEC.md）',
  d1.kind === 'deny' && d1.reason.includes('warden.mjs') && d1.reason.includes('--req R44'))
check('① 理由里**不硬编 R#**：写明这个号是从这本账的 SPEC.md **查出来的**',
  d1.kind === 'deny' && d1.reason.includes('查出来的'))
check('① 如实说这是"减速带不是路障"', d1.kind === 'deny' && d1.reason.includes('减速带不是路障'))
check('① 说明账本来源可追', d1.kind === 'deny' && d1.reason.includes('账本来源：'))

// ── 夹具 ②：每条支线都近期动过
section('② 正控：每条支线都近期动过 ⇒ 不 deny')
const F_OK = mkFixture('ok-all-recent', {
  '.warden/MAP.md': mapMd([
    { id: 'C', title: '热', recent: '第 20 轮（本轮）' },
    { id: 'A', title: '也热', recent: '第 19 轮（1 轮前）' },
    { id: 'F', title: '也热', recent: '第 18 轮（2 轮前）' },
  ]),
})
const d2 = D({ toolName: 'write', toolArgs: { file_path: path.join(F_OK, 'a.rs') }, cwd: F_OK, sessionId: 's2' })
check('② kind === allow', d2.kind === 'allow', 'kind=' + d2.kind + ' why=' + d2.why)

// ── 夹具 ③：数据不足 —— 宁可放过，但**记一行失败（不静默）**
section('③ 正控：数据不足 / 推不出账本 ⇒ 不 deny，但必须留一行（不静默）')
const F_NOLEDGER = mkFixture('no-ledger', { 'src/x.rs': '// x\n' })
const d3a = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_NOLEDGER, 'src', 'x.rs') }, cwd: F_NOLEDGER, sessionId: 's3' })
check('③a 没有 .warden ⇒ allow（不误拦）', d3a.kind === 'allow', 'kind=' + d3a.kind)
check('③a **记了一行**（note 非空，不静默）', typeof d3a.note === 'string' && d3a.note.length > 0, JSON.stringify(d3a))

const F_NOMAP = mkFixture('ledger-no-map', { '.warden/SPEC.md': '## R1\n- 原话: 夹具\n', 'src/x.rs': '// x\n' })
const d3b = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_NOMAP, 'src', 'x.rs') }, cwd: F_NOMAP, sessionId: 's3' })
check('③b 有 .warden 但没 ARCH.md/MAP.md ⇒ allow', d3b.kind === 'allow', 'kind=' + d3b.kind + ' why=' + d3b.why)
check('③b **记了一行**（note 非空）', typeof d3b.note === 'string' && d3b.note.includes('no-branch-ledger'), JSON.stringify(d3b))

const d3c = D({ toolName: 'edit', toolArgs: {}, cwd: F_MAP, sessionId: 's3' })
check('③c 写工具但**没给路径** ⇒ allow（没判据就不拦）', d3c.kind === 'allow', 'kind=' + d3c.kind)

// ── ④ 负控：read/glob/grep/todo 永不被拦，而且**零 IO**
section('④ 负控：read / glob / grep / todo 永不被拦（拦它们会死锁）')
const spy = countingFs(fs)
for (const t of ['read', 'glob', 'grep', 'todo_write', 'present', 'read_image']) {
  const d = BG.decide({ toolName: t, toolArgs: { file_path: path.join(F_MAP, 'src', 'x.rs') }, cwd: F_MAP, sessionId: 's4' },
    { fs: spy, path, env: {}, state: newState() })
  check(`④ 负控 ${t} ⇒ allow`, d.kind === 'allow', 'kind=' + d.kind)
}
check('④ 负控 非写工具**零 IO**（一次 fs 都没调）', spy.calls === 0, 'calls=' + spy.calls)

// ── ⑤ 负控 R31：并行写不同文件不许误报
section('⑤ 负控 R31：多个子代理并行改不同文件 ⇒ 不误报')
const st5 = newState()
const par = []
for (let i = 0; i < 6; i += 1) {
  par.push(D({ toolName: 'write', toolArgs: { file_path: path.join(F_MAP, 'src', 'm' + i + '.rs') }, cwd: F_MAP, sessionId: 'par' },
    { state: st5, now: 1000000 + i * 1000 }))
}
const denies5 = par.filter((r) => r.kind === 'deny').length
check('⑤ 负控 6 个并行写同一会话 ⇒ 拒绝数 ≤ MAX_DENIES(' + BG.DEFAULT_CFG.MAX_DENIES + ')',
  denies5 <= BG.DEFAULT_CFG.MAX_DENIES, 'denies=' + denies5)
check('⑤ 负控 拒绝理由里**不许**出现"并发/冲突/另一个代理"这类误报措辞',
  par.filter((r) => r.kind === 'deny' && /并发|冲突|另一个代理|同时写|竞争/.test(r.reason)).length === 0)
check('⑤ 负控 并行不是判据：换一个**没失衡**的工程 ⇒ 6 个全放行', (function () {
  const st = newState()
  for (let i = 0; i < 6; i += 1) {
    const r = D({ toolName: 'write', toolArgs: { file_path: path.join(F_OK, 'm' + i + '.rs') }, cwd: F_OK, sessionId: 'par2' },
      { state: st, now: 2000000 + i * 1000 })
    if (r.kind !== 'allow') return false
  }
  return true
})())

// ── ⑤b 真形状：N 个子代理 = N 个 sessionId ⇒ 最多 2N 次减速带（S4）
section('⑤b 真形状（S4）：N 个子代理 = N 个 sessionId ⇒ 预算按会话分桶 ⇒ 最多 **2N**')
/**
 * ⚠ 上面 ⑤ 用的是**同一个 sessionId**，所以只看到 ≤2 —— 那**不是**真形状。
 *   审查实测：`state.denies` 按 `sessionId` 分桶 ⇒ 6 个并行子代理各带自己的预算
 *   ⇒ 最多 **2N = 12** 次减速带。这里把它钉住（含"依然不判冲突"的负控）。
 */
const st5b = newState()
let denies5b = 0
const reasons5b = []
for (let i = 0; i < 6; i += 1) {
  for (let k = 0; k < 3; k += 1) {
    const r = D({ toolName: 'write', toolArgs: { file_path: path.join(F_MAP, 'src', 'p' + i + '_' + k + '.rs') }, cwd: F_MAP, sessionId: 'sub' + i },
      { state: st5b, now: 3000000 + k * 120000 })
    if (r.kind === 'deny') { denies5b += 1; reasons5b.push(r.reason) }
  }
}
check('⑤b 6 个 sessionId × 3 次写 ⇒ 拒绝数 = 2N = 12（不是 ≤2）', denies5b === 12, 'denies=' + denies5b)
check('⑤b 每个会话各 2 次、第 3 次被节流（denies 按 sessionId 分桶，实测出来的）',
  denies5b === 6 * BG.DEFAULT_CFG.MAX_DENIES, 'denies=' + denies5b)
check('⑤b 负控 依然**不判冲突**：没有一条理由出现"并发/冲突/另一个代理"措辞',
  reasons5b.every((x) => !/并发|冲突|另一个代理|同时写|竞争/.test(x)))
check('⑤b 负控 12 条理由里**没有一条**把"并行"当成判据（都指向支线失衡）',
  reasons5b.every((x) => x.includes('支线守门员') && x.includes('被丢下')))

// ── ⑥ inject 为空 + 最小 ctx
section('⑥ inject 为空 ⇒ 拿不到服务时不进 waiting、不报错')
check('⑥ plugin.inject 是空数组', Array.isArray(BG.inject) && BG.inject.length === 0, JSON.stringify(BG.inject))
check('⑥ plugin.name 是 branch-guard', BG.name === 'branch-guard')
let threw6 = null
try { BG.apply({ on: function () { return function () { } } }) } catch (e) { threw6 = e }
check('⑥ 只有 on 的最小 ctx（没有 get/effect/任何服务）⇒ apply 不报错', threw6 === null, threw6 && threw6.message)

// ── ⑦ 可逆
section('⑦ 可逆：dispose 后监听器全摘掉')
const reg7 = []
const disposers7 = []
const ctx7 = {
  on: function (ev, fn) {
    const rec = { ev, fn }
    reg7.push(rec)
    return function () { const i = reg7.indexOf(rec); if (i >= 0) reg7.splice(i, 1) }
  },
  effect: function (cb) { disposers7.push(cb()) },
}
BG.apply(ctx7)
check('⑦ 挂上 1 个 tools/pre-execute 监听器', reg7.length === 1 && reg7[0].ev === 'tools/pre-execute')
check('⑦ effect 收到 1 个 disposer', disposers7.length === 1 && typeof disposers7[0] === 'function')
let nextCalled = 0
const r7 = reg7[0].fn({ name: 'read', arguments: {}, agent: { session: { id: 's7', header: { cwd: F_MAP } } } }, function () { nextCalled += 1; return 'NEXT' })
check('⑦ handler 放行时**调用 next()**', nextCalled === 1 && r7 === 'NEXT', 'r=' + String(r7))
const r7b = reg7[0].fn({ name: 'edit', arguments: { file_path: path.join(F_MAP, 'src', 'x.rs') }, agent: { session: { id: 's7b', header: { cwd: F_MAP } } } }, function () { nextCalled += 1; return 'NEXT' })
check('⑦ handler 拒绝时**返回 {kind:deny}** 而不是 next()',
  r7b && typeof r7b.then === 'function' && nextCalled === 1, 'r=' + String(r7b))
const v7b = await r7b
check('⑦ 拒绝形状 = {kind:"deny", reason:…}（waterfall 契约）', v7b && v7b.kind === 'deny' && typeof v7b.reason === 'string' && v7b.reason.length > 0)
disposers7[0]()
check('⑦ dispose 后监听器全摘掉', reg7.length === 0, 'reg=' + reg7.length)
check('⑦ 没有 effect 的 ctx（只有 on 的返回值）也不报错 —— 见用例 ⑥', true)

// ── ⑧ 不进上下文
section('⑧ 不进上下文：列出对 ctx 的每一次访问')
const accessed = []
const ctx8 = new Proxy({}, {
  get: function (t, prop) {
    const k = String(prop)
    accessed.push(k)
    if (k === 'on') return function () { return function () { } }
    if (k === 'effect') return function (cb) { cb() }
    return undefined
  },
})
BG.apply(ctx8)
const uniq = [...new Set(accessed)].sort()
check('⑧ 对 ctx 的访问**只有** on / effect', uniq.every((k) => k === 'on' || k === 'effect') && uniq.indexOf('on') >= 0, JSON.stringify(uniq))
for (const bad of ['systemPrompt', 'context', 'messages', 'steer', 'prompt', 'emit', 'broadcast', 'createUserMessage', 'session', 'agent', 'shell', 'logger', 'get']) {
  check(`⑧ 没碰 ctx.${bad}`, accessed.indexOf(bad) < 0)
}
// ⚠ 这里旧稿也无保护地 `readFileSync`（同上，读不到就抛栈崩掉）。
//   被测本体不在 ⇒ **FAIL**（不许当"核不了"放过，理由同 ㉔ 那一处）。
if (!JS_READ.ok) {
  for (const bad of ['systemPrompt', 'agent.steer', 'createUserMessage', 'ctx.context']) {
    check(`⑧ 源码（去注释后）里没有 ${bad}`, false, '**核不了**：' + JS_READ.why)
  }
} else {
  const srcLines = JS_READ.text.split(/\r?\n/)
  const codeOnly = srcLines.filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
  for (const bad of ['systemPrompt', 'agent.steer', 'createUserMessage', 'ctx.context']) {
    check(`⑧ 源码（去注释后）里没有 ${bad}`, codeOnly.indexOf(bad) < 0)
  }
}

// ── ⑨⑩ ARCH.md + ROUNDS.jsonl 活判据
section('⑨⑩ 活判据（ARCH.md + ROUNDS.jsonl）：窗口窄 ⇒ deny；窗口不窄 ⇒ allow')
const ARCH = archMd([
  { id: 'A', title: '出墨规则', req: 'R1', items: [{ name: '前端出墨', kw: '出墨' }] },
  { id: 'B', title: '辅助线', req: 'R2', items: [{ name: '辅助线提示', kw: '辅助线' }] },
  { id: 'C', title: '热支线', req: 'R3', items: [{ name: '热支线工作', kw: '热支线' }] },
  { id: 'D', title: '第四支线', req: 'R4', items: [{ name: '第四支线工作', kw: '第四支线' }] },
])
// ⑨：A 只在第 1 轮、B 只在第 2 轮、C 在第 5..10 轮；maxRound=10，窗口=5..10 ⇒ 只碰了 C
const R9 = []
R9.push({ round: 1, req: 'R1', delivered: '出墨 完成' })
R9.push({ round: 2, req: 'R2', delivered: '辅助线 完成' })
for (let i = 5; i <= 10; i += 1) R9.push({ round: i, req: 'R3', delivered: '热支线 工作 ' + i })
const F_LIVE = mkFixture('live-deny', { '.warden/ARCH.md': ARCH, '.warden/ROUNDS.jsonl': roundsJsonl(R9), 'src/x.rs': '' })
const d9 = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_LIVE, 'src', 'x.rs') }, cwd: F_LIVE, sessionId: 's9' })
check('⑨ 活判据：最近 6 轮只碰 C、A/B 已丢 ⇒ deny', d9.kind === 'deny', 'kind=' + d9.kind + ' why=' + d9.why)
check('⑨ 点名 A', d9.kind === 'deny' && /A · 出墨规则/.test(d9.reason))
check('⑨ 点名 B', d9.kind === 'deny' && /B · 辅助线/.test(d9.reason))
check('⑨ 理由里写明窗口只碰了几条 + 覆盖率', d9.kind === 'deny' && /最近 6 轮里\*\*只碰了 1 条\*\*/.test(d9.reason) && /能归属的轮次 100%/.test(d9.reason))
check('⑨ 判据数据写明是"活算"而不是 MAP 快照', d9.kind === 'deny' && d9.reason.includes('活算'))

// ⑩：让 D 也在窗口里被碰一次（第 5 轮）⇒ D 不热但被碰 ⇒ 窗口不窄 ⇒ allow
const R10 = R9.slice()
R10.push({ round: 5, req: 'R4', delivered: '第四支线 工作' })
const F_LIVE2 = mkFixture('live-narrow-no', { '.warden/ARCH.md': ARCH, '.warden/ROUNDS.jsonl': roundsJsonl(R10), 'src/x.rs': '' })
const d10 = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_LIVE2, 'src', 'x.rs') }, cwd: F_LIVE2, sessionId: 's10' })
check('⑩ 负控 窗口里还碰了别的支线（D）⇒ 不 deny（没被饿死）', d10.kind === 'allow', 'kind=' + d10.kind + ' why=' + d10.why)
check('⑩ 负控 放行的理由 = window-not-narrow', d10.why === 'window-not-narrow', 'why=' + d10.why)

// ⑨b 腿 B（集中度）：真账本的形状 —— 支线多、最近只碰一小块、过半被丢下
const ARCH_B = archMd([
  { id: 'A', title: '一', req: 'R1', items: [{ name: '一', kw: '甲' }] },
  { id: 'B', title: '二', req: 'R2', items: [{ name: '二', kw: '乙' }] },
  { id: 'C', title: '三', req: 'R3', items: [{ name: '三', kw: '丙' }] },
  { id: 'D', title: '四', req: 'R4', items: [{ name: '四', kw: '丁' }] },
  { id: 'E', title: '五', req: 'R5', items: [{ name: '五', kw: '戊' }] },
  { id: 'F', title: '六', req: 'R6', items: [{ name: '六', kw: '己' }] },
  { id: 'G', title: '七', req: 'R7', items: [{ name: '七', kw: '庚' }] },
  { id: 'H', title: '八', req: 'R8', items: [{ name: '八', kw: '辛' }] },
])
const RB = []
RB.push({ round: 1, req: 'R1', delivered: '甲' })
RB.push({ round: 2, req: 'R2', delivered: '乙' })
RB.push({ round: 3, req: 'R3', delivered: '丙' })
RB.push({ round: 4, req: 'R4', delivered: '丁' })
RB.push({ round: 5, req: 'R5', delivered: '戊' })
RB.push({ round: 7, req: 'R6', delivered: '己' })          // F：窗口内、但已 5 轮前 ⇒ 不热（让腿 A 挂）
for (let i = 8; i <= 12; i += 1) RB.push({ round: i, req: 'R7', delivered: '庚' })   // G：热
const F_LIMB = mkFixture('live-limb-b', { '.warden/ARCH.md': ARCH_B, '.warden/ROUNDS.jsonl': roundsJsonl(RB), 'src/x.rs': '' })
const d9b = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_LIMB, 'src', 'x.rs') }, cwd: F_LIMB, sessionId: 's9b' })
check('⑨b 正控 腿 B（集中度：8 条里最近 6 轮只碰 2 条、7 条被丢）⇒ deny',
  d9b.kind === 'deny' && /判据腿 = B-concentration/.test(d9b.reason), 'kind=' + d9b.kind + ' why=' + d9b.why)
check('⑨b 理由里给出全项目条数与被丢比例', d9b.kind === 'deny' && /全项目 8 条里被丢下 7 条/.test(d9b.reason))

// ⑩b 冷支线豁免：写的东西明显在动"被丢的"那条 ⇒ 放行
const d10b = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_LIVE, 'src', '辅助线.rs'), content: '辅助线提示 辅助线' }, cwd: F_LIVE, sessionId: 's10b' })
check('⑩b 负控 这一笔明显在动**被丢的**支线（关键词命中 B）⇒ 放行（那正是本闸门要的）', d10b.kind === 'allow' && d10b.why === 'cold-branch-work', 'kind=' + d10b.kind + ' why=' + d10b.why)

// ⑩c 数据不足：ROUNDS 里归属不到任何支线 ⇒ 放行 + 留一行
const F_NOROUNDS = mkFixture('live-no-rounds', { '.warden/ARCH.md': ARCH, 'src/x.rs': '' })
const d10c = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_NOROUNDS, 'src', 'x.rs') }, cwd: F_NOROUNDS, sessionId: 's10c' })
check('⑩c 负控 有 ARCH 没 ROUNDS ⇒ 放行 + 记一行（分不出热/冷就不拦，但不静默）',
  d10c.kind === 'allow' && d10c.why === 'no-rounds' && typeof d10c.note === 'string' && d10c.note.length > 0, JSON.stringify(d10c))

// ── ⑪ 负控 shell
section('⑪ 负控：shell 只读命令 / warden.mjs 命令永不被拦')
const d11a = D({ toolName: 'pwsh', toolArgs: { command: 'Get-ChildItem .' }, cwd: F_MAP, sessionId: 's11' })
check('⑪ 负控 只读 pwsh 命令 ⇒ allow', d11a.kind === 'allow' && d11a.why === 'no-write-hint', 'why=' + d11a.why)
const d11b = D({ toolName: 'pwsh', toolArgs: { command: 'node warden.mjs record --req R44 >> log.txt' }, cwd: F_MAP, sessionId: 's11' })
check('⑪ 负控 `node …warden.mjs …`（补救的路）⇒ allow，哪怕带写动作', d11b.kind === 'allow' && d11b.why === 'ledger-cmd', 'why=' + d11b.why)

// ── ⑫ 补救路：写账本文件
section('⑫ 补救的路永不拦：写 .warden/** 下的账本文件')
const d12 = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_MAP, '.warden', 'ROUNDS.jsonl') }, cwd: F_MAP, sessionId: 's12' })
check('⑫ 负控 写 .warden/ROUNDS.jsonl ⇒ allow', d12.kind === 'allow' && d12.why === 'remedy-path', 'why=' + d12.why)

// ── ⑬ 显式外部账本 + scope（**今天就能用**的那条路）
section('⑬ 显式外部账本（env）生效，且 scope 挡住跨项目误拦')
const F_OUTER = mkFixture('outer', {
  '.warden/MAP.md': mapMd([
    { id: 'C', title: '热支线', recent: '第 20 轮（本轮）' },
    { id: 'A', title: '出墨规则', recent: '第 10 轮（10 轮前）' },
    { id: 'F', title: '辅助线', recent: '**从未动过**' },
  ]),
  'projA/.warden/SPEC.md': '## R1\n- 原话: 夹具\n',
  'projA/src/x.rs': '',
  'projB/.warden/SPEC.md': '## R1\n- 原话: 夹具\n',
  'projB/src/y.rs': '',
})
const envA = { BRANCH_GUARD_LEDGER: F_OUTER, BRANCH_GUARD_SCOPE: path.join(F_OUTER, 'projA') }
const d13a = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_OUTER, 'projA', 'src', 'x.rs') }, cwd: path.join(F_OUTER, 'projA'), sessionId: 's13' }, { env: envA })
check('⑬ 正控 scope 内 ⇒ deny（外部账本被用上）', d13a.kind === 'deny', 'kind=' + d13a.kind + ' why=' + d13a.why)
check('⑬ 理由里写明账本来源 via=extra + scope', d13a.kind === 'deny' && d13a.reason.includes('via=extra') && d13a.reason.includes('scope='))
const d13b = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_OUTER, 'projB', 'src', 'y.rs') }, cwd: path.join(F_OUTER, 'projB'), sessionId: 's13' }, { env: envA })
check('⑬ 负控 scope 外（另一个工程）⇒ allow（挡住跨项目误拦）', d13b.kind === 'allow', 'kind=' + d13b.kind + ' why=' + d13b.why)
const d13c = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_OUTER, 'projA', 'src', 'x.rs') }, cwd: path.join(F_OUTER, 'projA'), sessionId: 's13d' })
check('⑬ 负控 不给 env ⇒ 祖先账本默认**不用** ⇒ allow（"两个项目读到对方守则"不许重演）',
  d13c.kind === 'allow' && (d13c.why === 'no-branch-ledger' || d13c.why === 'no-ledger'), 'kind=' + d13c.kind + ' why=' + d13c.why)
check('⑬ 负控 上面那次放行**也留了一行**，并点名"最近的账本没有支线图"',
  typeof d13c.note === 'string' && d13c.note.indexOf('no-branch-ledger@') === 0, JSON.stringify(d13c.note))
const d13d = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_OUTER, 'projA', 'src', 'x.rs') }, cwd: path.join(F_OUTER, 'projA'), sessionId: 's13e' },
  { env: { BRANCH_GUARD_LEDGER: F_OUTER, BRANCH_GUARD_SCOPE: path.join(F_OUTER, 'projA'), BRANCH_GUARD_ALLOW_ANCESTOR: '1' } })
check('⑬ 正控 显式开 ALLOW_ANCESTOR ⇒ 用祖先账本，且理由里**写明这是祖先账本**',
  d13d.kind === 'deny' && d13d.reason.includes('via=ancestor') && d13d.reason.includes('祖先账本'), 'kind=' + d13d.kind)

// ── ⑭ 减速带（如实描述）
section('⑭ 减速带：有限次数 + 冷却，且理由里明说这条出路')
const st14 = newState()
const seq = []
for (let i = 0; i < 4; i += 1) {
  seq.push(D({ toolName: 'edit', toolArgs: { file_path: path.join(F_MAP, 'src', 'x.rs') }, cwd: F_MAP, sessionId: 's14' },
    { state: st14, now: 5000000 }))
}
check('⑭ 冷却期内重复调用 ⇒ 只拦 1 次', seq.filter((r) => r.kind === 'deny').length === 1, JSON.stringify(seq.map((r) => r.why || 'deny')))
const st14b = newState()
const seqB = []
for (let i = 0; i < 5; i += 1) {
  seqB.push(D({ toolName: 'edit', toolArgs: { file_path: path.join(F_MAP, 'src', 'x.rs') }, cwd: F_MAP, sessionId: 's14b' },
    { state: st14b, now: 6000000 + i * 120000 }))
}
check('⑭ 过了冷却 ⇒ 拦到 MAX_DENIES 就停，之后一律放行',
  seqB.filter((r) => r.kind === 'deny').length === BG.DEFAULT_CFG.MAX_DENIES,
  'denies=' + seqB.filter((r) => r.kind === 'deny').length)
check('⑭ 被节流的那几次**也留了一行**（不静默）', seqB.filter((r) => r.kind === 'allow' && String(r.note || '').indexOf('throttled') === 0).length > 0)

// ── ⑮ fail-open
section('⑮ fail-open：判据自己坏了 ⇒ 放行，绝不让工具调用失败')
const boomFs = {
  existsSync: function () { throw new Error('夹具：IO 炸了') },
  statSync: function () { throw new Error('夹具：IO 炸了') },
  readFileSync: function () { throw new Error('夹具：IO 炸了') },
}
let r15 = null
try {
  r15 = BG.preToolDecision({ toolName: 'edit', toolArgs: { file_path: path.join(F_MAP, 'src', 'x.rs') }, cwd: F_MAP, sessionId: 's15' },
    { fs: boomFs, path, env: {}, state: newState() })
} catch (e) { r15 = { kind: 'THREW', e: e } }
check('⑮ IO 全炸 ⇒ preToolDecision 返回 allow（不抛）', r15 && r15.kind === 'allow', JSON.stringify(r15 && r15.kind))
// 真正的 fail-open 测法：让**判据本身**炸（deps 一取就抛），再证明是 try/catch 兜住的
const boomDeps = new Proxy({}, { get: function () { throw new Error('夹具：deps 炸了') } })
let decideThrew = false
try { BG.decide({ toolName: 'edit', toolArgs: { file_path: 'x' } }, boomDeps) } catch (e) { decideThrew = true }
check('⑮ 纯判据 decide() **会抛**（证明上面那次 allow 不是"根本没跑到"）', decideThrew)
let r15b = null
try { r15b = BG.preToolDecision({ toolName: 'edit', toolArgs: { file_path: 'x' } }, boomDeps) } catch (e) { r15b = { kind: 'THREW' } }
check('⑮ 判据炸了 ⇒ preToolDecision 兜住并 allow（fail-open 硬约束）', r15b && r15b.kind === 'allow', JSON.stringify(r15b && r15b.kind))

// ── ⑰ 「有意先放着」的出路**真的能让闸门闭嘴**（读侧已就位；写侧待下一单）
section('⑰ 出路是真的：BRANCH-PARKED.jsonl 里 park 掉的支线不再触发 deny')
const F_PARK = mkFixture('parked', {
  '.warden/MAP.md': mapMd([
    { id: 'C', title: '热支线', recent: '第 20 轮（本轮）' },
    { id: 'A', title: '出墨规则', recent: '第 10 轮（10 轮前）' },
    { id: 'F', title: '辅助线', recent: '**从未动过**' },
  ]),
  '.warden/BRANCH-PARKED.jsonl': '{"branch":"A","why":"有意先放着","by":"用户","at":"2026-01-01T00:00:00Z"}\n',
  'src/x.rs': '',
})
const d17a = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_PARK, 'src', 'x.rs') }, cwd: F_PARK, sessionId: 's17' })
check('⑰ park 掉 A 之后只剩 1 条被丢 ⇒ 不 deny（证据不够，不是"闸门坏了"）',
  d17a.kind === 'allow' && d17a.why === 'few-dropped', 'kind=' + d17a.kind + ' why=' + d17a.why)
const F_PARK2 = mkFixture('parked-all', {
  '.warden/MAP.md': mapMd([
    { id: 'C', title: '热支线', recent: '第 20 轮（本轮）' },
    { id: 'A', title: '出墨规则', recent: '第 10 轮（10 轮前）' },
    { id: 'F', title: '辅助线', recent: '**从未动过**' },
    { id: 'G', title: '另一条', recent: '第 12 轮（8 轮前）' },
  ]),
  '.warden/BRANCH-PARKED.jsonl': '{"branch":"A"}\n\n{"branch":"F"}\n# 注释行\n{"branch":"G"}\n坏行不是 JSON\n',
  'src/x.rs': '',
})
const d17b = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_PARK2, 'src', 'x.rs') }, cwd: F_PARK2, sessionId: 's17' })
check('⑰ 全部 park 掉 ⇒ 0 条被丢 ⇒ allow', d17b.kind === 'allow', 'kind=' + d17b.kind + ' why=' + d17b.why)
check('⑰ 坏行 / 注释行 / 空行不会让解析炸掉', BG.parseParked('# c\n\n坏\n{"branch":"Z"}\n').has('Z'))

// ── ⑱ 性能
section('⑱ 性能：每次工具调用多花多少')
/**
 * ⚠ **测量方法（2026-09-24 返工时改的）**：原来是**单次**测量 —— 这台机器上同时跑着
 *   别的 agent（P-M19/P-M20/P-M23… 都在跑 lab），单次读数被 GC / CPU 抢占污染过
 *   （实测同一条断言 1.147 / 1.464 / **6.535** µs 三次读数）。**阈值一个都没动**，
 *   改成 DESIGN §7 自己声明的方法：**5 次独立测量取中位**，并把 5 个读数**全部印出来**。
 */
function benchMedian(iters, fn) {
  const runs = []
  for (let r = 0; r < 5; r += 1) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i += 1) fn(i)
    const t1 = process.hrtime.bigint()
    runs.push(Number(t1 - t0) / iters / 1000)
  }
  const sorted = runs.slice().sort((a, b) => a - b)
  return { runs, median: sorted[Math.floor(sorted.length / 2)] }
}
const stP = newState()
const bNonWrite = benchMedian(20000, () => BG.decide({ toolName: 'read', toolArgs: {} }, { fs, path, env: {}, state: stP }))
const warm = 500
const bWriteWarm = benchMedian(warm, (i) => BG.decide(
  { toolName: 'edit', toolArgs: { file_path: path.join(F_MAP, 'src', 'x.rs') }, cwd: F_MAP, sessionId: 'perf' },
  { fs, path, env: {}, state: stP, now: 1e9 + i * 1e6 }))
const usNonWrite = bNonWrite.median
const usWriteWarm = bWriteWarm.median
const fmt = (a) => a.map((x) => x.toFixed(3)).join(' / ')
console.log(`  非写工具（read/glob/grep/todo…）：中位 ${usNonWrite.toFixed(3)} µs/次（0 次 fs）· 5 次 = ${fmt(bNonWrite.runs)}`)
console.log(`  写工具（缓存命中）：中位 ${usWriteWarm.toFixed(1)} µs/次（5 次 statSync + 判定）· 5 次 = ${fmt(bWriteWarm.runs)}`)
check('⑱ 非写工具（5 次取中位）< 5 µs/次', usNonWrite < 5, usNonWrite.toFixed(3))
check('⑱ 写工具（缓存命中，5 次取中位）< 3000 µs/次', usWriteWarm < 3000, usWriteWarm.toFixed(1))
check('⑱ 非写工具**每一次**读数都 < 5 µs（不只是中位 —— 抖动要看得见）',
  bNonWrite.runs.every((x) => x < 5), fmt(bNonWrite.runs))

// ── ⑲ ★ 硬自检：理由里的每一条命令，必须在本机真的存在
section('⑲ ★ 硬自检：印在 deny 理由里的每一条命令，必须在本机**真的存在**')
check('⑲ 读到了 `warden.mjs`（命令表的权威源）—— 读不到就 FAIL，不许把"核不了"当"核过了"',
  WARDEN_SRC.length > 0, 'WARDEN_MJS=' + String(WARDEN_MJS))
const KNOWN_CMDS = BG.knownWardenCommands(WARDEN_SRC)
check('⑲ 从 `warden.mjs` 的命令分派处读到 ≥20 条子命令（不是空集）', KNOWN_CMDS.size >= 20, 'n=' + KNOWN_CMDS.size)
const cmdsInReason = BG.extractWardenCommands(d1.reason)
check('⑲ 从真理由里抽出了 ≥2 条 `warden.mjs` 子命令', cmdsInReason.length >= 2, JSON.stringify(cmdsInReason))
check('⑲ 每一条都在命令表里（missing 为空）',
  BG.missingWardenCommands(d1.reason, WARDEN_SRC).length === 0, JSON.stringify(BG.missingWardenCommands(d1.reason, WARDEN_SRC)))
check('⑲ 真理由里**没有** `branch park`（那条命令在 warden.mjs 里 grep 0 处 —— 上一版的假出路）',
  !/branch\s+park/.test(d1.reason))
// ★ 负控：故意印一个不存在的命令 ⇒ 这条断言**必须红**
const doctoredReason = d1.reason + '\n  9) node warden.mjs branch park --branch A --why "有意先放着"'
const missBad = BG.missingWardenCommands(doctoredReason, WARDEN_SRC)
check('⑲ 负控 故意印 `node warden.mjs branch park …` ⇒ missing 非空且点名 `branch`',
  missBad.includes('branch'), JSON.stringify(missBad))
check('⑲ 负控 对照：把同一条命令换成一个**真的存在**的 ⇒ missing 变空（证明红的是"不存在"，不是别的）',
  BG.missingWardenCommands(d1.reason + '\n  9) node warden.mjs map', WARDEN_SRC).length === 0)
check('⑲ 负控 空输入**不许**报"全都在"（A6：输入为 0 不许报成功）',
  BG.missingWardenCommands(d1.reason, '').length > 0, JSON.stringify(BG.missingWardenCommands(d1.reason, '')))
/**
 * ★ **运行时那一道也要真跑到**（原来这一支没测，DESIGN §8 第 11 条挂着）：
 *   把 `WARDEN_MJS` 指到一个**命令表里没有 `map`** 的假源 ⇒ `decide()` 必须在理由末尾
 *   **追加**那行"自身缺陷"，而且**判定不变**（还是 deny，fail-open 约束①）。
 */
const FAKE_WARDEN = mkFixture('fake-warden-src', {
  'warden.mjs': "if (cmd === 'record') { return 0 }\nif (cmd === 'report') { return 0 }\n",
})
const dFake = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_MAP, 'src', 'x.rs') }, cwd: F_MAP, sessionId: 'sfake' },
  { env: { WARDEN_MJS: path.join(FAKE_WARDEN, 'warden.mjs') }, state: newState() })
check('⑲ 运行时 命令表里没有 `map` ⇒ 理由末尾**追加**"自身缺陷"行（点名 map）',
  dFake.kind === 'deny' && dFake.reason.includes('自身缺陷') && /找不到：map/.test(dFake.reason),
  'kind=' + dFake.kind + ' 尾部=' + JSON.stringify(dFake.reason.slice(-120)))
check('⑲ 运行时 追加缺陷行**不改判定**（fail-open：看守自己坏了不该让工具调用失败）', dFake.kind === 'deny')
check('⑲ 负控 用**真的** `warden.mjs` ⇒ 理由里**没有**"自身缺陷"那一行',
  !d1.reason.includes('自身缺陷'))
check('⑲ 负控 读不到 `warden.mjs` ⇒ **一个字都不加**（宁可不说，不许瞎说）',
  (function () {
    const d = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_MAP, 'src', 'x.rs') }, cwd: F_MAP, sessionId: 'snow' },
      { env: { WARDEN_MJS: path.join(F_MAP, 'no-such-warden.mjs') }, state: newState() })
    return d.kind === 'deny' && !d.reason.includes('自身缺陷')
  })())

// ── ⑳ ★ ① 的判据：`--req R#` 必须在**触发闸门的那本账**里真的存在且语义对得上
section('⑳ ★ ① `--req R#` 从触发闸门的账里**查**，查不到/分不清就**不印**（R# 不跨账）')
check('⑳ 正控 夹具账 SPEC 里 R44 = 支线守门员 ⇒ `findGuardReq` 返回 R44', BG.findGuardReq(SPEC_GUARD) === 'R44',
  String(BG.findGuardReq(SPEC_GUARD)))
check('⑳ 正控 理由里印的是**查出来的那个号** `--req R44`', d1.kind === 'deny' && d1.reason.includes('--req R44'))
check('⑳ 正控 理由里点名了它是从**这本账**的 SPEC.md 查出来的',
  d1.kind === 'deny' && d1.reason.includes('SPEC.md') && d1.reason.includes('查出来的'))
/**
 * ★ 负控 = **真账本的真实形态**：作者机上 `<workspace>\.warden\SPEC.md` 里那个 R44 是
 *   「纠正 R43：界面要显示…」—— **同号不同物**。夹具照抄这个形状。
 *   ⚠ 同上面那条：**不写作者机绝对路径**（脱敏后的 `<WORKSPACE>` 会被误读成真路径）。
 */
const SPEC_UI_R44 = [
  '# SPEC（夹具：真账本的形状 —— R44 是另一条需求）',
  '## R43 · 插件对用户的输出：能不说就不说',
  '- 原话: 关于插件的自言自语尽量精简',
  '## R44 · **纠正 R43**：界面要显示（不花 token 就该显示），滚动起来让他看得见在动',
  '- 原话: 如果在界面上不显示对审下token没有作用，就可以显示出来',
  '- 必须: 正常运行时也显示**一行**状态，小、细、灰',
].join('\n') + '\n'
const F_UI = mkFixture('ui-r44', {
  '.warden/MAP.md': mapMd(MAP_ROWS),
  '.warden/SPEC.md': SPEC_UI_R44,
  'src/x.rs': '',
})
const dUI = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_UI, 'src', 'x.rs') }, cwd: F_UI, sessionId: 'sui' })
check('⑳ 负控 那本账的 R44 是「界面要显示」⇒ `findGuardReq` = null（**对不上就不印**）',
  BG.findGuardReq(SPEC_UI_R44) === null, String(BG.findGuardReq(SPEC_UI_R44)))
check('⑳ 负控 闸门照样拦（失衡是真的）', dUI.kind === 'deny', 'kind=' + dUI.kind + ' why=' + dUI.why)
check('⑳ 负控 但理由里**不许**出现 `--req R44`（否则就把这一轮记到另一条需求上了）',
  dUI.kind === 'deny' && !/--req R44/.test(dUI.reason))
check('⑳ 负控 理由里**明说"不印 --req"**并指出去哪找需求号',
  dUI.kind === 'deny' && /不印/.test(dUI.reason) && /SPEC\.md/.test(dUI.reason) && /R# 不跨账/.test(dUI.reason))
check('⑳ 负控 两条都命中（分不清是哪条）⇒ 也不印',
  BG.findGuardReq(SPEC_GUARD + '\n## R50 · 支线守门员：别的支线被忽视\n- 必须: 硬闸\n') === null)
const F_NOSPEC = mkFixture('no-spec', { '.warden/MAP.md': mapMd(MAP_ROWS), 'src/x.rs': '' })
const dNoSpec = D({ toolName: 'edit', toolArgs: { file_path: path.join(F_NOSPEC, 'src', 'x.rs') }, cwd: F_NOSPEC, sessionId: 'snospec' })
check('⑳ 负控 账里**没有 SPEC.md** ⇒ 不印 `--req`（没得查就不硬编）',
  dNoSpec.kind === 'deny' && !/--req R\d/.test(dNoSpec.reason), 'kind=' + dNoSpec.kind)
check('⑳ 负控 上面那次的 `--req` 只是**占位符** `<那本账里的 R#>`，不是编出来的号',
  dNoSpec.kind === 'deny' && dNoSpec.reason.includes('--req <那本账里的 R#>'))

// ── ㉑ ★ ③ 归属口径：三个数一起印
section('㉑ ★ ③ 归属口径：并集 / 只用 [R#] / 只用关键词**三个数一起印**，且点明口径')
check('㉑ 活算理由里三个口径都印了',
  d9.kind === 'deny' && /归属口径/.test(d9.reason) && /并集/.test(d9.reason)
  && /只用 \[R#\]/.test(d9.reason) && /只用关键词子串/.test(d9.reason))
check('㉑ 点明"这个数是**关键词子串**推出来的"', d9.kind === 'deny' && /关键词子串推出来的/.test(d9.reason))
check('㉑ 点明本闸门用的是哪一个口径', d9.kind === 'deny' && /本闸门用的就是它/.test(d9.reason))
check('㉑ 负控 MAP 源（没有"哪几轮动过"）⇒ 理由里**不许**印口径三个数（编不出来就不编）',
  d1.kind === 'deny' && !/归属口径/.test(d1.reason))
// 单元：三口径在夹具上确实给出**不同**的数 —— 否则"印三个"就是摆设
const ARCH_CAL = archMd([
  { id: 'A', title: '甲支线', req: 'R1', items: [{ name: '甲子项', kw: '甲' }] },
  { id: 'B', title: '乙支线', req: 'R2', items: [{ name: '乙子项', kw: '乙' }] },
  { id: 'C', title: '丙支线', req: 'R3', items: [{ name: '丙子项', kw: '丙' }] },
  { id: 'D', title: '丁支线', req: 'R4', items: [{ name: '丁子项', kw: '丁' }] },
])
const R_CAL = BG.parseRounds(roundsJsonl([
  { round: 1, req: 'R1', delivered: '这一轮里没有那个关键词' },   // A：只有 [R#] 命中
  { round: 2, req: 'R9', delivered: '乙' },                       // B：只有关键词命中（R9 不在 ARCH 里）
]))
const cs = BG.caliberSpread(BG.parseArch(ARCH_CAL), R_CAL, new Set(), BG.DEFAULT_CFG)
check('㉑ 三口径给出**不同**的数（union=2 / reqOnly=3 / kwOnly=3）—— 口径真的在起作用',
  cs.union === 2 && cs.reqOnly === 3 && cs.kwOnly === 3, JSON.stringify(cs))
check('㉑ 并集归属得最多 ⇒ 被丢得最少（union ≤ 另两个）', cs.union <= cs.reqOnly && cs.union <= cs.kwOnly)
// ★ 口径必须跟**调用方的 cfg** 走（不是写死 DEFAULT_CFG）—— 上一版把它缓存在 loadBranches 里，
//   而那里的缓存键只有"文件指纹"、不含 cfg ⇒ 换 cfg 会给出**陈旧口径**。这条钉住"在 deny 那一次现算"。
const csTight = BG.caliberSpread(BG.parseArch(ARCH_CAL), R_CAL, new Set(),
  Object.assign({}, BG.DEFAULT_CFG, { STALE_GAP: 1 }))
check('㉑ 口径跟调用方的 cfg 走（STALE_GAP 3→1 ⇒ 被丢的从 2 变 3）',
  csTight.union === 3 && csTight.union > cs.union, JSON.stringify({ gap3: cs, gap1: csTight }))
check('㉑ 口径行里**每个数后面都跟着它的口径**（不许只印一个数）',
  BG.caliberLines(cs).join('\n').includes('并集') && BG.caliberLines(cs).join('\n').includes('只用 [R#]'))

// ── ㉓ ★ S8：临时区日志有界
section('㉓ ★ S8：临时区日志**有界**（原来每次写调用一行、无上限无轮转）')
const realConsoleError = console.error
console.error = function () { /* 自检里别把 100 行 stderr 灌进输出 */ }
const logLinesAllow = []
const lgAllow = BG.makeDefaultLog((line) => logLinesAllow.push(line))
for (let i = 0; i < 50; i += 1) lgAllow({ at: 'x', ev: 'allow', why: 'no-ledger', note: 'no-ledger', tool: 'edit', pid: 1 })
const logLinesDeny = []
const lgDeny = BG.makeDefaultLog((line) => logLinesDeny.push(line))
for (let i = 0; i < 50; i += 1) lgDeny({ at: 'x', ev: 'deny', why: 'branch-imbalance', note: 'deny:2d/1h', tool: 'edit', pid: 1 })
console.error = realConsoleError
check('㉓ 50 次 allow+note ⇒ 临时区最多写 LOG_MAX_ALLOW 行', logLinesAllow.length === BG.LOG_MAX_ALLOW,
  'wrote=' + logLinesAllow.length + ' max=' + BG.LOG_MAX_ALLOW)
check('㉓ 50 次 deny ⇒ 临时区最多写 LOG_MAX_DENY 行（拒绝单列一档）', logLinesDeny.length === BG.LOG_MAX_DENY,
  'wrote=' + logLinesDeny.length + ' max=' + BG.LOG_MAX_DENY)
check('㉓ 上限**不是 0**（不许为了省成本把观测整个砍掉）', BG.LOG_MAX_ALLOW >= 1 && BG.LOG_MAX_DENY >= 1)
check('㉓ 负控 上限是**真的**在拦：第 1 行写了、第 50 行没写',
  logLinesAllow.length > 0 && logLinesAllow.length < 50)

// ── ㉔ ★ S5：引文的逐字 + 行号可追
section('㉔ ★ S5：引文的**逐字**与**行号**都要可追（上一版把 :2974 写成 :1844）')
const WARDEN_LINES = WARDEN_SRC.split(/\r?\n/)
const QUOTE_SILENT = '重审永远先排热门支线 → 冷支线永远排不上队 = **用流程把冷支线静默丢掉**'
const quoteAt = WARDEN_LINES.findIndex((l) => l.includes(QUOTE_SILENT)) + 1
check('㉔ 那段引文在 `warden.mjs` 里**逐字**存在（找不到 = 引文过期，不是闸门坏了）', quoteAt > 0, 'at=' + quoteAt)

/**
 * ★★ **修法（R43 公开包事故之二）**：旧稿是 `check('㉔ 实测行号 = 2974（本单核到的）', quoteAt === 2974, …)`
 *   —— 一个**写死的过期行号**。实测本机已经是 `at=3571`（公开包那份是 3567），
 *   因为它**必须**随 `warden.mjs` 的版本漂移，而每漂一次就要人来手改一次。
 *
 *   我**没有**把 2974 改成 3571 —— 那只是把过期值往后推一次，
 *   下次 `warden.mjs` 一动，这条又会红（"修一次、烂一次"）。
 *
 *   现在的判据**自己算期望值**：期望值 = `quoteAt`（**从被测的 `warden.mjs` 里搜出来的真实行号**），
 *   判据 = 「`branch-guard.js` / `DESIGN.md` **引着那段引文时**标出的行号，必须等于 `quoteAt`」。
 *
 *   ⚠ **只认"引着那段引文的那一处"，不认文件里随便哪个 `warden.mjs:<N>`**。
 *     为什么这条很要命：旧稿的 `jsSrc.includes('warden.mjs:2974')` 是**整文件子串搜索**
 *     ⇒ 它命中的其实是文件里**另一处**注释（`js:13` 那句"同文件 `warden.mjs:2974` 留着自认的洞"），
 *     **与 `QUOTE_SILENT` 那段引文毫无关系**。也就是说旧稿那条断言**从写下的那天起就没在核它自称要核的东西**
 *     ——它核的是"文件里出现过字符串 2974"，而不是"这段引文的行号对不对"。
 *     ⇒ 本修法把"**哪一段引文**"钉成判据的一部分：必须**同一行**里同时出现
 *        `warden.mjs:<N>` **和** `QUOTE_SILENT` 的某个可辨识片段。
 *
 *   ⚠ 解析不出来 ⇒ **FAIL**（不许把"解析不出来"当通过）。
 *
 *   ⚠ **强度对比（如实说）**：
 *     · 变强的：① 不再凭常量、凭真实行号；② **JS 与 DESIGN 必须互相一致**（旧稿根本没有这条，
 *       而实测它们现在就不一致：JS 只在一处提引文、DESIGN 在另一处提，数字还不一样）；
 *       ③ 引文片段与行号必须在**同一行**上共现（旧稿的整文件子串搜索是假判据）。
 *     · 变弱的一处：旧稿会因为"文件里任何地方出现 2974"而 PASS。**那不是检查强度，那是个 bug** ——
 *       它对"引文行号漂了"完全不敏感（实测 2974 → 3567 它照样 FAIL，
 *       但 FAIL 的理由是"字符串不见了"，**不是**"行号不对"；改回字面量 2974 就能骗过它）。
 *     · ⇒ 净效果：**判据更强、更准**，且下面有负控证明它不是恒真。
 */
/** 引文的可辨识片段（用来在源码里认出"这一段引的正是那段引文"） */
const QUOTE_MARK = '用流程把冷支线静默丢掉'
/**
 * 在 src 里找"**引着那段引文的那一处**标了 `warden.mjs:<N>`"的那个 N。
 *
 * ⚠ 为什么不能只扫同一行：实测两处的排版**都是"行号在前一行、引文在下一行"**：
 *     · `branch-guard.js`  L13 `*   · 同文件 \`warden.mjs:2974\` 留着自认的洞：`
 *                          L14 `*     「重审永远先排热门支线 → … 用流程把冷支线静默丢掉**。」`
 *     · `DESIGN.md`        L46 是**单行**：`| \`warden.mjs:2974\` | 「…用流程把冷支线静默丢掉」 | …`
 *   ⇒ 判据取"**引文所在行，或它**紧邻的前一行**"（最多回看 1 行）——
 *     这是对**真实排版**的忠实描述，不是放宽：回看**只回看 1 行**，
 *     且那一行必须**含 `warden.mjs:<N>`**，否则返回 null（⇒ FAIL）。
 *
 * ⚠ 更要命的对照：旧稿的 `jsSrc.includes('warden.mjs:2974')` 是**整文件子串搜索** ——
 *   它命中的是 L13 那个行号，**跟"引文在第几行"没有半点关系**：
 *   把 L14 的引文整段删掉、L13 的 2974 留着，旧稿**照样 PASS**。
 *   ⇒ 新判据强制"行号 **与引文相邻**"，那种假绿就没了。
 * @returns {number|null}
 */
function citedLineForQuote(src) {
  const lines = String(src).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(QUOTE_MARK)) continue
    // ① 引文自己这一行
    const same = /warden\.mjs:(\d+)/.exec(lines[i])
    if (same) return Number(same[1])
    // ② 紧邻的前一行（"行号在前、引文在后"的排版）
    const prev = i > 0 ? /warden\.mjs:(\d+)/.exec(lines[i - 1]) : null
    if (prev) return Number(prev[1])
    return null      // 引文在、但旁边没有行号 ⇒ 明确"解析不出来"，不许继续找别的行
  }
  return null
}
/**
 * ⚠ `JS_READ` / `DESIGN2_READ`（带 try/catch 的那两个）**声明在上面、靠近 `TPL_READ` 处** ——
 *   因为 ⑧ 那一组（源码去注释扫描）在 371 行附近就要用 `JS_READ`，
 *   不允许"用到一半才声明"（`const` 有 TDZ，会直接抛 `ReferenceError`）。
 */
// 被测本体都读不到 ⇒ 这一组**全 FAIL**（不是 SKIP：连"测的对象"都不在，说"核不了"太轻）
check('㉔ 被测本体 `branch-guard.js` 读得到（读不到 = FAIL，不许当"核不了"轻轻放过）',
  JS_READ.ok, JS_READ.why || '')
const jsLine = jsSrc === null ? null : citedLineForQuote(jsSrc)
const designLine = designSrc === null ? null : citedLineForQuote(designSrc)
check('㉔ ★ `branch-guard.js` **引着那段引文的那一行**上标了行号且可解析（解析不出来 = FAIL）',
  jsLine !== null, 'js=warden.mjs:' + jsLine)
check('㉔ ★ **`branch-guard.js` 标的行号 == 引文真在第几行**（期望值来自被测文件，不抄常量）',
  jsLine !== null && quoteAt > 0 && jsLine === quoteAt,
  'js 标=' + jsLine + ' 真在=' + quoteAt + (jsLine === quoteAt ? '' : '  ← 行号已过期（真实漂移），去改源码里的标注'))
// ⚠ DESIGN 不在 ⇒ SKIP（旁证文档缺位），**不是** PASS，**也不是**假红
if (designSrc === null) {
  skip('㉔ ★ **`branch-guard.DESIGN.md` 标的行号 == 引文真在第几行**（与 JS 同一个真相源）',
    '**核不了**：' + DESIGN2_READ.why + '（这不是"核过了"）')
  skip('㉔ ★ 两份标注**互相一致**（JS 与 DESIGN 不许各写各的 —— 旧稿没有这条判据）',
    '**核不了**：' + DESIGN2_READ.why + '（这不是"核过了"）')
} else {
  check('㉔ ★ **`branch-guard.DESIGN.md` 标的行号 == 引文真在第几行**（与 JS 同一个真相源）',
    designLine !== null && quoteAt > 0 && designLine === quoteAt,
    'DESIGN 标=' + designLine + ' 真在=' + quoteAt)
  check('㉔ ★ 两份标注**互相一致**（JS 与 DESIGN 不许各写各的 —— 旧稿没有这条判据）',
    jsLine !== null && designLine !== null && jsLine === designLine,
    'js=' + jsLine + ' design=' + designLine)
}
// ⚠ 这两条**保留原意**（"历史坏值 :1844 不许回来"），但收窄成"引文那一行"——
//   全文子串搜索会把无关文本里的 1844 也算进来（旧稿的 `.includes` 正是这个毛病）。
check('㉔ 引着那段引文的那一行里**不出现历史坏值 :1844**',
  jsSrc !== null && !String(jsSrc).split(/\r?\n/).some((l) => l.includes(QUOTE_MARK) && l.includes('warden.mjs:1844')))
if (designSrc !== null) {
  check('㉔ `branch-guard.DESIGN.md` 里不出现历史坏值 :1844',
    !designSrc.includes('warden.mjs:1844'))
}
/**
 * ★ **负控（证明上面"自己算期望值"的判据不是恒真）**：
 *   ① 把标注写成 `quoteAt + 1` ⇒ 判据**必须为假**；
 *   ② 把那段引文整行删掉（模拟"引文过期"）⇒ `citedLineForQuote` 必须返回 null（⇒ FAIL）。
 */
check('㉔ 负控①：把标注改成"真行号 +1" ⇒ `jsLine === quoteAt` **必须为假**',
  (function () {
    const fake = ' *   · 同文件 `warden.mjs:' + (quoteAt + 1) + '` 留着自认的洞：\n *     「… ' + QUOTE_MARK + '…」'
    return citedLineForQuote(fake) !== quoteAt
  })(),
  '假标注=' + (quoteAt + 1) + ' 真=' + quoteAt)
check('㉔ 负控②：引文那行整行没了 ⇒ 解析必须返回 null（⇒ 判据 FAIL，不许静默当真）',
  citedLineForQuote(' *   · 同文件 `warden.mjs:1234` 留着自认的洞：（引文已被删）') === null)
check('㉔ 负控③：**引文留着、行号删掉** ⇒ 解析必须返回 null（旧稿的整文件子串搜索在这里会假绿）',
  citedLineForQuote(' *   · 同文件 留着自认的洞：\n *     「… ' + QUOTE_MARK + '…」') === null)

// ── ㉕ ★ 逐字：权威源从盘上读；本闸门**不印**三条硬规矩
section('㉕ ★ 逐字：权威源是 `派单模板.md`（从盘上读，不许在自检里另抄一遍）')
/**
 * ★★ **公开版的修法（B5）**：`派单模板.md` **不在公开包里** ⇒ 这三条**必然核不了**。
 *   旧稿的形态是「读不到 ⇒ `TPL_SRC=''` ⇒ 三条断言**按设计一律 FAIL**」。
 *   那在公开用户机器上就是**3 条假红**：他什么都没干，却看到插件像坏了。
 *
 *   我选 **SKIP**（而不是"沿用 FAIL"或"改读不到就算过"），三条理由：
 *     ① **不能 FAIL**：这不是"闸门有缺陷"，是"**这份输入在本包不存在**"。
 *        这个自检的定位是"插件在本机可用"，而插件**运行期根本不读 `派单模板.md`**
 *        （它只在 handover-gate 的 deny 文案里用那三条硬规矩，且那些是插件自己的 `HARD_RULES`）。
 *        ⇒ 把"打包时没带这份私有文档"记成插件的 FAIL，是**指错了对象**。
 *     ② **更不能 PASS**：读不到就当通过，正是 A6「没查到 ≠ 查了没问题」的病。
 *     ③ ⇒ 第三档 SKIP：**逐条印出**"核不了，因为找不到 X"，**不进 exit code**，
 *        并在汇总行里**明写"有 N 条没核"** —— "没核"这件事本身**可见**。
 *
 *   ⚠ **强度对比（如实说）**：在**有** `派单模板.md` 的机器上（比如本机），
 *     下面这些断言**一条都不少、判据一字不改**，照旧 PASS/FAIL。
 *     只在**没有**这份文件时才降级成 SKIP。
 *     ⇒ 换句话说：**本机（开发机）的检查强度没有削弱**，公开包只是把"假红"改成"如实说核不了"。
 *   ⚠ 而且**降级是"整组"降的**：三条一起 SKIP，**不许**留其中一条去 PASS 凑数。
 */
if (!TPL_READ.ok) {
  const WHY = '**核不了**：' + TPL_READ.why + '（`派单模板.md` 不在公开包里；这不是"核过了"）'
  skip('㉕ 权威源 `派单模板.md` 在', WHY)
  skip('㉕ 权威源里第 2 条用的是 **ASCII U+0022**（不是 U+201C/U+201D）', WHY)
  skip('㉕ 权威源里第 1 条是**两行**、且两行里都没有全角空格 U+3000', WHY)
  skip('㉕ 负控 "把两行用 U+3000 拼成一行"这个形态**在权威源里不存在**（那就是被润色过的版本）', WHY)
} else {
check('㉕ 权威源 `派单模板.md` 在', TPL_SRC.length > 0, DISPATCH_TPL)
const hasStraightQuote = (s) => s.includes('不许用"加提示词"解决任何问题')
check('㉕ 权威源里第 2 条用的是 **ASCII U+0022**（不是 U+201C/U+201D）', hasStraightQuote(TPL_SRC))
check('㉕ 负控 把引号换成 U+201C/U+201D ⇒ 上面那条判据**必须为假**（证明它不是恒真）',
  hasStraightQuote('不许用\u201C加提示词\u201D解决任何问题') === false)
const tplLines = TPL_SRC.split(/\r?\n/)
const tplL13 = (tplLines[12] || '').trim()
const tplL14 = (tplLines[13] || '').trim()
check('㉕ 权威源里第 1 条是**两行**、且两行里都没有全角空格 U+3000',
  tplL13.includes('只改你点名的文件') && tplL14.includes('真文件一个字节都不许动')
  && !tplL13.includes('\u3000') && !tplL14.includes('\u3000'))
check('㉕ 负控 "把两行用 U+3000 拼成一行"这个形态**在权威源里不存在**（那就是被润色过的版本）',
  !TPL_SRC.includes(tplL13 + '\u3000' + tplL14))
}
check('㉕ 本闸门的 deny 理由**不印**三条硬规矩（那是 R43 `handover-gate.js` 的事；印了就是越界 + 抄错风险）',
  !/三条硬规矩|加提示词|DSH_HOME|真文件一个字节/.test(d1.reason))
check('㉕ 本闸门自己的三条硬约束是**另一组**（fail-open / 非写工具零 IO / 补救路永不拦），在源码注释里',
  jsSrc.includes('fail-open') && jsSrc.includes('补救的路') && jsSrc.includes('非写工具'))

finish()

function finish() {
  console.log('\n' + '='.repeat(72))
  console.log(`结果：${pass} PASS / ${fail} FAIL${skipN ? ' / ' + skipN + ' SKIP' : ''}`)
  if (skipN) {
    // ⚠ 逐条印出来，**不许**把 SKIP 混进"结果：xxx PASS"里让人以为全核过了（A6）。
    console.log(`⚠ **有 ${skipN} 条没核**（SKIP ≠ 通过；前置输入不在本包/本机里）：`)
    for (const n of skippedNames) console.log('    SKIP  ' + n)
    console.log('  原因见上面每条 SKIP 后面的说明；要真核，请设 TASK_WARDEN_ROOT 指向有 `派单模板.md` 的那一层。')
  }
  if (fail) console.log('未通过：' + failedNames.join(' ｜ '))
  console.log('夹具根（%TEMP%，没碰真工程）：' + ROOT)
  console.log('exit code = ' + (fail ? 1 : 0) + (skipN ? '（SKIP 计入上面的"没核"，但**不**改变 exit code）' : ''))
  process.exit(fail ? 1 : 0)
}
