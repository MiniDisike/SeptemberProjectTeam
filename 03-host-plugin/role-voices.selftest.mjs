#!/usr/bin/env node
/*
 * role-voices.selftest.mjs —— `role-voices.js` 的自检。**用 exit code 报结果**：
 *   0 = 全过（所有断言都成立）
 *   1 = 有红（至少一条断言不成立，逐条打印是哪条）
 *
 * 为什么要有它、为什么长这样：
 *   R42 的病根是「主代理是唯一信息通道」—— 角色说了什么，用户只能看到转述，或者干脆看不到。
 *   本插件要做的是**把原话本身落盘**。所以自检的重点不是"跑起来了"，
 *   而是几条**能被机器复核的性质**：
 *     · 逐字性：写进去的正文与模型输出**逐字节相同**（sha256 相同）；
 *     · 主会话不归档（`origin` 缺失的 agent 必须被忽略）；
 *     · **只吃子代理自己的事件**（⑭）：fork 子代理前面是被继承的父会话前缀，
 *       前缀里主代理那条 `assistant/message` **不许**被当成"角色发言"归档；
 *       负控（子代理自己零发言）+ 正控（子代理自己有发言 ⇒ 归档的是它自己那条）成对。
 *     · 去重（同一 agent 同一条消息触发两次 ⇒ 只归档一次）；
 *     · **不进上下文**（把插件挂到假 ctx 上，列出它注册过的全部东西，证明没有上下文注册）；
 *     · 可逆（dispose 之后监听器全部摘掉，贴出摘掉前后的列表）；
 *       ⚠ ⑦ 这条断言**以前是假绿**：旧夹具的 `dispose()` 无条件清空 listeners/effects，
 *       于是"插件什么都不摘"也会 PASS。夹具已改成**只调注册时交回来的 disposer**，
 *       并加了 ⑦b 反控（旧实现会把"没交回 disposer"的旁路记录也清掉 ⇒ 假绿现形）。
 *     · **索引段序**（⑮）：统一索引两段同表头时，插件的"末尾追加"必须落在**最后一段**里；
 *     · 失败如实（工程根推不出 / 没有 text 块 / 下界拿不到 时**都不静默吞**）；
 *     · 正控：没有任何子代理 ⇒ **一个文件都不建**。
 *
 * ⚠ 夹具一律造在 `%TEMP%\role-voices-lab`，**不碰真账本**（`<WORKSPACE>\.warden`）与真工程。
 *
 * 用法：
 *   node role-voices.selftest.mjs           跑完全套，结束后删掉夹具
 *   node role-voices.selftest.mjs --keep    跑完**保留**夹具（用于端到端演示：Get-ChildItem -Recurse）
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('./role-voices.js')
const I = plugin._internals

const KEEP = process.argv.includes('--keep')
const LAB = path.join(os.tmpdir(), 'role-voices-lab')
const FALLBACK = path.join(LAB, '__fallback__')

// ────────────────────────────────────────────────────────────────────────────
// 极简断言框架（不引依赖；每条都打印，红的一条也不藏）
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
// 假 ctx：把插件**真正 apply 一遍**，并记录它碰过的每一样东西
// ────────────────────────────────────────────────────────────────────────────
function makeFakeCtx() {
  const listeners = []
  const effects = []
  const touches = []
  const calls = []
  const disposeLog = []
  const target = {
    on(name, fn) {
      calls.push({ m: 'on', args: [String(name)] })
      const rec = { name: String(name), fn }
      /**
       * 真 Cordis 里 `ctx.on` 返回的**就是**挂在当前 fiber 上的那个 effect 的 disposer：
       * `cordis\lib\index.js:335-345` 的 `register()` 做的是
       * `this.ctx.fiber.effect(() => { hooks.push(...); return () => this.unregister(...) }, label)`。
       * ⇒ 这里必须把它**记在记录上**，`dispose()` 只调它，绝不自己顺手 splice。
       */
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
        return rec.dispose()
      }
      return rec.detach
    },
    get(name) {
      calls.push({ m: 'get', args: [String(name)] })
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
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
    ctx,
    listeners,
    effects,
    touches,
    calls,
    disposeLog,
    names: () => listeners.map((l) => l.name),
    emit(name, payload) {
      // 照 DSH 的 emit/serial 语义：listener 只收 payload，**没有 next**
      for (const l of listeners.slice()) if (l.name === name) l.fn(payload)
    },
    /**
     * ★ 模拟 fiber 卸载：**只调"注册时交回来的那些 disposer"**（逆序），
     *   **绝不**自己顺手 `listeners.length = 0` / `effects.length = 0`。
     *
     * 为什么必须这样（R42 返工 F4/F5）：旧夹具在这里无条件清空两个数组，于是
     *   `eq('⑦ dispose 后监听器全摘掉', after.length, 0)` 与
     *   `eq('⑦ dispose 后 effects 也空了', ctxA.effects.length, 0)`
     *   **即使插件什么都不注册、什么都不摘，也会 PASS** —— 那是两条假绿，证明不了可逆性。
     * ⚠ 改的是**夹具**，不是断言：⑦ 那两条断言一个字都没有放宽。
     *   自检 7b 有反控，证明新夹具抓得住"登记了却没交回 disposer"的旁路注册。
     *
     * @returns {Array<[string, boolean]>} 真正被调用过的 disposer 及其返回值。
     */
    dispose() {
      disposeLog.length = 0
      for (const rec of listeners.slice().reverse()) {
        if (typeof rec.dispose === 'function') disposeLog.push(['on:' + rec.name, rec.dispose()])
      }
      for (const rec of effects.slice().reverse()) {
        if (typeof rec.detach === 'function') disposeLog.push(['effect:' + rec.label, rec.detach()])
      }
      return disposeLog
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 假 agent / 假 session
// ────────────────────────────────────────────────────────────────────────────
const T0 = Date.UTC(2026, 8, 24, 11, 3, 11) // 固定时间，文件名才可复现

function makeSession(id, cwd, events, opts) {
  const o = opts || {}
  const header = {
    version: 3,
    id,
    createdAt: T0 - 60000,
    cwd,
    isSeeded: false,
    ...(o.origin === undefined ? {} : { origin: o.origin }),
    ...(o.delegationDepth === undefined ? {} : { delegationDepth: o.delegationDepth }),
    ...(o.agentPreset === undefined ? {} : { agentPreset: o.agentPreset }),
  }
  return {
    header,
    seq: events.length,
    inheritedEventCount: o.inheritedEventCount || 0,
    eventAt(i) { return events[i] },
  }
}

function makeAgent(id, session, sink) {
  const use = (m) => { sink.push(m); throw new Error('本插件不该调用 agent.' + m) }
  return {
    id,
    session,
    status: 'idle',
    // 这三个是"消息通道"。它们**故意抛**：真被调用的话，插件自己的 catch 会把它
    // 记成一条 archive-threw 失败 —— 于是"偷用了消息通道"这件事会在失败台账里现形。
    steer() { return use('steer') },
    send() { return use('send') },
    followup() { return use('followup') },
    cancel() { return use('cancel') },
  }
}

/** 造一个子代理会话的事件流：user/message → subagent/descriptor → assistant/message… */
function subagentEvents(label, messageText, extraBlocks) {
  const content = []
  if (messageText !== null) content.push({ type: 'text', text: messageText })
  for (const b of extraBlocks || []) content.push(b)
  const evs = [
    { type: 'user/message', seq: 0, time: T0 - 5000, data: { role: 'user', content: [{ type: 'text', text: '干活' }] } },
    { type: 'subagent/descriptor', seq: 1, time: T0 - 4000, data: { version: 3, mode: 'one-shot', provider: 'in-process', label } },
    { type: 'assistant/message', seq: 2, time: T0 - 3000, data: { turn: 1, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '中途的草稿，不该被选' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
    { type: 'step/end', seq: 3, time: T0 - 2500, data: { turn: 1, step: 1 } },
  ]
  if (content.length > 0 || messageText === '') {
    evs.push({ type: 'assistant/message', seq: 4, time: T0, data: { turn: 1, step: 2, message: { id: 'm2', role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } } } })
  }
  evs.push({ type: 'step/end', seq: evs.length, time: T0 + 1, data: { turn: 1, step: 2 } })
  return evs
}

// ────────────────────────────────────────────────────────────────────────────
// 开跑
// ────────────────────────────────────────────────────────────────────────────
if (fs.existsSync(LAB)) fs.rmSync(LAB, { recursive: true, force: true })
fs.mkdirSync(LAB, { recursive: true })
fs.mkdirSync(FALLBACK, { recursive: true })

// 夹具 A：真工程（有 .git），子代理在**子目录**里跑 ⇒ 工程根要往上找
const PROJ = path.join(LAB, 'proj')
const DEEP = path.join(PROJ, 'src', 'deep')
fs.mkdirSync(DEEP, { recursive: true })
fs.mkdirSync(path.join(PROJ, '.git'), { recursive: true })
const ARCHIVE = path.join(PROJ, I.DIR_NAME)

const failuresPath = () => path.join(FALLBACK, I.FAIL_NAME)
const readFailures = () => {
  if (!fs.existsSync(failuresPath())) return []
  return fs.readFileSync(failuresPath(), 'utf8').split(/\r?\n/).filter((s) => s.trim() !== '').map((s) => JSON.parse(s))
}

// ── 1. 正控：假 subagent 结束 ⇒ 归档真的发生，文件名/内容符合约定 ──────────────
const MSG = [
  '# 结论',
  '',
  '这段是**逐字**的原文：空格 与\t制表符 都要原样保留。',
  '尾随空格在这里 → ',
  '最后一行没有换行',
].join('\n')

const ctxA = makeFakeCtx()
plugin.apply(ctxA.ctx, { fallbackDir: FALLBACK })
check('① apply 之后 ctx 上多出 4 个监听器', ctxA.listeners.length === 4, 'listeners=' + JSON.stringify(ctxA.names()))
check('① 挂的正是那 4 个子代理结束事件',
  JSON.stringify(ctxA.names().slice().sort()) === JSON.stringify(I.HOOKS.map((h) => h[0]).slice().sort()),
  JSON.stringify(ctxA.names()))

const agentSink = []
const sub = makeAgent('session-ccc30000-0000-4000-8000-000000000000', makeSession(
  'session-ccc30000-0000-4000-8000-000000000000', DEEP, subagentEvents('审查', MSG),
  { origin: 'subagent', delegationDepth: 1, agentPreset: 'standard' }), agentSink)
ctxA.emit('agent/turn-stopping', { turn: 1, agent: sub })

check('① 归档目录已建出来', fs.existsSync(ARCHIVE), ARCHIVE)
const filesA = listFiles(ARCHIVE)
const mdA = filesA.filter((f) => f.endsWith('.md') && f !== I.README_NAME && f !== I.INDEX_NAME)
eq('① 正好一个归档文件', mdA.length, 1)
const fileA = mdA[0] || ''
check('① README.md 存在', filesA.includes(I.README_NAME), JSON.stringify(filesA))
check('① INDEX.md 存在', filesA.includes(I.INDEX_NAME), JSON.stringify(filesA))

// 文件名约定：YYYY-MM-DD_HHMMSS__<角色名或短id>__<短标题>.md
const nameOk = /^\d{4}-\d{2}-\d{2}_\d{6}__审查__结论\.md$/.test(path.basename(fileA))
check('① 文件名 = YYYY-MM-DD_HHMMSS__角色__短标题.md', nameOk, path.basename(fileA))

const fileTextA = fs.readFileSync(path.join(ARCHIVE, fileA), 'utf8')
check('① 头部含 时间/角色/agent id/来源',
  fileTextA.includes('- 时间: ') && fileTextA.includes('- 角色: 审查')
  && fileTextA.includes('- agent id: session-ccc30000-0000-4000-8000-000000000000')
  && fileTextA.includes('- 来源: turn-stopping'))
check('① 角色名取自 subagent/descriptor.label（不是猜的）',
  fileTextA.includes('- 角色来源: subagent/descriptor.label'), fileTextA.split('\n').find((l) => l.startsWith('- 角色来源')))
check('① 工程根 = 有 .git 的那一层（从 src\\deep 往上找）',
  fileTextA.includes('- 工程根: ' + PROJ + '（via git）'), fileTextA.split('\n').find((l) => l.startsWith('- 工程根')))
check('① 选的是**最后一条** content 非空的助手消息（不是中途草稿）',
  fileTextA.includes('@ seq 4'), fileTextA.split('\n').find((l) => l.startsWith('- 助手消息')))

// ── 2. 逐字性：正文与输入逐字节相同 ─────────────────────────────────────────
const bodyA = I.extractBody(fileTextA)
eq('② 正文 === 输入的助手消息（逐字节）', bodyA, MSG)
eq('② sha256(输入消息)', sha256(MSG), sha256(bodyA))
check('② 头部记的 sha256 与实算一致',
  fileTextA.includes('- 正文 sha256: ' + sha256(MSG)),
  fileTextA.split('\n').find((l) => l.startsWith('- 正文 sha256')))
eq('② 头部记的字节数与实算一致',
  fileTextA.includes('- 正文字节: ' + Buffer.byteLength(MSG, 'utf8')), true)
check('② 文件最后一个字节就是原话最后一个字节（没补换行）',
  fileTextA.endsWith(MSG) && !fileTextA.endsWith('\n'), JSON.stringify(fileTextA.slice(-12)))
check('② 首尾空白/制表符都没被 trim',
  bodyA.includes('\t') && bodyA.includes('→ \n'), JSON.stringify(bodyA.slice(-40)))

// ── 3. 去重：同一 agent 同一条消息触发两次（真实现场是 4 个事件都会到） ────────
ctxA.emit('agent/status', { status: 'idle', agent: sub })
ctxA.emit('agent/disposed', { agent: sub })
ctxA.emit('agent/turn-stopping', { turn: 1, agent: sub })
const mdA2 = listFiles(ARCHIVE).filter((f) => f.endsWith('.md') && f !== I.README_NAME && f !== I.INDEX_NAME)
eq('③ 同一 agent 同一条消息触发 4 次 ⇒ 仍然只有 1 个归档文件', mdA2.length, 1)
const indexRows = (dir) => fs.readFileSync(path.join(dir, I.INDEX_NAME), 'utf8')
  .split(/\r?\n/).filter((l) => l.startsWith('|') && !l.startsWith('| ---') && !l.startsWith('| 时间'))
eq('③ INDEX.md 里也只有 1 条数据行', indexRows(ARCHIVE).length, 1)

// ── 4. INDEX.md 字段 ───────────────────────────────────────────────────────
const row = indexRows(ARCHIVE)[0]
const cells = row.split('|').map((s) => s.trim())
// ['', 时间, 角色, 标题, 字节, 文件链接, '']
eq('④ INDEX 角色列', cells[2], '审查')
eq('④ INDEX 标题列', cells[3], '结论')
const realBytes = fs.statSync(path.join(ARCHIVE, fileA)).size
eq('④ INDEX 字节列 = 归档文件真实字节数', cells[4], String(realBytes))
check('④ INDEX 文件列是可点的 markdown 链接且指向那个文件',
  cells[5] === '[结论](' + I.linkSafe(path.basename(fileA)) + ')', cells[5])
check('④ INDEX 时间列 = 消息自己的时间（不是写盘时间）',
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cells[1]), cells[1])
check('④ INDEX 时间与文件名时间戳一致',
  cells[1].replace(/[-: ]/g, '') === path.basename(fileA).slice(0, 17).replace(/[-_]/g, ''), cells[1] + ' vs ' + path.basename(fileA))

// ── 5. 负控：主会话（header 没有 origin）必须被忽略 ────────────────────────
const LAB2 = path.join(LAB, 'mainonly')
fs.mkdirSync(path.join(LAB2, '.git'), { recursive: true })
const ctxB = makeFakeCtx()
plugin.apply(ctxB.ctx, { fallbackDir: FALLBACK })
const mainSession = makeSession('session-main-1111-2222-3333-444455556666', LAB2, [
  { type: 'user/message', seq: 0, time: T0, data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
  { type: 'assistant/message', seq: 1, time: T0, data: { turn: 1, step: 1, message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: '主代理说的话' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
], { /* 刻意不给 origin、不给 delegationDepth */ })
const mainAgent = makeAgent('session-main-1111-2222-3333-444455556666', mainSession, [])
ctxB.emit('agent/turn-stopping', { turn: 1, agent: mainAgent })
ctxB.emit('agent/status', { status: 'idle', agent: mainAgent })
ctxB.emit('agent/disposed', { agent: mainAgent })
check('⑤ 主会话（没有 origin）⇒ 归档目录根本没被建',
  !fs.existsSync(path.join(LAB2, I.DIR_NAME)), listFiles(LAB2).join(','))
eq('⑤ 主会话 ⇒ 一个文件都没建', listFiles(LAB2).length, 0)
eq('⑤ 主会话 ⇒ 一条失败记录都没有（它不是失败，是本来就不该管）', readFailures().length, 0)

// ── 6. 不进上下文：列出插件注册过的全部东西 ────────────────────────────────
const touched = Array.from(new Set(ctxA.touches)).sort()
console.log('\n[证据 ⑥] 插件从 ctx 上读过的成员（代理记录）：' + JSON.stringify(touched))
console.log('[证据 ⑥] 插件对 ctx 的每一次调用：' + JSON.stringify(ctxA.calls))
console.log('[证据 ⑥] 插件注册的监听器：' + JSON.stringify(ctxA.names()))
check('⑥ ctx 上只被读了 on / effect 两样，别的什么都没碰',
  JSON.stringify(touched) === JSON.stringify(['effect', 'on']), JSON.stringify(touched))
eq('⑥ 没有一次 ctx.get(服务名)', ctxA.calls.filter((c) => c.m === 'get').length, 0)
eq('⑥ 没有一次读未知成员', ctxA.calls.filter((c) => c.m === 'read-unknown').length, 0)
check('⑥ 没有任何 systemPrompt / context / prompt 相关注册',
  !ctxA.calls.some((c) => /systemprompt|runtimecontext|context|prompt|message|inject/i.test(JSON.stringify(c))),
  JSON.stringify(ctxA.calls))
eq('⑥ 没有调用过 agent 的任何消息通道（steer/send/followup/cancel）', agentSink.length, 0)
eq('⑥ 没有因为"偷用消息通道"而产生失败记录', readFailures().length, 0)

// ── 7. 可逆：dispose 之后监听器全部摘掉 ───────────────────────────────────
const before = ctxA.names()
ctxA.dispose()
const after = ctxA.names()
console.log('[证据 ⑦] dispose 前监听器：' + JSON.stringify(before))
console.log('[证据 ⑦] dispose 后监听器：' + JSON.stringify(after))
console.log('[证据 ⑦] dispose 真正调用过的 disposer：' + JSON.stringify(ctxA.disposeLog))
eq('⑦ dispose 后监听器全摘掉', after.length, 0)
check('⑦ dispose 前确实挂着 4 个（否则这条是空测）', before.length === 4, JSON.stringify(before))
eq('⑦ dispose 后 effects 也空了', ctxA.effects.length, 0)
const filesAfterDispose = listFiles(ARCHIVE).length
ctxA.emit('agent/turn-stopping', { turn: 1, agent: sub })
eq('⑦ dispose 之后再发事件 ⇒ 一个文件都不多', listFiles(ARCHIVE).length, filesAfterDispose)

// ── 7b. ★ 夹具反控：证明 ⑦ 不是假绿（旧夹具在这里会假绿） ────────────────────
// 旧夹具的 dispose() 无条件 `listeners.length = 0` / `effects.length = 0`，
// 所以"注册了却没人交回 disposer"的旁路记录也会被它清掉 —— 那条断言就没在证明任何事。
// 这里把**旧实现逐字抄一份**跑给读者看，再跑新夹具，两条一起贴。
const bypass = () => ({ name: 'agent/turn-stopping', fn: () => {}, dispose: null })
const oldDispose = (fx) => {   // ← 逐字抄 R42 返工前的假 ctx.dispose()
  for (const e of fx.effects.slice().reverse()) e.dispose()
  fx.effects.length = 0
  for (const l of fx.listeners.slice()) {
    const i = fx.listeners.indexOf(l)
    if (i >= 0) fx.listeners.splice(i, 1)
  }
}
const ctxY2 = makeFakeCtx()
ctxY2.ctx.on('agent/turn-stopping', () => {})
ctxY2.listeners.push(bypass())
eq('⑦b 夹具前提：登记了 2 条（1 条正常 + 1 条"没交回 disposer"的旁路）', ctxY2.names().length, 2)
oldDispose(ctxY2)
eq('⑦b 旧夹具（无条件清空）⇒ 旁路那条也被"清掉"了 —— 这就是假绿', ctxY2.names().length, 0)

const ctxY = makeFakeCtx()
ctxY.ctx.on('agent/turn-stopping', () => {})
ctxY.listeners.push(bypass())
eq('⑦b 新夹具前提：同样 2 条', ctxY.names().length, 2)
ctxY.dispose()
console.log('[证据 ⑦b] 新夹具 dispose 日志：' + JSON.stringify(ctxY.disposeLog))
eq('⑦b 新夹具只调交回来的 disposer ⇒ 旁路那条**留了下来**（假绿已消除）', ctxY.names().length, 1)
check('⑦b 新夹具的 dispose 日志里只有真正被调用过的那一个 disposer',
  JSON.stringify(ctxY.disposeLog) === JSON.stringify([['on:agent/turn-stopping', true]]),
  JSON.stringify(ctxY.disposeLog))

// ── 8. 失败如实：工程根推不出 ⇒ 不静默吞 ──────────────────────────────────
const NOPROJ = path.join(LAB, 'noproj', 'sub')
fs.mkdirSync(NOPROJ, { recursive: true })
const probe = I.findProjectRootVia(NOPROJ)
console.log('[证据 ⑧] 夹具 noproj 的工程根判法：' + JSON.stringify(probe))
check('⑧ 夹具前提：noproj 向上既无 .git 也无 .warden（否则这条测的不是"推不出"）',
  probe.found === null, JSON.stringify(probe))
const ctxC = makeFakeCtx()
plugin.apply(ctxC.ctx, { fallbackDir: FALLBACK })
const noProjAgent = makeAgent('session-noproj-aaaa-bbbb-cccc-ddddeeeeffff', makeSession(
  'session-noproj-aaaa-bbbb-cccc-ddddeeeeffff', NOPROJ, subagentEvents('审查', '在非工程目录里说的话'),
  { origin: 'subagent', delegationDepth: 1 }), [])
const beforeFail = readFailures().length
ctxC.emit('agent/turn-stopping', { turn: 1, agent: noProjAgent })
const fails = readFailures()
eq('⑧ 工程根推不出 ⇒ 落了一行失败记录（没静默吞）', fails.length, beforeFail + 1)
const lastFail = fails[fails.length - 1]
eq('⑧ 失败原因是 project-root-not-found', lastFail.reason, 'project-root-not-found')
check('⑧ 失败记录里有 cwd / start / via，能定位是哪一步卡的',
  typeof lastFail.start === 'string' && lastFail.via === 'self' && lastFail.agentId !== '', JSON.stringify(lastFail))
check('⑧ 非工程目录里没有凭空造出文件夹',
  !fs.existsSync(path.join(NOPROJ, I.DIR_NAME)) && !fs.existsSync(path.join(LAB, 'noproj', I.DIR_NAME)),
  listFiles(path.join(LAB, 'noproj')).join(','))

// ── 9. 失败如实：最后一条助手消息里没有 text 块 ────────────────────────────
const LAB3 = path.join(LAB, 'proj3')
fs.mkdirSync(path.join(LAB3, '.git'), { recursive: true })
const ctxD = makeFakeCtx()
plugin.apply(ctxD.ctx, { fallbackDir: FALLBACK })
const toolOnly = makeAgent('session-toolonly-1111-2222-3333-444455556666', makeSession(
  'session-toolonly-1111-2222-3333-444455556666', LAB3,
  subagentEvents('资料员', null, [{ type: 'tool-call', id: 'c1', name: 'read' }]),
  { origin: 'subagent', delegationDepth: 1 }), [])
const beforeFail9 = readFailures().length
ctxD.emit('agent/turn-stopping', { turn: 1, agent: toolOnly })
const fails9 = readFailures()
eq('⑨ 只有工具调用、没有 text ⇒ 落一行失败记录', fails9.length, beforeFail9 + 1)
eq('⑨ 失败原因是 no-text-blocks', fails9[fails9.length - 1].reason, 'no-text-blocks')
check('⑨ 失败行同时写进了用户能看到的 INDEX.md',
  fs.readFileSync(path.join(LAB3, I.DIR_NAME, I.INDEX_NAME), 'utf8').includes('⚠ 归档失败'),
  fs.readFileSync(path.join(LAB3, I.DIR_NAME, I.INDEX_NAME), 'utf8'))
eq('⑨ 没造出空的归档文件', listFiles(path.join(LAB3, I.DIR_NAME)).filter((f) => f.endsWith('.md') && !f.endsWith('README.md') && !f.endsWith('INDEX.md')).length, 0)

// ── 10. 正控：没有任何子代理 ⇒ 一个文件都不建 ──────────────────────────────
const LAB4 = path.join(LAB, 'silent')
fs.mkdirSync(path.join(LAB4, '.git'), { recursive: true })
const ctxE = makeFakeCtx()
plugin.apply(ctxE.ctx, { fallbackDir: FALLBACK })
check('⑩ 只挂上插件、不发任何事件 ⇒ 什么都没建（懒建，不在 boot 时撒野）',
  listFiles(LAB4).length === 0, listFiles(LAB4).join(','))
eq('⑩ 也没有失败记录', readFailures().length, fails9.length)

// ── 11. 同秒重名不覆盖 + 标题规则 ─────────────────────────────────────────
const ctxF = makeFakeCtx()
plugin.apply(ctxF.ctx, { fallbackDir: FALLBACK })
const twin1 = makeAgent('session-twin-1111-2222-3333-44445555666a', makeSession(
  'session-twin-1111-2222-3333-44445555666a', LAB3, subagentEvents('记录', '同样的一行标题\n正文 A'),
  { origin: 'subagent', delegationDepth: 1 }), [])
const twin2 = makeAgent('session-twin-1111-2222-3333-44445555666b', makeSession(
  'session-twin-1111-2222-3333-44445555666b', LAB3, subagentEvents('记录', '同样的一行标题\n正文 B'),
  { origin: 'subagent', delegationDepth: 1 }), [])
ctxF.emit('agent/turn-stopping', { turn: 1, agent: twin1 })
ctxF.emit('agent/turn-stopping', { turn: 1, agent: twin2 })
const twinFiles = listFiles(path.join(LAB3, I.DIR_NAME)).filter((f) => /__记录__/.test(f))
eq('⑪ 同秒同角色同标题的两条 ⇒ 两个文件（不互相覆盖）', twinFiles.length, 2)
check('⑪ 第二条退到 -2 后缀', twinFiles.some((f) => /-2\.md$/.test(f)), JSON.stringify(twinFiles))
eq('⑪ 两条正文各自正确',
  I.extractBody(fs.readFileSync(path.join(LAB3, I.DIR_NAME, twinFiles.find((f) => !/-2\.md$/.test(f))), 'utf8')), '同样的一行标题\n正文 A')
eq('⑪ -2 那条正文也正确',
  I.extractBody(fs.readFileSync(path.join(LAB3, I.DIR_NAME, twinFiles.find((f) => /-2\.md$/.test(f))), 'utf8')), '同样的一行标题\n正文 B')

const longLine = '一'.repeat(80)
eq('⑪ 标题按码点截到 40 字', Array.from(I.titleOf(longLine)).length, 40)
eq('⑪ 标题里的非法字符被去掉',
  I.titleOf('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij')
eq('⑪ 首行为空 ⇒ 退到第一条非空行', I.titleOf('\n\n真正的标题\nx'), '真正的标题')
eq('⑪ 全是空 ⇒ 无标题', I.titleOf('\n\n'), '无标题')
eq('⑪ markdown 井号不进标题', I.titleOf('## 结论\n正文'), '结论')
check('⑪ emoji 不会被劈成半个', Array.from(I.titleOf('🎯'.repeat(60))).length === 40, I.titleOf('🎯'.repeat(60)))

// ── 12. 纯函数：工程根判法照抄 warden.mjs 的三条路 ────────────────────────
const g = I.findProjectRootVia(DEEP)
eq('⑫ 有 .git ⇒ via=git', g.via, 'git')
eq('⑫ 有 .git ⇒ root 是那一层', g.root, PROJ)
const LAB5 = path.join(LAB, 'wardenonly', 'inner')
fs.mkdirSync(path.join(LAB, 'wardenonly', '.warden'), { recursive: true })
fs.mkdirSync(LAB5, { recursive: true })
const w = I.findProjectRootVia(LAB5)
eq('⑫ 没有 .git、祖先有 .warden ⇒ via=ancestor-warden', w.via, 'ancestor-warden')
eq('⑫ 没有 .git、祖先有 .warden ⇒ root 是那一层', w.root, path.join(LAB, 'wardenonly'))
const s = I.findProjectRootVia(path.join(LAB, 'wardenonly'))
eq('⑫ .warden 就在自己身上 ⇒ via=self（与 warden.mjs 一致）', s.via, 'self')
eq('⑫ 但 found=warden，能分清"找到了"和"没找到"', s.found, 'warden')

// ── 13. 已有"别人格式"的 INDEX.md ⇒ 只追加分节，不改写已有内容 ──────────────
// 真实场景：<工程根>\角色发言\ 可能已经存在，里面已经有一份手工写的 INDEX.md。
const LAB6 = path.join(LAB, 'proj6')
const ARCH6 = path.join(LAB6, I.DIR_NAME)
fs.mkdirSync(ARCH6, { recursive: true })
fs.mkdirSync(path.join(LAB6, '.git'), { recursive: true })
const HAND = '# 角色发言 · 手工存量\n\n共 2 份。\n\n- **aaaa1111** · 你是「审查」 — `x.md` （12 KB）\n'
fs.writeFileSync(path.join(ARCH6, I.INDEX_NAME), HAND, 'utf8')
const ctxG = makeFakeCtx()
plugin.apply(ctxG.ctx, { fallbackDir: FALLBACK })
const six = makeAgent('session-six-1111-2222-3333-444455556666', makeSession(
  'session-six-1111-2222-3333-444455556666', LAB6, subagentEvents('审查', '自动归档的第一条'),
  { origin: 'subagent', delegationDepth: 1 }), [])
ctxG.emit('agent/turn-stopping', { turn: 1, agent: six })
const index6 = fs.readFileSync(path.join(ARCH6, I.INDEX_NAME), 'utf8')
check('⑬ 手工 INDEX.md 原有内容一个字节都没动（仍是前缀）', index6.startsWith(HAND), JSON.stringify(index6.slice(0, 40)))
check('⑬ 追加了分节标记 + 表头', index6.includes(I.INDEX_SECTION_MARK) && index6.includes(I.INDEX_HEADER))
check('⑬ 自动归档那一行落在表里',
  /\| 2026-\d\d-\d\d \d\d:\d\d:\d\d \| 审查 \| 自动归档的第一条 \| \d+ \| \[/.test(index6), index6.slice(-240))

// 模拟重启：新 ctx、新 agent、同一个目录 ⇒ 不许重复插分节
const ctxH = makeFakeCtx()
plugin.apply(ctxH.ctx, { fallbackDir: FALLBACK })
const six2 = makeAgent('session-six2-1111-2222-3333-444455556667', makeSession(
  'session-six2-1111-2222-3333-444455556667', LAB6, subagentEvents('审查', '重启后的一条'),
  { origin: 'subagent', delegationDepth: 1 }), [])
ctxH.emit('agent/turn-stopping', { turn: 1, agent: six2 })
const index6c = fs.readFileSync(path.join(ARCH6, I.INDEX_NAME), 'utf8')
eq('⑬ 重启后再归档 ⇒ 分节标记只出现一次', index6c.split(I.INDEX_SECTION_MARK).length - 1, 1)
eq('⑬ 但新的一行确实加进去了', (index6c.match(/^\| 2026-/gm) || []).length, 2)

// ── 14. ★★ F1 判定性实验：fork 子代理只吃**自己**的事件 ────────────────────
// 官方口径（`dsh-subagent\lib\index.js:336-343`）：取最终助手消息时喂进去的是
// `child.session.snapshotEvents(boundary)`、`boundary = child.session.seq`（start 时记下）
// ⇒ **只吃子代理自己的事件**。fork 出来的子代理带 seed（`inheritedEventCount = seed.length`）。
// 本节的夹具：前 3 条是**被继承的父会话前缀**（其中 seq 1 是主代理的 assistant/message），
// 之后才是子代理自己的事件。负控 = 子代理自己零 assistant/message。
const PARENT_TEXT = '★这是主代理（父会话）说的话，不是子代理说的★'
const CHILD_TEXT = '★这是子代理自己说的★'

function forkEvents(ownText) {
  const prefix = [
    { type: 'user/message', seq: 0, time: T0 - 9000, data: { role: 'user', content: [{ type: 'text', text: '父会话里用户说的话' }] } },
    { type: 'assistant/message', seq: 1, time: T0 - 8000, data: { turn: 1, step: 1, message: { id: 'parent-m', role: 'assistant', content: [{ type: 'text', text: PARENT_TEXT }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
    { type: 'step/end', seq: 2, time: T0 - 7500, data: { turn: 1, step: 1 } },
  ]
  const own = [
    { type: 'subagent/descriptor', seq: 3, time: T0 - 7000, data: { version: 3, mode: 'fork', provider: 'fork-in-process', label: '审查' } },
  ]
  if (ownText !== null) {
    own.push({ type: 'assistant/message', seq: 4, time: T0 - 6000, data: { turn: 1, step: 1, message: { id: 'child-m', role: 'assistant', content: [{ type: 'text', text: ownText }], source: { kind: 'model', provider: 'p', model: 'm' } } } })
  }
  own.push({ type: 'step/end', seq: own.length + 3, time: T0 - 5000, data: { turn: 1, step: 1 } })
  return prefix.concat(own)
}

const LAB7 = path.join(LAB, 'fork')
fs.mkdirSync(path.join(LAB7, '.git'), { recursive: true })
const ARCH7 = path.join(LAB7, I.DIR_NAME)
const ctxI = makeFakeCtx()
plugin.apply(ctxI.ctx, { fallbackDir: FALLBACK })
const arch7 = () => listFiles(ARCH7).filter((f) => f.endsWith('.md') && f !== I.README_NAME && f !== I.INDEX_NAME)

const forkNoOwn = makeAgent('session-fork-1111-2222-3333-444455556666', makeSession(
  'session-fork-1111-2222-3333-444455556666', LAB7, forkEvents(null),
  { origin: 'subagent', delegationDepth: 1, inheritedEventCount: 3 }), [])

/** 旧口径逐字抄一份：从 total-1 一路扫到 **0**（R42 返工前 `lastAssistantMessage` 就是这么写的）。 */
function oldNaiveScan(session) {
  for (let i = Number(session.seq) - 1; i >= 0; i--) {
    const ev = session.eventAt(i)
    if (!ev || ev.type !== 'assistant/message') continue
    const c = ev.data && ev.data.message && ev.data.message.content
    if (Array.isArray(c) && c.length > 0) {
      return { seq: i, text: c.filter((b) => b.type === 'text').map((b) => b.text).join('') }
    }
  }
  return null
}

const s7 = forkNoOwn.session
const naiveHit = oldNaiveScan(s7)
const fixedHit = I.lastAssistantMessage(s7)
console.log('\n[证据 ⑭] 夹具：seq=' + s7.seq + '  inheritedEventCount=' + s7.inheritedEventCount
  + '  前缀 = seq 0..2（seq 1 是主代理的 assistant/message），子代理自己 = seq 3..' + (s7.seq - 1))
console.log('[证据 ⑭] 旧口径（从 total-1 扫到 0）命中：' + JSON.stringify(naiveHit))
console.log('[证据 ⑭] 新口径（下界 = inheritedEventCount = 3）命中：' + JSON.stringify(fixedHit))
console.log('[证据 ⑭] 新口径算出的下界：' + JSON.stringify(I.ownEventRange(s7)))
check('⑭ 夹具是判定性的：旧口径确实会命中主代理那条', !!naiveHit && naiveHit.text === PARENT_TEXT, JSON.stringify(naiveHit))
check('⑭ 新口径在子代理自己那段里扫不到任何 assistant/message', fixedHit === null, JSON.stringify(fixedHit))

// ★ 机械证明（不靠"看代码"）：把 eventAt 装上探针，看插件**到底读了哪些 seq**。
// 下界以下（0..2）一个都不许读 —— 那是被继承的父会话前缀。
const readSeqs = []
const spy = {
  header: s7.header,
  seq: s7.seq,
  inheritedEventCount: s7.inheritedEventCount,
  eventAt(i) { readSeqs.push(i); return s7.eventAt(i) },
}
I.lastAssistantMessage(spy)
const readByLast = readSeqs.slice()
readSeqs.length = 0
I.subagentLabel(spy)
const readByLabel = readSeqs.slice()
console.log('[证据 ⑭] lastAssistantMessage 读过的 seq：' + JSON.stringify(readByLast))
console.log('[证据 ⑭] subagentLabel 读过的 seq：' + JSON.stringify(readByLabel))
check('⑭ 机械证明：lastAssistantMessage 一个"下界以下"的 seq 都没读',
  readByLast.length > 0 && readByLast.every((i) => i >= s7.inheritedEventCount), JSON.stringify(readByLast))
check('⑭ 机械证明：subagentLabel 一个"下界以下"的 seq 都没读',
  readByLabel.length > 0 && readByLabel.every((i) => i >= s7.inheritedEventCount), JSON.stringify(readByLabel))

const beforeFail14 = readFailures().length
ctxI.emit('agent/turn-stopping', { turn: 1, agent: forkNoOwn })
const fails14 = readFailures()
console.log('[证据 ⑭ 负控] 归档文件数: ' + arch7().length
  + '   归档正文: ' + JSON.stringify(arch7().length === 0 ? '(没有归档文件)' : I.extractBody(fs.readFileSync(path.join(ARCH7, arch7()[0]), 'utf8'))))
console.log('[证据 ⑭ 负控] 新增失败记录: ' + (fails14.length - beforeFail14) + '  ' + JSON.stringify(fails14[fails14.length - 1]))
eq('⑭ 负控：fork 子代理自己零发言 ⇒ **一个归档文件都不建**', arch7().length, 0)
eq('⑭ 负控：如实记了一行失败（没静默吞）', fails14.length, beforeFail14 + 1)
eq('⑭ 负控：失败原因 = no-assistant-message（"子代理自己没有发言"）', fails14[fails14.length - 1].reason, 'no-assistant-message')
check('⑭ 负控：主代理那句话**没有**出现在该目录的任何文件里（含 INDEX.md）',
  !listFiles(ARCH7).some((f) => fs.readFileSync(path.join(ARCH7, f), 'utf8').includes(PARENT_TEXT)),
  JSON.stringify(listFiles(ARCH7)))

// 正控：同一份 fork 形状，但子代理自己有**一条** assistant/message ⇒ 归档的必须是它自己那条
const forkWithOwn = makeAgent('session-fork2-1111-2222-3333-44445555666a', makeSession(
  'session-fork2-1111-2222-3333-44445555666a', LAB7, forkEvents(CHILD_TEXT),
  { origin: 'subagent', delegationDepth: 1, inheritedEventCount: 3 }), [])
ctxI.emit('agent/turn-stopping', { turn: 1, agent: forkWithOwn })
const files14b = arch7()
console.log('[证据 ⑭ 正控] 归档文件: ' + JSON.stringify(files14b))
eq('⑭ 正控：子代理自己有发言 ⇒ 正好 1 个归档文件', files14b.length, 1)
const text14b = files14b.length ? fs.readFileSync(path.join(ARCH7, files14b[0]), 'utf8') : ''
const body14b = I.extractBody(text14b)
console.log('[证据 ⑭ 正控] 归档正文原样: ' + JSON.stringify(body14b))
console.log('[证据 ⑭ 正控] 正文 === 子代理自己那句话 ? ' + (body14b === CHILD_TEXT))
console.log('[证据 ⑭ 正控] 正文 === 主代理那句话 ? ' + (body14b === PARENT_TEXT))
console.log('[证据 ⑭ 正控] 头部：' + JSON.stringify(text14b.split('\n').filter((l) => l.startsWith('- 子代理自己的事件') || l.startsWith('- 助手消息'))))
eq('⑭ 正控：归档的正文就是**子代理自己**那条', body14b, CHILD_TEXT)
check('⑭ 正控：正文**不是**主代理那条', body14b !== PARENT_TEXT, JSON.stringify(body14b))
check('⑭ 正控：取的是子代理自己的 seq 4（不是父前缀里的 seq 1）',
  text14b.includes('- 助手消息: assistant/message @ seq 4'), text14b.split('\n').find((l) => l.startsWith('- 助手消息')))
check('⑭ 正控：头部如实写出"子代理自己的事件"区间 seq 3..5（inheritedEventCount=3）',
  text14b.includes('- 子代理自己的事件: seq 3..5（inheritedEventCount=3'), text14b.split('\n').find((l) => l.startsWith('- 子代理自己的事件')))
check('⑭ 正控：角色名仍取自子代理自己的 descriptor（seq 3），不是父前缀',
  text14b.includes('- 角色: 审查') && text14b.includes('- 角色来源: subagent/descriptor.label'))

// ⑭c：下界**拿不到** ⇒ 拒收 + 记一行失败（绝不退回 0 —— 那正是这条洞）
const LAB7c = path.join(LAB, 'fork-nobound')
fs.mkdirSync(path.join(LAB7c, '.git'), { recursive: true })
const ARCH7c = path.join(LAB7c, I.DIR_NAME)
const ctxI2 = makeFakeCtx()
plugin.apply(ctxI2.ctx, { fallbackDir: FALLBACK })
const ev7c = forkEvents(null)
const sess7c = makeSession('session-nobound-1111-2222-3333-4444555566ff', LAB7c, ev7c,
  { origin: 'subagent', delegationDepth: 1, inheritedEventCount: 3 })
delete sess7c.inheritedEventCount            // ← 模拟"这个会话样对象上拿不到下界"
const noBound = makeAgent('session-nobound-1111-2222-3333-4444555566ff', sess7c, [])
console.log('[证据 ⑭c] 下界拿不到时 ownEventRange = ' + JSON.stringify(I.ownEventRange(sess7c)))
const beforeFail14c = readFailures().length
ctxI2.emit('agent/turn-stopping', { turn: 1, agent: noBound })
const fails14c = readFailures()
console.log('[证据 ⑭c] 归档文件数: ' + listFiles(ARCH7c).filter((f) => f.endsWith('.md') && f !== I.README_NAME && f !== I.INDEX_NAME).length
  + '   失败记录: ' + JSON.stringify(fails14c[fails14c.length - 1]))
eq('⑭c 下界拿不到 ⇒ ownEventRange 明确报 own-bound-unknown', I.ownEventRange(sess7c).reason, 'own-bound-unknown')
eq('⑭c 下界拿不到 ⇒ **不归档**', listFiles(ARCH7c).filter((f) => f.endsWith('.md') && f !== I.README_NAME && f !== I.INDEX_NAME).length, 0)
eq('⑭c 下界拿不到 ⇒ 如实记一行失败（没退回 0 去扫父前缀）', fails14c.length, beforeFail14c + 1)
eq('⑭c 失败原因 = own-bound-unknown', fails14c[fails14c.length - 1].reason, 'own-bound-unknown')
check('⑭c 主代理那句话同样没出现在该目录任何文件里',
  !listFiles(ARCH7c).some((f) => fs.readFileSync(path.join(ARCH7c, f), 'utf8').includes(PARENT_TEXT)),
  JSON.stringify(listFiles(ARCH7c)))

// ── 15. ★ F3：统一索引两段同表头时，"末尾追加"必须落在**最后一段**里 ─────────
// 夹具形状照抄对调后的真 INDEX.md：手工表在前、自动表在最后，两段用同一个表头。
// 插件发现已有表头分隔线 ⇒ 什么都不插，只 `fs.appendFileSync` 到文件末尾；
// 所以**只要自动段是最后一段**，新行就落在自动段的表里。
const LAB8 = path.join(LAB, 'index-last')
fs.mkdirSync(path.join(LAB8, '.git'), { recursive: true })
const ARCH8 = path.join(LAB8, I.DIR_NAME)
fs.mkdirSync(ARCH8, { recursive: true })
const SEP8 = '| --- | --- | --- | --- | --- |'
const BEFORE8 = [
  '# 角色发言 · INDEX', '',
  '## ① 手工存量', '',
  '| 时间 | 角色 | 标题 | 字节 | 文件 |', SEP8,
  '| 2026-09-24 00:08:33 | 审查 | 存量一 | 1 | [存量一](x.md) |',
  '| 2026-09-24 14:35:20 | 记录 | 存量二 | 2 | [存量二](y.md) |', '',
  '## ② 自动归档（插件）', '',
  '| 时间 | 角色 | 标题 | 字节 | 文件 |', SEP8, '',
].join('\n')
fs.writeFileSync(path.join(ARCH8, I.INDEX_NAME), BEFORE8, 'utf8')
const ctxJ = makeFakeCtx()
plugin.apply(ctxJ.ctx, { fallbackDir: FALLBACK })
const eight = makeAgent('session-idxlast-1111-2222-3333-444455556666', makeSession(
  'session-idxlast-1111-2222-3333-444455556666', LAB8, subagentEvents('审查', '自动段里的第一条'),
  { origin: 'subagent', delegationDepth: 1 }), [])
ctxJ.emit('agent/turn-stopping', { turn: 1, agent: eight })
const idx8 = fs.readFileSync(path.join(ARCH8, I.INDEX_NAME), 'utf8')
const ls8 = idx8.split(/\r?\n/)
const autoHead = ls8.findIndex((l) => l === '## ② 自动归档（插件）') + 1
const newRow = ls8.findIndex((l) => /^\| 2026-.*\| 审查 \| 自动段里的第一条 \|/.test(l)) + 1
const seps = ls8.map((l, i) => [l, i]).filter(([l]) => l === SEP8).map(([, i]) => i)
const lastSep = seps[seps.length - 1] + 1
console.log('\n[证据 ⑮] 段序：自动段标题在第 ' + autoHead + ' 行（手工段在前）；共 ' + ls8.length + ' 行')
console.log('[证据 ⑮] 两个表头分隔线在第 ' + JSON.stringify(seps.map((i) => i + 1)) + ' 行；最后一个在第 ' + lastSep + ' 行')
console.log('[证据 ⑮] 自动归档新行落在第 ' + newRow + ' 行')
console.log('[证据 ⑮] 分节标记出现次数: ' + (idx8.split(I.INDEX_SECTION_MARK).length - 1))
check('⑮ 已有内容一个字节都没动（仍是前缀）', idx8.startsWith(BEFORE8), JSON.stringify(idx8.slice(0, 30)))
check('⑮ 两段都有表头分隔线 ⇒ 插件不插分节标记（正是 F3 的现场）', !idx8.includes(I.INDEX_SECTION_MARK))
check('⑮ 新行落在「② 自动归档」段之后（不是手工存量段里）',
  autoHead > 0 && newRow > autoHead, 'autoHead=' + autoHead + ' newRow=' + newRow)
check('⑮ 新行紧跟在**最后一个**表头分隔线之后（= 追加落在最后一段的表里）',
  newRow === lastSep + 1, 'lastSep=' + lastSep + ' newRow=' + newRow)
eq('⑮ 手工段那 2 行一个字节都没动',
  ls8.filter((l) => /存量[一二]/.test(l)).join('\n'),
  '| 2026-09-24 00:08:33 | 审查 | 存量一 | 1 | [存量一](x.md) |\n| 2026-09-24 14:35:20 | 记录 | 存量二 | 2 | [存量二](y.md) |')

// ── 汇总 ──────────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
console.log('')
for (const r of results) {
  if (r.ok) { pass++; console.log('  PASS  ' + r.name) }
  else { fail++; console.log('  FAIL  ' + r.name + (r.detail ? '   ← ' + r.detail : '')) }
}
console.log('\n合计：' + results.length + ' 条断言，PASS ' + pass + '，FAIL ' + fail)
console.log('夹具根：' + LAB)
console.log('归档夹具（端到端演示用）：' + ARCHIVE)

if (!KEEP) {
  fs.rmSync(LAB, { recursive: true, force: true })
} else {
  console.log('（--keep：夹具保留，可直接 Get-ChildItem -Recurse 看）')
}
process.exit(fail === 0 ? 0 : 1)
