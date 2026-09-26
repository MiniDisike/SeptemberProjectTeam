'use strict'
/**
 * R43 —— 「把写交接与读交接写进硬规则」的**执行器**（常驻 Host Cordis 插件）。
 *
 * 用户逐字（2026-09-24）：「（用户原话已隐去 —— 公开版不留逐字）」
 * 派单里的定性：「这是对"靠自觉"的反制……所以**必须是代码拦，不是提醒**。」
 *
 * ---------------------------------------------------------------------------
 * 本文件只做两件事，都是**代码拦**，都不是提示词：
 *
 *   ① 读闸（硬）—— 会话开始后，**没读过本工程的交接文件之前，不许改任何文件**。
 *      落点：`tools/pre-execute` waterfall（`dsh-tools\lib\index.js:3116`）
 *      返回 `{kind:'deny', reason}` ⇒ 该调用**在派发前**就变成 error
 *      （`dsh-tools\lib\index.js:3127-3138` 把 reason materialize 成 isError 结果）。
 *      "读过"是机器判的：只看 `tools/result` 里一次**成功的 `read`**、且路径命中
 *      交接文件（`dsh-tools\lib\index.js:3284-3302`，emit 观测，返回值没人看）。
 *      **模型自称"读过了"不参与判定**（R43 必须③）。
 *
 *   ② 写闸（硬）—— 一轮里改过文件却没更新交接 ⇒ **不许当完成**。
 *      `agent/turn-stopping` 是 **serial**（`dsh-agent-loop\lib\index.js:967`
 *      `await this.dispatch.serial(...)`，返回值被丢掉）⇒ **它没有 deny 这条路**。
 *      能用的"阻止收尾"只有一条，而且是**代码**：
 *      `dsh-agent-loop\lib\index.js:973` `if (turnEnds && this.inbox.nextStep.length === 0) break;`
 *      ⇒ 往 `inbox.next-step` 塞一条（`agent.steer()`，同文件 `:792-794`），
 *        **回合的 break 条件不成立，回合真的结束不了**。
 *      另加一条**无条件的 deny**（不依赖 steer 是否成功、也不依赖事件语义）：
 *      下一轮**第一次要改文件的动作**被 `tools/pre-execute` 直接 deny，理由里列出
 *      "上一轮改了哪 N 个文件、交接在哪、怎么补"。这一条是硬的、可重复的、不会成环的。
 *
 * ---------------------------------------------------------------------------
 * 硬约束（本 skill 反复吃过的亏，逐条照办）：
 *   · **fail-open 是硬约束**：本文件是"看守"，看守自己坏了**绝不许**让工具调用失败。
 *     判定体一律包 try/catch，异常 ⇒ allow（`console.error` + 一行失败记录，不进模型上下文）。
 *   · **不许静默失效**：推不出工程根 / 交接文件不存在 / 事件形状变了 —— 一律记一行失败
 *     （`state.failures` + stderr + 落盘行），**绝不装作没这回事**。
 *   · **可逆**：所有监听走 `ctx.on`（Cordis 里 `ctx.on` 本身就是当前 fiber 的 effect，
 *     `cordis\lib\index.js:335-345` `register()` → `this.ctx.fiber.effect(...)`，
 *     返回 disposer）；另用 `ctx.effect()` 兜一层，dispose 后监听器与内存状态全摘掉。
 *   · **不注册任何"持续"通道**：**不注册任何 systemPrompt / runtime context / 消息通道**。
 *     对 `ctx` 的调用**只有** `ctx.on` 与 `ctx.effect`（自检里逐条列出来证明）。
 *     ⚠ **口径更正（R43 返工，旧稿写"零上下文注入"是假的）**：写闸的收尾侧
 *     `agent.steer()` **每次都会塞一条 `role:"user"` 消息进上下文**（实测 561 字符 / 847 字节
 *     ≈ **244 token**），上限 ≤1 次/回合、≤2 次/会话 ⇒ **≤488 token/会话**。
 *     它**不是持续通道**（不注册任何东西，只推一次 inbox），但**确实进上下文** ——
 *     所以不许再说"零上下文注入"。`WARDEN_HANDOVER_STEER=off` 可关（**每次现读**，见 normalizeOpts）。
 *   · **运行时"只读盘"也是假的（口径更正，R43 返工）**：本插件**会写盘**，只写**一个自己造的
 *     事件行文件**（deny / 失败 / steer / 回合脏 / 读交接）。落点按下面顺序取第一个**可写**的：
 *       ① `opts.logPath`（自检传的显式路径，无条件用）；
 *       ② `WARDEN_HANDOVER_LOG`（同上，显式）；
 *       ③ `<root>\.warden\HANDOVER-GATE.jsonl` —— **只在 `.warden` 这个目录已经存在时**；
 *       ④ 上面都不成立 ⇒ `%TEMP%\handover-gate.jsonl`（`os.tmpdir()`）。
 *     ⚠ **绝不 mkdir**：非显式路径要求**父目录已经存在**，不存在就往下一条候选退。
 *       实测（审查）：不给 `logPath` 时，在被审工程根下会得到
 *       `<该工程>\.warden\HANDOVER-GATE.jsonl`
 *       ⇒ **插件会往被审工程里 append 一个它自己造的新文件**。这就是事实口径，不许含糊。
 *     允许路径永远可写豁免，所以这条落盘**不会**和读闸/写闸打架。
 *
 * ---------------------------------------------------------------------------
 * 模块形态：`module.exports = { name, inject, apply }`（**不是** `export const name`）。
 *   证据：同目录的 `warden-watch.js` 就是这个形态，而 `cordis.patch.yml` 的 insert 行
 *   现在正挂着它、它是活的。`inject: []` —— Cordis 的 inject 是**硬依赖**，
 *   声明了却缺席会让**整个插件**进 waiting；本插件不需要任何服务。
 */

const nodeFs = require('node:fs')
const nodePath = require('node:path')

/* ==========================================================================
 * 一、常量与判据表
 * ========================================================================== */

/** 交接文件的两个名字（R43 ③） */
const HANDOVER_BASE = '交接.md'          // 首选
const HANDOVER_PREFIX = '交接-'
const HANDOVER_SUFFIX = '.md'

/**
 * 本插件自己的版本串 —— **只出现在自动草稿的 `生成者:` 那一行**，不参与任何判定。
 * 为什么要有它：自动草稿是"机器写的"，读它的人必须能一眼看出**是哪个版本写的**
 * （草稿内容随版本变；`生成者: handover-gate@<版本>` 就是钉住这一点的）。
 */
const PLUGIN_VERSION = '1.1.0-auto-draft'

/* ──────────────────────────────────────────────────────────────────────────
 * ★ 自动写交接草稿（AUTO-DRAFT）—— 常量表
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ⚠⚠ **这一节是本文件里唯一"会主动写盘"的功能。** 下面每一条都是**安全阀**，
 *    顺序、判据、为什么这么定，全部写在这里；改它们之前先读完整节。
 *
 * 用户逐字（2026-09-24，本功能的需求原文）：「（用户原话已隐去 —— 公开版不留逐字）」
 *
 * ⇒ 需求拆成**两条机器判据**，缺一不可：
 *   ① 开关打开（`WARDEN_HANDOVER_AUTO=on` / config `auto`）—— 决定"这个工程要不要自动写"；
 *   ② **本轮显式声明"这活还有后续"**（`WARDEN_HANDOVER_NEXT="…"` / config `next`）—— 决定
 *      "这一轮是不是那种'做完还需要接手'的活"。
 *   **默认两条都不成立 ⇒ 永不写。** 这就落实了"不是每一个动作都写"。
 *
 * 为什么判据用「显式声明」而不是从账本里猜：
 *   实测（2026-09-24 的 `.warden/ROUNDS.jsonl`，114 条）里**没有可靠信号**要它
 *   —— `plan` 只有 1 条非空、`branch` **0 条**；`missing_half`（半成品）也不是这个语义，
 *   拿它当"有后续"就等于**每个半成品都写交接**，正是用户明确反对的那种。
 *   ⇒ 所以**不猜**：由调用方在环境变量/config 里**显式说一句**，插件只认这一句。
 *
 * ── 怎么用（逐字可抄） ────────────────────────────────────────────────────
 *   打开开关（常驻 Host 插件的进程环境变量，**每次现读**，不必重启）：
 *     `setx WARDEN_HANDOVER_AUTO on`                        （Windows，之后新开的窗口生效）
 *     `$env:WARDEN_HANDOVER_AUTO = 'on'`                    （只对当前这个 shell 生效）
 *   本轮声明"这活还有后续"（**这一句就是草稿里"下一步"的来源**）：
 *     `setx WARDEN_HANDOVER_NEXT "把 X 推到远端，然后重跑自检"`
 *     `$env:WARDEN_HANDOVER_NEXT = '把 X 推到远端，然后重跑自检'`
 *   关掉（默认值就是 off，这一行只是写明白）：
 *     `setx WARDEN_HANDOVER_AUTO off`
 *   config 形式（`cordis.patch.yml` 里本插件那一节，与 env 二选一，config 优先）：
 *     ```yaml
 *     - name: handover-gate
 *       config:
 *         auto: true                       # 等价于 WARDEN_HANDOVER_AUTO=on
 *         next: "把 X 推到远端，然后重跑自检"   # 等价于 WARDEN_HANDOVER_NEXT
 *     ```
 *   ⚠ `next` 里**只有空白的字符串 = 没声明**（不许拿一个空格当声明）。
 *   ⚠ 声明是**逐轮**的：这一轮声明了、下一轮没声明 ⇒ 下一轮**不写**。
 *      （env 是进程级的，做不到逐轮自动清 —— 所以要按需 `setx`/`Remove-Item Env:`
 *        或干脆用 config。**这是如实标注的限制**，不是 bug。）
 *
 * ── 文件名（★ 必须读：它会反过来影响两道闸） ──────────────────────────────
 *   自动草稿的文件名 = `HANDOVER_AUTO_PREFIX + 'YYYY-MM-DD' + HANDOVER_SUFFIX`
 *   ⇒ 就是 **`交接-2026-09-24.md`** —— **它故意走"交接文件那一套名字"**。
 *
 *   为什么**必须**这样（代价与理由都写清，用户要求"报告这个选择及其后果"）：
 *     · 自动草稿的**目的**是"让任务自动化" ⇒ 它必须是一份**真交接文件**：
 *       能被下一轮的人 `read` 到、能被算成"这个工程有交接"、能被 `isHandoverName` 认出来。
 *     · 若起一个**不被 `isHandoverName` 认的**名字（如 `_auto-交接草稿.md`），
 *       它**不消写闸**（`onToolResult` 里"只有解析出来的那一份才算更新了交接"）⇒
 *       草稿写完**欠账还在** ⇒ 用户还是被拒绝改文件 ⇒ 这个功能等于没做（**半成品**）。
 *     · 若起 `交接.md`（首选名）⇒ **抢占用户自己的首选名**，那是用户的文件，不行。
 *
 *   ⇒ 所以选了 `交接-<日期>.md` 这一族名。**后果（如实、一条不漏）**：
 *     ① `isHandoverName('交接-2026-09-24.md') === true` ⇒ 它**是**一份"交接文件"：
 *        工程根下写它**走两道闸的共同豁免**（`decideWrite` 第 2 步）、且**能消写闸欠账**
 *        （`onToolResult` 里 `pathKey(abs) === pathKey(resolvedPath)` 那一条）——
 *        这正是我们要的（草稿必须真的算数），但它也意味着
 *        **一份自动草稿能让"这个工程有交接"成立、从而解除 deny**。
 *     ② 它会**参与"最新那一份"的选举**（`compareLatestHandover`：日期优先）。
 *        同一天里若同时存在用户手写的 `交接-2026-09-24.md` —— **保护条件 (1) 会让插件
 *        根本不写**（已存在的文件没有 AUTO 标记 ⇒ 绝不覆盖）⇒ 不会打架。
 *        但**跨天**时：自动草稿是"今天"的日期 ⇒ 它会**盖过**用户昨天手写的那一份的选举
 *        ⇒ 会话"必须读的那一份"变成自动草稿（内容只有机器字段，没有人的上下文）。
 *        ⚠ 这是**已知代价**，如实标注：**要么别开这个开关，要么接受"跨天后最新那份可能是草稿"**。
 *     ③ **它不会去碰 `交接.md`**（首选名）—— 首选名存在时 `resolveHandover` 直接命中它，
 *        自动草稿**连候选都不会成为**（不覆盖、不抢）。
 *
 * ── 四道安全阀（**每一条都必须成立才写**，顺序即判定顺序） ────────────────
 *   (1) **已存在的同名文件里没有 AUTO 标记 ⇒ 绝不写**（`canWriteAutoDraft`）。
 *       判据不是"文件存不存在"，而是"**它是不是插件自己写的**"：只有首行逐字是
 *       `<!-- AUTO-ONLY -->` 才允许覆盖。所以**用户/主代理写的任何一份永远不会被覆盖**
 *       —— 哪怕名字正好撞上（比如用户自己写了一份 `交接-今天.md`）。
 *       读不出来（权限/编码）⇒ **当没有标记处理 ⇒ 不写**（fail-closed 的方向）。
 *   (2) **本回合零改动 ⇒ 不写**（`dirty` 为空 ⇒ `no-dirty`）。
 *   (3) **没有显式声明"有后续" ⇒ 不写**（`next` 为空 ⇒ `no-next`）。
 *   (4) **`dry` 模式 ⇒ 只打印不写**（`dry:true` ⇒ 走的是同一条判定链，但把字节算出来、
 *       记一行 `auto-draft-dry` 日志、**不调 `writeFileSync`**）。
 *   另外开关没开（默认）⇒ **连判定都不进**，理由 `auto-off`；草稿已是最新 ⇒ `already-current`。
 *
 * ── 自动生成标记（防覆盖的另一半） ────────────────────────────────────────
 *   · 文件的**第一行**逐字是 `<!-- AUTO-ONLY -->`（`HANDOVER_AUTO_MARK`）。
 *   · **第二行**逐字是"本文件由插件生成，**不要手改**，手改会被下次覆盖"。
 *     为什么两行：标记行要能被别的东西（脚本/grep）当作**机器判据**用，
 *     而"不要手改"那句话是给**人**看的 ⇒ 不能混在一行里。
 */
const HANDOVER_AUTO_MARK = '<!-- AUTO-ONLY -->'
const HANDOVER_AUTO_PREFIX = '交接-'
/** 第二行（人读的那句）—— 逐字，改它要同时改自检 */
const HANDOVER_AUTO_WARN = '本文件由插件生成，**不要手改**，手改会被下次覆盖。'
/** 草稿正文里要排除的目录名（工程根下的一级目录）—— 见 `draftPaths` */
const AUTO_DRAFT_EXCLUDE_DIRS = Object.freeze(['.warden', '.dsh'])

/** **会改盘**的工具（只拦这几类 —— 见读闸的注释：范围一放开就死锁） */
const MODIFY_TOOLS = Object.freeze(['write', 'edit', 'str_replace_editor'])
/**
 * shell 类。★ R43 返工（S5）：**未读交接时整个类都 deny**（不再只看关键词）——
 *   旧稿只认关键词，`pwsh -Command "node -e \"fs.writeFileSync(...)\""` **既不触发读闸也不触发写闸**，
 *   能整条绕过 R43 去改工程文件。读交接只需要 `read` 工具，所以"未读 ⇒ 整个类拒"没有死锁。
 *   读过之后：只读命令放行；有欠账时**整个类**也 deny（否则同一句 `node -e` 又能绕过写闸）。
 *   ⚠ 仍然**拦不住**（如实）：`node script.mjs`（脚本内部写盘）、`python -c "open(…,'w')"`、
 *   任何拼出来的路径 —— 这些在"已读 + 无欠账"时是过的，写在 DESIGN 的"拦不住"里。
 */
const SHELL_TOOLS = Object.freeze(['pwsh', 'bash', 'sh', 'shell', 'cmd', 'run', 'exec'])
/**
 * ★ R43 返工（S4）：声明交付（`present`）。它**不写盘**，但"声明完成"正是 R43 要拦的那件事
 *   ⇒ 它**只受写闸管**（有欠账 ⇒ deny），**不受读闸管**（它不改盘，不必先读交接）。
 */
const PRESENT_TOOLS = Object.freeze(['present'])

/**
 * 写动作启发式。★ R43 返工后的用途**收窄了**：它现在**只**用来决定"这次 shell 调用要不要
 * 记进本回合的脏清单"（读闸已经不靠它了 —— 未读交接时整个 shell 类都被拒）。
 * ⚠ 与 `gate.mjs` 的 `WRITE_HINTS` **不是**同一个正则，两处口径不同是有意的：
 *   gate.mjs 那份把 `>` 单独当写动作 ⇒ **`2>&1` 也会命中**（实测：`node --check x.js 2>&1`
 *   会被当成改盘）。本闸要收窄误报：`>` 后面必须跟一个**不是 `&`** 的目标。
 *   `> file` / `>> file` 命中；`2>&1` / `>&1` 不命中。
 * ⚠ 仍然**拦不住** `node script.mjs`（脚本内部写盘）、`python -c "open(...).write()"`、
 *   以及任何拼出来的路径 —— 这时它**不会被记成脏**（如实标注，不许说成"防住了 shell"）。
 */
const WRITE_HINTS = /(Set-Content|Add-Content|Out-File|Set-ItemProperty|Remove-Item|Move-Item|Copy-Item|New-Item|Clear-Content|Rename-Item|tee\b|sed\s+-i|truncate|dd\s|>\s*[^&\s])/i

/**
 * ★★ 三条硬规矩 —— **逐条逐字**，**全部从权威源机器抽取**。
 *   权威源 = `派单模板.md`（"派单前从这里抄，不凭记忆"的那个文件）。
 *   自检 ㉓ 现在**读那个文件、按行号机器抽取**（L13/L14/L18/L22），与这里**逐条 `===`** ——
 *   自检里**不再另抄一遍**（另抄一遍就是第二个真相源；旧稿正是靠它把**错的字符**钉成期望值
 *   ⇒ 58/58 里含一条**假绿**）。
 *
 * ⚠ **R43 返工的现场（本项目 A5「不许拿听上去合理的解释代替核实」的实例，两个错叠在一起）**：
 *     ① 第 2 条：第一版**本来就是正确的 ASCII**（与权威源一致）；错的是自检 ㉓ 里**另抄的那份
 *        期望值**（弯引号）⇒ ㉓ 把**对的**报成 `#2DIFF`；而"修法"**方向反了** ——
 *        把**正确的 ASCII 改成弯引号**，还把**错的字符**写进 ㉓c 钉成期望值 ⇒ **那条绿是假的**。
 *        （旧注释把这件事写成"第一版抄错了"，**方向也是反的**。）
 *     ② 第 1 条：**把权威源的两行用全角空格 U+3000 拼成了一行**，旧注释还把结论写成
 *        "权威源里两个引号之间是全角空格"（**权威源里一处 U+3000 都没有**，
 *        那是**我拼的时候加的**）⇒ 这不是抄错一个字符，是**改写了结构**；
 *        第 3 条同样是被压缩过的句子（权威源 L22 只到"指到镜像"）。
 *
 *   抽取规则（**只有这一条**）：按行号取那一行，若行首有 markdown 标题装饰
 *   （`## ⚠ ` / `## ⚠⚠ `）就剥掉，**其余一个字符都不动** ——
 *   不拼接、不加全角空格、不剥 `**` 强调记号、不改引号、不补句号。
 *
 *   ```
 *   第 1 条 = 权威源 **两行**（L13 错写法行 + L14 正写法行）⇒ HARD_RULES[0] / [1]
 *   第 2 条 = L18（标题行，剥掉 `## ⚠ `）                  ⇒ HARD_RULES[2]
 *   第 3 条 = L22（标题行，剥掉 `## ⚠ `）                  ⇒ HARD_RULES[3]
 *   ```
 *   ⚠ 所以 `HARD_RULES` 是 **4 行**（3 条规矩），**不是 3 行** ——
 *   第 1 条在权威源里本来就是"错写法行 / 正写法行"的**两行对照**。
 *   自检 ㉓ 按 **L13/L14/L18/L22** 逐行抽取、逐条 `===`（自检里**不另抄一遍**）。
 */
const HARD_RULES = Object.freeze([
  '✗ 错写法：「只改你点名的文件」                      ← 会诱导你直接改真文件',
  '✓ 正写法：「只改 .warden/patches/<ID>/work/ 里的副本；**真文件一个字节都不许动**」',
  '不许用"加提示词"来解决任何问题',
  '测副本必须把 DSH_HOME 指到镜像',
])

/** deny 理由里那一段逐字规矩（每行**不加**前缀，保证整行可被逐字 grep） */
function rulesBlock() {
  return [
    '  本单三条硬规矩（逐字，必须原样抄进每份任务书；**第 1 条在权威源里是两行**，所以下面有 4 行）：',
    ...HARD_RULES,
  ].join('\n')
}

/* ==========================================================================
 * 二、依赖注入与路径工具（自检可以不碰真盘：fs/path 都能喂假的）
 * ========================================================================== */

function io0(deps) {
  const d = (deps && typeof deps === 'object') ? deps : {}
  return { fs: d.fs || nodeFs, path: d.path || nodePath }
}

/** Windows 上路径大小写/斜杠不敏感 —— 比较用的规范化键（与 gate.mjs 同口径） */
function pathKey(p) {
  const s = String(p === undefined || p === null ? '' : p).replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** 交接文件名的两个认法 */
function isHandoverName(n) {
  const s = String(n || '')
  if (s === HANDOVER_BASE) return true
  return s.startsWith(HANDOVER_PREFIX) && s.endsWith(HANDOVER_SUFFIX) && s.length > HANDOVER_PREFIX.length + HANDOVER_SUFFIX.length
}

/**
 * 从 `交接-YYYY-M-D.md` 里取出可比较的日期键（**补零后**，字典序 = 时间序）；取不到返回 ''。
 * ★ R43 返工（S10）：**月/日不补零也认**（`交接-2026-9-24.md`）。
 *   旧稿只认 `\d{2}`，于是 `交接-2026-9-24.md` 不被认成日期 ⇒ **静默退回 mtime**。
 *   为什么必须支持：本文件下面 `compareLatestHandover` 的注释自己写着"mtime 的语义是
 *   '这个文件什么时候被拷过来的'，**不是**交接的语义"；名字里明明写着日期却不认，
 *   等于把口径偷偷退回 mtime。非法月/日（0 或 13+）仍返回 ''（不许拿垃圾名字赢过真日期）。
 */
function dateOfHandoverName(n) {
  const m = /^交接-(\d{4})-(\d{1,2})-(\d{1,2})\.md$/.exec(String(n || ''))
  if (!m) return ''
  const mo = Number(m[2])
  const dy = Number(m[3])
  if (!(mo >= 1 && mo <= 12) || !(dy >= 1 && dy <= 31)) return ''
  return m[1] + ('0' + mo).slice(-2) + ('0' + dy).slice(-2)
}

function numOr(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/* ==========================================================================
 * 三、工程根（R43 ③ / R40 ②）
 * ========================================================================== */

/**
 * 与 `warden.mjs` 的 `findProjectRootVia` **同约定**（只读参考，**没有** import 它 ——
 * 它是 ESM，本文件是 CJS，而且"不许改它"）：
 *   · 向上找最近的 `.git` ⇒ `via:'git'`（正路）
 *   · 一路没有 `.git`，退而取"最近的、装着 `.warden` 的那一层" ⇒
 *     `via:'self-warden'`（就是它自己）/ `via:'ancestor-warden'`（是祖先 —— **静默路**，要当心）
 *
 * ⚠ **与 warden.mjs 的一处有意不同**：什么都没找到时，warden.mjs 返回
 *   `{root: start, via:'self'}`（它必须给个目录才能干活），本闸返回 `{root:null, via:'unresolved'}`。
 *   为什么：对本闸来说"推不出工程根"和"工程根就在这儿"是**两件必须分得开的事** ——
 *   返回 start 会让"推不出"伪装成一个正常根，那就成了静默失效。
 */
function findProjectRootVia(start, deps) {
  const { fs, path } = io0(deps)
  let abs = ''
  try { abs = path.resolve(String(start)) } catch (e) { return { root: null, via: 'unresolved' } }
  let d = abs
  let wardenOwner = null
  for (;;) {
    let hasGit = false
    let hasWarden = false
    try { hasGit = fs.existsSync(path.join(d, '.git')) } catch (e) { /* 读不到就当没有 */ }
    try { hasWarden = fs.existsSync(path.join(d, '.warden')) } catch (e) { /* 同上 */ }
    if (hasGit) return { root: d, via: 'git' }
    if (wardenOwner === null && hasWarden) wardenOwner = d
    let up = ''
    try { up = path.dirname(d) } catch (e) { break }
    if (!up || up === d) break
    d = up
  }
  if (wardenOwner !== null) {
    return { root: wardenOwner, via: pathKey(wardenOwner) === pathKey(abs) ? 'self-warden' : 'ancestor-warden' }
  }
  return { root: null, via: 'unresolved' }
}

/* ==========================================================================
 * 四、交接文件解析（R43 ③）
 * ========================================================================== */

function statMtimeMs(fs, p) {
  try { const st = fs.statSync(p); return Number(st.mtimeMs) || 0 } catch (e) { return 0 }
}

/** 列出工程根下的所有候选交接文件（只读一个 readdir + 每个候选一次 stat） */
function listHandovers(root, deps) {
  const { fs, path } = io0(deps)
  const out = []
  const preferred = path.join(root, HANDOVER_BASE)
  let prefOk = false
  try { prefOk = fs.existsSync(preferred) && fs.statSync(preferred).isFile() } catch (e) { prefOk = false }
  if (prefOk) {
    out.push({ name: HANDOVER_BASE, path: preferred, date: '', mtime: statMtimeMs(fs, preferred), preferred: true })
  }
  let names = []
  try { names = fs.readdirSync(root) } catch (e) { names = [] }
  for (const n of names) {
    if (n === HANDOVER_BASE) continue
    if (!isHandoverName(n)) continue
    const p = path.join(root, n)
    let st = null
    try { st = fs.statSync(p) } catch (e) { continue }
    let isFile = true
    try { isFile = (st && typeof st.isFile === 'function') ? st.isFile() : true } catch (e) { isFile = true }
    if (!isFile) continue
    out.push({ name: n, path: p, date: dateOfHandoverName(n), mtime: Number(st && st.mtimeMs) || 0, preferred: false })
  }
  return out
}

/**
 * "最新的一份"的口径（**必须钉住，否则同一份夹具两个人算出两个答案**）：
 *   ① 名字里带 ISO 日期的（`交接-YYYY-MM-DD.md`）优先于不带的 —— 日期键大的在前；
 *   ② 同一天/都不带日期时，`mtimeMs` 大的在前；
 *   ③ 再相同，文件名大的在前（ISO 日期串字典序 = 时间序）。
 * 为什么日期优先于 mtime：交接文件的**语义**是"哪一天的交接"，不是"这个文件什么时候被
 * 拷过来的"。实测本工程里就有一份反例：`交接-2026-09-24.md`（今天写的）和
 * `交接-做成DSH插件.md` / `交接-补充给插件窗口.md`（09-16 的旧件）并存 ——
 * 三个名字里只有一份带 ISO 日期 ⇒ 日期键单独就能把它挑出来，不依赖 mtime。
 */
function compareLatestHandover(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1
  if (a.mtime !== b.mtime) return b.mtime - a.mtime
  if (a.name === b.name) return 0
  return a.name < b.name ? 1 : -1
}

/**
 * 解析出"这个会话必须读/必须更新的那一份交接文件"。
 * 返回：`{ok:true, path, how, picked, candidates}` 或
 *       `{ok:false, why:'none', root, expect, candidates:[]}`
 *
 * ★ 性能：首选名命中时**直接返回**，不做 `readdirSync`。
 *   为什么值得单独写一句：本闸挂在**每一次改盘工具调用**上，而"首选名命中"是常态
 *   ⇒ 常态路径上省掉一次 readdir + 每个候选一次 stat（实测 ~200 µs/次）。
 *   `candidates` 只在"要给人看有哪些候选"时才需要，所以它在快路径上就是 `['交接.md']`。
 */
function resolveHandover(root, deps) {
  const { fs, path } = io0(deps)
  const preferred = path.join(root, HANDOVER_BASE)
  let prefOk = false
  try { prefOk = fs.existsSync(preferred) && fs.statSync(preferred).isFile() } catch (e) { prefOk = false }
  if (prefOk) {
    return { ok: true, path: preferred, how: '首选名 `交接.md`', picked: HANDOVER_BASE, candidates: [HANDOVER_BASE] }
  }
  const cands = listHandovers(root, deps)
  const names = cands.map((c) => c.name)
  if (!cands.length) {
    return { ok: false, why: 'none', root: root, expect: preferred, candidates: names }
  }
  const dated = cands.filter((c) => c.date !== '')
  const pool = (dated.length ? dated : cands).slice()
  pool.sort(compareLatestHandover)
  const pick = pool[0]
  return {
    ok: true,
    path: pick.path,
    how: dated.length
      ? '`交接-<日期>.md` 里**日期最新**的一份（日期优先于 mtime）'
      : '`交接-*.md` 里 **mtime 最新**的一份（名字里没有可解析的 ISO 日期）',
    picked: pick.name,
    candidates: names,
  }
}

/* ==========================================================================
 * 五、会话/调用信息的读取（只用官方 hooks 在读的那两个字段）
 * ========================================================================== */

/** `agent.session.header.id` —— 官方 `dsh-hooks-codex\lib\index.js:305` 读的就是它 */
function sessionOf(agent) {
  try {
    const h = agent && agent.session && agent.session.header
    if (h && typeof h.id === 'string' && h.id) return h.id
  } catch (e) { /* 读不到就退化 */ }
  return 'anonymous'
}

/** `agent.session.header.cwd` —— 官方 `dsh-hooks-codex\lib\index.js:146/307` 读的就是它 */
function cwdOf(agent) {
  try {
    const h = agent && agent.session && agent.session.header
    if (h && typeof h.cwd === 'string' && h.cwd) return h.cwd
  } catch (e) { /* 下一条 */ }
  try { return process.cwd() } catch (e) { return '' }
}

/** 相对路径的解析基准表（与 gate.mjs 同口径：cwds 在前，cwd 兜底） */
function collectBases(input) {
  const out = []
  const push = (b) => { if (typeof b === 'string' && b && out.indexOf(b) < 0) out.push(b) }
  if (input && Array.isArray(input.cwds)) for (const b of input.cwds) push(b)
  if (input && typeof input.cwd === 'string') push(input.cwd)
  if (!out.length) { try { push(process.cwd()) } catch (e) { /* 连 cwd 都没有 */ } }
  return out
}

/** 目标路径 → 一组绝对候选（相对路径可能落在任何一个基准下，全试） */
function candidateAbs(raw, bases, deps) {
  const { path } = io0(deps)
  const out = []
  if (typeof raw !== 'string' || !raw) return out
  try {
    if (path.isAbsolute(raw)) { out.push(path.normalize(raw)); return out }
  } catch (e) { return out }
  for (const b of bases) {
    try { const p = path.resolve(b, raw); if (out.indexOf(p) < 0) out.push(p) } catch (e) { /* 跳过 */ }
  }
  return out
}

/**
 * 一次调用里**只做一次**向上找根（性能 + 一致性）。
 * 返回 `{abs, baseDir, pr}`：
 *   · 有目标路径 ⇒ 逐个候选找根，**第一个能落到某个工程根上**的胜出；
 *   · 都没有根 ⇒ 用第一个候选 + 它的（失败的）根判定；
 *   · 根本没有目标路径（shell 命令）⇒ 用会话 cwd 找根。
 * ⚠ 为什么必须一次：第一版里 `pickAbs()` 找一次根、`decideWrite()` 又找一次根，
 *   **每次改盘调用走两遍上升链**（实测白花 ~300 µs/次）。这是自检 ㉘ 抓出来的。
 */
function resolveTarget(raw, bases, deps) {
  const { path } = io0(deps)
  const cands = candidateAbs(raw, bases, deps)
  let firstPr = null
  let firstDir = ''
  for (const c of cands) {
    let dir = ''
    try { dir = path.dirname(c) } catch (e) { continue }
    const pr = findProjectRootVia(dir, deps)
    if (pr.root) return { abs: c, baseDir: dir, pr: pr }
    if (firstPr === null) { firstPr = pr; firstDir = dir }
  }
  if (cands.length) return { abs: cands[0], baseDir: firstDir, pr: firstPr || { root: null, via: 'unresolved' } }
  const baseDir = bases[0] || ''
  return { abs: '', baseDir: baseDir, pr: findProjectRootVia(baseDir, deps) }
}

/** 这一条绝对路径是不是"某个工程根下的交接文件" */
function isHandoverTarget(abs, root, deps) {
  const { path } = io0(deps)
  if (!abs || !root) return false
  let n = ''
  try { n = path.basename(abs) } catch (e) { return false }
  if (!isHandoverName(n)) return false
  try { return pathKey(path.dirname(abs)) === pathKey(root) } catch (e) { return false }
}

/* ==========================================================================
 * 六、"这次调用会不会改盘"（读闸/写闸的适用范围）
 * ========================================================================== */

function argsText(args) {
  try { return typeof args === 'string' ? args : JSON.stringify(args) } catch (e) { return '' }
}

/**
 * 会不会改盘。
 * ⚠ 范围**故意克制**：只认 `write` / `edit` / `str_replace_editor`，
 *   以及 **带写动作**的 shell 命令。`read` / `read_image` / `glob` / `grep` /
 *   `todo_write` / `present` / `skill` / `subagent` … 一律**零 IO 放行**。
 *   为什么必须这样（否则**死锁**）：读交接这个动作本身就是 `read` ——
 *   把 `read` 也拦了，就永远读不了交接，闸就永远解不开。
 *   自检里有专门一条负控钉这个（"read 自己不被拦"）。
 */
function isModifying(toolName, args) {
  if (MODIFY_TOOLS.indexOf(toolName) >= 0) return true
  if (SHELL_TOOLS.indexOf(toolName) >= 0) return WRITE_HINTS.test(argsText(args))
  return false
}

/** 直接写文件的那两个/三个工具，目标路径在 `file_path` */
function targetPathOf(toolName, args) {
  if (MODIFY_TOOLS.indexOf(toolName) < 0) return ''
  const v = args && args.file_path
  return typeof v === 'string' ? v : ''
}

/** shell 命令的可读摘要（只用于 deny 理由/脏清单，不用于判定） */
function shellDigest(toolName, args) {
  const t = argsText(args).replace(/\s+/g, ' ').trim()
  return '(' + toolName + ') ' + t.slice(0, 140) + (t.length > 140 ? ' …' : '')
}

/* ==========================================================================
 * 七、状态 + 失败记录（不许静默）
 * ========================================================================== */

function createState() {
  return {
    /** sid -> Set(pathKey)：这个会话**成功读过**的交接文件（绝对路径的规范化键） */
    read: new Map(),
    /**
     * ★ R43 返工（S2）：键 = `sid + ':' + turn`（**不再是 sid**）。
     *   值 = `{sid, turn, roots: Map<rootKey, {root, dirty:Map<key,display>, handoverTouched}>}`
     *   旧稿键是 sid、**只在 turn-stopping 里 delete** ⇒ `dsh-agent-loop\lib\index.js:941` 的
     *   `reject` / abort / `:945` / `:976` 跳过 turn-stopping 时，**记账跨回合泄漏**
     *   ⇒ 写闸被静默关掉（审查实测 `E16 {"ev":"clean","handoverTouched":true,"dirty":1}`）。
     *   现在还有一条兜底：`finalizeUpTo` 收尾 `turn <= 当前` 的**所有**桶，不只是当前这一个。
     */
    cur: new Map(),
    /**
     * sid -> {turn, src}：当前回合号。主源是 `agent/pre-step` 的 payload（**官方事件**，
     * payload 里就有 `turn`）；兜底是 `agent.phase.turn`（见 `turnOf`）。
     */
    curTurn: new Map(),
    /**
     * ★ R43 返工（S1）：键 = **工程根的 pathKey**（**不再是 sid**）。
     *   值 = `{paths:[], turn, root, sid, at, stale?}`。
     *   旧稿按 sid 存 ⇒ **子代理改了文件、父会话完全看不见**（审查实测
     *   `E11 {"turnRow":null,"steers":0,"pending":null}`）—— 而 R19 就是"编程活派给子代理"
     *   ⇒ 写闸可被最常用的工作方式整条绕过。
     */
    pending: new Map(),
    /** sid -> 本会话已经 steer 过几次（防环，落内存） */
    steers: new Map(),
    /** sid:turn -> 这一回合已经 steer 过几次 */
    steersTurn: new Map(),
    /** 失败行（不许静默失效的证据都在这里） */
    failures: [],
    /** 观测（进程内存；不落盘的也在里面） */
    denies: [],
    turns: [],
    reads: [],
    stats: { preExecute: 0, ioCalls: 0, denied: 0, allowed: 0, steered: 0 },
    logPath: '',
    logWritten: 0,
    logErrors: 0,
    logSkipped: 0,
    logSeen: new Map(),
    disposers: [],
  }
}

function pushRing(arr, row, cap) {
  arr.push(row)
  const n = cap || 200
  while (arr.length > n) arr.shift()
}

/**
 * 记一行失败。**这是"不许静默失效"的唯一出口**：
 *   ① `state.failures`（自检/诊断能读）
 *   ② stderr（`console.error` —— **不进模型上下文**）
 *   ③ 落盘（若 `logPath` 可解析）—— 因为实测教训是"只写 stderr 等于没记"
 *      （`warden-watch.js` 顶部那段：host 进程的 stderr 没有谁去看）。
 */
function fail(state, ev, detail, deps) {
  const row = Object.assign({ at: new Date().toISOString(), ev: ev, kind: 'failure' }, detail || {})
  pushRing(state.failures, row, 200)
  try { console.error('[handover-gate] ' + JSON.stringify(row)) } catch (e) { /* 连 console 都没了 */ }
  logRow(state, row, deps)
  return row
}

/** 同一 (ev,sid,gate,tool,target) 在这么长时间内只落一行 —— 防"deny 风暴"把日志刷爆 */
const LOG_DEDUPE_MS = 3000

/** 落一行观测（best-effort；失败绝不影响工具调用；同一事件 3 秒内只落一次） */
function logRow(state, row, deps) {
  try {
    if (!state.logPath) return
    const key = String(row.ev || '') + '|' + String(row.sid || '') + '|' + String(row.gate || '')
      + '|' + String(row.tool || '') + '|' + String(row.path || row.target || '')
    const now = Date.now()
    if (now - numOr(state.logSeen.get(key), 0) < LOG_DEDUPE_MS) { state.logSkipped += 1; return }
    state.logSeen.set(key, now)
    if (state.logSeen.size > 500) state.logSeen.clear()
    const { fs } = io0(deps)
    fs.appendFileSync(state.logPath, JSON.stringify(row) + '\n', 'utf8')
    state.logWritten += 1
  } catch (e) {
    state.logErrors += 1
  }
}

/**
 * 决定事件行落在哪。
 * ⚠ **绝不 mkdir**：只在 `<root>\.warden` **已经存在**时用它；否则退回 `%TEMP%`。
 *   理由：本插件在别人的工程里跑，**不许**为了自己记日志而往人家工程里建目录。
 * 每次解析会缓存（`state.logPath` 一旦定下就不再变）。
 */
function resolveLogPath(state, root, opts, deps) {
  if (state.logPath) return state.logPath
  const { fs, path } = io0(deps)
  const explicit = opts && opts.logPath ? String(opts.logPath) : ''
  const cands = []
  if (explicit) cands.push(explicit)
  if (root) cands.push(path.join(root, '.warden', 'HANDOVER-GATE.jsonl'))
  try { cands.push(path.join(require('node:os').tmpdir(), 'handover-gate.jsonl')) } catch (e) { /* 没有 tmp */ }
  for (const c of cands) {
    if (!explicit || c !== explicit) {
      // 非显式路径：只允许写进**已经存在**的目录（.warden 必须是已存在的那个）
      const dir = path.dirname(c)
      let dirOk = false
      try { dirOk = fs.existsSync(dir) } catch (e) { dirOk = false }
      if (!dirOk) continue
    }
    state.logPath = c
    return c
  }
  return ''
}

/* ==========================================================================
 * 七之二、回合号 / 脏账 / 欠账 —— **R43 返工（S1 + S2）新增**
 * ==========================================================================
 *
 * 旧稿两个键都错了，而且是**两种不同的静默**：
 *   · `cur` 键 = sid，只在 turn-stopping 里 delete ⇒ 跳过 turn-stopping 的回合把脏账
 *     **泄漏**到下一个回合（S2：回合 B 什么都没改却被判 clean）；
 *   · `pending` 键 = sid ⇒ 子代理改盘，父会话**完全看不见**（S1：R19 的标准工作方式被绕过）。
 * 现在：`cur` = `sid:turn`（+ 收尾所有更早的桶），`pending` = **工程根**。
 */

/** `sid:turn` —— 两个键拼起来的桶键（`turn` 可能是 -1，表示回合号推不出） */
function curKey(sid, turn) { return sid + ':' + String(turn) }

function bucketFor(state, sid, turn) {
  const k = curKey(sid, turn)
  let b = state.cur.get(k)
  if (!b) { b = { sid: sid, turn: turn, roots: new Map() }; state.cur.set(k, b) }
  return b
}

/** 一个桶里某个工程根的槽（脏清单 + 这个回合有没有更新过交接） */
function rootSlot(bucket, rootKey, root) {
  let s = bucket.roots.get(rootKey)
  if (!s) { s = { root: root || '', dirty: new Map(), handoverTouched: false }; bucket.roots.set(rootKey, s) }
  if (!s.root && root) s.root = root
  return s
}

/**
 * 当前回合号 —— 两个来源，都是**代码**读出来的，**不问模型**：
 *   ① `agent/pre-step` 的 payload —— **官方事件**：`dsh-agent-loop\lib\index.js:894-901`
 *      派发 `{messages, ...position, signal}`，而 `position = {turn, step}`（`:937-940`）；
 *      `agent` 由 `dsh-agent\lib\index.js:209-213` 的 `fused()` 塞进 payload。⇒ **主源**。
 *   ② `agent.phase.turn` / `agent.phase.lastTurn` —— `dsh-agent-loop\lib\index.js:766-769`
 *      定义 phase、`:930` `phase.turn = turn`。⇒ **兜底**（插件在回合中途才挂上时用）。
 * 两个都取不到 ⇒ **-1**，并由调用方记一行失败 `turn-unresolved`（**不许静默**：
 * 回合号推不出会让 S2 的修复退化回旧行为，那必须看得见）。
 */
function turnOf(state, agent, sid) {
  try {
    const rec = state.curTurn.get(sid)
    if (rec && Number.isFinite(rec.turn) && rec.turn >= 0) return rec.turn
  } catch (e) { /* 下一条 */ }
  try {
    const p = agent && agent.phase
    if (p && typeof p === 'object') {
      if (Number.isFinite(p.turn)) return Number(p.turn)
      if (Number.isFinite(p.lastTurn)) return Number(p.lastTurn)
    }
  } catch (e) { /* 取不到 */ }
  return -1
}

/**
 * 0 字节写（`write` 的 `content` 是空串或纯空白）。
 * ⚠ 如实：`dsh-tool-fs\lib\index.js:561` 自己写着"空 `content` 是合法的（它写一个空文件）"——
 *   本闸**只在交接文件这一类目标上**拒它：交接的豁免是为了让"补救动作"可达，
 *   而 0 字节交接**不是补救**，它是把记录毁掉（审查实测：把交接清成 0 字节也能清欠账）。
 * `edit` 判不了（它给的是 old/new 片段）—— 这条如实写在 DESIGN 的"拦不住"里。
 */
function isEmptyHandoverWrite(toolName, args) {
  if (toolName !== 'write') return false
  const v = args && args.content
  if (typeof v !== 'string') return false
  return v.trim().length === 0
}

/**
 * 收尾 `turn <= upTo` 的**所有**桶（不只是当前这一个），返回要发布的回合行。
 * 为什么要"所有"：`:941` reject / abort / `:945` / `:976` 都会**跳过** turn-stopping，
 *   旧桶若只按当前回合收，就会永远留在 map 里 —— 旧稿的静默路就是这条。
 * 每个脏根 ⇒ 写进 `state.pending`（**按工程根**，S1）⇒ 下一次改盘动作被 deny。
 * ⚠ 根推不出的槽（`slot.root === ''`）：照样记"脏"行，但**不建欠账**（没有工程根就没有
 *   "本工程的交接文件"可更新），也不触发 steer —— 如实，不装。
 */
function finalizeUpTo(state, sid, upTo, deps) {
  const rows = []
  const buckets = Array.from(state.cur.values())
    .filter((b) => b.sid === sid)
    .filter((b) => (b.turn < 0 ? upTo >= 0 : b.turn <= upTo))
    .sort((a, b) => (a.turn < b.turn ? -1 : a.turn > b.turn ? 1 : 0))
  for (const b of buckets) {
    state.cur.delete(curKey(b.sid, b.turn))
    if (!b.roots.size) {
      rows.push({ sid: sid, turn: b.turn, ev: 'clean', dirty: 0, handoverTouched: false, paths: [] })
      continue
    }
    for (const [rootKey, slot] of b.roots) {
      const paths = Array.from(slot.dirty.values())
      if (slot.handoverTouched) {
        rows.push({ sid: sid, turn: b.turn, ev: 'clean', dirty: paths.length, handoverTouched: true, paths: paths.slice(0, 12) })
        continue
      }
      if (!paths.length) {
        rows.push({ sid: sid, turn: b.turn, ev: 'clean', dirty: 0, handoverTouched: false, paths: [] })
        continue
      }
      if (slot.root) {
        const prev = state.pending.get(rootKey)
        const merged = (prev && Array.isArray(prev.paths)) ? Array.from(new Set(prev.paths.concat(paths))) : paths
        state.pending.set(rootKey, {
          paths: merged, turn: b.turn, root: slot.root, sid: sid, at: new Date().toISOString(),
        })
      }
      rows.push({
        sid: sid, turn: b.turn, ev: 'dirty', dirty: paths.length, handoverTouched: false,
        paths: paths.slice(0, 12), root: slot.root, rootKey: rootKey,
      })
    }
  }
  return rows
}

/** 把 finalize 出来的回合行发布出去（`steered`/`why` 由调用方给：steer 只在收尾侧做） */
function publishTurnRows(state, rows, steered, why, deps) {
  for (const r of rows) {
    const row = Object.assign({ at: new Date().toISOString() }, r, { steered: steered, why: why })
    pushRing(state.turns, row)
    if (r.ev === 'dirty') logRow(state, Object.assign({}, row, { ev: 'turn-dirty' }), deps)
  }
}

/**
 * 这个工程根**现在**有没有"改了文件却没更新交接"的欠账。两条来源：
 *   ① `state.pending`（**按工程根**）—— 收尾时建立；**跨会话可见**
 *      ⇒ 子代理改盘，父会话的下一次改盘动作也会被拦（S1）。
 *   ② 本会话**更早回合**留下的、还没收尾的脏桶（同 sid、`turn < 当前回合`）
 *      ⇒ turn-stopping 被 reject/abort 跳过时仍然拦得住（S2）。
 * ⚠ 为什么 ② 只扫**同一个 sid**：回合号在会话之间**不可比**（父会话 turn 3、子代理 turn 1
 *   是常态），按根跨会话比大小会误拦正在干活的另一个会话。跨会话那一条由 ①（root 键）负责。
 * ⚠ 残余缺口（如实申报）：子代理的回合**被 reject/abort** 时 ① 不会被建立，
 *   这时只有那个子代理自己的下一次改盘被 ② 拦住 —— 父会话看不见。见 DESIGN 第 11 节。
 */
function debtFor(state, rootKey, sid, turn) {
  const pend = state.pending.get(rootKey)
  if (pend && Array.isArray(pend.paths) && pend.paths.length) return pend
  const paths = []
  let fromTurn = 0
  for (const b of state.cur.values()) {
    if (b.sid !== sid) continue
    if (!(turn >= 0) || !(b.turn < turn)) continue
    const slot = b.roots.get(rootKey)
    if (!slot || slot.handoverTouched) continue
    for (const p of slot.dirty.values()) if (paths.indexOf(p) < 0) paths.push(p)
    if (b.turn > fromTurn) fromTurn = b.turn
  }
  if (!paths.length) return null
  return { paths: paths, turn: fromTurn, root: rootKey, stale: true, at: new Date().toISOString() }
}

/**
 * 工具成功与否 —— **只认 `result.isError !== true`，而且要求 `result` 是个对象**。
 * ★ R43 返工（S5）：旧稿 `!(result && result.isError === true)` 把 `result === undefined`
 *   当成**成功** ⇒ 形状一变就会把一次失败的 read 记成"读过"。现在形状不认识就**不认**，
 *   并记一行失败 `result-shape-unknown`（不许静默）。
 */
function resultIsOk(result) {
  return !!result && typeof result === 'object' && result.isError !== true
}

/* ==========================================================================
 * 八、理由文本（deny 的 reason —— 逐字给可抄的路径 + 三条硬规矩）
 * ========================================================================== */

function readGateReason(o) {
  const lines = [
    '[task-warden R43 读闸] 先别动文件：这个会话**还没有读过本工程的交接文件**。',
    '',
    '  你必须先读的那一份（**逐字可抄**，用 `read` 工具打开它）：',
    '    ' + o.handover,
    '  （它就是这样被认出来的：' + o.how + '；工程根 ' + o.root + ' 由 `' + o.via + '` 判定）',
    '',
    '  「读过」是**机器判**的：只有一次**成功的 `read` 工具调用**、且路径正好是上面这一条，才算数',
    '  （判定读的是 `tools/result` 里 `exec.name==="read"` 且 `result.isError!==true`）。',
    '  **模型自己说「我读过了」不算**（R43 必须③）—— 本条拦截不看任何自述。',
    '',
    '  本条**只拦会改盘的动作**：' + o.toolName + (o.target ? '（`' + o.target + '`）' : '') + '。',
    '  `read` / `glob` / `grep` / `todo_write` **不拦** —— 否则连"读交接"这个动作本身都做不了（死锁）。',
    '',
    '  ⚠ 交接文件本身（上面那一条路径）**永远可写**：写它是补救动作，不会被自己拦死。',
    '  ⚠ `present`（声明交付）**不受读闸管**（它不写盘），但受**写闸**管。',
    '',
    ...(o.agentMissing ? [
      '  ⚠⚠ 另：这一次调用**读不到会话身份**（`exec.agent` 缺席）⇒ 按 **fail-closed** 处理。',
      '     旧稿在这种情况下把读写都退化到同一个 `' + 'anonymous' + '` 桶（一次 read 解锁所有无 agent 调用，S5）',
      '     —— 现在不这么干了：读不到身份的 read **不记"已读"**，并记一行失败 `agent-missing`。',
      '',
    ] : []),
    rulesBlock(),
    '',
    '  补法（两步，就这两步）：',
    '    1) 用 `read` 打开 ' + o.handover,
    '    2) 然后再改文件。',
  ]
  return lines.join('\n')
}

/**
 * ★ R43 返工（S5）：**未读交接 ⇒ 整个 shell 类都拒**（不再只看关键词）。
 * 为什么必须这样：`pwsh -Command "node -e \"fs.writeFileSync(...)\""` 里
 * **一个写关键词都没有** ⇒ 旧稿"既不触发读闸也不触发写闸" ⇒ 能整条绕过 R43 改工程文件。
 * 为什么不会死锁：读交接只需要 `read` 工具（本闸对 `read` 零 IO 放行），
 * 而且 reason 里已经给了**逐字可抄的绝对路径**。
 */
function shellReadGateReason(o) {
  const lines = [
    '[task-warden R43 读闸] 先别动文件：**shell 类调用一律被拒** —— 这个会话还没读过本工程的交接文件。',
    '',
    '  你必须先读的那一份（**逐字可抄**，用 `read` 工具打开它）：',
    '    ' + o.handover,
    '  （它就是这样被认出来的：' + o.how + '；工程根 ' + o.root + ' 由 `' + o.via + '` 判定）',
    '',
    '  这一次是：' + o.toolName + (o.target ? '（`' + o.target + '`）' : '') + '。',
    '  ⚠ 为什么**整个类**都拒、而不是只看命令里的关键词：',
    '     `pwsh -Command "node -e \\"fs.writeFileSync(...)\\""` 里**没有任何写关键词**，',
    '     旧稿因此既不触发读闸、也不触发写闸 ⇒ 能整条绕过 R43 去改工程文件（S5）。',
    '     "认关键词"这条路**证不了没有**（`node script.mjs`、拼出来的路径都认不出来），',
    '     所以未读交接时**不赌关键词**：`pwsh`/`bash`/`sh`/`shell`/`cmd`/`run`/`exec` 全拒。',
    '',
    '  ⚠ 读交接**不需要** shell：只要 `read` 工具，路径就在上面。所以这里没有死锁。',
    '  ⚠ 读**过**之后：只读命令照旧放行；有欠账时整个类也会拒（否则同一句 `node -e` 又能绕过写闸）。',
    '',
    rulesBlock(),
    '',
    '  补法（两步，就这两步）：',
    '    1) 用 `read` 打开 ' + o.handover,
    '    2) 然后再跑 shell。',
  ]
  return lines.join('\n')
}

/**
 * ★ R43 返工（(4)）：0 字节写交接 —— **拒**。
 * 旧稿把"写交接"当唯一解锁方式，却没看**写了什么** ⇒ 把交接清成 0 字节也能清欠账。
 * 交接的豁免是为了让**补救动作**可达；0 字节交接不是补救，是把记录毁掉。
 */
function emptyHandoverReason(o) {
  const lines = [
    '[task-warden R43] 这次 `write` 被拒：**0 字节写交接文件**。',
    '',
    '  目标：' + o.target,
    '  （它就是这样被认出来的：' + o.how + '）',
    '',
    '  ⚠ 交接文件的豁免是为了让"补救动作"可达 —— 而 **0 字节不是补救**，',
    '    它是把记录毁掉。实测（审查）：把交接清成 0 字节**也能清欠账**，所以这里拒掉。',
    '  ⚠ 如实：`dsh-tool-fs\\lib\\index.js:561` 自己写着"空 content 是合法的（写一个空文件）"——',
    '     本闸**只在交接文件这一类目标上**收窄它，别的文件不受影响。',
    '',
    '  补法：把内容写上（至少三样：**现在做到哪 / 下一步做什么 / 这一轮动过哪些文件**）。',
    '',
    rulesBlock(),
  ]
  return lines.join('\n')
}

function missingHandoverReason(o) {
  const lines = [
    '[task-warden R43 读闸] 先别动文件：**这个工程里没有交接文件**。',
    '',
    '  ⚠ 这跟"没读到"是**两件事**：我在工程根下面按两个名字都找过了，**一个都没有**。',
    '    工程根：' + o.root + '（由 `' + o.via + '` 判定）',
    '    ① ' + HANDOVER_BASE + '（首选）',
    '    ② ' + HANDOVER_PREFIX + '*' + HANDOVER_SUFFIX + '（取最新的一份）',
    '',
    '  本闸对"交接文件不存在"的选择是 **fail-closed：拒绝 + 记一行失败**（不是放行）——',
    '  自检里把这条钉住了（`handover-missing`）。',
    '',
    '  补法（逐字可抄）：用 `write` 建这一份，然后才能改别的文件：',
    '    ' + o.expect,
    '  内容至少写清三样：**现在做到哪 / 下一步做什么 / 这一轮动过哪些文件**。',
    '  （写这一份**不会被拦** —— 工程根下的 `交接*.md` 是两条闸的共同豁免项。）',
    '',
    rulesBlock(),
  ]
  return lines.join('\n')
}

function writeGateReason(o) {
  const head = o.pend.paths.slice(0, 12).map((p) => '     · ' + p).join('\n')
  const more = o.pend.paths.length > 12 ? '\n     …（还有 ' + (o.pend.paths.length - 12) + ' 个）' : ''
  const lines = [
    '[task-warden R43 写闸] 先别动文件：**上一轮改了 ' + o.pend.paths.length + ' 个文件，却没有更新交接**。',
    '',
    '  上一轮（turn ' + o.pend.turn + '）改过、但交接里没有体现的路径：',
    head + more,
    '',
    '  ⚠ 口径（R43 返工）：欠账**按工程根**记 —— 子代理改的盘、更早回合没清掉的脏账，',
    '     都会在这里拦；所以这里的"上一轮"可能是**另一个会话**（子代理）或**更早的回合**',
    '     （turn-stopping 被 reject/abort 跳过时）。' + (o.pend.stale ? '（这一条是**陈旧脏账**：本会话更早回合留下的）' : ''),
    '',
    '  你必须更新的那一份交接（**逐字可抄**）：',
    '    ' + o.handover,
    '  （它就是这样被认出来的：' + o.how + '）',
    '',
    '  本条**拦的是"下一次要改盘的动作"**：' + o.toolName + (o.target ? '（`' + o.target + '`）' : '') + '。',
    '  ⚠ 这一条**不依赖任何事件语义**，因此它拦得住 —— 而 `agent/turn-stopping` 拦不住：',
    '    它是 `serial`（`dsh-agent-loop\\lib\\index.js:967`，返回值被丢掉），**没有 deny 这条路**。',
    '    收尾那一侧靠的是 `:973` 的 `if (turnEnds && this.inbox.nextStep.length === 0) break;`',
    '    —— 往 next-step 塞一条（`agent.steer()`），回合的 break 就不成立，**回合真的结束不了**。',
    '  ⚠ 有欠账时 **shell 类一律拒**（连 `git status` 这种只读命令也拒）：',
    '     否则 `pwsh -Command "node -e \\"fs.writeFileSync(...)\\""` 这类**没有关键词**的写动作会绕过写闸。',
    '',
    '  补法（一步）：用 `write`/`edit` 把这一轮"做了什么、下一步、动过哪些文件"写进上面那份交接。',
    '  ⚠ 如果你**还没读过**这一份交接：先 `read` 它，再更新它 —— 否则你写的是没读过的东西。',
    '  写它**不会被拦**（工程根下的 `交接*.md` 是两条闸的共同豁免项）—— 但要**认那一份**：',
    '  写无关的 `交接-别的名字.md` **不清**欠账，**0 字节写**会被直接拒。',
    '',
    rulesBlock(),
  ]
  return lines.join('\n')
}

function steerText(o) {
  const head = o.paths.slice(0, 12).map((p) => '    · ' + p).join('\n')
  const more = o.paths.length > 12 ? '\n    …（还有 ' + (o.paths.length - 12) + ' 个）' : ''
  const whose = (o.turn === undefined || o.turn === null || o.turn < 0) ? '' : ('（回合 turn ' + o.turn + '）')
  return [
    '[task-warden R43 写闸] 本工程有 ' + o.paths.length + ' 个文件改过' + whose + '，却**没有更新交接** —— 回合不能在这里结束。',
    '',
    '  改过但没进交接的路径：',
    head + more,
    '',
    '  交接文件（逐字可抄）：',
    '    ' + o.handover,
    '',
    '  补法：用 `write`/`edit` 把"做了什么、下一步、动过哪些文件"写进上面那份交接（**要有内容**，0 字节会被拒）。',
    '',
    '  ⚠ 这不是"提醒"：本回合的收尾条件是 `dsh-agent-loop\\lib\\index.js:973`',
    '    `if (turnEnds && this.inbox.nextStep.length === 0) break;`',
    '    我把这条消息塞进 `next-step` ⇒ **回合真的不会结束**。',
    '    你若不更新交接，下一次要改盘的动作会被 `tools/pre-execute` 直接 deny。',
  ].join('\n')
}

function deny(reason) { return { kind: 'deny', reason: reason } }
function allow() { return { kind: 'allow' } }

/* ==========================================================================
 * 八之二、★ 自动写交接草稿（AUTO-DRAFT）—— **本文件唯一主动写盘的功能**
 * ==========================================================================
 *
 * 需求原文、开关用法、文件名选择的代价、四道安全阀的完整说明，全在文件头
 * `一、常量与判据表` 里那个长注释块（`HANDOVER_AUTO_MARK` 上面）。这里只写**实现**。
 *
 * 三个 verdict（`writeAutoDraft` 的返回值，**全部只有这几种**）：
 *   { wrote:true,  path, bytes, dry:false }  —— 真的写了（或 dry 模式下算出来了）
 *   { wrote:false, why:'…' }                 —— 没写，**why 逐字标明是哪一道阀拦的**
 *   why 的取值（自检逐条钉住）：
 *     'auto-off' 开关没开 | 'no-dirty' 本轮零改动 | 'no-next' 没有显式声明有后续
 *     | 'no-root' 工程根推不出 | 'bad-date' 日期拼不出来（不猜今天的日期）
 *     | 'foreign-exists' 已存在同名文件且**没有** AUTO 标记 ⇒ 绝不覆盖
 *     | 'already-current' 已存在且是 AUTO 草稿，内容逐字相同 ⇒ 不重复写
 *     | 'write-failed:…' 写盘抛了（**只记一行失败，绝不影响工具调用**）
 *
 * ⚠ 这个函数**绝不抛**（fail-open 硬约束：看守自己坏了不许让工具调用失败）。
 */

/* ------------------------------------------------------------ 加载即留痕（★本文件是 6 份的「同款」母本） */
/**
 * ★★ **加载即留痕**（需求 R9 的后半句：「装完能验证真的加载了」）。
 *
 * 要解决的问题：5 个插件装上之后，**公开用户没有任何可机械验证的手段**证明它们真的跑起来了。
 *   现状是"看效果"—— 而看守类插件在正常情况下**本就不该有任何可见效果**（fail-open、不欠账就一个字不说）
 *   ⇒ 「它没加载」与「它加载了但今天没话说」在用户眼里**长得一模一样**（这正是本项目反复防的
 *   「没查到 ≠ 查了没问题」：分不开，就等于没有证据）。
 *
 * 所以：**被宿主加载并 apply() 时，往同一个文件里写自己那一条**。
 *
 * ── 统一落点（6 个插件写**同一份文件**，不许各写各的）────────────────────────
 *   `<落点目录>/PLUGIN-LOADED.json` —— 一个 JSON 文档，`plugins` 是 map，key = 插件 id：
 *   { "schema":1, "updatedAt":"…", "plugins": { "context-dedup": {…}, "role-voices": {…}, … } }
 *   为什么是"一个 map"而不是 6 个文件：用户**一条命令**就能看到"哪几个加载了"；
 *   6 个文件就得 `dir` 六次再自己数，等于把"能验证"退回给用户。
 *
 * ── 落点目录**运行期派生**（公开包硬要求：**一个作者机路径都不许有**）──────────
 *   多级兜底，顺序即优先级（前一个写得进去就用前一个，**第一个能写的胜出**）：
 *     ① `$WARDEN_PLUGIN_LEDGER`   —— 显式指定目录（测试 / 非标准安装位置）
 *     ② `$DSH_HOME/plugin-ledger` —— `DSH_HOME` 是 DSH 自己注入的环境变量，**换用户就跟着变**
 *     ③ `<os.homedir()>/.dsh/plugin-ledger` —— 退到 DSH 的默认家目录
 *        （`DSH_HOME` 没设时 DSH 本身就是用这个默认值；与 `plugin-io.js` 的
 *         `resolveWardenMjs` / `warden-watch.js` 的 `resolveWardenMjs` **同款三级口径**，
 *         只是把"读"换成"写"，并多一级 `tmpdir`）
 *     ④ `<os.tmpdir()>/dsh-plugin-ledger` —— 上两级都写不进去时兜底
 *        （`warden-watch.js:106-108` 实测记过：前几个候选哪一个能写取决于进程沙箱根，
 *          临时区两边都写得进去）
 *   一处作者机路径都没有：**每一段都是 `os`/`process.env` 现推的**，
 *   推不出来就**往下一级退**，退到底还不行就**静默放弃**（见下）。
 *
 * ── 为什么选这一族目录（而不是工程根 `.warden/`）────────────────────────────
 *   · 「装完能不能用」是**机器级事实**，不是某个工程的事实 —— 同一个插件会被好几个工程用到；
 *     写进工程根 ⇒ 换个工程就得再查一遍，且"没写"分不清是没加载还是这个工程没跑过。
 *   · 插件沙箱实测**写不进任意路径**（`warden-watch.js:106-108` 那条），
 *     而 `$DSH_HOME` / 家目录 / 临时区是**插件进程真写得进去**的地方。
 *   · 全部落在**用户自己的家目录/临时区**，不进任何仓库 ⇒ 不会被误推送到公开仓库。
 *
 * ── 隐私（硬约束）───────────────────────────────────────────────────────
 *   **只写 4 样**：插件 id / 版本串 / ISO 时间戳 / pid。
 *   ⚠ **不写宿主实例 id**（旧稿写"5 样"、含 Cordis 的 `ctx.id`）：见下面 `hostId` 那条 ——
 *   读 `ctx.id` 会破坏「对 `ctx` 只有 on/effect」的访问面约束，**本包一律不传**。
 *   **绝不写**：工程路径、会话 id、用户名、环境变量值、任何用户内容。
 *   ⚠ 那个 `via` 值是**回落第几级**的标签，形如 `3·home` —— 是**来源标签、不是路径**，
 *     它本身不含家目录字面量（路径只在内存里，不落盘）。
 *
 * ── fail-open（硬约束）──────────────────────────────────────────────────
 *   写失败/目录不可写 ⇒ **静默降级、绝不抛**。这 6 个插件都是看守，
 *   **自己坏了不许让用户的操作失败**，也不许因为"留痕失败"就在屏幕上吵闹。
 *
 * ── 不许在热路径上加同步 IO ─────────────────────────────────────────────
 *   只在 `apply()` 里调**一次**。**不要**每次工具调用都写 —— 那是每秒几十次的
 *   `mkdirSync`+`readFileSync`+`writeFileSync`，会把看守变成性能问题。
 *   （`context-dedup` 自己在 `apply()` 里另有一条 `flushStatus()`，那是**另一个文件、
 *     另一个用途**，本函数与它无关，也不共用任何状态。）
 *
 * ⚠⚠ **同款实现**：`context-dedup.js` / `role-voices.js` / `handover-gate.js` / `branch-guard.js` /
 *   `report-spill.js` / `warden-watch.js` —— **这 6 份里的本段逐字节相同**（含本注释；
 *   不点名"母本是哪一个"，因为点名表写死后在本文件里会把自己也列进"另外几份"，读着自相矛盾）。
 *   可复算：`node _ledger_samecheck.mjs` 应打印 `distinct implementations: 1`，
 *   函数代码段 sha256 前缀 `4489b155…`（**注释段自己不报 sha**：报了就会因为写进 sha 而自我失效）。
 *   ⚠ 因文件而异的**不在这里**，在**调用点**：用 `name` 还是写死 id、用 `VERSION` 还是复用 `PLUGIN_VERSION`。
 *   **为什么复制 6 份而不是抽一个公共模块**：`warden-watch.js:54-57` 已经写明这个坑 ——
 *   `plugin-io.js` 顶层直接干活并 `process.exit`，**不是可以安全引入的纯函数模块**；
 *   引一个公共文件还会多出"装上去了但那个文件没随包走"的新静默失败面（本包**已经**因为漏发
 *   `plugin-io.js` 踩过一次，见 `warden-watch.js:27-29`）。
 *   ⇒ 宁可 6 份逐字复制，也不新增一个可缺席的依赖 —— 但**口径必须只有一套**：
 *     改这里的任何一行，**另外 5 份都要跟着改**（注释首行点名"与谁同款"就是为这个）。
 *
 * @param {string} pluginId 这个插件自己的 id（与 `name` 同一个字面量，**不是**会话 id）
 * @param {string} version  这个插件自己的版本串
 * @param {*}      hostId   宿主注入的插件实例 id（Cordis 的 `ctx.id`），没有就不写这个键。
 *   ⚠ **本包一律不传它**（6 个调用点都不传）：读 `ctx.id` 会在 Proxy 上留一次 `GET(id)`，
 *   与「对 `ctx` 的调用**只有** `ctx.on` 与 `ctx.effect`」那条硬契约冲突（`handover-gate.js:40`）。
 *   这个形参**保留**是为了公共实现段 6 份逐字相同、且将来宿主若改用别的方式提供实例 id 时不必改签名。
 */
function markPluginLoaded(pluginId, version, hostId) {
  try {
    const osx = require('os')
    const pathx = require('path')
    const fsx = require('fs')

    /* ── ① 派生落点目录（多级兜底；**一个作者机路径都没有**） ── */
    const cands = []
    if (process.env.WARDEN_PLUGIN_LEDGER) {
      cands.push({ dir: String(process.env.WARDEN_PLUGIN_LEDGER), src: 'env:WARDEN_PLUGIN_LEDGER' })
    }
    if (process.env.DSH_HOME) {
      cands.push({ dir: pathx.join(String(process.env.DSH_HOME), 'plugin-ledger'), src: 'DSH_HOME' })
    }
    try { cands.push({ dir: pathx.join(osx.homedir(), '.dsh', 'plugin-ledger'), src: 'home' }) } catch (e) { /* 取不到家目录就退下一级 */ }
    try { cands.push({ dir: pathx.join(osx.tmpdir(), 'dsh-plugin-ledger'), src: 'tmpdir' }) } catch (e) { /* 连临时区都没有就只剩前几级 */ }

    const FILE = 'PLUGIN-LOADED.json'
    const now = new Date().toISOString()
    /* ⚠ 只记这几样；`pid` 用来区分"这次启动是哪个进程加载的"（重启后 pid 变、at 变） */
    const mine = { id: String(pluginId), version: String(version), at: now, pid: process.pid }
    /* 宿主给的实例 id：**有才写**（没有就整个键都不出现，不写 null 噪音） */
    try { if (hostId !== undefined && hostId !== null && String(hostId) !== '') mine.hostId = String(hostId) } catch (e) { /* 算了 */ }

    for (let i = 0; i < cands.length; i++) {
      const c = cands[i]
      try {
        fsx.mkdirSync(c.dir, { recursive: true })
        const p = pathx.join(c.dir, FILE)

        /* ── ② 读旧文档（**读不动就当空文档**：读失败绝不许变成写失败） ── */
        let doc = null
        try {
          const parsed = JSON.parse(fsx.readFileSync(p, 'utf8'))
          /* 只有"真的是个普通对象"才复用；数组/字符串/数字都当坏档重建 */
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed
        } catch (e) { doc = null }
        if (doc === null) doc = {}
        /* `plugins` 是放各插件记录的 map；顶层其他键（schema/更新时间）原样保留 */
        if (!doc.plugins || typeof doc.plugins !== 'object' || Array.isArray(doc.plugins)) doc.plugins = {}

        doc.schema = 1
        doc.updatedAt = now
        doc.plugins[String(pluginId)] = mine

        /* ── ③ 原子写：先写 `.tmp` 再 `renameSync` ──
         *   为什么：6 个插件**几乎同时** apply（同一次 compose 的 6 条 insert），
         *   直接 `writeFileSync` 有互相读到"写了一半"的窗口 ⇒ 可能整个 map 被截断。
         *   rename 在同一卷上是原子的 ⇒ 读者永远读到"完整的上一版或完整的新版"。
         *   ⚠ 这里**不跨进程加锁**：跨进程锁要建锁文件，锁文件自己就是新的静默失败面
         *   （进程崩了就永久锁死）。实测这个窗口的后果是"某一条留痕丢了"，
         *   而**丢了就是没记录** —— 正是我们要的诚实降级：不会伪造"加载了"。
         *   （调用点用 `markPluginLoadedWithRetry` **再读一次**、必要时重写一轮来收敛。） */
        const tmp = p + '.' + process.pid + '.tmp'
        fsx.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
        fsx.renameSync(tmp, p)
        return { ok: true, path: p, via: (i + 1) + '·' + c.src }
      } catch (e) { /* 这一级不可写 ⇒ 换下一级；**绝不抛** */ }
    }
    return { ok: false, path: null, via: null }
  } catch (e) {
    /* 连 require/os 都炸了 —— 那更不能影响主功能 */
    return { ok: false, path: null, via: null }
  }
}

/**
 * 调用点的**收敛重试**：6 个插件几乎同时 apply，有可能互相覆盖（见上面 ③ 的说明）。
 * 这里只补一件事：**写完再读一次，自己那条不在就再写一轮**（最多 2 轮）。
 * 目的不是"保证万无一失"，而是把"同时加载 6 个"这个常见情形的漏记压到实测为零；
 * 仍然失败就**静默算了**（漏记 = 没记录，不伪造"加载了"）。
 * 与 `markPluginLoaded` 一样：**绝不抛**，也**只在 apply() 里调用一次**。
 */
function markPluginLoadedWithRetry(pluginId, version, hostId) {
  for (let round = 0; round < 2; round++) {
    const r = markPluginLoaded(pluginId, version, hostId)
    if (!r.ok) return r
    try {
      const doc = JSON.parse(require('fs').readFileSync(r.path, 'utf8'))
      if (doc && doc.plugins && doc.plugins[String(pluginId)]) return r
    } catch (e) { /* 读不动就再来一轮 */ }
  }
  return markPluginLoaded(pluginId, version, hostId)
}

/** 本地日期 `YYYY-MM-DD`（草稿文件名里的那一天）。**不猜**：拼不出来就返回 `''` ⇒ 调用方放弃 */
function localDateKey(d) {
  try {
    const x = d || new Date()
    const y = x.getFullYear()
    const m = x.getMonth() + 1
    const dy = x.getDate()
    if (!(y >= 1970 && y <= 9999) || !(m >= 1 && m <= 12) || !(dy >= 1 && dy <= 31)) return ''
    return String(y) + '-' + ('0' + m).slice(-2) + '-' + ('0' + dy).slice(-2)
  } catch (e) { return '' }
}

/**
 * 自动草稿的文件名：`交接-YYYY-MM-DD.md`。
 * ⚠ 它**故意**落在 `isHandoverName()` 认的那一族名字里（后果见文件头那一节，逐条列了）：
 *   ① 它因此**是**一份真交接（能被 read、能消写闸欠账、能解除 deny）；
 *   ② 它会参与"最新那一份"的选举（跨天时可能盖过用户昨天手写的那一份）；
 *   ③ 它**不是** `交接.md`（不抢用户的首选名）。
 */
function autoDraftName(dateKey) { return HANDOVER_AUTO_PREFIX + dateKey + HANDOVER_SUFFIX }

/**
 * 这份文件**是不是插件自己写的**（首行逐字 `<!-- AUTO-ONLY -->`）。
 * ⚠ 读不出来（不存在 / 权限 / 不是文件）⇒ **false**（= "不是我的"）⇒ 调用方**不写**。
 *   这是 fail-closed 的方向，也是安全阀 (1) 的全部实现。
 */
function hasAutoMark(p, deps) {
  const { fs } = io0(deps)
  try {
    if (!fs.existsSync(p)) return false
    const st = fs.statSync(p)
    if (st && typeof st.isFile === 'function' && !st.isFile()) return false
    const txt = String(fs.readFileSync(p, 'utf8'))
    return txt.split(/\r?\n/, 1)[0].trim() === HANDOVER_AUTO_MARK
  } catch (e) { return false }
}

/**
 * 精确 UTF-8 字节数（草稿行里要报 `字节数`）。
 * `Buffer.byteLength` 在**真 fs** 下一定有；喂假 fs 时退回 `utf8Bytes` 手算。
 * ⚠ 为什么不用 `String.length`：中文一个字 1 个 `length` 但 3 个字节 ——
 *   报"字节数"却给字符数，就是**换了个口径还不说**。
 */
function utf8ByteLength(s) {
  try { return Buffer.byteLength(String(s), 'utf8') } catch (e) { return utf8Bytes(String(s)) }
}

/**
 * 本轮的 record（R# / status）—— 从 `.warden/ROUNDS.jsonl` 读**最后一条**。
 * ⚠ **只读，绝不写**；读不出来 ⇒ 返回 `''`，草稿里那一行就写"（读不到）"。
 * ⚠ 只取最后一条**能解析**的行：末尾有半行（进程被杀）时不至于让整份草稿没有 record。
 */
function lastRoundOf(root, deps) {
  const { fs, path } = io0(deps)
  let p = ''
  try { p = path.join(root, '.warden', 'ROUNDS.jsonl') } catch (e) { return '' }
  let txt = ''
  try {
    if (!fs.existsSync(p)) return ''
    txt = String(fs.readFileSync(p, 'utf8'))
  } catch (e) { return '' }
  const lines = txt.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l) continue
    let o = null
    try { o = JSON.parse(l) } catch (e) { continue }
    if (!o || typeof o !== 'object') continue
    const req = (o.req === undefined || o.req === null) ? '' : String(o.req)
    const st = (o.status === undefined || o.status === null) ? '' : String(o.status)
    if (!req && !st) continue
    return (req || '?') + ' / ' + (st || '?')
  }
  return ''
}

/**
 * ★ 安全阀 (2) 的**判据**：草稿里"本轮改动的文件"到底该列哪些。
 *
 * 收窄规则（**逐条都要能说清为什么**）：
 *   ① **只留工程根内的**（`pathKey` 前缀比较）—— 工程根外的改动**不是这个工程的交接内容**；
 *   ② **排除工程根下一级的 `.warden` 与 `.dsh`**（`AUTO_DRAFT_EXCLUDE_DIRS`）——
 *      那些是**账本/会话**自己的目录，把它们当"本轮改动"写进交接是噪声
 *      （用户要的是"任务做完了、下一步是什么"，不是"我又往账本里记了多少行"）；
 *   ③ 不是绝对路径的**照原样保留**（`write` 的 `file_path` 可能是相对路径 / shell 摘要）——
 *      **不猜**它落在哪，猜错了比不写更坏；
 *   ④ 去重、排序、**原样路径**（不做 `normalize` 之外的改写）。
 *
 * ⇒ 返回 `{ paths, dropped }`：`dropped` 是"被 ①② 排除掉几条"，
 *   它会出现在日志与 dry 输出里 —— **排除必须看得见**，不许静默丢。
 */
function draftPaths(root, dirty, deps) {
  const { path } = io0(deps)
  const seen = new Map()
  let dropped = 0
  const rootKey = pathKey(root)
  const exParts = AUTO_DRAFT_EXCLUDE_DIRS.map((d) => pathKey(d))
  for (const raw of (dirty || [])) {
    const s = String(raw === undefined || raw === null ? '' : raw)
    if (!s.trim()) continue
    let abs = ''
    try { abs = path.isAbsolute(s) ? path.normalize(s) : '' } catch (e) { abs = '' }
    if (abs) {
      const k = pathKey(abs)
      if (!(k === rootKey || k.indexOf(rootKey + '/') === 0)) { dropped += 1; continue }
      const rel = k.slice(rootKey.length + 1)
      const parts = rel.split('/')
      if (parts.length >= 2 && exParts.indexOf(parts[0]) >= 0) { dropped += 1; continue }
      if (!seen.has(k)) seen.set(k, abs)
      continue
    }
    const k = pathKey('?' + s)
    if (!seen.has(k)) seen.set(k, s)
  }
  const paths = Array.from(seen.values()).sort()
  return { paths: paths, dropped: dropped }
}

/**
 * 拼草稿正文。**只写机器算得出的东西**（用户要求），一个字的散文都不写：
 *   首行标记 / 第二行"不要手改" / `生成: true` / `生成者:` / `时间戳` / `工程根` /
 *   改动文件数与逐个路径 / 本轮 record / 下一步来源 / 复跑命令 / 正文首段那句警告。
 * ⚠ `下一步` 那一行**一定是显式声明的那句原话**（`next`），不加工、不改写、不补句号。
 */
function buildAutoDraft(o) {
  const L = []
  L.push(HANDOVER_AUTO_MARK)
  L.push(HANDOVER_AUTO_WARN)
  L.push('')
  L.push('生成: true')
  L.push('生成者: handover-gate@' + PLUGIN_VERSION)
  L.push('时间戳: ' + String(o.at))
  L.push('工程根: ' + String(o.root))
  L.push('改动文件数: ' + o.paths.length + (o.dropped ? ('（另有 ' + o.dropped + ' 条在工程根外/在 .warden、.dsh 下，已排除）') : ''))
  for (const p of o.paths) L.push('  - ' + p)
  L.push('本轮 record: ' + (o.round || '（读不到 .warden/ROUNDS.jsonl 的最后一条）'))
  L.push('下一步来源: 显式声明 ' + o.nextSrc)
  L.push('下一步: ' + o.next)
  if (o.rerun) L.push('复跑命令: ' + o.rerun)
  L.push('')
  L.push(HANDOVER_AUTO_WARN)
  L.push('')
  L.push('（本文件由 `handover-gate` 插件的自动草稿功能写出；它不是人写的交接，')
  L.push('  内容**只有机器算得出来的字段** —— 现在做到哪 / 下一步 / 这一轮动过哪些文件。）')
  return L.join('\n') + '\n'
}

/**
 * ★ 复跑命令 —— **只认显式声明**，绝不猜。
 *   两个来源，优先取前者：
 *     ① config `rerun`（字符串）—— 显式给的就是它；
 *     ② `WARDEN_HANDOVER_RERUN` 环境变量（**每次现读**）。
 *   都没有 ⇒ `''` ⇒ **草稿里那一行直接不出现**（写"复跑命令: （无）"是把噪声当内容，
 *   而写一条**猜的**命令更坏：接手的人会照着跑一遍错的）。
 */
function rerunCommand(opts) {
  try {
    const o = (opts && typeof opts === 'object') ? opts : {}
    if (typeof o.rerun === 'string' && o.rerun.trim()) return o.rerun.trim()
    const v = String(envNow('WARDEN_HANDOVER_RERUN', '')).trim()
    return v
  } catch (e) { return '' }
}

/**
 * ★★ 自动写草稿的**唯一入口**。
 *
 * `o = { auto, dry, next, rerun, root, dirty, sid, turn, logPath }`
 * 返回 `{wrote, why?, path?, bytes?, dry?, next?, dropped?, paths?}`。
 *
 * 判定顺序（**就是文件头那四道安全阀**，一条不跳）：
 *   0. `auto !== true`            ⇒ `auto-off`   （默认值；不声不响，不记失败行——
 *         "没开这个功能"不是故障，是用户的正常选择）
 *   1. `!root`                    ⇒ `no-root`
 *   2. `dry` 模式**照常判定**，只是最后不写（安全阀 (4) 的实现钉在这里：
 *        dry 走的是**同一条链**，不是另一条 —— 否则"dry 跑过"证明不了"真跑会写"）
 *   3. 日期拼不出                  ⇒ `bad-date`（**不猜今天的日期**）
 *   4. 已存在同名文件：
 *        · 没有 AUTO 标记           ⇒ `foreign-exists`  ★ 安全阀 (1)，绝不覆盖
 *        · 是 AUTO 草稿且内容逐字相同 ⇒ `already-current`
 *   5. `!next`                    ⇒ `no-next`    ★ 安全阀 (3)
 *   6. 过滤后**零改动**             ⇒ `no-dirty`   ★ 安全阀 (2)
 *   7. dry ⇒ 只返回算出来的字节，**不写盘**（`{wrote:false, why:'dry', …}`，调用方记日志）
 *   8. 写（`writeFileSync`）⇒ `{wrote:true}`
 *
 * ⚠ 为什么 (5)(6) 排在 (4) 之后：覆盖判定**必须最先**做（哪怕这一轮什么都不写，
 *   "这个路径是别人的/不是我的"这个事实也要在日志里出现一次，否则以后撞名时查不出原因）。
 * ⚠ 顺序对**副作用**没有影响（前面几条都不写盘），但对**日志里为什么没写**有影响
 *   ⇒ 自检里逐条钉住"哪一道阀先拦的"。
 * ⚠ 这个函数**绝不抛**（外面还包了一层 try/catch；写盘失败 ⇒ 记一行失败，不改判定结果）。
 */
function writeAutoDraft(o, state, deps) {
  const src = (o && typeof o === 'object') ? o : {}
  try {
    // 0) 开关（默认 off）—— 没开就是没开，不记失败行（这不是故障）
    if (src.auto !== true) return { wrote: false, why: 'auto-off' }
    const root = String(src.root || '')
    if (!root) return { wrote: false, why: 'no-root' }
    const dry = src.dry === true

    const { fs, path } = io0(deps)
    const dateKey = localDateKey(src.now)
    if (!dateKey) return { wrote: false, why: 'bad-date' }
    const target = path.join(root, autoDraftName(dateKey))

    // 4) ★ 安全阀 (1)：别人的文件**一个字节都不许动**（判据是"有没有 AUTO 标记"）
    let exists = false
    try { exists = fs.existsSync(target) } catch (e) { exists = false }
    let prevText = ''
    if (exists) {
      const mine = hasAutoMark(target, deps)
      if (!mine) return { wrote: false, why: 'foreign-exists', path: target }
      try { prevText = String(fs.readFileSync(target, 'utf8')) } catch (e) { prevText = '' }
    }

    // 5) ★ 安全阀 (3)：**没有显式声明"有后续" ⇒ 不写**
    const next = String(src.next || '').trim()
    if (!next) return { wrote: false, why: 'no-next', path: target }

    // 6) ★ 安全阀 (2)：**本回合零改动 ⇒ 不写**
    const filt = draftPaths(root, src.dirty, deps)
    if (!filt.paths.length) return { wrote: false, why: 'no-dirty', path: target, dropped: filt.dropped }

    const text = buildAutoDraft({
      at: new Date().toISOString(),
      root: root,
      paths: filt.paths,
      dropped: filt.dropped,
      round: lastRoundOf(root, deps),
      next: next,
      nextSrc: src.nextSrc || 'WARDEN_HANDOVER_NEXT',
      rerun: src.rerun || '',
    })
    if (exists && prevText === text) return { wrote: false, why: 'already-current', path: target }

    const bytes = utf8ByteLength(text)
    if (dry) return { wrote: false, why: 'dry', path: target, bytes: bytes, next: next, paths: filt.paths, dropped: filt.dropped }

    // 8) 写。⚠ 这里**只可能是**：新建，或覆盖**一份首行带 AUTO 标记的**文件。
    try {
      fs.writeFileSync(target, text, 'utf8')
    } catch (e) {
      return { wrote: false, why: 'write-failed:' + String((e && e.message) || e).slice(0, 120), path: target }
    }
    return { wrote: true, path: target, bytes: bytes, dry: false, next: next, paths: filt.paths, dropped: filt.dropped }
  } catch (e) {
    return { wrote: false, why: 'threw:' + String((e && e.message) || e).slice(0, 120) }
  }
}

/**
 * 写草稿**之后**把"这一份就是最新交接"这件事反映到 `state.read`（否则刚放行的动作
 * 下一句就被读闸再拦一次，白折腾）。
 * ⚠ 这一步**只动内存 state**，不写盘、不改任何判定；`freshenAutoSettings` 是它的另一半
 *   （把这份路径从 `state.pending` 欠账里去掉）。
 */
function markAutoDraftRead(state, sid, p) {
  try {
    let set = state.read.get(sid)
    if (!set) { set = new Set(); state.read.set(sid, set) }
    set.add(pathKey(p))
  } catch (e) { /* 记不上就下次再读一遍，不影响结果 */ }
}

/**
 * 草稿写完之后，清掉**这个工程根**的欠账（若有）。
 * 为什么必须有这一步：`onToolResult` 只在**工具调用**（`write` 工具 / 带写关键词的 shell）
 * 里清欠账；自动草稿走的是 `fs.writeFileSync`，**没有任何事件会来记账**
 * ⇒ 不清的话：草稿写好、文件放行，但 `state.pending` 里那条欠账还在
 * ⇒ **下一次改盘立刻又被写闸拒**，而且这辈子都清不掉（本轮的 `slot.handoverTouched`
 * 也已经在 finalize 时用过了）。那样这个功能就是**半成品**，所以这一步不是可选的。
 * ⚠ 只清**本工程根**那一条键（`pathKey(root)`），别的工程的欠账一律不动。
 */
function freshenAutoSettings(state, root, sid, targetPath, deps) {
  try {
    if (!root) return
    const rk = pathKey(root)
    if (state.pending.delete(rk)) {
      pushRing(state.turns, { at: new Date().toISOString(), sid: sid, ev: 'handover-updated', path: targetPath, why: 'auto-draft' })
      logRow(state, { at: new Date().toISOString(), ev: 'write-gate-cleared', sid: sid, handover: targetPath, why: 'auto-draft' }, deps)
    }
  } catch (e) { /* 清不掉也不影响这次放行 */ }
}

/** 把一次自动草稿的结果记进 rings + 事件行（**写了/没写都要看得见**） */
function logAutoDraft(state, row, deps) {
  pushRing(state.turns, row)
  if (row.wrote || row.dry) {
    logRow(state, Object.assign({}, row, { at: new Date().toISOString(), ev: 'auto-draft' }), deps)
    return
  }
  // 没写：只记"**被哪一道阀拦的**"，而且**不记失败行**——默认 off / 没声明有后续
  // 是**正常状态**，把它们记成失败行会把"不许静默失效"的那本账灌满噪声。
  logRow(state, Object.assign({}, row, { at: new Date().toISOString(), ev: 'auto-draft-skip' }), deps)
}

/**
 * ★ "本轮改动过的文件"——**读闸这一刻**能拿到的那个清单。
 *
 * ⚠ 时序是这里最容易搞错的东西，必须写清（否则会写出一个**永远空**的清单）：
 *   `tools/result` 是**工具成功之后**才 emit 的 ⇒ 本次调用想写的那个文件
 *   **还不在这回合的脏清单里**（它还没写成）。所以"本轮改动"= **更早回合留下的**：
 *     ① `state.pending.get(rootKey)`：**按工程根**记的欠账（含子代理改的盘，S1）；
 *     ② 本会话 `turn < 当前回合` 还没收尾的脏桶（S2：turn-stopping 被跳过时）。
 *   这正是 `debtFor()` 的口径 —— 所以这里**直接复用它**，不另写一份（第二份真相源）。
 *   两条都空 ⇒ 清单空 ⇒ 自动写**不触发**（安全阀 (2)）⇒ 照旧 deny。
 *
 * 这与用户的需求**对得上**：自动草稿是给"这一轮任务做完了"写的，
 * 而"做完了"在账本里就是"**改了东西、收尾时欠了一笔交接**"那个状态。
 * ⚠ 直接跑 dry 试跑时（还没有任何历史）清单会是空的 ⇒ 那是**如实**的：
 *   dry 就是"现在这一秒真的写会写什么"，不是"假如我改过三个文件会写什么"。
 */
function draftDirtyNow(state, rootKey, sid, turn) {
  try {
    const d = debtFor(state, rootKey, sid, turn)
    return (d && Array.isArray(d.paths)) ? d.paths : []
  } catch (e) { return [] }
}

/* ==========================================================================
 * 九、判定主体：读闸 + 写闸（纯函数；`state` 由 install 创建）
 * ========================================================================== */

/**
 * `input = { toolName, toolArgs, sessionId, turn?, agentMissing?, cwd?, cwds? }`
 * 返回 `{kind:'allow'}` 或 `{kind:'deny', reason}`。
 *
 * 判定顺序（**R43 返工后重排**，每一步都有理由）：
 *   0. 既不是改盘工具、也不是 shell、也不是 `present` ⇒ **零 IO 放行**
 *      （`read`/`read_image`/`glob`/`grep`/`todo_write`/`skill`/`subagent` 全在这里出去）
 *   1. 工程根推不出 ⇒ 记一行失败 + 放行（"推不出"没有参照物；见 DESIGN.md 的取舍）
 *   2. 目标是工程根下的 `交接*.md` ⇒ **豁免**（两条闸的共同豁免；否则补救动作被自己拦死 = 死锁）
 *      2b. 但 **0 字节写** ⇒ deny（(4)：0 字节不是补救，它把记录毁掉）
 *   3. 写闸：**这个工程根**有欠账（含子代理的、含更早回合没清掉的）⇒ deny
 *      —— 对改盘工具、**所有 shell**、`present` 都生效
 *   4. `present`（声明交付）⇒ allow（S4：它不写盘，所以不受读闸管，但受写闸管）
 *   5. shell 且**没读过这一份**交接 ⇒ deny（S5：**整个类**，不赌关键词）
 *   6. 交接文件不存在 ⇒ deny + 记一行失败（fail-closed）
 *      6.b ★ 新增：**自动写草稿**（开关默认 off + 本轮显式声明有后续 + 本轮有改动
 *          + 目标不是别人的文件 + 非 dry）⇒ **先写、写完重新解析、真的在盘上才 allow**；
 *          任何一条不成立 ⇒ **原样走下面的 deny**（默认行为一字不改）。见那一节的注释。
 *   7. 没读过这一份 ⇒ deny
 *   8. 其余 ⇒ allow
 */
function decideWrite(state, input, deps, opts) {
  const { path } = io0(deps)
  state.stats.preExecute += 1
  const toolName = String((input && input.toolName) || '')
  const args = input && input.toolArgs
  const sid = String((input && input.sessionId) || 'anonymous')
  const turn = numOr(input && input.turn, -1)
  const agentMissing = !!(input && input.agentMissing)
  const isMod = MODIFY_TOOLS.indexOf(toolName) >= 0
  const isShell = SHELL_TOOLS.indexOf(toolName) >= 0
  const isPresent = PRESENT_TOOLS.indexOf(toolName) >= 0

  // 0) 零 IO 放行（**死锁负控就靠这一条**：`read` 自己必须过）
  if (!isMod && !isShell && !isPresent) { state.stats.allowed += 1; return allow() }

  const bases = collectBases(input)
  const raw = targetPathOf(toolName, args)
  const t = resolveTarget(raw, bases, deps)
  const abs = t.abs
  const baseDir = t.baseDir
  const pr = t.pr
  if (!pr.root) {
    fail(state, 'root-unresolved', {
      tool: toolName, base: baseDir, via: pr.via,
      why: '一路往上既没有 .git 也没有 .warden ⇒ 认不出这是哪个工程、也就没有"本工程的交接文件"可读',
      action: 'allow（记一行失败，不静默）',
    }, deps)
    state.stats.allowed += 1
    return allow()
  }
  if (pr.via === 'ancestor-warden') {
    fail(state, 'root-via-ancestor-warden', {
      tool: toolName, root: pr.root, base: baseDir,
      why: '这一层没有 .git；根是"向上最近的装着 .warden 的那一层"推出来的（warden.mjs 里这条叫静默路）',
      action: 'allow（记一行失败，让"落在谁的账本上"可查）',
    }, deps)
  }
  resolveLogPath(state, pr.root, opts, deps)
  const rootKey = pathKey(pr.root)

  // 2) 交接文件本身：永远可写（两条闸的共同豁免）—— 但 0 字节不算"写交接"
  if (abs && isHandoverTarget(abs, pr.root, deps)) {
    if (isEmptyHandoverWrite(toolName, args)) {
      const h0 = resolveHandover(pr.root, deps)
      const reason = emptyHandoverReason({
        target: abs, how: h0.ok ? h0.how : '（按 `交接.md` / `交接-*.md` 认出来的）',
      })
      state.stats.denied += 1
      pushRing(state.denies, { at: new Date().toISOString(), sid: sid, gate: 'empty-handover', tool: toolName, target: abs })
      logRow(state, { at: new Date().toISOString(), ev: 'deny', gate: 'empty-handover', sid: sid, tool: toolName, target: abs }, deps)
      return deny(reason)
    }
    state.stats.allowed += 1
    return allow()
  }

  const h = resolveHandover(pr.root, deps)
  const handoverPath = h.ok ? h.path : h.expect
  const how = h.ok ? h.how : '（现在还没有，应该建在这一条上）'

  // 3) 写闸：**按工程根**的欠账（S1 跨会话 + S2 陈旧脏账）
  const pend = debtFor(state, rootKey, sid, turn)
  if (pend) {
    const reason = writeGateReason({ pend: pend, handover: handoverPath, how: how, toolName: toolName, target: abs || raw })
    state.stats.denied += 1
    pushRing(state.denies, { at: new Date().toISOString(), sid: sid, gate: 'write-gate', tool: toolName, target: abs || raw, dirty: pend.paths.length })
    logRow(state, { at: new Date().toISOString(), ev: 'deny', gate: 'write-gate', sid: sid, tool: toolName, target: abs || raw, dirty: pend.paths.length, stale: !!pend.stale }, deps)
    return deny(reason)
  }

  // 4) `present`（声明交付）：不写盘 ⇒ 不受读闸管；欠账那一步已经在上面拦过了（S4）
  if (isPresent) { state.stats.allowed += 1; return allow() }

  const readSet = state.read.get(sid)
  const readOk = !!(h.ok && readSet && readSet.has(pathKey(h.path)))

  // 5) shell：**未读这一份 ⇒ 整个类拒**（S5）
  if (isShell) {
    if (!readOk) {
      const reason = h.ok
        ? shellReadGateReason({ handover: h.path, how: h.how, root: pr.root, via: pr.via, toolName: toolName, target: abs || raw })
        : missingHandoverReason({ root: pr.root, via: pr.via, expect: h.expect })
      state.stats.denied += 1
      pushRing(state.denies, { at: new Date().toISOString(), sid: sid, gate: 'read-gate-shell', tool: toolName, target: abs || raw, handover: h.ok ? h.path : '' })
      logRow(state, { at: new Date().toISOString(), ev: 'deny', gate: 'read-gate-shell', sid: sid, tool: toolName, target: abs || raw }, deps)
      return deny(reason)
    }
    state.stats.allowed += 1
    return allow()
  }

  // 6) 交接文件不存在 ⇒ fail-closed + 记一行失败
  if (!h.ok) {
    fail(state, 'handover-missing', {
      tool: toolName, root: pr.root, expect: h.expect, via: pr.via,
      why: '按 `交接.md` 与 `交接-*.md` 两个名字在工程根下都没找到交接文件',
      action: 'deny（fail-closed；自检把这条钉住了）',
    }, deps)

    /**
     * ★★ 6.b 自动写交接草稿 —— **fail-closed 的"先付款后放行"**
     * ------------------------------------------------------------------
     * 顺序与理由（用户明确要求把顺序说清）：
     *   **先写草稿（同步 `writeFileSync`，写完才往下走）⇒ 重新解析 ⇒ 放行**，
     *   而不是"先放行、回头再写"。三个阶段各自都必须是这一步之前就成立的：
     *     · 写盘抛了 / 哪一道阀没开 ⇒ `w.wrote !== true` ⇒ **照旧 deny**（默认行为不变）；
     *     · 写完但**重新解析**还是找不到那一份（不可能，除非盘坏了）⇒ 也 **deny**；
     *     · 两关都过 ⇒ 这一份**此刻真的在盘上**，读闸拦它的理由就没了 ⇒ **allow**。
     *   为什么不能"先放行、回头再写"：`tools/pre-execute` 是**同步判定链**，
     *   返回值一旦是 allow，这个回合后面**没有任何钩子**能撤销它 ⇒ 那就是 fail-open。
     * ⚠ 这一条**不改默认行为**：开关没开（默认 off）或本轮没声明"有后续"
     *   ⇒ `w.why` 是 `auto-off`/`no-next`/`no-dirty`/`foreign-exists`… ⇒ **原样 deny**，
     *   理由文本一字不改（自检里"交接不存在 ⇒ deny"那条断言仍然钉得住）。
     * ⚠ 这里**也**要求"本轮有改动"（安全阀 (2) 在 `writeAutoDraft` 里）：
     *   零改动的一轮**不会**被自动草稿放行 —— 不放行就必须 deny，方向没有松。
     */
    const w = writeAutoDraft({
      auto: autoEnabled(opts),
      dry: autoDry(opts),
      next: nextDeclaration(opts),
      rerun: rerunCommand(opts),
      root: pr.root,
      dirty: draftDirtyNow(state, rootKey, sid, turn),
      nextSrc: 'WARDEN_HANDOVER_NEXT',
      sid: sid,
    }, state, deps)
    logAutoDraft(state, w.wrote
      ? { sid: sid, turn: turn, wrote: true, dry: false, path: w.path, bytes: w.bytes, files: w.paths.length, dropped: w.dropped, gate: 'read-gate-missing' }
      : { sid: sid, turn: turn, wrote: false, dry: w.why === 'dry', path: w.path, why: w.why, bytes: w.bytes, dropped: w.dropped, gate: 'read-gate-missing' }, deps)

    if (w.wrote === true) {
      // 重新解析：这一份必须**真的**被 `resolveHandover` 认成"本工程的交接"
      // （它按名字+日期选举，所以这里不是"假设它认得"，是**问一次**）
      const h2 = resolveHandover(pr.root, deps)
      if (h2.ok) {
        markAutoDraftRead(state, sid, h2.path)
        freshenAutoSettings(state, pr.root, sid, h2.path, deps)
        state.stats.allowed += 1
        // 记一行"放行"，理由与 deny 那条**对称**，便于事后查"是谁放的行"
        pushRing(state.denies, { at: new Date().toISOString(), sid: sid, gate: 'auto-draft-allow', tool: toolName, target: abs || raw, handover: h2.path, bytes: w.bytes })
        logRow(state, { at: new Date().toISOString(), ev: 'auto-draft-allow', sid: sid, turn: turn, tool: toolName, target: abs || raw, handover: h2.path, bytes: w.bytes }, deps)
        return allow()
      }
      // 荒谬分支，但**不许静默**：写了草稿却解析不出它 ⇒ 记一行失败，按 deny 走
      fail(state, 'auto-draft-not-resolved', {
        tool: toolName, root: pr.root, wrote: w.path,
        why: '草稿写成功了，但 `resolveHandover` 在写完之后的重新解析里没有把它认成"本工程的交接"',
        action: 'deny（fail-closed；默认行为不变）',
      }, deps)
    }

    state.stats.denied += 1
    pushRing(state.denies, { at: new Date().toISOString(), sid: sid, gate: 'read-gate-missing', tool: toolName, root: pr.root })
    logRow(state, { at: new Date().toISOString(), ev: 'deny', gate: 'read-gate-missing', sid: sid, tool: toolName, root: pr.root, expect: h.expect }, deps)
    return deny(missingHandoverReason({ root: pr.root, via: pr.via, expect: h.expect }))
  }

  // 7) 读闸：这一份交接**这个会话**成功读过吗
  if (!readOk) {
    const reason = readGateReason({
      handover: h.path, how: h.how, root: pr.root, via: pr.via,
      toolName: toolName, target: abs || raw, agentMissing: agentMissing,
    })
    state.stats.denied += 1
    pushRing(state.denies, { at: new Date().toISOString(), sid: sid, gate: 'read-gate', tool: toolName, target: abs || raw, handover: h.path })
    logRow(state, { at: new Date().toISOString(), ev: 'deny', gate: 'read-gate', sid: sid, tool: toolName, target: abs || raw, handover: h.path }, deps)
    return deny(reason)
  }

  state.stats.allowed += 1
  return allow()
}

/* ==========================================================================
 * 十、观测：tools/result（"读过"与"改过"的**唯一**事实来源）
 * ========================================================================== */

/**
 * `tools/result` 是 **emit**（`dsh-tools\lib\index.js:3290-3301`，返回值没人看、抛错只 logger.warn）
 * ⇒ 这里**只记账，绝不影响结果**。而且它天生不会因为本监听器坏了而让工具调用失败。
 *
 * ⚠ 形状（如实）：
 *   · `exec.name` / `exec.arguments`（deep-frozen 的 JSON 副本）
 *   · `exec.agent` —— 由 `dsh-tools\lib\index.js:3043`（`...agent !== void 0 ? { agent } : {}`）放上去
 *   · `result.isError` —— 成功与否**只认这一个字段**（`:3127-3138` 的 deny 也是 materialize 成 isError）
 *
 * ★ R43 返工（S1/S2/S5）改了三处记账口径：
 *   · 脏账落进 **`sid:turn` 桶**（不再是 sid），并按**工程根**分槽 ⇒ 子代理的盘父会话也看得见；
 *   · `result` 形状不认识（undefined / 非对象）**不再当成功**（S5）；
 *   · `exec.agent` 缺席 ⇒ **不记"已读"、不记"改过"** + 一行失败（S5：不再退化到共享 `anonymous` 桶）。
 */
function onToolResult(state, exec, result, deps, opts) {
  try {
    const toolName = String((exec && exec.name) || '')
    const args = exec && exec.arguments
    const shapeOk = !!result && typeof result === 'object'
    if (!shapeOk) {
      fail(state, 'result-shape-unknown', {
        tool: toolName,
        why: '`tools/result` 的 `result` 不是对象（旧稿 `!(result && result.isError===true)` 会把它当**成功**）',
        action: '不认这次结果：不记"已读"、不记"改过"',
      }, deps)
    }
    const ok = resultIsOk(result)
    const agent = exec && exec.agent
    if (!agent) {
      fail(state, 'agent-missing', {
        tool: toolName,
        why: '`exec.agent` 缺席 ⇒ 认不出是哪个会话；旧稿会让所有无 agent 的调用共用 `anonymous` 桶（一次 read 解锁全部，S5）',
        action: '不记账 + 在 `tools/pre-execute` 一侧 fail-closed（读闸因此不会解开）',
      }, deps)
      return
    }
    const sid = sessionOf(agent)
    const bases = collectBases({ cwd: cwdOf(agent), cwds: [] })

    // ── 读：只有"成功的 read + 路径命中交接文件"才算读过（R43 必须③）
    if (toolName === 'read') {
      if (!ok) return
      const raw = args && typeof args.file_path === 'string' ? args.file_path : ''
      if (!raw) return
      const cands = candidateAbs(raw, bases, deps)
      for (const abs of cands) {
        let n = ''
        try { n = nodePath.basename(abs) } catch (e) { continue }
        if (!isHandoverName(n)) continue
        const pr = findProjectRootVia(nodePath.dirname(abs), deps)
        if (!pr.root) continue
        const h = resolveHandover(pr.root, deps)
        const isResolved = !!(h.ok && pathKey(h.path) === pathKey(abs))
        // ★ 只把**这条路径本身**记为"已读"：换了一份新日期的交接 ⇒ 必须重读（R40 ② 的"最新那份"）
        let set = state.read.get(sid)
        if (!set) { set = new Set(); state.read.set(sid, set) }
        set.add(pathKey(abs))
        pushRing(state.reads, { at: new Date().toISOString(), sid: sid, path: abs, isResolved: isResolved, root: pr.root })
        logRow(state, { at: new Date().toISOString(), ev: 'handover-read', sid: sid, path: abs, isResolved: isResolved, root: pr.root }, deps)
        return
      }
      return
    }

    // ── 写：记账（本回合脏清单 / 交接是否被更新过）
    //    ⚠ `isModifying` 对 shell 仍然是**关键词启发式** ⇒ 认不出来的写（`node script.mjs`）
    //      **不会被记成脏**。这是如实标注的已知洞（DESIGN "拦不住"），不许说成"防住了 shell"。
    if (!isModifying(toolName, args)) return
    if (!ok) return
    const raw = targetPathOf(toolName, args)
    const t = resolveTarget(raw, bases, deps)
    const abs = t.abs
    const pr = t.pr
    const turn = turnOf(state, agent, sid)
    if (turn < 0) {
      fail(state, 'turn-unresolved', {
        tool: toolName, sid: sid,
        why: '既没收到 `agent/pre-step` 的 turn，`agent.phase.turn` 也读不到 ⇒ 脏账只能落到 `sid:-1` 一个桶里（S2 的修复会退化回旧行为）',
        action: '继续记账（fail-open），但**记一行失败**让这件事看得见',
      }, deps)
    }
    // ★ 回合边界：把**更早回合**的桶收尾成欠账（turn-stopping 被 reject/abort 跳过时也收）
    publishTurnRows(state, finalizeUpTo(state, sid, turn - 1, deps), false, 'turn-boundary', deps)

    const b = bucketFor(state, sid, turn)
    const rootKey = pr.root ? pathKey(pr.root) : ('?' + sid)
    const slot = rootSlot(b, rootKey, pr.root || '')

    if (abs && pr.root && isHandoverTarget(abs, pr.root, deps)) {
      // ★ R43 返工（(4)）：**只有解析出来的那一份**才算"更新了交接"
      const h = resolveHandover(pr.root, deps)
      const resolvedPath = h.ok ? h.path : h.expect
      if (pathKey(abs) !== pathKey(resolvedPath)) {
        pushRing(state.turns, { at: new Date().toISOString(), sid: sid, turn: turn, ev: 'handover-other', path: abs, resolved: resolvedPath })
        logRow(state, { at: new Date().toISOString(), ev: 'handover-other-not-updating', sid: sid, turn: turn, path: abs, resolved: resolvedPath }, deps)
        return
      }
      if (isEmptyHandoverWrite(toolName, args)) {
        // `decideWrite` 已经拒了；这里再兜一层（事件顺序不同 / 有人绕开 pre-execute 时）
        pushRing(state.turns, { at: new Date().toISOString(), sid: sid, turn: turn, ev: 'handover-empty', path: abs })
        logRow(state, { at: new Date().toISOString(), ev: 'handover-empty-write-ignored', sid: sid, turn: turn, path: abs }, deps)
        return
      }
      slot.handoverTouched = true
      // ★ 写闸的**唯一**解锁方式：把**那一份**交接真的有内容地写下去
      if (state.pending.delete(rootKey)) {
        logRow(state, { at: new Date().toISOString(), ev: 'write-gate-cleared', sid: sid, turn: turn, handover: abs }, deps)
      }
      pushRing(state.turns, { at: new Date().toISOString(), sid: sid, turn: turn, ev: 'handover-updated', path: abs })
      return
    }
    const display = abs || (raw ? String(raw) : shellDigest(toolName, args))
    slot.dirty.set(pathKey(display) || display, display)
  } catch (e) {
    // 记账坏了**绝不许**影响工具结果（emit 本身也会兜，这里再兜一层）
    try { fail(state, 'result-handler-threw', { err: String((e && e.message) || e) }, deps) } catch (e2) { /* 算了 */ }
  }
}

/* ==========================================================================
 * 十一、写闸的收尾侧：agent/turn-stopping
 * ========================================================================== */

/**
 * ⚠⚠ **这个监听器绝对不许抛。**
 *   实测形状：`dsh-agent-loop\lib\index.js:967` 是 `await this.dispatch.serial(...)`，
 *   外面 `:976 catch (error) { ... turnEnds = {kind:'error'} }` ——
 *   **在 turn-stopping 里抛一次，这一回合会被标成 error**。
 *   所以整个函数体包一层 try/catch，坏了自己记一行失败、立刻返回。
 *
 * 这里做两件事：
 *   ① 收尾 `turn <= 当前` 的**所有**记账桶 ⇒ "改了 N 个文件却没更新交接"变成**按工程根**的欠账
 *      ⇒ 下一次改盘动作被 deny（**无条件、不会成环**；也拦得住子代理改的盘）
 *   ② 往 next-step 塞一条 ⇒ **回合结束不了**（`agent.steer()`；`:973` 的 break 不成立）
 *      带硬上限防环（每回合 1 次、每会话 2 次）—— 上限**落进程内存**，
 *      为什么不上账本：上限是**防环用的短命计数**，重启后清零只会让上限更松（fail-open 方向），
 *      而 I60 事故（warden-watch 的 steer 把新窗口卡成 43 次工具调用）的根因是
 *      "红是结构性的、修不掉"，本闸的 steer 是**可执行的一步**（写交接），且上限极小。
 */
function onTurnStopping(state, payload, deps, opts) {
  try {
    const agent = payload && payload.agent
    const sid = sessionOf(agent)
    const turn = numOr(payload && payload.turn, turnOf(state, agent, sid))

    // ★ 收尾 turn <= 当前 的**所有**桶（不只是当前这一个）：
    //   `:941` reject / abort / `:945` / `:976` 会**跳过** turn-stopping，
    //   旧桶只能在这里（或下一次写盘时的回合边界）被收掉 —— 这就是 S2 的修法。
    const rows = finalizeUpTo(state, sid, turn, deps)
    const dirtyRows = rows.filter((r) => r.ev === 'dirty')
    if (!dirtyRows.length) {
      publishTurnRows(state, rows, false, 'clean', deps)
      return
    }

    // 交接文件的路径（steer 文本里要给逐字可抄的那一条）—— 优先用脏账里记下的**工程根**
    let handoverPath = ''
    let how = ''
    let root = dirtyRows[0].root || ''
    if (!root) {
      try {
        const bases = collectBases({ cwd: cwdOf(agent), cwds: [] })
        const pr = findProjectRootVia(bases[0] || '', deps)
        if (pr.root) root = pr.root
      } catch (e) { /* 推不出就留空，steer 文本仍给得出补法 */ }
    }
    if (root) {
      try {
        const h = resolveHandover(root, deps)
        handoverPath = h.ok ? h.path : h.expect
        how = h.ok ? h.how : '（现在还没有，应该建在这一条上）'
      } catch (e) { /* 下一条 */ }
    }
    if (!handoverPath) {
      try {
        handoverPath = nodePath.join(root || (collectBases({ cwd: cwdOf(agent), cwds: [] })[0] || ''), HANDOVER_BASE)
      } catch (e) { handoverPath = HANDOVER_BASE }
    }
    const dirtyPaths = []
    for (const r of dirtyRows) for (const p of (r.paths || [])) if (dirtyPaths.indexOf(p) < 0) dirtyPaths.push(p)

    // 阻止收尾（**代码**：让 :973 的 break 不成立）
    // ★ R43 返工（(6)）：逃生阀**每次现读**环境变量（旧稿在 install 时读 ⇒ 改它要重启 DSH）
    let steered = false
    let why = ''
    const turnKey = curKey(sid, turn)
    if (!steerEnabled(opts)) why = 'steer-off'
    else if (!agent || typeof agent.steer !== 'function') why = 'no-agent-or-steer'
    else if (numOr(state.steersTurn.get(turnKey), 0) >= steerMaxPerTurn(opts)) why = 'turn-cap'
    else if (numOr(state.steers.get(sid), 0) >= steerMaxPerSession(opts)) why = 'session-cap'
    else {
      try {
        agent.steer(makeSteerMessage(steerText({ paths: dirtyPaths, handover: handoverPath, turn: dirtyRows[0].turn })))
        steered = true
        state.stats.steered += 1
        state.steersTurn.set(turnKey, numOr(state.steersTurn.get(turnKey), 0) + 1)
        state.steers.set(sid, numOr(state.steers.get(sid), 0) + 1)
      } catch (e) {
        why = 'steer-threw:' + String((e && e.message) || e).slice(0, 120)
      }
    }

    publishTurnRows(state, rows, steered, why, deps)
    logRow(state, {
      at: new Date().toISOString(), ev: 'turn-steer', sid: sid, turn: turn, dirty: dirtyPaths.length,
      handover: handoverPath, how: how, steered: steered, why: why,
    }, deps)
  } catch (e) {
    // ★ 绝不许抛（抛了这回合会被标成 error）
    try { fail(state, 'turn-stopping-threw', { err: String((e && e.message) || e) }, deps) } catch (e2) { /* 算了 */ }
  }
}

/**
 * steer 的消息形状。优先用 DSH 自己的 `createUserMessage`（与 warden-watch 同法），
 * 拿不到就退回一个普通对象 —— 两条路都包 try/catch，坏了自己记失败、绝不外抛。
 *
 * ★★ **会话格式 v4：`source.kind` 必须是"产出者自有"的身份，不许是 `"plugin"`。**
 *   判据逐字在装机包里（`resources\app.asar` → `lib/types/message-sources.js`）：
 *     `function source(message){ const value = message["source"];
 *        if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string"
 *            || value["kind"].length === 0 || value["kind"] === "plugin")
 *          throw new SessionFormatError("format v4 message requires a producer-owned source kind"); }`
 *   而 v3 → v4 迁移对**第三方插件**的改写，就是 `producerKind()` 的兜底分支
 *     `return \`plugin:${plugin}\`;` ⇒ `{kind:'plugin', plugin:'handover-gate'}` 变成
 *     `{kind:'plugin:handover-gate'}`（`rewritePluginSource` 在只有 2 个键时**只留 `kind`**、
 *     把 `plugin` 字段丢掉）。**这里必须与迁移产物同名**，否则同一个插件在新老日志里会有两个名字。
 *
 *   ⚠ 为什么这条不是"小毛病"：`agent.steer()` 落进 `agent/inbox/spliced`，而 v4 的
 *     `assertV4SourceRowAdmission()` **明确校验这一族的 `inserted[].source`** ——
 *     旧写法会在写盘那一步抛 `SessionFormatError`，**整条消息一个字都不落盘、整个回合以 error 收尾**。
 *     （旧稿 `{ kind: 'plugin', plugin: 'handover-gate' }` 实测在 v4 会话上必然被拒。）
 */
let _createUserMessage
let _createUserMessageResolved = false
function resolveCreateUserMessage() {
  if (_createUserMessageResolved) return _createUserMessage
  _createUserMessageResolved = true
  const tries = []
  try { tries.push(require('@deepseek-ai/dsh-llm')) } catch (e) { /* 下一条 */ }
  try {
    const { createRequire } = require('node:module')
    const entry = process.argv[1]
    if (entry) tries.push(createRequire(entry)('@deepseek-ai/dsh-llm'))
  } catch (e) { /* 下一条 */ }
  for (const m of tries) {
    if (m && typeof m.createUserMessage === 'function') { _createUserMessage = m.createUserMessage; break }
  }
  return _createUserMessage
}

function makeSteerMessage(text) {
  // ★ v4：产出者自有的 kind（见上面那段注释的判据）。**不许**写回 `{kind:'plugin', plugin:…}`。
  const source = { kind: 'plugin:handover-gate' }
  const mk = resolveCreateUserMessage()
  if (typeof mk === 'function') {
    try { return mk({ content: [{ type: 'text', text: text }], source: source }) } catch (e) { /* 退回下面 */ }
  }
  return { role: 'user', content: [{ type: 'text', text: text }], source: source }
}

/* ==========================================================================
 * 十二、装载 / 拆卸
 * ========================================================================== */

function envNow(k, d) {
  try { const v = process.env[k]; return (v === undefined || v === '') ? d : v } catch (e) { return d }
}

/**
 * 选项归一。
 * ★ R43 返工（(6)）：**逃生阀改成每次现读环境变量**。
 *   旧稿在 install 时就把 `WARDEN_HANDOVER_STEER` 读成 `opts.steer` ⇒
 *   **改它要重启 DSH，不是热开关**（而文件头还把它写成"一行关掉"）。
 *   现在：`opts.steer` 只在**显式传了**的时候才是硬覆盖（自检要这个口子），
 *   否则 `steerEnabled()` **每次都去读** `process.env`。
 *   `steerMaxPerTurn` / `steerMaxPerSession` 同理（显式 > 现读环境变量 > 默认值）。
 */
function normalizeOpts(options) {
  const o = (options && typeof options === 'object') ? options : {}
  return {
    fs: o.fs || null,
    path: o.path || null,
    /** steer（阻止收尾）默认**开**；`WARDEN_HANDOVER_STEER=off` **每次现读**（热开关，不必重启） */
    steer: o.steer !== undefined ? !!o.steer : (String(envNow('WARDEN_HANDOVER_STEER', 'on')).toLowerCase() !== 'off'),
    /** 显式覆盖（自检用）；`null` = 没显式给 ⇒ 每次现读环境变量 */
    steerExplicit: o.steer !== undefined ? !!o.steer : null,
    steerMaxPerTurn: numOr(o.steerMaxPerTurn !== undefined ? o.steerMaxPerTurn : envNow('WARDEN_HANDOVER_STEER_MAX_TURN', 1), 1),
    steerMaxPerSession: numOr(o.steerMaxPerSession !== undefined ? o.steerMaxPerSession : envNow('WARDEN_HANDOVER_STEER_MAX_SESSION', 2), 2),
    steerMaxPerTurnExplicit: o.steerMaxPerTurn !== undefined ? numOr(o.steerMaxPerTurn, 1) : null,
    steerMaxPerSessionExplicit: o.steerMaxPerSession !== undefined ? numOr(o.steerMaxPerSession, 2) : null,
    logPath: o.logPath || envNow('WARDEN_HANDOVER_LOG', ''),

    /* ── ★ 自动写交接草稿（见文件头"自动写交接草稿"那一节） ──
     * 与 steer 同一个规矩：**显式 config > 每次现读环境变量 > 默认**。
     * 这里在 `normalizeOpts` 里存的只是"**显式覆盖**"和"**当时的**快照"，
     * 真正的判定在 `autoEnabled()` / `nextDeclaration()` —— **每次都现读**。
     * 所以 `setx WARDEN_HANDOVER_AUTO on` 之后**不必重启 DSH**（这是必须的：
     * 插件的 `apply()` 只在装载时跑一次，装的时候就把值冻住 = 老毛病 (6)）。
     */
    auto: o.auto !== undefined ? !!o.auto : null,
    autoExplicit: o.auto !== undefined ? !!o.auto : undefined,
    /** 显式声明"这活还有后续"；`null`/`undefined` = 没显式给 ⇒ 每次现读 `WARDEN_HANDOVER_NEXT` */
    next: (typeof o.next === 'string') ? o.next : null,
    nextExplicit: (typeof o.next === 'string') ? o.next : undefined,
    /** `dry:true` ⇒ 只打印不写（自检/试跑用） */
    dry: o.dry !== undefined ? !!o.dry : false,
    dryExplicit: o.dry !== undefined ? !!o.dry : undefined,
  }
}

/* ★ 为什么 `*Explicit` 的"没显式给"必须是 `undefined` 而不是 `null`：
 *   `install()` 会把 `normalizeOpts(options)` 的**返回值**（一个每次新建的对象）交给
 *   `decideWrite`；若"没给"写成 `null`，那个对象上就**永远有一个 `null` 值**，
 *   `autoEnabled()` 的"`!== null && !== undefined` 才算显式"就会把**省略**判成**显式给 null**
 *   ⇒ `process.env` **一次都不会被读** ⇒ 热开关（"改 env 不必重启"）直接失效。
 *   实测抓到过：`writeAutoDraft` 收到的一直是 `auto:false`（= `!!null`），日志里永远 `auto-off`。
 *   ⇒ 只有 **undefined** 才表示"这个键不存在"，那是这一族判定（与 `steerEnabled` 同法）成立的前提。
 *   ⚠ `steerExplicit` 上面写的是 `null`，但它在 `normalizeOpts` 里被赋成 `!!o.steer` 或 `null`
 *     且 `steerEnabled` 同时判 `!== null` —— 同样有这个毛病，**不在本单范围内，没有动它**
 *     （本单只改自动草稿这一块；如实写在交回报告里）。 */

/** steer 到底开不开 —— **每次现读**（`opts.steer` 显式给了就以它为准） */
function steerEnabled(opts) {
  if (opts && opts.steerExplicit !== null && opts.steerExplicit !== undefined) return !!opts.steerExplicit
  return String(envNow('WARDEN_HANDOVER_STEER', 'on')).toLowerCase() !== 'off'
}
function steerMaxPerTurn(opts) {
  if (opts && opts.steerMaxPerTurnExplicit !== null && opts.steerMaxPerTurnExplicit !== undefined) return opts.steerMaxPerTurnExplicit
  return numOr(envNow('WARDEN_HANDOVER_STEER_MAX_TURN', 1), 1)
}
function steerMaxPerSession(opts) {
  if (opts && opts.steerMaxPerSessionExplicit !== null && opts.steerMaxPerSessionExplicit !== undefined) return opts.steerMaxPerSessionExplicit
  return numOr(envNow('WARDEN_HANDOVER_STEER_MAX_SESSION', 2), 2)
}

/* ──────────────────────────────────────────────────────────────────────────
 * ★ 自动写交接草稿：开关与声明的**现读**入口
 * ──────────────────────────────────────────────────────────────────────────
 * 三个函数全部**每次现读**，理由与 `steerEnabled` 逐字相同（老毛病 (6)：
 * 在 install 时读 ⇒ 改环境变量要重启 DSH，那就不是热开关）：
 *   `autoEnabled()`      —— `WARDEN_HANDOVER_AUTO`（默认 **off**）
 *   `nextDeclaration()`  —— `WARDEN_HANDOVER_NEXT`（**这就是"显式声明有后续"**）
 *   `autoDry()`          —— config `dry`（默认 false；没有环境变量口子，故意的：
 *                            dry 是**试跑**用的，不该被一个全局 env 悄悄打开）
 *
 * ⚠ 解析口径（**必须是这一个**，自检逐条钉住）：
 *   · 只有逐字 `off` / `false` / `0` / `no`（去空白、不分大小写）算**关**；
 *     只有逐字 `on` / `true` / `1` / `yes` 算**开**；
 *   · **别的任何值一律按默认（off）** —— 不许"只要非空就是开"。
 *     为什么：一个拼错的 `WARDEN_HANDOVER_AUTO=yes!` 若被当成"开"，
 *     就等于**用户从没开过的开关自己开了**，而这个开关会写盘 ⇒ 必须往关的方向失败。
 */
function autoEnabled(opts) {
  if (opts && opts.autoExplicit !== null && opts.autoExplicit !== undefined) return !!opts.autoExplicit
  const v = String(envNow('WARDEN_HANDOVER_AUTO', 'off')).trim().toLowerCase()
  return v === 'on' || v === 'true' || v === '1' || v === 'yes'
}

/**
 * "这活还有后续"的**显式声明**。返回去掉首尾空白的字符串；**没声明 ⇒ `''`**。
 * ⚠ 只有空白的字符串**不算声明**（`'   '` ⇒ `''`）—— 见常量表的用法。
 * ⚠ 它不是"从账本猜出来的"：账本里没有可靠信号（见常量表的实测），**这里只认人说的话**。
 */
function nextDeclaration(opts) {
  if (opts && typeof opts.nextExplicit === 'string') return opts.nextExplicit.trim()
  return String(envNow('WARDEN_HANDOVER_NEXT', '')).trim()
}

/** `dry:true` ⇒ 只打印不写（config 显式给了就以它为准；没有环境变量口子） */
function autoDry(opts) {
  if (opts && opts.dryExplicit !== null && opts.dryExplicit !== undefined) return !!opts.dryExplicit
  return false
}
/**
 * 把**四条**监听挂到 ctx 上，返回 `state`（自检/诊断要读的东西都在里面）。
 *
 * ★ **对 `ctx` 的调用只有 `ctx.on`**（本函数里），`apply()` 里另加一次 `ctx.effect`。
 *   没有 `ctx.systemPrompt` / `ctx.context` / `ctx.provide` / `ctx.set` / 任何消息通道注册 ——
 *   自检里有一条把这份调用清单列出来逐条断言。
 *
 * ★ 四条监听各自被 `ctx.on` 注册成当前 fiber 的 effect（`cordis\lib\index.js:335-345`），
 *   fiber 卸载时**自动**摘掉；`state.disposers` 再兜一层，供 `ctx.effect` 与自检显式调用。
 *
 * ★ R43 返工新增第 ④ 条 `agent/pre-step`：**只为拿回合号**（S2 的修法要靠 `sid:turn` 分桶）。
 *   它是 waterfall ⇒ 必须 `return next()`，而且**绝不许抛**（抛了会把这一步打断）。
 */
function install(ctx, options) {
  const opts = normalizeOpts(options)
  const deps = { fs: opts.fs || nodeFs, path: opts.path || nodePath }
  const state = createState()
  const disposers = []

  // ① 读闸 + 写闸（都是 deny）
  disposers.push(ctx.on('tools/pre-execute', function (exec, next) {
    let d = null
    try {
      const agent = exec && exec.agent
      const sid = sessionOf(agent)
      d = decideWrite(state, {
        toolName: exec && exec.name,
        toolArgs: exec && exec.arguments,
        sessionId: sid,
        turn: turnOf(state, agent, sid),
        agentMissing: !agent,
        cwd: cwdOf(agent),
        cwds: [],
      }, deps, opts)
    } catch (e) {
      // ★ fail-open 硬约束：看守自己坏了绝不许让工具调用失败
      d = null
      try { fail(state, 'pre-execute-threw', { err: String((e && e.message) || e) }, deps) } catch (e2) { /* 算了 */ }
    }
    if (d && d.kind === 'deny' && typeof d.reason === 'string' && d.reason) {
      return Promise.resolve({ kind: 'deny', reason: d.reason })
    }
    return next()
  }))

  // ② 记账（"读过"与"改过"的唯一事实来源）
  disposers.push(ctx.on('tools/result', function (exec, result) {
    onToolResult(state, exec, result, deps, opts)
  }))

  // ③ 写闸的收尾侧（阻止收尾 + 欠账）
  disposers.push(ctx.on('agent/turn-stopping', function (payload) {
    onTurnStopping(state, payload, deps, opts)
  }))

  // ④ 回合号（S2）：`agent/pre-step` 是**官方事件**，payload 里就有 `turn`（见 turnOf 的注释）
  disposers.push(ctx.on('agent/pre-step', function (payload, next) {
    try {
      const agent = payload && payload.agent
      const sid = sessionOf(agent)
      const turn = numOr(payload && payload.turn, -1)
      if (turn >= 0) {
        const prev = state.curTurn.get(sid)
        state.curTurn.set(sid, { turn: turn, src: 'agent/pre-step' })
        if (!prev || prev.turn !== turn) {
          // 新回合开始 ⇒ 把**更早回合**的桶收尾成欠账（turn-stopping 被跳过时也收）
          publishTurnRows(state, finalizeUpTo(state, sid, turn - 1, deps), false, 'turn-boundary', deps)
        }
      } else {
        fail(state, 'pre-step-turn-missing', {
          sid: sid, why: '`agent/pre-step` 的 payload 里没有可用的 `turn` ⇒ 回合号只能靠 `agent.phase` 兜底',
        }, deps)
      }
    } catch (e) {
      try { fail(state, 'pre-step-threw', { err: String((e && e.message) || e) }, deps) } catch (e2) { /* 算了 */ }
    }
    return next()
  }))

  state.disposers = disposers
  return state
}

/** 显式拆卸（自检要证明"dispose 后监听器全摘掉"）；重复调用安全 */
function uninstall(state) {
  for (const d of (state && state.disposers) || []) {
    try { d() } catch (e) { /* 摘不掉也要继续摘下一个 */ }
  }
  if (state) {
    state.read.clear(); state.cur.clear(); state.pending.clear()
    state.curTurn.clear(); state.steers.clear(); state.steersTurn.clear()
  }
  return state
}

module.exports = {
  name: 'handover-gate',
  /**
   * ★ `inject: []` —— **故意留空**。
   *   Cordis 的 inject 是**硬依赖**：声明了却缺席 ⇒ 整个插件进 `waiting`。
   *   本插件不需要任何服务（不用 shell、不用 storage、不用 approval），
   *   可选服务一律走 `ctx.get()`（本插件一个都不用）。
   */
  inject: [],
  apply(ctx) {
    /* ★ 加载即留痕（R9）：**整个插件生命周期里只写这一次**，不在任何热路径上。
     *   写失败静默降级（`markPluginLoaded*` 内部已经吞掉所有异常）。
     *   位置选在 `apply()` 最前面：宿主调用 `apply` 本身就等于"这个插件加载成功了"。
     *   ⚠ **第 3 个实参 `hostId` 故意不传**：读 `ctx.id` 会在 `ctx` 的 Proxy 上留下一次
     *     `GET(id)`，与「对 `ctx` 的调用**只有** `ctx.on` 与 `ctx.effect`」那条硬契约
     *     （本文件上面的注释逐字写着）**直接冲突**（实测：自检 ㉔/㉔b 因此变红）。
     *     `hostId` 是可选参数 ⇒ 不传就整个键都不出现，留痕照常工作。
     *   ★ 复用本文件已有的 `PLUGIN_VERSION`，**不新增第二个版本常量**。 */
    markPluginLoadedWithRetry('handover-gate', PLUGIN_VERSION)
    const state = install(ctx)
    /**
     * ★ 可逆：`ctx.on` 已经各自是 fiber effect；这里再用一个 effect 兜一层，
     *   把**四条**监听与所有内存状态在卸载时一并清掉（`ctx.effect(execute)` 的返回值就是 disposer）。
     */
    ctx.effect(function () {
      return function () { uninstall(state) }
    }, 'handover-gate.dispose')

  },
  /** 以下都是给自检/诊断用的出口（Cordis 只读 name/inject/apply/Config，多余键会被忽略） */
  install: install,
  uninstall: uninstall,
  createState: createState,
  _internals: {
    HANDOVER_BASE: HANDOVER_BASE,
    HANDOVER_PREFIX: HANDOVER_PREFIX,
    HANDOVER_SUFFIX: HANDOVER_SUFFIX,
    MODIFY_TOOLS: MODIFY_TOOLS,
    SHELL_TOOLS: SHELL_TOOLS,
    PRESENT_TOOLS: PRESENT_TOOLS,
    WRITE_HINTS: WRITE_HINTS,
    HARD_RULES: HARD_RULES,
    rulesBlock: rulesBlock,
    findProjectRootVia: findProjectRootVia,
    resolveHandover: resolveHandover,
    listHandovers: listHandovers,
    isHandoverName: isHandoverName,
    dateOfHandoverName: dateOfHandoverName,
    isModifying: isModifying,
    isHandoverTarget: isHandoverTarget,
    decideWrite: decideWrite,
    onToolResult: onToolResult,
    onTurnStopping: onTurnStopping,
    normalizeOpts: normalizeOpts,
    pathKey: pathKey,
    resolveLogPath: resolveLogPath,
    /* ── R43 返工新增出口（自检要能单独钉住它们） ── */
    turnOf: turnOf,
    curKey: curKey,
    finalizeUpTo: finalizeUpTo,
    publishTurnRows: publishTurnRows,
    debtFor: debtFor,
    isEmptyHandoverWrite: isEmptyHandoverWrite,
    resultIsOk: resultIsOk,
    steerEnabled: steerEnabled,
    steerMaxPerTurn: steerMaxPerTurn,
    steerMaxPerSession: steerMaxPerSession,
    shellReadGateReason: shellReadGateReason,
    emptyHandoverReason: emptyHandoverReason,
    readGateReason: readGateReason,
    writeGateReason: writeGateReason,
    steerText: steerText,
    /* ── ★ 自动写交接草稿（自检要能单独钉住每一个安全阀） ── */
    PLUGIN_VERSION: PLUGIN_VERSION,
    HANDOVER_AUTO_MARK: HANDOVER_AUTO_MARK,
    HANDOVER_AUTO_WARN: HANDOVER_AUTO_WARN,
    HANDOVER_AUTO_PREFIX: HANDOVER_AUTO_PREFIX,
    AUTO_DRAFT_EXCLUDE_DIRS: AUTO_DRAFT_EXCLUDE_DIRS,
    autoEnabled: autoEnabled,
    nextDeclaration: nextDeclaration,
    autoDry: autoDry,
    rerunCommand: rerunCommand,
    localDateKey: localDateKey,
    autoDraftName: autoDraftName,
    hasAutoMark: hasAutoMark,
    buildAutoDraft: buildAutoDraft,
    draftPaths: draftPaths,
    draftDirtyNow: draftDirtyNow,
    lastRoundOf: lastRoundOf,
    utf8ByteLength: utf8ByteLength,
    writeAutoDraft: writeAutoDraft,
    logAutoDraft: logAutoDraft,
    markAutoDraftRead: markAutoDraftRead,
    freshenAutoSettings: freshenAutoSettings,
  },
}
