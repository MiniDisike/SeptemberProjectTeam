#!/usr/bin/env node
/**
 * 脑子政策改动的黑盒用例（用户 2026-09-2x 逐字：「（用户原话已隐去 —— 公开版不留逐字）」）。
 *
 * 跑：node brain-policy.test.mjs        exit 0 = 全过
 *
 * 它只调 CLI，不 import 内部函数 —— 判据必须长在**用户会跑的那条路上**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WARDEN = path.join(HERE, 'warden.mjs')
const BASE = path.join(HERE, '.warden-brain-policy-test')
const PROJ = path.join(BASE, 'proj')

let passed = 0
const failures = []
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`) } else { failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

function cli(args) {
  const r = spawnSync(process.execPath, [WARDEN, ...args], { cwd: PROJ, encoding: 'utf8' })
  // ⚠ 沙箱下 spawnSync 的 piped stdio 会 EPERM（status=null、error 有值）。
  //   不许把那种情况报成"退出码不对" —— 那是**没查成**，不是"查了有问题"。
  const spawnError = r.error ? `[spawn 失败：${r.error.code ?? r.error.message}]` : ''
  return { code: r.status, out: `${spawnError}${r.stdout ?? ''}${r.stderr ?? ''}` }
}

fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(path.join(PROJ, '.git'), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'a.txt'), 'x\n', 'utf8')

const init = cli(['init'])
check('init 成功', init.code === 0, init.out.slice(0, 300))
if (init.code !== 0) {
  console.log('\n★ init 就没跑成 ⇒ 后面全是"没查成"，不是"查了有问题"。')
  console.log('  （沙箱下 spawnSync 会 EPERM —— 这个用例要在无沙箱环境下跑。）')
  fs.rmSync(BASE, { recursive: true, force: true })
  process.exit(2)
}
fs.writeFileSync(path.join(PROJ, '.warden', 'ARCH.md'), '## 一\n内容\n', 'utf8')

console.log('\n== 1. brain brief：默认 = 第 1 个（不提"第 2 个"）')
const first = cli(['brain', 'brief', '--artifact', '.warden/ARCH.md'])
check('退出 0', first.code === 0, String(first.code))
check('不出现"第 2 个脑子"', !first.out.includes('第 2 个脑子'))
check('给出 record 提示且不带 --trigger', first.out.includes('brain record') && !first.out.includes('--trigger'))
check('要求交 --claims（可机检指控）', first.out.includes('claims'))
check('**不许**透露任何人的结论这句还在', first.out.includes('你没被告知任何人的结论'))

console.log('\n== 2. brain brief --trigger：加派第 2 个，并写清为什么')
for (const [trg, needle] of [['conflict', '哪边成立'], ['shallow', 'grep 到的原话'], ['explore', '≥3 条别的做法']]) {
  const r = cli(['brain', 'brief', '--artifact', '.warden/ARCH.md', '--trigger', trg])
  check(`--trigger ${trg} 退出 0`, r.code === 0, String(r.code))
  check(`--trigger ${trg} 点名"你是第 2 个脑子"`, r.out.includes('第 2 个脑子') && r.out.includes(trg))
  check(`--trigger ${trg} 带上该触发的具体动作（${needle}）`, r.out.includes(needle))
  check(`--trigger ${trg} 仍然**不给别人的结论**（独立性）`,
    r.out.includes('没有告诉你第 1 个脑子判了什么'))
  check(`--trigger ${trg} 的 record 提示带 --trigger`, r.out.includes(`--trigger ${trg}`))
  check(`--trigger ${trg} 的 record 提示默认用 B 号脑子`, r.out.includes('--brain B'))
}

console.log('\n== 3. 非法 --trigger 必须拒收（不是静默忽略）')
const bad = cli(['brain', 'brief', '--artifact', '.warden/ARCH.md', '--trigger', 'nuke'])
check('brief 非法 trigger ⇒ exit 2', bad.code === 2, String(bad.code))
check('brief 非法 trigger 会列出合法值', bad.out.includes('conflict') && bad.out.includes('shallow') && bad.out.includes('explore'))
const badRec = cli(['brain', 'record', '--artifact', '.warden/ARCH.md', '--brain', 'B', '--verdict', 'reject', '--trigger', 'nuke'])
check('record 非法 trigger ⇒ exit 2', badRec.code === 2, String(badRec.code))

console.log('\n== 4. 默认（1 个脑子）是正常态，不是欠账')
const rec1 = cli(['brain', 'record', '--artifact', '.warden/ARCH.md', '--brain', 'A', '--verdict', 'accept', '--issues', ''])
check('记第 1 个脑子成功', rec1.code === 0, rec1.out.slice(0, 200))
check('状态里是「单审」', rec1.out.includes('单审'))
check('单审说明是"默认就是 1 个"', rec1.out.includes('默认就是 1 个'))
check('单审**不再**说"高风险产物要求 2 个"', !rec1.out.includes('高风险产物要求 2 个'))
check('单审列出三种触发条件', rec1.out.includes('conflict') && rec1.out.includes('shallow') && rec1.out.includes('explore'))

const rec2 = cli(['brain', 'record', '--artifact', '.warden/ARCH.md', '--brain', 'B', '--verdict', 'accept', '--issues', '', '--trigger', 'explore'])
check('记第 2 个脑子（带 trigger）成功', rec2.code === 0, rec2.out.slice(0, 200))
const brainRecs = fs.readFileSync(path.join(PROJ, '.warden', 'BRAIN.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
check('BRAIN.jsonl 里第 2 条记下了 trigger=explore',
  brainRecs.length === 2 && brainRecs[1].trigger === 'explore', JSON.stringify(brainRecs[1]?.trigger))
check('第 1 条**没有** trigger 字段（派第 1 个时不该有）',
  brainRecs[0].trigger === undefined, JSON.stringify(brainRecs[0]?.trigger))

console.log('\n== 5. brain 状态页的扩编说明已改成新政策')
const st = cli(['brain'])
check('状态页退出 0', st.code === 0, String(st.code))
check('写明"默认只派 1 个"', st.out.includes('默认只派 1 个'))
check('写明三种触发条件', st.out.includes('conflict') && st.out.includes('shallow') && st.out.includes('explore'))
check('不再写"高风险产物…要 2 个脑子"', !st.out.includes('要 2 个脑子'))

console.log('\n== 6. help 里有脑子这一段（原来 HELP 完全没有 brain）')
const help = cli(['help'])
check('help 里有 brain brief', help.out.includes('brain brief'))
check('help 里写明默认 1 个', help.out.includes('默认只派 1 个脑子'))
check('help 里有 brain audit', help.out.includes('brain audit'))

console.log('\n== 7. 空台账时不许报"审过了"')
fs.rmSync(path.join(PROJ, '.warden', 'BRAIN.jsonl'), { force: true })
const empty = cli(['brain'])
check('空台账说"从没跑过"', empty.out.includes('从没跑过'))
check('空台账给出派第 1 个的命令', empty.out.includes('brain brief'))

process.chdir(HERE)
fs.rmSync(BASE, { recursive: true, force: true })

console.log(`\n${'─'.repeat(60)}`)
if (failures.length === 0) { console.log(`全部通过：${passed} 条`); process.exit(0) }
console.log(`通过 ${passed} 条，**不通过 ${failures.length} 条**：`)
for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(1)
