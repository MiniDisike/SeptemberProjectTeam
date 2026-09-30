/**
 * 「九月项目团」drift-heal 自愈巡检（2026-09-29）
 *
 * 背景（2026-09-28/29 DSH 升级事故，两条教训）：
 *   ① 守卫写死了会消失的文件：preset-default-guard 守 `$DSH_HOME/settings.yaml`，
 *      DSH 升级把它迁走（改名 `.imported`）⇒ 守卫每轮 ENOENT 打空
 *      （warden-watch-debug.jsonl 593 次 preset-default-error，一次没 heal 成功）。
 *   ② 巡检依赖了会变的 API：warden-watch 的 turn 线调 `shell.run`，
 *      DSH 升级把它移除 ⇒ 每轮 TypeError（263 次 run-threw），turn 检查线整体死掉。
 *
 * 本文件的四条设计原则（就是从这两条教训来的）：
 *   ① **巡检零 shell 依赖** —— 全部纯 fs。shell API 再怎么变，自愈照跑。
 *   ② **期望清单内置 + 分层探测** —— settings.yaml 存在守它；不存在自动切到
 *      **生效层**（profile patch 的 agent-preset-registry），不再对着死文件打空。
 *   ③ **最小改动** —— 只改坏的那一行/补缺的键，绝不整文件重写
 *      （沿用 preset-default-guard「绝不整文件重写」的约束）。
 *   ④ **全部留痕** —— 返回结构化报告，由 warden-watch 落 warden-watch-debug.jsonl
 *      （`heal-*` 事件族），修没修、修了什么，可查。
 *
 * 自检（不碰 DSH、不用重启）：
 *   node drift-heal.mjs --selftest
 * 由 warden-watch.js 在 boot 与每轮边界调用（probe 只读不写 → heal 才落盘）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/** 期望清单：改这里 = 改「什么状态算健康」。 */
export const EXPECT = {
  presetDefault: 'roles',
  autonomyMode: 'on',
  inserts: [
    { id: 'warden-watch', file: 'warden-watch.js' },
    { id: 'context-dedup', file: 'context-dedup.js' },
    { id: 'role-voices', file: 'role-voices.js' },
    { id: 'handover-gate', file: 'handover-gate.js' },
    { id: 'branch-guard', file: 'branch-guard.js' },
    { id: 'report-spill', file: 'report-spill.js' },
  ],
}

/** 插件目录运行时推导 —— ⚠ 不写死盘符（plugin-io.js 踩过的坑：写死作者机的固定盘，换机即失效）。 */
export const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * 三个被守护文件的路径（从 DSH_HOME 推导，不写死盘符）。
 * profile 默认 desktop（本插件只装在桌面 profile；web 那份 insert 不在本机 GUI 里生效）。
 */
export function defaultPaths() {
  const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE || 'desktop'
  return {
    patchPath: path.join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml'),
    settingsPath: path.join(DSH_HOME, 'settings.yaml'),
    autonomyPath: path.join(DSH_HOME, 'autonomy.json'),
  }
}

const deBOM = (s) => String(s ?? '').replace(/^\uFEFF/, '')
const stripQ = (s) => String(s ?? '').trim().replace(/^["']|["']$/g, '')

/* ---------------------------------------------------------- ① patch 层 preset */

/**
 * 纯函数：给定 cordis.patch.yml 全文，回答 agent-preset-registry 的
 * default / selectedDefault 要不要改、改成什么。
 * 返回 { action: 'ok' | 'heal' | 'absent', current?, next?, why }
 *  - 找不到 agent-preset-registry 块 → absent（next 已带重建后的全文）
 *  - 块在但任一值不是 required → heal（只改值的行，缩进/行内注释/EOL 原样保留）
 *  - 两值都是 required → ok
 */
export function evaluatePresetInPatch(text, required = EXPECT.presetDefault) {
  const src = String(text ?? '')
  const lines = src.split('\n')
  const head = /^([ \t]*)- id:[ \t]*agent-preset-registry\b/
  let h = -1
  let hIndent = ''
  for (let i = 0; i < lines.length; i += 1) {
    const m = head.exec(lines[i])
    if (m) { h = i; hIndent = m[1]; break }
  }
  if (h < 0) {
    const sep = src.endsWith('\n') ? '' : '\n'
    const block = [
      '',
      '# ── drift-heal 重建：用户 2026-09-17 硬约束（默认预设必须 = roles，不许改）──',
      '- id: agent-preset-registry',
      '  name: "@deepseek-ai/dsh-agent-preset-registry"',
      '  config:',
      '    default: ' + required,
      '    selectedDefault: ' + required,
      '',
    ].join('\n')
    return { action: 'absent', current: null, next: src + sep + block, why: 'patch 里没有 agent-preset-registry 段 —— 按期望重建，钉到 ' + required }
  }
  // 块边界：下一个缩进 <= 块头缩进的顶级列表项，或 EOF
  const valRe = /^([ \t]*)(default|selectedDefault):[ \t]*([^#\r\n]*?)([ \t]*)(#[^\r\n]*)?\r?$/
  const bound = /^([ \t]*)- [^\s]/
  let end = lines.length
  for (let i = h + 1; i < lines.length; i += 1) {
    const m = bound.exec(lines[i])
    if (m && m[1].length <= hIndent.length) { end = i; break }
  }
  const cur = {}
  const hit = {}
  for (let i = h + 1; i < end; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || /^[ \t]*#/.test(line)) continue
    const m = valRe.exec(line)
    if (!m || m[1].length <= hIndent.length) continue
    cur[m[2]] = stripQ(m[3])
    hit[m[2]] = i
  }
  if (cur.default === undefined && cur.selectedDefault === undefined) {
    const ins = hIndent + '  config:\n' + hIndent + '    default: ' + required + '\n' + hIndent + '    selectedDefault: ' + required
    lines.splice(end, 0, ins)
    return { action: 'heal', current: cur, next: lines.join('\n'), why: 'agent-preset-registry 块里没有 default/selectedDefault —— 补成 ' + required }
  }
  const bad = Object.keys(cur).filter((k) => cur[k] !== required)
  if (bad.length === 0) {
    return { action: 'ok', current: cur, why: 'patch 层默认已是 ' + required + '，不动' }
  }
  for (const k of bad) {
    const i = hit[k]
    const m = valRe.exec(lines[i])
    const eol = lines[i].endsWith('\r') ? '\r' : ''
    // 值后面的空白与行内注释**原样接回**（preset-default-guard 踩过的：整行重写会吃掉注释）
    const tail = (m[4] || '') + (m[5] || '')
    lines[i] = m[1] + k + ': ' + required + tail + eol
  }
  return {
    action: 'heal',
    current: cur,
    next: lines.join('\n'),
    why: '发现 patch 层默认被改成「' + bad.map((k) => k + '=' + cur[k]).join(', ') + '」—— 按用户 2026-09-17 的硬约束改回 ' + required,
  }
}

/* ---------------------------------------------------------- ② patch 层六插件 insert */

/**
 * 纯函数：检查 cordis.patch.yml 里 `- insert:` 段是否把 EXPECT.inserts 挂全了。
 * 返回 { action: 'ok' | 'heal', missing?, next?, why }
 *  - 缺哪条补哪条（插在最后一个 insert 段尾，缩进对齐段内既有条目）
 *  - 一个 insert 段都没有 → 在文件末尾追加整段
 * 判据：insert 段内的条目是**缩进 > 0** 的 `- id:` 行（顶层的 `- id:` 是其它插件条目，不算）。
 */
export function evaluateInserts(text, expected = EXPECT.inserts) {
  const src = String(text ?? '')
  const lines = src.split('\n')
  const insHead = /^([ \t]*)- insert:/
  const idInSeg = /^([ \t]*)- id:[ \t]*([^\s#]+)/
  const bound = /^([ \t]*)- [^\s]/
  const segs = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = insHead.exec(lines[i])
    if (!m) continue
    let end = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      const b = bound.exec(lines[j])
      if (b && b[1].length <= m[1].length) { end = j; break }
    }
    segs.push({ head: i, end, indent: m[1] })
  }
  const found = []
  let idIndent = '    '
  let segFound = false
  for (let s = segs.length - 1; s >= 0; s -= 1) {
    const seg = segs[s]
    for (let i = seg.head + 1; i < seg.end; i += 1) {
      const m = idInSeg.exec(lines[i])
      if (m && m[1].length > seg.indent.length) {
        if (!found.includes(m[2])) found.push(m[2])
        if (!segFound) { idIndent = m[1]; segFound = true }
      }
    }
  }
  const missing = expected.filter((e) => !found.includes(e.id))
  if (missing.length === 0) {
    return { action: 'ok', why: EXPECT.inserts.length + ' 个插件 insert 齐全，不动' }
  }
  if (segs.length > 0) {
    const lastSeg = segs[segs.length - 1]
    const rows = missing.map((e) => idIndent + '- id: ' + e.id + '\n' + idIndent + '  name: ' + PLUGIN_DIR + '/' + e.file).join('\n')
    lines.splice(lastSeg.end, 0, rows)
    return {
      action: 'heal',
      missing,
      next: lines.join('\n'),
      why: 'insert 段缺 ' + missing.map((e) => e.id).join(', ') + '（升级重写 patch 时可能被丢）—— 补齐',
    }
  }
  const block = [
    '',
    '# ── task-warden 的 6 个常驻 Host 插件（drift-heal 重建）──────────────────',
    '- insert:',
    ...expected.map((e) => '    - id: ' + e.id + '\n      name: ' + PLUGIN_DIR + '/' + e.file),
    '',
  ].join('\n')
  const sep = src.endsWith('\n') ? '' : '\n'
  return { action: 'heal', missing, next: src + sep + block, why: 'patch 里一个 insert 段都没有 —— 按期望重建六插件挂载' }
}

/* ---------------------------------------------------------- ③ autonomy.json */

/**
 * 纯函数：R34 放权开关（用户 2026-09-29 拍板 on）。
 * 返回 { action: 'ok' | 'heal', current?, next?, why }
 *  - JSON 损坏（升级写坏/BOM/截断）→ 重建最小 JSON
 *  - mode 不是期望 → 只改 mode 与 at，**保留其它字段**
 */
export function evaluateAutonomyJson(text, mode = EXPECT.autonomyMode, nowIso = new Date().toISOString()) {
  const raw = deBOM(text).trim()
  let o = null
  try { o = JSON.parse(raw) } catch (e) { o = null }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    const next = JSON.stringify({ mode, why: 'R34 放权开关（drift-heal 重建：原文件损坏）', at: nowIso.slice(0, 10) }, null, 2)
    return { action: 'heal', current: null, next, why: 'autonomy.json 解析失败（损坏/BOM/截断）—— 重建，mode=' + mode }
  }
  if (String(o.mode || '').toLowerCase() === mode) {
    return { action: 'ok', current: o.mode, why: 'autonomy 已是 ' + mode + '，不动' }
  }
  const next = JSON.stringify({ ...o, mode, at: nowIso.slice(0, 10) }, null, 2)
  return { action: 'heal', current: o.mode, next, why: '发现放权开关被改成「' + o.mode + '」—— 按用户 2026-09-29 拍板改回 ' + mode }
}

/* ---------------------------------------------------------- IO：probe / heal / 原子写 */

/**
 * 原子写（沿用 preset-default-guard 的手法）：写前留备份 → tmp → rename → 失败退回直接写。
 * 文件不存在（重建场景）不备份。任何异常不抛。
 */
function atomicWrite(file, content, now) {
  const out = { writeMode: null, backup: null }
  try {
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    if (fs.existsSync(file)) {
      const backup = file + '.bak-heal-' + stamp
      try {
        fs.writeFileSync(backup, fs.readFileSync(file, 'utf8'), 'utf8')
        out.backup = backup
      } catch (e) { out.backup = null }
    }
    const tmp = file + '.tmp-heal-' + String(process.pid)
    try {
      fs.writeFileSync(tmp, content, 'utf8')
      fs.renameSync(tmp, file)
      out.writeMode = 'atomic-rename'
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch (_) { /* 清不掉就算了 */ }
      fs.writeFileSync(file, content, 'utf8')
      out.writeMode = 'direct-write'
    }
  } catch (e) {
    out.writeMode = 'failed:' + String((e && e.message) || e).slice(0, 120)
  }
  return out
}

/**
 * 只读不写的一轮巡检（probe）。给 warden-watch 做「连看两次才动手」的第一眼。
 * 返回 { at, items: [{check, action, current?, missing?, err?, why}] }
 */
export function probe({ patchPath, settingsPath, autonomyPath, presetGuard = null, now = new Date() } = {}) {
  const at = now.toISOString()
  const items = []
  if (presetGuard && typeof presetGuard.evaluateSettings === 'function' && settingsPath) {
    try {
      if (fs.existsSync(settingsPath)) {
        const pre = presetGuard.evaluateSettings(fs.readFileSync(settingsPath, 'utf8'), EXPECT.presetDefault)
        items.push({ check: 'settings-preset', action: pre.action, current: pre.current ?? null, why: pre.why })
      } else {
        // ⚠ 这就是 2026-09-28/29 事故的根：老守卫在这里对着死文件每轮打空（593 次 ENOENT）。
        //   现在明确记成 skipped-missing，自动转守 patch 层 —— 不打空、不报 error。
        items.push({ check: 'settings-preset', action: 'skipped-missing', why: 'settings.yaml 不存在（升级已迁移）—— 自动转守 patch 层' })
      }
    } catch (e) {
      items.push({ check: 'settings-preset', action: 'error', err: String((e && e.message) || e).slice(0, 200) })
    }
  }
  try {
    if (patchPath && fs.existsSync(patchPath)) {
      const src = fs.readFileSync(patchPath, 'utf8')
      const p = evaluatePresetInPatch(src, EXPECT.presetDefault)
      items.push({ check: 'patch-preset', action: p.action, current: p.current ?? null, why: p.why })
      const ins = evaluateInserts(src, EXPECT.inserts)
      items.push({ check: 'patch-inserts', action: ins.action, missing: ins.missing ?? [], why: ins.why })
    } else {
      items.push({ check: 'patch', action: 'error', err: 'patch 文件不存在: ' + String(patchPath) })
    }
  } catch (e) {
    items.push({ check: 'patch', action: 'error', err: String((e && e.message) || e).slice(0, 200) })
  }
  try {
    if (autonomyPath && fs.existsSync(autonomyPath)) {
      const r = evaluateAutonomyJson(fs.readFileSync(autonomyPath, 'utf8'), EXPECT.autonomyMode, at)
      items.push({ check: 'autonomy', action: r.action, current: r.current ?? null, why: r.why })
    } else {
      items.push({ check: 'autonomy', action: 'rebuild', why: 'autonomy.json 丢失 —— 按期望重建 mode=' + EXPECT.autonomyMode })
    }
  } catch (e) {
    items.push({ check: 'autonomy', action: 'error', err: String((e && e.message) || e).slice(0, 200) })
  }
  return { at, items }
}

/**
 * 一轮巡检 + 对需要动手的项落盘（写前备份、原子写）。任何单项失败不拖垮其它项。
 * ⚠ patch preset 的「两击」规则由调用方（warden-watch 的 strikes）负责：先 probe 连看两次，
 *   再调 healAll 落盘 —— 撕裂/陈旧读不许直接写文件（沿用 preset-default-guard 约束）。
 */
export function healAll(opts = {}) {
  const now = opts.now || new Date()
  const rep = probe({ ...opts, now })
  const written = []
  const patchPath = opts.patchPath
  const autonomyPath = opts.autonomyPath
  try {
    if (patchPath && fs.existsSync(patchPath)) {
      const src = fs.readFileSync(patchPath, 'utf8')
      const p = evaluatePresetInPatch(src, EXPECT.presetDefault)
      // ⚠ inserts 必须基于 **preset 已修的文本** 继续算（2026-09-29 自检抓出来的 bug：
      //   原来基于 src 算 inserts，追加段把 preset 的 roles 修改整个丢掉 ⇒ 永远差一步）。
      const ins = evaluateInserts(p.next ?? src, EXPECT.inserts)
      const finalText = ins.next ?? p.next ?? src
      if (finalText !== src) {
        const w = atomicWrite(patchPath, finalText, now)
        written.push({
          check: 'patch',
          actions: [p.action, ins.action].filter((a) => a === 'heal' || a === 'absent'),
          backup: w.backup,
          writeMode: w.writeMode,
          why: [p.why, ins.why].filter(Boolean).join('；'),
        })
      }
    }
  } catch (e) {
    written.push({ check: 'patch', action: 'error', err: String((e && e.message) || e).slice(0, 200) })
  }
  try {
    if (autonomyPath) {
      const repA = rep.items.find((i) => i.check === 'autonomy')
      if (repA && (repA.action === 'heal' || repA.action === 'rebuild')) {
        let next = null
        if (repA.action === 'rebuild') {
          next = JSON.stringify({ mode: EXPECT.autonomyMode, why: 'R34 放权开关（drift-heal 重建）', at: rep.at.slice(0, 10) }, null, 2)
        } else {
          next = evaluateAutonomyJson(fs.readFileSync(autonomyPath, 'utf8'), EXPECT.autonomyMode, rep.at).next
        }
        if (next) {
          const w = atomicWrite(autonomyPath, next, now)
          written.push({ check: 'autonomy', action: repA.action, backup: w.backup, writeMode: w.writeMode, why: repA.why })
        }
      }
    }
  } catch (e) {
    written.push({ check: 'autonomy', action: 'error', err: String((e && e.message) || e).slice(0, 200) })
  }
  return { ...rep, written }
}

/* ------------------------------------------------------------------ 自检 */
function selftest() {
  const cases = []
  const T = (name, got, want) => cases.push({ name, got, want, ok: got === want })
  const has = (name, got, re) => cases.push({ name, got: re.test(String(got)), want: true, ok: re.test(String(got)) })

  // ① patch 层 preset：standard → heal，default 与 selectedDefault 都改、其余一字不动
  const a = [
    '- id: agent-preset-registry',
    '  name: "@deepseek-ai/dsh-agent-preset-registry"',
    '  config:',
    '    default: standard',
    '    selectedDefault: standard',
  ].join('\n')
  const ra = evaluatePresetInPatch(a)
  T('①a standard → heal', ra.action, 'heal')
  T('①b 两值都改回 roles', (ra.next.match(/: roles/g) || []).length, 2)
  T('①c name 行不动', ra.next.includes('"@deepseek-ai/dsh-agent-preset-registry"'), true)

  // ② 已是 roles → ok
  const b = '- id: agent-preset-registry\n  config:\n    default: roles\n    selectedDefault: roles\n'
  T('② roles → ok', evaluatePresetInPatch(b).action, 'ok')

  // ③ 行内注释保留 + CRLF
  const c = '- id: agent-preset-registry\r\n  config:\r\n    default: standard   # 我的手写注释\r\n    selectedDefault: standard\r\n'
  const rc = evaluatePresetInPatch(c)
  T('③a CRLF+注释 → heal', rc.action, 'heal')
  T('③b 注释原样保留', rc.next.includes('# 我的手写注释'), true)

  // ④ 块缺失 → absent（重建整段），原内容保留
  const rd = evaluatePresetInPatch('- id: ui-chat\n  config:\n    a: 1\n')
  T('④a 缺块 → absent', rd.action, 'absent')
  T('④b 重建后 default=roles', rd.next.includes('default: roles'), true)
  T('④c 原内容保留', rd.next.includes('a: 1'), true)

  // ⑤ inserts：齐全 → ok
  const full = '- insert:\n    - id: warden-watch\n      name: X/warden-watch.js\n'
  T('⑤ 齐全 → ok', evaluateInserts(full, [{ id: 'warden-watch', file: 'warden-watch.js' }]).action, 'ok')

  // ⑥ inserts：缺五条 → heal 补齐，缩进对齐 4 空格
  const lack = '- insert:\n    - id: warden-watch\n      name: X/warden-watch.js\n'
  const rl = evaluateInserts(lack, EXPECT.inserts)
  T('⑥a 缺失 → heal', rl.action, 'heal')
  T('⑥b 补出 5 条', (rl.next.match(/- id: (context-dedup|role-voices|handover-gate|branch-guard|report-spill)/g) || []).length, 5)
  T('⑥c 缩进对齐 4 空格', rl.next.includes('\n    - id: context-dedup'), true)

  // ⑦ 没有任何 insert 段 → 追加整段
  const r0 = evaluateInserts('- id: ui-chat\n  config:\n    a: 1\n', EXPECT.inserts)
  T('⑦a 无段 → heal', r0.action, 'heal')
  T('⑦b 六条都补', (r0.next.match(/- id: /g) || []).length >= 6, true)

  // ⑧ autonomy：off → heal on，保留其它字段
  const ra8 = evaluateAutonomyJson('{"mode":"off","why":"R34 放权开关","at":"2026-09-24"}', 'on', '2026-09-29T00:00:00.000Z')
  T('⑧a off → heal', ra8.action, 'heal')
  T('⑧b mode=on', ra8.next.includes('"mode": "on"'), true)
  T('⑧c why 字段保留', ra8.next.includes('R34 放权开关'), true)

  // ⑨ autonomy：on → ok
  T('⑨ on → ok', evaluateAutonomyJson('{"mode":"on","at":"2026-09-29"}', 'on').action, 'ok')

  // ⑩ autonomy：BOM 不炸（PowerShell Set-Content 实测写 BOM）
  T('⑩ BOM → heal', evaluateAutonomyJson('\uFEFF{"mode":"off"}', 'on').action, 'heal')

  // ⑪ autonomy：损坏 JSON → 重建
  const rb11 = evaluateAutonomyJson('{mode: off', 'on')
  T('⑪a 损坏 → heal(重建)', rb11.action, 'heal')
  T('⑪b 重建后可解析', JSON.parse(rb11.next).mode, 'on')

  // ⑫ probe：三文件全缺 → 明确分级，不抛异常
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-heal-test-'))
  const rp = probe({ patchPath: path.join(tmpd, 'no-such.patch.yml'), settingsPath: path.join(tmpd, 'no-such-settings.yaml'), autonomyPath: path.join(tmpd, 'autonomy.json'), presetGuard: null })
  const byCheck = (name) => rp.items.find((i) => i.check === name)
  // ⑫a presetGuard=null 时 settings 检查整个跳过（items 里没有它）—— 不打空
  T('⑫a presetGuard=null 不查 settings', byCheck('settings-preset'), undefined)
  T('⑫b patch 不存在 → error 不抛', byCheck('patch').action, 'error')
  T('⑫c autonomy 不存在 → rebuild', byCheck('autonomy').action, 'rebuild')

  // ⑫d settings.yaml 存在但 presetGuard=null → 也不查（不炸）
  const rp2 = probe({ patchPath: path.join(tmpd, 'no-such.patch.yml'), settingsPath: tmpd, autonomyPath: path.join(tmpd, 'autonomy.json'), presetGuard: null })
  T('⑫d settingsPath 是目录/无守卫 → 不查 settings', rp2.items.find((i) => i.check === 'settings-preset'), undefined)

  // ⑬ healAll：真实 tmp 文件 round-trip（drift 的 patch + autonomy → heal → 复读确认）
  const patchFile = path.join(tmpd, 'cordis.patch.yml')
  fs.writeFileSync(patchFile, a + '\n', 'utf8')
  const autoFile = path.join(tmpd, 'autonomy.json')
  fs.writeFileSync(autoFile, '{"mode":"off","why":"R34","at":"2026-09-24"}', 'utf8')
  const rh = healAll({ patchPath: patchFile, settingsPath: path.join(tmpd, 'no.yaml'), autonomyPath: autoFile, presetGuard: null })
  T('⑬a healAll 落盘 patch', rh.written.some((w) => w.check === 'patch' && w.backup), true)
  T('⑬b healAll 落盘 autonomy', rh.written.some((w) => w.check === 'autonomy'), true)
  T('⑬c 复读已是 roles', evaluatePresetInPatch(fs.readFileSync(patchFile, 'utf8')).action, 'ok')
  T('⑬d autonomy 复读已是 on', JSON.parse(fs.readFileSync(autoFile, 'utf8')).mode, 'on')

  // ⑭ 稳态二连：第二次 healAll 应为 no-op（不产生任何写入）
  const rh2 = healAll({ patchPath: patchFile, settingsPath: path.join(tmpd, 'no.yaml'), autonomyPath: autoFile, presetGuard: null })
  T('⑭ 稳态不再写', rh2.written.length, 0)

  try { fs.rmSync(tmpd, { recursive: true, force: true }) } catch (e) { /* 清不掉就算了 */ }

  const bad = cases.filter((x) => !x.ok)
  for (const x of bad) console.error('FAIL: ' + x.name + ' got=' + JSON.stringify(x.got) + ' want=' + JSON.stringify(x.want))
  console.log('drift-heal selftest: ' + (cases.length - bad.length) + '/' + cases.length + ' passed')
  return bad.length === 0
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('drift-heal.mjs')
if (isMain) {
  const ok = selftest()
  process.exit(ok ? 0 : 1)
}