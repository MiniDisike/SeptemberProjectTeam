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
 * ★ 「自动启用」守卫（用户 2026-09-17 逐字：「以后**绝对不能**改自动启用的这一项！」）
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

    function refresh(trigger, turn, session) {
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
            + ' ' + q('no'),        // hostSlotHit
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

    ctx.on('agent/turn-stopping', function (payload) {
      let sid = '-'
      let turn = 0
      try {
        const a = payload && payload.agent
        if (a && typeof a.sessionId === 'string') sid = a.sessionId
        turn = Number(payload && payload.turn) || 0
      } catch (e) { }
      /**
       * ⚠ **2026-09-17 加的探针 —— 它是一次"测量"，不是修复。**
       *
       * 实测（插件自己的调用日志，53 条）：`by=plugin` 的 22 条**全部是 `trigger=boot`**，
       * `trigger=turn` **一次都没有**；最后一次插件自己跑是 21:32（之后只有我手工跑的）。
       * 而事件名是对的 —— `agent/turn-stopping` 在 `dsh-agent-loop` 里真的分发
       * （`dsh-hooks-codex` / `dsh-hooks-claude-code` 两个出厂包都用 `ctx.on("agent/turn-stopping", …)`）。
       * ⇒ 有两种可能，靠日志分不开：
       *   ① 这个事件**根本没送到**本插件（本插件挂在 profile 层的 composition 上，
       *      而那两个出厂包是挂在**每个 agent 的作用域**里的 —— 作用域差别可能就是原因）；
       *   ② 事件送到了，但 `shell.run` 在轮次结束时失败（失败只 `console.error`，**不写 CALLS**，
       *      所以日志上看起来"什么都没发生"）。
       * 这个探针写在 `shell.run` **之前**：只要事件到了，就先落一行 DEBUG。
       * 下次启动后看 `warden-watch-debug.jsonl`：
       *   - 有 `turn-stopping` 行、却仍没有 `plugin-io` 的 `trigger=turn` ⇒ 是 ②（shell 那一层）；
       *   - 连 `turn-stopping` 行都没有 ⇒ 是 ①（作用域 / 挂载位置），要把本插件挂进 agent 作用域
       *     （见 `%DSH_HOME%\.agent-presets\roles\agent.cordis.yml`）。
       */
      try {
        const fsx = require('fs')
        const osx = require('os')
        const pathx = require('path')
        const line = JSON.stringify({ at: new Date().toISOString(), ev: 'turn-stopping', sid: sid, turn: turn }) + '\n'
        const cands = [
          require('path').join(require('os').homedir(), 'DSH-Workspace', 'task-warden'),
          osx.tmpdir(),
        ]
        for (const d of cands) {
          try { fsx.mkdirSync(d, { recursive: true }); fsx.appendFileSync(pathx.join(d, 'warden-watch-debug.jsonl'), line, 'utf8'); break } catch (e) { /* 换下一个 */ }
        }
      } catch (e) { /* 探针自己坏了绝不许影响轮次 */ }
      refresh('turn', turn, sid)
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
            cwd: (exec && exec.cwd) || undefined,
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
