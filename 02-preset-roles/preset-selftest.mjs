/**
 * `agent.cordis.yml` 的结构自检（不挂载，只查形状与不变量）。
 *
 *   node preset-selftest.mjs
 *
 * ⚠ 它**不能**代替真正的挂载校验。真正的判据是
 *   `agentPresets.standingKeyFor('roles')`（在运行中的 DSH 里跑，见 README 的"验收"一节）——
 *   那个会真的把整棵插件树组合起来，能抓出"包解析不到 / config 非法 / 行没激活 / 服务漏了 realm"。
 *   本脚本抓的是**编辑事故**：少了一行、把加固行写成 disabled、协议又抄回了 persona。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/** js-yaml 从 DSH 的 profile 里借（本目录没有 node_modules）——**运行时推导，不写死机器路径** */
function loadYaml() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const candidates = [
    path.join(home, 'profiles', 'node_modules', 'js-yaml'),
    'js-yaml',
  ]
  for (const c of candidates) {
    try { return require(c) } catch { /* 换下一个 */ }
  }
  return null
}

let passed = 0
const failures = []
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`) } else { failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

const yaml = loadYaml()
if (yaml === null) {
  console.log('✗ 找不到 js-yaml（去 DSH profile 的 node_modules 借不到）—— 这一条是"没查成"，不是"没问题"')
  process.exit(2)
}

const file = path.join(HERE, 'agent.cordis.yml')
const text = fs.readFileSync(file, 'utf8')

// `!!js` 是 cordis loader 自己注册的 tag，js-yaml 默认不认 —— 这里给它一个不执行的桩。
const JsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => '<js>' })
const schema = yaml.DEFAULT_SCHEMA.extend([JsTag])

let rows
try {
  rows = yaml.load(text, { schema })
} catch (e) {
  console.log(`✗ YAML 解析失败：${e.message}`)
  process.exit(1)
}

console.log('== 1. 形状')
check('顶层是数组', Array.isArray(rows))
check('有行', Array.isArray(rows) && rows.length > 0, String(rows?.length))

const all = []
function walk(list, parent) {
  for (const row of list ?? []) {
    if (row === null || typeof row !== 'object') continue
    all.push({ row, parent })
    if (Array.isArray(row.config)) walk(row.config, row.id ?? parent)
  }
}
walk(rows, null)

const ids = all.map((x) => x.row.id)
check('每行都有 id', ids.every((x) => typeof x === 'string' && x.length > 0))
check('id 不重复', new Set(ids).size === ids.length, ids.filter((x, i) => ids.indexOf(x) !== i).join(','))
const byId = new Map(all.map((x) => [x.row.id, x]))

console.log('\n== 2. 角色协议加固行')
const guard = byId.get('team-guard')
check('有 team-guard 行', guard !== undefined)
check('它用 preset 相对路径（./ 前缀）', guard?.row.name === './team-guard.mjs', String(guard?.row.name))
check('它没声明 config（调参走 team-guard.json）', guard?.row.config === undefined)
check('插件文件就在 composition 旁边', fs.existsSync(path.join(HERE, 'team-guard.mjs')))
check('它的自检文件也在', fs.existsSync(path.join(HERE, 'team-guard.selftest.mjs')))

// 「关掉加固」是合法状态，但**必须显式**：静默 disabled 会让下一个人以为加固还在跑。
// （这条是「方向员」独立评审抓出来的：README 原来推荐 disabled:true，而这里原来必然 FAIL ⇒ 下个 agent 会把它又打开。）
const guardJsonPath = path.join(HERE, 'team-guard.json')
let guardJson = null
if (fs.existsSync(guardJsonPath)) {
  try { guardJson = JSON.parse(fs.readFileSync(guardJsonPath, 'utf8')) } catch { guardJson = 'BAD' }
  check('team-guard.json 是合法 JSON', guardJson !== 'BAD')
} else {
  check('没有 team-guard.json ⇒ 用默认（gate / 1 次 / write+edit）', true)
}
if (guard?.row.disabled === true) {
  check('★ 显式关掉时必须在 team-guard.json 里写 mode:"off"（不许静默关）',
    guardJson !== null && guardJson !== 'BAD' && guardJson.mode === 'off',
    'disabled:true 但没有 mode:"off" 的 team-guard.json')
} else {
  check('加固默认是**开着**的（没被 disabled）', true)
}

console.log('\n== 3. 派单口（三个角色 + fork + 两个可选）')
const coder = byId.get('tool-subagent-coder')
check('有 subagent_coder 行', coder !== undefined)
check('它的 toolName = subagent_coder', coder?.row.config?.toolName === 'subagent_coder')
check('它在 delegation group 里（跟着 workflowEngine realm 走）', coder?.parent === 'delegation', String(coder?.parent))
check('它默认前台、可显式后台（continuable）', coder?.row.config?.backgroundMode === 'continuable')
check('它的 persona 里写死"只改点名的文件"', String(coder?.row.config?.persona).includes('只改任务书里点名的那几个文件'))
check('它的 persona 要求贴原样自检输出', String(coder?.row.config?.persona).includes('原样输出'))
check('liaison 还在', byId.get('tool-subagent-liaison')?.row.config?.toolName === 'subagent_liaison')
check('direction 还在', byId.get('tool-subagent-direction')?.row.config?.toolName === 'subagent_direction')
const dirPersona = String(byId.get('tool-subagent-direction')?.row.config?.persona)
check('方向员 persona 写死「维度清单」', dirPersona.includes('维度清单'))
check('方向员 persona 写死"不适用的要写明为什么不适用"', dirPersona.includes('不适用的要写明为什么不适用'))
check('方向员 persona 写死大局观', dirPersona.includes('大局观'))
check('方向员 persona 要求标「未提供独立视角」', dirPersona.includes('未提供独立视角'))
check('资料员 persona 还在要求给出处', String(byId.get('tool-subagent-liaison')?.row.config?.persona).includes('必须给出处'))
// ★ 两条 persona 里的 `find add` 原来**缺 `--text`**（warden.mjs 强制必填 ⇒ 照抄就 exit 2）。
//   这是「方向员」独立评审抓出来的：教错人的命令比没有命令更坏。
const liaisonPersona = String(byId.get('tool-subagent-liaison')?.row.config?.persona)
check('★ 资料员 persona 的 find add 带 --text（否则照抄就 exit 2）',
  /find add --by 资料员 --text/.test(liaisonPersona), liaisonPersona.slice(-160))
check('★ 方向员 persona 的 find add 带 --text',
  /find add --by 方向员 --text/.test(dirPersona), dirPersona.slice(-160))
check('fork 还在', byId.get('tool-subagent-fork')?.row.config?.toolName === 'subagent_fork')
check('codex 行保持 disabled（生产版没装）', byId.get('tool-subagent-codex')?.row.disabled === true)
check('claude-code 行保持 disabled', byId.get('tool-subagent-claude-code')?.row.disabled === true)

console.log('\n== 4. persona 与协议段**不重复**（同一个协议写两遍 = 白花 token + 会漂移）')
const prefix = String(byId.get('persona')?.row.config?.prefix ?? '')
check('persona 里不再抄开工协议的命令（没有 node 调用行）', !/node\s+[<"'\w]/.test(prefix))
check('persona 里不再抄 role brief 命令', !prefix.includes('role brief'))
check('persona 里不再抄脑子政策（没有 brain brief）', !prefix.includes('brain brief'))
check('persona 里不再抄维度清单全文（没有"观感与质感"）', !prefix.includes('观感与质感'))
check('persona 指向协议段（让模型知道去哪看）', prefix.includes('角色协议') && prefix.includes('实时状态'))
check('persona 保留"不许把干完活当交付"', prefix.includes('不许把"干完活"当交付'))
check('persona 保留"方向员要有大局观"', prefix.includes('方向员要有大局观'))
check('persona 保留状态类问题直接答（含 agentPreset 判据）',
  prefix.includes('一句话直接答') && prefix.includes('agentPreset'))
check('persona 保留"不许转述角色"', prefix.includes('不许你转述'))
check('persona 保留 8 席名单', prefix.includes('AI测试用户') && prefix.includes('支线守门员'))
check('suffix 仍带工作目录', String(byId.get('persona')?.row.config?.suffix).includes('{{cwd}}'))

console.log('\n== 5. 服务行的 realm 不变量（漏一个 realm = 挂载时就被拒）')
for (const groupId of ['planning', 'compaction', 'delegation']) {
  const g = byId.get(groupId)
  check(`${groupId} 是 group 且带 isolate`, g?.row.group === true && g?.row.isolate !== undefined && Object.keys(g.row.isolate).length > 0)
}
const realmServices = ['planMode', 'compaction', 'toolResultPruner', 'workflowEngine']
for (const s of realmServices) {
  const owner = all.find((x) => x.row.isolate?.[s] === true)
  check(`服务 ${s} 有 entry-local realm`, owner !== undefined, owner?.row.id ?? '（没找到）')
}

console.log('\n== 6. 其它行没被顺手改坏')
for (const id of ['agent-instructions', 'tool-pwsh', 'tool-bash', 'tool-fs', 'tool-fs-search', 'tool-jobs',
  'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal', 'tool-ask-user', 'tool-todo', 'tool-web', 'present']) {
  check(`${id} 还在`, byId.has(id))
}
check('tool-todo 仍是并行 in_progress', byId.get('tool-todo')?.row.config?.allowParallelInProgress === true)

console.log(`\n${'─'.repeat(60)}`)
if (failures.length === 0) {
  console.log(`全部通过：${passed} 条`)
  console.log('⚠ 这只证明**形状**对。真正的判据是运行中 DSH 里的 standingKeyFor(\'roles\')。')
  process.exit(0)
}
console.log(`通过 ${passed} 条，**不通过 ${failures.length} 条**：`)
for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(1)
