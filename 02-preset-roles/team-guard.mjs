/**
 * 九月项目团 · 角色协议加固（agent preset `roles` 内部插件）
 *
 * ## 为什么要有这个文件
 *
 * 用户的逐字反馈（2026-09-2x）：「（用户原话已隐去 —— 公开版不留逐字）」
 *
 * 病根是**形态**问题，不是内容问题：角色协议原来**只是 persona 里的一大段文字**，
 * 位置在 system prompt 的开头，和几十条别的规矩混在一起 —— 模型看不见它，
 * 于是"角色"变成了用户手动触发的功能。
 *
 * 所以这里换三种**它躲不掉**的形态（都在 preset 自己的作用域里，
 * 只覆盖本 preset 的会话；子代理由 composeFrom 继承同一份 composition）：
 *
 *   ① **常驻协议段**（`systemPrompt.section`，order 9500 = 排在工具说明之后、
 *      结构化输出之前）—— 位置最靠后，是模型读 prompt 时最后看到的东西。
 *      文本是**静态**的：system prompt 的字节不变 ⇒ 不破坏 KV cache
 *      （这是 `dsh-base` 里"tool catalog 保持不变"的同一条理由）。
 *
 *   ② **每步刷新的实时状态**（`systemPrompt.context`，order 130）——
 *      走的是 runtime context 通道：只有内容**变了**才追加一条消息
 *      （`dsh-agent-loop` 的 `RuntimeContextProjection.project`），
 *      所以它便宜，而且**每一步模型请求里都在**。
 *      它读的是磁盘上真实的东西（`.warden/` 里有什么）和本会话真实发生过的事
 *      （派过资料员/方向员没有、record 过没有），不是"你记得要做"。
 *
 *   ③ **第一次写文件前的角色闸**（`tools/pre-execute` waterfall）——
 *      用户的原话是"加固"，而这个项目自己的结论是
 *      **「写进代码 ≠ 拦得住」「没被 exit code 拦的都只是建议」**。
 *      所以这里**真的返回 `deny`**（不是再写一段建议）：本会话还没派过任何角色时，
 *      第一次 `write`/`edit` 被拒，理由里给出**逐字可抄的命令**。
 *
 *      ⚠ **它默认是一次"减速带"，不是路障**（如实描述，别自夸成"真拦"）：
 *        默认 `maxDeniesPerSession = 1` ⇒ 同一个会话最多被拒一次，重试即放行，
 *        而且拒绝理由里**明说了**这条出路。目的是让协议出现在决策点上，
 *        不是阻止你干活。要真当硬闸：把 `maxDeniesPerSession` 调大（99），
 *        拒绝理由会自动改成"重试不会放行"（措辞跟着配置走，见 `denyReason`）。
 *
 *   ④ **有界观测探针**（`makeProbe`）—— 证明"这一行真被装上、监听器真被派发过、闸真响过"。
 *      没有它，「闸响过并放行」与「闸从没被派发」在证据上分不开（「审查」E02）。
 *
 *      ⚠ 三条硬边界（看守自己坏了绝不许影响用户干活）：
 *        · **一个会话最多拦一次**（`maxDeniesPerSession`，默认 1）——
 *          它是一次"让协议出现在决策点上"的减速带，不是永久路障；
 *        · **子代理一律放行**（`session.header.origin === 'subagent'`）——
 *          实现工程师要能写代码；
 *        · 任何异常都 **fail-open**（返回 `next()`）。
 *
 *      ⚠ 例外，**故意**不 fail-open：`isSubagent` 读不到 header 时返回 `false`（当顶层 ⇒ 闸生效）。
 *        误判成顶层 ⇒ 子代理被拦一次（有界、可重试）；误判成子代理 ⇒ **闸永远不响**。
 *        宁可吵，不许静默。
 *
 *      ⚠ 「角色参与了」的判据**必须窄**（第一版写错了，见 `isEngagementCall` 的注释）：
 *        只认"角色**真的被派出去 / 产出真的落了账**"，不认 `init` / `check` / `role brief`。
 *        否则拒绝理由第 1 步（跑 `init`）本身就是解锁口令，闸就白装了。
 *
 * ## 可调项
 *
 * 同目录下的 `team-guard.json`（可选，没有就用默认值）：
 *
 *   { "mode": "gate",              // gate = 真拦一次 / remind = 只提醒 / off = 全关
 *     "maxDeniesPerSession": 1,    // 0 = 不拦；99 = 每次写文件都拦
 *     "mutatingTools": ["write", "edit"] }
 *
 * ## 自检
 *
 *   node team-guard.selftest.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Cordis 插件名 */
export const name = 'team-guard'

// ⚠ **故意不声明 `inject: ['systemPrompt']`**（「审查」独立评审 E08）：
//   声明成硬依赖后，prompt 服务一旦不可用，整行会被 cordis 停到 waiting ——
//   三种形态**连同那个闸一起静默消失**，而"加固没装上"没有任何痕迹。
//   现在改成 `ctx.get('systemPrompt')` + undefined 检查：服务在就注册段与快照，不在就记一行探针；
//   **闸不依赖它**，无论 prompt 服务在不在都照装。

/**
 * 段位。`dsh-system-prompt` 的 `SECTION_ORDERS`：
 *   TOOLS_SDK 5000 · DELIVERABLE_FILE_REFERENCES 9000 · STRUCTURED_OUTPUT 9900 ·
 *   HARNESS_SOURCE 10000 · WEB_SURFACE 10100 · **DEPLOYMENT_PERSONA_SUFFIX 10200**
 *
 * ⚠ 这里原来是 9500，注释还写着"排在最后、模型最后读到的正文"——**那是错的**，
 *   被「审查」独立评审当场用生产日志证伪（会话 11622ba2：system prompt 11402 字，
 *   协议段起于偏移 8032，**其后仍有 3370 字**）。
 *   ⇒ 现在取 **10250**：排在 persona 后缀（10200）**之后**，"最后读到"这句才成立。
 *   `preset-selftest.mjs` / `team-guard.selftest.mjs` 都有断言钉住这个大小关系。
 */
const SECTION_ORDER = 10250

/**
 * 运行态快照位次。`CONTEXT_ORDERS`：SANDBOX_POLICY 110 · APPROVAL_POLICY 115 ·
 * SUBAGENT_DELEGATION 120 ⇒ 130 排在它们后面（越靠后越靠近请求）。
 */
const CONTEXT_ORDER = 130

/** 默认配置（`team-guard.json` 只覆盖它列出的字段） */
const DEFAULTS = {
  mode: 'gate',
  maxDeniesPerSession: 1,
  mutatingTools: ['write', 'edit'],
}

/** 行数统计的字节上限：超过就只报"很多"，不把大账本读进内存 */
const MAX_COUNT_BYTES = 262144

// ─────────────────────────────────────────────────────────── 配置

/**
 * 读同目录的可选配置。**读不动/没有/坏掉一律回默认** ——
 * 加固层自己坏了，绝不能让 preset 挂不起来。
 * @param {string} [file] 配置文件路径（自检用）
 * @returns {{mode:'gate'|'remind'|'off', maxDeniesPerSession:number, mutatingTools:string[]}}
 */
export function loadOptions(file = path.join(HERE, 'team-guard.json')) {
  const out = { ...DEFAULTS, mutatingTools: [...DEFAULTS.mutatingTools] }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.mode === 'gate' || parsed.mode === 'remind' || parsed.mode === 'off') out.mode = parsed.mode
      if (Number.isInteger(parsed.maxDeniesPerSession) && parsed.maxDeniesPerSession >= 0) {
        out.maxDeniesPerSession = parsed.maxDeniesPerSession
      }
      if (Array.isArray(parsed.mutatingTools) && parsed.mutatingTools.every((x) => typeof x === 'string')) {
        out.mutatingTools = [...parsed.mutatingTools]
      }
    }
  } catch { /* 没有 / 读不动 / 不是 JSON ⇒ 用默认 */ }
  return out
}

/**
 * `warden.mjs` 的绝对路径 —— 协议段和拒绝理由里给的是**能逐字抄的命令**，
 * 所以这里要真路径，不能写 `<HOME>` 这种占位符。
 * @param {Record<string,string|undefined>} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function wardenPath(env = process.env, home = os.homedir()) {
  const root = (env && env.DSH_HOME) || path.join(home, '.dsh')
  return path.join(root, 'skills', 'task-warden', 'warden.mjs')
}

// ─────────────────────────────────────────────────────────── 文本

/**
 * 常驻协议段。**静态文本**（同进程内恒定）⇒ system prompt 不抖动。
 * @param {string} [warden] warden.mjs 绝对路径
 * @returns {string}
 */
export function protocolText(warden = wardenPath()) {
  const W = `node "${warden}"`
  return [
    '【九月项目团 · 角色协议】这是本窗口的默认工作方式，**不需要用户再提醒你**。',
    // ⚠ 这里**故意不抄角色名单**：名单只有一张 —— `warden.mjs` 的 `ROLE_REGISTRY`。
    //   「审查」独立评审指出：把 8 席名字抄进这个文件，就是第 9 份硬拷贝，
    //   而 `warden.mjs` 的 `roleRegistryAudit()` **扫不到它** ⇒ 加第九席时这里会静默漂移。
    //   本项目自己的规矩就是「别再往别处抄角色名单」。要名单：跑 `role` / `roles --health`。
    `本团有 **8 席角色**（7 席有票 + 1 席无票）。`,
    `⚠ **名单只有一张** —— \`${warden}\` 里的 \`ROLE_REGISTRY\`。**别自己抄、别自己编职称**：`,
    `   \`${W} role\` 看角色卡，\`${W} roles --health\` 看"角色是不是在跑"的机械仪表。`,
    '角色不是摆设：每个角色的价值 = 它提出的、别人提不出来的东西；产出必须挂到某条 R# / 规则 id。',
    '',
    '第 0 步 —— 任何"超过一句话"的任务，**在写任何文件之前**：',
    ` ① 工程根（有 .git 的那层）锁原话：${W} init`,
    ' ② **同一条消息里并行派两个**（别串行，省时间）：',
    `     ${W} role brief --role 资料员 --question "…" --ref R#   → subagent_liaison`,
    `     ${W} role brief --role 方向员 --question "…" --ref R#   → subagent_direction`,
    '     只给材料，不给你的结论。产出落台账：',
    `     ${W} find add --by 资料员 --text "…" --source "出处" --ref R#`,
    `     ${W} find add --by 方向员 --text "…" --why "指回哪条原话" --ref R#`,
    ' ③ 写软件 / 做东西之前先要一份「**维度清单**」（方向员出、资料员供事实）：',
    '     目标与非目标 · 输入与校验 · 错误与失败态 · 边界与极端值 · 性能与资源 ·',
    '     结构与可维护性 · 测试与自检 · 用法与文档 · **观感与质感**（默认值 / 措辞 / 反馈 /',
    '     对齐 / 留白 / 动效）· 兼容与依赖 · 安全 · 后续可扩展点。',
    '     适用的必须交代；不适用的写明为什么不适用 —— **没交代就是交付简陋**。',
    '',
    '★ 写代码要**并行派子代理**：按文件 / 模块切成互不重叠的块，在**同一条消息里**同时派多个',
    '  `subagent_coder`（`run_in_background: true`），每块一个；别一个一个串行等。',
    '  每块说清：改哪个文件、验收标准、不许碰别的文件。',
    '',
    '★ 脑子（独立审查）**默认只派 1 个**。只有下面三种情况才派第 2 个，并写 `--trigger`：',
    '   ① `conflict` 结论 / 来源冲突；② `shallow` 第 1 个查得太笼统、没证据、没看完；',
    '   ③ `explore` 需要"还有哪些做法 / 哪些坑"，不是"这行不行"。',
    `   ${W} brain brief --artifact <产物> [--trigger conflict|shallow|explore]`,
    `   ${W} brain record --artifact <产物> --brain A --verdict accept|reject --issues "…"`,
    `   审查必须交可机检指控，否则判决不算数：${W} brain audit --artifact <产物>`,
    '',
    `★ 每轮收尾 ${W} record --req R# --status …；说"完成 / 修好 / 交付"之前必须 ${W} check（**exit 0 才算过**）。`,
    '★ 角色说话按「名字 · 职称：原话」**直接显示，不许你转述**（`role say` 写、`role scan` 自查）。',
  ].join('\n')
}

/**
 * 拒绝理由 —— 用户要的"加固"落在这一句上：它必须**逐字可抄**，不能只是"请先派角色"。
 *
 * ⚠ `maxDenies` 决定最后那段"琐事出路"**说不说**，必须与实际配置一致：
 *   默认 `maxDeniesPerSession=1` ⇒ 重试确实会放行，那就如实说；
 *   调成 99（真想当硬闸）⇒ 就不能再写"重试即可放行"，那是假话。
 *   （「审查」独立评审指出：默认值下这段自带绕过口令，而文件头却自称"真拦" ——
 *    两处现在都改成**如实描述**：默认是一次**减速带**，不是路障。）
 * @param {string} [warden] warden.mjs 绝对路径
 * @param {number} [maxDenies] 本会话允许拒几次（默认 1）
 * @returns {string}
 */
export function denyReason(warden = wardenPath(), maxDenies = DEFAULTS.maxDeniesPerSession) {
  const W = `node "${warden}"`
  return [
    '【九月项目团 · 角色协议还没启动】你正要写文件，但**这个会话里还没有任何角色参与过**：',
    '没派过 `subagent_liaison` / `subagent_direction`，也没有把角色的产出落进发现台账。',
    '（跑过 `init` / `check` / `role brief` **都不算** —— 那是记账和生成任务书，不是"派了活"。）',
    '',
    '先做第 0 步，再回来重试本次调用：',
    ` 1) ${W} init                                  # 工程根 = 有 .git 的那一层`,
    ` 2) ${W} role brief --role 资料员 --question "…" --ref R#`,
    `    ${W} role brief --role 方向员 --question "…" --ref R#`,
    '    把两段任务书分别整段丢给 `subagent_liaison` / `subagent_direction`（**同一条消息里一起派**）。',
    ' 3) 写软件 / 做东西之前，先拿到「维度清单」（方向员出、资料员供事实），再动手。',
    '',
    ...(maxDenies <= 1
      ? ['如果你判断这**确实是一轮内的琐事**（不产出新文件、不涉及取舍）：本会话只会拦这一次，',
        '直接重试本次调用即可放行 —— 但"这是琐事"要由你在正文里说清楚，不要默认它是。']
      : [`⚠ 本会话的闸配的是 \`maxDeniesPerSession=${maxDenies}\`：**重试不会放行**，`,
        '  必须真做完第 0 步（派出角色 / 产出落账）才能继续。']),
  ].join('\n')
}

// ─────────────────────────────────────────────────────────── 纯判据（自检直接调这些）

/**
 * 一次工具调用算不算"角色**真的**参与了"。
 *
 * ⚠ **第一版这里是错的，而且是致命的错**（「方向员」独立评审抓出来的，2026-09-23）：
 *   第一版只写 `/warden\.mjs/` —— 于是 `init` / `check` / `--help` **全算"角色参与"**。
 *   而拒绝理由的第 1 步**就是**让模型跑 `init` ⇒ **被拒一次 → 跑 `init` → 重试 → 放行**，
 *   **一个角色都没派**；更糟的是此后每一步的状态行都印「角色已参与 ✓」——
 *   一句假话进了每一步的上下文。
 *   这就是本项目自己那句 **「写进代码 ≠ 拦得住」** 的新形态，也是「没查到 ≠ 查了没问题」的同类：
 *   闸响了、状态绿了，而角色根本没被派过。
 *
 * 所以现在只认**角色真的被派出去 / 产出真的落了账**：
 *   · `subagent_liaison` / `subagent_direction` —— 固定人格的两个派单口**被调用**
 *   · `warden.mjs find add` —— 资料员 / 方向员的产出**落进发现台账**（协议里就是主代理替它们落）
 *   · `warden.mjs role say` —— 角色**真的开口了**（逐字进 `.warden/ROLE_SPEECH.jsonl`）
 *
 * **不认**（它们是"记账 / 看状态 / 生成任务书"，不是"派了活"）：
 *   `init` · `check` · `record` · `role brief`（只生成任务书，还没派）· `role scan` · `--help`
 *
 * 判据只看调用本身（工具名 + 参数里的命令），不依赖任何跨会话内存。
 * @param {string} toolName
 * @param {unknown} args
 * @returns {boolean}
 */
export function isEngagementCall(toolName, args) {
  if (toolName === 'subagent_liaison' || toolName === 'subagent_direction') return true
  if (toolName !== 'pwsh' && toolName !== 'bash') return false
  const cmd = args !== null && typeof args === 'object' && typeof args.command === 'string' ? args.command : ''
  return /warden\.mjs["']?\s+(?:role\s+say|find\s+add)\b/.test(cmd)
}

/**
 * 一次工具调用算不算"这一轮 record 过了"。
 * @param {string} toolName
 * @param {unknown} args
 * @returns {boolean}
 */
export function isRecordCall(toolName, args) {
  if (toolName !== 'pwsh' && toolName !== 'bash') return false
  const cmd = args !== null && typeof args === 'object' && typeof args.command === 'string' ? args.command : ''
  return /warden\.mjs["']?\s+record/.test(cmd)
}

/**
 * 一次工具调用算不算"跑过 check 了"。
 * @param {string} toolName
 * @param {unknown} args
 * @returns {boolean}
 */
export function isCheckCall(toolName, args) {
  if (toolName !== 'pwsh' && toolName !== 'bash') return false
  const cmd = args !== null && typeof args === 'object' && typeof args.command === 'string' ? args.command : ''
  return /warden\.mjs["']?\s+check/.test(cmd)
}

/**
 * 这个 agent 是不是子代理。
 *
 * 判据是**正面证据**：`session.header.origin === 'subagent'`
 * （`dsh-session` 的 header 校验里，`origin` 只可能是这个值）。
 *
 * ⚠ 读不到 header 时返回 `false`（= 当它是顶层会话，闸生效），**不是**返回 true。
 *   两个方向的代价不对称：
 *     · 误判成顶层 ⇒ 子代理被拦一次 —— 有界（一会话一次）、可重试放行、理由里写清了怎么办；
 *     · 误判成子代理 ⇒ **闸永远不响**，也就是这个加固整个静默失效。
 *   这正是本 skill 反复防的「没查到 ≠ 查了没问题」，所以这里不许 fail-open。
 * @param {unknown} agent
 * @returns {boolean}
 */
export function isSubagent(agent) {
  try {
    const header = agent !== null && typeof agent === 'object' ? agent.session?.header : undefined
    return header?.origin === 'subagent'
  } catch {
    return false
  }
}

/**
 * 闸的判决 —— 纯函数，`apply` 只负责把 `state` 改掉。
 * @param {{mode:string, maxDeniesPerSession:number, mutatingTools:string[]}} opts
 * @param {{engaged:boolean, denies:number}} state
 * @param {string} toolName
 * @param {boolean} subagent
 * @returns {{action:'allow'}|{action:'deny'}}
 */
export function gateDecision(opts, state, toolName, subagent) {
  if (opts.mode !== 'gate') return { action: 'allow' }
  if (subagent) return { action: 'allow' }
  if (!opts.mutatingTools.includes(toolName)) return { action: 'allow' }
  if (state.engaged) return { action: 'allow' }
  if (state.denies >= opts.maxDeniesPerSession) return { action: 'allow' }
  return { action: 'deny' }
}

// ─────────────────────────────────────────────────────────── 磁盘状态

/** 行数缓存：key = 路径，命中条件 = size + mtimeMs 都没变（每步一次 stat，不重复读盘） */
const lineCache = new Map()

function existsFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 找**工程根**：从会话工作区往上找最近的带 `.git` 的那一层（有界，最多 8 层）。
 *
 * 为什么必须有它：`.warden` 的权威是**工程根**，不是会话工作区。
 * 本项目实测踩过「**两个项目读到对方守则**」——容器目录（例如 `<WORKSPACE>`）自己
 * **没有 `.git`**，却有一个 `.warden`，于是谁在这个工作区跑都读到同一份守则。
 * 所以状态行不能只印一句「`.warden`：已建」替它背书，必须说清**这个账本是谁家的**。
 *
 * ⚠ 不缓存：`git init` 可能就发生在会话中途，缓存会把"刚变成工程根"判成"不是"。
 *   代价是有界的一次 stat 走查（≤8 次 statSync），每步一次，可以接受。
 * @param {string|null} cwd
 * @param {number} [maxUp] 最多往上走几层
 * @returns {{root:string|null, via:'self'|'ancestor'|'none'}}
 */
export function findProjectRoot(cwd, maxUp = 8) {
  if (typeof cwd !== 'string' || cwd.length === 0) return { root: null, via: 'none' }
  let cur = path.resolve(cwd)
  for (let i = 0; i <= maxUp; i += 1) {
    if (existsDir(path.join(cur, '.git'))) return { root: cur, via: i === 0 ? 'self' : 'ancestor' }
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return { root: null, via: 'none' }
}

function countLines(p) {
  try {
    const st = fs.statSync(p)
    if (!st.isFile() || st.size === 0) return 0
    const hit = lineCache.get(p)
    if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.lines
    if (st.size > MAX_COUNT_BYTES) return -1
    const text = fs.readFileSync(p, 'utf8')
    let lines = 0
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1
    if (text.length > 0 && text.charCodeAt(text.length - 1) !== 10) lines += 1
    lineCache.set(p, { size: st.size, mtimeMs: st.mtimeMs, lines })
    return lines
  } catch {
    return 0
  }
}

function showLines(v) {
  return v < 0 ? '很多' : String(v)
}

/**
 * 读工作区 `.warden/` 的**粗状态**（只读文件大小/行数，不解析内容）。
 * @param {string|null} cwd
 * @returns {{dir:boolean, spec:boolean, rounds:number, findings:number, speech:number, brain:number}}
 */
export function readWardenState(cwd) {
  const out = { dir: false, spec: false, rounds: 0, findings: 0, speech: 0, brain: 0 }
  if (typeof cwd !== 'string' || cwd.length === 0) return out
  const dir = path.join(cwd, '.warden')
  try {
    if (!fs.statSync(dir).isDirectory()) return out
  } catch {
    return out
  }
  out.dir = true
  out.spec = existsFile(path.join(dir, 'SPEC.md'))
  out.rounds = countLines(path.join(dir, 'ROUNDS.jsonl'))
  out.findings = countLines(path.join(dir, 'FINDINGS.jsonl'))
  out.speech = countLines(path.join(dir, 'ROLE_SPEECH.jsonl'))
  out.brain = countLines(path.join(dir, 'BRAIN.jsonl'))
  return out
}

// ─────────────────────────────────────────────────────────── 观测（有界）

/** 探针每进程最多写几行 —— 观测自己不许变成噪音 */
const PROBE_MAX_LINES = 8
/** 探针文件总大小上限（跨多次挂载也不许把它养大） */
const PROBE_MAX_BYTES = 65536
/** 探针文件名（落在工程根 `.warden/` 下，退 cwd，再退 tmpdir） */
const PROBE_FILE = 'team-guard-probe.jsonl'

/**
 * 装一个**有界的**观测探针。
 *
 * 为什么必须有它（「审查」独立评审 E02，2026-09-23，**这是它的核心指控**）：
 *   第一版全文 **0 处落盘/计数**，异常被空 `catch` 吞掉 ⇒
 *   「闸响过并放行」与「闸**从没被派发**」在证据上**长得一模一样**。
 *   这正是本项目那句 **「没查到 ≠ 查了没问题」**。
 *   `warden-watch.js` 早就诊断并修过同一个病（它的 `plugin-live` 探针），这里照做。
 *
 * 它证明的是**加载与派发**，不是"判决对不对"：
 *   · `mounted` —— 这一行被装上、prompt 服务在、两种形态都注册了；
 *   · `prompt-service-missing` —— 装上了但 prompt 服务不在（段与快照没注册，闸照装）；
 *   · `tool` —— 前两次工具调用各一行 ⇒ 监听器**真的被派发过**；
 *   · `deny` —— 闸真的响过；
 *   · `pre-execute-threw` —— 判据抛异常（fail-open 了，但不静默）。
 *
 * 落盘位置：`<工程根>/.warden/team-guard-probe.jsonl` → `<cwd>` → `<tmpdir>`，
 * 第一个写得进去的赢。探针自己坏了**绝不许**影响工具调用。
 * @returns {(event:string, extra?:object, agent?:unknown) => void}
 */
function makeProbe() {
  let written = 0
  const dirsFor = (agent) => {
    const out = []
    try {
      const cwd = agent?.session?.header?.cwd
      const root = findProjectRoot(typeof cwd === 'string' ? cwd : null).root
      if (root !== null) out.push(path.join(root, '.warden'))
    } catch { /* 拿不到就算了 */ }
    try { out.push(process.cwd()) } catch { /* 环境不给就算了 */ }
    try { out.push(os.tmpdir()) } catch { /* 同上 */ }
    return out
  }
  return function probe(event, extra, agent) {
    try {
      if (written >= PROBE_MAX_LINES) return
      written += 1
      const line = JSON.stringify({ at: new Date().toISOString(), ev: event, pid: process.pid, ...(extra ?? {}) }) + '\n'
      for (const dir of dirsFor(agent)) {
        try {
          fs.mkdirSync(dir, { recursive: true })
          const file = path.join(dir, PROBE_FILE)
          // 总大小闸：跨多次挂载也不许把这个文件养大（每进程 8 行 × 每次挂载）
          try {
            if (fs.statSync(file).size > PROBE_MAX_BYTES) continue
          } catch { /* 文件还不存在 ⇒ 继续 */ }
          fs.appendFileSync(file, line, 'utf8')
          return
        } catch { /* 换下一个 */ }
      }
    } catch { /* 观测自己坏了绝不许影响工具调用 */ }
  }
}

// ─────────────────────────────────────────────────────────── 插件

/**
 * 装三种形态：常驻协议段、实时状态快照、第一次写文件前的角色闸。
 * @param {import('@deepseek-ai/cordis').Context} ctx preset 的 standing scope
 */
export function apply(ctx) {
  const opts = loadOptions()
  if (opts.mode === 'off') return

  /** 有界观测探针（证明"被装上 / 被派发 / 响过"，见 makeProbe 的注释） */
  const probe = makeProbe()
  /** 前两次工具调用留痕用 */
  let toolSeen = 0

  /** 每个 agent 自己的状态（WeakMap：agent 回收即回收，不跨会话残留） */
  const sessions = new WeakMap()

  function stateOf(agent) {
    if (agent === null || typeof agent !== 'object') return null
    let st = sessions.get(agent)
    if (st === undefined) {
      st = { engaged: false, recorded: false, checked: false, denies: 0 }
      sessions.set(agent, st)
    }
    return st
  }

  function statusText(assembly) {
    try {
      const agent = assembly?.agent
      // 没有 agent 就没有"本会话"可言 ⇒ 一个字都不渲染（别往请求里塞噪音）
      if (agent === null || typeof agent !== 'object') return ''
      // 子代理不看主代理的协议与状态：那是给"派单的人"看的，对干活的人是噪音
      if (isSubagent(agent)) return ''
      const st = stateOf(agent)
      let cwd = null
      try {
        const raw = agent.session?.header?.cwd
        if (typeof raw === 'string') cwd = raw
      } catch { /* header 读不动就当未知 */ }
      const proj = findProjectRoot(cwd)
      const lines = ['【九月项目团 · 实时状态】']
      lines.push(`· 工作区：${cwd ?? '（未知）'}`)
      if (cwd === null) {
        lines.push('· .warden：读不到工作区，跳过检查')
      } else if (proj.root === null) {
        // 容器目录：**不许**替它背书（实测事故：两个项目读到对方守则）
        lines.push('· 工程根：**往上找不到 `.git`** —— 这个工作区不是工程根')
        lines.push(existsDir(path.join(cwd, '.warden'))
          ? '· .warden：工作区里**有** `.warden`，但它可能属于上层容器（本项目实测过"两个项目读到对方守则"）—— **不要**拿它当本工程的账本；要建就建在真有 `.git` 的那一层'
          : '· .warden：工作区里没有；本工作区也没有 `.git` ⇒ 先确认工程根在哪一层')
      } else {
        const w = readWardenState(proj.root)
        lines.push(`· 工程根：${proj.root}${proj.via === 'self' ? '（就是工作区）' : '（在工作区**上层**）'}`)
        if (w.dir) {
          lines.push(`· .warden：已建（SPEC ${w.spec ? '✓' : '✗'} ｜ 轮次 ${showLines(w.rounds)} ｜ 发现 ${showLines(w.findings)}`
            + ` ｜ 角色发言 ${showLines(w.speech)} ｜ 脑子 ${showLines(w.brain)} 份）`)
        } else {
          lines.push('· .warden：**还没建** —— 在工程根先跑 `init` 把用户原话逐字锁进去')
        }
      }
      if (st === null) {
        lines.push('· 本会话：状态不可用')
      } else {
        lines.push(`· 本会话：角色${st.engaged ? '已参与 ✓' : '**还没有任何角色参与**'}`
          + ` ｜ record ${st.recorded ? '✓' : '✗'} ｜ check ${st.checked ? '✓' : '✗'}`)
        if (!st.engaged) {
          lines.push('→ **动手写文件之前**先做第 0 步：init → 同一条消息里并行派 资料员 + 方向员 → 拿到维度清单再写代码。')
        } else if (!st.recorded) {
          lines.push('→ 本轮收尾别忘了 `record`；说"完成 / 修好 / 交付"之前必须 `check`（exit 0 才算过）。')
        } else if (proj.root !== null && readWardenState(proj.root).brain === 0) {
          lines.push('→ 脑子一次都没跑过：交付前派 **1 个**（默认 1 个；只有冲突 / 查得不细 / 要探索更多做法时才派第 2 个）。')
        }
      }
      return lines.join('\n')
    } catch {
      return ''
    }
  }

  // ① 常驻协议段（静态 ⇒ system prompt 不抖动；子代理那里渲染成空串 ⇒ 不占 token）
  //
  // ⚠ 它必须是**函数**：子代理与主代理跑在同一份 standing composition 上
  //   （`composeFrom` 继承的是同一个 generation），所以段本身对所有 agent 都可见；
  //   而"第 0 步 / 你是主代理"这套话对资料员/方向员/实现工程师是**错**的、也是纯噪音。
  //   渲染成 '' 的段会被 `renderPrompt` 丢掉 ⇒ 子代理的 prompt 里根本没有这一段。
  //
  // ⚠⚠ 这里**故意不用 `inject: ['systemPrompt']`**（「审查」独立评审 E08）：
  //   声明成硬依赖后，prompt 服务一旦不可用，整行会被 cordis 停到 waiting ——
  //   **三种形态连同那个闸一起静默消失**，而"加固没装上"没有任何痕迹。
  //   现在：prompt 服务在就注册段与快照，不在就只记一行探针；
  //   **闸不依赖它**，无论 prompt 服务在不在都照装。
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) {
    probe('prompt-service-missing', { mode: opts.mode })
  } else {
    systemPrompt.section({
      name: 'roles:team-protocol',
      order: SECTION_ORDER,
      text: (assembly) => (isSubagent(assembly?.agent) ? '' : protocolText()),
    })
    // ② 每步刷新的实时状态（runtime context 通道：变了才追加消息）
    systemPrompt.context({
      name: 'roles:team-status',
      order: CONTEXT_ORDER,
      text: statusText,
    })
    probe('mounted', { mode: opts.mode, section: SECTION_ORDER, context: CONTEXT_ORDER })
  }

  // ③ 第一次写文件前的角色闸（**不依赖 systemPrompt**）
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      const tool = String(exec?.name ?? '')
      const st = stateOf(exec?.agent)
      if (st !== null) {
        if (isEngagementCall(tool, exec?.arguments)) st.engaged = true
        if (isRecordCall(tool, exec?.arguments)) st.recorded = true
        if (isCheckCall(tool, exec?.arguments)) st.checked = true
        // 前两次工具调用各留一行：证明"监听器真的被派发过"，而不只是"注册过"
        if (toolSeen < 2) {
          toolSeen += 1
          probe('tool', { tool, engaged: st.engaged, denies: st.denies }, exec?.agent)
        }
        const verdict = gateDecision(opts, st, tool, isSubagent(exec?.agent))
        if (verdict.action === 'deny') {
          st.denies += 1
          probe('deny', { tool, denies: st.denies }, exec?.agent)
          return { kind: 'deny', reason: denyReason(wardenPath(), opts.maxDeniesPerSession) }
        }
      }
    } catch (e) {
      // fail-open，但**不许静默**：留一行痕迹（有界），否则"看守坏了"和"没被派发"分不开
      probe('pre-execute-threw', { err: String((e && e.message) || e).slice(0, 200) })
    }
    return next()
  })
}
