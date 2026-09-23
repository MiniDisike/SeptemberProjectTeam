/**
 * `team-guard.mjs` 的自检 —— 黑盒为主：只调导出函数 + 用一个假 ctx 真跑一遍 `apply`。
 *
 *   node team-guard.selftest.mjs
 *
 * 退出码：0 = 全过；1 = 有用例不通过。
 *
 * ⚠ 为什么"假 ctx 真跑 apply"这条必须有：
 *   加固层最危险的失败形态不是"判错"，是**装不上 / 静默不响**
 *   （本项目的老病：「没查到 ≠ 查了没问题」「写进代码 ≠ 拦得住」）。
 *   只测纯函数测不出"监听器根本没挂上"。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  apply,
  denyReason,
  findProjectRoot,
  gateDecision,
  isCheckCall,
  isEngagementCall,
  isRecordCall,
  isSubagent,
  loadOptions,
  protocolText,
  readWardenState,
  wardenPath,
} from './team-guard.mjs'
// 命名空间导入：用来断言"**没有**导出 inject"（E08 回归）
import * as guardNs from './team-guard.mjs'

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failures.push(label)
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n== ${title}`)
}

// ───────────────────────────────────────────────── 1. 文本：协议段与拒绝理由

section('1. 协议段 / 拒绝理由（静态文本，必须逐字可抄）')

const W = wardenPath()
const protocol = protocolText(W)
const deny = denyReason(W)

check('协议段里有真 warden.mjs 绝对路径（不是 <HOME> 占位符）',
  protocol.includes(W) && !protocol.includes('<HOME>'), W)
check('协议段点名了 8 席里的资料员与方向员',
  protocol.includes('资料员') && protocol.includes('方向员'))
check('协议段要求同一条消息里并行派两个（不是串行）',
  protocol.includes('同一条消息里并行派两个'))
check('协议段有「维度清单」并列出质感一类维度',
  protocol.includes('维度清单') && protocol.includes('观感与质感'))
check('协议段写死「没交代就是交付简陋」', protocol.includes('没交代就是交付简陋'))
check('协议段要求并行派 subagent_coder 改善工时',
  protocol.includes('subagent_coder') && protocol.includes('并行派子代理'))
check('协议段写死脑子默认 1 个', protocol.includes('默认只派 1 个'))
check('协议段给出三种才派第 2 个的触发名',
  protocol.includes('conflict') && protocol.includes('shallow') && protocol.includes('explore'))
check('协议段要求 check exit 0 才算过', protocol.includes('exit 0 才算过'))
check('协议段要求角色说话不许转述', protocol.includes('不许你转述'))

check('拒绝理由里有 init', deny.includes('init'))
check('拒绝理由里有两条可抄的 role brief 命令', (deny.match(/role brief --role/g) ?? []).length === 2,
  String((deny.match(/role brief --role/g) ?? []).length))
check('拒绝理由写明了"只会拦这一次 + 重试放行"',
  deny.includes('只会拦这一次') && deny.includes('重试本次调用即可放行'))
check('拒绝理由要求"这是琐事"要由模型自己说清楚', deny.includes('要由你在正文里说清楚'))
check('拒绝理由里明说 init/check/role brief **都不算**参与',
  deny.includes('都不算'))
// ★ 「审查」E04：措辞必须跟着配置走，不许在"重试不会放行"的配置下还说"重试即可放行"
const denyStrict = denyReason(W, 99)
check('★ maxDenies=99 时，拒绝理由**不许**再写"重试即可放行"',
  !denyStrict.includes('重试本次调用即可放行'))
check('★ maxDenies=99 时，明说重试不会放行', denyStrict.includes('重试不会放行'))
check('★ 默认 maxDenies=1 时才给琐事出路', deny.includes('重试本次调用即可放行'))

// ───────────────────────────────────────────────── 2. 判据：谁算"角色参与了"

section('2. 判据：isEngagementCall / isRecordCall / isCheckCall')

check('subagent_liaison 算参与', isEngagementCall('subagent_liaison', {}) === true)
check('subagent_direction 算参与', isEngagementCall('subagent_direction', {}) === true)
check('pwsh 跑 warden.mjs find add 算参与（产出落了账）',
  isEngagementCall('pwsh', { command: `node "${W}" find add --by 资料员 --text "x" --source "y" --ref R1` }) === true)
check('bash 跑 warden.mjs role say 算参与（角色真的开口了）',
  isEngagementCall('bash', { command: 'node /home/u/.dsh/skills/task-warden/warden.mjs role say --role 审查 --text "…"' }) === true)

// ★★ 第一版这里是错的（「方向员」独立评审 2026-09-23 抓出来）：
//    只匹配 /warden\.mjs/ ⇒ `init` / `check` / `--help` 全算"参与"，
//    而拒绝理由第 1 步就是让模型跑 `init` ⇒ 跑一次 init 就解锁，一个角色都没派。
//    下面这几条负控就是钉住那个洞的。
check('★ pwsh 跑 warden.mjs init **不算**参与（否则闸的解锁口令就是它自己）',
  isEngagementCall('pwsh', { command: `node "${W}" init` }) === false)
check('★ pwsh 跑 warden.mjs check **不算**参与',
  isEngagementCall('pwsh', { command: `node "${W}" check` }) === false)
check('★ pwsh 跑 warden.mjs record **不算**参与',
  isEngagementCall('pwsh', { command: `node "${W}" record --req R1 --status done` }) === false)
check('★ pwsh 跑 warden.mjs role brief **不算**参与（生成任务书 ≠ 派出去）',
  isEngagementCall('pwsh', { command: `node "${W}" role brief --role 资料员 --question "x"` }) === false)
check('★ pwsh 跑 warden.mjs role scan **不算**参与',
  isEngagementCall('pwsh', { command: `node "${W}" role scan out.md` }) === false)
check('★ warden.mjs --help **不算**参与',
  isEngagementCall('pwsh', { command: `node "${W}" --help` }) === false)
check('★ init 与 role brief 串在一条命令里：有 role brief 但没派 ⇒ 仍不算',
  isEngagementCall('pwsh', { command: `node "${W}" init; node "${W}" role brief --role 方向员 --question "x"` }) === false)
check('★ init 与 find add 串在一起 ⇒ 算（产出真落了账）',
  isEngagementCall('pwsh', { command: `node "${W}" init; node "${W}" find add --by 方向员 --text "x" --why "y" --ref R1` }) === true)

check('pwsh 跑 git status 不算参与', isEngagementCall('pwsh', { command: 'git status' }) === false)
check('write 本身不算参与', isEngagementCall('write', { file_path: 'a.txt' }) === false)
check('subagent_coder **不算**参与（写代码在协议里排在派角色之后）',
  isEngagementCall('subagent_coder', { prompt: '改 a.js' }) === false)
check('没有 command 字段不炸', isEngagementCall('pwsh', {}) === false && isEngagementCall('pwsh', null) === false)

check('record 认得出（带引号的路径）',
  isRecordCall('pwsh', { command: `node "${W}" record --req R1 --status done` }) === true)
check('record 认得出（不带引号）',
  isRecordCall('pwsh', { command: 'node warden.mjs record --req R1' }) === true)
check('role say 不算 record', isRecordCall('pwsh', { command: `node "${W}" role say --role 审查` }) === false)
check('check 认得出', isCheckCall('pwsh', { command: `node "${W}" check` }) === true)
check('record 不算 check', isCheckCall('pwsh', { command: `node "${W}" record` }) === false)

section('3. 判据：isSubagent（正面证据；读不到 ⇒ 当顶层，闸生效）')

check('origin=subagent ⇒ true', isSubagent({ session: { header: { origin: 'subagent' } } }) === true)
check('顶层（只有 cwd）⇒ false', isSubagent({ session: { header: { cwd: 'D:\\x' } } }) === false)
check('没有 session ⇒ false（不许 fail-open 成"永不响"）', isSubagent({}) === false)
check('null ⇒ false', isSubagent(null) === false)
check('抛异常 ⇒ false', isSubagent({ get session() { throw new Error('boom') } }) === false)

// ───────────────────────────────────────────────── 4. 闸的判决矩阵

section('4. gateDecision 判决矩阵')

const opts = { mode: 'gate', maxDeniesPerSession: 1, mutatingTools: ['write', 'edit'] }
const fresh = () => ({ engaged: false, denies: 0 })

check('未参与 + write + 顶层 ⇒ deny',
  gateDecision(opts, fresh(), 'write', false).action === 'deny')
check('未参与 + edit + 顶层 ⇒ deny',
  gateDecision(opts, fresh(), 'edit', false).action === 'deny')
check('未参与 + read ⇒ allow',
  gateDecision(opts, fresh(), 'read', false).action === 'allow')
check('未参与 + pwsh ⇒ allow（不拦命令行，避免误伤只读命令）',
  gateDecision(opts, fresh(), 'pwsh', false).action === 'allow')
check('已参与 + write ⇒ allow',
  gateDecision(opts, { engaged: true, denies: 0 }, 'write', false).action === 'allow')
check('子代理 + write ⇒ allow（实现工程师必须能写）',
  gateDecision(opts, fresh(), 'write', true).action === 'allow')
check('已经拦过一次 ⇒ allow（一个会话最多一次）',
  gateDecision(opts, { engaged: false, denies: 1 }, 'write', false).action === 'allow')
check('maxDeniesPerSession=0 ⇒ 永不拦',
  gateDecision({ ...opts, maxDeniesPerSession: 0 }, fresh(), 'write', false).action === 'allow')
check('mode=remind ⇒ 永不拦',
  gateDecision({ ...opts, mode: 'remind' }, fresh(), 'write', false).action === 'allow')
check('mode=off ⇒ 永不拦',
  gateDecision({ ...opts, mode: 'off' }, fresh(), 'write', false).action === 'allow')
check('自定义 mutatingTools 生效',
  gateDecision({ ...opts, mutatingTools: ['str_replace'] }, fresh(), 'write', false).action === 'allow')

// ───────────────────────────────────────────────── 5. 配置加载

section('5. loadOptions（坏配置一律回默认，绝不让 preset 挂不起来）')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-guard-'))
const cfg = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text, 'utf8'); return p }

const d = loadOptions(path.join(tmp, 'nope.json'))
check('没有配置文件 ⇒ 默认 gate / 1 / [write, edit]',
  d.mode === 'gate' && d.maxDeniesPerSession === 1 && d.mutatingTools.join(',') === 'write,edit')
check('坏 JSON ⇒ 默认', loadOptions(cfg('bad.json', '{oops')).mode === 'gate')
check('JSON 不是对象 ⇒ 默认', loadOptions(cfg('arr.json', '[1,2]')).mode === 'gate')
check('非法 mode 被忽略 ⇒ 默认 gate', loadOptions(cfg('m.json', '{"mode":"nuke"}')).mode === 'gate')
check('合法 mode 生效', loadOptions(cfg('m2.json', '{"mode":"remind"}')).mode === 'remind')
check('合法 maxDeniesPerSession 生效',
  loadOptions(cfg('n.json', '{"maxDeniesPerSession":99}')).maxDeniesPerSession === 99)
check('负数 maxDeniesPerSession 被忽略',
  loadOptions(cfg('n2.json', '{"maxDeniesPerSession":-3}')).maxDeniesPerSession === 1)
check('mutatingTools 生效',
  loadOptions(cfg('t.json', '{"mutatingTools":["a","b"]}')).mutatingTools.join(',') === 'a,b')
check('mutatingTools 里混进非字符串 ⇒ 整条忽略',
  loadOptions(cfg('t2.json', '{"mutatingTools":["a",1]}')).mutatingTools.join(',') === 'write,edit')
check('默认值不被调用方改坏（返回的是副本）', (() => {
  const a = loadOptions(path.join(tmp, 'nope.json'))
  a.mutatingTools.push('x')
  return loadOptions(path.join(tmp, 'nope.json')).mutatingTools.length === 2
})())

// ───────────────────────────────────────────────── 6. 消息与磁盘

section('6. findProjectRoot / readWardenState（账本是谁家的）')

const noWarden = readWardenState(tmp)
check('目录里没有 .warden ⇒ dir=false', noWarden.dir === false)
check('cwd 是 null ⇒ dir=false', readWardenState(null).dir === false)

// 容器目录（没有 .git，但有一个 .warden）—— 这正是"两个项目读到对方守则"的形状
const container = path.join(tmp, 'container')
fs.mkdirSync(path.join(container, '.warden'), { recursive: true })
check('容器目录里 findProjectRoot ⇒ root=null（往上没有 .git）',
  findProjectRoot(container).root === null, JSON.stringify(findProjectRoot(container)))
check('容器目录**自己**有 .warden 时 readWardenState 仍说 dir=true（读得到，但状态行不许替它背书）',
  readWardenState(container).dir === true)

const proj = path.join(tmp, 'proj')
fs.mkdirSync(path.join(proj, '.warden'), { recursive: true })
fs.mkdirSync(path.join(proj, '.git'), { recursive: true })          // ★ 夹具自己钉工程根
fs.writeFileSync(path.join(proj, '.warden', 'SPEC.md'), 'R1\n', 'utf8')
fs.writeFileSync(path.join(proj, '.warden', 'ROUNDS.jsonl'), '{"a":1}\n{"a":2}\n', 'utf8')
fs.writeFileSync(path.join(proj, '.warden', 'BRAIN.jsonl'), '{"b":1}\n', 'utf8')
const st = readWardenState(proj)
check('.warden 存在 ⇒ dir=true', st.dir === true)
check('SPEC.md 认得出', st.spec === true)
check('ROUNDS 2 行', st.rounds === 2, String(st.rounds))
check('BRAIN 1 行', st.brain === 1, String(st.brain))
check('缺的台账算 0（不是 NaN / 不是崩）', st.findings === 0 && st.speech === 0)
check('cwd 是文件不是目录 ⇒ dir=false', readWardenState(path.join(proj, '.warden', 'SPEC.md')).dir === false)

check('工程根自己有 .git ⇒ via=self', findProjectRoot(proj).via === 'self')
const sub = path.join(proj, 'src', 'deep')
fs.mkdirSync(sub, { recursive: true })
const up = findProjectRoot(sub)
check('子目录 ⇒ 往上找到工程根，via=ancestor', up.via === 'ancestor' && up.root === proj, JSON.stringify(up))
check('找根有界：maxUp=0 时找不到 ⇒ root=null', findProjectRoot(sub, 0).root === null)
check('cwd 是 null / 空串 ⇒ via=none',
  findProjectRoot(null).via === 'none' && findProjectRoot('').via === 'none')

// ───────────────────────────────────────────────── 7. 假 ctx 真跑 apply

section('7. 假 ctx 真跑 apply（证明三种形态真挂上了，且闸真会响）')

function fakeCtx({ noPrompt = false } = {}) {
  const ctx = {
    sections: [],
    contexts: [],
    listeners: new Map(),
    systemPrompt: noPrompt ? undefined : {
      section(s) { ctx.sections.push(s); return () => {} },
      context(c) { ctx.contexts.push(c); return () => {} },
    },
    get(name) { return name === 'systemPrompt' ? ctx.systemPrompt : undefined },
    on(name, cb) {
      if (!ctx.listeners.has(name)) ctx.listeners.set(name, [])
      ctx.listeners.get(name).push(cb)
      return () => {}
    },
  }
  return ctx
}

const PROBE_NAME = 'team-guard-probe.jsonl'
// 探针在"没有 agent"那一行会落到 cwd，写不进去就退到 tmpdir —— 断言要**两个都看**。
// （实测：在只读目录 / 沙箱外的工作区里跑自检时，只看 cwd 会误报"探针没落盘"。）
const probeInCwd = path.join(process.cwd(), PROBE_NAME)
const probeInTmp = path.join(os.tmpdir(), PROBE_NAME)
const readProbe = () => {
  for (const p of [probeInCwd, probeInTmp]) {
    try { return fs.readFileSync(p, 'utf8') } catch { /* 换下一个 */ }
  }
  return ''
}
fs.rmSync(probeInCwd, { force: true })
fs.rmSync(probeInTmp, { force: true })

const ctx = fakeCtx()
const allow = () => Promise.resolve({ kind: 'allow' })
apply(ctx)

check('注册了 1 个常驻协议段', ctx.sections.length === 1, String(ctx.sections.length))
check('协议段名字是 roles:team-protocol', ctx.sections[0]?.name === 'roles:team-protocol')
check('★ 协议段 order = 10250，**大于** persona 后缀的 10200（"最后读到"才是真的）',
  ctx.sections[0]?.order === 10250 && ctx.sections[0].order > 10200, String(ctx.sections[0]?.order))
check('协议段是函数（要按 agent 区分主代理 / 子代理）', typeof ctx.sections[0]?.text === 'function')
check('注册了 1 个实时状态快照', ctx.contexts.length === 1, String(ctx.contexts.length))
check('快照名字是 roles:team-status', ctx.contexts[0]?.name === 'roles:team-status')
check('快照 order = 130（排在沙箱/审批/派单之后）', ctx.contexts[0]?.order === 130)
check('快照 text 是函数（每步重算）', typeof ctx.contexts[0]?.text === 'function')
check('挂上了 tools/pre-execute', ctx.listeners.has('tools/pre-execute'))
check('**没有**多余的 agent/pre-step 监听器（那条路已经删掉，不留死代码）',
  !ctx.listeners.has('agent/pre-step'))
check('一共只挂了 1 个监听器（挂得越多，越可能是死代码）',
  [...ctx.listeners.values()].reduce((n, v) => n + v.length, 0) === 1,
  String([...ctx.listeners.keys()].join(',')))
check('★ 没有声明 inject（声明了的话 prompt 服务一停，闸会跟着一起静默死掉）',
  guardNs.inject === undefined, JSON.stringify(guardNs.inject))

// 有界观测探针（「审查」E02）：证明"被装上"这一行真的落了盘
check('★ 探针落了盘（mounted）', readProbe().includes('"ev":"mounted"'), probeInCwd + ' 或 ' + probeInTmp)

// prompt 服务不在时：段与快照不注册，但**闸照装**（E08 回归）
const ctxNoPrompt = fakeCtx({ noPrompt: true })
apply(ctxNoPrompt)
check('★ prompt 服务缺失 ⇒ 段与快照都不注册', ctxNoPrompt.sections.length === 0 && ctxNoPrompt.contexts.length === 0)
check('★ prompt 服务缺失 ⇒ **闸仍然装上**（不再被硬依赖拖死）',
  ctxNoPrompt.listeners.has('tools/pre-execute'))
const noPromptDeny = await ctxNoPrompt.listeners.get('tools/pre-execute')[0](
  { name: 'write', arguments: {}, agent: { session: { header: { cwd: proj } } } }, allow)
check('★ prompt 服务缺失 ⇒ 闸照样会响', noPromptDeny?.kind === 'deny', JSON.stringify(noPromptDeny))

const preTool = ctx.listeners.get('tools/pre-execute')[0]
const agent = { session: { header: { cwd: proj, agentPreset: 'roles' } } }

const first = await preTool({ name: 'write', arguments: { file_path: 'x.js' }, agent }, allow)
check('第一次 write 被拒', first?.kind === 'deny', JSON.stringify(first))
check('拒绝理由里带 init 与 role brief',
  String(first?.reason).includes('init') && String(first?.reason).includes('role brief'))

const second = await preTool({ name: 'write', arguments: { file_path: 'x.js' }, agent }, allow)
check('同一个会话第二次 write 放行（最多拦一次）', second?.kind === 'allow')

// 有界观测探针（「审查」E02）：证明"监听器真被派发过 / 闸真响过"
const projProbe = path.join(proj, '.warden', PROBE_NAME)
const probeText = (() => { try { return fs.readFileSync(projProbe, 'utf8') } catch { return '' } })()
check('★ 探针落到工程根 .warden/ 里（不是乱扔）', probeText.length > 0, projProbe)
check('★ 探针证明监听器**真的被派发过**（tool 行）', probeText.includes('"ev":"tool"'))
check('★ 探针证明闸**真的响过**（deny 行）', probeText.includes('"ev":"deny"'))
check('★ 探针里的 tool 行带得出工具名', probeText.includes('"tool":"write"'))

// ★ 关键回归：**跑 init 不能解锁**（第一版的洞就是这个）
const agentInit = { session: { header: { cwd: proj } } }
await preTool({ name: 'pwsh', arguments: { command: `node "${W}" init` }, agent: agentInit }, allow)
const afterInit = await preTool({ name: 'write', arguments: {}, agent: agentInit }, allow)
check('★ 只跑过 init 的会话，write **仍然被拒**（init 不是解锁口令）',
  afterInit?.kind === 'deny', JSON.stringify(afterInit))

// 另一个会话：真的派了角色 ⇒ 直接放行
const agent2 = { session: { header: { cwd: proj } } }
const engaged = await preTool({ name: 'subagent_liaison', arguments: { prompt: '查一下' }, agent: agent2 }, allow)
check('派资料员本身不被拦', engaged?.kind === 'allow')
const afterEngage = await preTool({ name: 'write', arguments: {}, agent: agent2 }, allow)
check('已派过角色的会话 write 放行', afterEngage?.kind === 'allow')

// 子代理：永远放行
const subAgentRef = { session: { header: { origin: 'subagent', cwd: proj } } }
const subWrite = await preTool({ name: 'write', arguments: {}, agent: subAgentRef }, allow)
check('子代理 write 放行（实现工程师能写代码）', subWrite?.kind === 'allow')

// read 从不被拦
const agent3 = { session: { header: { cwd: proj } } }
const readRes = await preTool({ name: 'read', arguments: {}, agent: agent3 }, allow)
check('read 从不被拦', readRes?.kind === 'allow')

// 看守自己坏了 ⇒ fail-open
const boom = { name: 'write', get arguments() { throw new Error('boom') }, agent: agent3 }
const survived = await preTool(boom, allow)
check('判据抛异常 ⇒ fail-open 放行', survived?.kind === 'allow')

// 实时状态：真跑一次 text()
const status = ctx.contexts[0].text({ agent, scope: agent })
check('状态快照有抬头', typeof status === 'string' && status.includes('【九月项目团 · 实时状态】'))
check('工程根自己有 .git ⇒ 状态里点出工程根', status.includes('工程根：') && status.includes('就是工作区'))
check('状态快照里能看到 .warden 已建', status.includes('.warden：已建'))
check('未参与时状态里出现"动手写文件之前"', status.includes('动手写文件之前'))
const statusAfter = ctx.contexts[0].text({ agent: agent2, scope: agent2 })
check('已参与时状态里出现"角色已参与 ✓"', statusAfter.includes('角色已参与 ✓'))
check('读不到工作区时状态不炸、也不瞎报',
  ctx.contexts[0].text({ agent: { session: { header: {} } } }).includes('读不到工作区'))
check('assembly 什么都没有也不炸', ctx.contexts[0].text(undefined) === '')

// ★ 容器目录（有 .warden、没有 .git）：状态行**不许**替它背书
const containerAgent = { session: { header: { cwd: container } } }
const containerStatus = ctx.contexts[0].text({ agent: containerAgent, scope: containerAgent })
check('★ 容器目录 ⇒ 状态里明说"往上找不到 .git / 这不是工程根"',
  containerStatus.includes('往上找不到') && containerStatus.includes('不是工程根'))
check('★ 容器目录 ⇒ 不许只说"已建"就完事，要提示可能属于上层容器',
  containerStatus.includes('上层容器') && containerStatus.includes('不要**拿它当本工程的账本'))

// 主代理 / 子代理的分流（同一份 standing composition，靠渲染成空串来区分）
const mainAgent = { session: { header: { cwd: proj } } }
const subAgent = { session: { header: { origin: 'subagent', cwd: proj } } }
const mainProtocol = ctx.sections[0].text({ agent: mainAgent })
check('协议段对主代理渲染出完整协议', mainProtocol.includes('第 0 步') && mainProtocol.includes('维度清单'))
check('协议段对子代理渲染成空串（不占子代理的 token、也不误导它）',
  ctx.sections[0].text({ agent: subAgent }) === '')
check('协议段两次渲染字节相同（system prompt 不抖动 ⇒ 不破坏 KV cache）',
  ctx.sections[0].text({ agent: mainAgent }) === mainProtocol)
check('协议段拿不到 agent 时**照样渲染**（宁可吵，不许静默失效）',
  ctx.sections[0].text(undefined) === mainProtocol)
check('状态快照对子代理渲染成空串', ctx.contexts[0].text({ agent: subAgent }) === '')

// ───────────────────────────────────────────────── 结果

fs.rmSync(tmp, { recursive: true, force: true })
// 探针的 mounted 那一行没有 agent，会落到 cwd 或 tmpdir —— 自检自己收拾干净
fs.rmSync(probeInCwd, { force: true })
fs.rmSync(probeInTmp, { force: true })

console.log(`\n${'─'.repeat(60)}`)
if (failures.length === 0) {
  console.log(`全部通过：${passed} 条`)
  process.exit(0)
}
console.log(`通过 ${passed} 条，**不通过 ${failures.length} 条**：`)
for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(1)
