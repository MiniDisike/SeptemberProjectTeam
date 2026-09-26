// check-plugins-loaded.mjs 的自检 —— 证明**三种状态真的分得开**（尤其"查不到"不许冒充成功）。
// 用法：node check-plugins-loaded.selftest.mjs
//
// 为什么必须有它：本项目铁律 A6 ——「没查到」≠「查过了没问题」。
//   判据若退化成"没有错误就是通过"，这三态就会合并成一句"OK" ⇒ 用户拿到假证据。
//   所以这里**每个状态都必须有一条正控**，并且**必须有一条负控**证明判据不是恒真。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'check-plugins-loaded.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cpl-selftest-'))
const require = createRequire(import.meta.url)

let ok = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { ok++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + '  ' + (detail || '')) }
}

/**
 * ★ 本会话沙箱禁止子进程的**管道 stdio**（实测 `spawnSync(node,['-e',…])` ⇒
 *   `status=null, error=EPERM`）⇒ 不能靠 spawn 子进程来拿"用户看到的退出码"。
 *   改法：**在进程内把 main() 真跑一遍**，拦住它的 exit 与 stdout —— 拿到的东西
 *   与用户跑命令行**同一个函数**产生的（不是抄一份内部逻辑，是同一份代码路径）。
 */
async function runInProcess(args) {
  const { main } = await import(pathToFileURL(SCRIPT).href)
  const out = []
  const ow = process.stdout.write.bind(process.stdout)
  const realExit = process.exit
  let code = 0
  process.stdout.write = (s) => { out.push(String(s)); return true }
  process.exit = (c) => { code = (c === undefined ? 0 : c); throw new ExitSignal() }
  try {
    main(args)
  } catch (e) {
    if (!(e instanceof ExitSignal)) { process.stdout.write = ow; process.exit = realExit; throw e }
  } finally {
    process.stdout.write = ow
    process.exit = realExit
  }
  return { code, out: out.join('') }
}
class ExitSignal extends Error {}

/** 用假 ctx 把指定插件真跑一遍，写进 dir（**在进程内**，不开子进程）。 */
function applyPlugins(dir, ids) {
  process.env.WARDEN_PLUGIN_LEDGER = dir
  const errs = []
  for (const m of ids) {
    let mod
    try { mod = require(path.join(HERE, m + '.js')) } catch (e) { errs.push(m + ' require: ' + e.message); continue }
    const ctx = {
      id: 'host-' + m,
      logger: { warn() {}, info() {}, error() {} },
      on() { return () => {} },
      effect(f) { try { const d = f(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
      get() { return undefined },
      shell: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
    }
    try { mod.apply(ctx, {}) } catch (e) { errs.push(m + ' apply: ' + e.message) }
  }
  return errs.join('; ')
}

const ALL = ['context-dedup', 'role-voices', 'handover-gate', 'branch-guard', 'report-spill', 'warden-watch']

// ─────────────── ① 查不到（not-found）⇒ 必须 exit 2，且**不许**说"通过/正常" ───────────────
console.log('--- ① 落点不存在 ⇒ 查不到（exit 2），且不许冒充成功 ---')
const empty = path.join(TMP, 'empty')
fs.mkdirSync(empty, { recursive: true })
const r1 = await runInProcess(['--dir', empty])
check('① exit code = 2（不是 0）', r1.code === 2, 'got ' + r1.code)
check('① 明说"查不到"', r1.out.includes('查不到'), '')
check('① 明说"不是\\"没问题\\""', r1.out.includes('不是"没问题"'), '')
check('① ★负控：**不出现**"确证 6 个都加载了"', !r1.out.includes('确证 6 个都加载了'), '')
check('① ★负控：**不出现**任何"通过/全部正常"字样', !/全部正常|检查通过|一切正常/.test(r1.out), '')
check('① 告诉用户"这不是通过"（不许当成功读）', r1.out.includes('这不是') || r1.out.includes('不证明'), '')
// ⚠ 口径：给了 `--dir` 时，候选表**只有那一条**（这是对的 —— 用户显式指定了，再列四个派生目录是噪音）。
//   所以"列出四个派生候选"要用**不给 --dir** 的那一次来测（见 ①b）。
check('① 列出用过的那条落点（用户知道刚才查的是哪）', r1.out.includes(empty), '')

// ─────────────── ①b 不给 --dir ⇒ 找遍四个派生候选 ───────────────
console.log('--- ①b 不给 --dir ⇒ 按四级候选去找，并说清用的是哪一级 ---')
const r1b = await runInProcess([])
check('①b 不给 --dir 时 exit 仍是 0/1/2 之一', [0, 1, 2].includes(r1b.code), 'got ' + r1b.code)
check('①b 报出用的是哪一级来源（env / DSH_HOME / home / tmpdir）',
  /(env:WARDEN_PLUGIN_LEDGER|DSH_HOME|home|tmpdir)/.test(r1b.out), r1b.out.slice(0, 300))
check('①b 查的确实是四级之一派生出来的路径（不是别的目录）',
  [
    process.env.WARDEN_PLUGIN_LEDGER,
    process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'plugin-ledger'),
    path.join(os.homedir(), '.dsh', 'plugin-ledger'),
    path.join(os.tmpdir(), 'dsh-plugin-ledger'),
  ].filter(Boolean).some((d) => r1b.out.includes(d)),
  r1b.out.slice(0, 300))
// 硬约束：**不许**因为"没有 --dir"就什么都不报（那会让 A6 退化成静默）
check('①b 无论哪一级，都给出明确的「确证/查不到」结论（不许沉默通过）',
  /确证 6 个都加载了|确证有插件没加载|查不到/.test(r1b.out), r1b.out.slice(0, 300))

// ─────────────── ② 确证全加载 ⇒ exit 0 ───────────────
console.log('--- ② 6 个全加载 ⇒ exit 0 ---')
const all6 = path.join(TMP, 'all6')
const applyLog1 = applyPlugins(all6, ALL)
check('② 夹具前提：6 个 apply() 都没报错', applyLog1 === '', applyLog1)
const r2 = await runInProcess(['--dir', all6])
check('② exit code = 0', r2.code === 0, 'got ' + r2.code + ' :: ' + r2.out.slice(0, 300))
check('② 明说"确证 6 个都加载了"', r2.out.includes('确证 6 个都加载了'), '')
check('② 6 个 id 逐条点名', ALL.every((id) => r2.out.includes(id)), '')
check('② 说清口径："加载了" = apply() 被调用过', r2.out.includes('apply()'), '')

// ─────────────── ③ 确证缺 2 个 ⇒ exit 1，且逐条点名缺谁 ───────────────
console.log('--- ③ 只加载 4 个 ⇒ exit 1，点名缺的那 2 个 ---')
const part = path.join(TMP, 'part')
const partialIds = ['context-dedup', 'role-voices', 'branch-guard', 'report-spill']
const applyLog2 = applyPlugins(part, partialIds)
check('③ 夹具前提：4 个 apply() 都没报错', applyLog2 === '', applyLog2)
const r3 = await runInProcess(['--dir', part])
check('③ exit code = 1（不是 0、也不是 2）', r3.code === 1, 'got ' + r3.code)
check('③ 明说"确证有插件没加载"', r3.out.includes('确证有插件没加载'), '')
check('③ 逐条点名缺的 handover-gate', r3.out.includes('handover-gate'), '')
check('③ 逐条点名缺的 warden-watch', r3.out.includes('warden-watch'), '')
check('③ 这是"查过了、有问题"（与②的"查不到"分开）', r3.out.includes('查过了'), '')

// ─────────────── ④ ★ 负控：三种状态的 exit code **两两不同** ───────────────
console.log('--- ④ ★负控：三态 exit code 两两不同（合并 = A6 违规）---')
check('④ 0 / 1 / 2 三个码互不相等', new Set([r2.code, r3.code, r1.code]).size === 3,
  'got ' + [r2.code, r3.code, r1.code].join('/'))

// ─────────────── ⑤ 坏档不许被当成"全加载" ───────────────
console.log('--- ⑤ 坏 JSON / 形状不对 ⇒ 不许判"全加载" ---')
const bad = path.join(TMP, 'bad')
fs.mkdirSync(bad, { recursive: true })
fs.writeFileSync(path.join(bad, 'PLUGIN-LOADED.json'), '{ this is not json', 'utf8')
const r5 = await runInProcess(['--dir', bad])
check('⑤ 坏 JSON ⇒ 不是 exit 0', r5.code !== 0, 'got ' + r5.code)
check('⑤ 坏 JSON ⇒ 明说形状不对', r5.out.includes('形状') || r5.out.includes('查不到'), '')

const bad2 = path.join(TMP, 'bad2')
fs.mkdirSync(bad2, { recursive: true })
fs.writeFileSync(path.join(bad2, 'PLUGIN-LOADED.json'), JSON.stringify({ plugins: { 'context-dedup': { id: 'context-dedup' } } }), 'utf8')
const r5b = await runInProcess(['--dir', bad2])
check('⑤b 只有 1 个键 ⇒ exit 1 且点名缺 5 个', r5b.code === 1 && r5b.out.includes('5'), 'got ' + r5b.code)

// ─────────────── ⑥ --json 的 state 与退出码一致 ───────────────
console.log('--- ⑥ --json 的 state 与 exit code 一致 ---')
for (const [args, expCode, expState] of [[['--dir', all6], 0, 'loaded'], [['--dir', part], 1, 'partial'], [['--dir', empty], 2, 'not-found']]) {
  const r = await runInProcess([...args, '--json'])
  let j = null
  try { j = JSON.parse(r.out) } catch { /* 解析不了就是 FAIL */ }
  check('⑥ state=' + expState + ' 且 exit=' + expCode, !!j && j.state === expState && r.code === expCode,
    'got state=' + (j && j.state) + ' exit=' + r.code)
}

// ─────────────── ⑦ 只读：跑完不许在落点里多出任何东西 ───────────────
console.log('--- ⑦ 本脚本**只读**（跑完落点内容不变）---')
const before = fs.readdirSync(all6).sort().join(',')
const beforeTxt = fs.readFileSync(path.join(all6, 'PLUGIN-LOADED.json'), 'utf8')
await runInProcess(['--dir', all6]); await runInProcess(['--dir', all6, '--json']); await runInProcess(['--dir', empty])
const after = fs.readdirSync(all6).sort().join(',')
const afterTxt = fs.readFileSync(path.join(all6, 'PLUGIN-LOADED.json'), 'utf8')
check('⑦ 目录列表没变', before === after, before + ' -> ' + after)
check('⑦ 文件内容逐字节没变', beforeTxt === afterTxt, '')
check('⑦ 查不到的落点也没被"顺手建出来"', !fs.existsSync(path.join(empty, 'PLUGIN-LOADED.json')), '')

// ─────────────── ⑧ 口径一致：验尸器的四级派生 vs 插件本体 ───────────────
console.log('--- ⑧ 验尸器的落点派生 == 插件本体的落点派生（防两边漂）---')
const cplMod = await import(pathToFileURL(SCRIPT).href)
const mine = cplMod.candidateDirs({ WARDEN_PLUGIN_LEDGER: 'X', DSH_HOME: 'Y' }, os).map((c) => c.dir)
const pluginSrc = fs.readFileSync(path.join(HERE, 'context-dedup.js'), 'utf8')
const hasEnv = pluginSrc.includes('process.env.WARDEN_PLUGIN_LEDGER')
const hasDsh = pluginSrc.includes("'plugin-ledger'")
const hasHome = pluginSrc.includes("'.dsh'")
const hasTmp = pluginSrc.includes("'dsh-plugin-ledger'")
check('⑧ 验尸器派生出的 4 级顺序 = env → DSH_HOME → home → tmpdir',
  mine.length === 4 && mine[0] === 'X' && mine[1] === path.join('Y', 'plugin-ledger'),
  JSON.stringify(mine))
check('⑧ 插件本体里同样有这 4 级（env / DSH_HOME / .dsh / dsh-plugin-ledger）',
  hasEnv && hasDsh && hasHome && hasTmp,
  JSON.stringify({ hasEnv, hasDsh, hasHome, hasTmp }))

fs.rmSync(TMP, { recursive: true, force: true })
console.log('')
console.log('合计 ' + (ok + fail) + ' 条断言，PASS ' + ok + '，FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
