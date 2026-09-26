/**
 * R36 —— 工具执行前的闸：「**要改一件已经确认完成的东西，却没先备份**」。
 *
 * 用户原话（2026-09-16）：「（用户原话已隐去 —— 公开版不留逐字）」。
 * 原来只能在 `record` / `check` 时拦（`warden.mjs` 的 `reopenGate`）—— 那时候文件**已经被改了**。
 * 本文件是 `reopenGate` 的**执行前版本**：判据一样，只是提前到工具真正跑之前。
 *
 * 判据（机械可判，**只此一种**，不许猜语义）—— 六条全中才 deny：
 *   ① 工具名 ∈ {edit, write}，且参数里 `file_path` 是非空字符串；
 *   ② 目标文件**当前存在**（不存在的文件 takeSnapshot 根本拷不到 → 为它 deny 是解不开的死结）；
 *   ③ 从目标文件所在目录往上找**最近的 `.git` 那一层**，且那一层必须有 `.warden/`；
 *   ④ 目标文件被该工程 `.warden/params.yml` 的 `watches[].file` **点名**（Windows 大小写/斜杠不敏感）；
 *   ⑤ 该工程 `.warden/ROUNDS.jsonl` 里**整个账本最新一轮**的 status 是 `done`；
 *   ⑥ `.warden/snapshots/<目录>/manifest.json` 里**没有** `at` 晚于那条 done 时间的快照。
 *   命中 ⇒ `deny`，reason 直接给出该跑的命令（照 `reopenGate` 的措辞）。
 *
 * **fail-open 是硬约束**：内部任何异常 / 读不到文件 / 解析失败，一律 allow ——
 * 绝不能让一次工具调用因为"看守坏了"而失败。所以对外只用 `preToolDecision`（带 try/catch）。
 *
 * **不做跨会话状态**：本闸是进程级事件（`tools/pre-execute`，`Scoped<Agent>` 只对 agent-scoped
 * listener 生效），判据**只能看这次调用本身**（工具名 + 参数里的路径 + 该路径所属工程磁盘上的
 * `.warden`）。不依赖任何内存里攒的全局状态 —— 用户明确要求窗口间不能互相实时影响造成干扰。
 *
 * **开销**：非 edit/write 的工具调用**零 IO** 直接放行；edit/write 才做几次 existsSync + 读一个
 * 小文件（params.yml）与 ROUNDS/snapshots 的轻量解析。**绝不 spawn 子进程**跑 warden.mjs。
 *
 * 依赖注入：`{ fs, path }`（默认 node:fs / node:path），这样自检可以不碰 DSH 直接喂假数据。
 */

import nodeFs from 'node:fs'
import nodePath from 'node:path'
import nodeOs from 'node:os'

/** 只对这两个写文件的工具生效（本机工具名） */
export const GATE_TOOLS = ['edit', 'write']

/**
 * ★★ **交付动作也要过闸**（2026-09-17 用户点名要的：让 present 交付动作本身过闸）。
 *
 * 为什么必须这样：`check` 是**自愿跑的** —— 隔壁那次真实工作**跑了** check（所以今天的判据能拦它），
 *   但一个**根本不跑 check** 的窗口，照样能把违背「不要」的东西交出去。
 *   ⇒ 把判据挂到**交付那一刻**：`present` 是"我把它交给你"的动作，拦住它 = 拦住交付。
 *
 * 判据（**只读账本文件，绝不 spawn 子进程** —— 与本闸的硬约束一致）：
 *   ① **每条「不要」都必须被交代过**：某需求最新一轮 `done`，而它的「不要」项没有全部出现在
 *      那一轮的 `avoided` 里 ⇒ 拒交；
 *   ② **报了 done 就必须有一次收尾对账**（R14）：存在 `done` 轮且轮号 > 最后一条
 *      `kind=results` 的 `lastRound` ⇒ 拒交。
 *
 * ⚠ 三条如实说明：
 *   · 它判的是"**有没有显式回应**"与"**有没有对账**"，**不是**"交付物到底违没违规"（后者机器判不了）；
 *   · 取工程根用**被交付文件的路径**（不是 cwd）—— 交付物在哪个工程就查哪本账；
 *   · 判据坏了仍然 **fail-open**（绝不让一次工具调用因为看守自己坏了而失败）。
 */
export const PRESENT_TOOLS = ['present']

/**
 * 最小 SPEC 解析：只要「## R#」块里的 `- 不要:`。
 * ⚠ **切分口径必须与 `warden.mjs` 的 `splitList` 一模一样**：`/[；;、,，|]/`。
 *   我第一版只切了 `[；;|]`，漏了**顿号与逗号** ⇒ 闸把 R2 的两条当成一条
 *   （`把没投票、没实验的规则当既定法律`），于是它认不出我已经交代过、**误拦**。
 *   自检⑯/⑰ 只覆盖了单条的夹具，没覆盖"一条里带顿号" —— 这是夹具没铺到的缝。
 */
export function parseMustNot(text) {
  const out = new Map()
  let cur = null
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^##\s+(R\d+)\b/.exec(line)
    if (m) { cur = m[1]; if (!out.has(cur)) out.set(cur, []); continue }
    if (!cur) continue
    if (/^-\s*不要\s*[:：]/.test(line)) {
      const body = line.replace(/^-\s*不要\s*[:：]\s*/, '')
      for (const part of body.split(/[；;、,，|]/)) { const t = part.trim(); if (t) out.get(cur).push(t) }
    }
  }
  return out
}

/** 读 JSONL（坏行跳过；**读不动返回 null**，与"空文件"区分开） */
function readJsonlFile(fs, p) {
  try {
    const out = []
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const s = line.trim()
      if (!s.startsWith('{')) continue
      try { out.push(JSON.parse(s)) } catch (e) { /* 坏行 */ }
    }
    return out
  } catch (e) { return null }
}

/** 交付闸的判据：**只读账本**。返回 `{kind:'deny', reason}` 或 `null`（放行）。导出以便自检直接喂夹具。 */
export function judgeLedger(root, deps) {
  const { fs, path } = io0(deps)
  const wdir = path.join(root, '.warden')
  const specPath = path.join(wdir, 'SPEC.md')
  /**
   * ★★ **没有账本 ⇒ 不许交付**（2026-09-23 新增；用户的产品级要求）。
   *
   * 用户原话：「（用户原话已隐去 —— 公开版不留逐字）」
   *
   * 这条洞就是"一装就失灵"的根：
   *   下面所有判据都从 `SPEC.md` / `ROUNDS.jsonl` 读 —— **账本不存在时，`return null` = 放行**。
   *   于是新窗口（工作区里没有 `.warden`）可以**随便交**，用户看到的只有"表面糊弄"。
   *
   * 现在：**能判出工程根、而那本账里没有需求 ⇒ 拒交**，并给出**一条命令就能做**的补法。
   *   ⚠ 只认"**有 `## R#` 需求**"才算账本成立 —— 空骨架不算（否则自动建骨架就等于自动放行）。
   *   ⚠ 判据坏了仍然 fail-open（见 preToolDecision 的 try/catch）。
   */
  const hasSpec = fs.existsSync(specPath)
  let specText = ''
  if (hasSpec) { try { specText = fs.readFileSync(specPath, 'utf8') } catch (e) { specText = '' } }
  const reqCount = (specText.match(/^##\s+R\d+\b/gm) || []).length
  if (reqCount === 0) {
    const wardenCmd = wardenCmdFor()
    return {
      kind: 'deny',
      reason: '[task-warden 交付闸] 先别交：**这个工程还没有账本**'
        + (hasSpec ? '（`.warden/SPEC.md` 在，但里面一条 `## R#` 需求都没有）' : '（连 `.warden/SPEC.md` 都没有）')
        + '。\n'
        + '  为什么拦：没有需求被锁住，"你要的 vs 我给的"就**无从对账** —— 交付闸、角色仪表、欠账表全都读不到东西，\n'
        + '    用户看到的就是"表面糊弄完就说做完了"（这正是他报的那次）。\n'
        + `  两条命令就补上（在 ${root} 里跑）：\n`
        + `    1) ${wardenCmd} init\n`
        + '    2) 把用户这次说的**原话逐字**写进 `.warden/SPEC.md` 成 `## R1 · <标题>`（含 `- 原话:` / `- 必须:` / `- 不要:` / `- 子项:`）\n'
        + `    3) ${wardenCmd} claims add --voice "<会话id>#<seq>" --kind 需求 --ref R1 --why "…"\n`
        + '  （这不是"多一道手续"：不锁需求，后面每一条判据都是空的 —— 这就是"装上了却一用就失灵"的根。）',
    }
  }
  let mustNot = new Map()
  try { mustNot = parseMustNot(specText) } catch (e) { return null }
  const rounds = readJsonlFile(fs, path.join(wdir, 'ROUNDS.jsonl'))
  if (!rounds || !rounds.length) return null

  const lastByReq = new Map()
  for (const r of rounds) {
    const id = String(r.requirement ?? ''); if (!id) continue
    const cur = lastByReq.get(id)
    if (!cur || Number(r.round ?? 0) >= Number(cur.round ?? 0)) lastByReq.set(id, r)
  }

  // ① 每条「不要」都要被交代过
  const miss = []
  for (const [id, row] of lastByReq) {
    if (String(row.status) !== 'done') continue
    const items = (mustNot.get(id) ?? []).filter((x) => String(x).trim())
    if (!items.length) continue
    const av = Array.isArray(row.avoided) ? row.avoided.map((x) => String(x).trim()) : []
    for (const it of items) {
      if (!av.some((a) => a === it || a.startsWith(it + '='))) miss.push({ id, round: row.round, item: it })
    }
  }
  if (miss.length) {
    const head = miss.slice(0, 6).map((m) => `\n     · [${m.id}] ${String(m.item).slice(0, 60)}`).join('')
    return {
      kind: 'deny',
      reason: `[task-warden 交付闸] 先别交：有 ${miss.length} 条「不要」**从没被交代过** ——`
        + ` 用户逐字说过这些是他不要的，而你标了 done 却没说清怎么避开的。${head}`
        + (miss.length > 6 ? `\n     …（还有 ${miss.length - 6} 条）` : '')
        + `\n  补法：node warden.mjs record --req <R#> --status done --avoided "不要项=怎么避开的" …`
        + `\n  （来历：隔壁窗口把你的「我不要被锁定成平面」锁进了 SPEC、也跑了 check，然后交付了锁平面的东西 ——`
        + ` 旧判据拿整句自然语言去 includes 交付散文，永远不可能响。现在：**没交代过的「不要」不许交付**。）`,
    }
  }

  // ② 报了 done 就必须有一次收尾对账（R14）
  const recon = readJsonlFile(fs, path.join(wdir, 'RECON.jsonl'))
  let lastResults = -1
  for (const o of (recon ?? [])) {
    if (o && o.kind === 'results') lastResults = Math.max(lastResults, Number(o.lastRound ?? 0))
  }
  const doneAfter = [...lastByReq.values()].filter((r) => String(r.status) === 'done' && Number(r.round ?? 0) > lastResults)
  if (doneAfter.length) {
    const ids = [...new Set(doneAfter.map((r) => String(r.requirement ?? '')))].slice(0, 6).join('、')
    return {
      kind: 'deny',
      reason: `[task-warden 交付闸] 先别交：有 ${doneAfter.length} 轮报了 **done**（涉及 ${ids}），`
        + '但**那之后没有任何一次收尾对账** —— 用户要求：结束时给结果清单并对账，从来没有实现过。'
        + '\n  补法：node warden.mjs results（打出结果清单 + 对账行，并记进 RECON.jsonl）',
    }
  }
  return null
}

/** `present` 的判定：用**被交付文件的路径**定位工程根（不是 cwd） */
function judgePresent(input, deps) {
  const { fs, path } = io0(deps)
  const args = (input && input.toolArgs) || {}
  const files = Array.isArray(args.files) ? args.files : []
  const roots = []
  const seen = new Set()
  const bases = []
  if (Array.isArray(input.cwds)) for (const b of input.cwds) if (b) bases.push(b)
  if (input.cwd) bases.push(input.cwd)
  if (!bases.length) bases.push(process.cwd())
  for (const f of files) {
    const p = f && typeof f.path === 'string' ? f.path : ''
    if (!p) continue
    const candidates = path.isAbsolute(p) ? [path.dirname(p)] : bases.map((b) => path.resolve(b, path.dirname(p)))
    for (const c of candidates) {
      let root = null
      try { root = findProjectRoot(c, deps) } catch (e) { root = null }
      if (!root) continue
      const k = pathKey(root)
      if (seen.has(k)) continue
      seen.add(k); roots.push(root)
    }
  }
  for (const root of roots) {
    const v = judgeLedger(root, deps)
    if (v && v.kind === 'deny') return v
  }
  return allow()
}

/**
 * ★ **shell 类工具**（2026-09-17 新增；补 R12 的保留项）。
 *
 * 审查第二遍点名的洞：「`gate.mjs:269` 自述非 edit/write **零 IO 直接放行** ⇒ **`pwsh` 一条命令绕过整道闸**。」
 *   ⇒ 现在对 shell 类工具也看一眼：**命令文本里提到被盯的档位文件、并且带写动作**时，
 *     走与 edit/write **同一套**判定（`judgeOne`）。
 *
 * ⚠ 三条如实说明（不许把它说成"防住了 shell"）：
 *   ① 它是**启发式**：写动作靠关键词/重定向识别，绕过方法显然存在（换一种写法、拼路径、用别名）；
 *   ② **只认被盯的档位文件** —— 没被 params.yml 点名的文件它一概不管（那不是这道闸的职责）；
 *   ③ **只读命令放行**：`Get-Content` 同一个文件不会被拦（读不会改坏数据）。
 */
export const SHELL_TOOLS = ['pwsh', 'bash', 'sh', 'shell', 'run', 'exec', 'cmd']

/** 写动作的关键词/重定向（启发式；只用于"要不要多看一眼"，不用于判定本身） */
const WRITE_HINTS = /(>>|>|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Clear-Content|tee\b|sed\s+-i|truncate|dd\s|chmod\s|echo\s.*>)/i
/** 这两个工具参数里的目标路径字段 */
export const PATH_FIELD = 'file_path'

const DEFAULT_WARDEN_CMD = 'node warden.mjs snapshot --label'
// ⚠ 公开版：运行时推导
const WARDEN_MJS_DIR = nodePath.join(nodeOs.homedir(), '.dsh', 'skills', 'task-warden') + nodePath.sep

/**
 * ★★ **warden.mjs 的位置：运行期派生，不许写死作者机路径**（公开包硬要求）。
 *
 * 病根（2026-09-23 修）：`judgeLedger` 的"没有账本 ⇒ 拒交"分支原来把命令写死成一串
 *   **作者机的绝对路径**（`node <作者机绝对路径>/skills/task-warden/warden.mjs`）。
 *   ⇒ 别的用户装上之后，屏幕上会指着**别人的机器**让他去跑 ——
 *     既暴露了作者路径，在**他的机器上根本跑不通**（那个路径不存在，必然 ENOENT）。
 *
 * 三级解析（与 `plugin-io.js` 的 `resolveWardenMjs` **同款口径**，避免两套写法各说各话：
 *   字段优先级、`path.join` 的三段、`existsSync` 逐个探，**都照抄那一份**）：
 *   ① `TASK_WARDEN_MJS` 环境变量 —— 显式指定，最高优先（测试 / 非标准安装位置）
 *   ② `<DSH_HOME>/skills/task-warden/warden.mjs` —— `DSH_HOME` 是 DSH 自己注入的环境变量，
 *      **换用户就自动跟着变**
 *   ③ `<os.homedir()>/.dsh/skills/task-warden/warden.mjs` —— 退到 DSH 的默认家目录
 *      （`DSH_HOME` 没设时 DSH 本身就是用这个默认值）
 *
 * ⚠ **故意不做的事**：**不写"找不到就退回作者机路径"**。
 *   查不到就返回**占位形态**（`node "<你的 DSH_HOME>/skills/task-warden/warden.mjs"`）——
 *   让用户看明白"这是要你自己填的"，而不是给他一条**在他机器上必然失败**的命令。
 *   这也与本文件 `fail-open` 的硬约束一致：这里的降级**只影响文案**，
 *   `judgeLedger` 仍然照旧返回 deny（判据一个字没动）。
 *
 * 为什么在本文件内自己实现、不 `import` `plugin-io.js`：
 *   `plugin-io.js` 是 **CommonJS**（`require`，无 `export`），而本文件是 **ESM**（`import`）——
 *   跨模块引它只能走 `createRequire`，而 `gate.mjs` 是**每个 edit/write 工具调用都要过**的热路径，
 *   且它自己写明"**绝不 spawn 子进程**"（引一个会 `execFileSync` 的模块更是反向操作）。
 *   ⇒ 在本文件内实现同款逻辑，并在上面写明"与 plugin-io.js 的 resolveWardenMjs 同款"。
 */
export function resolveWardenMjs() {
  const candidates = []
  if (process.env.TASK_WARDEN_MJS) candidates.push(String(process.env.TASK_WARDEN_MJS))
  const dshHome = process.env.DSH_HOME
  if (dshHome) candidates.push(nodePath.join(dshHome, 'skills', 'task-warden', 'warden.mjs'))
  try { candidates.push(nodePath.join(nodeOs.homedir(), '.dsh', 'skills', 'task-warden', 'warden.mjs')) } catch (e) { /* 取不到家目录就算了 */ }
  for (const c of candidates) {
    try { if (nodeFs.existsSync(c)) return c } catch (e) { /* 换下一个 */ }
  }
  return null
}

/** 占位形态：推不出真路径时给用户的**可自己填**的写法（**不是**作者机路径） */
const WARDEN_MJS_PLACEHOLDER = '<你的 DSH_HOME>/skills/task-warden/warden.mjs'

/**
 * 拼"该跑的那条命令"：派生成功 ⇒ 用**他机器上的真实路径**；失败 ⇒ 占位形态 + 怎么填。
 * `null` 时**不许**退回任何一台具体机器的路径（见 `resolveWardenMjs` 的注释）。
 */
export function wardenCmdFor() {
  let mjs = null
  try { mjs = resolveWardenMjs() } catch (e) { mjs = null }
  if (mjs) return 'node ' + mjs
  return 'node "' + WARDEN_MJS_PLACEHOLDER + '"'
}

export function allow() { return { kind: 'allow' } }

/** Windows 上路径大小写/斜杠不敏感 —— 比较用的规范化键 */
export function pathKey(p) {
  const s = String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

function io0(deps) {
  const d = (deps && typeof deps === 'object') ? deps : {}
  return { fs: d.fs ?? nodeFs, path: d.path ?? nodePath }
}

/**
 * 极简 YAML 子集：只认 `watches:` 下的 `- key: value` 列表（与 `warden.mjs` 的 `parseParams` 同口径）。
 * **同口径很重要**：`parseParams` 会丢掉没有 `id`/`kind` 的行，那些行 `takeSnapshot` 也不会拷
 * —— 若本闸认了它们，就会拦下一个"给了命令也解决不了"的文件。所以这里也过滤掉。
 */
export function parseWatchedFiles(text) {
  const out = []
  let cur = null
  let inW = false
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '')
    if (/^watches\s*:/.test(line)) { inW = true; continue }
    if (!inW) continue
    if (/^\S/.test(line) && line.trim()) { inW = false; continue }
    const item = /^\s*-\s*(.*)$/.exec(line)
    if (item) {
      cur = {}
      out.push(cur)
      const kv = /^(\w+)\s*:\s*(.*)$/.exec(item[1].trim())
      if (kv) cur[kv[1]] = String(kv[2]).trim().replace(/^["']|["']$/g, '')
      continue
    }
    if (!cur) continue
    const kv = /^\s+(\w+)\s*:\s*(.*)$/.exec(line)
    if (kv) cur[kv[1]] = String(kv[2]).trim().replace(/^["']|["']$/g, '')
  }
  return out.filter((w) => w && w.id && w.kind && w.file)
}

/** 坏行跳过（和 `readRounds` 一样，不因为一行坏 JSON 就整个判据崩掉） */
export function parseJsonl(text) {
  const out = []
  for (const line of String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    try {
      const o = JSON.parse(s)
      if (o && typeof o === 'object') out.push(o)
    } catch (e) { /* 坏行跳过 */ }
  }
  return out
}

/**
 * 工程根：从 start 往上找**最近的 `.git`**；那一层**必须也有 `.warden/`**。
 * 有 `.git` 但没 `.warden`（或者一路走到盘根都没有 `.git`）⇒ 返回 null = **不拦**。
 * 为什么强调"同一层"：`.warden` 落在没有 `.git` 的容器目录上会串项目（本机实测踩过）。
 */
export function findProjectRoot(startDir, deps) {
  const { fs, path } = io0(deps)
  let d = path.resolve(String(startDir))
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) {
      return fs.existsSync(path.join(d, '.warden')) ? d : null
    }
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}

/** 账本里**最新一轮**（按 at 最大；同 at 比 round；再同则取文件里靠后的那条） */
export function latestRound(rounds) {
  let best = null
  let bestAt = -1
  let bestRound = -1
  for (const r of Array.isArray(rounds) ? rounds : []) {
    if (!r || typeof r !== 'object') continue
    const t = Date.parse(String(r.at ?? '')) || 0
    const n = Number(r.round) || 0
    if (best === null || t > bestAt || (t === bestAt && n >= bestRound)) {
      best = r; bestAt = t; bestRound = n
    }
  }
  return best === null ? null : { rec: best, at: bestAt, round: bestRound }
}

/** 所有快照里最晚的 `at`（毫秒）；没有/全坏 ⇒ -1 */
export function latestSnapshotAt(wardenDir, deps) {
  const { fs, path } = io0(deps)
  const dir = path.join(String(wardenDir), 'snapshots')
  let names = []
  try { names = fs.readdirSync(dir) } catch (e) { return -1 }
  let max = -1
  for (const n of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, n, 'manifest.json'), 'utf8'))
      const t = Date.parse(String((m && m.at) ?? '')) || 0
      if (t > max) max = t
    } catch (e) { /* 坏快照跳过 */ }
  }
  return max
}

function buildReason(o) {
  const when = new Date(o.doneAt).toISOString()
  return [
    `[task-warden R36] 先别动：\`${o.raw}\` 是这个工程 params.yml 里盯着的源文件，`,
    `而 ${o.reqId} 在账本里最新一轮是 **done**（${when}），那之后**没有任何快照**。`,
    '这正是「要改一件已经确认完成的东西，却没先备份」。',
    `先备份再动：${DEFAULT_WARDEN_CMD} "改 ${o.reqId} 之前"`,
    `（在工程根 ${o.root} 里跑；warden.mjs 在 ${WARDEN_MJS_DIR}）`,
  ].join('\n')
}

/** 对一个绝对路径判定；不命中返回 null。**可能抛**（由 preToolDecision 兜） */
function judgeOne(abs, raw, deps) {
  const { fs, path } = io0(deps)

  // ② 目标必须已存在：不存在的文件 takeSnapshot 拷不到，deny 就成了死结
  //    （而且新建一个文件没有"已确认完成的数据"可丢）
  if (!fs.existsSync(abs)) return null
  let st = null
  try { st = typeof fs.statSync === 'function' ? fs.statSync(abs) : null } catch (e) { st = null }
  if (st && typeof st.isFile === 'function' && !st.isFile()) return null

  // ③ 工程根
  const root = findProjectRoot(path.dirname(abs), deps)
  if (!root) return null
  const wdir = path.join(root, '.warden')

  // ④ 是不是被盯的源文件
  const paramsPath = path.join(wdir, 'params.yml')
  if (!fs.existsSync(paramsPath)) return null
  const watched = parseWatchedFiles(fs.readFileSync(paramsPath, 'utf8'))
  if (!watched.length) return null
  const target = pathKey(path.resolve(abs))
  const hit = watched.find((w) => pathKey(path.resolve(root, w.file)) === target)
  if (!hit) return null

  // ⑤ 账本最新一轮是 done 吗
  const roundsPath = path.join(wdir, 'ROUNDS.jsonl')
  if (!fs.existsSync(roundsPath)) return null
  const last = latestRound(parseJsonl(fs.readFileSync(roundsPath, 'utf8')))
  if (!last) return null
  if (String(last.rec.status ?? '') !== 'done') return null
  const doneAt = last.at
  if (!(doneAt > 0)) return null

  // ⑥ 那之后有没有快照
  const snapAt = latestSnapshotAt(wdir, deps)
  if (snapAt > doneAt) return null

  const reqId = String(last.rec.requirement ?? '').trim()
  if (!reqId) return null   // 没有真实需求号就没法给出可跑的命令 → 不拦

  return { kind: 'deny', reason: buildReason({ reqId, doneAt, root, raw }) }
}

/**
 * 纯判据主体：**只做判定，不兜异常**（自检要能看到它抛）。
 * `input = { toolName, toolArgs, cwd?, cwds? }`；返回 `{kind:'allow'}` 或 `{kind:'deny',reason}`。
 */
export function decide(input, deps) {
  const { fs, path } = io0(deps)
  const toolName = String((input && input.toolName) ?? '')
  if (!GATE_TOOLS.includes(toolName)) {
    // ①c **交付动作**：把判据挂到"我把它交给你"那一刻（用户点名要的）
    if (PRESENT_TOOLS.includes(toolName)) return judgePresent(input, deps)
    // ①b shell 类工具：**不是零 IO 了** —— 但只在"提到被盯文件 + 带写动作"时才真的去读盘
    if (SHELL_TOOLS.includes(toolName)) return judgeShell(input, deps)
    return allow()                                            // ① 其它非写文件工具：零 IO 放行
  }

  const args = input && input.toolArgs
  if (!args || typeof args !== 'object') return allow()
  const raw = args[PATH_FIELD]
  if (typeof raw !== 'string' || !raw.trim()) return allow()

  const bases = []
  const seen = new Set()
  const push = (b) => {
    if (typeof b !== 'string' || !b) return
    const k = pathKey(b)
    if (seen.has(k)) return
    seen.add(k); bases.push(b)
  }
  if (Array.isArray(input.cwds)) for (const b of input.cwds) push(b)
  push(input.cwd)
  if (!bases.length) push(process.cwd())

  const abs0 = path.isAbsolute(raw) ? path.normalize(raw) : null
  if (abs0) return judgeOne(abs0, raw, deps) ?? allow()

  for (const base of bases) {
    const abs = path.resolve(base, raw)
    const v = judgeOne(abs, raw, deps)
    if (v && v.kind === 'deny') return v
  }
  return allow()
}

/**
 * shell 类工具的判定（2026-09-17 新增，补 R12 的保留项）。
 * 只在"命令文本里**提到**被盯的档位文件、且带写动作"时，才对那个文件跑 `judgeOne`。
 */
function judgeShell(input, deps) {
  const { fs, path } = io0(deps)
  const args = (input && input.toolArgs) || {}
  let text = ''
  try { text = typeof args === 'string' ? args : JSON.stringify(args) } catch (e) { return allow() }
  if (!text) return allow()
  if (!WRITE_HINTS.test(text)) return allow()          // 没看到写动作 ⇒ 不多看一眼

  const bases = []
  if (Array.isArray(input.cwds)) for (const b of input.cwds) if (typeof b === 'string' && b) bases.push(b)
  if (typeof input.cwd === 'string' && input.cwd) bases.push(input.cwd)
  if (!bases.length) bases.push(process.cwd())

  // ⚠ `JSON.stringify` 会把路径里的反斜杠**变成两个**（`\` → `\\`），所以归一化必须
  //   ① 反斜杠→正斜杠 ② **把连续斜杠折叠成一个** —— 只做①的话 `D://x` 永远不等于 `D:/x`
  //   （我第一版就是这么写的，自检⑬当场红了）。
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
  const t = norm(text)
  const seenRoot = new Set()
  for (const base of bases) {
    let root = null
    try { root = findProjectRoot(base, deps) } catch (e) { root = null }
    if (!root) continue
    const k = pathKey(root)
    if (seenRoot.has(k)) continue
    seenRoot.add(k)
    const paramsPath = path.join(root, '.warden', 'params.yml')
    if (!fs.existsSync(paramsPath)) continue
    let watched = []
    try { watched = parseWatchedFiles(fs.readFileSync(paramsPath, 'utf8')) } catch (e) { continue }
    for (const w of watched) {
      if (!w || !w.file) continue
      const abs = path.resolve(root, w.file)
      // 命令里可能是绝对路径、也可能是相对工程根的写法 —— 两种都认
      const hit = t.includes(norm(abs)) || t.includes(norm(String(w.file)))
      if (!hit) continue
      const v = judgeOne(abs, w.file, deps)
      if (v && v.kind === 'deny') return v
    }
  }
  return allow()
}

/**
 * 插件只调这一个：**任何异常都变成 allow**（fail-open 硬约束）。
 * 中间件绝不能因为看守自己坏了而让工具调用失败。
 */
export function preToolDecision(input, deps) {
  let io = null
  try { io = io0(deps) } catch (e) { return allow() }
  try {
    return decide(input, io)
  } catch (e) {
    try {
      // 走 stderr，不进模型上下文：判据坏了要能看见，但不能污染工具结果
      console.error('[warden-gate] 判据出错，放行（fail-open）：' + String((e && e.message) || e))
    } catch (_) { /* 连 console 都没了也要放行 */ }
    return allow()
  }
}
