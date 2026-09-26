#!/usr/bin/env node
'use strict'
/* ============================================================================
 * context-dedup.selftest.mjs —— 自检套件（`node` 直接跑，exit code 报结果）
 *
 *   0 = 全过（每一条判据的正控 + 负控都过）
 *   1 = 有红
 *
 * 它**不碰真 DSH、不碰真账本、不碰真工程**：全部夹具都在内存里造，
 * 一个字节都不写盘（临时区也不用）。
 *
 * 覆盖（正控 / 负控成对）：
 *   T1  逐字节相同 ⇒ 第二次换成指引；第一次原样保留          【正控】
 *   T2  ★内容变了 ⇒ 不走「相同」档；差异行照推              【负控·最要紧】
 *   T3  相似 ⇒ 只推差异行，且**能逐行重建原文**（零信息损失）【正控】
 *   T4  isError 结果不动                                    【负控】
 *   T5  小于阈值不动                                        【负控】
 *   T6  第一份已不在上下文里 ⇒ 不许省略（不许让内容消失）    【负控】
 *   T7  跨会话不共享（两个假会话，两边都该保留第一份）      【负控】
 *   T8  没有任何重复 ⇒ 一个字节都不改（原样返回同一个对象）  【正控】
 *   T9  省下的字符数报得对                                  【正控】
 *   T10 可逆：apply → dispose ⇒ 监听器全摘掉                【正控】
 *   T11 含非 text 块（如 image）不动                        【负控】
 *   T12 decision.kind !== 'accept'（block）不动              【负控】
 *   T13 嵌套调用（exec.parent）不动                          【负控】
 *   T14 decision 走 value 替换那一路 ⇒ 不动                  【负控】
 *   T15 只有行尾不同（CRLF vs LF）⇒ 归一化后视为相同         【正控·记录行为】
 *   T16 原文里含占位符形状 ⇒ 放弃「相似」档（防重建歧义）    【负控】
 *   T17 owner 会被体积剪枝挖到 ⇒ 放弃省略（护栏）            【负控】
 *   T22 取不到 toolResultPruner ⇒ 护栏兜底 8192（不是 0）     【负控·+正控】
 *   T23 悬空 owner 记账：健康 0/0 · 搬走后 2/2 · 再跑一趟 0/2 【正控·+判定性】
 *
 * 另有 3 段原样输出（报告要贴）：
 *   E3 合成会话的"省了多少"实测（**夹具口径**，不是线上节省率）
 *   E4 端到端的 tools/post-execute waterfall 复现（打印返回的 decision）
 *   E5 可逆性证明（打印摘掉前后的监听器列表）
 *
 * ⚠ **两个计数别混**（口径写在这里，也打印在汇总里）：
 *   · `ok()` / `eq()` = **断言**条数（一条判据里可能有很多条断言，例如 T21 一条判据
 *     跑 11 条断言）；汇总会打印本次**实际求值**的断言数。
 *   · `RESULTS.length` = **判据行数**（T1–T21 + T22 + T23 + E3 + E4 = 25 条）。
 *   ⇒ 报"通过 25/25"时说的是判据行数，别让人以为总共只查了 25 件事。
 * ==========================================================================*/

/* ⚠ 本文件是 `.mjs`（ESM）⇒ 没有 require / __dirname，用 createRequire 拿回来。
   插件本体是 CJS（`.js` + module.exports）—— 这是本仓库已挂载的 warden-watch.js
   用的同一形状，详见 context-dedup.DESIGN.md 的"发现别处也得改"一节。 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const plugin = require(path.join(__dirname, 'context-dedup.js'))

const MARKER_RE = plugin.__internals.MARKER_RE
const GUIDANCE_RE = plugin.__internals.GUIDANCE_RE
const HEADER_RE = plugin.__internals.HEADER_RE

/* ======================================================== 1. 夹具（全在内存） */

/** 假的 Cordis ctx：on/effect/get/logger —— 形状照 cordis 4.0.2 的真实契约。 */
function makeCtx(services) {
  const listeners = []
  const effects = []
  let idSeq = 0
  const ctx = {
    _listeners: listeners,
    _effects: effects,
    on(name, listener, options) {
      const opts = options === undefined || options === null ? {} : options
      const entry = { id: ++idSeq, name, listener, options: opts }
      /* 照 cordis events.ts:143 —— prepend 用 unshift，否则 push */
      if (opts.prepend === true) listeners.unshift(entry)
      else listeners.push(entry)
      let live = true
      return () => {
        if (!live) return false
        live = false
        const i = listeners.indexOf(entry)
        if (i >= 0) listeners.splice(i, 1)
        return true
      }
    },
    effect(fn, label) {
      const disposer = fn()
      effects.push({ disposer, label })
      let live = true
      return () => {
        if (!live) return
        live = false
        if (typeof disposer === 'function') disposer()
      }
    },
    get(name) {
      return services === undefined || services === null ? undefined : services[name]
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return ctx
}

let msgSeq = 0
/** 假会话：log + surface + replaceGeneration，语义照 Session 的真实契约。 */
function makeSession(id, ctx) {
  const log = []
  const surface = []
  let gen = 0
  const session = {
    header: { id },
    _log: log,
    get seq() {
      return log.length
    },
    get surface() {
      return { nodes: surface.slice(), replaceGeneration: gen }
    },
    eventAt(seq) {
      return log[seq]
    },
    append(type, data, opts) {
      const seq = log.length
      const ev = Object.assign({ seq, type, data }, opts === undefined ? {} : opts)
      log.push(ev)
      const op = opts === undefined ? undefined : opts.surfaceOp
      if (op !== undefined && op !== null && op.op === 'replace') {
        const i = surface.indexOf(op.startSeq)
        if (i < 0) throw new Error('fake session: replace target is not on the surface')
        surface.splice(i, op.endSeq - op.startSeq + 1, seq)
        gen += 1
      } else if (type !== 'compaction/prune') {
        surface.push(seq)
      }
      /* 照 cordis/dsh：append 之后同步广播 session/event（post-commit feed） */
      for (const entry of ctx._listeners.slice()) {
        if (entry.name === 'session/event') entry.listener(session, ev)
      }
      return ev
    },
    /** 自检专用：模拟别人（体积剪枝 / compaction）把这个节点从 surface 上换掉。 */
    evict(seq) {
      const i = surface.indexOf(seq)
      if (i < 0) return false
      surface.splice(i, 1)
      gen += 1
      return true
    },
    /** 当前 surface 上所有 tool/result 的文本（"上传后的字符数"就数它）。 */
    surfaceTexts() {
      const out = []
      for (const seq of surface) {
        const ev = log[seq]
        if (ev === undefined || ev.type !== 'tool/result') continue
        const blk = ev.data.message.content[0]
        out.push(blk.content.map((b) => b.text).join(''))
      }
      return out
    },
  }
  return session
}

const BASE_DECISION = Object.freeze({ kind: 'accept' })

/** 真的 waterfall 形状：prepend 在前，每个 listener 拿 next()，最后落到 base。 */
function waterfall(ctx, name, ...args) {
  const ls = ctx._listeners.filter((e) => e.name === name).map((e) => e.listener)
  const base = () => Promise.resolve(BASE_DECISION)
  const dispatch = (i) => {
    if (i >= ls.length) return base()
    return Promise.resolve(ls[i](...args, () => dispatch(i + 1)))
  }
  return dispatch(0)
}

/** 走一遍真实形状：tools/post-execute waterfall → 按 decision 落盘成 tool/result。 */
async function runTool(ctx, session, toolName, callId, text, options) {
  const opts = options === undefined ? {} : options
  const exec = {
    callId,
    name: toolName,
    arguments: {},
    agent: { session },
    signal: undefined,
  }
  if (opts.parent !== undefined) exec.parent = opts.parent
  const result = {
    isError: opts.isError === true,
    value: null,
    content: opts.content !== undefined ? opts.content : [{ type: 'text', text }],
  }
  const decision = await waterfall(ctx, 'tools/post-execute', exec, result)
  if (decision.kind === 'accept') {
    const content = decision.content !== undefined ? decision.content : result.content
    session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          id: 'm' + ++msgSeq,
          role: 'user',
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content }],
        },
      },
      { surfaceOp: 'append' },
    )
  }
  return { decision, exec, result }
}

/** 直接落盘一个 tool/result（**不**经过 post-execute）—— 模拟"插件装载之前就有的上下文"。 */
function appendToolResult(session, callId, text) {
  session.append(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        id: 'm' + ++msgSeq,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      },
    },
    { surfaceOp: 'append' },
  )
}

/** 直接落盘一个 assistant/message（带 tool-call 块）—— 清理档靠它学"工具名"。 */
function appendAssistantToolCall(session, callId, name) {
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: 'm' + ++msgSeq,
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
      },
      stream: [],
    },
    { surfaceOp: 'append' },
  )
}

/** 跑一次 agent/pre-step（清理那一档的触发点）。 */
function preStep(ctx, session) {
  return waterfall(ctx, 'agent/pre-step', { agent: { session }, turn: 1, step: 1, signal: undefined })
}

/** 从 decision 里取出它实际要上传的文本。 */
function decisionText(decision, fallback) {
  if (decision.content !== undefined) return decision.content.map((b) => b.text).join('')
  return fallback
}

/* ======================================================== 2. 内容夹具生成器 */

/** 造一段"像文件"的文本：每行都非平凡（够长、含实义字符）。 */
function makeBody(tag, lineCount) {
  const out = []
  for (let i = 0; i < lineCount; i++) {
    out.push(`const ${tag}_${String(i).padStart(3, '0')} = compute(${i}, ${i * 7}); // 第 ${i} 行，填充到足够长以便越过阈值`)
  }
  return out.join('\n')
}

/** 把某几行换成新内容（模拟"改完文件再读一遍"）。 */
function patchLines(text, indices, tag) {
  const lines = text.split('\n')
  for (const i of indices) lines[i] = `const PATCHED_${tag}_${i} = recompute(${i}); // 这一行变了，必须照推`
  return lines.join('\n')
}

/**
 * 逐行重建：省略后的内容 + 上文里已有的那些行 ⇒ 必须逐字节等于原文。
 * 这就是"零信息损失"那条断言用的函数。
 * `emittedLinesByBlockId` = 块号 -> **该块实际推上去的那份文本**的行数组
 *   （占位符 `[dup:B:L]` 里的 L 指的就是 B 那份文本的第 L 行 —— 因为读者手上
 *    有的就是那份文本）。
 */
function reconstruct(emittedText, emittedLinesByBlockId) {
  const lines = emittedText.split('\n')
  const out = []
  for (const line of lines) {
    if (HEADER_RE.test(line) || GUIDANCE_RE.test(line)) continue
    const m = MARKER_RE.exec(line)
    if (m === null) {
      out.push(line)
      continue
    }
    const blockId = Number(m[1])
    const lineNo = Number(m[2])
    const owner = emittedLinesByBlockId.get(blockId)
    if (owner === undefined) throw new Error(`reconstruct: 占位符指向未知块号 ${blockId}`)
    const original = owner[lineNo - 1]
    if (original === undefined) throw new Error(`reconstruct: 块 ${blockId} 没有第 ${lineNo} 行`)
    out.push(original)
  }
  return out.join('\n')
}

/** 从真实运行态里取这个会话的 state（不是靠测试自己的假设）。 */
function stateOf(session) {
  const id = session.header.id
  for (const holder of plugin.__internals.statsRegistry) {
    if (holder.byId.has(id)) return holder.byId.get(id)
  }
  return undefined
}

/** 块号 -> 该块实际推上去的那份文本（从真实 surface 反查 textFpToBlock）。 */
function emittedTextByBlockId(session, state) {
  const fpOf = plugin.__internals.fpOf
  const out = new Map()
  for (const seq of session.surface.nodes) {
    const ev = session._log[seq]
    if (ev === undefined || ev.type !== 'tool/result') continue
    const text = ev.data.message.content[0].content.map((b) => b.text).join('')
    const bid = state.textFpToBlock.get(fpOf(text))
    if (bid !== undefined) out.set(bid, text)
  }
  return out
}

/**
 * 从**真实运行态**里取"推上去的那份文本恰好等于 `text` 的那个块"的块号。
 * ⚠ 测试**不许**自己假设块号（`nextBlockId` 的分配顺序一变，硬编码就会假红）；
 *   一律照 E3 的写法从 `state.textFpToBlock` + 当前 surface 反查。
 * @returns 块号，或 undefined
 */
function blockIdOfEmittedText(session, state, text) {
  for (const entry of emittedTextByBlockId(session, state)) {
    if (entry[1] === text) return entry[0]
  }
  return undefined
}

/**
 * 对一份结果做零信息损失验证：
 *   · 被整块换成指引 ⇒ 指引指向的那个 owner 必须**还活着**、是**原样块**、
 *     且它在 surface 上的那份文本**逐字节等于原文**；
 *   · 否则 ⇒ 把 surface 上这份（含占位符）逐行重建，必须逐字节等于原文。
 */
function verifyZeroLoss(session, state, callId, original) {
  const onSurface = findSurfaceTextForCallId(session, callId)
  if (onSurface === undefined) return { ok: false, why: '这份不在 surface 上了' }
  const byBlock = emittedTextByBlockId(session, state)
  const linesByBlock = new Map()
  for (const entry of byBlock) linesByBlock.set(entry[0], entry[1].split('\n'))

  if (GUIDANCE_RE.test(onSurface)) {
    const m = GUIDANCE_RE.exec(onSurface)
    const occ = Number(m[1])
    const tool = m[2]
    let owner
    for (const rec of state.blocks.values()) {
      if (rec.toolName === tool && rec.occurrence === occ && rec.verbatim === true) {
        owner = rec
        break
      }
    }
    if (owner === undefined) return { ok: false, why: `指引指向一个不存在的原样块（第 ${occ} 次 ${tool}）` }
    if (state.idx === null || !state.idx.liveBlocks.has(owner.blockId)) {
      return { ok: false, why: `指引的 owner（块 ${owner.blockId}）已经不在上下文里了 —— 内容会消失` }
    }
    const ownerText = byBlock.get(owner.blockId)
    if (ownerText !== original) return { ok: false, why: `owner（块 ${owner.blockId}）在 surface 上的文本 != 原文` }
    return { ok: true, how: `整块指引 → 块 ${owner.blockId}（原样 · 还活着 · 逐字节等于原文）` }
  }
  const rebuilt = reconstruct(onSurface, linesByBlock)
  if (rebuilt !== original) return { ok: false, why: '逐行重建 != 原文' }
  return { ok: true, how: '逐行重建 == 原文' }
}

/* ======================================================== 3. 测试跑手 ======= */
const RESULTS = []
/**
 * **断言**计数器（口径见文件头）：`ok()` 与 `eq()` 各算一条。
 * ⚠ 它不是 `RESULTS.length` —— 后者是**判据行数**。汇总里两个都打印。
 */
const ASSERTIONS = { ok: 0, eq: 0 }
let currentPair = ''
async function test(id, pair, title, fn) {
  currentPair = pair
  /* 每条判据实际跑了多少条断言 —— **现算**，不写死（写死的数字会过期）。 */
  const assertsBefore = ASSERTIONS.ok + ASSERTIONS.eq
  try {
    await fn()
    RESULTS.push({ id, pair, title, ok: true, detail: '', asserts: ASSERTIONS.ok + ASSERTIONS.eq - assertsBefore })
  } catch (error) {
    RESULTS.push({ id, pair, title, ok: false, detail: String((error && error.message) || error), asserts: ASSERTIONS.ok + ASSERTIONS.eq - assertsBefore })
  }
}
function ok(cond, message) {
  ASSERTIONS.ok += 1
  if (!cond) throw new Error(message)
}
function eq(actual, expected, message) {
  ASSERTIONS.eq += 1
  if (actual !== expected) throw new Error(`${message}\n      实际: ${JSON.stringify(actual)}\n      期望: ${JSON.stringify(expected)}`)
}

/* ======================================================== 4. 判据 ========== */
async function main() {
  /* ---------------------------------------------------------------- T1 */
  await test('T1', '正控', '逐字节相同 ⇒ 第二次换成指引；第一次原样保留', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t1', ctx)
    await preStep(ctx, s)
    const body = makeBody('t1', 12)

    const first = await runTool(ctx, s, 'read', 'c1', body)
    ok(first.decision === BASE_DECISION, '第一份不该被动：decision 必须原样（同一个对象）')
    const firstText = decisionText(first.decision, body)
    eq(firstText, body, '第一份必须逐字节原样推上去')

    const second = await runTool(ctx, s, 'read', 'c2', body)
    const secondText = decisionText(second.decision, body)
    ok(GUIDANCE_RE.test(secondText), `第二份必须被换成指引行，实际=${JSON.stringify(secondText.slice(0, 120))}`)
    ok(secondText.length < body.length, '指引行必须比原文短')
    ok(secondText.includes('原文在上下文里'), '指引必须写明原文在上下文里')

    /* 正控的另一半：第一份仍在 surface 上、且是全文 */
    const texts = s.surfaceTexts()
    eq(texts.length, 2, 'surface 上应该有两个 tool/result')
    eq(texts[0], body, '第一份在 surface 上必须仍是全文')
    ok(GUIDANCE_RE.test(texts[1]), '第二份在 surface 上必须是指引行')
  })

  /* ---------------------------------------------------------------- T2 */
  await test('T2', '负控★', '内容变了 ⇒ 不走「相同」档；差异行照推（最要紧的一条）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t2', ctx)
    await preStep(ctx, s)
    const body = makeBody('t2', 12)

    await runTool(ctx, s, 'read', 'c1', body)

    /* 只改一行 —— 内容变了，指纹就变 */
    const changed = patchLines(body, [5], 't2')
    ok(plugin.__internals.fpOf(changed) !== plugin.__internals.fpOf(body), '改了内容，指纹必须变')

    const second = await runTool(ctx, s, 'read', 'c2', changed)
    const secondText = decisionText(second.decision, changed)

    /* ① 绝不能被整块换成"逐字节相同"的指引 */
    ok(!GUIDANCE_RE.test(secondText), '内容变了却走了「相同」档 —— 这是最严重的一种错')
    /* ② 差异行必须逐字照推 */
    ok(secondText.includes('const PATCHED_t2_5 = recompute(5); // 这一行变了，必须照推'), '改掉的那一行必须原样推上去')
    /* ③ 逐行重建必须逐字节等于改后的原文。
       ⚠ 块号**从真实运行态取**（照 E3 的写法），不是测试自己假设的 1 ——
          `nextBlockId` 的分配顺序一变，硬编码的块号就会**假红**。 */
    const state = stateOf(s)
    ok(state !== undefined, '必须能拿到会话 state')
    const ownerBlockId = blockIdOfEmittedText(s, state, body)
    ok(ownerBlockId !== undefined, '必须能从真实运行态里找到"第一次原样推上去的那份"的块号')
    const markers = secondText.split('\n').filter((l) => MARKER_RE.test(l))
    ok(markers.length > 0, '夹具：内容变了的那份必须有占位符')
    for (const line of markers) {
      eq(Number(MARKER_RE.exec(line)[1]), ownerBlockId, `占位符必须指向真实运行态里那个 owner 块（${line}）`)
    }
    const ownerLines = new Map()
    ownerLines.set(ownerBlockId, body.split('\n'))
    eq(reconstruct(secondText, ownerLines), changed, '重建出来的必须逐字节等于改后的原文')
  })

  /* ---------------------------------------------------------------- T3 */
  await test('T3', '正控', '相似 ⇒ 只推差异行，且能逐行重建原文（零信息损失）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t3', ctx)
    await preStep(ctx, s)
    const body = makeBody('t3', 14)

    await runTool(ctx, s, 'read', 'c1', body)
    const changed = patchLines(body, [2, 6, 11], 't3')
    const second = await runTool(ctx, s, 'read', 'c2', changed)
    const secondText = decisionText(second.decision, changed)

    const header = secondText.split('\n')[0]
    ok(HEADER_RE.test(header), `第一行必须是头部，实际=${JSON.stringify(header)}`)

    /* 只有 3 行是新的 ⇒ 被省略的行数 = 14 - 3 = 11 */
    const m = HEADER_RE.exec(header)
    eq(Number(m[1]), 11, '头部报的省略行数必须等于"所有非平凡行都已在上文出现过"的行数')
    ok(secondText.includes('重复已省略'), '头部必须写明重复已省略')

    /* 差异行照推 */
    for (const i of [2, 6, 11]) {
      ok(secondText.includes(`const PATCHED_t3_${i} = recompute(${i}); // 这一行变了，必须照推`), `第 ${i} 行（差异行）必须原样推上去`)
    }
    /* 未变行以占位符形式被省掉 */
    const markers = secondText.split('\n').filter((l) => MARKER_RE.test(l))
    eq(markers.length, 11, '占位符个数必须等于被省略的行数')

    /* ★零信息损失：逐行拼回去 == 原文（逐字节）。
       ⚠ 块号**从真实运行态取**（照 E3 的写法）—— 硬编码块号会假红。 */
    const state = stateOf(s)
    ok(state !== undefined, '必须能拿到会话 state')
    const ownerBlockId = blockIdOfEmittedText(s, state, body)
    ok(ownerBlockId !== undefined, '必须能从真实运行态里找到"第一次原样推上去的那份"的块号')
    for (const line of markers) {
      eq(Number(MARKER_RE.exec(line)[1]), ownerBlockId, `占位符必须指向真实运行态里那个 owner 块（${line}）`)
    }
    const ownerLines = new Map()
    ownerLines.set(ownerBlockId, body.split('\n'))
    eq(reconstruct(secondText, ownerLines), changed, '重建必须逐字节等于原文（零信息损失）')

    /* 占位符必须真的比原行短（否则省了更费 token） */
    for (const line of body.split('\n')) {
      ok(!MARKER_RE.test(line), '夹具本身不该含占位符形状')
    }
    ok(secondText.length < changed.length, '改写后的必须更短')
  })

  /* ---------------------------------------------------------------- T4 */
  await test('T4', '负控', 'isError 结果一律不动', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t4', ctx)
    await preStep(ctx, s)
    const body = makeBody('t4', 12)

    await runTool(ctx, s, 'read', 'c1', body)
    const second = await runTool(ctx, s, 'read', 'c2', body, { isError: true })
    ok(second.decision === BASE_DECISION, 'isError 结果必须原样放行（decision 同一个对象）')

    /* 再确认一次：把 isError 关掉，同样的内容就该被省略 —— 证明上面不是因为别的原因 */
    const third = await runTool(ctx, s, 'read', 'c3', body)
    ok(GUIDANCE_RE.test(decisionText(third.decision, body)), '同一个内容、非 isError ⇒ 应该被省略（说明 T4 是 isError 起的作用）')
  })

  /* ---------------------------------------------------------------- T5 */
  await test('T5', '负控', '小于阈值一律不动', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t5', ctx)
    await preStep(ctx, s)
    const small = 'short line a\nshort line b\nshort line c' // < 512
    ok(small.length < 512, '夹具必须小于阈值')

    await runTool(ctx, s, 'read', 'c1', small)
    const second = await runTool(ctx, s, 'read', 'c2', small)
    ok(second.decision === BASE_DECISION, '小于阈值必须原样放行')

    /* 负控的另一半：同一个会话里放一份够大的，就该被省 */
    const big = makeBody('t5', 12)
    await runTool(ctx, s, 'read', 'c3', big)
    const fourth = await runTool(ctx, s, 'read', 'c4', big)
    ok(GUIDANCE_RE.test(decisionText(fourth.decision, big)), '够大的重复应该被省（说明 T5 是阈值起的作用）')
  })

  /* ---------------------------------------------------------------- T6 */
  await test('T6', '负控', '第一份已不在上下文里 ⇒ 不许省略（不许让内容消失）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t6', ctx)
    await preStep(ctx, s)
    const body = makeBody('t6', 12)

    await runTool(ctx, s, 'read', 'c1', body)
    const firstSeq = s.surface.nodes[0]
    await preStep(ctx, s) // sweep：把第一份登记成"活着"
    ok(s.evict(firstSeq), '夹具：必须能把第一份从 surface 上换掉')
    await preStep(ctx, s) // gen 变了 ⇒ 全量重建；第一份已经不在了

    const second = await runTool(ctx, s, 'read', 'c2', body)
    const secondText = decisionText(second.decision, body)
    ok(!GUIDANCE_RE.test(secondText), '第一份已经不在上下文里，绝不能省略 —— 否则内容彻底消失')
    eq(secondText, body, '必须照旧全文推')
    ok(s.surfaceTexts().some((t) => t === body), 'surface 上必须真的有一份全文')
  })

  /* ---------------------------------------------------------------- T7 */
  await test('T7', '负控', '跨会话不共享（两个假会话，两边都该保留第一份）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s1 = makeSession('s-t7-a', ctx)
    const s2 = makeSession('s-t7-b', ctx)
    await preStep(ctx, s1)
    await preStep(ctx, s2)
    const body = makeBody('t7', 12)

    const a1 = await runTool(ctx, s1, 'read', 'a1', body)
    const b1 = await runTool(ctx, s2, 'read', 'b1', body)
    eq(decisionText(a1.decision, body), body, '会话 A 的第一份必须原样')
    eq(decisionText(b1.decision, body), body, '会话 B 的第一份必须原样（不许因为 A 读过就省掉）')

    /* 两边各自第二次都该被省 —— 证明两边的集合都在正常工作 */
    const a2 = await runTool(ctx, s1, 'read', 'a2', body)
    const b2 = await runTool(ctx, s2, 'read', 'b2', body)
    ok(GUIDANCE_RE.test(decisionText(a2.decision, body)), '会话 A 的第二次应该被省')
    ok(GUIDANCE_RE.test(decisionText(b2.decision, body)), '会话 B 的第二次应该被省')
  })

  /* ---------------------------------------------------------------- T8 */
  await test('T8', '正控', '没有任何重复 ⇒ 一个字节都不改（原样返回同一个 decision 对象）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t8', ctx)
    await preStep(ctx, s)

    for (let i = 0; i < 5; i++) {
      const body = makeBody(`t8_${i}`, 12)
      const out = await runTool(ctx, s, 'read', `c${i}`, body)
      ok(out.decision === BASE_DECISION, `第 ${i} 份没有任何重复 ⇒ 必须原样返回同一个 decision 对象（一个字节都不改）`)
      ok(!Object.hasOwn(out.decision, 'content'), 'decision 上不许凭空多出 content 字段')
    }
    eq(s.surfaceTexts().length, 5, 'surface 上应有 5 份全文')
  })

  /* ---------------------------------------------------------------- T9 */
  await test('T9', '正控', '省下的字符数报得对', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t9', ctx)
    await preStep(ctx, s)
    const body = makeBody('t9', 12)

    await runTool(ctx, s, 'read', 'c1', body)
    const second = await runTool(ctx, s, 'read', 'c2', body)
    const guide = decisionText(second.decision, body)
    const expectSaved = plugin.__internals.cpLen(body) - plugin.__internals.cpLen(guide)

    const stats = plugin.readStats(s)
    ok(stats !== null, '必须能读到这个会话的读数')
    eq(stats.dupBlocks, 1, 'dupBlocks 应该是 1')
    eq(stats.savedChars, expectSaved, 'savedChars 必须精确等于"原文码点数 - 指引码点数"')
    eq(stats.charsBefore - stats.charsAfter, stats.savedChars, 'charsBefore - charsAfter 必须等于 savedChars')
    ok(stats.savedTokenEstimate > 0, 'token 估算必须是个正数（它是估算，字符数是精确的）')
  })

  /* ---------------------------------------------------------------- T10 */
  const reversible = { before: [], after: [] }
  await test('T10', '正控', '可逆：apply → dispose ⇒ 监听器全摘掉', async () => {
    const ctx = makeCtx()
    reversible.before = []
    plugin.apply(ctx, {})
    reversible.before = ctx._listeners.map((e) => `${e.name}${e.options.prepend === true ? ' [prepend]' : ''}`)
    ok(reversible.before.length === 4, `apply 之后应该有 4 个监听器，实际 ${reversible.before.length}`)
    ok(reversible.before.includes('tools/post-execute [prepend]'), '必须注册 tools/post-execute（prepend）')
    ok(reversible.before.includes('agent/pre-step'), '必须注册 agent/pre-step（清理那一档）')
    ok(reversible.before.includes('session/event'), '必须注册 session/event')
    ok(reversible.before.includes('session/disposed'), '必须注册 session/disposed')

    for (const eff of ctx._effects.slice()) {
      if (typeof eff.disposer === 'function') eff.disposer()
    }
    reversible.after = ctx._listeners.map((e) => `${e.name}${e.options.prepend === true ? ' [prepend]' : ''}`)
    eq(reversible.after.length, 0, `dispose 之后监听器必须一个不剩，实际还剩 ${JSON.stringify(reversible.after)}`)
  })

  /* ---------------------------------------------------------------- T11 */
  await test('T11', '负控', '含非 text 块（如 image）一律不动', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t11', ctx)
    await preStep(ctx, s)
    const body = makeBody('t11', 12)
    const rich = [{ type: 'text', text: body }, { type: 'image', source: { kind: 'attachment', id: 'x' } }]

    await runTool(ctx, s, 'read', 'c1', body, { content: rich })
    const second = await runTool(ctx, s, 'read', 'c2', body, { content: rich })
    ok(second.decision === BASE_DECISION, '含非 text 块的结果必须原样放行（看不懂就别动它）')
  })

  /* ---------------------------------------------------------------- T12 */
  await test('T12', '负控', "decision.kind !== 'accept'（block）一律不动", async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t12', ctx)
    await preStep(ctx, s)
    const body = makeBody('t12', 12)

    /* 手工造一条 block decision：在 waterfall 的 base 之前插一个"拦截器" */
    const blocker = { kind: 'block', feedback: [{ type: 'text', text: 'nope' }] }
    ctx.on('tools/post-execute', () => Promise.resolve(blocker))
    const exec = { callId: 'c1', name: 'read', arguments: {}, agent: { session: s }, signal: undefined }
    const result = { isError: false, value: null, content: [{ type: 'text', text: body }] }
    const decision = await waterfall(ctx, 'tools/post-execute', exec, result)
    ok(decision === blocker, 'block decision 必须原样穿过去')
  })

  /* ---------------------------------------------------------------- T13 */
  await test('T13', '负控', '嵌套调用（exec.parent）一律不动', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t13', ctx)
    await preStep(ctx, s)
    const body = makeBody('t13', 12)

    await runTool(ctx, s, 'read', 'c1', body)
    const nested = await runTool(ctx, s, 'read', 'c2', body, { parent: Symbol('toolExecutionToken') })
    ok(nested.decision === BASE_DECISION, '嵌套调用必须原样放行（照 spill-policy）')
  })

  /* ---------------------------------------------------------------- T14 */
  await test('T14', '负控', 'decision 走 value 替换那一路 ⇒ 一律不动', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t14', ctx)
    await preStep(ctx, s)
    const body = makeBody('t14', 12)
    await runTool(ctx, s, 'read', 'c1', body)

    const valueDecision = { kind: 'accept', value: { hello: 'world' } }
    ctx.on('tools/post-execute', () => Promise.resolve(valueDecision))
    const exec = { callId: 'c2', name: 'read', arguments: {}, agent: { session: s }, signal: undefined }
    const result = { isError: false, value: null, content: [{ type: 'text', text: body }] }
    const decision = await waterfall(ctx, 'tools/post-execute', exec, result)
    ok(decision === valueDecision, 'value 替换必须原样穿过（content 与 value 互斥）')
  })

  /* ---------------------------------------------------------------- T15 */
  await test('T15', '正控', '只有行尾不同（CRLF vs LF）⇒ 归一化后视为相同（记录行为）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t15', ctx)
    await preStep(ctx, s)
    const lf = makeBody('t15', 12)
    const crlf = lf.split('\n').join('\r\n')
    ok(crlf !== lf, '夹具：两份必须字节不同')
    eq(plugin.__internals.fpOf(crlf), plugin.__internals.fpOf(lf), '归一化行尾后指纹必须相同')

    await runTool(ctx, s, 'read', 'c1', lf)
    const second = await runTool(ctx, s, 'read', 'c2', crlf)
    ok(GUIDANCE_RE.test(decisionText(second.decision, crlf)), '只有行尾不同 ⇒ 走「相同」档（这是 R41 明确允许的归一化）')
  })

  /* ---------------------------------------------------------------- T16 */
  await test('T16', '负控', '原文里含占位符形状 ⇒ 放弃「相似」档（防重建歧义）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t16', ctx)
    await preStep(ctx, s)
    const body = makeBody('t16', 12)

    await runTool(ctx, s, 'read', 'c1', body)
    /* 改一行，同时塞进一行长得像占位符的内容 —— 那会让"重建"产生歧义 */
    const lines = body.split('\n')
    lines[3] = 'const PATCHED_t16_3 = recompute(3); // 这一行变了，必须照推'
    lines[7] = '[dup:1:2]'
    const tricky = lines.join('\n')

    const second = await runTool(ctx, s, 'read', 'c2', tricky)
    const secondText = decisionText(second.decision, tricky)
    eq(secondText, tricky, '原文含占位符形状时必须整块照推（宁可不省，绝不猜错）')
  })

  /* ---------------------------------------------------------------- T17 */
  await test('T17', '负控', 'owner 会被体积剪枝挖到 ⇒ 放弃省略（护栏）', async () => {
    /* 造一个假的 toolResultPruner：阈值 600 字符 */
    const ctx = makeCtx({ toolResultPruner: { config: { thresholdChars: 600 } } })
    plugin.apply(ctx, {})
    const s = makeSession('s-t17', ctx)
    await preStep(ctx, s)
    const big = makeBody('t17', 14) // 远超 600
    ok(plugin.__internals.cpLen(big) > 600, '夹具必须大于剪枝阈值')

    await runTool(ctx, s, 'read', 'c1', big)
    const second = await runTool(ctx, s, 'read', 'c2', big)
    const secondText = decisionText(second.decision, big)
    ok(!GUIDANCE_RE.test(secondText), 'owner 会被体积剪枝挖到 ⇒ 不许省略（否则"原文在上下文里"是假话）')
    eq(secondText, big, '必须照旧全文推')

    /* 负控的另一半：**看不见剪枝器**时护栏**不失效**，改用 pruner 的默认阈值 8192；
       这份（约 770 字符）没超过 8192 ⇒ 照样省。（超过 8192 的那条控在 T22。） */
    const ctx2 = makeCtx()
    plugin.apply(ctx2, {})
    const s2 = makeSession('s-t17b', ctx2)
    await preStep(ctx2, s2)
    await runTool(ctx2, s2, 'read', 'c1', big)
    const again = await runTool(ctx2, s2, 'read', 'c2', big)
    ok(GUIDANCE_RE.test(decisionText(again.decision, big)), '看不见剪枝器 ⇒ 兜底 8192，这份没超过 8192 ⇒ 应该被省')
  })

  /* ---------------------------------------------------------------- T18 */
  await test('T18', '正控', '清理档：对插件装载前就已在上下文里的重复做一次清理（走 compaction/prune + replace）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t18', ctx)
    const cpLen = plugin.__internals.cpLen
    const body = makeBody('t18', 12)
    const other = makeBody('t18other', 12)
    const similar = patchLines(body, [4], 't18')

    /* 全部直接落盘 —— 实时档一次都没跑过（这正是"清理档"要负责的场面） */
    const jobs = [
      ['p1', 'read', body],
      ['p2', 'bash', other],
      ['p3', 'read', body],
      ['p4', 'read', similar],
    ]
    for (const job of jobs) {
      appendAssistantToolCall(s, job[0], job[1])
      appendToolResult(s, job[0], job[2])
    }
    const before = s.surfaceTexts().reduce((a, t) => a + cpLen(t), 0)

    await preStep(ctx, s)

    const after = s.surfaceTexts().reduce((a, t) => a + cpLen(t), 0)
    ok(after < before, `清理档必须真的改写了（before=${before} after=${after}）`)

    const texts = s.surfaceTexts()
    eq(texts.length, 4, 'surface 上仍是 4 个节点')
    eq(texts[0], body, '第一份必须原样保留')
    eq(texts[1], other, '不重复的那份必须原样保留')
    ok(GUIDANCE_RE.test(texts[2]), `第三份（逐字节重复）必须被换成指引，实际=${JSON.stringify(texts[2].slice(0, 90))}`)
    /* 工具名是从 assistant/message 的 tool-call 块学来的 —— 必须是真名，不是"(未知工具)" */
    ok(texts[2].includes('第 1 次 read'), `指引必须报出工具名与第几次，实际=${JSON.stringify(texts[2])}`)
    ok(HEADER_RE.test(texts[3].split('\n')[0]), '第四份（相似）必须是"按行省略"的头部形状')

    /* 落盘形状必须照 dsh-compaction-tool-result-pruner */
    const types = s._log.map((e) => e.type)
    ok(types.includes('compaction/prune'), '必须留下 compaction/prune 影子定价事件')
    const repl = s._log.find((e) => e.type === 'tool/result' && e.surfaceOp !== undefined && e.surfaceOp.op === 'replace')
    ok(repl !== undefined, '替换必须是 surfaceOp.op === "replace"')
    eq(repl.surfaceOp.startSeq, repl.surfaceOp.endSeq, '必须是单节点替换（startSeq === endSeq）')
    ok(Array.isArray(repl.sourceEventSeqs) && repl.sourceEventSeqs.length === 1, '必须引用被遮蔽的那个节点')
    ok(Object.isFrozen(repl.data.message), '替换后的消息必须是冻结的（照 freezeMessage）')
    const prune = s._log.find((e) => e.type === 'compaction/prune')
    ok(Array.isArray(prune.data.shadowedSeqs) && prune.data.shadowedSeqs.length === 1, 'compaction/prune 必须列出被遮蔽的 seq')
    ok(prune.data.shadowedRange.start === prune.data.shadowedRange.end, 'shadowedRange 必须是单点')
    ok(typeof prune.data.shadowedTokenCount === 'number' && prune.data.shadowedTokenCount > 0, 'shadowedTokenCount 必须是个正数')

    /* 零信息损失：第四份逐行重建回原文 */
    const state = stateOf(s)
    ok(state !== undefined, '必须能拿到会话 state')
    const v = verifyZeroLoss(s, state, 'p4', similar)
    ok(v.ok, `清理档改写的相似结果必须零信息损失：${v.why}`)

    const stats = plugin.readStats(s)
    eq(stats.cleanupRewrites, 2, '清理档应该改写 2 个（1 个整块 + 1 个按行）')
    eq(stats.armRewrites, 0, '实时档一次都没跑')
    ok(stats.savedChars > 0, '必须报出省了多少')
    eq(stats.savedChars, before - after, 'savedChars 必须等于实测的 before-after')
  })

  /* ---------------------------------------------------------------- T19 */
  await test('T19', '负控', '清理档幂等：再跑两次不许再动、也不许重复计数', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t19', ctx)
    const cpLen = plugin.__internals.cpLen
    const body = makeBody('t19', 12)
    appendAssistantToolCall(s, 'p1', 'read')
    appendToolResult(s, 'p1', body)
    appendAssistantToolCall(s, 'p2', 'read')
    appendToolResult(s, 'p2', body)

    await preStep(ctx, s)
    const afterFirst = s.surfaceTexts().reduce((a, t) => a + cpLen(t), 0)
    const statsFirst = plugin.readStats(s)
    const logLenFirst = s._log.length

    await preStep(ctx, s)
    await preStep(ctx, s)
    const afterThird = s.surfaceTexts().reduce((a, t) => a + cpLen(t), 0)
    const statsThird = plugin.readStats(s)

    eq(afterThird, afterFirst, '再跑 sweep 不许再改动 surface')
    eq(statsThird.cleanupRewrites, statsFirst.cleanupRewrites, '不许重复计数')
    eq(s._log.length, logLenFirst, '不许再往日志里追加事件')
  })

  /* ---------------------------------------------------------------- T20 */
  await test('T20', '正控', "similar:false ⇒ 只剩「逐字节相同」档，内容变一个字节就照旧全文推", async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { similar: false })
    const s = makeSession('s-t20', ctx)
    await preStep(ctx, s)
    const body = makeBody('t20', 12)

    await runTool(ctx, s, 'read', 'c1', body)
    /* ① 逐字节相同 —— 仍然要省 */
    const same = await runTool(ctx, s, 'read', 'c2', body)
    ok(GUIDANCE_RE.test(decisionText(same.decision, body)), 'similar:false 不影响「相同」档')

    /* ② 内容变了 —— 必须**整块原样**推上去（一个字节都不改） */
    const changed = patchLines(body, [5], 't20')
    const diff = await runTool(ctx, s, 'read', 'c3', changed)
    ok(diff.decision === BASE_DECISION, 'similar:false 时内容变了必须原样放行（同一个 decision 对象）')
    eq(decisionText(diff.decision, changed), changed, '必须逐字节全文推')

    const stats = plugin.readStats(s)
    eq(stats.similarBlocks, 0, 'similar:false 时不该出现任何"按行相似"的改写')
    eq(stats.dupBlocks, 1, '只该有 1 次整块相同')
  })

  /* ---------------------------------------------------------------- T21 */
  await test('T21', '负控', '配置校验：不认识的键 / 非法值一律在挂载时就报错', async () => {
    const cases = [
      [{ nope: 1 }, 'unknown config key'],
      [{ minChars: 0 }, 'minChars'],
      [{ minChars: 512.5 }, 'minChars'],
      [{ minChars: '512' }, 'minChars'],
      [{ minLineChars: 0 }, 'minLineChars'],
      [{ maxIndexedLines: -1 }, 'maxIndexedLines'],
      [{ cleanup: 'yes' }, 'cleanup'],
      [{ similar: 1 }, 'similar'],
    ]
    for (const entry of cases) {
      let threw = null
      try {
        plugin.apply(makeCtx(), entry[0])
      } catch (error) {
        threw = error
      }
      ok(threw !== null, `配置 ${JSON.stringify(entry[0])} 必须在挂载时报错，而不是静默用默认值`)
      ok(String(threw.message).includes(entry[1]), `报错信息里应该提到 ${entry[1]}，实际=${threw.message}`)
    }
    /* 正控：合法配置（含空配置）必须能挂上 */
    for (const good of [{}, { minChars: 100 }, { minChars: 100, minLineChars: 4, maxIndexedLines: 10, cleanup: false, similar: false }]) {
      plugin.apply(makeCtx(), good)
    }
  })

  /* ---------------------------------------------------------------- T22 */
  await test('T22', '负控', '取不到 toolResultPruner ⇒ 护栏兜底 8192（不是 0 = 不设限）', async () => {
    const ownerGuardChars = plugin.__internals.ownerGuardChars
    /* ① 取不到服务 ⇒ 8192（**不是** 0：0 在判定里等于"不设限" = 护栏自动关掉） */
    eq(ownerGuardChars(makeCtx()), 8192, '取不到 toolResultPruner 时必须兜底 8192')
    /* ② 正控：取到了、有阈值 ⇒ 用它自己的 */
    eq(ownerGuardChars(makeCtx({ toolResultPruner: { config: { thresholdChars: 600 } } })), 600, '取得到时必须用它自己的阈值')
    /* ③ 取到了但没有可用阈值 ⇒ 也退回 8192 */
    eq(ownerGuardChars(makeCtx({ toolResultPruner: { config: {} } })), 8192, '服务在但没有可用阈值时必须退回 8192')
    /* ④ 取服务本身抛错 ⇒ 也退回 8192（不许因为一次异常把护栏关掉） */
    const throwing = { get() { throw new Error('boom') }, logger: { info() {}, warn() {}, error() {} } }
    eq(ownerGuardChars(throwing), 8192, '读服务抛错时必须退回 8192')

    /* ⑤ 行为控：看不见剪枝器、这份又超过 8192 ⇒ **不许**省略（少省一点，绝不写假话） */
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t22', ctx)
    await preStep(ctx, s)
    const huge = makeBody('t22', 200) // 实测 11619 码点 > 8192
    ok(plugin.__internals.cpLen(huge) > 8192, `夹具必须大于 8192，实际 ${plugin.__internals.cpLen(huge)}`)
    await runTool(ctx, s, 'read', 'c1', huge)
    const second = await runTool(ctx, s, 'read', 'c2', huge)
    const secondText = decisionText(second.decision, huge)
    ok(!GUIDANCE_RE.test(secondText), '看不见剪枝器 ⇒ owner 可能被挖掉 ⇒ 超过 8192 的不许省略')
    eq(secondText, huge, '必须照旧全文推')
    ok(s.surfaceTexts().some((t) => t === huge), 'surface 上必须真的有一份全文')

    /* ⑥ 正控的另一半：看得见剪枝器、且它的阈值比这份大 ⇒ 照样省（证明⑤不是别的原因） */
    const ctx2 = makeCtx({ toolResultPruner: { config: { thresholdChars: 200000 } } })
    plugin.apply(ctx2, {})
    const s2 = makeSession('s-t22b', ctx2)
    await preStep(ctx2, s2)
    await runTool(ctx2, s2, 'read', 'c1', huge)
    const again = await runTool(ctx2, s2, 'read', 'c2', huge)
    ok(GUIDANCE_RE.test(decisionText(again.decision, huge)), '看得见剪枝器且阈值够大 ⇒ 应该被省')
  })

  /* ---------------------------------------------------------------- T23 */
  await test('T23', '正控', '悬空 owner 记账：健康 0/0 · 搬走后 2/2 · 再跑一趟 Now=0 而累加=2（① 的判定性实验）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, {})
    const s = makeSession('s-t23', ctx)
    await preStep(ctx, s)
    const body = makeBody('t23', 12)
    const changed = patchLines(body, [5], 't23')

    await runTool(ctx, s, 'read', 'c1', body) // 原样块（owner）
    const dup = await runTool(ctx, s, 'read', 'c2', body) // 整块相同 ⇒ 指引行
    ok(GUIDANCE_RE.test(decisionText(dup.decision, body)), '夹具：第二份必须被换成指引行')
    const sim = await runTool(ctx, s, 'read', 'c3', changed) // 相似 ⇒ 占位符指向 owner
    ok(HEADER_RE.test(decisionText(sim.decision, changed).split('\n')[0]), '夹具：第三份必须是「相似」档')
    const markerCount = decisionText(sim.decision, changed).split('\n').filter((l) => MARKER_RE.test(l)).length
    ok(markerCount > 0, '夹具：「相似」档那份必须有占位符')

    await preStep(ctx, s) // 索引重建：此刻两条记号行的 owner 都还活着
    eq(plugin.readStats(s).danglingOwner, 0, '正控：owner 都还在上下文里 ⇒ 悬空数必须保持 0')
    eq(plugin.readStats(s).danglingOwnerNow, 0, '正控：健康时"本趟检出"也必须是 0')

    /* 把 owner（第一份）从 surface 上搬走 —— 模拟 compaction 把它整块搬走 */
    ok(s.evict(s.surface.nodes[0]), '夹具：必须能把 owner 从 surface 上搬走')
    await preStep(ctx, s) // gen 变了 ⇒ 全量重建；owner 已经不在了
    eq(plugin.readStats(s).danglingOwner, 2, '指引行 1 条 + 「相似」档 1 条 ⇒ 累加键必须各记 1 笔（改前恒为 0）')
    eq(plugin.readStats(s).danglingOwnerNow, 2, '这一趟是全量重建、访问了全部节点 ⇒ "本趟检出"必须同样是 2')

    /* ★ 两个口径的判定性对照：再跑一趟（这一趟 surface 没有任何变化 ⇒ 早退、没有重新核）
       ⇒ **本趟检出归 0，而历史累计仍是 2**。这一步专门把"此刻这一趟"与"历史累计"分开。 */
    const beforeThird = plugin.readStats(s).danglingOwner
    const thirdPass = plugin.__internals.sweepSession(s, stateOf(s), ctx, plugin.__internals.resolveConfig({}))
    ok(thirdPass !== null && thirdPass.skipped === true, `夹具：这一趟必须早退（什么都没变），实际=${JSON.stringify(thirdPass)}`)
    eq(plugin.readStats(s).danglingOwnerNow, 0, '早退那一趟没有重新核 ⇒ "本趟检出"必须是 0')
    eq(plugin.readStats(s).danglingOwner, beforeThird, '累加键不许被早退那一趟改动（它只增不减）')
    eq(plugin.readStats(s).danglingOwner, 2, '累加键必须仍是 2（两个口径就此分开：Now=0 而累计=2）')

    /* 判定性：那两条记号行**还原样留在 surface 上**（假话还在），而占位符此刻取不回任何一行 */
    const texts = s.surfaceTexts()
    eq(texts.length, 2, 'surface 上应该只剩两条记号行')
    ok(GUIDANCE_RE.test(texts[0]) && texts[0].includes('原文在上下文里'), '指引行还在，且还写着"原文在上下文里"—— 这就是那句假话')
    ok(HEADER_RE.test(texts[1].split('\n')[0]), '「相似」档那份还在')
    const markers = texts[1].split('\n').filter((l) => MARKER_RE.test(l))
    eq(markers.length, markerCount, '占位符个数不变（我们不会去改已经写下的记号行）')
    const byBlock = emittedTextByBlockId(s, stateOf(s))
    const linesByBlock = new Map()
    for (const entry of byBlock) linesByBlock.set(entry[0], entry[1].split('\n'))
    let threw = null
    try {
      reconstruct(texts[1], linesByBlock)
    } catch (error) {
      threw = error
    }
    ok(threw !== null, '占位符指向的 owner 已不在上下文里 ⇒ 重建**必须取不回**（这正是"悬空"）')

    /* 负控的另一半：owner 不在了 ⇒ 再读一遍原文不许再省略（硬约束 ⑤） */
    const again = await runTool(ctx, s, 'read', 'c4', body)
    eq(decisionText(again.decision, body), body, 'owner 不在了 ⇒ 再读一遍必须照旧全文推')
  })

  /* ================================================== E3 合成会话实测 ======= */
  console.log('')
  console.log('===== E3 合成会话：去重前 / 去重后 =============================')
  const e3 = await syntheticSession(false)
  console.log(`  [E3-a] 实时档 ①（插件先挂上，20 次 read 边走边省）`)
  console.log(`    会话节点：20 个 tool/result（其中 8 个逐字节相同、4 个相似）`)
  console.log(`    去重前字符数（全部原文码点数）：${e3.beforeChars}`)
  console.log(`    去重后字符数（surface 上实际那份）：${e3.afterChars}`)
  console.log(`    省下：${e3.beforeChars - e3.afterChars} 字符 = ${e3.pct.toFixed(2)}%`)
  console.log(`      ⚠ **夹具口径**：分母是"这 20 个 tool/result 节点的原文码点数之和"，`)
  console.log(`        不是线上节省率 —— 真会话里还有 user/message / assistant/message / system 节点，`)
  console.log(`        分母更大，同一个会话里这个比例只会更低。**不许把它当线上节省率报。**`)
  console.log(`    分档计数：整块相同 ${e3.stats.dupBlocks} 次 · 按行相似 ${e3.stats.similarBlocks} 次`)
  console.log(`    实时档改写 ${e3.stats.armRewrites} 次 · 清理档改写 ${e3.stats.cleanupRewrites} 次`)
  console.log(`    省下的 token 估算（按 4 字符 ≈ 1 token）：${e3.stats.savedTokenEstimate}`)
  console.log(`    护栏放弃次数（owner 可能被体积剪枝挖到）：${e3.stats.skippedOwnerGuard}`)
  console.log(`    悬空 owner：本趟 sweep 检出 ${e3.stats.danglingOwnerNow} 条 · 历史累计 ${e3.stats.danglingOwner} 条`)
  console.log(`      ⚠ 两个口径别混：**"本趟检出"是瞬时键**（每趟 sweep 入口清零；早退/增量那一趟只统计`)
  console.log(`        这一趟真正访问到的记号行 ⇒ 0 表示"这一趟没检出"，**不是**"此刻一定没有假话"）；`)
  console.log(`        **"历史累计"只增不减**（回答"有没有发生过假话"）。两个都留是因为问的是两件事。`)
  console.log(`    零信息损失断言：${e3.zeroLoss ? 'PASS（每一份都能逐字节取回原文）' : 'FAIL'}`)

  const e3c = await syntheticSession(true)
  console.log(`  [E3-b] 清理档 ②（20 份先全部落盘、之后才挂插件 —— 只有清理档有机会干活）`)
  console.log(`    去重前字符数：${e3c.beforeChars}`)
  console.log(`    去重后字符数：${e3c.afterChars}`)
  console.log(`    省下：${e3c.beforeChars - e3c.afterChars} 字符 = ${e3c.pct.toFixed(2)}%（同样是**夹具口径**）`)
  console.log(`    分档计数：整块相同 ${e3c.stats.dupBlocks} 次 · 按行相似 ${e3c.stats.similarBlocks} 次`)
  console.log(`    实时档改写 ${e3c.stats.armRewrites} 次 · 清理档改写 ${e3c.stats.cleanupRewrites} 次`)
  console.log(`    悬空 owner：本趟 sweep 检出 ${e3c.stats.danglingOwnerNow} 条 · 历史累计 ${e3c.stats.danglingOwner} 条`)
  console.log(`    零信息损失断言：${e3c.zeroLoss ? 'PASS（每一份都能逐字节取回原文）' : 'FAIL'}`)
  console.log(`  逐份验证明细（E3-a，前 12 条）：`)
  for (const how of e3.hows.slice(0, 12)) console.log(`    ${how}`)
  console.log(`    …（共 ${e3.hows.length} 条，全部为 PASS）`)
  const e3ok = e3.zeroLoss && e3c.zeroLoss && e3c.stats.cleanupRewrites > 0
    && e3.stats.danglingOwner === 0 && e3c.stats.danglingOwner === 0
    && e3.stats.danglingOwnerNow === 0 && e3c.stats.danglingOwnerNow === 0
  if (!e3ok) {
    RESULTS.push({
      id: 'E3',
      pair: '正控',
      title: '合成会话上零信息损失 + 清理档真的干活',
      ok: false,
      detail: `a.zeroLoss=${e3.zeroLoss} b.zeroLoss=${e3c.zeroLoss} b.cleanupRewrites=${e3c.stats.cleanupRewrites} a.dangling=${e3.stats.danglingOwner}/${e3.stats.danglingOwnerNow} b.dangling=${e3c.stats.danglingOwner}/${e3c.stats.danglingOwnerNow}`,
    })
  } else {
    RESULTS.push({ id: 'E3', pair: '正控', title: '合成会话上零信息损失（逐份取回原文）+ 清理档真的干活 + 悬空两个口径都是 0', ok: true, detail: '' })
  }

  /* ================================================== E4 waterfall 复现 ==== */
  console.log('')
  console.log('===== E4 端到端 tools/post-execute 复现（真实 waterfall 形状）====')
  const e4 = await waterfallRepro()
  console.log(`  假 exec：${JSON.stringify(e4.exec)}`)
  console.log(`  假 result：isError=${e4.result.isError} content=[{type:'text', text:<${e4.bodyChars} 字符>}]`)
  console.log(`  waterfall 顺序：${e4.order.join(' → ')} → base()`)
  console.log(`  第一份返回的 decision：${JSON.stringify(e4.firstDecision)}`)
  console.log(`  第二份返回的 decision：`)
  console.log(`    ${JSON.stringify(e4.secondDecision)}`)
  console.log(`  第二份 decision.content[0].text 原样：`)
  console.log(`    ${e4.secondText}`)
  const e4ok = e4.firstDecision.kind === 'accept'
    && !Object.hasOwn(e4.firstDecision, 'content')
    && GUIDANCE_RE.test(e4.secondText)
  RESULTS.push({
    id: 'E4',
    pair: '正控',
    title: '端到端 waterfall 复现（第一份不动 / 第二份换成指引）',
    ok: e4ok,
    detail: e4ok ? '' : 'waterfall 复现的 decision 形状不对',
  })

  /* ================================================== E5 可逆性证明 ======== */
  console.log('')
  console.log('===== E5 可逆性证明：apply → dispose ==========================')
  console.log(`  dispose 之前的监听器列表（${reversible.before.length} 个）：`)
  for (const l of reversible.before) console.log(`    - ${l}`)
  console.log(`  dispose 之后的监听器列表（${reversible.after.length} 个）：`)
  if (reversible.after.length === 0) console.log('    （空）')
  for (const l of reversible.after) console.log(`    - ${l}`)
  console.log(`  结论：${reversible.after.length === 0 ? '全部摘掉，没有残留' : '有残留 ⇒ 不可逆'}`)

  /* ================================================== 汇总 ================= */
  console.log('')
  console.log('===== 判据汇总 =================================================')
  let failed = 0
  for (const r of RESULTS) {
    if (!r.ok) failed += 1
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} [${r.pair}] ${r.title}`)
    if (!r.ok) console.log(`        ↳ ${r.detail}`)
  }
  const total = RESULTS.length
  const assertTotal = ASSERTIONS.ok + ASSERTIONS.eq
  /* 断言最多的一条判据 —— **现算**（E3/E4 直接 push、不走 test()，它们按 0 计）。 */
  let maxAsserts = 0
  let maxId = ''
  for (const r of RESULTS) {
    if ((r.asserts || 0) > maxAsserts) {
      maxAsserts = r.asserts
      maxId = r.id
    }
  }
  console.log('')
  console.log(`  判据行数：${total} 条（T1–T21 + T22 + T23 + E3 + E4）`)
  console.log(`  断言条数（本次实际求值）：ok() = ${ASSERTIONS.ok} 条 + eq() = ${ASSERTIONS.eq} 条 = **${assertTotal} 条**`)
  console.log(`    ⚠ 两个计数别混：**${total} 是判据行数，${assertTotal} 才是断言数** —— 一条判据里可能有很多条断言`)
  console.log(`      （实测：本趟断言最多的一条是 ${maxId}，跑了 ${maxAsserts} 条 —— 这个数是**现算的**，没有写死，`)
  console.log(`        所以改判据时它不会变成过期数字。E3/E4 直接 push、不走 test()，按 0 计。）`)
  console.log(`  合计：${total - failed}/${total} 判据通过，${failed} 条红；断言全过 = ${failed === 0}`)
  console.log(`  exit code = ${failed === 0 ? 0 : 1}`)
  process.exitCode = failed === 0 ? 0 : 1
}

/* ==================================================== 合成会话（E3）======= */
/**
 * 造一个 20 个 tool/result 的合成会话：
 *   8 个逐字节相同 · 4 个相似（各改 2 行）· 8 个互不相同
 * @param cleanupOnly - true = 先把 20 份**全部落盘**、之后才 apply 插件
 *   （于是只有「清理档」②有机会干活）；false = 插件先挂上（「实时档」①干活）。
 */
async function syntheticSession(cleanupOnly) {
  const ctx = makeCtx()
  const s = makeSession(cleanupOnly === true ? 'synthetic-20-cleanup' : 'synthetic-20-live', ctx)

  const base = makeBody('syn', 40)
  const jobs = []
  /* 8 个逐字节相同 */
  for (let i = 0; i < 8; i++) jobs.push({ kind: 'dup', text: base, tag: `dup${i}` })
  /* 4 个相似：在 base 上各改 2 行 */
  for (let i = 0; i < 4; i++) {
    jobs.push({ kind: 'similar', text: patchLines(base, [i * 3, i * 3 + 1], `sim${i}`), tag: `sim${i}` })
  }
  /* 8 个互不相同、也和 base 不重叠 */
  for (let i = 0; i < 8; i++) jobs.push({ kind: 'unique', text: makeBody(`uniq${i}`, 40), tag: `uniq${i}` })

  const originals = new Map() // callId -> 原文（用来重建）
  let beforeChars = 0
  const cpLen = plugin.__internals.cpLen

  if (cleanupOnly === true) {
    /* 插件还没挂上 —— 全部直接落盘 */
    for (let i = 0; i < jobs.length; i++) {
      const callId = `syn-c${i}`
      originals.set(callId, jobs[i].text)
      beforeChars += cpLen(jobs[i].text)
      appendAssistantToolCall(s, callId, 'read')
      appendToolResult(s, callId, jobs[i].text)
    }
    plugin.apply(ctx, {})
    await preStep(ctx, s)
  } else {
    plugin.apply(ctx, {})
    await preStep(ctx, s)
    for (let i = 0; i < jobs.length; i++) {
      const callId = `syn-c${i}`
      originals.set(callId, jobs[i].text)
      beforeChars += cpLen(jobs[i].text)
      await runTool(ctx, s, 'read', callId, jobs[i].text)
    }
    await preStep(ctx, s) // 清理档再跑一次（幂等性也顺带测了）
  }

  const surface = s.surfaceTexts()
  let afterChars = 0
  for (const t of surface) afterChars += cpLen(t)

  /* ★零信息损失：把 surface 上每一份都验证回它的原文（走真实运行态，不走测试假设） */
  const state = stateOf(s)
  let zeroLoss = state !== undefined
  const hows = []
  if (state !== undefined) {
    for (let i = 0; i < jobs.length; i++) {
      const callId = `syn-c${i}`
      const v = verifyZeroLoss(s, state, callId, originals.get(callId))
      if (!v.ok) {
        zeroLoss = false
        hows.push(`${callId}: FAIL ${v.why}`)
      } else {
        hows.push(`${callId}: ${v.how}`)
      }
    }
  }
  return {
    beforeChars,
    afterChars,
    pct: beforeChars === 0 ? 0 : ((beforeChars - afterChars) / beforeChars) * 100,
    stats: plugin.readStats(s),
    zeroLoss: zeroLoss,
    hows,
  }
}

/** 按 callId 找 surface 上那一条 tool/result 的文本。 */
function findSurfaceTextForCallId(session, callId) {
  for (const seq of session.surface.nodes) {
    const ev = session._log[seq]
    if (ev === undefined || ev.type !== 'tool/result') continue
    const src = ev.data.message.source
    if (src !== undefined && src.callId === callId) {
      const blk = ev.data.message.content[0]
      return blk.content.map((b) => b.text).join('')
    }
  }
  return undefined
}

/* ==================================================== waterfall 复现（E4）== */
async function waterfallRepro() {
  const ctx = makeCtx()
  plugin.apply(ctx, {})
  const s = makeSession('e4-session', ctx)
  await preStep(ctx, s)
  const body = makeBody('e4', 12)
  const order = ctx._listeners.filter((e) => e.name === 'tools/post-execute').map((e) => 'context-dedup:post-execute(prepend)')
  order.push('（本进程里没有别的 post-execute 监听器）')

  const exec = { callId: 'e4-c1', name: 'read', arguments: { file_path: 'X.js' }, agent: { session: s }, signal: undefined }
  const result = { isError: false, value: null, content: [{ type: 'text', text: body }] }
  const firstDecision = await waterfall(ctx, 'tools/post-execute', exec, result)
  s.append(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: {
        id: 'm' + ++msgSeq,
        role: 'user',
        source: { kind: 'tool', callId: 'e4-c1' },
        content: [{ type: 'tool-result', toolCallId: 'e4-c1', content: firstDecision.content === undefined ? result.content : firstDecision.content }],
      },
    },
    { surfaceOp: 'append' },
  )
  const exec2 = { callId: 'e4-c2', name: 'read', arguments: { file_path: 'X.js' }, agent: { session: s }, signal: undefined }
  const result2 = { isError: false, value: null, content: [{ type: 'text', text: body }] }
  const secondDecision = await waterfall(ctx, 'tools/post-execute', exec2, result2)
  const secondText = secondDecision.content.map((b) => b.text).join('')
  return {
    exec: { name: exec.name, callId: exec.callId, arguments: exec.arguments, hasAgent: true, parent: 'undefined' },
    result: { isError: false },
    bodyChars: plugin.__internals.cpLen(body),
    order,
    firstDecision: { kind: firstDecision.kind, hasContent: Object.hasOwn(firstDecision, 'content') },
    secondDecision: { kind: secondDecision.kind, content: secondDecision.content },
    secondText,
  }
}

main().catch((error) => {
  console.log('')
  console.log('自检自己炸了：' + String((error && error.stack) || error))
  process.exitCode = 1
})
