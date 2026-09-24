'use strict'
/*
 * task-warden 的**常驻 Host 半边**（由 composition 行加载，不是动态包）。
 *
 * 为什么要有这个文件：动态 Cordis 包**天生不落盘**（源码写死：
 *   dsh-cordis-host-runner\README.md:12「Definitions live only in process memory,
 *   so a DSH restart clears them and nothing is written to disk.」）
 * —— 蓝屏/重启就没了。所以把"干活"那一半改写成这个普通插件，挂在
 *   %DSH_HOME%\profiles\web\cordis.patch.yml  的 insert 行上，**重启自动加载**。
 *
 * 它只做原来 Host 半边里的"干活"部分：
 *   agent/turn-stopping → 跑 .warden\plugin-io.js（内部按账本指纹去重）
 * 动态包那套 harness/客户端 RPC（live / owner-here / check-now）在这里**不存在**，
 * 所以那一行"监督员：…"的界面提示**不在本文件范围内** —— 见 RESTORE.md 的说明。
 *
 * 注意：这里能直接用 node 的东西（不受动态沙箱限制），但仍走 ctx.shell 服务，
 * 这样沙箱策略/超时口径与原来一致。
 */
/**
 * ⚠ 公开版：ROOT 与 CMD 必须**运行时推导**。
 *   原来是字面量 `'<WORKSPACE>'` —— 那是脱敏脚本写坏的：同批的 gate.mjs / preset-default-guard.mjs
 *   都改成了运行时推导，只有这个漏了。后果是插件**直接死掉**（CMD 指向一个不存在的路径），
 *   而 gate.mjs 自己写明 fail-open 是硬约束 ⇒ **执行前闸等于没有**。
 *   （这条是「脑子A」的泄漏审计抓出来的。）
 */
const ROOT = process.env.WARDEN_ROOT || process.cwd()
// ⚠ plugin-io.js 与它**放在同一个目录**（本包已带上它）—— 脑子A/B 都指出：
//   原来它没随包发布，于是 CMD 指向一个不存在的文件 ⇒ 常驻插件那条刷新线是死的。
const CMD = 'node ' + require('path').join(__dirname, 'plugin-io.js').split(require('path').sep).join('/')
const MIN_GAP_MS = 5000
const FAIL_LIMIT = 3

/**
 * ★ 观测把「轮次触发到底有没有跑成」变成可查的事实（2026-09-17 加）。
 *
 * 为什么必须加这一层：原来的代码在三个地方**只写 `console.error`** ——
 * 而这个插件跑在 DSH 的 host 进程里，**没有谁去看它的 stderr**。
 * 实测后果（`.warden/PLUGIN-CALLS.jsonl` + `warden-watch-debug.jsonl`）：
 *   · 探针显示 `turn-stopping` 事件**确实到了**（17:10 还有一行 turn=37）；
 *   · 但当天的 `trigger=turn` **一次都没有**落进 CALLS —— 最后一次插件自己跑是 15:48。
 *   ⇒ 「事件到了、`shell.run` 没成」和「事件没到」在日志上长得一模一样，**分不开**。
 *   这正是本 skill 反复防的「没查到 ≠ 查了没问题」：分不开，就等于没有证据。
 * 所以：**每一次 refresh 的结果（成功/失败 + 原样错误 + 拿到的 stdout 长度）都落一行**。
 * 落盘失败绝不抛（看守自己坏了不许影响轮次）。
 */
const DEBUG_CANDIDATES = [
  // ⚠ 公开版：改成运行时推导（原来是写死的两个绝对路径）
  //   优先环境变量 WARDEN_ROOT；否则用当前工作区。
  process.env.WARDEN_ROOT || process.cwd(),
  require('path').join(require('os').homedir(), 'DSH-Workspace', 'task-warden'),
  // ★ 第三个候选 = 临时区。为什么加：实测（资料员 2026-09-17）**前两个候选哪一个能写，
  //   取决于当前进程的沙箱根** —— agent/手动触发的进程写 D: 成功、插件子进程反过来。
  //   临时区两边都能写，所以它兜底，保证"观测"这一层永远不会因为路径不可写而整体静默。
  (function () { try { return require('os').tmpdir() } catch (e) { return null } })(),
].filter(Boolean)
function watchLog(obj) {
  try {
    const fsx = require('fs')
    const pathx = require('path')
    const line = JSON.stringify(obj) + '\n'
    for (const d of DEBUG_CANDIDATES) {
      try {
        fsx.mkdirSync(d, { recursive: true })
        fsx.appendFileSync(pathx.join(d, 'warden-watch-debug.jsonl'), line, 'utf8')
        return
      } catch (e) { /* 换下一个 */ }
    }
  } catch (e) { /* 观测自己坏了绝不许影响轮次 */ }
}

/*
 * R36：工具执行前的「要改一件已经确认完成的东西，却没先备份」闸（用户：
 * 「要保证有监督的，**错误的时候就要制止**」）。
 * 原来只能在 record / check 时拦（warden.mjs 的 reopenGate）—— 那时候文件**已经被改了**。
 * 判据全在 gate.mjs（纯函数，带 6 用例自检），这里只负责挂到事件上。
 *
 * 为什么 require 包在 try 里：这是**看守**，不是被看守的东西。它自己装不上，
 * 也绝不能让用户的工具调用失败 —— 装不上就退化成"永不拦"。
 */
let gate = null
try {
  gate = require('./gate.mjs')
} catch (e) {
  try {
    console.error('[warden-watch] R36 闸没装上（退化为不拦）：' + String((e && e.message) || e))
  } catch (_) { /* 连 console 都没有就算了 */ }
}

/**
 * ★ 「自动启用」守卫（用户 2026-09-17 逐字：「（用户原话已隐去 —— 公开版不留逐字）」）
 *   被改掉的是 `$DSH_HOME/settings.yaml` 的 `agent-presets.default`（实测：
 *   09-16 23:59 的备份 = roles，09-17 16:32 的备份 = standard）。
 *   决策逻辑在 `preset-default-guard.mjs`（纯函数 + 24 条自检）；
 *   这里只负责**定时看**、**连看两次才动手**（一次读可能是撕裂/陈旧的，不许凭它写文件）、
 *   并把动作落进 warden-watch-debug.jsonl。
 *   装不上就退化成"不检查"——看守自己坏了绝不许影响轮次。
 */
let presetGuard = null
try {
  presetGuard = require('./preset-default-guard.mjs')
} catch (e) {
  try {
    console.error('[warden-watch] 自动启用守卫没装上（退化为不检查）：' + String((e && e.message) || e))
  } catch (_) { /* 算了 */ }
}

module.exports = {
  name: 'warden-watch',
  inject: ['shell'],
  apply(ctx) {
    const shell = ctx.shell
    // R36 用：工具给的 file_path 可能是相对路径。会话工作区不一定是 ROOT，两个基准都试。
    let CWDS = [ROOT]
    try {
      const cwd = process.cwd()
      if (cwd && cwd.replace(/\\/g, '/').toLowerCase() !== ROOT.toLowerCase()) CWDS = [cwd, ROOT]
    } catch (e) { /* 拿不到 cwd 就只用 ROOT */ }
    let fp = ''
    let fpAt = 0
    let running = false
    let runs = 0
    let fails = 0

    /**
     * 看一次「自动启用」那一项。
     * 两击规则：**连续两次**读到"不是 roles"才动手（连续调用之间没有任何等待，
     * 但每次各读一次文件）—— 目的是不让一次撕裂/陈旧读造成假自愈。
     * 稳态成本：每次一个 statSync + 一次 readFileSync（几 KB），无写入。
     */
    let guardStrikes = 0
    function guardCheck(trigger) {
      if (presetGuard === null || typeof presetGuard.ensureDefault !== 'function') return
      try {
        const pre = presetGuard.evaluateSettings(require('fs').readFileSync(presetGuard.DEFAULT_SETTINGS, 'utf8'))
        if (pre.action === 'ok') {
          if (guardStrikes > 0) guardStrikes = 0
          watchLog({ at: new Date().toISOString(), ev: 'preset-default-ok', trigger: trigger, current: pre.current })
          return
        }
        guardStrikes += 1
        if (guardStrikes < 2) {
          watchLog({ at: new Date().toISOString(), ev: 'preset-default-suspect', trigger: trigger,
            strike: guardStrikes, current: pre.current, why: pre.why })
          return
        }
        const r = presetGuard.ensureDefault()
        watchLog({ at: new Date().toISOString(), ev: 'preset-default-healed', trigger: trigger,
          strike: guardStrikes, action: r.action, was: pre.current, now: presetGuard.REQUIRED_DEFAULT,
          backup: r.backup, err: r.err })
        guardStrikes = 0
      } catch (e) {
        watchLog({ at: new Date().toISOString(), ev: 'preset-default-error', trigger: trigger,
          err: String((e && e.message) || e).slice(0, 300) })
      }
    }

    function refresh(trigger, turn, session, sessionCwd) {
      guardCheck(trigger)
      if (running) { watchLog({ at: new Date().toISOString(), ev: 'refresh-skip', why: 'running', trigger: trigger, turn: turn }); return }
      if (trigger === 'turn' && (Date.now() - fpAt) < MIN_GAP_MS) { watchLog({ at: new Date().toISOString(), ev: 'refresh-skip', why: 'gap', trigger: trigger, turn: turn, gapMs: Date.now() - fpAt }); return }
      running = true
      runs += 1
      const sid = session || '-'
      const t0 = Date.now()
      /**
       * ★ **参数必须过 shell 引号**（2026-09-17 重启验证实测抓出来的真 bug）。
       *
       * 病根：账本指纹长这样 —— `.warden/SPEC.md:48459:1789…|.warden/VOICE.jsonl:153305:…`
       *   里面有 **`|`**。它被直接拼进命令行 ⇒ **shell 把 `|` 当成管道**，后半截当命令跑：
       *   实测 stderr = `.warden/VOICE.jsonl:153305:… : The term … is not recognized as a cmdlet`
       *   ⇒ 每一次 turn 触发的检查都以 `run-nonjson`（exitCode 1）告终，**turn 那条线等于白跑**。
       * 为什么以前没暴露：boot 那次传的是 `'-'`（还没有指纹），所以只有 boot 能成 —— 与实测吻合。
       * 现在：所有可能含空白/引号/元字符的参数一律用 **单引号包裹**（`'` → `''`，pwsh 的转义法）。
       */
      const q = (v) => "'" + String(v).replace(/'/g, "''") + "'"
      Promise.resolve().then(function () {
        return shell.run(shell.resolve({
          command: CMD + ' ' + q(trigger) + ' ' + String(turn || 0) + ' ' + q('plugin')
            + ' ' + q('-')          // owner：常驻版认不出会话（没有卡片上报那条路）
            + ' ' + q('-')          // ownerSource
            + ' ' + String(runs)    // agentEvents/runs
            + ' ' + q('resident')   // initiatorProbe：标明这是常驻版
            + ' ' + q(sid)          // lastEvent
            + ' ' + '0'             // polls
            + ' ' + String(runs)    // events
            + ' ' + '0'
            + ' ' + q(fp !== '' ? fp : '-')
            + ' ' + String(fpAt)
            + ' ' + String(MIN_GAP_MS)
            + ' ' + String(FAIL_LIMIT)
            + ' ' + String(fails)
            + ' ' + q('resident')   // hostSlot
            + ' ' + q(sid)          // triggerSession
            + ' ' + '0'             // hostSlots
            + ' ' + q('no')         // hostSlotHit
            // ★ 2026-09-23 新增第 22 个参数：**这个会话自己的工作区**。
            //   病根：plugin-io.js 的 ROOT 原来硬编码 `<WORKSPACE>` ⇒ 用户在别的盘干活，
            //   插件读写的却是那本账（屏幕上显示另一个项目的账）。见 plugin-io.js 顶部那段注释。
            //   取 `agent.session.header.cwd`（官方 hooks-codex:146 读的就是这个字段）。
            + ' ' + q(sessionCwd || ROOT),
          workdir: ROOT,
          timeoutMs: 60000,
          stdoutMaxBytes: 2097152,
        }))
      }).then(function (res) {
        const text = String((res.stdout && res.stdout.text) || '')
        const errText = String((res.stderr && res.stderr.text) || '')
        let d = null
        try { d = JSON.parse(text) } catch (e) { }
        if (d === null) {
          fails += 1
          watchLog({ at: new Date().toISOString(), ev: 'run-nonjson', trigger: trigger, turn: turn, sid: sid,
            exitCode: res && res.exitCode, durationMs: Date.now() - t0,
            stdoutLen: text.length, stderrLen: errText.length,
            stderrHead: errText.slice(0, 400), stdoutHead: text.slice(0, 200) })
          return
        }
        if (d.fingerprint) fp = String(d.fingerprint)
        if (d.at) fpAt = d.at
        if (d.ok === true) fails = 0; else fails += 1
        watchLog({ at: new Date().toISOString(), ev: 'run-ok', trigger: trigger, turn: turn, sid: sid,
          exitCode: res && res.exitCode, durationMs: Date.now() - t0, ok: d.ok === true,
          checkExit: d.checkExit, notice: String(d.notice || '').slice(0, 160), fails: fails })
      }).catch(function (e) {
        fails += 1
        /**
         * ★ 原来这里只有 `console.error` —— 等于**没记**。现在把原样的错误写进可查的落盘文件：
         *   这一行就是判"到底是 shell.run 挂了、还是插件没被调到"的唯一证据。
         */
        watchLog({ at: new Date().toISOString(), ev: 'run-threw', trigger: trigger, turn: turn, sid: sid,
          durationMs: Date.now() - t0, fails: fails,
          errName: String((e && e.name) || ''), errCode: String((e && e.code) || ''),
          errMessage: String((e && e.message) || e).slice(0, 600) })
      }).then(function () {
        running = false
      })
    }

    /**
     * ★★ **回合边界：把欠账塞回它眼前**（2026-09-23；七席投票 回合边界 4 · 看得见 3）。
     *
     * 依据（全是角色的原话，逐字落在 ROLE_SPEECH.jsonl）：
     *   · **审查**：「派发之后立刻重查收件箱：`if (turnEnds && this.inbox.nextStep.length === 0) break;`
     *     —— 监听者只要往 next-step 塞一条消息，**回合就继续跑**。官方 `dsh-hooks-codex` 就是这么做的。」
     *   · **记录**（硬条件）：「每回合连续 steer 上限**必须落账本**（可复算），不能只放进程内存。」
     *   · **支线守门员**（硬条件）：「**不许在 R5 修好前通电**：结构性红接成 steer = 回合永远结束不了。」
     *   · **审查**：「官方那份**没防环**（`stop_hook_active: false` 写死）⇒ 防环必须自己写。」
     */
    const STEER_MAX_PER_TURN = 2
    const STEER_LOG = 'STEER.jsonl'

    /**
     * ★★ **回合边界的开关 —— 默认 `off`**（2026-09-23 事故 I60 之后改的）。
     *
     * 事故（用户原话：「（用户原话已隐去 —— 公开版不留逐字）」）：
     *   我第一版把它默认打开，结果用户的新窗口（session-532b909a）问了个**数学笑话**，
     *   回答完之后**单回合跑了 43 次工具调用 / 26 步 / 约 20 分钟**，
     *   最后**用户不得不手动停掉它**。日志实证：`{"ev":"steer","kind":"check-red",...}`。
     *   根因：那条 steer 说的是「check 是红的，先处理掉再收尾」，而那个红是**结构性的**
     *   （工作区账本一条需求都没有）⇒ 它修不掉 ⇒ 一直试。
     *
     * 这正是七席投票里 **支线守门员** 的硬条件原话：
     *   「**回合边界不许在 R5 修好前通电**：结构性红接成 steer = 回合永远结束不了。」
     *   —— 我**没有听**，直接通电了。现在按它说的改回来。
     *
     * 现在的默认行为：
     *   · **默认 `off`：一个字都不 steer**（不打扰任何窗口）；
     *   · 想开：在 `<ROOT>/.warden/steer.json` 里写 `{"mode":"on"}`；
     *   · 即便开了，也只有两种**无害**情形会说话，且**每会话各一次**：
     *       `no-ledger`（结构性缺账本）/ `no-role-speech`（check 已绿但零角色发言）；
     *   · **`check-red` 永远不 steer** —— 那是"活没干完"，模型可能一轮补不完，接了就是死循环。
     */
    function steerMode() {
      try {
        const fsx = require('fs'); const pathx = require('path')
        const p = pathx.join(ROOT, '.warden', 'steer.json')
        if (!fsx.existsSync(p)) return 'off'          // ← 默认关（事故后改的）
        const o = JSON.parse(fsx.readFileSync(p, 'utf8'))
        return String((o && o.mode) || 'off').toLowerCase() === 'on' ? 'on' : 'off'
      } catch (e) { return 'off' }
    }

    /** 找 `createUserMessage`：从 DSH 自己的安装里解析（不许硬编码作者机器路径） */
    function resolveCreateUserMessage() {
      const tries = []
      try { tries.push(require('@deepseek-ai/dsh-llm')) } catch (e) { /* 下一条 */ }
      try {
        const { createRequire } = require('module')
        const entry = process.argv[1]
        if (entry) tries.push(createRequire(entry)('@deepseek-ai/dsh-llm'))
      } catch (e) { /* 下一条 */ }
      try {
        const pathx = require('path')
        const entry = process.argv[1] || ''
        const root = entry ? pathx.dirname(pathx.dirname(entry)) : ''
        if (root) tries.push(require(pathx.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')))
      } catch (e) { /* 下一条 */ }
      for (const m of tries) if (m && typeof m.createUserMessage === 'function') return m.createUserMessage
      return null
    }
    const createUserMessage = resolveCreateUserMessage()

    /**
     * 读刚落盘的快照（插件自己写的那份），用来判断"这一轮该不该说话"。
     *
     * ⚠⚠ **2026-09-23 修一个"读写路径不一致"的真 bug（I60 的第二半）**：
     *   用户把插件注入给他的那段话贴了回来，里面写着「需求监督未通过：**14 条**」——
     *   而 **14 条是 `<WORKSPACE>` 那本旧账的数字**，不是那个会话自己工作区的数字。
     *   根因：**写**快照时 plugin-io 用的是 `argv[22]`（会话工作区，我这次刚修好的），
     *   而**读**快照时这里按 `DEBUG_CANDIDATES` 顺序找，**第一个是 `process.cwd()` = `<WORKSPACE>`**
     *   ⇒ 读到的永远是那本旧账 ⇒ steer 拿旧账的数字去说这个会话。
     *   修法：**读必须跟着写走** —— 先把"这个会话自己的工作区"排在候选第一位。
     */
    function readLiveSnapshot(sessionCwd) {
      try {
        const fsx = require('fs'); const pathx = require('path')
        const cands = []
        if (sessionCwd) cands.push(sessionCwd)
        for (const d of DEBUG_CANDIDATES) if (cands.indexOf(d) < 0) cands.push(d)
        for (const d of cands) {
          const p = pathx.join(d, 'PLUGIN-LIVE.json')
          if (!fsx.existsSync(p)) continue
          return JSON.parse(fsx.readFileSync(p, 'utf8'))
        }
      } catch (e) { /* 读不到就当没有 */ }
      return null
    }

    /**
     * 判据：这一轮要不要 steer、说什么。`{should:false}` 是正常路径（没欠账就一个字不说）。
     *
     * ⚠⚠ **2026-09-23 实测事故后收紧（I60）** —— 第一版**把新窗口卡死了**：
     *   现场：新窗口（session-532b909a）问了个数学笑话，回答完**还在跑**；
     *   日志实证：`{"ev":"steer","kind":"check-red","turn":1,"used":0,"viaHelper":true}`，
     *   而那个会话跑到 **turn=1 / step=23** 仍没停。
     *   根因两条（都是我第一版写错的）：
     *     ① 我用 `snap.line`（**标题行**，内容是「需求监督未通过：1 条」）去判"结构性缺 SPEC" ——
     *        而那句话在 `snap.detail` 里 ⇒ **结构性那条永远匹配不上** ⇒ 掉进 check-red 分支，
     *        塞给它「check 是红的，先处理掉再收尾」；
     *     ② 而那个红**本来就是结构性的**（工作区账本一条需求都没有），**干活再多也不会变绿**
     *        ⇒ 它只能一直试 ⇒ **回合永远结束不了**。
     *   ⇒ 这正是七席投票里 **支线守门员** 的硬条件原话：
     *     「**回合边界不许在 R5 修好前通电**：结构性红接成 steer = 回合永远结束不了。」
     *   现在三条自我约束（收紧到"宁可少说"）：
     *     ① 只在**结构性缺账本**时说话，且**每个会话只说一次**（`once:'session'`）；
     *     ② **普通 check 红一律不 steer** —— 那是"活没干完"，不是"配置缺"，模型可能一轮补不完；
     *     ③ 零角色发言只在 **check 已经绿**（说明活干完了）时提醒一次。
     */
    function steerDecision(snap) {
      if (!snap || typeof snap !== 'object') return { should: false, why: 'no-snapshot' }
      const speech = Number(snap.speechCount || 0)
      /**
       * ★★ **2026-09-24 修 A1：判据改成读结构化事实，不读中文文案。**
       *
       * 「审查」的原话（它把这条列为"还活着、建议优先"）：
       *   「『修好』的那版，结构性判据**仍然匹配不上真实文本** —— 现在的安全是碰巧的，不是判据对了。
       *    当前判的是 `/缺 \.warden\/SPEC\.md/`，而 **SPEC 存在但空**时（自动建骨架之后的常态），
       *    真实 `detail` 是 `[需求] SPEC.md 里一条需求都没有`，**不含那句子串**
       *    ⇒ `no-ledger` 分支**永远不会响**；它现在不闯祸只是靠 `checkExit===1 → 不说话` 兜住
       *    （**fail-closed 是运气，不是判据**）。」
       *
       * ⇒ 现在读 `reqCount`（`plugin-io.js` 算出来放进快照的**事实**：SPEC 里 `## R#` 的条数）。
       *   `reqCount === 0` **就是**"没有账本"的定义，与任何一句话怎么写都无关 ——
       *   文案再改（我自己那次 R5 修复就改过）也不会让判据失效。
       *   ⚠ `reqCount` 缺失（老快照/读不到）时**不许当成 0** —— 那会误报；宁可不说。
       */
      const reqCount = snap.reqCount
      const hasStructuredFact = reqCount !== null && reqCount !== undefined
      if (hasStructuredFact && Number(reqCount) === 0) {
        return { should: true, kind: 'no-ledger', once: 'session',
          text: '[九月项目团] 这个窗口还没有账本：`.warden/SPEC.md` 里一条需求都没有。'
            + '先把用户这次说的原话**逐字**写进 `.warden/SPEC.md` 成 `## R1 · <标题>`（含 `- 原话:` / `- 必须:` / `- 不要:` / `- 子项:`），'
            + '再跑 `node <HOME>/.dsh/skills/task-warden/warden.mjs claims add --voice "<会话id>#<seq>" --kind 需求 --ref R1 --why "…"`。'
            + '没有需求被锁住，后面的对账/角色仪表/交付闸全是空的。'
            + '（这条只提醒一次，**不要为了它反复重试**：它是配置缺口，不是靠多干活能变绿的。）' }
      }
      // ② 普通 check 红 **不 steer**（第一版在这里把回合卡死过 —— 见上面那段事故注释）
      if (Number(snap.checkExit) === 1) return { should: false, why: 'check-red-not-actionable' }
      // ③ 零角色发言：只在 check 已绿（活干完了）时提醒一次
      if (speech === 0) {
        return { should: true, kind: 'no-role-speech', once: 'session',
          text: '[九月项目团] 本轮账本里**一条角色发言都没有**（`ROLE_SPEECH.jsonl` 没新增）。'
            + '角色不是"主代理想起了才派"：现在派 **资料员**（要事实/出处）与 **方向员**（要大局观/维度清单）各出一次，'
            + '用 `node <HOME>/.dsh/skills/task-warden/warden.mjs role say --role <角色> --text "<它的原话>"` 逐字落账。'
            + '（这条只提醒一次。）' }
      }
      return { should: false, why: 'nothing-to-say' }
    }

    /**
     * 防环：**上限落账本**（记录的条件：不能只放进程内存）。
     * ⚠ 2026-09-23 收紧：`once:'session'` 的 kind **整个会话只许一次**（原来是"每回合最多 2 次"，
     *   而"每回合 2 次"对一个修不好的红来说 = 每回合都续一次 = **永远不结束**）。
     */
    function steerAllowed(turn, sid, kind, once) {
      try {
        const fsx = require('fs'); const pathx = require('path')
        const p = pathx.join(ROOT, '.warden', STEER_LOG)
        let nTurn = 0; let nSessionKind = 0
        if (fsx.existsSync(p)) {
          for (const l of fsx.readFileSync(p, 'utf8').split(/\r?\n/)) {
            const s = l.trim(); if (!s.startsWith('{')) continue
            try {
              const o = JSON.parse(s)
              if (o.suppressed) continue
              if (Number(o.turn) === Number(turn) && String(o.sid || '') === String(sid || '')) nTurn += 1
              if (String(o.kind) === String(kind) && String(o.sid || '') === String(sid || '')) nSessionKind += 1
            } catch (e) { /* 坏行 */ }
          }
        }
        if (once === 'session' && nSessionKind >= 1) return { allowed: false, used: nSessionKind, path: p, why: 'once-per-session' }
        return { allowed: nTurn < STEER_MAX_PER_TURN, used: nTurn, path: p, why: 'per-turn-cap' }
      } catch (e) { return { allowed: false, used: -1, path: '', why: 'read-failed' } }
    }
    function steerRecord(turn, sid, kind, suppressed, p, why) {
      try {
        require('fs').appendFileSync(p, JSON.stringify({
          at: new Date().toISOString(), turn: Number(turn) || 0, sid: String(sid || ''), kind: kind,
          suppressed: !!suppressed, why: why || '', pid: process.pid, max: STEER_MAX_PER_TURN,
        }) + '\n', 'utf8')
      } catch (e) { /* 记账坏了不许影响回合 */ }
    }

    ctx.on('agent/turn-stopping', function (payload) {
      let sid = '-'
      let turn = 0
      let agent = null
      try {
        // ⚠ **2026-09-23 修字段名**（支线守门员复核出来的）：`agent` 一直都在 payload 里
        //   （`dsh-agent\lib\index.js:210` 的 `fused(payload) = {...payload, agent}`），
        //   而原来读的 `agent.sessionId` **不存在** ⇒ sid 永远是 '-'（实测 188/188 行全是 '-'）。
        //   官方 `dsh-hooks-codex:305` 读的是 `agent?.session.header.id`。
        agent = (payload && payload.agent) || null
        if (agent && agent.session && agent.session.header && typeof agent.session.header.id === 'string') sid = agent.session.header.id
        turn = Number(payload && payload.turn) || 0
      } catch (e) { /* 读不到就退化成 '-' */ }
      try {
        const fsx = require('fs')
        const pathx = require('path')
        const line = JSON.stringify({ at: new Date().toISOString(), ev: 'turn-stopping', sid: sid, turn: turn, pid: process.pid }) + '\n'
        // ⚠ 路径表**与 watchLog 用同一份**（原来这里另写一张，两条线落在两个文件里、
        //   "事件到了之后到底跑没跑"分不开 —— 资料员 2026-09-23 复核出来的）。
        for (const d of DEBUG_CANDIDATES) {
          try { fsx.mkdirSync(d, { recursive: true }); fsx.appendFileSync(pathx.join(d, 'warden-watch-debug.jsonl'), line, 'utf8'); break } catch (e) { /* 换下一个 */ }
        }
      } catch (e) { /* 探针自己坏了绝不许影响轮次 */ }
      const sessionCwdNow = (agent && agent.session && agent.session.header && agent.session.header.cwd) || ''
      refresh('turn', turn, sid, sessionCwdNow)

      // ── 回合边界：把欠账塞回它眼前（**默认关**；事故 I60 之后改的，见 steerMode 的注释）
      try {
        const mode = steerMode()
        if (mode !== 'on') return                     // ← 默认一个字都不说
        if (!agent || typeof agent.steer !== 'function') {
          watchLog({ at: new Date().toISOString(), ev: 'steer-skip', why: 'no-agent-or-steer', turn: turn, pid: process.pid })
          return
        }
        const dd = steerDecision(readLiveSnapshot(sessionCwdNow))
        if (!dd.should) return
        const g = steerAllowed(turn, sid, dd.kind, dd.once)
        if (!g.allowed) {
          steerRecord(turn, sid, dd.kind, true, g.path, g.why)
          watchLog({ at: new Date().toISOString(), ev: 'steer-suppressed', kind: dd.kind, turn: turn, used: g.used, max: STEER_MAX_PER_TURN, pid: process.pid })
          return
        }
        const msg = createUserMessage
          ? createUserMessage({ content: [{ type: 'text', text: dd.text }], source: { kind: 'plugin', plugin: 'task-warden' } })
          : { role: 'user', content: [{ type: 'text', text: dd.text }], source: { kind: 'plugin', plugin: 'task-warden' } }
        agent.steer(msg)
        steerRecord(turn, sid, dd.kind, false, g.path, g.why)
        watchLog({ at: new Date().toISOString(), ev: 'steer', kind: dd.kind, turn: turn, used: g.used, viaHelper: !!createUserMessage, pid: process.pid })
      } catch (e) {
        try { watchLog({ at: new Date().toISOString(), ev: 'steer-threw', err: String((e && e.message) || e).slice(0, 200), turn: turn, pid: process.pid }) } catch (e2) { /* 连日志都没了 */ }
      }
    })

    // ------------------------------------------------------------------ R36 闸
    // 事件是**进程级**的（Scoped<Agent> 只对 agent-scoped listener 生效），所以判据**只能看
    // 这次调用本身**（工具名 + 参数里的路径 + 该路径所属工程磁盘上的 .warden）——
    // 不依赖任何跨会话的内存状态：用户明确要求窗口间不能互相实时影响造成干扰。
    // 非 edit/write 的调用在 gate 里**零 IO** 直接放行；绝不在这里 spawn 子进程。
    /**
     * ★ 装载探针（2026-09-17 加）：证明「这个常驻插件**确实被加载了**、而且工具前置闸挂上了」。
     *   为什么需要它：`turn-stopping` 那条线的失败**只写 stderr**，而 stderr 没人看 ——
     *   于是一个"根本没被加载"的插件和一个"加载了但跑不动"的插件在日志上毫无区别。
     *   成本控制：**每个进程只写前 3 次**工具调用（之后不再落盘，避免每次工具调用都产生 IO）。
     */
    let toolCallsSeen = 0
    ctx.on('tools/pre-execute', function (exec, next) {
      try {
        if (toolCallsSeen < 3) {
          toolCallsSeen += 1
          watchLog({ at: new Date().toISOString(), ev: 'plugin-live', source: 'tools/pre-execute',
            seq: toolCallsSeen, tool: String((exec && exec.name) || ''), pid: process.pid })
        }
      } catch (e) { /* 探针自己坏了绝不许影响工具调用 */ }
      let d = null
      try {
        if (gate && typeof gate.preToolDecision === 'function') {
          d = gate.preToolDecision({
            toolName: exec && exec.name,
            toolArgs: exec && exec.arguments,
            // ⚠ 2026-09-17 补：**把工具自己的 cwd 也传下去**。
            //   原来只传 `cwds`（会话工作区列表）—— 而 shell 命令完全可能跑在**别处**
            //   （`cd D:\其他工程; Set-Content …`），那样被盯的档位文件就找不到了。
            //   `exec.cwd` 不存在时是 undefined，judgeShell 会退回 cwds/process.cwd()（不改变原行为）。
            // ★ 2026-09-24 修 E2（「资料员」+「审查」各查一遍）：**`exec.cwd` 根本不存在** ——
            //   `dsh-tools` 全文 0 处 `cwd`，`ToolExecutionInput` 声明里也没有 ⇒ 这一行永远是 undefined，
            //   `cwd` 分支是**死代码**。
            //   现在改读**同一份数据的真字段**：`exec.agent.session.header.cwd`
            //   （`agent` 由 `dsh-agent:210` 的 `fused(payload) = {...payload, agent}` 注入；
            //    官方 `dsh-hooks-codex:146` 读的就是 `agent?.session.header.cwd`）。
            cwd: (exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) || undefined,
            cwds: CWDS,          // 相对路径按会话工作区（可能不是 ROOT）解析
          })
        }
      } catch (e) {
        d = null // 看守自己坏了 → 放行（绝不能让一次工具调用因为看守坏了而失败）
      }
      if (d && d.kind === 'deny' && typeof d.reason === 'string' && d.reason) {
        return Promise.resolve({ kind: 'deny', reason: d.reason })
      }
      return next()
    })

    // 装载时先跑一次，让快照/审计不至于等到下一次轮次边界
    refresh('boot', 0, '-')
  },
}
