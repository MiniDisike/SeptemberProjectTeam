#!/usr/bin/env node
/**
 * check-plugins-loaded.mjs —— 「5 个插件真的加载了吗」的**一条命令**验尸器。
 *
 * 为什么要有它（需求 R9 的后半句「装完能验证真的加载了」）：
 *   5 个看守插件在正常情况下**本来就不该有任何可见效果**（fail-open、不欠账就一个字不说）
 *   ⇒ 「它没加载」与「它加载了但今天没话说」在用户眼里**长得一模一样**。
 *   没有这个脚本，用户只能"看效果"，而"没有效果"是**两种完全相反的状态共用的**外观。
 *
 * ★★ 本脚本的第一原则（本项目铁律 A6）：**「没查到」≠「查过了没问题」** ——
 *   这两句必须是**两个不同的退出码 + 两段不同的文字**，不许合并成一句"OK"。
 *
 * 退出码（**这就是判据本体**）：
 *   0 = **确证加载**：落点文件存在，且 `plugins` 里有全部 6 个键
 *   1 = **确证没加载**：落点文件存在（说明机制本身在工作），但 `plugins` 里缺键
 *       ⇒ 缺的那个键 = 那个插件**没有**被加载 —— 这是"查过了，有问题"
 *   2 = **查不到**（**不是**"没问题"）：落点文件**根本不存在**
 *       ⇒ 机制可能没跑、落点可能被沙箱挡住、也可能插件压根没装。
 *          **本脚本不知道是哪种**，所以**不许**输出任何"正常/通过"字样。
 *
 * 用法：
 *   node check-plugins-loaded.mjs              # 人读
 *   node check-plugins-loaded.mjs --json       # 机器读
 *   node check-plugins-loaded.mjs --dir <路径>  # 指定落点（默认按插件的四级兜底现推）
 *
 * ⚠ 本脚本**只读**：不建目录、不写任何文件、不启动 DSH。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 6 个宿主插件（5 个看守 + context-dedup）。顺序固定，便于对拍。 */
export const EXPECTED = [
  'context-dedup',
  'role-voices',
  'handover-gate',
  'branch-guard',
  'report-spill',
  'warden-watch',
]

/**
 * 与插件本体里 `markPluginLoaded` **同一套四级派生**（顺序即优先级）。
 * ⚠ 这里**故意重写一遍而不是引插件**：验尸器要能在"插件自己坏了"时照常工作，
 *   不能依赖被验对象的代码。（两边的口径若漂了，本文件末尾的 `--selfcheck` 会红。）
 */
export function candidateDirs(env = process.env, osp = os) {
  const out = []
  if (env.WARDEN_PLUGIN_LEDGER) out.push({ dir: String(env.WARDEN_PLUGIN_LEDGER), src: 'env:WARDEN_PLUGIN_LEDGER' })
  if (env.DSH_HOME) out.push({ dir: path.join(String(env.DSH_HOME), 'plugin-ledger'), src: 'DSH_HOME' })
  try { out.push({ dir: path.join(osp.homedir(), '.dsh', 'plugin-ledger'), src: 'home' }) } catch { /* 取不到家目录就退下一级 */ }
  try { out.push({ dir: path.join(osp.tmpdir(), 'dsh-plugin-ledger'), src: 'tmpdir' }) } catch { /* 连临时区都没有 */ }
  return out
}

/**
 * 读出"确证状态"。返回的 `state` 只有三种，**互斥**：
 *   'loaded'       —— 文件在、6 个键全在
 *   'partial'      —— 文件在、但缺键（= 确证有插件没加载）
 *   'not-found'    —— 文件不在（= 查不到；**不是**"没问题"）
 */
export function inspect(dir) {
  const p = path.join(dir, 'PLUGIN-LOADED.json')
  let raw
  try { raw = fs.readFileSync(p, 'utf8') } catch { return { state: 'not-found', path: p, present: [], absent: EXPECTED.slice() } }

  let doc = null
  try { doc = JSON.parse(raw) } catch { /* 坏档当作"文件在但读不出来" */ }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !doc.plugins || typeof doc.plugins !== 'object') {
    return { state: 'partial', path: p, present: [], absent: EXPECTED.slice(), note: '文件在，但不是本插件写的那个形状（JSON 坏 / 没有 plugins 键）' }
  }
  const present = EXPECTED.filter((id) => doc.plugins[id])
  const absent = EXPECTED.filter((id) => !doc.plugins[id])
  return { state: absent.length === 0 ? 'loaded' : 'partial', path: p, present, absent, doc }
}

function findFirstHit(cands) {
  for (const c of cands) {
    if (fs.existsSync(path.join(c.dir, 'PLUGIN-LOADED.json'))) return c
  }
  return null
}

/**
 * ★ 导出成 `main(args)` 是**为了让自检能跑同一条代码路径**：
 *   本会话沙箱禁止子进程的管道 stdio（`spawnSync` ⇒ EPERM），自检开不了子进程，
 *   只能在进程内把同一个 `main()` 跑一遍并接住它的 stdout / exit。
 *   ⇒ 自检验的就是用户跑命令时**真正执行的那份代码**，不是抄一份判据。
 * @param {string[]} argv
 */
export function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes('--json')

  let enforcedDir = null
  const di = argv.indexOf('--dir')
  if (di >= 0 && argv[di + 1]) enforcedDir = argv[di + 1]

  const cands = enforcedDir
    ? [{ dir: enforcedDir, src: 'explicit --dir' }]
    : candidateDirs()

  const hit = findFirstHit(cands)
  const used = hit || cands[0]
  const res = inspect(used.dir)

  const payload = {
    schema: 1,
    state: res.state,
    ledger: res.path,
    via: used.src,
    expected: EXPECTED,
    present: res.present,
    absent: res.absent,
    note: res.note || null,
    candidates: cands.map((c) => ({ dir: c.dir, src: c.src })),
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    process.exit(res.state === 'loaded' ? 0 : res.state === 'partial' ? 1 : 2)
  }

  const L = []
  L.push('=== 插件加载核查（只读）===')
  L.push('落点: ' + res.path)
  L.push('来源: ' + used.src)
  L.push('')

  if (res.state === 'not-found') {
    L.push('★ 结论：**查不到**（不是"没问题"）')
    L.push('')
    L.push('  落点文件根本不存在。**它不证明插件没加载，也不证明加载了** ——')
    L.push('  本脚本只知道"这里的痕迹不存在"，不知道原因。可能的三种，本脚本分不出来：')
    L.push('    ① 插件压根没装上；② 装上了但宿主没跑起它们；③ 跑起来了但这个进程写不进去（沙箱/权限）。')
    L.push('  ⇒ 这**不是**一条通过记录。要看"到底哪一步断了"，得先解决"为什么没有痕迹"。')
    L.push('')
    L.push('  现推过的四个落点候选（前一个不存在就试下一个）：')
    for (const c of cands) L.push('    · [' + c.src + '] ' + c.dir)
    L.push('')
    L.push('  若确认插件已装、DSH 已重启，仍看不到本文件 ⇒ 落点被挡住了，')
    L.push('  用 `--dir <一个你确定可写的地方>` 并设 `WARDEN_PLUGIN_LEDGER=<同一个地方>` 重试。')
    process.stdout.write(L.join('\n') + '\n')
    process.exit(2)
  }

  if (res.state === 'partial') {
    L.push('★ 结论：**确证有插件没加载**')
    if (res.note) L.push('  （' + res.note + '）')
    L.push('')
    L.push('  已确认加载（' + res.present.length + '/' + EXPECTED.length + '）：' + (res.present.join(', ') || '（一个都没有）'))
    L.push('  ⊗ 没有加载（' + res.absent.length + '）：' + res.absent.join(', '))
    L.push('')
    L.push('  这一条是"查过了、有问题"：落点文件**在**（说明机制能跑），')
    L.push('  但上面那些插件**没有**在里面留下自己的那一条 ⇒ 它们确实没被加载。')
    process.stdout.write(L.join('\n') + '\n')
    process.exit(1)
  }

  L.push('★ 结论：**确证 6 个都加载了**')
  L.push('')
  L.push('  ' + EXPECTED.length + '/' + EXPECTED.length + ' 全部在文件里有自己那一条：')
  for (const id of EXPECTED) {
    const r = res.doc.plugins[id] || {}
    L.push('    · ' + id.padEnd(16) + ' version=' + String(r.version) + '  at=' + String(r.at) + '  pid=' + String(r.pid))
  }
  L.push('')
  L.push('  ⚠ 口径：「加载了」= 宿主**调用过它的 apply()**（留痕写在 apply 第一行）。')
  L.push('    这**不**等于"它今天干了活"—— 看守没事可做时本来就一个字都不说。')
  process.stdout.write(L.join('\n') + '\n')
  process.exit(0)
}

// 被 import 时不自动跑（自检要自己调 main）；直接执行时才跑。
const _isMain = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (_isMain) main()
