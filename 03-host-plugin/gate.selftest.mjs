/**
 * R36 自检：`node gate.selftest.mjs` → 退出码 0（全绿）/ 1（有红）。
 * **不依赖 DSH**：只用 node 标准库 + 真 fs，在系统临时目录里造工程夹具。
 *
 * 覆盖（至少这 6 个，编号与派单一致）：
 *   ① 目标文件不是被盯的 → allow
 *   ② 被盯 + 最近一轮 done 且之后无快照 → deny，且 reason 含 `snapshot --label`
 *   ③ 被盯 + done 之后有快照 → allow
 *   ④ 没有 .warden 的目录 → allow
 *   ⑤ 喂坏数据让它抛异常 → allow（fail-open）
 *   ⑥ 正常迭代不许误拦：先 record 成 in_progress，再连写同一文件 5 次 → 0 次 deny
 * 另加 ⑦~⑩ 把那两处**刻意收紧**的判据钉住（见 PROGRESS-r36.md）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { preToolDecision } from './gate.mjs'

let fails = 0
const rows = []

function check(no, title, ok, extra) {
  if (!ok) fails += 1
  rows.push(`${ok ? 'ok  ' : 'FAIL'}  ${no}  ${title}${extra ? '  —— ' + extra : ''}`)
}

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'r36-gate-selftest-'))
process.on('exit', () => {
  try { fs.rmSync(BASE, { recursive: true, force: true }) } catch (e) { /* 清不掉就算了 */ }
})

const WATCHES = [
  'watches:',
  '  - id: watched_x',
  '    label: 被盯的档位',
  '    kind: rust_const',
  '    file: src/watched.rs',
  '    name: WATCHED_X',
  '',
].join('\n')

const T_DONE = '2026-09-16T13:36:52.804Z'
const T_SNAP_LATE = '2026-09-16T13:40:00.000Z'
const T_SNAP_EARLY = '2026-09-16T13:00:00.000Z'

function mkProject(name, o) {
  const root = path.join(BASE, name)
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  const wd = path.join(root, '.warden')
  fs.mkdirSync(wd, { recursive: true })
  fs.writeFileSync(path.join(wd, 'params.yml'), o.watches ?? WATCHES, 'utf8')
  fs.writeFileSync(path.join(wd, 'ROUNDS.jsonl'), o.rounds ?? '', 'utf8')
  for (const s of o.snapshots ?? []) {
    const d = path.join(wd, 'snapshots', s.name)
    fs.mkdirSync(d, { recursive: true })
    if (s.broken) { fs.writeFileSync(path.join(d, 'manifest.json'), '{ not json', 'utf8'); continue }
    fs.writeFileSync(path.join(d, 'manifest.json'),
      JSON.stringify({ label: s.label ?? '', at: s.at, values: {}, files: [] }, null, 2), 'utf8')
  }
  for (const f of o.files ?? ['src/watched.rs']) {
    const p = path.join(root, f)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'const WATCHED_X: f32 = 1.4;\n', 'utf8')
  }
  return root
}

const round = (o) => JSON.stringify(o)

function dec(toolName, filePath, cwd) {
  return preToolDecision({ toolName, toolArgs: { file_path: filePath }, cwd })
}

// ---------------------------------------------------------------- ①②③
// 同一份夹具：R2 最新一轮 done（2026-09-16T13:36:52.804Z），一开始没有任何快照
const P1 = mkProject('p1', {
  files: ['src/watched.rs', 'src/other.rs'],
  rounds: [
    round({ round: 1, requirement: 'R1', status: 'not_started', at: '2026-09-16T13:36:51.436Z' }),
    round({ round: 2, requirement: 'R2', status: 'done', delivered: '做完了', evidence: 'src/watched.rs:1', at: T_DONE }),
    '',
  ].join('\n'),
})

{
  const d = dec('edit', path.join(P1, 'src', 'other.rs'), P1)
  check('①', '不是被盯的文件 → allow', d.kind === 'allow', `kind=${d.kind}`)
}
{
  const d = dec('edit', path.join(P1, 'src', 'watched.rs'), P1)
  const ok = d.kind === 'deny'
    && typeof d.reason === 'string'
    && d.reason.includes('snapshot --label')
    && d.reason.includes('R2')
  check('②', '被盯 + 最近一轮 done + 之后无快照 → deny（reason 带命令与真实需求号）',
    ok, `kind=${d.kind} reason=${JSON.stringify(String(d.reason).split('\n')[3] ?? '')}`)
}
{
  // 补一份**晚于**那条 done 的快照
  const sd = path.join(P1, '.warden', 'snapshots', '2026-09-16T13-40-00-改_R2_之前')
  fs.mkdirSync(sd, { recursive: true })
  fs.writeFileSync(path.join(sd, 'manifest.json'),
    JSON.stringify({ label: '改 R2 之前', at: T_SNAP_LATE, values: {}, files: [] }, null, 2), 'utf8')
  const d = dec('edit', path.join(P1, 'src', 'watched.rs'), P1)
  check('③', 'done 之后有快照 → allow', d.kind === 'allow', `kind=${d.kind}`)
}

// ---------------------------------------------------------------- ④
{
  const plain = path.join(BASE, 'no-warden')
  fs.mkdirSync(path.join(plain, '.git'), { recursive: true })
  fs.mkdirSync(path.join(plain, 'src'), { recursive: true })
  const f = path.join(plain, 'src', 'watched.rs')
  fs.writeFileSync(f, 'x\n', 'utf8')
  const d = dec('write', f, plain)
  check('④', '没有 .warden 的目录 → allow', d.kind === 'allow', `kind=${d.kind}`)
}
{
  // ④b：最近一层有 .git 但**没有** .warden，更高层有 → 也 allow（按"同一层"判，不往上借）
  const outer = mkProject('outer', {
    files: ['inner/src/watched.rs'],
    rounds: round({ round: 1, requirement: 'R9', status: 'done', at: T_DONE }) + '\n',
    watches: WATCHES.replace('file: src/watched.rs', 'file: inner/src/watched.rs'),
  })
  fs.mkdirSync(path.join(outer, 'inner', '.git'), { recursive: true })
  const f = path.join(outer, 'inner', 'src', 'watched.rs')
  const d = dec('edit', f, outer)
  check('④b', '最近的 .git 层没有 .warden（更高层才有）→ allow', d.kind === 'allow', `kind=${d.kind}`)
}

// ---------------------------------------------------------------- ⑤ fail-open
{
  const cases = []
  // a) 输入整个是坏的
  try { cases.push(['null 输入', preToolDecision(null)]) } catch (e) { cases.push(['null 输入', { kind: 'THREW' }]) }
  // b) 参数取值时抛
  let b = null
  try {
    b = preToolDecision({
      toolName: 'write',
      toolArgs: { get file_path() { throw new Error('boom-args') } },
      cwd: BASE,
    })
  } catch (e) { b = { kind: 'THREW' } }
  cases.push(['参数 getter 抛异常', b])
  // c) 注入的 fs 全抛
  let c = null
  try {
    c = preToolDecision(
      { toolName: 'edit', toolArgs: { file_path: path.join(P1, 'src', 'watched.rs') }, cwd: P1 },
      { fs: new Proxy({}, { get() { throw new Error('boom-fs') } }), path })
  } catch (e) { c = { kind: 'THREW' } }
  cases.push(['注入的 fs 全抛', c])
  // d) deps 整个是坏的
  let d0 = null
  try { d0 = preToolDecision({ toolName: 'edit', toolArgs: { file_path: 'x' } }, 12345) } catch (e) { d0 = { kind: 'THREW' } }
  cases.push(['deps 不是对象', d0])
  // e) params.yml / ROUNDS.jsonl 是坏文本、manifest 是坏 JSON
  const bad = mkProject('bad-text', {
    watches: 'watches: [ {{{ 这不是 YAML\n  - : : :\n',
    rounds: '{{{ 不是 JSON\n[1,2,3\n# 注释\n',
    snapshots: [{ name: 'broken', broken: true }],
  })
  let e0 = null
  try { e0 = dec('edit', path.join(bad, 'src', 'watched.rs'), bad) } catch (err) { e0 = { kind: 'THREW' } }
  cases.push(['坏 params/ROUNDS/manifest', e0])
  const badOnes = cases.filter(([, r]) => !r || r.kind !== 'allow')
  check('⑤', '喂坏数据（都会抛）→ 一律 allow（fail-open）',
    badOnes.length === 0, badOnes.map(([n, r]) => `${n}:${r && r.kind}`).join(', ') || `${cases.length} 个子用例全 allow`)
}
{
  // ⑤b：连 console 都没了的极端情况下也不许抛
  const savedErr = console.error
  let r = null
  try {
    console.error = () => { throw new Error('no console') }
    r = preToolDecision(
      { toolName: 'edit', toolArgs: { file_path: path.join(P1, 'src', 'watched.rs') }, cwd: P1 },
      { fs: new Proxy({}, { get() { throw new Error('boom') } }), path })
  } catch (e) { r = { kind: 'THREW' } } finally { console.error = savedErr }
  check('⑤b', '判据抛 + console.error 也抛 → 仍然 allow', r && r.kind === 'allow', `kind=${r && r.kind}`)
}

// ---------------------------------------------------------------- ⑥ 正常迭代
{
  const p6 = mkProject('p6', {
    rounds: [
      round({ round: 1, requirement: 'R1', status: 'done', delivered: '第一版', evidence: 'src/watched.rs:1', at: T_DONE }),
      round({ round: 2, requirement: 'R2', status: 'in_progress', delivered: '正在改手感', at: '2026-09-16T13:50:00.000Z' }),
      '',
    ].join('\n'),
    // 故意**不给快照**：R1 是 done 且之后没有快照。若判据写成"任一需求最新一轮 done"就会误拦
  })
  const out = []
  for (let i = 0; i < 5; i += 1) out.push(dec('edit', path.join(p6, 'src', 'watched.rs'), p6).kind)
  const denies = out.filter((k) => k === 'deny').length
  check('⑥', 'record 成 in_progress 后连写同一文件 5 次 → 0 次 deny',
    denies === 0, `${out.join(',')}（deny ${denies} 次）`)
}

// ---------------------------------------------------------------- ⑦ 只对写文件工具生效
{
  const f = path.join(P1, 'src', 'watched.rs')
  const r1 = dec('read', f, P1).kind
  const r2 = dec('glob', f, P1).kind
  const r3 = preToolDecision({ toolName: 'write', toolArgs: { path: f }, cwd: P1 }).kind
  const r4 = preToolDecision({ toolName: 'write', toolArgs: { file_path: '   ' }, cwd: P1 }).kind
  const ok = [r1, r2, r3, r4].every((k) => k === 'allow')
  check('⑦', '非 edit/write、或没有 file_path → allow', ok, `${r1},${r2},${r3},${r4}`)
}

// ---------------------------------------------------------------- ⑧ 刻意收紧：文件还不存在
{
  // P1 此刻已有晚快照 → 换个"done 且无晚快照"的夹具才测得出差别
  const p8 = mkProject('p8', {
    files: ['src/other.rs'],   // src/watched.rs **不创建**
    rounds: round({ round: 1, requirement: 'R3', status: 'done', at: T_DONE }) + '\n',
  })
  const d = dec('write', path.join(p8, 'src', 'watched.rs'), p8)
  check('⑧', '被盯但文件还不存在 → allow（刻意收紧：takeSnapshot 拷不到它，deny 会成死结）',
    d.kind === 'allow', `kind=${d.kind}`)
}

// ---------------------------------------------------------------- ⑨ 早于 done 的快照不算备份
{
  const p9 = mkProject('p9', {
    rounds: round({ round: 1, requirement: 'R4', status: 'done', at: T_DONE }) + '\n',
    snapshots: [{ name: '2026-09-16T13-00-00-太早', label: '太早', at: T_SNAP_EARLY }],
  })
  const d = dec('edit', path.join(p9, 'src', 'watched.rs'), p9)
  check('⑨', '快照早于那条 done → 仍 deny（与 reopenGate 同口径）', d.kind === 'deny', `kind=${d.kind}`)
}

// ---------------------------------------------------------------- ⑩ 坏快照不算备份
{
  const p10 = mkProject('p10', {
    rounds: round({ round: 1, requirement: 'R5', status: 'done', at: T_DONE }) + '\n',
    snapshots: [{ name: '2026-09-16T13-50-00-坏的', broken: true }],
  })
  const d = dec('edit', path.join(p10, 'src', 'watched.rs'), p10)
  check('⑩', 'manifest.json 是坏 JSON 的快照 → 不算备份 → deny（与 reopenGate 同口径）',
    d.kind === 'deny', `kind=${d.kind}`)
}

// ---------------------------------------------------------------- ⑪ 路径口径
{
  // 注意：上面 ③ 已经给 P1 补了晚快照，所以这里必须另起一个"done 且无晚快照"的夹具
  const p11 = mkProject('p11', {
    rounds: round({ round: 1, requirement: 'R6', status: 'done', at: T_DONE }) + '\n',
  })
  const f = path.join(p11, 'src', 'watched.rs')
  const weird = f.replace(/\\/g, '/').toUpperCase()      // Windows：大小写 + 正斜杠都不敏感
  const d1 = dec('edit', weird, p11)
  const d2 = dec('edit', path.join('src', 'watched.rs'), p11)   // 相对路径按 cwd 解析
  check('⑪', '大小写/正斜杠/相对路径都认得出来（Windows 口径）',
    d1.kind === 'deny' && d2.kind === 'deny', `${d1.kind},${d2.kind}`)
}

// ---------------------------------------------------------------- ⑫ 接线：真插件 + 假 ctx（不启 DSH）
{
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  let plugin = null
  let loadErr = ''
  try { plugin = req('./warden-watch.js') } catch (e) { loadErr = String((e && e.message) || e) }
  const handlers = {}
  if (plugin && typeof plugin.apply === 'function') {
    plugin.apply({
      shell: {
        run: () => Promise.resolve({ stdout: { text: '{}' }, exitCode: 0 }),
        resolve: (x) => x,
      },
      on: (n, f) => { handlers[n] = f; return () => {} },
    })
  }
  const h = handlers['tools/pre-execute']
  const next = () => Promise.resolve({ kind: 'allow' })
  const p12 = mkProject('p12', {
    rounds: round({ round: 1, requirement: 'R8', status: 'done', at: T_DONE }) + '\n',
  })
  let r = null
  let r2 = null
  try {
    r = h ? await h({ name: 'write', arguments: { file_path: path.join(p12, 'src', 'watched.rs') } }, next) : null
    r2 = h ? await h(null, next) : null
  } catch (e) { loadErr = String((e && e.message) || e) }
  check('⑫', '真插件挂上 tools/pre-execute 且真返回 deny（假 ctx，不启 DSH）',
    !!h && r && r.kind === 'deny' && String(r.reason).includes('snapshot --label') && r2 && r2.kind === 'allow',
    h ? `kind=${r && r.kind} / 坏输入=${r2 && r2.kind}` : `没注册 tools/pre-execute ${loadErr}`)
  check('⑫b', '原有 agent/turn-stopping 监听仍在（硬约束：那部分一行不动）',
    typeof handlers['agent/turn-stopping'] === 'function')

  // ⑬~⑮ shell 类工具（2026-09-17 新增；补 R12 保留项："pwsh 一条命令绕过整道闸"）
  //   ⚠ 这三条**直接测闸本体**（`gate.preToolDecision` 带显式 `cwd`），不走插件那层 ——
  //     因为插件只传会话工作区（`CWDS`），而夹具在系统临时目录里、不在工作区内；
  //     插件那层的接线由 ⑫ 负责测。这是"测哪一层"的问题，不是"能不能拦"的问题
  //     （我第一版就是走了插件那层，于是 ⑬ 假红了一次）。
  const p13 = mkProject('p13', {
    rounds: round({ round: 1, requirement: 'R8', status: 'done', at: T_DONE }) + '\n',
  })
  const watchedAbs = path.join(p13, 'src', 'watched.rs')
  const unwatchedAbs = path.join(p13, 'src', 'other.rs')
  let w13 = null; let r13 = null; let r14 = null
  try {
    w13 = preToolDecision({
      toolName: 'pwsh',
      toolArgs: { command: `Set-Content -Path '${watchedAbs}' -Value 'x'` },
      cwd: p13,
    })
    r13 = preToolDecision({
      toolName: 'pwsh',
      toolArgs: { command: `Get-Content '${watchedAbs}'` },
      cwd: p13,
    })
    r14 = preToolDecision({
      toolName: 'pwsh',
      toolArgs: { command: `Set-Content -Path '${unwatchedAbs}' -Value 'x'` },
      cwd: p13,
    })
  } catch (e) { loadErr = String((e && e.message) || e) }
  check('⑬', 'shell 写被盯的档位文件 ⇒ deny（原来这里是零 IO 放行）',
    !!w13 && w13.kind === 'deny' && String(w13.reason).includes('snapshot --label'),
    w13 ? `kind=${w13.kind}` : `没返回 ${loadErr}`)
  check('⑭', 'shell **只读**同一个文件 ⇒ allow（读不会改坏数据）',
    !!r13 && r13.kind === 'allow',
    r13 ? `kind=${r13.kind}` : `没返回 ${loadErr}`)
  check('⑮', 'shell 写**没被盯**的文件 ⇒ allow（那不是这道闸的职责）',
    !!r14 && r14.kind === 'allow',
    r14 ? `kind=${r14.kind}` : `没返回 ${loadErr}`)

  // ⑯~⑰ **交付闸**（2026-09-17 用户点名：让 present 交付动作本身过闸）
  const SPEC_P = [
    '# 需求账本', '',
    '## R1 · 自由创作', '',
    '- 原话: 编的原话',
    '- 必须: 方向自由',
    '- 不要: 不许把绘制锁死在一张平面',
    '- 子项: 甲 | 乙',
    '- 锁定: 2026-09-17', '',
  ].join('\n')
  const p16 = mkProject('p16', {
    rounds: round({ round: 1, requirement: 'R1', status: 'done', at: T_DONE, covered: ['甲', '乙'] }) + '\n',
  })
  fs.writeFileSync(path.join(p16, '.warden', 'SPEC.md'), SPEC_P, 'utf8')
  let v16 = null
  try {
    v16 = preToolDecision({ toolName: 'present', toolArgs: { files: [{ path: path.join(p16, 'docs', 'x.md') }] }, cwd: p16 })
  } catch (e) { loadErr = String((e && e.message) || e) }
  check('⑯', 'present 交付：有「不要」没交代 ⇒ **deny**（check 是自愿跑的，交付闸不是）',
    !!v16 && v16.kind === 'deny' && String(v16.reason).includes('不许把绘制锁死在一张平面'),
    v16 ? `kind=${v16.kind}` : `没返回 ${loadErr}`)

  const p17 = mkProject('p17', {
    rounds: round({ round: 1, requirement: 'R1', status: 'done', at: T_DONE, covered: ['甲', '乙'],
      avoided: ['不许把绘制锁死在一张平面=画布锚在活刷尖，随鼠标移动'] }) + '\n',
  })
  fs.writeFileSync(path.join(p17, '.warden', 'SPEC.md'), SPEC_P, 'utf8')
  // ⚠ 还要给它一条**收尾对账**记录 —— 否则会撞上交付闸的第二条判据（R14：报了 done 就要有对账）。
  //   我第一版没写，⑰ 就红了（正控被另一条判据拦住，不是防误伤失败）。
  fs.writeFileSync(path.join(p17, '.warden', 'RECON.jsonl'),
    JSON.stringify({ at: T_DONE, kind: 'results', session: '', planned: ['R1'], quotes: 1, gaps: 0, lastRound: 1 }) + '\n', 'utf8')
  let v17 = null
  try {
    v17 = preToolDecision({ toolName: 'present', toolArgs: { files: [{ path: path.join(p17, 'docs', 'x.md') }] }, cwd: p17 })
  } catch (e) { loadErr = String((e && e.message) || e) }
  check('⑰', 'present 交付：逐条交代过 ⇒ allow（正控，防误伤）',
    !!v17 && v17.kind === 'allow',
    v17 ? `kind=${v17.kind}` : `没返回 ${loadErr}`)
}

// ---------------------------------------------------------------- 输出
const tail = rows.join('\n')
console.log(tail)
console.log(fails === 0
  ? `\n全绿：${rows.length} 项用例，0 红。（夹具在系统临时目录，跑完自删）`
  : `\n有红：${rows.length} 项里 ${fails} 项不过。`)
process.exit(fails === 0 ? 0 : 1)
