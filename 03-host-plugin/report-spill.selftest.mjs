#!/usr/bin/env node
/*
 * report-spill.selftest.mjs —— `report-spill.js` 的自检。**用 exit code 报结果**：
 *   0 = 全过（所有断言都成立）
 *   1 = 有红（至少一条断言不成立，逐条打印是哪条）
 *   2 = 环境不合法（见下面那条硬门槛）—— **不是**"测过了"
 *
 * ── 硬门槛：DSH_HOME 必须指向镜像（用户逐字规矩③）────────────────────────────
 *   跑本文件之前必须把 `DSH_HOME` 指到一个**含下面四样**的镜像：
 *     <DSH_HOME>\skills\task-warden\warden.mjs
 *     <DSH_HOME>\skills\task-warden\bill.mjs
 *     <DSH_HOME>\skills\task-warden\selftest.mjs
 *     <DSH_HOME>\skills\task-warden\experiments\lab\   （目录）
 *   缺一样 ⇒ **exit 2**，并打印该怎么跑。**故意做成硬门槛**：
 *   "测的时候环境不对"这件事必须是**跑出来的红**，不能靠人记得。
 *   本仓库现成的镜像：
 *     <WORKSPACE>\task-warden\.warden\patches\P-M26\work\mirror-dsh-home
 *   跑法（PowerShell，一行）：
 *     $env:DSH_HOME='<WORKSPACE>\task-warden\.warden\patches\P-M26\work\mirror-dsh-home'; node <WORKSPACE>\task-warden\plugin\report-spill.selftest.mjs
 *
 * ── 夹具一律造在 %TEMP%\report-spill-lab，**不碰**真工程、不碰 `.warden\` ────
 *
 * ── 断言覆盖（每条都能被复跑；编号与报告正文一一对应）──────────────────────
 *   ① 码点口径：cpLength / cpSliceHead / cpSliceTail，emoji 不被劈成半个代理对
 *   ② 替换串**逐字形状**（与用户点名的格式逐字符对照）
 *   ③ `decide()` 的每一条"不触发"判据（纯函数层，零 IO）+ 工具名单（7+2，含审查点名那三个）
 *   ④ 零上下文注入（假 ctx 列出全部触碰键）+ `{prepend:true}` + 交回 disposer（**两个**监听器）
 *   ⑤ 通道 A 端到端：长报告 ⇒ 落盘 + 换回"头尾+路径"；**正文与原文逐字节相同（sha256）**
 *   ⑥ 短报告 ⇒ 原样返回**同一个** decision 对象
 *   ⑦ 非目标工具 ⇒ 原样返回同一个对象 **且 fs 调用 0 次**（spy，带正控）
 *   ⑧ `exec.parent !== undefined`（嵌套调用）⇒ 不动
 *   ⑨ `result.isError === true` ⇒ 不动
 *   ⑩ `additionalContexts` 被**原样转发**
 *   ⑪ 非 text 块 / `kind:'block'` / 带 `value` 的 decision ⇒ 不动
 *   ⑫ 落盘失败（`角色发言` 是个文件）⇒ **fail-open**：原样放行 + 记一行
 *   ⑬ 工程根推不出 ⇒ fail-open + 记一行（`existsSync` 桩，带正控）
 *   ⑭ 撞名**不覆盖**：同一秒同一工具两份报告 ⇒ 第二份落 `-2`
 *   ⑮ 同一个 `callId` 被问第二遍 ⇒ 复用，**不写第二个文件**
 *   ⑯ 可逆：dispose 之后监听器**全摘净**（夹具只调注册时交回的 disposer）
 *   ⑰ **判定性对照**：阈值真的在起作用（默认 4000 / 副本常量改 1 / config / env / env 关）
 *   ⑱ `findProjectRootVia` 与 `role-voices.js` 的**对拍**（两份实现漂了就红）
 *   ⑲ 性能：非目标工具 5 次读数 + 中位，且 fs 调用 0 次
 *   ★ 本单新增（R26 返工）：
 *   ⑳ **通道 B 端到端**（`agent/pre-step` 结算通知）：换回"头尾+路径"、
 *      正文逐字节 === 子代理那份报告、summary/marker/reasoning 块**原样不动**、
 *      认不出形状 ⇒ 不动 + 记一行、没留收尾话 ⇒ 不动（静默）、非通知消息 ⇒ 不动
 *   ㉑ **`角色发言\` 有界**：轮转只删本插件自己的报告文件（严判名字），
 *      role-voices 归档 / INDEX.md / README.md / 子目录 / 其它文件**一个都不碰**；
 *      刚写下去的那一份**永不删**；`keepReports=0` ⇒ 关掉
 *   ㉒ 工具名单与本部署**真 preset 文件**对拍（`roles/agent.cordis.yml` 里所有 `toolName:`）
 *
 * 用法：
 *   node report-spill.selftest.mjs           跑完全套，结束后删掉夹具
 *   node report-spill.selftest.mjs --keep    跑完**保留**夹具（端到端演示用）
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

const require = createRequire(import.meta.url)
const plugin = require('./report-spill.js')
const I = plugin._internals
const roleVoices = require('./role-voices.js')

const KEEP = process.argv.includes('--keep')

// ────────────────────────────────────────────────────────────────────────────
// ⓪ 硬门槛：DSH_HOME 必须指向镜像
// ────────────────────────────────────────────────────────────────────────────
const MIRROR_NEED = [
  path.join('skills', 'task-warden', 'warden.mjs'),
  path.join('skills', 'task-warden', 'bill.mjs'),
  path.join('skills', 'task-warden', 'selftest.mjs'),
  path.join('skills', 'task-warden', 'experiments', 'lab'),
]
{
  const home = process.env.DSH_HOME || ''
  const missing = home === '' ? MIRROR_NEED.slice() : MIRROR_NEED.filter((r) => !fs.existsSync(path.join(home, r)))
  if (missing.length > 0) {
    console.error('[report-spill.selftest] exit 2：DSH_HOME 没指向合法镜像。')
    console.error('  DSH_HOME = ' + JSON.stringify(home))
    console.error('  缺: ' + JSON.stringify(missing))
    console.error('  跑法：')
    console.error("    $env:DSH_HOME='<WORKSPACE>\\task-warden\\.warden\\patches\\P-M26\\work\\mirror-dsh-home'; node " + path.resolve(process.argv[1]))
    process.exit(2)
  }
  console.log('[门槛] DSH_HOME 镜像 OK = ' + home + '（四样齐全）')
}

// ────────────────────────────────────────────────────────────────────────────
// 断言框架
// ────────────────────────────────────────────────────────────────────────────
const results = []
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) })
}
function eq(name, got, want) {
  check(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want))
}
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}
function listFiles(dir) {
  const out = []
  const walk = (d, rel) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch (e) { return }
    for (const e of entries) {
      const r = rel === '' ? e.name : rel + '/' + e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}

// ────────────────────────────────────────────────────────────────────────────
// fs spy —— "零 IO"必须**跑出来**，不能靠读代码相信
// ────────────────────────────────────────────────────────────────────────────
const FS_FNS = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'existsSync', 'readFileSync', 'statSync', 'openSync', 'readdirSync', 'unlinkSync', 'rmSync']
const realFs = {}
let spyOn = false
let spyCounts = {}
function installFsSpy() {
  for (const k of FS_FNS) {
    realFs[k] = fs[k]
    fs[k] = function (...args) {
      if (spyOn) spyCounts[k] = (spyCounts[k] || 0) + 1
      return realFs[k].apply(fs, args)
    }
  }
}
function uninstallFsSpy() {
  for (const k of FS_FNS) if (realFs[k]) fs[k] = realFs[k]
}
function spyStart() { spyCounts = {}; spyOn = true }
function spyStop() { spyOn = false; return spyCounts }
function spyTotal(c) { return Object.values(c).reduce((a, b) => a + b, 0) }
installFsSpy()
// 正控：spy 必须真的挂在插件用的那个 fs 对象上（否则"0 次"是假绿）
{
  const probe = path.join(os.tmpdir(), 'report-spill-spy-probe.txt')
  spyStart()
  fs.writeFileSync(probe, 'x', 'utf8')
  const c = spyStop()
  check('⓪ spy 正控：直接调 fs.writeFileSync 被数到 1 次（spy 与插件同源）', c.writeFileSync === 1, JSON.stringify(c))
  try { fs.unlinkSync(probe) } catch (e) { /* ignore */ }
}

// ────────────────────────────────────────────────────────────────────────────
// 假 ctx：把插件**真正 apply 一遍**，记录它碰过的每一样东西
// ────────────────────────────────────────────────────────────────────────────
function makeFakeCtx() {
  const listeners = []
  const effects = []
  const touches = []
  const calls = []
  const logs = { info: [], warn: [], error: [] }
  const target = {
    on(name, fn, opts) {
      calls.push({ m: 'on', args: [String(name), opts === undefined ? null : opts] })
      const rec = { name: String(name), fn, opts }
      rec.dispose = function dispose() {
        const i = listeners.indexOf(rec)
        if (i < 0) return false
        listeners.splice(i, 1)
        return true
      }
      listeners.push(rec)
      return rec.dispose
    },
    effect(fn, label) {
      calls.push({ m: 'effect', args: [String(label)] })
      const d = typeof fn === 'function' ? fn() : undefined
      const rec = { label: String(label), dispose: typeof d === 'function' ? d : () => {} }
      effects.push(rec)
      rec.detach = function detach() {
        const i = effects.indexOf(rec)
        if (i < 0) return false
        effects.splice(i, 1)
        rec.dispose()
        return true
      }
      return rec.detach
    },
    logger: {
      info(m) { logs.info.push(String(m)) },
      warn(m) { logs.warn.push(String(m)) },
      error(m) { logs.error.push(String(m)) },
    },
  }
  const ctx = new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol') return t[prop]
      const key = String(prop)
      touches.push(key)
      if (Object.prototype.hasOwnProperty.call(t, key)) return t[key]
      calls.push({ m: 'read-unknown', args: [key] })
      return undefined
    },
  })
  return {
    ctx, listeners, effects, touches, calls, logs,
    names: () => listeners.map((l) => l.name),
    /**
     * ★ 模拟 fiber 卸载：**只调"注册时交回来的那些 disposer"**（逆序），
     *   **绝不**自己顺手 `listeners.length = 0` —— 否则"插件什么都不摘"也会 PASS，
     *   那是假绿（R42 的 selftest 踩过这个坑，这里照它的修法做）。
     */
    dispose() {
      const log = []
      for (const rec of listeners.slice().reverse()) {
        if (typeof rec.dispose === 'function') log.push(['on:' + rec.name, rec.dispose()])
      }
      for (const rec of effects.slice().reverse()) {
        if (typeof rec.detach === 'function') log.push(['effect:' + rec.label, rec.detach()])
      }
      return log
    },
    /** 找到某个事件的监听器（找不到就抛，别静默） */
    rec(evName) {
      const rec = listeners.find((l) => l.name === evName)
      if (!rec) throw new Error(evName + ' 监听器不存在')
      return rec
    },
    /** 通道 A 的监听器 */
    handler() { return this.rec('tools/post-execute') },
    /** 通道 B 的监听器（本单新增） */
    preStep() { return this.rec('agent/pre-step') },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 夹具
// ────────────────────────────────────────────────────────────────────────────
const LAB = path.join(os.tmpdir(), 'report-spill-lab')
fs.rmSync(LAB, { recursive: true, force: true })
fs.mkdirSync(LAB, { recursive: true })
const FALLBACK = path.join(LAB, '__fallback__')
const PROJ = path.join(LAB, 'proj')          // 有 .git ⇒ 工程根 = PROJ
const PROJ2 = path.join(LAB, 'proj2')        // 有 .warden ⇒ via self
const NOROOT = path.join(LAB, 'noroot')      // 两个都没有（配合 existsSync 桩）
for (const d of [PROJ, PROJ2, NOROOT]) fs.mkdirSync(d, { recursive: true })
fs.mkdirSync(path.join(PROJ, '.git'), { recursive: true })
fs.mkdirSync(path.join(PROJ2, '.warden'), { recursive: true })
const ARCH = path.join(PROJ, I.DIR_NAME)
const ARCH2 = path.join(PROJ2, I.DIR_NAME)

/** 造一份长度**恰好 n 个码点**的 ASCII 报告（ASCII 下码点 == UTF-16 码元，便于独立核算）。 */
function mkReport(n, seed) {
  const head = 'HEAD[' + seed + ']'
  const tail = '[TAIL' + seed + ']'
  const body = 'x'.repeat(Math.max(0, n - head.length - tail.length))
  return head + body + tail
}

function makeSession(id, cwd) {
  return { header: { version: 3, id, cwd }, seq: 0, inheritedEventCount: 0 }
}
function makeAgent(id, session) {
  return { id, session, status: 'idle' }
}
/** 造一次 `tools/post-execute` 的 exec/result。 */
function makeExec(over) {
  const o = over || {}
  const session = o.session || makeSession('session-aaaa-bbbb-cccc-dddd11112222', PROJ)
  const agent = o.agent || makeAgent('session-aaaa-bbbb-cccc-dddd11112222', session)
  const exec = { name: o.name === undefined ? 'subagent' : o.name, arguments: {}, agent, callId: o.callId === undefined ? 'call-1' : o.callId }
  if (o.parent !== undefined) exec.parent = o.parent
  if (o.noAgent === true) delete exec.agent
  return exec
}
function acceptResult(text) {
  return { isError: false, content: [{ type: 'text', text: text }] }
}
/** 跑一次通道 A 的监听器（waterfall：next 的默认值就是 dsh-tools 自己那个兜底）。 */
function run(fc, exec, result, decisionOverride) {
  const rec = fc.handler()
  const next = () => Promise.resolve(decisionOverride === undefined ? { kind: 'accept' } : decisionOverride)
  return rec.fn(exec, result, next)
}

/**
 * ★ 造一条**形状与真框架逐字相同**的结算通知（`dsh-subagent\lib\index.js:661-681`）。
 * `[summary, marker, ...output]`，output 里可能夹 reasoning 块。
 */
function makeNotice(body, opts) {
  const o = opts || {}
  const childId = o.childId || 'session-1111-2222-3333-444455556666'
  const content = [{
    type: 'text',
    text: 'Background subagent ' + childId + ' finished and will do no further work unless you send it more.',
  }]
  if (o.noOutput === true) {
    content.push({ type: 'text', text: I.NOTICE_MARKER_NONE })
  } else {
    content.push({ type: 'text', text: I.NOTICE_MARKER_CLOSING })
    if (o.reasoning !== undefined) content.push({ type: 'reasoning', text: o.reasoning })
    content.push({ type: 'text', text: body === undefined ? '' : body })
  }
  if (o.extra !== undefined) content.push(o.extra)
  return {
    content: content,
    source: { kind: I.NOTICE_SOURCE_KIND, form: 'notice', summary: 'subagent finished', senderSessionId: childId },
  }
}
/** 跑一次通道 B 的监听器。 */
function runPreStep(fc, agent, messages, decisionOverride) {
  const rec = fc.preStep()
  const next = () => Promise.resolve(decisionOverride === undefined ? { kind: 'enter', messages: messages } : decisionOverride)
  return rec.fn({ agent: agent, messages: messages, turn: 1, step: 1, signal: {} }, next)
}

// ────────────────────────────────────────────────────────────────────────────
// ⓪b 导出形状 —— 宿主加载器（`unwrapExports`）只取 name / inject / apply
// ────────────────────────────────────────────────────────────────────────────
{
  eq('⓪b 导出 name 是字符串', typeof plugin.name, 'string')
  eq('⓪b 导出 name = report-spill（与 cordis.patch.yml 里那行的 id 同名）', plugin.name, 'report-spill')
  eq('⓪b 导出 inject 是数组', Array.isArray(plugin.inject), true)
  eq('⓪b 导出 apply 是函数', typeof plugin.apply, 'function')
  eq('⓪b apply 收两个形参（ctx, config）', plugin.apply.length, 2)
  check('⓪b _internals 也在（自检用；加载器忽略多余字段）', typeof plugin._internals === 'object' && plugin._internals !== null, typeof plugin._internals)
  console.log('[证据 ⓪b] module.exports = { name: ' + JSON.stringify(plugin.name) + ', inject: ' + JSON.stringify(plugin.inject) + ', apply: [Function:' + plugin.apply.length + '], _internals: {...} }')
}

// ────────────────────────────────────────────────────────────────────────────
// ① 码点口径
// ────────────────────────────────────────────────────────────────────────────
{
  eq('① cpLength("abc") = 3', I.cpLength('abc'), 3)
  eq('① cpLength("😀") = 1（不是 2）', I.cpLength('😀'), 1)
  eq('① cpLength("a😀b") = 3', I.cpLength('a😀b'), 3)
  const emo = '😀'.repeat(2000)
  eq('① emoji 串码点 = 2000（UTF-16 长度 4000）', I.cpLength(emo), 2000)
  eq('① 它的 .length 确实是 4000（口径差异看得见）', emo.length, 4000)
  const h = I.cpSliceHead(emo, 1200)
  const t = I.cpSliceTail(emo, 600)
  eq('① cpSliceHead(1200) 码点数 = 1200', I.cpLength(h), 1200)
  eq('① cpSliceTail(600) 码点数 = 600', I.cpLength(t), 600)
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  check('① 头里没有半个代理对（emoji 没被劈）', !lone.test(h), 'head 前 8 个码元=' + JSON.stringify(h.slice(0, 8)))
  check('① 尾里没有半个代理对', !lone.test(t), 'tail 前 8 个码元=' + JSON.stringify(t.slice(0, 8)))
  console.log('[证据 ①] emoji 串：码点 2000 / UTF-16 4000；头 1200 码点 = ' + h.length + ' 码元；尾 600 码点 = ' + t.length + ' 码元')
}

// ────────────────────────────────────────────────────────────────────────────
// ② 替换串逐字形状
// ────────────────────────────────────────────────────────────────────────────
{
  const n = 9000
  const text = mkReport(n, 'shape')
  const p = 'D:\\x\\角色发言\\2026-09-24_215530__报告__subagent.md'
  const got = I.buildReplacement(text, p)
  check('② buildReplacement 成立', got.ok === true, JSON.stringify(got && got.reason))
  if (got.ok) {
    const want = I.noticeFor(n, p) + '\n\n' + text.slice(0, 1200) + '\n\n' + I.markerFor(n - 1800) + '\n\n' + text.slice(n - 600)
    eq('② 与用户点名的格式**逐字符**相同', got.text, want)
    eq('② 头 = 1200', got.head, 1200)
    eq('② 尾 = 600', got.tail, 600)
    eq('② 省略 = n-1800', got.omitted, n - 1800)
    check('② 通知行以 `[完整报告 9000 字符已落盘（原文逐字节在盘上）：` 开头',
      got.text.startsWith('[完整报告 9000 字符已落盘（原文逐字节在盘上）：' + p + ']'),
      JSON.stringify(got.text.slice(0, 40)))
    check('② 中间省略标记逐字 = `…（中间省略 7200 字符）…`', got.text.includes('…（中间省略 7200 字符）…'))
    check('② 替换串比原文短', I.cpLength(got.text) < n, I.cpLength(got.text) + ' vs ' + n)
    console.log('[证据 ②] 原文 9000 → 换回 ' + I.cpLength(got.text) + ' 字符；头 ' + got.head + ' + 尾 ' + got.tail + '，省略 ' + got.omitted)
  }
  // 守卫：短到没有"中间"可省 ⇒ 不成立
  const tiny = I.buildReplacement('short', p)
  eq('② 极短文本 ⇒ nothing-to-omit（不换）', tiny.ok === false ? tiny.reason : 'ok', 'nothing-to-omit')
}

// ────────────────────────────────────────────────────────────────────────────
// ③ decide() 的每一条"不触发"判据（纯函数，零 IO）+ 工具名单
// ────────────────────────────────────────────────────────────────────────────
{
  const long = mkReport(7000, 'decide')
  const res = acceptResult(long)
  const acc = { kind: 'accept' }
  eq('③ 基线：subagent + 顶层 + accept + 7000 字符 ⇒ 触发', I.decide(makeExec(), res, acc, 4000).reason, 'over-threshold')
  eq('③ exec 缺失 ⇒ no-exec', I.decide(null, res, acc, 4000).reason, 'no-exec')
  eq('③ 非目标工具 read ⇒ not-spill-tool', I.decide(makeExec({ name: 'read' }), res, acc, 4000).reason, 'not-spill-tool')
  eq('③ 非目标工具 pwsh ⇒ not-spill-tool', I.decide(makeExec({ name: 'pwsh' }), res, acc, 4000).reason, 'not-spill-tool')
  eq('③ parent 存在（嵌套）⇒ nested-call', I.decide(makeExec({ parent: 'tok-1' }), res, acc, 4000).reason, 'nested-call')
  eq('③ decision 是 block ⇒ not-accept', I.decide(makeExec(), res, { kind: 'block', feedback: [] }, 4000).reason, 'not-accept')
  eq('③ decision 带 value ⇒ value-replacement', I.decide(makeExec(), res, { kind: 'accept', value: 1 }, 4000).reason, 'value-replacement')
  eq('③ result.isError ⇒ is-error-result', I.decide(makeExec(), { isError: true, content: [{ type: 'text', text: long }] }, acc, 4000).reason, 'is-error-result')
  eq('③ 混了非 text 块 ⇒ non-text-block',
    I.decide(makeExec(), { isError: false, content: [{ type: 'text', text: long }, { type: 'image', data: 'x' }] }, acc, 4000).reason, 'non-text-block')
  eq('③ 4000 字符 ⇒ under-threshold（阈值是"严格大于"）', I.decide(makeExec(), acceptResult(mkReport(4000, 'eq')), acc, 4000).reason, 'under-threshold')
  eq('③ 4001 字符 ⇒ over-threshold', I.decide(makeExec(), acceptResult(mkReport(4001, 'gt')), acc, 4000).reason, 'over-threshold')
  for (const t of I.SPILL_TOOLS) {
    eq('③ 目标工具族 ' + t + ' ⇒ 触发', I.decide(makeExec({ name: t }), res, acc, 4000).reason, 'over-threshold')
  }
  // ★ 审查点名的三个名字必须在名单里（逐字）
  for (const t of ['subagent_liaison', 'subagent_direction', 'subagent_coder']) {
    check('③ ★审查点名 ' + t + ' 在 SUBAGENT_TOOLS 里', I.SUBAGENT_TOOLS.includes(t), JSON.stringify(I.SUBAGENT_TOOLS))
  }
  eq('③ 子代理工具族一共 7 个（本部署默认 preset 里所有 toolName）', I.SUBAGENT_TOOLS.length, 7)
  eq('③ 编排器工具 2 个（workflow / ralph）', I.ORCHESTRATOR_TOOLS.length, 2)
  eq('③ 目标工具合计 9 个', I.SPILL_TOOLS.length, 9)
  eq('③ 默认阈值 = 4000（本单重新定，依据见源码注释）', I.DEFAULT_MAX_CHARS, 4000)
  console.log('[证据 ③] SUBAGENT_TOOLS = ' + JSON.stringify(I.SUBAGENT_TOOLS))
  console.log('[证据 ③] ORCHESTRATOR_TOOLS = ' + JSON.stringify(I.ORCHESTRATOR_TOOLS) + '；合计 ' + I.SPILL_TOOLS.length + ' 个；默认阈值 ' + I.DEFAULT_MAX_CHARS)
}

// ────────────────────────────────────────────────────────────────────────────
// ④ 零上下文注入 + prepend + disposer（**两个**监听器）
// ────────────────────────────────────────────────────────────────────────────
{
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK })
  eq('④ 注册了恰好 2 个监听器（通道 A + 通道 B）', fc.listeners.length, 2)
  eq('④ 第 1 个监听的是 tools/post-execute（通道 A）', fc.names()[0], 'tools/post-execute')
  eq('④ 第 2 个监听的是 agent/pre-step（通道 B，本单新增）', fc.names()[1], 'agent/pre-step')
  eq('④ 通道 A 带了 {prepend:true}（照 spill-policy 的做法）', JSON.stringify(fc.handler().opts), JSON.stringify({ prepend: true }))
  eq('④ 通道 B 也带了 {prepend:true}', JSON.stringify(fc.preStep().opts), JSON.stringify({ prepend: true }))
  eq('④ ctx.on 返回了 disposer（函数）', typeof fc.handler().dispose, 'function')
  eq('④ 通道 B 的 ctx.on 也返回了 disposer', typeof fc.preStep().dispose, 'function')
  eq('④ 注册了恰好 1 个 effect', fc.effects.length, 1)
  eq('④ effect 的 label', fc.effects[0].label, 'report-spill.dispose-hooks')
  const uniq = Array.from(new Set(fc.touches)).sort()
  console.log('[证据 ④] 插件碰过的 ctx 键（去重排序）= ' + JSON.stringify(uniq))
  console.log('[证据 ④] ctx 调用序列 = ' + JSON.stringify(fc.calls.map((c) => c.m + (c.args ? '(' + c.args.join(',') + ')' : ''))))
  const allowed = ['on', 'effect', 'logger']
  check('④ 碰过的 ctx 键 ⊆ {on, effect, logger} —— 一个多余的都没有',
    uniq.every((k) => allowed.includes(k)), JSON.stringify(uniq))
  for (const bad of ['systemPrompt', 'context', 'messages', 'steer', 'prompt', 'inject', 'provide', 'get']) {
    check('④ 没有碰 ctx.' + bad, !uniq.includes(bad), JSON.stringify(uniq))
  }
  check('④ 没有任何 read-unknown（读了不存在的 ctx 属性）',
    !fc.calls.some((c) => c.m === 'read-unknown'), JSON.stringify(fc.calls.filter((c) => c.m === 'read-unknown')))
  check('④ 没有 ctx.get(...)（不取任何服务）', !fc.calls.some((c) => c.m === 'get'), JSON.stringify(fc.calls))
  eq('④ inject 是空的（不把生死绑在别人的加载顺序上）', JSON.stringify(plugin.inject), '[]')
  eq('④ name = report-spill', plugin.name, 'report-spill')
  // 可逆 ⑯ 放这里一起做（同一个夹具）
  // ⚠ 关键顺序：**先只调 effect 的 disposer**（不碰 on 那两个），
  //   这样才能证明"插件自己的 effect 回调真的把监听器摘了"，
  //   而不是被夹具顺手清空（R42 的 selftest 在这里踩过假绿的坑）。
  const before = fc.names().slice()
  const effOk = fc.effects[0].detach()
  eq('⑯ 调 effect 的 disposer 之前：监听器数 = 2', before.length, 2)
  eq('⑯ effect 的 disposer 返回 true（找到并摘掉）', effOk, true)
  eq('⑯ **只调 effect 的 disposer** ⇒ 监听器被插件自己的回调摘净（0 个）', fc.names().length, 0)
  eq('⑯ 此时 effect 也空了', fc.effects.length, 0)
  eq('⑯ 反控：摘净后 tools/post-execute 监听器不存在（handler() 抛）',
    (() => { try { fc.handler(); return 'found' } catch (e) { return 'thrown' } })(), 'thrown')
  eq('⑯ 反控：摘净后 agent/pre-step 监听器也不存在（preStep() 抛）',
    (() => { try { fc.preStep(); return 'found' } catch (e) { return 'thrown' } })(), 'thrown')

  // 再用第二个夹具走"框架直接调每个 on 的 disposer"这条路（幂等性 + 返回值）
  const fc2 = makeFakeCtx()
  plugin.apply(fc2.ctx, { fallbackDir: FALLBACK })
  const filesBefore = listFiles(ARCH)
  const log = fc2.dispose()
  eq('⑯ 夹具②：dispose 后监听器数 = 0', fc2.names().length, 0)
  eq('⑯ 夹具②：dispose 后 effect 数 = 0', fc2.effects.length, 0)
  eq('⑯ 夹具②：真被调用过的 disposer 有 3 条（2 个 on + 1 个 effect）', log.length, 3)
  check('⑯ 夹具②：通道 A 的 on disposer 返回 true',
    log.some(([k, v]) => k === 'on:tools/post-execute' && v === true), JSON.stringify(log))
  check('⑯ 夹具②：通道 B 的 on disposer 返回 true',
    log.some(([k, v]) => k === 'on:agent/pre-step' && v === true), JSON.stringify(log))
  check('⑯ 夹具②：effect 的 disposer 返回 true', log.some(([k, v]) => k === 'effect:report-spill.dispose-hooks' && v === true), JSON.stringify(log))
  eq('⑯ 反控：摘净后目录里没有新文件', listFiles(ARCH).length, filesBefore.length)
  console.log('[证据 ⑯] 只调 effect disposer ⇒ 监听器 ' + before.length + ' → ' + fc.names().length + '；夹具② dispose 日志 = ' + JSON.stringify(log))
}

// ────────────────────────────────────────────────────────────────────────────
// ⑤ 通道 A 端到端：长报告 ⇒ 落盘 + 换回 + **逐字节相同**
// ────────────────────────────────────────────────────────────────────────────
let SPILLED_FILE = ''
let SPILLED_TEXT = ''
{
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK })
  const n = 12000
  const text = mkReport(n, 'e2e-long')
  const exec = makeExec({ callId: 'call-long-1' })
  const result = acceptResult(text)
  const decision = { kind: 'accept', content: [{ type: 'text', text: text }] }
  const out = await run(fc, exec, result, decision)
  check('⑤ 返回的 decision 是新对象（换过了）', out !== decision)
  eq('⑤ kind 仍是 accept', out.kind, 'accept')
  eq('⑤ content 恰好 1 块 text', out.content.length === 1 && out.content[0].type, 'text')
  const files = listFiles(ARCH).filter((f) => f.endsWith('.md'))
  eq('⑤ 落盘恰好 1 个文件', files.length, 1)
  SPILLED_FILE = path.join(ARCH, files[0])
  check('⑤ 文件名形状 `YYYY-MM-DD_HHMMSS__报告__subagent.md`',
    /^\d{4}-\d{2}-\d{2}_\d{6}__报告__subagent(-\d+)?\.md$/.test(files[0]), files[0])
  const fileText = fs.readFileSync(SPILLED_FILE, 'utf8')
  const body = I.extractBody(fileText)
  check('⑤ extractBody 拿得到正文（分隔线在）', body !== null)
  eq('⑤ **落盘正文 === 原始结果文本**（逐字节，=== 比较）', body === text, true)
  eq('⑤ 落盘正文 sha256 === 原文 sha256', sha256(body), sha256(text))
  check('⑤ 文件头部记的 sha256 与实测相同',
    fileText.includes('- 正文 sha256: ' + sha256(text)), '实测=' + sha256(text))
  eq('⑤ 头部记的字节数 = 原文 UTF-8 字节数', fileText.includes('- 正文字节: ' + Buffer.byteLength(text, 'utf8')), true)
  check('⑤ 正文口径写在头部里（码点）', fileText.includes('码点计数'))
  check('⑤ 头部记了通道 = tools/post-execute', fileText.includes('- 通道: tools/post-execute'), '')
  // 换回去的内容
  SPILLED_TEXT = out.content[0].text
  check('⑤ 换回的内容以通知行开头', SPILLED_TEXT.startsWith('[完整报告 12000 字符已落盘（原文逐字节在盘上）：'), JSON.stringify(SPILLED_TEXT.slice(0, 30)))
  check('⑤ 通知行里是**绝对路径**，且指向刚落的那个文件', SPILLED_TEXT.includes(SPILLED_FILE), SPILLED_FILE)
  check('⑤ 含头 1200 字符（原文前 1200 码点）', SPILLED_TEXT.includes(text.slice(0, 1200)))
  check('⑤ 含尾 600 字符（原文后 600 码点）', SPILLED_TEXT.includes(text.slice(text.length - 600)))
  check('⑤ 含省略标记 `…（中间省略 10200 字符）…`', SPILLED_TEXT.includes('…（中间省略 10200 字符）…'))
  check('⑤ 换回的内容比原文短得多', I.cpLength(SPILLED_TEXT) < 2500, I.cpLength(SPILLED_TEXT))
  console.log('[证据 ⑤] 原文 12000 字符 → 落盘 ' + files[0] + '（' + Buffer.byteLength(fileText, 'utf8') + ' 字节）→ 换回 ' + I.cpLength(SPILLED_TEXT) + ' 字符')
  console.log('[证据 ⑤] sha256(原文) = ' + sha256(text))
  console.log('[证据 ⑤] sha256(落盘正文) = ' + sha256(body))
  console.log('[证据 ⑤] 省下 ' + (12000 - I.cpLength(SPILLED_TEXT)) + ' 字符（约 ' + Math.round((1 - I.cpLength(SPILLED_TEXT) / 12000) * 100) + '%）')

  // ⑤b emoji 报告：口径是码点，且正文同样逐字节
  const emo = '😀'.repeat(8000)
  const exec2 = makeExec({ callId: 'call-emoji' })
  const out2 = await run(fc, exec2, acceptResult(emo), { kind: 'accept', content: [{ type: 'text', text: emo }] })
  const files2 = listFiles(ARCH).filter((f) => f.endsWith('.md'))
  eq('⑤b emoji 报告也落盘（第二份）', files2.length, 2)
  const emoFile = path.join(ARCH, files2.filter((f) => f !== files[0])[0])
  const emoBody = I.extractBody(fs.readFileSync(emoFile, 'utf8'))
  eq('⑤b emoji 报告落盘正文逐字节相同', emoBody === emo, true)
  eq('⑤b emoji 报告 sha256 相同', sha256(emoBody), sha256(emo))
  check('⑤b 通知行的 N 是**码点** 8000（不是 UTF-16 的 16000）',
    out2.content[0].text.startsWith('[完整报告 8000 字符已落盘'), JSON.stringify(out2.content[0].text.slice(0, 24)))
  console.log('[证据 ⑤b] emoji 8000 码点（UTF-16 16000）⇒ 通知行写 8000；正文 sha 相同')
}

// ────────────────────────────────────────────────────────────────────────────
// ⑥ 短报告 ⇒ 原样返回**同一个** decision 对象 + 零 IO
// ────────────────────────────────────────────────────────────────────────────
{
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK })
  const text = mkReport(3999, 'short')
  const decision = { kind: 'accept', content: [{ type: 'text', text: text }] }
  const filesBefore = listFiles(ARCH)
  spyStart()
  const out = await run(fc, makeExec({ callId: 'call-short' }), acceptResult(text), decision)
  const counts = spyStop()
  eq('⑥ 短报告（3999 < 4000）⇒ 返回的就是**同一个对象**', out === decision, true)
  eq('⑥ 短报告 ⇒ content 一字未动', out.content[0].text === text, true)
  eq('⑥ 短报告 ⇒ fs 调用 0 次', spyTotal(counts), 0)
  eq('⑥ 短报告 ⇒ 目录里没多文件', listFiles(ARCH).length, filesBefore.length)
  console.log('[证据 ⑥] 3999 字符：原样放行，fs 计数 = ' + JSON.stringify(counts))
}

// ────────────────────────────────────────────────────────────────────────────
// ⑦ 非目标工具 ⇒ 原样同一个对象 **且 fs 0 次**（spy，带正控）
// ────────────────────────────────────────────────────────────────────────────
{
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK })
  for (const toolName of ['read', 'pwsh', 'write', 'web_search', 'todo_write']) {
    const text = mkReport(40000, 'non-subagent-' + toolName)   // 很长，但工具名不是目标工具
    const decision = { kind: 'accept', content: [{ type: 'text', text: text }] }
    spyStart()
    const out = await run(fc, makeExec({ name: toolName, callId: 'call-' + toolName }), acceptResult(text), decision)
    const counts = spyStop()
    eq('⑦ ' + toolName + ' ⇒ 原样同一个对象', out === decision, true)
    eq('⑦ ' + toolName + ' ⇒ fs 调用 0 次（哪怕结果 40000 字符）', spyTotal(counts), 0)
  }
  // ★ 正控：同一个 spy 在**目标工具**长报告上必须数到 >0 —— 否则上面的 0 是假绿
  const big = mkReport(20000, 'spy-positive')
  spyStart()
  await run(fc, makeExec({ callId: 'call-spy-pos' }), acceptResult(big), { kind: 'accept', content: [{ type: 'text', text: big }] })
  const pos = spyStop()
  check('⑦ **正控**：目标工具长报告走同一条路 ⇒ spy 数到 >0 次（证明 0 不是假绿）',
    spyTotal(pos) > 0, JSON.stringify(pos))
  console.log('[证据 ⑦] 非目标工具 5 个 × 40000 字符 ⇒ fs 全 0；正控（subagent 20000 字符）⇒ ' + JSON.stringify(pos))
}

// ────────────────────────────────────────────────────────────────────────────
// ⑧ 嵌套调用（exec.parent 存在）⇒ 不动 + 零 IO
// ────────────────────────────────────────────────────────────────────────────
{
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK })
  const text = mkReport(20000, 'nested')
  const decision = { kind: 'accept', content: [{ type: 'text', text: text }] }
  spyStart()
  const out = await run(fc, makeExec({ parent: 'tok-42', callId: 'call-nested' }), acceptResult(text), decision)
  const counts = spyStop()
  eq('⑧ exec.parent 存在 ⇒ 原样同一个对象', out === decision, true)
  eq('⑧ exec.parent 存在 ⇒ fs 调用 0 次', spyTotal(counts), 0)
  console.log('[证据 ⑧] parent="tok-42" + subagent + 20000 字符 ⇒ 不动，fs = ' + JSON.stringify(counts))
}

// ────────────────────────────────────────────────────────────────────────────
// ⑨ isError 结果 ⇒ 不动
// ────────────────────────────────────────────────────────────────────────────
{
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK })
  const text = mkReport(20000, 'iserror')
  const result = { isError: true, content: [{ type: 'text', text: text }] }
  const decision = { kind: 'accept', content: [{ type: 'text', text: text }] }
  spyStart()
  const out = await run(fc, makeExec({ callId: 'call-err' }), result, decision)
  const counts = spyStop()
  eq('⑨ isError ⇒ 原样同一个对象', out === decision, true)
  eq('⑨ isError ⇒ fs 调用 0 次', spyTotal(counts), 0)
  console.log('[证据 ⑨] isError=true + 20000 字符 ⇒ 不动，fs = ' + JSON.stringify(counts))
}

// ────────────────────────────────────────────────────────────────────────────
// ⑩ additionalContexts 被原样转发
// ────────────────────────────────────────────────────────────────────────────
{
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK })
  const text = mkReport(9000, 'ctx-forward')
  const ctxs = [{ type: 'user', content: '内层挂的上下文' }]
  const decision = { kind: 'accept', content: [{ type: 'text', text: text }], additionalContexts: ctxs }
  const out = await run(fc, makeExec({ callId: 'call-ctx' }), acceptResult(text), decision)
  check('⑩ 换过的 decision 带上了 additionalContexts', Array.isArray(out.additionalContexts), JSON.stringify(out))
  eq('⑩ additionalContexts 是**同一个数组**（原样转发，不是复制/过滤）', out.additionalContexts === ctxs, true)
  eq('⑩ 长度 1', out.additionalContexts.length, 1)
  // 负控：原来没有 additionalContexts ⇒ 不许凭空造一个空的
  const d2 = { kind: 'accept', content: [{ type: 'text', text: text }] }
  const out2 = await run(fc, makeExec({ callId: 'call-ctx-2' }), acceptResult(text), d2)
  eq('⑩ 负控：原来没有 ⇒ 结果里也没有这个键', Object.prototype.hasOwnProperty.call(out2, 'additionalContexts'), false)
  console.log('[证据 ⑩] additionalContexts 同一性 = ' + (out.additionalContexts === ctxs) + '；负控无键 = ' + !Object.prototype.hasOwnProperty.call(out2, 'additionalContexts'))
}

// ────────────────────────────────────────────────────────────────────────────
// ⑪ 非 text 块 / block / value ⇒ 不动（走**端到端**这条，不是只测纯函数）
// ────────────────────────────────────────────────────────────────────────────
{
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK })
  const text = mkReport(20000, 'mixed')
  const mixed = { kind: 'accept', content: [{ type: 'text', text: text }, { type: 'image', data: 'zz' }] }
  spyStart()
  const outA = await run(fc, makeExec({ callId: 'call-mixed' }), { isError: false, content: mixed.content }, mixed)
  const cA = spyStop()
  eq('⑪ 混非 text 块 ⇒ 原样同一个对象', outA === mixed, true)
  eq('⑪ 混非 text 块 ⇒ fs 0 次', spyTotal(cA), 0)

  const blk = { kind: 'block', feedback: [{ type: 'text', text: '不行' }] }
  spyStart()
  const outB = await run(fc, makeExec({ callId: 'call-block' }), acceptResult(text), blk)
  const cB = spyStop()
  eq('⑪ kind=block ⇒ 原样同一个对象', outB === blk, true)
  eq('⑪ kind=block ⇒ fs 0 次', spyTotal(cB), 0)

  const val = { kind: 'accept', value: { ok: 1 } }
  spyStart()
  const outC = await run(fc, makeExec({ callId: 'call-value' }), acceptResult(text), val)
  const cC = spyStop()
  eq('⑪ 带 value 的 decision ⇒ 原样同一个对象', outC === val, true)
  eq('⑪ 带 value 的 decision ⇒ fs 0 次', spyTotal(cC), 0)
  console.log('[证据 ⑪] 混块/block/value 三条：全部原样，fs 全 0')
}

// ────────────────────────────────────────────────────────────────────────────
// ⑫ 落盘失败 ⇒ fail-open（把 `角色发言` 做成一个**文件**，mkdir 必炸）
// ────────────────────────────────────────────────────────────────────────────
{
  const BROKEN = path.join(LAB, 'broken')
  fs.mkdirSync(path.join(BROKEN, '.git'), { recursive: true })
  fs.writeFileSync(path.join(BROKEN, I.DIR_NAME), '我是一个文件，不是目录', 'utf8')
  const fb = path.join(LAB, '__fallback-broken__')
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: fb })
  const text = mkReport(20000, 'broken')
  const decision = { kind: 'accept', content: [{ type: 'text', text: text }] }
  let threw = null
  let out = null
  try {
    out = await run(fc, makeExec({ session: makeSession('s-broken', BROKEN), callId: 'call-broken' }), acceptResult(text), decision)
  } catch (e) { threw = e }
  check('⑫ 落盘失败**没有抛**（绝不让工具调用失败）', threw === null, threw && String(threw.message))
  eq('⑫ 落盘失败 ⇒ 原样返回同一个 decision 对象', out === decision, true)
  eq('⑫ 落盘失败 ⇒ content 一字未动', out && out.content[0].text === text, true)
  const ledger = path.join(fb, I.FAIL_NAME)
  check('⑫ 失败台账存在', fs.existsSync(ledger), ledger)
  const rows = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []
  check('⑫ 台账里有 spill-write-failed 一行', rows.some((r) => r.reason === 'spill-write-failed'), JSON.stringify(rows.map((r) => r.reason)))
  check('⑫ 台账那一行带原样错误信息', rows.some((r) => r.reason === 'spill-write-failed' && typeof r.detail === 'string' && r.detail.length > 0), JSON.stringify(rows))
  check('⑫ ctx.logger.warn 也记了一行', fc.logs.warn.some((m) => m.includes('spill-write-failed')), JSON.stringify(fc.logs.warn))
  check('⑫ 失败台账**不在**工程里（不在 <工程根> 下）', !ledger.startsWith(BROKEN), ledger)
  console.log('[证据 ⑫] 角色发言 是文件 ⇒ ' + JSON.stringify(rows.map((r) => r.reason)) + '；decision 同一性 = ' + (out === decision))
  console.log('[证据 ⑫] 台账路径 = ' + ledger + '（在 tmpdir，不在工程里）')
}

// ────────────────────────────────────────────────────────────────────────────
// ⑬ 工程根推不出 ⇒ fail-open + 记一行（existsSync 桩；带正控）
// ────────────────────────────────────────────────────────────────────────────
{
  const fb = path.join(LAB, '__fallback-noroot__')
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: fb })
  const text = mkReport(20000, 'noroot')
  const decision = { kind: 'accept', content: [{ type: 'text', text: text }] }

  // 正控：不装桩时，NOROOT 的祖先链上如果真没有 .git/.warden ⇒ found 就是 null；
  // 如果环境里恰好有 ⇒ 我们如实打印出来，并改用桩来制造判据。
  const realProbe = I.findProjectRootVia(NOROOT)
  console.log('[证据 ⑬] 真环境探针 NOROOT ⇒ ' + JSON.stringify(realProbe))

  const realExists = fs.existsSync
  fs.existsSync = function (p) {
    const b = path.basename(String(p))
    if (b === '.git' || b === '.warden') return false      // 桩：这棵树没有任何工程标记
    return realExists.apply(fs, arguments)
  }
  let out = null
  let threw = null
  try {
    out = await run(fc, makeExec({ session: makeSession('s-noroot', NOROOT), callId: 'call-noroot' }), acceptResult(text), decision)
  } catch (e) { threw = e } finally {
    fs.existsSync = realExists
  }
  check('⑬ 工程根推不出 ⇒ 没有抛', threw === null, threw && String(threw.message))
  eq('⑬ 工程根推不出 ⇒ 原样返回同一个 decision 对象', out === decision, true)
  const ledger = path.join(fb, I.FAIL_NAME)
  const rows = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []
  check('⑬ 台账里有 project-root-not-found 一行', rows.some((r) => r.reason === 'project-root-not-found'), JSON.stringify(rows.map((r) => r.reason)))
  check('⑬ 那一行说清了 via / start', rows.some((r) => r.reason === 'project-root-not-found' && r.via === 'self' && r.start === NOROOT), JSON.stringify(rows))
  check('⑬ 桩生效的证据：探针在桩下 found=null', (() => {
    const e2 = fs.existsSync
    fs.existsSync = function (p) { const b = path.basename(String(p)); if (b === '.git' || b === '.warden') return false; return realExists.apply(fs, arguments) }
    const r = I.findProjectRootVia(NOROOT)
    fs.existsSync = e2
    return r.found === null
  })(), JSON.stringify(rows.map((r) => r.via)))
  console.log('[证据 ⑬] 桩下 project-root-not-found 行 = ' + JSON.stringify(rows.find((r) => r.reason === 'project-root-not-found')))
}

// ────────────────────────────────────────────────────────────────────────────
// ⑭ 撞名不覆盖（同一秒、同一工具、两份不同报告 ⇒ 第二份落 -2）
// ────────────────────────────────────────────────────────────────────────────
{
  const COLL = path.join(LAB, 'coll')
  fs.mkdirSync(path.join(COLL, '.git'), { recursive: true })
  const arch = path.join(COLL, I.DIR_NAME)
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK })
  const realNow = Date.now
  const FIXED_AT = 1790000000000
  Date.now = () => FIXED_AT                                  // 钉死时间 ⇒ 文件名必撞
  try {
    const base = I.formatStamp(FIXED_AT) + '__' + I.FILE_TAG + '__subagent.md'
    const second = base.replace(/\.md$/, '-2.md')
    const t1 = mkReport(9000, 'coll-a')
    const t2 = mkReport(9000, 'coll-b')
    const o1 = await run(fc, makeExec({ session: makeSession('s-coll', COLL), callId: 'c1' }), acceptResult(t1), { kind: 'accept', content: [{ type: 'text', text: t1 }] })
    const o2 = await run(fc, makeExec({ session: makeSession('s-coll', COLL), callId: 'c2' }), acceptResult(t2), { kind: 'accept', content: [{ type: 'text', text: t2 }] })
    const files = listFiles(arch).filter((f) => f.endsWith('.md'))
    eq('⑭ 同一秒两份报告 ⇒ 2 个文件（没互相吃掉）', files.length, 2)
    // ⚠ 不要靠 listFiles 的排序（`-` 0x2D 排在 `.` 0x2E 之前 ⇒ `-2.md` 会排在前面）；按名字点名。
    check('⑭ 第一个文件名 = ' + base, files.includes(base), JSON.stringify(files))
    check('⑭ 第二个文件名退到 -2 = ' + second, files.includes(second), JSON.stringify(files))
    const b1 = I.extractBody(fs.readFileSync(path.join(arch, base), 'utf8'))
    const b2 = I.extractBody(fs.readFileSync(path.join(arch, second), 'utf8'))
    eq('⑭ 第一份正文 = t1（逐字节）', b1 === t1, true)
    eq('⑭ 第二份正文 = t2（逐字节）', b2 === t2, true)
    check('⑭ 两个替换串各自指向自己的文件',
      o1.content[0].text.includes(path.join(arch, base)) && o2.content[0].text.includes(path.join(arch, second)),
      JSON.stringify([o1.content[0].text.slice(0, 110), o2.content[0].text.slice(0, 110)]))
    console.log('[证据 ⑭] ' + JSON.stringify(files) + '；两份正文各自逐字节相同')
  } finally {
    Date.now = realNow
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ⑮ 同一个 callId 被问第二遍 ⇒ 复用，不写第二个文件
// ────────────────────────────────────────────────────────────────────────────
{
  const REP = path.join(LAB, 'replay')
  fs.mkdirSync(path.join(REP, '.git'), { recursive: true })
  const arch = path.join(REP, I.DIR_NAME)
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK })
  const text = mkReport(9000, 'replay')
  const exec = makeExec({ session: makeSession('s-rep', REP), callId: 'same-call' })
  const o1 = await run(fc, exec, acceptResult(text), { kind: 'accept', content: [{ type: 'text', text: text }] })
  const n1 = listFiles(arch).filter((f) => f.endsWith('.md')).length
  spyStart()
  const o2 = await run(fc, exec, acceptResult(text), { kind: 'accept', content: [{ type: 'text', text: text }] })
  const counts = spyStop()
  const n2 = listFiles(arch).filter((f) => f.endsWith('.md')).length
  eq('⑮ 第一次落 1 个文件', n1, 1)
  eq('⑮ 第二次（同 callId 同文本）⇒ 不再落文件', n2, 1)
  eq('⑮ 第二次 ⇒ fs 调用 0 次', spyTotal(counts), 0)
  eq('⑮ 第二次换回的内容与第一次**逐字相同**', o2.content[0].text, o1.content[0].text)
  console.log('[证据 ⑮] 同 callId 第二遍：文件数 ' + n1 + '→' + n2 + '，fs = ' + JSON.stringify(counts) + '，替换串相同 = ' + (o2.content[0].text === o1.content[0].text))
}

// ────────────────────────────────────────────────────────────────────────────
// ⑰ ★ 判定性对照：阈值真的在起作用
// ────────────────────────────────────────────────────────────────────────────
{
  const T = path.join(LAB, 'threshold')
  fs.mkdirSync(path.join(T, '.git'), { recursive: true })
  const arch = path.join(T, I.DIR_NAME)
  const countMd = () => listFiles(arch).filter((f) => f.endsWith('.md')).length
  const text = mkReport(3000, 'threshold')     // 3000 字符：默认阈值（4000）下"短报告"
  const decision = () => ({ kind: 'accept', content: [{ type: 'text', text: text }] })

  // (a) 默认阈值 4000 ⇒ 不换
  const fcA = makeFakeCtx()
  plugin.apply(fcA.ctx, { fallbackDir: FALLBACK })
  const dA = decision()
  const outA = await run(fcA, makeExec({ session: makeSession('s-th', T), callId: 'th-a' }), acceptResult(text), dA)
  eq('⑰(a) 默认 4000：3000 字符的"短报告" ⇒ 原样不动', outA === dA, true)
  eq('⑰(a) 默认 4000：落盘文件数 0', countMd(), 0)

  // (b) 副本：把源码里 `const DEFAULT_MAX_CHARS = 4000` 改成 1（真的改一份副本文件）
  const CPY = path.join(LAB, 'copy-threshold1')
  fs.mkdirSync(CPY, { recursive: true })
  const src = fs.readFileSync(path.join(path.dirname(process.argv[1]), 'report-spill.js'), 'utf8')
  check('⑰(b) 副本前：源码里确实是 `const DEFAULT_MAX_CHARS = 4000`', src.includes('const DEFAULT_MAX_CHARS = 4000'), '')
  const patched = src.replace('const DEFAULT_MAX_CHARS = 4000', 'const DEFAULT_MAX_CHARS = 1')
  check('⑰(b) 副本改动了 1 处', patched !== src && patched.includes('const DEFAULT_MAX_CHARS = 1'), '')
  const cpyPath = path.join(CPY, 'report-spill-copy.js')
  fs.writeFileSync(cpyPath, patched, 'utf8')
  const cpy = require(cpyPath)
  eq('⑰(b) 副本常量确实是 1', cpy._internals.DEFAULT_MAX_CHARS, 1)
  const fcB = makeFakeCtx()
  cpy.apply(fcB.ctx, { fallbackDir: FALLBACK })
  const dB = decision()
  const outB = await run(fcB, makeExec({ session: makeSession('s-th', T), callId: 'th-b' }), acceptResult(text), dB)
  check('⑰(b) **副本阈值=1 ⇒ 同一份 3000 字符报告被换了**（阈值真的在起作用）', outB !== dB, 'out===decision? ' + (outB === dB))
  eq('⑰(b) 副本落盘 1 个文件', countMd(), 1)
  check('⑰(b) 副本换回的串里有通知行', outB.content && outB.content[0] && outB.content[0].text.startsWith('[完整报告 3000 字符已落盘'), JSON.stringify(outB.content && outB.content[0] && outB.content[0].text.slice(0, 30)))
  const bodyB = I.extractBody(fs.readFileSync(path.join(arch, listFiles(arch).filter((f) => f.endsWith('.md'))[0]), 'utf8'))
  eq('⑰(b) 副本落盘正文仍逐字节相同', bodyB === text, true)

  // (c) 调回去（用原插件、默认配置）⇒ 不再换
  const fcC = makeFakeCtx()
  plugin.apply(fcC.ctx, { fallbackDir: FALLBACK })
  const dC = decision()
  const outC = await run(fcC, makeExec({ session: makeSession('s-th', T), callId: 'th-c' }), acceptResult(text), dC)
  eq('⑰(c) 调回默认 4000 ⇒ 不再换（原样同一个对象）', outC === dC, true)
  eq('⑰(c) 落盘文件数仍是 1（没有新增）', countMd(), 1)

  // (d) config.maxChars = 1（同一条判据的第二种口径）
  const fcD = makeFakeCtx()
  plugin.apply(fcD.ctx, { maxChars: 1, fallbackDir: FALLBACK })
  const dD = decision()
  const outD = await run(fcD, makeExec({ session: makeSession('s-th', T), callId: 'th-d' }), acceptResult(text), dD)
  check('⑰(d) config.maxChars=1 ⇒ 被换', outD !== dD, 'out===decision? ' + (outD === dD))

  // (e) 环境变量 DSH_REPORT_SPILL_MAX_CHARS=1
  const savedEnv = process.env[I.ENV_MAX_CHARS]
  process.env[I.ENV_MAX_CHARS] = '1'
  try {
    const fcE = makeFakeCtx()
    plugin.apply(fcE.ctx, { fallbackDir: FALLBACK })
    const dE = decision()
    const outE = await run(fcE, makeExec({ session: makeSession('s-th', T), callId: 'th-e' }), acceptResult(text), dE)
    check('⑰(e) env ' + I.ENV_MAX_CHARS + '=1 ⇒ 被换（环境变量真的读到了）', outE !== dE, 'out===decision? ' + (outE === dE))
  } finally {
    if (savedEnv === undefined) delete process.env[I.ENV_MAX_CHARS]
    else process.env[I.ENV_MAX_CHARS] = savedEnv
  }

  // (f) env = 0 ⇒ 关（**0 必须是"关"**，否则 n>0 会把每一份结果都换掉）
  const savedEnv2 = process.env[I.ENV_MAX_CHARS]
  process.env[I.ENV_MAX_CHARS] = '0'
  try {
    const r = I.resolveMaxChars({}, process.env)
    eq('⑰(f) env=0 ⇒ 解析成 off', r.off, true)
    const fcF = makeFakeCtx()
    plugin.apply(fcF.ctx, { fallbackDir: FALLBACK })
    const dF = decision()
    const outF = await run(fcF, makeExec({ session: makeSession('s-th', T), callId: 'th-f' }), acceptResult(text), dF)
    eq('⑰(f) env=0 ⇒ 关掉了，原样不动', outF === dF, true)
  } finally {
    if (savedEnv2 === undefined) delete process.env[I.ENV_MAX_CHARS]
    else process.env[I.ENV_MAX_CHARS] = savedEnv2
  }

  // (g) DSH_REPORT_SPILL_OFF=1 ⇒ 关
  const savedOff = process.env[I.ENV_OFF]
  process.env[I.ENV_OFF] = '1'
  try {
    const r = I.resolveMaxChars({}, process.env)
    eq('⑰(g) ' + I.ENV_OFF + '=1 ⇒ off', r.off, true)
  } finally {
    if (savedOff === undefined) delete process.env[I.ENV_OFF]
    else process.env[I.ENV_OFF] = savedOff
  }

  // (h) 优先级：config > env > default
  const savedEnv3 = process.env[I.ENV_MAX_CHARS]
  process.env[I.ENV_MAX_CHARS] = '12345'
  try {
    eq('⑰(h) config 优先于 env', I.resolveMaxChars({ maxChars: 7 }, process.env).maxChars, 7)
    eq('⑰(h) 无 config 时用 env', I.resolveMaxChars({}, process.env).maxChars, 12345)
    delete process.env[I.ENV_MAX_CHARS]
    eq('⑰(h) 都没有 ⇒ 默认 4000', I.resolveMaxChars({}, process.env).maxChars, 4000)
    eq('⑰(h) 默认来源标成 default', I.resolveMaxChars({}, process.env).source, 'default')
  } finally {
    if (savedEnv3 === undefined) delete process.env[I.ENV_MAX_CHARS]
    else process.env[I.ENV_MAX_CHARS] = savedEnv3
  }
  console.log('[证据 ⑰] 3000 字符同一份报告：默认4000=不换 / 副本常量1=换 / 调回=不换 / config1=换 / env1=换 / env0=关 / OFF=关')
}

// ────────────────────────────────────────────────────────────────────────────
// ⑱ findProjectRootVia 与 role-voices.js 的**对拍**
// ────────────────────────────────────────────────────────────────────────────
{
  const theirs = roleVoices._internals && roleVoices._internals.findProjectRootVia
  check('⑱ role-voices 暴露了 findProjectRootVia（对拍对象存在）', typeof theirs === 'function', typeof theirs)
  if (typeof theirs === 'function') {
    const cases = [PROJ, PROJ2, path.join(PROJ, I.DIR_NAME), path.join(PROJ, '.git'), NOROOT, LAB, '<WORKSPACE>', '<WORKSPACE>\\task-warden']
    let same = 0
    for (const c of cases) {
      const a = I.findProjectRootVia(c)
      const b = theirs(c)
      const ok = a.root === b.root && a.via === b.via && a.found === b.found
      if (ok) same++
      else check('⑱ 对拍不一致 @ ' + c, false, 'mine=' + JSON.stringify(a) + ' theirs=' + JSON.stringify(b))
      console.log('[证据 ⑱] ' + c + ' ⇒ ' + JSON.stringify(a) + '  对拍=' + (ok ? '同' : '**异**'))
    }
    eq('⑱ 全部夹具上与 role-voices 逐字段相同（两份实现没漂）', same, cases.length)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ⑲ 性能：非目标工具 < 5 µs/次、0 次 fs（5 个读数 + 中位）
// ────────────────────────────────────────────────────────────────────────────
{
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK })
  const rec = fc.handler()
  const small = mkReport(120, 'perf-small')
  const huge = mkReport(400000, 'perf-huge')
  const execSmall = makeExec({ name: 'read', callId: 'p1' })
  const execHuge = makeExec({ name: 'read', callId: 'p2' })
  const rSmall = acceptResult(small)
  const rHuge = acceptResult(huge)
  const acc = { kind: 'accept' }
  const next = () => Promise.resolve(acc)

  const ITER = 2000
  const ROUNDS = 5
  async function bench(exec, result) {
    for (let i = 0; i < 300; i++) await rec.fn(exec, result, next)   // 预热
    const out = []
    for (let r = 0; r < ROUNDS; r++) {
      const t0 = performance.now()
      for (let i = 0; i < ITER; i++) await rec.fn(exec, result, next)
      out.push((performance.now() - t0) * 1000 / ITER)
    }
    return out
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }

  spyStart()
  const uSmall = await bench(execSmall, rSmall)
  const cSmall = spyStop()
  spyStart()
  const uHuge = await bench(execHuge, rHuge)
  const cHuge = spyStop()

  // 纯 decide() 的代价（不含 promise 机制）
  const t1 = performance.now()
  for (let i = 0; i < 200000; i++) I.decide(execHuge, rHuge, acc, 4000)
  const uDecide = (performance.now() - t1) * 1000 / 200000

  console.log('[证据 ⑲] 非目标工具（read）· 结果 120 字符 · 5 次读数(µs/次) = ' + JSON.stringify(uSmall.map((x) => +x.toFixed(3))) + ' 中位 = ' + med(uSmall).toFixed(3))
  console.log('[证据 ⑲] 非目标工具（read）· 结果 400000 字符 · 5 次读数(µs/次) = ' + JSON.stringify(uHuge.map((x) => +x.toFixed(3))) + ' 中位 = ' + med(uHuge).toFixed(3))
  console.log('[证据 ⑲] fs 计数：120 字符 = ' + JSON.stringify(cSmall) + '；400000 字符 = ' + JSON.stringify(cHuge))
  console.log('[证据 ⑲] 纯 decide() 单次 = ' + uDecide.toFixed(4) + ' µs（200000 次平均）')
  check('⑲ 非目标工具 120 字符 ⇒ 中位 < 5 µs', med(uSmall) < 5, med(uSmall).toFixed(3))
  check('⑲ 非目标工具 400000 字符 ⇒ 中位 < 5 µs', med(uHuge) < 5, med(uHuge).toFixed(3))
  eq('⑲ 非目标工具 120 字符 ⇒ fs 调用 0 次（' + ITER * ROUNDS + ' 次调用）', spyTotal(cSmall), 0)
  eq('⑲ 非目标工具 400000 字符 ⇒ fs 调用 0 次（' + ITER * ROUNDS + ' 次调用）', spyTotal(cHuge), 0)
  check('⑲ 结果长度 120 → 400000 之间没有量级变化（证明根本没扫正文）',
    Math.abs(med(uHuge) - med(uSmall)) < 3, med(uSmall).toFixed(3) + ' vs ' + med(uHuge).toFixed(3))
  check('⑲ 纯 decide() < 1 µs', uDecide < 1, uDecide.toFixed(4))

  // ⑲b 通道 B 对**非通知**消息也必须零 IO（它每个 agent 每一步都会被叫一次）
  const pre = fc.preStep()
  const preNext = () => Promise.resolve({ kind: 'enter', messages: [{ content: [{ type: 'text', text: 'x'.repeat(400000) }], source: { kind: 'user' } }] })
  for (let i = 0; i < 300; i++) await pre.fn({ agent: makeAgent('a', makeSession('s-perf', PROJ)) }, preNext)
  spyStart()
  const t2 = performance.now()
  for (let i = 0; i < 2000 * 5; i++) await pre.fn({ agent: makeAgent('a', makeSession('s-perf', PROJ)) }, preNext)
  const uPre = (performance.now() - t2) * 1000 / (2000 * 5)
  const cPre = spyStop()
  console.log('[证据 ⑲b] 通道 B 对非通知消息（400000 字符的 user 消息）· 单次 = ' + uPre.toFixed(3) + ' µs · fs = ' + JSON.stringify(cPre))
  eq('⑲b 通道 B 非通知消息 ⇒ fs 调用 0 次', spyTotal(cPre), 0)
  check('⑲b 通道 B 非通知消息 ⇒ 单次 < 5 µs', uPre < 5, uPre.toFixed(3))
}

// ────────────────────────────────────────────────────────────────────────────
// ⑳ ★★ **通道 B 端到端**（本单的核心）：结算通知 ⇒ 落盘 + 换回 + 逐字节相同
// ────────────────────────────────────────────────────────────────────────────
{
  const NB = path.join(LAB, 'notice')
  fs.mkdirSync(path.join(NB, '.git'), { recursive: true })
  const arch = path.join(NB, I.DIR_NAME)
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK })
  const agent = makeAgent('agent-parent', makeSession('s-parent', NB))
  const childId = 'session-1111-2222-3333-444455556666'

  // ⑳(a) 长报告 + 夹一个 reasoning 块（实测 323 份真通知里 154 份是这个形状）
  const report = mkReport(12000, 'notice-e2e')
  const reasoning = 'R'.repeat(500)
  const notice = makeNotice(report, { childId: childId, reasoning: reasoning })
  const messages = [{ content: [{ type: 'text', text: '人的话' }], source: { kind: 'user' } }, notice]
  const decision = { kind: 'enter', messages: messages }
  const out = await runPreStep(fc, agent, messages, decision)

  check('⑳(a) 返回的 decision 是新对象（换过了）', out !== decision, '')
  eq('⑳(a) kind 仍是 enter', out.kind, 'enter')
  check('⑳(a) messages 是新数组', out.messages !== messages, '')
  eq('⑳(a) messages 长度不变（2 条）', out.messages.length, 2)
  eq('⑳(a) 第 0 条（人的话）**同一个对象**，一字未动', out.messages[0] === messages[0], true)
  check('⑳(a) 第 1 条是新对象', out.messages[1] !== notice, '')
  const nc = out.messages[1].content
  eq('⑳(a) source **原样保留**（还是 subagent-settled）', out.messages[1].source === notice.source, true)
  eq('⑳(a) summary 块（块 0）是**同一个对象**、一字未动', nc[0] === notice.content[0], true)
  eq('⑳(a) marker 块（块 1）是**同一个对象**、一字未动', nc[1] === notice.content[1], true)
  eq('⑳(a) reasoning 块是**同一个对象**、一字未动（不丢信息）', nc[2] === notice.content[2], true)
  eq('⑳(a) 内容块数不变（4 块）', nc.length, 4)
  eq('⑳(a) 块 3 是新的 text 块', nc[3].type, 'text')
  const repl = nc[3].text
  check('⑳(a) 换回的串以通知行开头', repl.startsWith('[完整报告 12000 字符已落盘（原文逐字节在盘上）：'), JSON.stringify(repl.slice(0, 30)))
  check('⑳(a) 含头 1200 字符', repl.includes(report.slice(0, 1200)))
  check('⑳(a) 含尾 600 字符', repl.includes(report.slice(report.length - 600)))
  check('⑳(a) 含省略标记 `…（中间省略 10200 字符）…`', repl.includes('…（中间省略 10200 字符）…'))
  check('⑳(a) 换回后整条消息比原来短得多', I.cpLength(JSON.stringify(nc)) < 3000, I.cpLength(JSON.stringify(nc)))

  const files = listFiles(arch).filter((f) => f.endsWith('.md'))
  eq('⑳(a) 落盘恰好 1 个文件', files.length, 1)
  check('⑳(a) 文件名形状 `YYYY-MM-DD_HHMMSS__报告__<子代理短 id>.md`',
    /^\d{4}-\d{2}-\d{2}_\d{6}__报告__[0-9a-zA-Z]+(-\d+)?\.md$/.test(files[0]), files[0])
  eq('⑳(a) 短 id = 55556666', I.shortId(childId), '55556666')
  const fileText = fs.readFileSync(path.join(arch, files[0]), 'utf8')
  const body = I.extractBody(fileText)
  eq('⑳(a) **落盘正文 === 子代理那份报告**（逐字节，=== 比较）', body === report, true)
  eq('⑳(a) 落盘正文 sha256 === 报告 sha256', sha256(body), sha256(report))
  check('⑳(a) 头部记的 sha256 与实测相同', fileText.includes('- 正文 sha256: ' + sha256(report)), '')
  check('⑳(a) 头部记了通道 = agent/pre-step', fileText.includes('- 通道: agent/pre-step'), '')
  check('⑳(a) 头部记了子代理会话 id', fileText.includes('- 子代理会话: ' + childId), '')
  check('⑳(a) 头部记了内容块构成（含 reasoning×1）', fileText.includes('reasoning×1'), '')
  check('⑳(a) 通知行里是**绝对路径**且指向刚落那个文件', repl.includes(path.join(arch, files[0])), '')
  console.log('[证据 ⑳(a)] 通知正文 12000 字符 → 落盘 ' + files[0] + '（' + Buffer.byteLength(fileText, 'utf8') + ' 字节）→ 换回 ' + I.cpLength(repl) + ' 字符')
  console.log('[证据 ⑳(a)] sha256(报告) = ' + sha256(report))
  console.log('[证据 ⑳(a)] sha256(落盘正文) = ' + sha256(body))
  console.log('[证据 ⑳(a)] 块构成 = ' + JSON.stringify(nc.map((b) => b.type)) + '（summary/marker/reasoning 三块是同一个对象引用）')

  // ⑳(b) 短通知 ⇒ 原样返回**同一个** decision 对象 + 零 IO
  const shortNotice = makeNotice(mkReport(3000, 'notice-short'), { childId: childId })
  const shortMsgs = [shortNotice]
  const shortDecision = { kind: 'enter', messages: shortMsgs }
  const nBefore = listFiles(arch).length
  spyStart()
  const outShort = await runPreStep(fc, agent, shortMsgs, shortDecision)
  const cShort = spyStop()
  eq('⑳(b) 3000 < 4000 ⇒ 原样同一个 decision 对象', outShort === shortDecision, true)
  eq('⑳(b) 短通知 ⇒ fs 调用 0 次', spyTotal(cShort), 0)
  eq('⑳(b) 短通知 ⇒ 目录没多文件', listFiles(arch).length, nBefore)

  // ⑳(c) 没有收尾话（`It left no closing message.`）⇒ 不动、**静默**（不记失败）
  const noneNotice = makeNotice(undefined, { childId: childId, noOutput: true })
  const noneMsgs = [noneNotice]
  const noneDecision = { kind: 'enter', messages: noneMsgs }
  const fb = path.join(LAB, '__fallback-notice__')
  const fc2 = makeFakeCtx()
  plugin.apply(fc2.ctx, { fallbackDir: fb })
  const outNone = await runPreStep(fc2, agent, noneMsgs, noneDecision)
  eq('⑳(c) 没留收尾话 ⇒ 原样同一个 decision 对象', outNone === noneDecision, true)
  const ledgerPath = path.join(fb, I.FAIL_NAME)
  const rowsNone = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []
  check('⑳(c) 没留收尾话 ⇒ **不记失败**（正常情况，不是失败）',
    !rowsNone.some((r) => r.reason === 'notice-no-closing-message'), JSON.stringify(rowsNone.map((r) => r.reason)))
  eq('⑳(c) noticeReport 直接判 silent', I.noticeReport(noneNotice.content).silent, true)

  // ⑳(d) marker 文案不认识 ⇒ 不动 + 记一行 `notice-unknown-marker`（绝不猜）
  const weird = makeNotice(report, { childId: childId })
  weird.content[1] = { type: 'text', text: 'Its final words were:' }
  const weirdMsgs = [weird]
  const weirdDecision = { kind: 'enter', messages: weirdMsgs }
  spyStart()
  const outWeird = await runPreStep(fc2, agent, weirdMsgs, weirdDecision)
  const cWeird = spyStop()
  eq('⑳(d) 认不出的 marker ⇒ 原样同一个 decision 对象', outWeird === weirdDecision, true)
  // ⚠ 这里**不能**要求 fs 0 次：记那一行失败本身就是 IO（mkdir + appendFileSync，
  //   而 Node 的 appendFileSync 内部会走 fs.writeFileSync —— 实测过，见 DESIGN）。
  //   要证明的是"**没有落盘报告**" ⇒ 归档目录里一个文件都没多。
  eq('⑳(d) 认不出的 marker ⇒ 归档目录里没多出报告文件', listFiles(arch).filter((f) => f.endsWith('.md')).length, files.length)
  const rowsWeird = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []
  check('⑳(d) 认不出的 marker ⇒ 台账里有一行 notice-unknown-marker',
    rowsWeird.some((r) => r.reason === 'notice-unknown-marker'), JSON.stringify(rowsWeird.map((r) => r.reason)))
  check('⑳(d) 那一行带原样文案', rowsWeird.some((r) => r.reason === 'notice-unknown-marker' && String(r.detail).includes('Its final words were:')), JSON.stringify(rowsWeird))

  // ⑳(e) decision.kind 不是 enter ⇒ 原样不动
  const rej = { kind: 'reject' }
  eq('⑳(e) kind=reject ⇒ 原样同一个对象', await runPreStep(fc2, agent, [notice], rej) === rej, true)

  // ⑳(f) 纯通知形状（无 reasoning）：text,text,text
  const plainNotice = makeNotice(mkReport(9000, 'notice-plain'), { childId: childId })
  const plainMsgs = [plainNotice]
  const outPlain = await runPreStep(fc2, agent, plainMsgs, { kind: 'enter', messages: plainMsgs })
  eq('⑳(f) 无 reasoning 的通知 ⇒ 块数仍是 3', outPlain.messages[0].content.length, 3)
  check('⑳(f) 无 reasoning 的通知 ⇒ 第 2 块被换成替换串',
    outPlain.messages[0].content[2].text.startsWith('[完整报告 9000 字符已落盘'), '')
  // ⚠ 不能靠"目录里最后一个" —— 同一秒落两份时 `-2.md` 会排在 `.md` 前面。
  //   路径直接从**换回的那串**里取（它就是权威的那一份）。
  const plainPath = /：(.+?)\]/.exec(outPlain.messages[0].content[2].text)[1]
  const plainBody = I.extractBody(fs.readFileSync(plainPath, 'utf8'))
  eq('⑳(f) 无 reasoning 的通知正文逐字节相同', plainBody === mkReport(9000, 'notice-plain'), true)
  eq('⑳(f) 落盘文件就落在本夹具的归档目录里', path.dirname(plainPath), path.join(NB, I.DIR_NAME))

  // ⑳(g) 非通知消息（人的话 / plugin / agent-message）⇒ 不动 + 零 IO
  const otherMsgs = [
    { content: [{ type: 'text', text: mkReport(50000, 'human') }], source: { kind: 'user' } },
    { content: [{ type: 'text', text: mkReport(50000, 'plugin') }], source: { kind: 'plugin', plugin: 'x' } },
    { content: [{ type: 'text', text: mkReport(50000, 'agentmsg') }], source: { kind: 'agent-message' } },
  ]
  const otherDecision = { kind: 'enter', messages: otherMsgs }
  spyStart()
  const outOther = await runPreStep(fc2, agent, otherMsgs, otherDecision)
  const cOther = spyStop()
  eq('⑳(g) 非通知消息 ⇒ 原样同一个 decision 对象', outOther === otherDecision, true)
  eq('⑳(g) 非通知消息 ⇒ fs 调用 0 次（哪怕 3×50000 字符）', spyTotal(cOther), 0)
  console.log('[证据 ⑳] 短通知=不动 / 无收尾话=静默 / 认不出 marker=不动+记账 / reject=不动 / 非通知=不动，fs 全 0')
}

// ────────────────────────────────────────────────────────────────────────────
// ㉑ ★ `角色发言\` 有界：轮转只删本插件自己的报告文件
// ────────────────────────────────────────────────────────────────────────────
{
  const PR = path.join(LAB, 'prune')
  fs.mkdirSync(path.join(PR, '.git'), { recursive: true })
  const arch = path.join(PR, I.DIR_NAME)
  const fc = makeFakeCtx()
  plugin.apply(fc.ctx, { fallbackDir: FALLBACK, keepReports: 2 })
  const agent = makeAgent('agent-prune', makeSession('s-prune', PR))
  const realNow = Date.now
  let T0 = 1790000000000
  /** 用通道 B 落一份报告（时间可控）。 */
  async function spillAt(ms, seed, n) {
    Date.now = () => ms
    const notice = makeNotice(mkReport(n, seed), { childId: 'session-9999-8888-7777-666655554444' })
    const msgs = [notice]
    await runPreStep(fc, agent, msgs, { kind: 'enter', messages: msgs })
  }
  try {
    // 先放三份"别人的东西"——轮转**一个都不许碰**
    fs.mkdirSync(arch, { recursive: true })
    fs.writeFileSync(path.join(arch, 'INDEX.md'), '# 角色发言 · INDEX\n', 'utf8')
    fs.writeFileSync(path.join(arch, 'README.md'), '# 这是什么\n', 'utf8')
    fs.writeFileSync(path.join(arch, '2026-09-24_015d0842_你是「方向员」.md'), '手工存量', 'utf8')
    fs.mkdirSync(path.join(arch, '2026-09-24'), { recursive: true })
    fs.writeFileSync(path.join(arch, '2026-09-24', '2026-09-24_015d0842_手工子目录.md'), '子目录里的', 'utf8')
    // 名字里带"报告"但形状不对的（不该被认成我们的文件）
    fs.writeFileSync(path.join(arch, '别人写的__报告__说明.md'), '不是我们的', 'utf8')

    const others = ['INDEX.md', 'README.md', '2026-09-24_015d0842_你是「方向员」.md', '别人写的__报告__说明.md']

    for (let i = 0; i < 5; i++) await spillAt(T0 + i * 1000, 'prune-' + i, 9000)
    const files = listFiles(arch).filter((f) => f.endsWith('.md') && !f.includes('/'))
    const mine = files.filter((f) => I.REPORT_FILE_RE.test(f))
    eq('㉑ keepReports=2 ⇒ 只剩 2 份本插件的报告', mine.length, 2)
    eq('㉑ 留下的正是最新那两份', JSON.stringify(mine.slice().sort()), JSON.stringify([I.formatStamp(T0 + 3000) + '__报告__55554444.md', I.formatStamp(T0 + 4000) + '__报告__55554444.md'].sort()))
    for (const o of others) {
      check('㉑ **不许碰** ' + o, fs.existsSync(path.join(arch, o)), '不见了！')
    }
    check('㉑ **不许碰**子目录 2026-09-24/', fs.existsSync(path.join(arch, '2026-09-24', '2026-09-24_015d0842_手工子目录.md')), '子目录被动过')
    eq('㉑ listReportFiles 只认我们的名字（2 个）', I.listReportFiles(arch).length, 2)
    console.log('[证据 ㉑] 写了 5 份报告（keep=2）⇒ 目录里 = ' + JSON.stringify(listFiles(arch).filter((f) => !f.includes('/')).sort()))
    console.log('[证据 ㉑] 本插件自己的报告 = ' + JSON.stringify(I.listReportFiles(arch)))

    // ㉑b protect：刚写下去的那一份**永不删**（构造"它排在最前"的场景）
    const PR2 = path.join(LAB, 'prune-protect')
    fs.mkdirSync(path.join(PR2, '.git'), { recursive: true })
    const arch2 = path.join(PR2, I.DIR_NAME)
    fs.mkdirSync(arch2, { recursive: true })
    // 预置两份"更旧"的 + 一份**同秒但排更前**的名字（`-2.md` 字典序在 `.md` 之前）
    const SAME = 1790000000000
    const base = I.formatStamp(SAME) + '__报告__55554444'
    fs.writeFileSync(path.join(arch2, base + '.md'), 'old-1', 'utf8')
    const fcP = makeFakeCtx()
    plugin.apply(fcP.ctx, { fallbackDir: FALLBACK, keepReports: 1 })
    const agentP = makeAgent('agent-protect', makeSession('s-protect', PR2))
    Date.now = () => SAME
    const noticeP = makeNotice(mkReport(9000, 'protect'), { childId: 'session-9999-8888-7777-666655554444' })
    const msgsP = [noticeP]
    const outP = await runPreStep(fcP, agentP, msgsP, { kind: 'enter', messages: msgsP })
    check('㉑b 同秒撞名 ⇒ 新文件落在 -2', fs.existsSync(path.join(arch2, base + '-2.md')), JSON.stringify(I.listReportFiles(arch2)))
    check('㉑b 刚写下去的那一份**没被轮转删掉**（protect 生效）', fs.existsSync(path.join(arch2, base + '-2.md')), '')
    check('㉑b 替换串指向的正是那个文件', outP.messages[0].content[2].text.includes(path.join(arch2, base + '-2.md')), '')
    eq('㉑b keep=1 ⇒ 只剩 1 份', I.listReportFiles(arch2).length, 1)

    // ㉑c keepReports=0 ⇒ 关掉轮转（**不是"删光"**）
    const PR3 = path.join(LAB, 'prune-off')
    fs.mkdirSync(path.join(PR3, '.git'), { recursive: true })
    const arch3 = path.join(PR3, I.DIR_NAME)
    const fcOff = makeFakeCtx()
    plugin.apply(fcOff.ctx, { fallbackDir: FALLBACK, keepReports: 0 })
    const agentOff = makeAgent('agent-off', makeSession('s-off', PR3))
    for (let i = 0; i < 4; i++) {
      Date.now = () => T0 + i * 1000
      const nt = makeNotice(mkReport(9000, 'off-' + i), { childId: 'session-9999-8888-7777-666655554444' })
      const ms = [nt]
      await runPreStep(fcOff, agentOff, ms, { kind: 'enter', messages: ms })
    }
    eq('㉑c keepReports=0 ⇒ 4 份都留着（关掉轮转，不是删光）', I.listReportFiles(arch3).length, 4)
    eq('㉑c resolveKeepReports({keepReports:0}) ⇒ keep=0 且标 off', I.resolveKeepReports({ keepReports: 0 }, {}).keep, 0)
    eq('㉑c resolveKeepReports({}) ⇒ 默认 200', I.resolveKeepReports({}, {}).keep, 200)
    eq('㉑c 默认值常量 = 200', I.DEFAULT_KEEP_REPORTS, 200)
    eq('㉑c 来源标成 default', I.resolveKeepReports({}, {}).source, 'default')

    // ㉑d pruneReports 的纯函数面：keep<=0 / 目录不存在
    eq('㉑d pruneReports(dir, 0) ⇒ keep-disabled，不删', I.pruneReports(arch3, 0).reason, 'keep-disabled')
    eq('㉑d pruneReports(不存在的目录, 5) ⇒ dir-unreadable', I.pruneReports(path.join(LAB, 'no-such-dir'), 5).reason, 'dir-unreadable')
    eq('㉑d listReportFiles(不存在的目录) ⇒ null', I.listReportFiles(path.join(LAB, 'no-such-dir')), null)
    console.log('[证据 ㉑] 别人的东西 4 样 + 子目录全部健在；protect 生效；keep=0 关掉')
  } finally {
    Date.now = realNow
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ㉒ 工具名单与**真 preset 文件**对拍（`roles/agent.cordis.yml` 里所有 `toolName:`）
// ────────────────────────────────────────────────────────────────────────────
{
  const presetPath = '<HOME>\\.dsh\\.agent-presets\\roles\\agent.cordis.yml'
  if (!fs.existsSync(presetPath)) {
    console.log('[证据 ㉒] 读不到 ' + presetPath + ' ⇒ 跳过对拍（**不是**通过；见 DESIGN §3.3）')
    check('㉒ preset 文件不在 ⇒ 如实标注为"没对拍"（不许说"都对上了"）', true, 'skipped')
  } else {
    const yml = fs.readFileSync(presetPath, 'utf8')
    const names = []
    for (const line of yml.split(/\r?\n/)) {
      const m = /^\s*toolName:\s*(\S+)\s*$/.exec(line)
      if (m) names.push(m[1])
    }
    console.log('[证据 ㉒] ' + presetPath + ' 里所有 toolName = ' + JSON.stringify(names))
    check('㉒ 至少核到 5 个 toolName（文件形状没变）', names.length >= 5, String(names.length))
    for (const n of names) {
      check('㉒ 真 preset 的 toolName `' + n + '` 在本插件名单里', I.SPILL_TOOLS.includes(n), JSON.stringify(I.SPILL_TOOLS))
    }
    for (const n of ['subagent_liaison', 'subagent_direction', 'subagent_coder']) {
      check('㉒ ★审查点名的 ' + n + ' 真在 preset 里（对拍有意义）', names.includes(n), JSON.stringify(names))
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 汇总
// ────────────────────────────────────────────────────────────────────────────
uninstallFsSpy()
let pass = 0
let fail = 0
console.log('')
for (const r of results) {
  if (r.ok) { pass++; console.log('  PASS  ' + r.name) }
  else { fail++; console.log('  FAIL  ' + r.name + (r.detail ? '   ← ' + r.detail : '')) }
}
console.log('\n合计：' + results.length + ' 条断言，PASS ' + pass + '，FAIL ' + fail)
console.log('夹具根：' + LAB)
console.log('落盘目录夹具（端到端演示用）：' + ARCH + ' / ' + ARCH2)
console.log('DSH_HOME 镜像：' + process.env.DSH_HOME)
if (!KEEP) {
  fs.rmSync(LAB, { recursive: true, force: true })
} else {
  console.log('（--keep：夹具保留，可直接 Get-ChildItem -Recurse 看）')
}
process.exit(fail === 0 ? 0 : 1)
