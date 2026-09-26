#!/usr/bin/env node
/*
 * task-warden DSH 插件的「外部执行体」。
 *
 * 分工：插件（活运行时里的动态代码）只负责**什么时候喊**；这个文件负责**干什么**。
 * 为什么这么分：我在插件外面读不到它的内存 —— 插件里的错误我看不见。
 * 而这个文件我能自己跑、自己读输出，出问题能定位，不用猜。
 *
 * 用法：node plugin-io.js <trigger> <turn> <by>
 *   trigger: boot | turn | manual | probe-write
 *   by     : plugin（插件喊的）| manual-cli（我手工跑的）—— 不许把自己的手跑记成插件跑的
 *
 * ⚠ **本文件是公开包的一部分**：它随插件一起发给**别的用户**，装在**别人的路径**上。
 *   ⇒ **这个文件里不许出现作者机路径**（不许出现"某个具体用户的家目录 + 用户名"，
 *     或作者机上的某个固定盘符目录），
 *     凡路径一律**运行期派生**（`process.cwd()` / `DSH_HOME` / `os.homedir()` / `os.tmpdir()`），
 *     换机器后必须仍然能工作。可见的路径示例**一律写成 `<DSH_HOME>` 这类占位符**。
 *
 * 落盘（重要）：这个子进程跑在插件的沙箱里，实测
 *   mode=workspace-write  root=<插件沙箱根>  sessionId=null
 * 也就是说 **会话工作区所在盘 和 `<DSH_HOME>` 往往都写不了（EPERM）**，
 * 只有插件自己的沙箱根和临时区能写。所以下面是「多路径镜像」：能写哪个写哪个，
 * 并把真正写成功的路径放进 liveWrote 里，好让外面知道该去哪儿看。
 *
 * 退出码：永远 0 —— check 自己的退出码放在 JSON 的 checkExit 里，
 *         这样「check 失败」和「这脚本坏掉」能分开。
 */
// ★ T0 放在**最前面**：这样 durationMs 至少把 require、7 次 statSync、读上一份快照、
//    写三处镜像都算进去。**node 自己的进程启动（几十毫秒）在进程内无论如何量不到** ——
//    这一条必须写在文档里，不能拿 durationMs 当"端到端代价"。
const T0 = Date.now()

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

/**
 * ⚠⚠ **2026-09-23 修：ROOT 原来硬编码成作者机的一个固定盘** —— 那是 R5 事故的真正病根。
 *
 * 支线守门员七席投票时的原话：「**R5 必须立即修** —— 它是两条候选的共同前置；
 *   账本找不到，屏幕和闸都是空的。硬证据：`PLUGIN-LIVE.json` 的 detail 是 `[结构] 缺 .warden/SPEC.md`，
 *   而真账本在**另一个盘**的 `task-warden\.warden\SPEC.md` 下。」
 *
 * 实测（2026-09-23）：这个常量写死 ⇒ **用户在插件沙箱根（`<插件沙箱根>`）干活，
 *   插件读写的却是作者机那个固定盘上的账** —— 屏幕上显示的是**另一个盘、另一个项目**的账。
 *   ⚠ 公开包里这条更严重：别的用户机器上那个盘**根本不存在** ⇒ 账本永远找不到。
 *
 * 现在三级解析（**都不给才退回进程当前目录**）：
 *   ① `WARDEN_ROOT` 环境变量（调用方显式指定）
 *   ② `argv[22]`（`warden-watch.js` 传"这个会话自己的工作区"）
 *   ③ `process.cwd()`（运行期值，**不再是作者机的某个盘**）
 *
 * ⚠⚠ **2026-09-23 修（公开包）：本文件是随包发给公开用户的，一个作者机路径都不许留。**
 *   三处硬编码作者机路径全部改成**运行期派生**（换机器后必须仍能工作）：
 *     · `ROOT` 兜底 `<作者机的一个固定盘>` → `process.cwd()`；
 *     · `WARDEN` 字面量 `<作者机绝对路径>\skills\task-warden\warden.mjs` → 由 `DSH_HOME` 推导（见下）；
 *     · `OUT_DIRS` 里的 `<作者机家目录>\DSH-Workspace\task-warden` → `os.homedir()` 推导。
 *   **为什么不能退回作者机路径**：别的用户机器上那个路径不存在 ⇒ `execFileSync` 必然 ENOENT
 *   ⇒ 插件"装了等于没装"。宁可**明确降级**（拿到人话错误），也不许猜一条别人的路径。
 */
const ROOT = process.env.WARDEN_ROOT || process.argv[22] || process.cwd()

/**
 * ★ **warden.mjs 的位置：运行期推导，不许写死作者机路径**（公开包硬要求）。
 *
 * 为什么要费这个劲：`WARDEN` 原来是一个**写死的作者机绝对路径**，
 *   而它被三处 `execFileSync(process.execPath, [WARDEN, 'init'|'check'|'roles', ...])` 用（下方 L246/L283/L344 附近）。
 *   ⇒ 换到别的用户机器上：那个路径**不存在** ⇒ 每次都是 ENOENT
 *   ⇒ **插件"装了等于没装"**：屏幕上永远是"check 没跑成"，用户以为是自己环境不好。
 *
 * 三级解析（**按可靠性从高到低**，都推不出来就返回 `null`，由调用处报人话）：
 *   ① `TASK_WARDEN_MJS` 环境变量 —— 显式指定，最高优先（测试 / 非标准安装位置）
 *   ② `<DSH_HOME>/skills/task-warden/warden.mjs` —— `DSH_HOME` 是 DSH 自己注入的环境变量
 *      （本机实测 `DSH_HOME=<用户家目录>\.dsh`），**换用户就自动跟着变**
 *   ③ `<os.homedir()>/.dsh/skills/task-warden/warden.mjs` —— 退到 DSH 的默认家目录
 *      （`DSH_HOME` 没设时 DSH 本身就是用这个默认值）
 *
 * ⚠ **故意不做的事**：这里**不写"找不到就退回作者机路径"**。
 *   查不到就返回 `null` —— 调用处据此给出**人话错误**（"task-warden 的 warden.mjs 没找到，
 *   它应该装在 <DSH_HOME>\skills\task-warden\ 下"），而不是抛一个别人看不懂的 ENOENT。
 */
function resolveWardenMjs() {
  const candidates = []
  if (process.env.TASK_WARDEN_MJS) candidates.push(String(process.env.TASK_WARDEN_MJS))
  const dshHome = process.env.DSH_HOME
  if (dshHome) candidates.push(path.join(dshHome, 'skills', 'task-warden', 'warden.mjs'))
  try { candidates.push(path.join(os.homedir(), '.dsh', 'skills', 'task-warden', 'warden.mjs')) } catch (e) { /* 取不到家目录就算了 */ }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch (e) { /* 换下一个 */ }
  }
  return null
}
const WARDEN = resolveWardenMjs()

/**
 * ⚠ **没有 warden.mjs 时**：不是"静默跳过"，而是把**这一条**事实记进 `helperError`
 *   （它进快照的 `helperError` 字段 ⇒ 外面看得见），让屏幕报出**人话**。
 *   **不许**因此放宽任何检查、也不许伪造一个"通过" —— 只是把"为什么没跑成"说清楚。
 */
function wardenMissingNote() {
  return 'task-warden 的 warden.mjs 没找到（装了吗？）—— 应该在 <DSH_HOME>\\skills\\task-warden\\warden.mjs；'
    + '可用环境变量 TASK_WARDEN_MJS 显式指定。当前 DSH_HOME=' + JSON.stringify(process.env.DSH_HOME || '')
    + '，home=' + (function () { try { return os.homedir() } catch (e) { return '?' } })()
}
const LIVE_NAME = 'PLUGIN-LIVE.json'
const CALLS_NAME = 'PLUGIN-CALLS.jsonl'
const MAX_FEED = 80

// 按优先级镜像：第 1 个是"本该写的地方"，后面是插件沙箱真正允许的地方。
// ⚠ 公开包：第 2 项原来是写死的**一个作者机绝对路径**（<作者机家目录>\DSH-Workspace\task-warden）——
//   现在改成**运行期派生**：`<os.homedir()>/DSH-Workspace/task-warden`。
//   **为什么保留这一项而不是删掉**：它是"插件子进程真正写得进去"的兜底之一
//   （实测插件沙箱根就是 `<插件沙箱根>`，在本机恰好等于 `<家目录>\DSH-Workspace`），删了会少一条能落盘的镜像；
//   而换成 homedir 推导后，**换用户自动跟着用户的家目录走**，语义不变、路径不再属于作者。
const OUT_DIRS = [
  path.join(ROOT, '.warden'),
  (function () {
    try { return path.join(os.homedir(), 'DSH-Workspace', 'task-warden') }
    catch (e) { return null }   // 取不到家目录 → 这一项作废，由下面的临时区兜底
  })(),
  os.tmpdir(),
].filter(Boolean)

const trigger = process.argv[2] || 'unknown'
const turn = Number(process.argv[3] || 0) || 0
const by = process.argv[4] || 'unknown'
// 插件认到的「我属于哪个会话」（R20：提示只许在那个窗口显示）+ 它从哪儿认出来的 + 收到过几个轮次事件
const owner = (process.argv[5] && process.argv[5] !== '-') ? process.argv[5] : ''
const ownerSource = (process.argv[6] && process.argv[6] !== '-') ? process.argv[6] : ''
const agentEvents = Number(process.argv[7] || 0) || 0
const helperError = []
const mirrorDenied = []

// ── 0b) 量沙箱：子进程的三种 stdio 到底哪种能用 ───────────────────────────
// 实测踩到的坑：插件沙箱里 `execFileSync(..., stdio:['ignore','pipe','pipe'])`
// 直接 EPERM（受限模式下不能开命名管道）—— 于是 check 永远跑不起来。
if (trigger === 'probe-spawn') {
  const f = path.join(os.tmpdir(), 'ps-out.txt')
  const res = {}
  try {
    execFileSync(process.execPath, ['-e', 'process.stdout.write("A")'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    res.pipes = 'OK'
  } catch (e) { res.pipes = 'FAIL ' + String(e.code || e.message) }
  try {
    const fd = fs.openSync(f, 'w')
    try {
      execFileSync(process.execPath, ['-e', 'process.stdout.write("B")'], { stdio: ['ignore', fd, fd] })
      res.fds = 'OK'
    } finally { fs.closeSync(fd) }
    res.fdsContent = fs.readFileSync(f, 'utf8')
  } catch (e) { res.fds = 'FAIL ' + String(e.code || e.message) }
  try {
    execFileSync(process.execPath, ['-e', '0'], { stdio: 'ignore' })
    res.ignore = 'OK'
  } catch (e) { res.ignore = 'FAIL ' + String(e.code || e.message) }
  process.stdout.write(JSON.stringify({ verb: 'probe-spawn', res: res }))
  process.exit(0)
}

// ── 0c) 状态指纹去重 ───────────────────────────────────────────────────────
// 两个脑子与记录角色的共同要求：纯时间窗（N 秒）回答不了"结论会不会变旧"。
// 所以按**账本指纹**（每个账本文件的大小 + mtime）判：指纹没变且上一跑很近 → 不跑 check，
// 直接回放上一次快照（skipped:true）。这样"别的窗口触发干活"在账本没动时几乎零成本。
const LEDGERS = [
  '.warden/SPEC.md', '.warden/VOICE.jsonl', '.warden/CLAIMS.jsonl', '.warden/ROUNDS.jsonl',
  '.warden/DEVIATIONS.md', '.warden/INCIDENTS.jsonl', '.warden/RULES.jsonl',
]
function ledgerFingerprint() {
  const parts = []
  for (const rel of LEDGERS) {
    try {
      const s = fs.statSync(path.join(ROOT, rel))
      parts.push(rel + ':' + String(s.size) + ':' + String(Math.round(s.mtimeMs)))
    } catch (e) { parts.push(rel + ':missing') }
  }
  return parts.join('|')
}
const fpNow = ledgerFingerprint()
/**
 * ★ 上一份快照 —— 提前读出来，好在**同一轮**里比"角色健康签名有没有变"。
 *   为什么要比：用户要的「角色在跑：N/8」那一行**每轮都会算出同样的结论**，
 *   而提问闸门定过规矩 —— **同主题只问一次、不许变成每轮必响的噪音**（R19/R43）。
 *   所以：**签名变了才推到用户那一行**；没变就只记进快照（AI 自己看得到）。
 */
const prevSnap = (function () {
  for (const dir of OUT_DIRS) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, LIVE_NAME), 'utf8')) } catch (e) { /* 换下一个镜像 */ }
  }
  return null
})()
const sinceFp = process.argv[13] || ''
const sinceAt = Number(process.argv[14] || 0) || 0
const SKIP_WINDOW_MS = 5 * 60 * 1000
if (trigger === 'turn' && sinceFp !== '' && sinceFp === fpNow && sinceAt > 0 && (Date.now() - sinceAt) < SKIP_WINDOW_MS) {
  let prev = null
  for (const dir of OUT_DIRS) {
    try { prev = JSON.parse(fs.readFileSync(path.join(dir, LIVE_NAME), 'utf8')); break } catch (e) { /* 换下一个镜像 */ }
  }
  if (prev !== null && typeof prev === 'object') {
    const t2 = Date.now()
    prev.at = t2
    prev.atIso = new Date(t2).toISOString()
    prev.trigger = trigger
    prev.turn = turn
    prev.by = by
    prev.owner = owner
    prev.ownerSource = ownerSource
    prev.skipped = true
    prev.skipReason = '账本指纹未变，且距上一跑 < ' + String(SKIP_WINDOW_MS) + ' ms'
    prev.fingerprint = fpNow
    prev.durationMs = Date.now() - T0
    prev.triggerSession = process.argv[19] || ''
    prev.hostSlots = Number(process.argv[20] || 0) || 0
    prev.hostSlotHit = process.argv[21] || ''
    prev.liveWrote = []
    prev.mirrorDenied = []
    process.stdout.write(JSON.stringify(persist(prev)))
    process.exit(0)
  }
  // 读不到上一次快照就只能老老实实跑
}

function readJsonl(rel) {
  try {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const out = []
    for (const raw of text.split('\n')) {
      const s = raw.trim()
      if (!s.startsWith('{')) continue
      try { out.push(JSON.parse(s)) } catch (e) { /* 坏行跳过 */ }
    }
    return out
  } catch (e) {
    // ⚠ **文件"还不存在"是正常状态**（可选账本：角色还没发过言、还没人投票、还没事故…），
    //   不是"插件自身坏了"。原来一律记进 helperError ⇒ ok=false ⇒ 用户看到「没跑成（自身故障）」。
    //   实测（2026-09-17）：就因为 `.warden/ROLE_SPEECH.jsonl` 还没建，插件连报 3 次 ENOENT、
    //   ok=false，把一条**假警报**推到了用户那一行上 —— 假警报喊多了，真故障就没人看了。
    //   只有"读得到却读不动"（EACCES 等）才算故障。
    if (e && e.code !== 'ENOENT') helperError.push('读 ' + rel + ' 失败: ' + e.message)
    return []
  }
}

function pick(rows, fn) {
  const out = []
  for (const r of rows) {
    if (r === null || typeof r !== 'object') continue
    const item = fn(r)
    if (item) out.push(item)
  }
  return out
}

// ── 0) 量沙箱：哪些路径可写（给"插件到底能写哪儿"留证据）──────────────
if (trigger === 'probe-write') {
  const res = OUT_DIRS.map(function (p) {
    const f = path.join(p, 'PROBE-WRITE.txt')
    try {
      fs.mkdirSync(p, { recursive: true })
      fs.writeFileSync(f, 'probe', 'utf8')
      return { path: f, ok: true }
    } catch (e) { return { path: f, ok: false, err: String(e.code || e.message) } }
  })
  process.stdout.write(JSON.stringify({ verb: 'probe-write', cwd: process.cwd(), res: res }))
  process.exit(0)
}

// ── 1) 跑 check ────────────────────────────────────────────────────────────
// 注意：**不许用管道**（stdio 'pipe' 在插件沙箱里 EPERM）。改成把子进程的
// stdout/stderr 直接指到一个临时文件的 fd 上，跑完再读回来。
let checkExit = null
let stdout = ''
let stderr = ''
const tmpOut = path.join(os.tmpdir(), 'task-warden-check-' + String(process.pid) + '.txt')

/**
 * ★★ **没有账本 ⇒ 先建骨架**（2026-09-23 新增）。
 *
 * 依据（七席投票里唯一的全体共识）：
 *   · **支线守门员**：「**R5 必须立即修** —— 它是两条候选（回合边界 / 看得见）的**共同前置**；
 *     账本找不到，屏幕和闸都是空的。」硬证据：`PLUGIN-LIVE.json` 的 detail 是
 *     `[结构] 缺 .warden/SPEC.md`，而真账本在**另一个盘**的 `task-warden\.warden\SPEC.md` 下。
 *   · **记录**：「当前红是**结构性**的（7 个账本文件全 missing），不是模型一轮能补完的。」
 *   · 用户原话：「（用户原话已隐去 —— 公开版不留逐字）」+「我要的是一个**真正能够安装就能够正常使用**的」
 *     + R25 的必须项「新窗口自动建轮次（**不是拒交**）」。
 *
 * 实测（2026-09-23，在临时副本上跑）：`warden.mjs init` 在"有 .warden 只有插件文件、没有 .git"的目录里
 *   **照样能建出骨架**（SPEC.md / ROUNDS.jsonl / params.yml / CLAIMS.jsonl / config.json）。
 * ⇒ 插件每轮开工前先补这一步，**让"这个窗口有自己的轮次"变成真的**，而不是只报"缺 SPEC.md"。
 * ⚠ 只建骨架、**不编任何需求**（空 SPEC 仍算"没有需求"，交付闸照样拦）—— 原话必须由 agent 逐字锁进去。
 */
let autoInit = null
try {
  const specPath = path.join(ROOT, '.warden', 'SPEC.md')
  if (!fs.existsSync(specPath)) {
    if (WARDEN === null) {
      // ⚠ 公开包：找不到 warden.mjs ⇒ **不假装建过骨架**，把原因如实报出来（人话）。
      autoInit = 'skipped:' + wardenMissingNote()
    } else {
    const tmpInit = path.join(os.tmpdir(), 'task-warden-init-' + String(process.pid) + '.txt')
    const fd0 = fs.openSync(tmpInit, 'w')
    try {
      execFileSync(process.execPath, [WARDEN, 'init'], { cwd: ROOT, timeout: 30000, stdio: ['ignore', fd0, fd0] })
      autoInit = 'created'
    } catch (e) {
      autoInit = 'failed:' + String(e.code || e.message).slice(0, 60)
    } finally { fs.closeSync(fd0) }
    }
  }
} catch (e) { autoInit = 'threw:' + String((e && e.message) || e).slice(0, 60) }

/**
 * ★★ **结构化事实：本账本里到底有几条需求**（2026-09-24 加；修「审查」查出的 A1）。
 *
 * 为什么要有它：回合边界那个"这个窗口还没有账本"的判据，**原来是按中文子串判的**
 *   （`/缺 \.warden\/SPEC\.md/`）。而**自动建骨架之后的常态**是：SPEC.md **存在**但零条 `## R#`，
 *   此时 check 的真实文案是 `[需求] SPEC.md 里一条需求都没有` —— **不含那句子串**
 *   ⇒ `no-ledger` 分支**永远不会响**，它当时不闯祸只是因为 `checkExit===1 → 不说话` 兜住了。
 *   审查的原话：「**fail-closed 是运气，不是判据**」；而且文案一改（比如我那个 R5 修复
 *   把 `[结构] 缺 .warden/SPEC.md` 换成了 `[需求] SPEC.md 里一条需求都没有`）判据就死。
 *
 * ⇒ 现在把**事实**算出来放进快照（`reqCount`），判据读事实、不读文案。
 *   `reqCount === 0` 就是"没有账本"的**定义**，与任何一句话怎么写都无关。
 */
let reqCount = null
let specExists = false
try {
  const sp = path.join(ROOT, '.warden', 'SPEC.md')
  specExists = fs.existsSync(sp)
  if (specExists) {
    const txt = fs.readFileSync(sp, 'utf8')
    reqCount = (txt.match(/^##\s+R\d+\b/gm) || []).length
  } else {
    reqCount = 0
  }
} catch (e) { reqCount = null }

try {
  const fd = fs.openSync(tmpOut, 'w')
  try {
    if (WARDEN === null) {
      // ⚠ 公开包：warden.mjs 找不到 ⇒ `checkExit` **保持 null**（= "没跑成"，
      //   与 exit 1 的"check 未通过"是两回事，这个区分是上面 L358 那段注释定下的口径）。
      //   同时把**人话原因**记进 helperError ⇒ ok=false、屏幕上说得出来为什么。
      helperError.push(wardenMissingNote())
    } else {
    execFileSync(process.execPath, [WARDEN, 'check'], {
      cwd: ROOT, timeout: 45000, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', fd, fd],
    })
    checkExit = 0
    }
  } catch (e) {
    if (typeof e.status === 'number') checkExit = e.status
    else helperError.push('跑 check 失败(基础设施): ' + String(e.code || e.message))
  } finally {
    fs.closeSync(fd)
  }
  stdout = fs.readFileSync(tmpOut, 'utf8')
} catch (e) {
  helperError.push('check 输出落盘/读取失败: ' + String(e.code || e.message))
}
try { fs.unlinkSync(tmpOut) } catch (e) { /* 清不掉就算了 */ }

const outLines = (stdout + '\n' + stderr).split('\n')
let headline = ''
const bullets = []
for (const raw of outLines) {
  const s = raw.trim()
  if (s.startsWith('需求监督通过') || s.startsWith('需求监督未通过')) headline = s
  else if (s.startsWith('-') && s.includes('[')) bullets.push(s.replace(/^-\s*/, ''))
}
if (headline === '') {
  // ⚠ 这里原来写 "check 未通过（exit null）" —— 隔壁窗口指出：**null 分不开两件事**
  //   （check 真失败但没拿到码 vs 执行体自己坏了），而这套东西反复踩的就是"没查到 ≠ 查了没问题"。
  //   所以现在显式分开：checkRan=false 一律说"没跑成"，不许说成"check 未通过"。
  headline = checkExit === 0 ? 'check 通过'
    : (checkExit === null ? 'check 没跑成（不是 check 失败：执行体/环境层面的问题）'
      : ('check 未通过（exit ' + String(checkExit) + '）'))
}

let claimed = null
let total = null
const m = /已认领\s*(\d+)\s*\/\s*共\s*(\d+)/.exec(stdout)
if (m) {
  claimed = Number(m[1])
  total = Number(m[2])
}
// 角色发言条数（R6）：进快照给自己看，不进用户那一行
let speechCount = 0
try { speechCount = readJsonl('.warden/ROLE_SPEECH.jsonl').length } catch (e) { speechCount = 0 }

// ── 1b) 角色健康：「角色是不是摆设」的机械仪表（用户 2026-09-16 逐字要的那个"呈现"）
//   用户原话：「（用户原话已隐去 —— 公开版不留逐字）」「监督员要保证几个角色是正确在运行。」
//   判据在 warden.mjs 的 `rolesHealth`（【硬】票数/反对率/有无产出、【代理】独有项/同构），
//   那一行的措辞也**由 warden.mjs 产生**（`roles --health --json` 的 line 字段）——
//   **不许插件自己再拼一套**（两套措辞 = 两套口径，这正是本 skill 反复防的事）。
let rolesLine = ''
let rolesSig = ''
let rolesLineDeco = ''
let rolesExit = null
let rolesRan = false
let rolesRaw = ''
try {
  const tmpRoles = path.join(os.tmpdir(), 'task-warden-roles-' + String(process.pid) + '.txt')
  const fd2 = fs.openSync(tmpRoles, 'w')
  try {
    if (WARDEN === null) {
      // ⚠ 公开包：找不到 warden.mjs ⇒ `rolesRan` **保持 false**、`rolesExit` 保持 null
      //   （= "没跑成"，不是"角色健康检查失败" —— 后者是 rolesExit=1 的**结论**，不许混）。
      //   rolesRan=false 时下面 rolesChanged 恒为 false ⇒ **不会**把"角色在跑"那行错误地推给用户。
      helperError.push(wardenMissingNote())
    } else {
    execFileSync(process.execPath, [WARDEN, 'roles', '--health', '--json'], {
      cwd: ROOT, timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', fd2, fd2],
    })
    rolesExit = 0
    }
  } catch (e) {
    // exit 1 = 有角色被查出问题（**这是结论，不是故障**）；拿不到状态码才算基础设施问题
    if (typeof e.status === 'number') rolesExit = e.status
    else helperError.push('跑 roles --health 失败(基础设施): ' + String(e.code || e.message))
  } finally {
    fs.closeSync(fd2)
  }
  const raw = fs.readFileSync(tmpRoles, 'utf8')
  rolesRaw = raw                     // 后面拼「名字 · 职称」要用同一份 JSON（**不许再跑一次、也不许自己抄职称表**）
  try { fs.unlinkSync(tmpRoles) } catch (e) { /* 清不掉就算了 */ }
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a >= 0 && b > a) {
    const h = JSON.parse(raw.slice(a, b + 1))
    rolesRan = true
    rolesLine = String(h.line || '')
    const bad = (h.roles || []).filter(function (r) { return (r.flags || []).length })
    // 签名 = 谁有问题 + 问题条数（**不含时间**，否则每次都算"变了"）
    rolesSig = bad.map(function (r) { return String(r.role) + ':' + String((r.flags || []).length) }).join(',')
    rolesLineDeco = bad.filter(function (r) {
      return (r.flags || []).some(function (f) { return /装饰/.test(String(f)) })
    }).map(function (r) { return String(r.role) }).join('、')
  }
} catch (e) {
  helperError.push('roles --health 输出落盘/读取失败: ' + String(e.code || e.message))
}
const rolesChanged = rolesRan && rolesSig !== String((prevSnap && prevSnap.rolesSig) || '')

// ── 2) 角色的发言 → 一行一条（网游聊天区那套，**每行前面是「名字 · 职称」**）────
/**
 * 用户 R6（2026-09-17 逐字）：「（用户原话已隐去 —— 公开版不留逐字）」
 * ⇒ `名字 · 职称` 从哪里来：**只有一张表**（`warden.mjs` 的 `ROLE_REGISTRY`），
 *   插件不许自己再抄一份 —— 所以通过上面那次 `roles --health --json` 把职称读回来。
 * ⚠ 拿不到职称时**只显示名字**（显示退化），**绝不许编一个职称**。
 */
const titleOf = {}
try {
  const a = rolesRaw.indexOf('{')
  const b = rolesRaw.lastIndexOf('}')
  if (a >= 0 && b > a) {
    const h = JSON.parse(rolesRaw.slice(a, b + 1))
    for (const r of (h.roles || [])) if (r && r.role && r.title) titleOf[String(r.role)] = String(r.title)
  }
} catch (e) { /* 读不到就只显示名字 */ }
const sayWho = function (role) {
  const t = titleOf[String(role || '')]
  return t ? (String(role) + ' · ' + t) : String(role)
}
/**
 * ★ **从多个账本读 feed**（2026-09-17 修，用户实测报的 bug）。
 *
 * 用户原话：「（用户原话已隐去 —— 公开版不留逐字）」
 * 根因：这里原来**只读工作区那一本账**（`ROOT/.warden`），而本轮所有工作都在
 *   而在**另一个盘**的 `task-warden\.warden` 里（票 12:16Z、发现 12:23Z），工作区那本的最新活动
 *   停在 10:04Z ⇒ 浮层永远显示三小时前的东西。**读错了账本，不是渲染坏了。**
 *
 * 现在：工作区账本 + **它下面每个"有 .git 且有 .warden"的子目录**（= 各子工程），
 *   按时间合并。深度只下探一层、且必须同时有 `.git` 与 `.warden` —— 这是有界的，
 *   不会把 `_lab` 里那些实验沙箱也扫进来（它们没有 .git 吗？有 —— 但它们在 `_lab` 下，
 *   而 `_lab` 自己没有 .git，所以这一层扫不到它们）。
 */
function feedLedgers() {
  const out = [{ dir: path.join(ROOT, '.warden'), tag: '' }]
  try {
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = path.join(ROOT, e.name)
      if (fs.existsSync(path.join(p, '.git')) && fs.existsSync(path.join(p, '.warden'))) {
        out.push({ dir: path.join(p, '.warden'), tag: e.name })
      }
    }
  } catch (e) { /* 扫不动就算了 */ }
  return out
}
const FEED_LEDGERS = feedLedgers()

/** 读任意绝对路径的 JSONL（与 readJsonl 同一套容错：只有"读得到却读不动"才算故障） */
function readJsonlAbs(p) {
  try {
    const text = fs.readFileSync(p, 'utf8')
    const out = []
    for (const raw of text.split('\n')) {
      const s = raw.trim()
      if (!s.startsWith('{')) continue
      try { out.push(JSON.parse(s)) } catch (e) { /* 坏行跳过 */ }
    }
    return out
  } catch (e) {
    if (e && e.code !== 'ENOENT') helperError.push('读 ' + p + ' 失败: ' + e.message)
    return []
  }
}
/** 跨账本收集：每个账本读同一个文件，给每条盖上来源标签 */
function pickAll(name, fn) {
  const out = []
  for (const L of FEED_LEDGERS) {
    const rows = readJsonlAbs(path.join(L.dir, name))
    for (const r of rows) {
      const item = fn(r)
      if (item) { item.src = L.tag; out.push(item) }
    }
  }
  return out
}

const votes = pickAll('VOTES.jsonl', function (r) {
  if (typeof r.role !== 'string') return null
  return { at: String(r.at || ''), role: sayWho(r.role), text: String(r.choice || '') + '｜' + String(r.topic || '') + '｜' + String(r.reason || '') }
})
const brains = pickAll('BRAIN.jsonl', function (r) {
  const v = r.verdict === 'accept' ? '通过' : (r.verdict === 'reject' ? '打回' : String(r.verdict || ''))
  return { at: String(r.at || ''), role: '脑子' + String(r.brain || '?'), text: v + '｜' + String(r.artifact || '') + '｜' + String(r.issues || r.reason || '') }
})
const incidents = pickAll('INCIDENTS.jsonl', function (r) {
  return { at: String(r.at || ''), role: '记录', text: String(r.id || '') + '｜' + String(r['现象'] || '') }
})
/**
 * ★ 角色发言（用户 R6，2026-09-17 逐字要的）：「（用户原话已隐去 —— 公开版不留逐字）」
 *   ⇒ 把 `ROLE_SPEECH.jsonl` 的发言**逐字**喂进栏目：`role` 字段拼成 **`名字 · 职称`**，
 *     `text` 是**原话，一个字不改**（不截断、不润色、不加"它认为"、不合并）。
 *   ⚠ 这一条和上面那些"从我票/事故表推出来的一行"**不是一回事**：这是角色**自己说**的。
 */
const speeches = pickAll('ROLE_SPEECH.jsonl', function (r) {
  if (typeof r.role !== 'string') return null
  const title = String(r.title || '')
  return { at: String(r.at || ''), role: title ? (r.role + ' · ' + title) : r.role, text: String(r.text || '') }
})

/**
 * ★ **发现台账也要进 feed**（2026-09-17 补，我自己的 L29 当场抓出来的）。
 *
 * 病根：feed 原来只拼 `votes + brains + incidents + speeches` —— **漏了 FINDINGS**。
 *   而两个干活角色（资料员 / 方向员）的**真实产出通道就是发现台账** ⇒
 *   它们干了活，浮层里一个字都不显示。
 *   实测：task-warden 最新发现 12:23:42Z，而 feed 最后一条停在 12:16:25Z。
 * 形态按用户 R6：`名字 · 职称：原话`；发现落在哪条 R# 跟在正文后面。
 */
const finds = pickAll('FINDINGS.jsonl', function (r) {
  const by = String(r.by || '').trim()
  if (!by) return null
  const ref = String(r.ref || '').trim()
  return { at: String(r.at || ''), role: sayWho(by), text: String(r.text || '') + (ref ? '｜落到 ' + ref : '') }
})

let feed = votes.concat(brains, incidents, speeches, finds)
feed.sort(function (a, b) { return a.at < b.at ? -1 : (a.at > b.at ? 1 : 0) })
if (feed.length > MAX_FEED) feed = feed.slice(feed.length - MAX_FEED)
feed = feed.map(function (r, i) { return { seq: i + 1, at: r.at, role: r.role, text: r.text, src: r.src || '' } })

// ── 3) 那一刻的结论：**正常运行时一个字都不显示**（用户 R43）─────────────────
// 原话：「关于插件的自言自语尽量精简，人类用户阅读不了那么多内容。只要它们在正常运行就好了。」
// ⇒ 界线划清了：**正常运行 = 不需要他知道**。欠账条数、发现条数这类是我的记账，
//    进他的视线就是噪音（R19「不要一直出现在这里」、R21「对用户有影响的内容才显示」的进一步收紧）。
// 计数照旧写进 PLUGIN-LIVE.json / PLUGIN-CALLS.jsonl，供 AI 自己看；只是**不再推给他**。
// 唯一还会显示的情况：check 硬失败**且涉及某条 R#**（= 交付可能不对）—— 也只留一行、不带话术。
let staleCount = null
const mStale = /\[查出来没做\][^\n]*?有\s*(\d+)\s*条/.exec(stdout)
if (mStale) staleCount = Number(mStale[1])
// 发现台账里"还没落到做"的条数（资料员/方向员查到了但没接进清单）—— 记账用，不推给他
let staleFindings = null
const mFind = /\[发现\][^\n]*?有\s*(\d+)\s*条发现/.exec(stdout)
if (mFind) staleFindings = Number(mFind[1])
let notice = ''
/**
 * ★★ **脑子那一行**（2026-09-17 用户报的：「脑子不见了，我已经很久没看到它了」）。
 *
 * 查清的事实：机制**没被删**。真问题是两件事：
 *   ① 那天我用**子代理**跑脑子、却**没落账** ⇒ 判决从没进过界面；
 *   ② **`check` 根本不看脑子台账** ⇒ "改了高风险产物却没重新派脑子"是隐形的。
 *   ②已在 `warden.mjs` 的 check 里补了接线（输出一行 `[脑子] …`），这里把它**顶到界面上**。
 * 纪律与 rolesLine 一样：**签名变了才顶上来**（同主题只问一次）；没变就一个字都不加。
 * ⚠ **必须算在 notice 之前** —— 我第一版放在 notice 后面，于是 notice 用的时候它还是 undefined，
 *   界面永远看不到（这种"顺序写错"正是本项目一直在防的那类静默失败）。
 */
let brainLine = ''
let brainSig = ''
const mBrain = /\[脑子\][^\n]*/.exec(stdout)
if (mBrain) {
  brainLine = String(mBrain[0]).replace(/^\[脑子\]\s*/, '').trim()
  // 只有**真问题**才值得占这一行：★ 结论不成立 / 冲突未裁决 / 一个产物都没有
  const isProblem = /★/.test(brainLine) || /一个产物都没有/.test(brainLine)
  if (!isProblem) brainLine = ''
  brainSig = brainLine ? String(brainLine).replace(/\s+/g, '').slice(0, 120) : ''
}
const brainChanged = !!brainLine && brainSig !== String((prevSnap && prevSnap.brainSig) || '')

// ⚠ 用户 R44（**纠正 R43**）：「如果在界面上不显示对审下 token 没有作用，就可以显示出来。
//    滚动至少让我晓得任务在进行，我可以按重点看一眼。有纠错的可能。」
//   ⇒ 界面通道**不花 token**（实测这条 notice 从未进过模型上下文：本会话里以 plugin 来源进上下文的
//    只有 dsh-system-prompt，warden 注入 0 条），所以正常运行时**也要出一行** —— 他要的是"看得见在动"。
//   三级优先：① 自身故障 ② check 失败 ③ 进行中（带时间戳，这样一直在滚，看得出心跳）。
//   仍然只允许**一行**；小/细/灰/可×掉由客户端半边负责；欠账数这类记账不进这一行（那是给 AI 的通道，规则 R26）。
if (checkExit === null || helperError.length > 0) {
  notice = '监督员：没跑成（自身故障）'
} else if (checkExit !== 0) {
  const n = /(\d+)\s*条/.exec(headline)
  notice = '监督员：check 未通过 ' + (n ? n[1] : '?') + ' 条'
  /**
   * ⚠ 2026-09-17 补：**脑子那一行不许被 check 失败挡住**。
   *   实测：工作区那本账 check 红着，于是 notice 永远停在"check 未通过 N 条"，
   *   脑子的"结论不成立"一个字都露不出来 —— 这正是用户说的「脑子不见了」的一个机制。
   *   ⇒ 失败时把它接在后面（仍是一行）。
   */
  if (brainChanged) notice += ' ｜ 脑子：' + String(brainLine).replace(/\s+/g, ' ').slice(0, 60)
} else {
  const hhmm = new Date().toTimeString().slice(0, 5)
  const brief = function (s, n) { const t = String(s || '').replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n) + '…' : t }
  // "现在在推进哪条" 从 ROUNDS 尾行读 —— 这才是真正的进度；角色发言只当"最近一条"，且太旧就不显示
  // （否则会出现"时间戳是新的、内容是 11:53 的旧发言"这种看着在动其实在骗人的行）。
  const rounds = readJsonl('.warden/ROUNDS.jsonl')
  const lastRound = rounds.length ? rounds[rounds.length - 1] : null
  const cur = lastRound && lastRound.requirement
    ? ('进行中 ' + String(lastRound.requirement) + '(' + String(lastRound.status || '') + ')')
    : '账本检查通过'
  notice = '监督员·' + hhmm + ' ｜ ' + cur
  const lastFeed = feed.length ? feed[feed.length - 1] : null
  const fresh = lastFeed && lastFeed.at && (Date.now() - Date.parse(lastFeed.at) < 2 * 3600 * 1000)
  if (fresh) notice += ' ｜ ' + String(lastFeed.role || '') + '：' + brief(lastFeed.text, 28)
  /**
   * ★ 角色健康那一行：**签名变了才顶上来**（同主题只问一次 —— 提问闸门的规矩）。
   *   为什么值得占掉这一行：用户明确说过「不能糊弄人导致最后角色只是个摆设」，
   *   而"某角色是装饰"正是他自己要看的、可感知的差异（不是我的自言自语）。
   *   没变的时候**一个字都不加**：结论照样写进快照的 rolesLine/rolesSig，AI 自己能看到。
   */
  if (rolesChanged) {
    notice = '监督员·' + hhmm + ' ｜ ' + rolesLine
  }
  /**
   * ★ 脑子那一行（2026-09-17 用户报的「脑子不见了」）：与角色那一行同一套纪律 ——
   *   **签名变了才顶上来**；没变就不占这一行（结论照旧写进快照）。
   *   优先于角色那一行：脑子的"结论不成立"比"某角色是装饰"更该让人看见。
   */
  if (brainChanged) {
    notice = '监督员·' + hhmm + ' ｜ 脑子：' + brief(brainLine, 70)
  }
}

const now = Date.now()
const snap = {
  at: now,
  atIso: new Date(now).toISOString(),
  trigger: trigger,
  turn: turn,
  by: by,
  owner: owner,
  ownerSource: ownerSource,
  agentEvents: agentEvents,
  // 最近一次轮次事件是哪个会话发来的 —— 用来抓"事件跨会话串"这种毛病
  lastEventSession: process.argv[9] || '',
  polls: Number(process.argv[10] || 0) || 0,
  foreignEvents: Number(process.argv[11] || 0) || 0,
  ignoredEvents: Number(process.argv[12] || 0) || 0,
  // 插件自己的 shell 执行环境里带没带会话号 —— 这是最硬的归属来源（比事件可靠）
  sessionIdFromEnv: String(process.env.DSH_SESSION_ID || ''),
  initiatorProbe: process.argv[8] || '',
  // Host 侧的常量与状态也报进来 —— 它们没有落盘文件（在动态代码里），
  // 只有报进镜像，审查者才核得到"已实现 vs 打算做"。
  hostMinGapMs: Number(process.argv[15] || 0) || 0,
  hostFailLimit: Number(process.argv[16] || 0) || 0,
  hostFails: Number(process.argv[17] || 0) || 0,
  hostSlot: process.argv[18] || '',
  // 触发这次运行的**会话号**，以及 Host 内存里"分槽"的实况 ——
  // 没有这两样，"按会话分槽"就只是声称（脑子 B 的核心指控）。
  triggerSession: process.argv[19] || '',
  hostSlots: Number(process.argv[20] || 0) || 0,
  hostSlotHit: process.argv[21] || '',
  checkExit: checkExit,
  // ⚠ 隔壁窗口指出：checkExit=null 分不开"check 真失败"与"执行体自己坏了"。
  //   所以显式给一个布尔：checkRan=false 时**一句"check 未通过"都不许说**。
  checkRan: checkExit !== null,
  // ★ 2026-09-23：这一轮有没有**自动建过账本骨架**（R5 前置 / R25「自动建轮次」）。
  //   放在快照里，探针与回合边界的判据才读得到"这一步真跑过没有"。
  autoInit: autoInit,
  // ★★ 2026-09-24：**结构化事实** —— 本账本里 `## R#` 的条数，以及 SPEC 在不在。
  //   回合边界的"没有账本"判据读这两个字段，**不读中文文案**
  //   （审查查出 A1：按子串判时，我自己的 R5 修复改了文案 ⇒ 判据永远不命中，安全是碰巧的）。
  reqCount: reqCount,
  specExists: specExists,
  line: headline,
  detail: bullets.join(' ‖ '),
  claimed: claimed,
  total: total,
  unclaimed: (claimed === null || total === null) ? null : (total - claimed),
  notice: notice,
  // ⚠ 这两个计数原来**算完就丢**（我对用户说过"照旧写进 LIVE"，那是假话 —— 「审查」核出 snap 里没这两个字段）。
  //   现在真写进来：这是"给模型看的那条通道"（规则 R26）的数据源，AI 自己读快照就能看到账本状态。
  staleCount: staleCount,
  staleFindings: staleFindings,
  // ★ 角色健康（「角色是不是摆设」）：那一行 + 签名 + **这一轮有没有变化**。
  //   签名存下来是为了"同主题只问一次"：下一轮签名没变就不推给用户（但字段照旧可查）。
  rolesLine: rolesLine,
  rolesSig: rolesSig,
  rolesChanged: rolesChanged,
  // ★ 脑子那一行（2026-09-17 补）：结论不成立 / 冲突未裁决 / 从没跑过时才有值
  brainLine: brainLine,
  brainSig: brainSig,
  brainChanged: brainChanged,
  rolesExit: rolesExit,
  rolesRan: rolesRan,
  rolesDecorative: rolesLineDeco,
  // ★ 角色发言（R6）：条数 + 最近一条的 `名字 · 职称：原话`（**逐字**，不截断）
  speechCount: speechCount,
  lastSpeech: (function () {
    try {
      const rows = readJsonl('.warden/ROLE_SPEECH.jsonl')
      const r = rows.length ? rows[rows.length - 1] : null
      if (!r) return null
      return { at: String(r.at || ''), role: String(r.role || ''), title: String(r.title || ''), text: String(r.text || '') }
    } catch (e) { return null }
  })(),
  feed: feed,
  ok: helperError.length === 0 && checkExit !== null,
  skipped: false,
  // 耗时自报（在插件沙箱里自己计的，不再是"约 1 秒"这种没出处的话）
  durationMs: Date.now() - T0,
  fingerprint: fpNow,
  liveWrote: [],
  mirrorDenied: mirrorDenied.slice(),
  helperError: helperError.length > 0 ? helperError.join(' ; ') : '',
}

// ── 4) 落盘：多路径镜像（能写哪个写哪个）──────────────────────────────────
// 注意：写不进 `<会话工作区>\.warden` 是**沙箱的预期行为**（EPERM），不是故障 ——
// 所以它进 mirrorDenied，**不污染 helperError**（那个字段要留给"执行体自己坏了"）。
function persist(out) {
  for (const dir of OUT_DIRS) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, LIVE_NAME), JSON.stringify(out, null, 2), 'utf8')
      out.liveWrote.push(dir)
    } catch (e) {
      out.mirrorDenied.push(dir + ' → ' + String(e.code || e.message))
    }
  }
  // CALLS 那行必须在 liveWrote / mirrorDenied **都定下来之后**才拼 ——
  // 否则 liveWroteCount 永远是 0、mirrorDenied 永远是空（我第一版就踩了）。
  const callLine = JSON.stringify({
    at: out.atIso, trigger: out.trigger, turn: out.turn, by: out.by,
    owner: out.owner || null, ownerSource: out.ownerSource || null,
    skipped: out.skipped === true, durationMs: out.durationMs,
    hostMinGapMs: out.hostMinGapMs, hostFailLimit: out.hostFailLimit, hostFails: out.hostFails, hostSlot: out.hostSlot,
    triggerSession: out.triggerSession, hostSlots: out.hostSlots, hostSlotHit: out.hostSlotHit,
    // 镜像被拒也写进 CALLS：CALLS 是 append-only，而 PLUGIN-LIVE.json 是单槽会被下次覆盖
    // （脑子 A 指出的：EPERM 这条证据会被下一次运行冲掉）
    mirrorDenied: out.mirrorDenied, liveWroteCount: out.liveWrote.length,
    checkExit: out.checkExit, checkRan: out.checkRan, line: out.line, feed: (out.feed || []).length,
    rolesExit: out.rolesExit, rolesRan: out.rolesRan, rolesChanged: out.rolesChanged, rolesSig: out.rolesSig,
  }) + '\n'
  // 写成功的路径：补一份最终 LIVE（第一遍写出去时 liveWrote 还没填完）+ 追加 CALLS
  for (const dir of out.liveWrote) {
    try {
      fs.writeFileSync(path.join(dir, LIVE_NAME), JSON.stringify(out, null, 2), 'utf8')
      fs.appendFileSync(path.join(dir, CALLS_NAME), callLine, 'utf8')
    } catch (e) { /* 写不进去就算了 */ }
  }
  return out
}

process.stdout.write(JSON.stringify(persist(snap)))
process.exit(0)
