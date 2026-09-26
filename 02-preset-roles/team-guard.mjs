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
 *   ⑤ ★★ **主代理不写代码 —— 硬闸**（R36，`codeGate`，**默认就开**）——
 *      用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」
 *        「有问题就让子代理修。**不要自己写代码**……」
 *
 *      这一条与 ③ 的区别是**性质**上的，不是强度上的：
 *        · ③ 是"角色还没参与"的**减速带**（默认 `mode: 'gate'` ⇒ 会拦一次、重试放行；
 *          只有**显式**配 `remind` 才是只提醒 —— 默认值为什么是 `gate`，见 `DEFAULTS.mode` 那条注释）；
 *        · ⑤ 是**主代理想写代码文件就返回 deny**，**与 `mode` 无关**、默认 `enforce`、
 *          **不受 `maxDeniesPerSession` 限制**（重试不会放行）。
 *
 *      **判据（"这是不是本会话的主代理"）—— 查证过的正面证据，不是猜的**：
 *        `exec.agent.session.header.origin === 'subagent'` ⇒ 子代理 ⇒ **一律放行**；
 *        否则 ⇒ 主代理 ⇒ 闸生效。
 *        · `exec.agent` 的出处：`dsh-tools/lib/types/index.d.ts:208`
 *          （`ToolExecutionInput.agent`，"set by the agent loop"），
 *          调用点在 `dsh-tools/lib/index.js:3043`（`...agent !== void 0 ? { agent } : {}`）；
 *        · `session.header` 的出处：`dsh-session/lib/types/index.d.ts:117`（`readonly header`）、
 *          `dsh-session/lib/types/types.d.ts:58`（`SessionHeader`）；
 *        · `origin` 只能取 `'subagent'`：`dsh-session/lib/index.js:790`
 *          （`session header origin must be "subagent"`）；
 *        · 子代理创建时**真的写进 header**：`dsh-subagent/lib/index.js:510`
 *          （`childSessionMeta()` 里 `origin: "subagent"`）+ `:503`（读 `parent.session.header`）；
 *        · **活证据（不是读代码，是读真日志）**：本机
 *          `<HOME>\.dsh\sessions\--D-<USER>-grok--\<id>\session.v3.jsonl.zstd` 第一帧——
 *          顶层会话 `session-ccc30000-…` / `session-ddd40000-…`：**没有 `origin` 字段**、
 *          `delegationDepth: 0`；
 *          子代理会话 `4b6bfe7e-…`：`"origin":"subagent"`、`delegationDepth: 1`、
 *          有 `parentSession`。
 *        ⇒ 所以 `isSubagent()` 还接受**第二个正面证据** `delegationDepth >= 1`
 *          （顶层实测为 0）。它**只会多判出子代理**，不会把子代理误判成主代理；
 *          读不到 header 时仍然当**主代理**（宁可吵，不许静默失效）。
 *
 *      ★★ **路径规范化 —— 判决必须落在"真实落点"上**（R36 复查修正，两条**不经 shell** 的绕过）：
 *        判"豁免面"与"扩展名"之前，**先把路径规范化再判**。第一版在**未规范化的原始字符串**上
 *        按 `/` 分段找 `.warden`，全程没有 `path.resolve/normalize` ⇒ 「审查」实测这三条**全被放行**：
 *          `.warden/../src/a.js` · `src/.warden/../../evil.js` · `.warden\..\src\a.js`
 *        判决说"这是账本"，而 **OS 层面的真实落点**是 `src/a.js` / `evil.js`
 *        （写完之后 `src/a.js` 真的存在 —— 判决与落点**分叉**）。
 *        再加上 NTFS 备用数据流（ADS）：`src/foo.js::$DATA` 的**真实落点就是** `src/foo.js`，
 *        而第一版算出的扩展名是 `.js::$data`（认不出来 ⇒ 放行）—— 实测**真造出了 `a.js`**。
 *        ⇒ 所以：**先规范化，再判豁免面与扩展名**；扩展名按第一个 `:` 截断。
 *
 *        ★★ **同类第三条 —— 尾随点 / 尾随空白**（R36 复查第 4 条，**原来漏记在"已知的洞"之外**）：
 *          「审查」实测 `x.js.`（算出的扩展名是 `.`）与 `x.js␠`（`.js `）**零歧义却全被放行**。
 *          它的夹具目录我**找到了并逐字节核过**（`%TEMP%\pm4-win-Thtdbh\`）：
 *            `x1.js␠`(尾字节 0x20) · `x2.js.` · `x3.js` · `x4.js.` · `x5.js␠`(**尾字节 C2 A0 = U+00A0**)
 *          ⇒ 我上一轮**测过却没写进"已知的洞"**，是**漏记**，不是"没想到"。
 *          ⚠⚠ **落点到底是哪一个 —— 我自己在这台机器上实测过，两种行为都有，不许含糊**：
 *            · **Node 的 fs**（= DSH `write`/`edit` 真正走的那条路，也正是这道闸要看住的那条路）：
 *              `writeFileSync('x.js.')` 落盘的名字**就是 `x.js.`**（`readdir` 得到 `78 2e 6a 73 2e`），
 *              `statSync('x.js')` ⇒ **ENOENT** ⇒ **不是同一个文件**（libuv 走 `\\?\` 前缀）；
 *            · **cmd / PowerShell 的重定向**（都实测过）：`echo c> z.js.` 与 `Set-Content z.js.`
 *              落盘的**是 `z.js`**（尾随点被 Win32 丢掉）。
 *          ⇒ 所以本条的**准确描述**是「扩展名黑名单漏了一种零歧义的代码名」，
 *            **不是**"`x.js.` 是 `x.js` 的别名"（后者只在 shell 那条路上成立，而 shell 写文件
 *            本来就是"已知的洞"里记着**不堵**的那一条）。
 *          ⇒ 处置：**故意收紧** —— 判扩展名之前去掉尾随点/空白（`x.js.` → `x.js` ⇒ `.js` ⇒ **拦**）。
 *            去掉的是 `[.\s]`：Windows 只丢 ASCII 空格与点，这里**连 U+00A0 之类的空白一起去**，
 *            因为审查夹具里 `x5.js` 的尾字节就是 U+00A0（Windows 不丢它）而它是同一形状的零歧义代码名；
 *            多收这一点只会**多拦**、不会放行。代价极小（子代理本来就不受这道闸管，
 *            主代理真要写还有留痕的一次性豁免）；方向是**收紧**，而且**不许**拿"跟着 OS 落点走"
 *            当理由 —— 那句话在本机是半真半假的。`␠` = U+0020。
 *
 *        **基目录用哪个 —— 判据（查过的，不是猜的）**：`dsh-tool-fs/lib/index.js:225-242`
 *        （`session-cwd.js`）逐字写着：fs 工具解析相对路径用的是
 *        "the calling agent's per-session workspace (**`exec.agent.session.header.cwd`**) …
 *         rather than `process.cwd()` at the tool boundary"。
 *        ⇒ 本插件的判据是 **`exec.agent.session.header.cwd`**（本会话工作区），**不是** `process.cwd()`；
 *          `path.resolve(cwd, file)` 与工具的真实落点**同源**。
 *          · **绝对路径**：`path.resolve` 直接返回它自己（`..` 照样折叠）⇒ 正确；
 *          · **相对路径**：以会话工作区为基 ⇒ 与工具的落点一致；
 *          · **读不到 cwd**（没有 session / header）：退成 `path.normalize(file)`（**词法**折叠 `..`）。
 *            这一层对"词法尾巴里有没有一段叫 `.warden`"仍然正确（与基目录无关），
 *            只有"基目录自己就在 `.warden` 里"这类边角会差 —— 那种情况按 `base:'lexical'` **如实记进探针**，
 *            不假装它是会话工作区算出来的。
 *        ⚠ 一个**有界的已知偏差**（写在这里，不藏）：`dsh-tool-fs/lib/index.js:252-255` 里，
 *          当这次调用带 sandbox policy 时基目录会被换成 `policyWorkspaceRoot`。本插件在
 *          `tools/pre-execute` 里**读不到**它 ⇒ 那种情况用会话工作区**近似**。两者一般是同一个目录，
 *          **但这不是同一个判据**，所以如实写在文件头。
 *        ✅ **`.warden/**` 的豁免没有被取消** —— 要的是"**规范化之后**再看它是不是真在 `.warden` 里"。
 *          账本 / `SPEC.md` / 任务书 / `patches/**` 照旧直接放行（理由见下面"豁免面"）。
 *
 *      **豁免面（写清，且都是"直接放行"，不需要任何口令）**：
 *        · `.warden/**`（**整棵目录**，规范化之后判）—— 记账是主代理的活，**绝不拦**；
 *          ⚠ 护栏**故意比"只认账本文件"宽** —— 二选一里选了"写清为什么整棵不拦"，理由：
 *            ① `.warden/` 里放什么**由 skill 自己演化**（`SPEC.md` / `ROUNDS.jsonl` /
 *               `FINDINGS.jsonl` / `ROLE_SPEECH.jsonl` / `BRAIN.jsonl` / `RULES.jsonl` /
 *               `INCIDENTS.jsonl` / `DEVIATIONS.md` / 任务书 / `VOICE.jsonl` / `patches/**` …）——
 *               写一张"只认这 N 个文件名"的清单，就是**第 N 份会腐烂的硬拷贝**，
 *               正是本项目那句「名单只有一张，别再往别处抄」要防的事；
 *            ② **一个具体的、刚刚发生的反例**：`patch-pipeline.mjs` 的产物在
 *               `.warden/patches/<P>/work/<hash>__<file>.mjs`，而它**要求主代理去改那个 work 副本**
 *               （本轮 R36 复查改的就是 `.warden/patches/P-M4/work/43cbb2df__team-guard.mjs`）。
 *               收紧成"只认账本文件"会**当场把这套管线打死**。
 *          ⇒ 取舍：**整棵 `.warden/` 都不拦**，并把这句写进拒绝理由第 3 步（模型看得见），
 *            而不是靠"反正没人会往里写代码"这种没有证据的假设。
 *        · `*.md`（文档）—— **不拦**；
 *        · 代码扩展名**之外**的文件（`.json` / `.yaml` / `.toml` / `.ini` / `.txt` …）——
 *          **不拦**。判据是**代码扩展名黑名单**，不是"非白名单即拦"：
 *          **误伤**是这个闸最贵的失败态（用户点名"不许改自动启用"的同时，也骂过被没说的事挡住），
 *          两边一起满足的办法就是"**只拦明确是代码的**"，认不出来的一律放行
 *          （代价见下面"已知的洞"）。
 *          ⚠ 这里**不再**拿「又开始因为一些我没有说的东西而停止了工作」当论据 ——
 *            那是**半句**（同段第一句是"每轮结尾的八位角色的原话展示没有了"），
 *            拿它推"闸该关掉"属于**选择性引用**（见 `DEFAULTS.mode` 的注释）。
 *
 *      **显式的一次性豁免（两条，且必须留痕）**：
 *        · **一次性 token 文件** `<工程根>/.warden/ALLOW-MAIN-WRITE` —— 存在即放行**一次**，
 *          用完自动删掉；删不掉/写不进痕迹的**不放行**。
 *        · 环境变量 `DSH_TEAM_GUARD_ALLOW_MAIN_WRITE=1` —— **整个进程有效，不是一次性的**
 *          （如实说明，别把它当一次性用）。
 *        两条都往 `<工程根>/.warden/team-guard-exemptions.jsonl` 追一行；
 *        **写不进痕迹 ⇒ 这次豁免不算数，照样 deny**（"必须留痕"是硬条件，不是口号）。
 *
 *      **已知的洞（如实写出来，不许自夸成"真拦"）**：
 *        · `pwsh` / `bash` 里用 `Set-Content` / `Out-File` / 重定向照样能写代码 ——
 *          要堵它就得解析 shell 命令，误伤面太大（本项目已经因为误伤挨过骂），**不堵**；
 *        · **扩展名黑名单是"有界且已文档化的洞"** —— 认不出来的一律放行。
 *          2026-09-24「审查」实测**仍然 ALLOW** 的清单（原样抄下来，一条不删）：
 *            `.coffee` · `.es6` · `.json5` · `.wasm` · `.map` · `Dockerfile` · `src/build`（无扩展名）
 *          处置分两类（**说清为什么**，不是"顺手补两个"就完事）：
 *            · **本轮补进黑名单**：`.coffee` / `.es6` —— 它们就是 CoffeeScript / ES6 模块**源码**，
 *              是不是代码**没有歧义**，补进去零误伤；
 *            · **如实留着（并写明理由）**：
 *              `.json5` —— 与 `.json` 是同一类（配置 / 数据），而 `.json` 是**用户点名的豁免面**
 *                （本插件自己的 `team-guard.json` 就要主代理改）；只拦 `.json5` 是自相矛盾；
 *              `.wasm` / `.map` —— **构建产物**，不是手写源码；"主代理顺手写一个 .wasm"没有实际形态，
 *                而拦住"重新构建后生成 map"是典型的**误伤**；
 *              `Dockerfile` / `src/build`（无扩展名）—— 落在"认不出来的扩展名"那一档，而那一档
 *                **故意是 fail-open**（用户因为误伤关过闸）。要拦它就得改成"无扩展名 ⇒ 可能是代码"，
 *                那会把 `Makefile` / `LICENSE` / 各类无扩展名配置一起拦掉 —— 不划算，**不堵**。
 *          ⇒ 上面这份清单是"黑名单到底漏什么"的**唯一**记录。要补：**同时**改这里和
 *            `CODE_EXTENSIONS`（`team-guard.selftest.mjs` 不钉具体扩展名，所以改它不用动自检）。
 *        · **子代理那一半的探针**：R36 复查之前，`runCodeGate` 对子代理是 `return null` 且**一行不留**
 *          ⇒ 探针只能证"主代理被拦过"，**证不了"子代理那一半真的被放行了"**。
 *          现在**第一次**子代理代码调用写一行 `code-subagent-skip`（**每进程一行**，不加噪音）。
 *        · ★ **尾随点 / 尾随空白曾经漏在黑名单外**（R36 复查第 4 条）：`x.js.` / `x.js␠` /
 *          `x.js` + **U+00A0** 这类**零歧义代码名**原来算不出 `.js` ⇒ 落到"认不出来就放行"。
 *          **现在已收紧**（见文件头"同类第三条"，含本机实测的两种落点行为）。这条**必须**留在清单里
 *          —— 它是"我测过却没记"的那一条，删掉就等于把事故的形状抹掉。
 *        · ★ **`.warden␠`（带尾随空格）这个段名认不出来**：`ledgerScopePath` 用的是**没去尾**的
 *          路径（防止 `proj\.warden.\x.js` 被当账本放行）⇒ 那一层里的代码文件**照拦**。
 *          这是**更严**的一侧（不是绕过），照实写在这里。
 *        · **探针的覆盖边界（写清，别把"没查到"读成"没问题"）**：探针**每次 `apply()`** 最多 8 行
 *          （不是"每进程"—— 额度是 `makeProbe()` 的闭包局部量，而每次 `apply()` 各调一次 `makeProbe()`；
 *          跨多次挂载的总量由 `PROBE_MAX_BYTES` 兜底）、
 *          且只在前 2 次工具调用里写 `tool` 行 ⇒ **一次跑了很多调用的会话，后面的调用在探针里看不见**。
 *          要证"某一次具体调用被拒/放过"，看**那一次的返回值**，别只看探针。
 *          ⚠ 但 **角色闸的 `deny` 行不再受那 8 行约束**（`PROBE_ROLE_RESERVE`，R36 复查第 3 条）：
 *            code 闸每拒一次都可能写一行，8 行会被它吃光 ⇒ "角色闸没响"与"预算用光"又分不开。
 *            实测（改前）：连发 8 次 `x1..x8.js`（每次 code 闸 deny 一行）之后，
 *            第 9 次写 `x.txt` **确实被角色闸拒**，而 `gate:"role"` 那一行**根本写不进去**。
 *        · **挂载时的两行（`mounted` / `config-invalid`）原来只会扔给 `process.cwd()`**
 *          （R36 复查第 7 条）：那时还没有 agent，`findProjectRoot(null)` 返 null ⇒ 落点与任何会话
 *          都无关，而出厂自检里那条断言恰恰叫「★ 探针落到工程根 `.warden/` 里（**不是乱扔**）」。
 *          现在**两处都留**：① 挂载时先落 `process.cwd()` → `tmpdir`（保底证据：证明"装上了"这件事
 *          不会因为读不到会话就消失，出厂自检就是靠这一份判的）；② **第一次拿到 agent 时把它们
 *          `backfill` 到那个 agent 的真实工程根 `.warden/`**（带 `backfill:true` 标出来）。
 *          专用额度 `PROBE_MAX_PENDING=3`，不许把它养成第二个日志库。
 *        ⇒ 所以这条的准确定位是：**把"主代理顺手写代码"这个默认动作挡住**，
 *          不是防住一个成心绕路的模型。要防成心的，得靠 ③ 的角色参与与事后的 `check`。
 *
 *      ★★ **两道闸必须能分开验（R36 复查第 3 条）** —— 这是"断言假绿"的病根：
 *        `codeGate` 与 ③ 的角色闸**都会返回 `deny`**。第一版里 codeGate 抢在前面 ⇒
 *        「角色闸真的响过」与「code 闸顺手替它响了」在**证据上长得一模一样**。
 *        **本轮亲自复现的口径**（work 副本 + 出厂 `team-guard.selftest.mjs`，共 122 条断言；
 *        跑法：把 work 副本当 `team-guard.mjs` 放进镜像目录、`DSH_HOME` 指到该镜像，
 *        再 `node team-guard.selftest.mjs`）：
 *          · 无配置（`codeGate=enforce`）：exit=1，通过 **119** / 不通过 **3** ——
 *            `一共只挂了 1 个监听器（挂得越多，越可能是死代码）`（**过期**：本文件现在挂了
 *            `tools/pre-execute` + `tools/post-execute`）· `同一个会话第二次 write 放行（最多拦一次）` ·
 *            `已派过角色的会话 write 放行`（后两条是**假红**：夹具 `x.js` 让 code 闸替角色闸回答了两次）；
 *          · 加 `{"codeGate":"off"}`：exit=1，通过 **121** / 不通过 **1** —— 只剩 `一共只挂了 1 个监听器`。
 *        ⚠ **原先这里写的"那 5 条关掉 codeGate 就从绿变红"是错的**（旧口径的失败数
 *          也跟它自己给出的分类对不上）。实测那 5 条（`★ prompt 服务缺失 ⇒ 闸照样会响` ·
 *          `第一次 write 被拒` · `拒绝理由里带 init 与 role brief` ·
 *          `★ 探针证明闸真的响过（deny 行）` · `★ 只跑过 init 的会话，write 仍然被拒`）
 *          **在两种配置下都是绿的** —— 它们**不是**靠 code 闸才成立的。
 *          真正的病是：**这几条断言分不出是哪道闸**。同一批夹具实测 ——
 *          `codeGate=enforce` 时拒的是 `gate:"code"`（**由 code 闸满足**），
 *          `{"codeGate":"off"}` 时拒的是 `gate:"role"`；而断言只看 `kind:"deny"`，
 *          于是「角色闸真的响了」与「code 闸顺手替它响了」**照样长得一模一样**。
 *        ⇒ **要单验角色闸，两样都得改**：① 断言里加 `gate === 'role'`；
 *          ② 夹具从 `x.js` 换成**非代码文件**（`x.txt`）——只加断言不够、只换夹具也不够。
 *          本轮已把这两样一起补进出厂 `team-guard.selftest.mjs`（判决对象带 `gate` 字段，见 ①）。
 *        ⇒ 本插件提供三个**分开的观测口**（判决逻辑一行没放宽）：
 *          ① 探针里 `deny` 行的 `gate` 字段：角色闸那条路径上**一定是 `"role"`**，code 闸是 `"code"`
 *             （事件名故意都叫 `deny` —— "闸响了"是一个事实，"哪道闸"是另一个字段）；
 *          ② 探针 `tool` 行 / `deny` 行的 `roleWouldDeny` 与 `roleGate`：由**纯函数** `gateDecision`
 *             算出"这次调用角色闸会不会拒"，于是**即便 code 闸抢答，角色闸的判决也有据可查**；
 *          ③ 状态行里两道闸**分开报**：`· **角色闸**（③…）` 与 `· **主代理不写代码**：codeGate=…`
 *             是**两行**，各自带自己的计数（`st.denies` / `st.codeDenies`），不合并。
 *        ⚠ 但**要真验到"角色闸单独会拒"，夹具必须换掉** —— 见本轮报告「要改 selftest 的哪几条断言」：
 *          夹具 `x.js` 会被 code 闸先拦，必须换成**非代码文件**（`x.txt`）或把 `codeGate` 关掉再单测。
 *        ★★ 为了让"改完夹具就能单验"，本轮把**机制**补足了两处（**判决逻辑一行没放宽**）：
 *          ① **判决对象带机读字段**：两道闸的 `deny` 现在都是
 *             `{ kind:'deny', gate:'role'|'code', why:'…', reason:'…' }` ——
 *             `gate` 就是"哪道闸响的"，不必再拿 `reason` 的首行做字符串匹配。
 *             安全性（查过的）：`dsh-tools/lib/index.js:3116` 派发 `tools/pre-execute` 瀑布，
 *             `:3117` 只读 `gate.kind === "ask"`、`:3127` 只读 `decision.kind` / `decision.reason`，
 *             **未知键不校验、是惰性的**（不改判决，只加可读性）。
 *          ② **角色闸的 `deny` 探针单独保底**（`PROBE_ROLE_RESERVE=8` 行）：不再被 8 行总预算挤掉。
 *          这一条**不在本文件里**（`team-guard.selftest.mjs`），本轮只写清改法、**没改它**。
 * ## 可调项
 *
 * 同目录下的 `team-guard.json`（可选，没有就用默认值）：
 *
 *   { "mode": "gate",              // gate = 真拦一次 / remind = 只提醒 / off = 全关
 *     "maxDeniesPerSession": 1,    // 0 = 不拦；99 = 每次写文件都拦
 *     "mutatingTools": ["write", "edit"],
 *
 *     // ★ R36：主代理不写代码（**与 mode 无关，默认 enforce**）
 *     "codeGate": "enforce",       // enforce = 真 deny / warn = 只提醒 / off = 关
 *     "codeTools": ["write", "edit", "str_replace_editor"],
 *     "codeExtensions": [".js", ".ts", …],   // 覆盖：**整条替换**，不是追加
 *     "codeExemptEnv": "DSH_TEAM_GUARD_ALLOW_MAIN_WRITE",
 *     "codeExemptToken": ".warden/ALLOW-MAIN-WRITE",
 *     "docExtensions": [".md"] }
 *
 *   ⚠ `mode: "off"` 仍然会**整行早退**（连这道硬闸一起关掉）—— 那是一个显式的
 *     "本插件全关"，不是默认值，也不会自己发生。
 *
 *   ⚠⚠ **配置读不出来的样子必须看得见（不许静默）** —— R36 复查第 2 条。
 *     实测（「审查」原样输出）：同一份 `{"codeGate":"off"}`，写成**不带 BOM** 时
 *     `codeGate = off` **生效**；写成**带 BOM**（首字节 `EF BB BF`）时 `JSON.parse` 直接抛，
 *     被第一版那个空 `catch {}` 吞掉 ⇒ **静默回默认 `enforce`**，而用户是**照文档操作**的。
 *     PowerShell 的 `Set-Content -Encoding UTF8` / `Out-File -Encoding utf8` **就会写 BOM**
 *     —— 本机安装份 `<HOME>\.dsh\.agent-presets\roles\team-guard.mjs:255-257` 早就
 *     为同一个坑写过 `去 BOM` 的注释（逐字：「实测踩过」）。本文件当时漏了。
 *
 *     现在两条一起做（**去 BOM 只是其中一半**）：
 *       ① 读之前去 BOM：`.replace(/^\uFEFF/, '')`；
 *       ② 解析失败**不静默回默认**：把问题记进 `opts.configIssue`，在
 *          **状态行**（每一步都在）与**协议段**里逐字说明
 *          「配置文件**存在**但读不出来（第 N 行 / 原因）」，并往探针写一行 `config-invalid`。
 *          另外：顶层不是对象、以及**认不出来的字段名**（例：`codeGate` 拼成 `codegate`）
 *          也一并报出来 —— 它们同样是"照文档写了却静默无效"。
 *     判据：**"配置坏了"与"配置没写"从此在证据上分得开**（空 catch 的代价就是这两件事长得一样，
 *     这个文件自己也被骗过一次）。
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

/**
 * 「代码文件」的扩展名黑名单 —— 只拦**认得出是代码**的（见文件头 ⑤ 的取舍说明）。
 * 故意**不含** `.json` / `.yaml` / `.yml` / `.toml` / `.ini` / `.txt`：
 * 那些是配置与数据，主代理平时就要改（例：本插件自己的 `team-guard.json`）。
 */
const CODE_EXTENSIONS = [
  // JS / TS 家族与框架单文件组件
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
  '.vue', '.svelte', '.astro', '.ipynb',
  // ★ 2026-09-24 R36 复查补（原来实测 ALLOW 的两个：CoffeeScript / ES6 模块**源码**，零歧义）
  '.coffee', '.es6',
  // 脚本语言
  '.py', '.pyi', '.rb', '.php', '.pl', '.pm', '.lua', '.r', '.jl', '.dart',
  '.ex', '.exs', '.sh', '.bash', '.zsh', '.fish', '.ksh',
  '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.vbs',
  // 编译型语言
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.cs', '.java',
  '.kt', '.kts', '.scala', '.go', '.rs', '.swift', '.m', '.mm',
  '.groovy', '.gradle', '.fs', '.fsx', '.vb', '.nim', '.zig',
  '.hs', '.ml', '.erl', '.hrl', '.clj', '.cljs', '.elm', '.asm', '.s',
  // 前端标记与样式
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  // 数据库
  '.sql',
]

/** 文档扩展名 —— **不拦**（用户点名的豁免面之一：`*.md`） */
const DOC_EXTENSIONS = ['.md']

/** 豁免留痕的账本文件名（落在**工程根**的 `.warden/` 里） */
export const EXEMPTION_LEDGER = 'team-guard-exemptions.jsonl'

/** 默认配置（`team-guard.json` 只覆盖它列出的字段） */
const DEFAULTS = {
  // ★★ **默认 `gate`（真拦一次）—— 这一项已经被用户逐字钉死，不许再改。**
  //
  //   ① R22 用户原话（`VOICE.jsonl` 第 226 行；`kind:"user"` · `wrote:true` ·
  //      `2026-09-17T09:42:31.604Z`；本文件作者 2026-09-24 亲自 grep 复核过）：
  //      「原来的配置被人改掉了。这个是非常重要的功能，居然被改掉了，
  //        **做了插件不启用那不是毫无用处吗**？否则的话专门做这个插件干什么呢？
  //        **以后绝对不能改自动启用的这一项！**」
  //      ⇒ 把一个"默认就开着"的闸改成"默认不拦"，**正是这句话禁止的那个动作**。
  //      另有一条旁证：**安装份** `<HOME>\.dsh\.agent-presets\roles\team-guard.mjs:108`
  //      就是 `mode: 'gate'` —— 我上一轮把 **work 副本**改成了 `remind`，与安装份相反。
  //
  //   ② 上一轮我拿「**又开始因为一些我没有说的东西而停止了工作**」当理由改成 `remind`。
  //      ⚠ 那句话**确实是逐字原话**，但它是**半句**（`VOICE.jsonl` 第 362 行，
  //        `2026-09-23T14:29:42.563Z`）—— 同一段的**第一句**是：
  //        「我用了新窗口，感觉没有以前的项目团好用。**每轮结尾的八位角色的原话展示没有了。而且**
  //          又开始因为一些我没有说的东西而停止了工作…」
  //      ⇒ 用户抱怨的是"**角色的原话展示没了** + 还因为没说的事停下"，
  //        被我选择性引用成了"所以角色闸不许拦"。**把用户的否定写成正说**（A3 那条规矩）就是这么发生的。
  //
  //   ③ 同一 session、8 分钟后（`2026-09-23T14:37:41.725Z`，第 365 行）用户原话：「（用户原话已隐去 —— 公开版不留逐字）」；15:17（第 369 行）：「**要角色们完全能够激活自主运行**」。
  //      ⇒ 用户要的方向是"**角色自己动起来**"，不是"把闸关掉"。
  //
  //   ④ 本文件原来还自相矛盾：R36 的 `codeGate` 默认 **`enforce`（自动拦）**，
  //      而角色闸默认 `remind`（不拦）—— 同一个文件里两条闸的默认值反着来。
  //
  //   ⇒ 默认回到 **`gate`**：本会话还没派过角色时，第一次 `write`/`edit` 被拒一次
  //     （`maxDeniesPerSession=1` ⇒ 重试放行，拒绝理由里逐字写了这条出路）。
  //     真要"只提醒"：**由用户显式**在 preset 目录放 `{"mode":"remind"}` —— 那是他的动作，不是默认值。
  //     ⚠ 出厂 `team-guard.selftest.mjs:184` 断言的正是 `mode === 'gate'`（默认值只此一份）。
  mode: 'gate',
  maxDeniesPerSession: 1,
  mutatingTools: ['write', 'edit'],

  // ★ R36：**主代理不写代码**。与上面那个 `mode` **完全无关**，而且**默认就开** ——
  //   用户原话要的是"保证我在任何新窗口都是自动使用"，所以它不能吊在 `mode` 上：
  //   谁把 `mode` 配成 `remind` / 把 `maxDeniesPerSession` 配成 0，都**不该**让这道硬闸跟着消失。
  //   （上一轮这条注释写的是"那样默认 `remind` ⇒ 永远不响" —— 那句现在**过期了**：
  //     `mode` 的默认已经改回 `gate`，见 `DEFAULTS.mode` 那条注释。）
  codeGate: 'enforce',
  codeTools: ['write', 'edit', 'str_replace_editor'],
  codeExtensions: [...CODE_EXTENSIONS],
  docExtensions: [...DOC_EXTENSIONS],
  codeExemptEnv: 'DSH_TEAM_GUARD_ALLOW_MAIN_WRITE',
  codeExemptToken: '.warden/ALLOW-MAIN-WRITE',
  // ★ 分诊闸：交付前检查有没有未决议的投票。enforce = 真 deny / warn = 只提醒 / off = 关
  triageGate: 'enforce',
}

/** 行数统计的字节上限：超过就只报"很多"，不把大账本读进内存 */
const MAX_COUNT_BYTES = 262144

// ─────────────────────────────────────────────────────────── 配置

/**
 * 读同目录的可选配置。**读不动/没有/坏掉一律回默认** ——
 * 加固层自己坏了，绝不能让 preset 挂不起来。
 *
 * ⚠ 但"坏配置回默认"对 R36 那道硬闸是**危险的**：默认 `codeGate:'enforce'`，
 *   于是写错一个字段（比如把 `codeGate` 拼成 `codegate`）会**悄悄退回"拦"**而不是"放"。
 *   这个方向是**故意**的（宁可吵不许静默），而且它吵得有理由：主代理一写代码就被拦，
 *   拒绝理由里写着怎么关（`{"codeGate":"off"}`）。
 * @param {string} [file] 配置文件路径（自检用）
 * @returns {{mode:'gate'|'remind'|'off', maxDeniesPerSession:number, mutatingTools:string[],
 *   codeGate:'enforce'|'warn'|'off', codeTools:string[], codeExtensions:string[],
 *   docExtensions:string[], codeExemptEnv:string, codeExemptToken:string,
 *   configIssue:{file:string, kind:'unreadable'|'invalid-json'|'not-an-object', line:number|null, message:string}|null,
 *   unknownKeys:string[]}}
 */

/** 配置里**认得**的键（拼错的字段要能被报出来 —— 名单只此一份，与下面逐个 `if` 一一对应） */
const CONFIG_KEYS = new Set([
  'mode', 'maxDeniesPerSession', 'mutatingTools',
  'codeGate', 'codeTools', 'codeExtensions', 'docExtensions',
  'codeExemptEnv', 'codeExemptToken',
  'triageGate',
])

/**
 * 从 `JSON.parse` 的报错里算出行号（第 N 行）。
 * Node 的报错带 `position <n>`（新版本还附带 `(line L column C)`）；
 * 认不出来就返回 `null` —— **不许猜**（猜出来的行号会把用户骗到别的地方去）。
 * @param {unknown} err
 * @param {string} text 实际喂给 JSON.parse 的正文（已去 BOM）
 * @returns {number|null}
 */
function jsonErrorLine(err, text) {
  try {
    const msg = String((err && err.message) || (err && err.toString && err.toString()) || '')
    const byLine = /\bline (\d+)\b/.exec(msg)
    if (byLine !== null) return Number(byLine[1])
    const byPos = /position (\d+)/.exec(msg)
    if (byPos === null) return null
    const pos = Number(byPos[1])
    if (!Number.isFinite(pos) || pos < 0) return null
    let line = 1
    for (let i = 0; i < pos && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1
    return line
  } catch {
    return null
  }
}

export function loadOptions(file = path.join(HERE, 'team-guard.json')) {
  const out = {
    ...DEFAULTS,
    mutatingTools: [...DEFAULTS.mutatingTools],
    codeTools: [...DEFAULTS.codeTools],
    codeExtensions: [...DEFAULTS.codeExtensions],
    docExtensions: [...DEFAULTS.docExtensions],
    // ★ R36 复查：配置**本身**的状态。注意它说的不是"有没有配"，
    //   而是"**配了，但读不出来**" —— 这两件事原来被空 catch 搅成一团（见文件头）。
    configIssue: null,
    unknownKeys: [],
  }
  let raw = null
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    // 读不到时要**分清"没写配置"与"写了配置但读不动"**（权限 / 被占用 / 是目录…）。
    // ENOENT ⇒ 真的没写 ⇒ 静默（那是正常状态）；其它 ⇒ 记下来，别静默。
    const code = e !== null && typeof e === 'object' ? e.code : undefined
    if (code !== 'ENOENT') {
      out.configIssue = { file, kind: 'unreadable', line: null, message: String(code || (e && e.message) || e).slice(0, 200) }
    }
    return out
  }
  // ⚠ 去 BOM：PowerShell 的 `Set-Content -Encoding UTF8` / `Out-File -Encoding utf8` 会写 BOM，
  //   而 `JSON.parse` 遇到 BOM **直接抛** ⇒ 被 catch 吞掉 ⇒ **永远落默认**（实测踩过；
  //   本机安装份 `<HOME>\.dsh\.agent-presets\roles\team-guard.mjs:255-257` 早就修过这个坑）。
  //   ⇒ 这正是"用户逐字照文档写了 `{"codeGate":"off"}`，闸却照拦，而且没有任何证据"的成因。
  const text = raw.replace(/^\uFEFF/, '')
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    out.configIssue = {
      file,
      kind: 'invalid-json',
      line: jsonErrorLine(e, text),
      message: String((e && e.message) || e).slice(0, 200),
    }
    return out
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // 合法 JSON、但顶层不是对象 ⇒ 所有字段都会被忽略。**这同样是"写了却没生效"**，必须报出来。
    // ⚠ R36 复查第 7 条：原来这里写的是 `顶层是 ${typeof parsed}` ⇒ 顶层 `null` 时印出
    //   「顶层是 **object**，本插件只认对象」—— **`typeof null === 'object'`，那句话是错的**，
    //   而且正好把用户往反方向指（他会以为自己写的确实是个对象）。
    //   ⇒ `null` 单独说成 `null`（连"它是不是对象"都不含混）。
    const shape = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed
    out.configIssue = {
      file,
      kind: 'not-an-object',
      line: null,
      message: `顶层是 ${shape}，本插件只认对象`,
    }
    return out
  }
  try {
    if (parsed.mode === 'gate' || parsed.mode === 'remind' || parsed.mode === 'off') out.mode = parsed.mode
    if (Number.isInteger(parsed.maxDeniesPerSession) && parsed.maxDeniesPerSession >= 0) {
      out.maxDeniesPerSession = parsed.maxDeniesPerSession
    }
    if (Array.isArray(parsed.mutatingTools) && parsed.mutatingTools.every((x) => typeof x === 'string')) {
      out.mutatingTools = [...parsed.mutatingTools]
    }
    if (parsed.codeGate === 'enforce' || parsed.codeGate === 'warn' || parsed.codeGate === 'off') {
      out.codeGate = parsed.codeGate
    }
    if (parsed.triageGate === 'enforce' || parsed.triageGate === 'warn' || parsed.triageGate === 'off') {
      out.triageGate = parsed.triageGate
    }
    if (Array.isArray(parsed.codeTools) && parsed.codeTools.every((x) => typeof x === 'string')) {
      out.codeTools = [...parsed.codeTools]
    }
    // ⚠ 扩展名是**整条替换**不是追加 —— 追加语义下"想放开 .mjs"没法表达。
    //   空数组是合法的（= 什么都不当代码拦），所以只校验类型不校验长度。
    if (Array.isArray(parsed.codeExtensions) && parsed.codeExtensions.every((x) => typeof x === 'string')) {
      out.codeExtensions = normalizeExtensions(parsed.codeExtensions)
    }
    if (Array.isArray(parsed.docExtensions) && parsed.docExtensions.every((x) => typeof x === 'string')) {
      out.docExtensions = normalizeExtensions(parsed.docExtensions)
    }
    if (typeof parsed.codeExemptEnv === 'string' && parsed.codeExemptEnv.length > 0) {
      out.codeExemptEnv = parsed.codeExemptEnv
    }
    if (typeof parsed.codeExemptToken === 'string' && parsed.codeExemptToken.length > 0) {
      out.codeExemptToken = parsed.codeExemptToken
    }
    // 认不出来的键（`_` 开头当注释放过）—— 拼错一个字段就是"照文档写了却静默无效"，
    // 而第一版连"有没有生效"都没法从证据上判断。**只报不改**（不改判决）。
    out.unknownKeys = Object.keys(parsed).filter((k) => !CONFIG_KEYS.has(k) && !k.startsWith('_'))
  } catch { /* 字段应用不该抛；真抛了也绝不许让 preset 挂不起来（此时已按默认值返回） */ }
  return out
}

/**
 * 扩展名统一成小写带点的形态：`js` / `.JS` / `  .Js ` ⇒ `.js`。
 * 配置写错大小写或漏掉点，是**很容易发生**的事，而它会让黑名单**静默失效**
 * （`.JS` 匹配不上 `.js` ⇒ 代码文件当成"认不出来"⇒ 放行）。
 * @param {string[]} list
 * @returns {string[]}
 */
function normalizeExtensions(list) {
  const out = []
  for (const raw of list) {
    const t = String(raw).trim().toLowerCase()
    if (t.length === 0) continue
    out.push(t.startsWith('.') ? t : `.${t}`)
  }
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
 *
 * ⚠ 唯一的"不恒定"来源是 `configIssue`：它在**本进程内**也是恒定的（配置只在 `apply` 时读一次），
 *   所以 KV cache 不受影响。而它是必须的 —— 用户照文档写了 `{"codeGate":"off"}` 却没生效时，
 *   这一段是**在模型眼前说清"配置存在但读不出来"**的地方之一（另一处是状态行）。
 * @param {string} [warden] warden.mjs 绝对路径
 * @param {{file:string, kind:string, line:number|null, message:string}|null} [configIssue]
 *   `loadOptions()` 给的配置问题（null = 没有 / 没写 —— 两者现在分得开）
 * @returns {string}
 */
export function protocolText(warden = wardenPath(), configIssue = null) {
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
    '第 0 步 —— **要动手改东西**的任务，在写任何文件之前：',
    // ★★ 2026-09-24 补（C1/C3 的根）：安装副本原来写的是「**任何"超过一句话"的任务**」，
    //   **没有豁免** ⇒ 一个"描述一个三维绘图软件应该具备的功能"（交付物是文字）被当成大任务，
    //   实测跑了 **77 步 / 98 次工具调用 / 派 3 个子代理**（子会话日志合计 2.6MB），
    //   **step 18 就写出交付物了，之后又跑了 59 步**。
    //   用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」。
    '  ⚠ **下面三类不做第 0 步，直接干完**（为它们派角色 = 用用户没要求的东西拖住他，那是错的）：',
    '    ① 一句话能说完的琐事（改错别字 / 写快捷方式 / 查个数 / 跑一条命令）；',
    '    ② **交付物是文字的问答 / 描述 / 解释 / 建议** —— 用户要的是"说清楚"，不是"做出来"：',
    '       锁原话 + 直接答 + 收尾记一笔即可，**不派角色、不追求 check 全绿**；',
    '    ③ 用户明确说"别搞流程 / 就回答我"的。',
    '  ⚠ 反过来：**交付物是要落地的东西**（代码 / 界面 / 文件 / 配置 / 数据）⇒ 第 0 步一条都不许省。',
    '  ⚠ 拿不准时问自己一句：**用户拿到"一段文字"就满足了吗？** 是 ⇒ 走②；不是 ⇒ 走全套。',
    ` ① 工程根（有 .git 的那层）锁原话：${W} init`,
    ' ② **同一条消息里并行派两个**（别串行，省时间）：',
    `     ${W} role brief --role 资料员 --question "…" --ref R#   → subagent_liaison`,
    `     ${W} role brief --role 方向员 --question "…" --ref R#   → subagent_direction`,
    // ★★ 2026-09-24 加（从一轮**真实跑得好**的会话里抽出来的做法，
    //   用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」→「是的，写进去」）：
    //   那一轮（shape_lab 第 25 轮，81 分钟 / 171 步）里，两条任务书**具体到文件与函数**，
    //   于是资料员/方向员交回的结论**直接改写了这一轮怎么改**（一个把放行窄化并指出 UI 零提示、
    //   一个给出引擎的真实容忍边界）。对比另一轮：3 个子代理产出 2.6MB 日志，**没有改变任何实现**。
    '     ⚠ **任务书必须具体到"能拿去做决定"**，这是子代理产出有用结论还是泛泛而谈的分水岭：',
    '       写清 ① 具体对象（文件:行 / 函数 / 需求 R#）② 要回答的**具体问题**（不是"看看有没有问题"）',
    '       ③ 什么算答完（要给出处 / 数字 / 反例）④ **不许做什么**（只读就别改文件）。',
    '       反例（会白花钱）：「研究一下这个模块」；正例：「`kernel/bool3d.gd` 的 `check_operand`',
    '       硬拒契约被哪些自检/断言钉着？逐处给 `文件:行`，并指出哪一处是"谁修掉就变红"的守门断言。」',
    '     ⚠ **子代理跑完才落账**（别提前写结论）：`find add` 的内容必须是它**交回来的原话**，不是你替它总结的。',
    '     只给材料，不给你的结论。产出落台账：',
    `     ${W} find add --by 资料员 --text "…" --source "出处" --ref R#`,
    `     ${W} find add --by 方向员 --text "…" --why "指回哪条原话" --ref R#`,
    ' ③ 写软件 / 做东西之前先要一份「**维度清单**」（方向员出、资料员供事实）：',
    '     目标与非目标 · 输入与校验 · 错误与失败态 · 边界与极端值 · 性能与资源 ·',
    '     结构与可维护性 · 测试与自检 · 用法与文档 · **观感与质感**（默认值 / 措辞 / 反馈 /',
    '     对齐 / 留白 / 动效）· 兼容与依赖 · 安全 · 后续可扩展点。',
    '     适用的必须交代；不适用的写明为什么不适用 —— **没交代就是交付简陋**。',
    '',
    // ★★ 2026-09-24 加（同一条来路：从 shape_lab 第 25 轮那轮**跑得好**的会话里抽出来的做法）。
    //   那一轮的做法是：step 25 先写一个**临时探针**量出真实数字
    //   （「demo 里那把刀是 252 面 / 体积 1.435902 / 边界 0 / 非流形 0」「那 6 条非流形边来自 CSG 原始输出 121 条」），
    //   **量清了才去动 kernel/bool3d.gd**。而事故 I60 的根因恰恰是**在没量清之前就改了判据**。
    '★ **先量清，再改判据**（改内核 / 改判据 / 改契约之前的那一步，不许跳）：',
    '   写一个**临时探针**（脚本 / 最小复现），把这件事的**真实数字**量出来，贴**原样输出**，然后再动手。',
    '   · 要量的是：现状到底是多少（面数 / 体积 / 边界数 / 计数 / 耗时 / 哪一处先失败）？',
    '   · 反例（事故 I60）：没量清"那条红能不能被修掉"就把它接成了回合边界的判据 ⇒ 一句',
    '     「讲个数学笑话」被追成 25 步 / 43 次工具调用，**用户手动停掉**。',
    '   · 判据：**动手前你的正文里必须已经出现过一次真实测量输出**；只凭"读代码觉得是这样"不算。',
    '   · 探针是**临时**的：收尾要么删掉，要么写清它留在哪、为什么留（别在工程里堆一地一次性脚本）。',
    '',
    '★ 写代码要**并行派子代理**：按文件 / 模块切成互不重叠的块，在**同一条消息里**同时派多个',
    '  `subagent_coder`（`run_in_background: true`），每块一个；别一个一个串行等。',
    '  每块说清：改哪个文件、验收标准、不许碰别的文件。',
    '',
    // ★★ R35 / R36 的**窗口级**正文（2026-09-24 追加）。为什么必须在这里：
    //   这两条原来**只写进了 SPEC（工程级）**，而 SPEC 只在**那个工程**里可见 ——
    //   用户换个工程开新窗口时，它的上下文里**根本没有这两条**，只剩一句弱提示 ⇒
    //   实测（用户 2026-09-24 反馈）：「**任务中我没有主动告知的情况下，主代理还是在自己干活**」。
    //   而 R36 用户的逐字要求恰恰是「**保证我在任何新窗口都是自动使用**」⇒ 窗口级的唯一入口
    //   就是这一段（`systemPrompt.section`，`team-guard.mjs` 自己装在 roles preset 上）。
    //   ⚠ 全是**字面量**（没有时间戳、没有读数）：段文本在本进程内恒定 ⇒ 不破 KV cache。
    '★★ **R35 / R36 · 主代理不要自己写代码 —— 这是被硬拦的硬功能**（不只是这段文字）。',
    '  用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」',
    '  另两条理由（用户逐字）：「（用户原话已隐去 —— 公开版不留逐字）」',
    '  ⇒ 你（主代理）只做三件事：**切块派单 · 收集角色的原样输出 · 决定下一步**。',
    '★ **每笔改动走 R32 直线**（顺序固定、**一步都不许遗**）：',
    '  ① **复制**（先有可回滚的副本 + 记下路径与指纹）→ ② **只在副本上改**（原件在替换前一个字节都不许动）',
    '  → ③ **派角色检查**（必须有**角色署名**的检查记录；**不许拿子代理的自述当检查、不许主代理自检冒充**）',
    '  → ④ **确认无误才替换** → ⑤ 替换后复核（指纹变了 + 整体检查 exit 0）。',
    '  ⚠ 用户点名的两个漏：「**复制改完不检查**」「**检查了不替换现有的**（等于没做）」——',
    '    两条都是"看着做了、其实没做"，所以不许靠"记得"，要靠 `patch-pipeline.mjs` 的 `status` 驱动。',
    '',
    // ★★ 「派子代理时的三条硬规矩」（2026-09-24 三次真实损失）。为什么必须写进这一段：
    //   这三条原来在协议段里**一条都没有**（命中数全是 0），而每条都造成过真实损失：
    //   子代理在真文件上改了 8 分钟 · `DSH_HOME` 没指镜像导致 lab 跑真原件、得到**假绿** ·
    //   拿"再加一段提示词"当修复。⚠ 全是**字面量**（无时间戳 / 无进程号 / 无读数）：
    //   两次渲染字节必须相同 ⇒ 不破 KV cache。
    '★ **派子代理时的三条硬规矩**（三次真实损失换来的）：',
    '  ① **只改 work 副本；真文件一个字节都不许动**（副本在 `.warden/patches/<id>/work/`）。',
    '     派单时主代理必须点名那份副本；子代理改完必须**核真文件 sha 未变**并贴回。',
    '     （曾经有子代理直接改了真文件 8 分钟，跳过了整条直线。）',
    '  ② **测副本必须把 `DSH_HOME` 指到镜像 skill 目录**。',
    '     否则 lab 会跑**真原件**，得到的是**假绿**。',
    '     镜像要含 `skills\\task-warden\\{warden.mjs, bill.mjs, selftest.mjs, experiments\\lab}`。',
    '  ③ **不许用"加提示词"解决问题** —— **不要加提示词**，能写成**代码 / 声明 / hook** 的必须写成代码。',
    '     （用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」「**提示词越多越让它跑偏**」。）',
    '',
    '★★ **两道闸的形状（别把它读成"只是建议"）—— 与插件实际配的闸同一份口径**：',
    '  · **codeGate（主代理不写代码）= 硬闸**：你（主代理）对**代码文件**的',
    '    `write` / `edit` / `str_replace_editor` 会被 `tools/pre-execute` **直接 deny**，',
    '    **重试不会放行**，而且**与 `mode` 无关、不受 `maxDeniesPerSession` 限制**；',
    '  · **角色闸（③）= 减速带，不是路障**：只在"本会话还没有任何角色参与过"时拦 **一次**',
    '    （`maxDeniesPerSession`，**默认 1**）⇒ **重试即放行**。用户看到"角色闸"这个名字',
    '    容易以为它拦得住，所以这里说清：它只是把"先做第 0 步"摆到你的决策点上',
    '    （`mode` 配成 `remind` 时连这一次也不拦 —— 那是显式配置的结果，不是默认）；',
    '  · **不拦的（与 codeGate 同一口径，只有这一份，别在别处再写一张表）**：',
    '    `.warden/**`（账本 / SPEC / 任务书，以及 `patch-pipeline.mjs` 的',
    '    `.warden/patches/<P>/work/**` 工作副本 —— **那是你的活**）、`*.md`（文档）、',
    '    以及非代码文件（`.json` / `.yaml` / `.toml` / `.ini` / `.txt` … 配置与数据）；',
    '  · **一次性显式豁免（会写进账本，用完自动删）**：在工程根建一个空文件',
    '    `.warden/ALLOW-MAIN-WRITE`；或设环境变量 `DSH_TEAM_GUARD_ALLOW_MAIN_WRITE=1`',
    '    （⚠ **整个进程有效，不是一次性的**）。上面两个名字写的是**默认值**，',
    '    可配项见插件文件头「可调项」。',
    '  ⚠ 让子代理写代码**不只是"分工"**：子代理的工作过程不再进你的上下文，',
    '    后续轮次也不必重复喂它 —— 这是省 token / 省缓存的一条硬理由（见上面用户逐字）。',
    '',
    '★ 脑子（独立审查）**默认只派 1 个**。只有下面三种情况才派第 2 个，并写 `--trigger`：',
    '   ① `conflict` 结论 / 来源冲突；② `shallow` 第 1 个查得太笼统、没证据、没看完；',
    '   ③ `explore` 需要"还有哪些做法 / 哪些坑"，不是"这行不行"。',
    `   ${W} brain brief --artifact <产物> [--trigger conflict|shallow|explore]`,
    `   ${W} brain record --artifact <产物> --brain A --verdict accept|reject --issues "…"`,
    `   审查必须交可机检指控，否则判决不算数：${W} brain audit --artifact <产物>`,
    '',
    `★ 每轮收尾 ${W} record --req R# --status …；说"完成 / 修好 / 交付"之前必须 ${W} check（**exit 0 才算过**）。`,
    '  ⚠ **check 红了就不许说"完成"** —— 要么修到 exit 0，要么在正文里**逐条**说清每一条为什么现在处理不了。',
    '  ⚠ 反过来：**规则本身不是用户的要求**。为了一条"不是用户提的"规则而停下不干，比不守规则更糟；',
    '    遇到规则与用户原话冲突：**先按用户原话把活干完**，再把冲突如实报出来让他裁（别让他先拍板才肯动手）。',
    // ★★ 2026-09-24 加（R33：用户逐字「按照我们最开始的设置，这一步应该自动开始」）：
    //   实测现场：七席投完票（7/7、无一席反对骨架、10 条收敛点），主代理却回头问用户
    //   "你说继续，我就开" —— 而用户的任务书原文是「收集的资料已经足够多了。**派子代理进行逐条的修改**」。
    //   这违反了 `AGENTS.md` 里已经写着的一条：「遇到规则与用户原话冲突：**先按用户原话把活干完**，
    //   再把冲突如实报出来让他裁（**别让他先拍板才肯动手**）」。
    '★ **直线动作必须自动推进 —— 不许停下来等用户拍板**（R33）：',
    // ★★ 2026-09-24 加（R34：用户逐字「我想这个功能做一个可以勾选的功能，相当于一种放权功能」）：
    //   ⚠ 与 R28 不冲突：R28 管"**别谎报完工**"，R33/R34 管"**别空等**" —— 一个拦谎报，一个拦空等。
    //   **默认不勾**（未放权）；勾上（放权）才自动推进。开关落在文件里（不许只放进程内存）。
    (function () {
      try {
        // ⚠ 这是 **ES 模块** —— 顶部已经 `import fs from 'node:fs'` 等（第 71-73 行），
        //   这里**不许用 `require`**（第一次写的时候用了 ⇒ 抛异常被 catch 吞掉 ⇒ 永远落 fallback）。
        const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
        // ★ 放权开关放"稳定可发现"的地方：**全局**一份（一次勾选、所有窗口生效）+ 工程一份（可单独覆盖）
        const cands = [
          path.join(home, 'autonomy.json'),                        // 全局（推荐：勾一次全窗口生效）
          path.join(process.env.WARDEN_ROOT || process.cwd(), '.warden', 'autonomy.json'),  // 工程根
        ]
        for (const p of cands) {
          if (!fs.existsSync(p)) continue
          // ⚠ 去 BOM：PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，
          //   而 `JSON.parse` 遇到 BOM 直接抛 ⇒ 被 catch 吞掉 ⇒ 永远落 fallback（实测踩过）。
          const o = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
          if (String((o && o.mode) || '').toLowerCase() === 'on') {
            return '  ★★ **用户已放权（`' + p + '` = on）**：他下过令的下一步**直接执行**，不许再要一次授权；'
              + '"程序上要先投票/先讨论"**不是**停下来的理由（投票与讨论是机制该自己跑的）。'
              + '⚠ 放权**不解除任何闸**（check / 交付闸 / 角色检查 / patch-pipeline 的"没检查不许替换"一律照旧）。'
          }
          return '  ⚠ **未放权（`' + p + '` = off，默认）**：缺"只有用户才知道的事实"时**要问**，但**同一主题只问一次**；'
            + '⚠ 但**不许拿"要不要继续"去问他** —— 那是他已经下过令的事（他逐字：「（用户原话已隐去 —— 公开版不留逐字）」）。'
        }
      } catch (e) { /* 读不到就按未放权 */ }
      return '  ⚠ **未放权（默认，没找到开关文件）**：缺"只有用户才知道的事实"时要问，但**同一主题只问一次**；不许拿"要不要继续"去问他。'
    })(),
    '  · **用户已经下过令的下一步，直接执行**，不许再要一次授权；',
    '  · "程序上要先投票 / 要先讨论"**不是**停下来的理由 —— **投票与讨论是机制该自己跑的**，不是让用户拍板；',
    '  · 直线动作（复制 → 改 → 角色检查 → 替换）**每一步做完就推进下一步**，靠 `patch-pipeline.mjs` 的 `status` 驱动；',
    '  · 确实缺"只有用户才知道的事实"时才问，且**同一主题只问一次**；',
    '  · ⚠ 若"规则"与"用户原话"冲突：**先按用户原话把活干完**，再如实报冲突让他裁。',
    '  · ⚠ **收尾前必须跑 `patch-pipeline.mjs status`** —— 有卡住的（复制了没检查 / 检查了没替换 / 绕过管线改原件）⇒ **不许说"做完了"**。',
    // ★★ 2026-09-24 补（C3 的根，也是事故 I60 给**模型侧**的同一条教训）：
    //   实测：一个"描述功能"的会话，交付物在 step 18 就写完了，之后**又跑了 59 步** ——
    //   它一直在追一个**修不掉**的 check 红（那个账本里一条需求都没有 ⇒ 干活再多也不会变绿）。
    //   插件侧已经为此收紧（普通 check 红不再 steer）；模型侧也必须知道这条两分法。
    '  ⚠ **check 红要分清两种，处置完全不同**：',
    '    ① **配置性 / 结构性**的红（缺 `.warden/SPEC.md`、账本里一条需求都没有、原话没认领）——',
    '       那不是"活没干完"，**不许为它反复重试**；如实报一句"这是账本配置缺口，不是本轮交付的问题"即可。',
    '    ② **真·活没干完**的红（需求对不上、`不要` 没交代、报了 done 没对账）——',
    '       必须处理到 exit 0，或逐条说清每一条为什么现在处理不了。',
    '  ⚠ **分不清时按 ② 处理，但一样不许无限重试**：同一个红连着追 2 次没进展，就停下来报出来。',
    '    （事故 I60：一句"讲个数学笑话"被追成 25 步 / 43 次工具调用，用户手动停掉。）',
    '★ 角色说话按「名字 · 职称：原话」**直接显示，不许你转述**（`role say` 写、`role scan` 自查）。',
    '',
    // ★★ 多点门控：角色不是只在第 0 步参与，而是贯穿整个任务。
    '★ **角色贯穿全程**（不是只在第 0 步走个过场）：',
    '  · 每改一个文件 ⇒ 记录员记一笔（`record`）；',
    '  · 每声称一个事实 ⇒ 审查要证据（`find add --source`）；',
    '  · 每做一个设计决定 ⇒ 方向员签字（`find add --by 方向员`）；',
    '  · **声称 done**（`record --status done`）⇒ 必须 `check` 且 exit 0（**硬闸，重试不放行**）；',
    '  · **交付**（`present`）⇒ 必须先派脑子审查（`brain record`，**硬闸，重试不放行**）；',
    '  · 出现偏差（交付物与 SPEC 对不上）⇒ 派资料员查原因 + 方向员分析影响面 + 投票。',
    '  角色是不是在跑，看 `roles --health` 的机械仪表，不靠自我申报。',
    '',
    '★ **遇到一般问题时的分诊流程**（不许直接问用户 —— 先内部分诊）：',
    '  触发：遇到方案选择 / 设计决策 / 歧义消解（**不是**状态查询、不是用户明确要求你做的事）。',
    '  ① 提问闸门先判断值不值得占用用户时间：',
    `    ${W} role say --role 提问闸门 --text "这事值不值得占用用户的时间？我的判断：…"`,
    '  ② 值得讨论的一般重大问题 —— 资料员收集资料：',
    `    ${W} role brief --role 资料员 --question "…" --ref R#   → subagent_liaison`,
    `    产出落台账：${W} find add --by 资料员 --text "…" --source "出处" --ref R#`,
    '  ③ 所有有票角色投票（7 席）：',
    `    ${W} vote cast --topic "议题" --role <角色> --choice "选项" --reason "为什么"`,
    '  ④ 看计票结论：',
    `    ${W} vote --topic "议题"`,
    '    · 过半（4/7 席）选同一选项 ⇒ 按结论走（**不问用户**）；',
    '    · 未过半 / 分歧 ⇒ 继续补票、或换一个更具体的议题重投；',
    '  ⑤ 投票决定不了（补完票仍不过半）⇒ 才推给用户，并附各方意见与票数。',
    '  ⚠ **交付（present）前有未决议的投票会被硬拦** —— 必须先投出过半结论或明确推给用户。',
    // ⚠ 配置读不出来时**在这一段里也说出来**（不只在状态行）—— 用户照文档写了配置却静默无效，
    //   正是"不稳定"的一种；这里说清"文件在、但读不出来、现在用的是默认值"。
    ...(configIssue !== null && configIssue !== undefined
      ? ['',
        `⚠ **插件配置 \`${configIssue.file}\` 存在，但读不出来**`
        + `（${configIssue.line === null || configIssue.line === undefined ? '行号认不出来（Node 没给定位）/ ' : `第 ${configIssue.line} 行 / `}${configIssue.kind}）：${configIssue.message}`,
        '  现在用的是**默认值** —— 写 `{"codeGate":"off"}` 之类**不会生效**。',
        '  先把那个文件修好（常见原因：**带 BOM**、JSON 语法错、字段名拼错）；'
        + '**注意这与"没写配置"不是一回事**，别把"配置没生效"读成"闸不管用"。']
      : []),
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

/**
 * ★ R36 的拒绝理由 —— **主代理写代码文件**时给的那一段。
 *
 * 用户要求："**拒绝理由必须可操作**：写清'该派子代理 / 走哪条命令'，不许只写'不许'。"
 * 所以这里必须给出：① 派谁（`subagent_coder`）；② 怎么派（工具名 + `run_in_background` + 任务书要写什么）；
 * ③ 什么**不**被拦（免得为了记账/写文档去绕路）；④ 真要自己写时**怎么做且会留痕**。
 *
 * ⚠ 里面**不许**出现 `pwsh` 绕过写法之类的话 —— 那等于教绕路（洞写在文件头 ⑤，不写进拒绝理由）。
 * @param {string} file 被拦下的目标文件（调用方给的原始 `file_path`）
 * @param {string|null} root 工程根（找不到就 null）
 * @param {string} [warden] warden.mjs 绝对路径
 * @param {{codeExemptEnv:string, codeExemptToken:string}} [opts] 豁免配置（让理由与实际配置一致）
 * @param {string} [why] `codeGateDecision` 给的判据名（`main-agent-writes-code` / `no-path` / `exempt-untraced`）
 * @param {string} [note] 额外要说清的一件事（例：**规范化之后真实落点在哪** —— R36 复查：
 *   `src/foo.js::$DATA` 与 `.warden/../src/a.js` 的判决必须落在真实落点上，理由里要讲明白）
 * @returns {string}
 */
export function codeDenyReason(file, root, warden = wardenPath(), opts = DEFAULTS, why = 'main-agent-writes-code', note = '') {
  const W = `node "${warden}"`
  const where = root !== null && root !== undefined ? root : '（**工程根没找到** —— 见下面第 4 步）'
  const head = why === 'no-path'
    ? ['【九月项目团 · 主代理不写代码】你（主代理）正要调用一个**写文件的工具**，',
      '但这次调用的参数里**读不到 `file_path`** —— 我判不出它是不是代码文件。',
      '按本插件的规矩**判不出来就不放行**（宁可吵，不许静默失效），所以这次被拒。']
    : why === 'exempt-untraced'
      ? ['【九月项目团 · 主代理不写代码】这次走的是一次性豁免，但**豁免的痕迹没能写进账本**，',
        '所以**不算数**（"必须留痕"是硬条件）。']
      : ['【九月项目团 · 主代理不写代码（硬闸，不是建议）】',
        `你（**主代理**）正要写一个**代码文件**：\`${file}\``,
        ...(note === '' ? [] : ['', `⚠ ${note}`]),
        '',
        '这个插件的硬规则：**主代理不写代码，代码由子代理（实现工程师）写**。',
        '本次拒绝由 `tools/pre-execute` 返回 `{kind:"deny"}`，**重试不会放行**，',
        '也不受 `maxDeniesPerSession` 限制（那条只管上面那个"角色还没参与"的减速带）。']
  return [
    ...head,
    '',
    '── 该怎么办（照抄） ──────────────────────────────────────────',
    '1) **把这一块活派给 `subagent_coder`（实现工程师）**：',
    '   工具 `subagent_coder`，参数 `{ description: "改 <文件>", prompt: "<任务书>", run_in_background: true }`。',
    '   · 按**文件 / 模块**切成互不重叠的块，在**同一条消息里**同时派多个（别串行等）；',
    '   · 每份任务书要写清：**改哪个文件**、**验收标准**、**不许碰别的文件**；',
    '   · 它跑完会把「改了哪些文件 / 为什么 / 自检命令 + 原样输出」交回来，你**只读不改**。',
    '   ⚠ 这不只是分工：子代理的工作过程不进你的上下文，后续轮次也不必重复喂它 —— **省 token / 省缓存**。',
    '',
    '2) **如果这一轮还没做第 0 步**（没有角色参与过），先把第 0 步补上再派实现工程师：',
    `   ${W} init                                   # 工程根 = 有 .git 的那一层`,
    `   ${W} role brief --role 资料员 --question "…" --ref R#`,
    `   ${W} role brief --role 方向员 --question "…" --ref R#`,
    '   把两段任务书整段丢给 `subagent_liaison` / `subagent_direction`（同一条消息里一起派）。',
    '',
    '3) **这些不被拦，直接写**（别为它们去绕路）：',
    '   · `.warden/**` —— **整棵目录**都不拦：账本 / `SPEC.md` / `ROUNDS.jsonl` / 任务书，',
    '     以及 `patch-pipeline.mjs` 的 `.warden/patches/<P>/work/**` 工作副本（**那是你的活**）；',
    '   · `*.md` —— 文档；',
    '   · 非代码文件 —— `.json` / `.yaml` / `.yml` / `.toml` / `.ini` / `.txt` 等配置与数据。',
    '   ⚠ 判据是**规范化之后的真实落点**：`.warden/../src/a.js` **不是**账本，它落在 `src/a.js`；',
    '     写完之后真正出现的是 `src/a.js`（那是一个代码文件）—— 所以它**照拦**。',
    '',
    '4) **真要自己写这一次**（一次性豁免，**会往账本追一行**）：',
    `   · 建一个空文件：\`${where}/.warden/ALLOW-MAIN-WRITE\`  （正斜杠，Windows 也认）`,
    '     —— 存在即放行**一次**，用完自动删；',
    `   · 或设环境变量 \`${opts.codeExemptEnv}=1\` —— ⚠ **整个进程有效，不是一次性的**；`,
    `   · 两条都往 \`${EXEMPTION_LEDGER}\`（在工程根的 \`.warden/\` 里）追一行；`,
    '     **留痕写不进去 ⇒ 这次豁免不算数，照样 deny**。',
    '   · 想长期关掉这道闸（用户明确要求过"自动生效"，所以这是**显式**动作）：',
    '     在 preset 目录的 `team-guard.json` 里写 `{"codeGate":"off"}`。',
    // ⚠ 这里**故意不写具体的 shell 命令名**：厂房里有一条断言钉着"拒绝理由不许出现 shell 绕过写法"
    //   （它只做朴素子串匹配）。说的是同一个坑（UTF-8 写文件时会多出 BOM），但**不教任何命令**。
    '     ⚠ 写它**别带 BOM** —— Windows 上有些编辑器 / 脚本用 UTF-8 落盘时**会默认加上 BOM**，',
    '       而旧版遇到 BOM 会**静默失效**（这正是"照文档写了却没生效"的那个坑）。',
    '       本插件现在会**去 BOM**；即使还有别的读不出来的原因，',
    '       状态行也会明说"**配置存在但读不出来**（第 N 行 / 原因）"—— 不会再静默回默认。',
    '',
    '⚠ 别拿"我自己写更快"当理由：这条闸就是用户点名要的（原话见插件文件头 ⑤）。',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────── 纯判据（自检直接调这些）

/**
 * done 闸的拒绝理由 —— 声称 done 但 check 没通过。
 * @param {string} [warden] warden.mjs 绝对路径
 * @returns {string}
 */
export function doneGateReason(warden = wardenPath()) {
  const W = `node "${warden}"`
  return [
    '【九月项目团 · 声称 done 被拦】你正要 `record --status done`，但 **check 还没通过**：',
    '',
    '「完成 / 修好 / 交付」之前必须先跑 check 且 **exit 0**：',
    `  ${W} check`,
    '',
    '如果 check 是红的，分两种处置：',
    '  ① 配置性 / 结构性的红（缺 SPEC.md、账本空）→ 如实报"账本配置缺口"，不为它反复重试；',
    '  ② 真·活没干完的红（需求对不上、不要没交代、报了 done 没对账）→ 处理到 exit 0，',
    '    或逐条说清每一条为什么现在处理不了。',
    '  ⚠ 分不清时按 ② 处理，但同一个红连着追 2 次没进展就停下来报出来。',
    '',
    '⚠ **重试不会放行**：必须真跑 check 且 exit 0，然后才能 record --status done。',
  ].join('\n')
}

/**
 * present 闸的拒绝理由 —— 交付但脑子没审查过。
 * @param {string} [warden] warden.mjs 绝对路径
 * @returns {string}
 */
export function presentGateReason(warden = wardenPath()) {
  const W = `node "${warden}"`
  return [
    '【九月项目团 · 交付被拦】你正要交付（present），但 **脑子还没审查过**：',
    '',
    '交付之前必须派至少 1 个脑子做独立审查：',
    `  ${W} brain brief --artifact <产物>`,
    `  ${W} brain record --artifact <产物> --brain A --verdict accept|reject --issues "…"`,
    `  ${W} brain audit --artifact <产物>`,
    '',
    '脑子默认只派 1 个；只有冲突 / 查得不细 / 要探索更多做法时才派第 2 个（写 --trigger）。',
    '审查必须交可机检指控，否则判决不算数。',
    '',
    '⚠ **重试不会放行**：必须真跑 brain record，然后才能交付。',
  ].join('\n')
}

/**
 * 分诊闸的拒绝理由 —— 交付但有未决议的投票。
 * @param {string} [warden] warden.mjs 绝对路径
 * @param {string[]} [topics] 未决议的议题列表
 * @returns {string}
 */
export function triageGateReason(warden = wardenPath(), topics = []) {
  const W = `node "${warden}"`
  const list = (Array.isArray(topics) ? topics : []).map((t) => `  · ${t}`).join('\n')
  return [
    '【九月项目团 · 交付被拦】你正要交付（present），但有 **未决议的投票**：',
    '',
    list,
    '',
    '交付前必须把这些议题投出过半结论（4/7 席选同一选项 = 已决议）：',
    `  ${W} vote --topic "…"        看计票状态`,
    `  ${W} vote cast --topic "…" --role <角色> --choice "…" --reason "…"   补票`,
    '',
    '· 过半 ⇒ 按结论走（不问用户）；',
    '· 补完票仍不过半 / 分歧 ⇒ 才推给用户，并附各方意见与票数。',
    '⚠ **重试不会放行**：必须真把未决议的 topic 投出过半结论，然后才能交付。',
  ].join('\n')
}

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
 * 一次工具调用算不算"声称 done"（`warden.mjs record --status done`）。
 * 这是**关键决策点**：声称 done = 宣布完成，必须先过 check。
 * @param {string} toolName
 * @param {unknown} args
 * @returns {boolean}
 */
export function isDoneClaimCall(toolName, args) {
  if (toolName !== 'pwsh' && toolName !== 'bash') return false
  const cmd = args !== null && typeof args === 'object' && typeof args.command === 'string' ? args.command : ''
  return /warden\.mjs["']?\s+record\b/.test(cmd) && /--status\s+done/.test(cmd)
}

/**
 * 一次工具调用算不算"派了脑子审查"（`warden.mjs brain record`）。
 * @param {string} toolName
 * @param {unknown} args
 * @returns {boolean}
 */
export function isBrainRecordCall(toolName, args) {
  if (toolName !== 'pwsh' && toolName !== 'bash') return false
  const cmd = args !== null && typeof args === 'object' && typeof args.command === 'string' ? args.command : ''
  return /warden\.mjs["']?\s+brain\s+record/.test(cmd)
}

/**
 * 一次工具调用算不算"交付"（`present` 工具）。
 * @param {string} toolName
 * @param {unknown} args
 * @returns {boolean}
 */
export function isPresentCall(toolName, args) {
  return toolName === 'present'
}

/**
 * 从 `check` 的**输出文本**里读出判决。
 *
 * ⚠ 为什么必须有这个：第一版只记"`check` **跑过**没有"，于是状态行在
 *   `需求监督未通过：4 条` / `check-exit=1` 的同一步里照样印 **`check ✓`**。
 *   实测（2026-09-23，会话 11622ba2）：模型看到 `check ✓`，然后跟用户说
 *   「**做完了三件事**」—— 而 check 是红的。
 *   **一句假话进了每一步的上下文**，这就是"没做完就说做完了"的直接来源。
 *   这与本项目那句「没查到 ≠ 查了没问题」是同一类：**"跑过" ≠ "过了"**。
 *
 * 判据用 warden.mjs 自己打的**固定尾行**（比解析 exit code 稳，也不受 pruner 影响：
 * 它在输出末尾，而 pruner 保留 tail）：
 *   `需求监督通过：…` / `需求监督未通过：N 条`
 * @param {string} text 工具结果正文
 * @returns {{passed:boolean, failed:number|null}|null} 认不出来返回 null（**不许猜**）
 */
export function parseCheckVerdict(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const miss = /需求监督未通过[：:]\s*(\d+)\s*条/.exec(text)
  if (miss !== null) return { passed: false, failed: Number(miss[1]) }
  if (/需求监督通过[：:]/.test(text)) return { passed: true, failed: 0 }
  return null
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
    if (header === null || header === undefined) return false
    // 正面证据①：`origin` 只可能是 `'subagent'`（`dsh-session/lib/index.js:790`），
    // 子代理创建时真的写进去（`dsh-subagent/lib/index.js:510`）。
    if (header.origin === 'subagent') return true
    // 正面证据②：`delegationDepth >= 1`。**活证据**（本机真日志，见文件头 ⑤）：
    //   顶层 `session-ccc30000-…` / `session-ddd40000-…` ⇒ `delegationDepth: 0`；
    //   子代理 `4b6bfe7e-…` ⇒ `delegationDepth: 1` + `origin:"subagent"`。
    //   ⇒ 这条**只会多判出"子代理"**，不会把子代理判成主代理；
    //     它把"origin 万一没被写进去"时的误伤窗口关小，方向的取舍与原来一致（宁可吵）。
    return typeof header.delegationDepth === 'number' && header.delegationDepth >= 1
  } catch {
    return false
  }
}

/**
 * 这个 agent 是不是**本会话的主代理**。
 *
 * 就是 `isSubagent` 的取反 —— **判据只有这一条**，不做第二套：
 * 两个判据 = 两处会漂移的真相（本项目的老病）。
 * @param {unknown} agent
 * @returns {boolean}
 */
export function isMainAgent(agent) {
  return !isSubagent(agent)
}

/**
 * 从工具参数里取**目标文件路径**。
 *
 * 字段出处（查过的，不是猜的）：
 *   · `write` / `edit` ⇒ `file_path`：`dsh-tool-fs/lib/index.js:597` / `:742`，
 *     两者的 schema 都在 `dsh-tool-fs/lib/types/write.d.ts:17` / `edit.d.ts:24`；
 *   · `str_replace_editor` ⇒ `path`：`dsh-tool-str-replace-editor/lib/index.js:266` / `:280`。
 * ⇒ 两个字段都认（先 `file_path` 后 `path`），**不按工具名分叉**：
 *   工具改名/换字段时少一处要跟着改。
 *
 * ⚠ `exec.arguments` 在 `tools/pre-execute` 时**已经是解析好、冻结过的 JSON 快照** ——
 *   `dsh-tools/lib/index.js:3055`（`snapshotJsonValue(exec.arguments)`）+ `:3059`
 *   （`arguments: deepFreeze(detached)`），而 pre-execute 在 `:3116` 才被派发。
 *   所以这里读到的是**返回值**，不是待解析的原始字符串。
 * @param {unknown} args
 * @returns {string|null}
 */
export function targetPathOf(args) {
  if (args === null || typeof args !== 'object') return null
  for (const key of ['file_path', 'path']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim().length > 0) return v
  }
  return null
}

/**
 * 截掉 NTFS **备用数据流（ADS）** 后缀：`a.js::$DATA` 的**真实落点就是** `a.js`。
 *
 * 为什么必须有它（「审查」原样输出）：第一版对 `src/foo.js::$DATA` 算出的扩展名是
 * `.js::$data`（认不出来 ⇒ 放行），而**写完之后 `a.js` 真的存在** ——
 * 判决说"不是代码"，OS 层面**真造出了一个 .js 文件**。
 *
 * 只在**基础名**上按第一个 `:` 截断：盘符 `C:` 在 dirname 段里，不在 basename 上，
 * 所以不会被误伤（本函数只用于已经过 `path.resolve/normalize` 的路径）。
 * @param {string} p
 * @returns {string}
 */
function stripAdsSuffix(p) {
  const s = String(p)
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  const head = slash >= 0 ? s.slice(0, slash + 1) : ''
  const base = slash >= 0 ? s.slice(slash + 1) : s
  const cut = base.indexOf(':')
  return cut >= 0 ? `${head}${base.slice(0, cut)}` : s
}

/**
 * ★★ **去掉尾随点 / 尾随空白后再判扩展名**（R36 复查第 4 条）。
 *
 * 「审查」实测：`x.js.`（算出的扩展名是 `.`）· `x.js␠`（`.js `）· `x.js.␠` **零歧义却全被放行**。
 * 它的夹具目录我**找到了、逐字节核过**：`<HOME>\AppData\Local\Temp\pm4-win-Thtdbh\`
 *   `x1.js␠`(尾字节 0x20) · `x2.js.` · `x3.js` · `x4.js.` · `x5.js␠`(**尾字节 C2 A0 = U+00A0**)
 * ⇒ 我上一轮**测过却没写进"已知的洞"**，是**漏记**。
 *
 * ⚠⚠ **落点到底是哪一个 —— 我自己在这台机器上实测过，两种行为都有，不许含糊**：
 *   · 走 **Node 的 fs**（= DSH `write` / `edit` 工具真正用的那条路，也**正是这道闸要看住的那条路**）：
 *     `fs.writeFileSync('x.js.')` 落盘的名字**就是 `x.js.`**（`readdir` 里 78 2e 6a 73 2e），
 *     而 `statSync('x.js')` ⇒ **ENOENT**。⇒ 两个名字，**不是同一个文件**（libuv 会走 `\\?\` 前缀）。
 *   · 走 **cmd / PowerShell 的重定向**（都实测过）：`echo c> z.js.` 与 `Set-Content z.js.`
 *     落盘的名字**是 `z.js`**（尾随点被 Win32 解析器丢掉）。
 *   ⇒ 所以：**本条的准确描述是"扩展名黑名单漏了一种零歧义的代码名"**，
 *     **不是**"x.js. 是 x.js 的别名"（后者只有 shell 那条路成立，而 shell 写文件本来就是
 *     文件头「已知的洞」里记着**不堵**的那一条）。
 *   ⇒ 处置：**故意收紧** —— 判扩展名之前去掉尾随点/空白，`x.js.` ⇒ 认出 `.js` ⇒ **拦**。
 *     代价极小：子代理本来就不受这道闸管，主代理真需要时还有留痕的一次性豁免。
 *     ⚠ 方向是**收紧**，**不拿"跟着 OS 落点走"当理由**（那句话在本机是半真半假的，已写清）。
 *
 * 去掉的是什么（**比 Windows 多收一点，收在严的一侧**）：
 *   · Windows 丢的是 **ASCII 空格(0x20) 与点**（实测 cmd / PowerShell 都是这个行为）；
 *   · 这里用 `[.\s]+$`，`\s` **还覆盖 U+00A0 / U+3000 等空白** —— 因为审查夹具里
 *     `x5.js` 的尾字节就是 **U+00A0**（Windows **不**丢它），而它是**同一个形状的零歧义代码名**。
 *     多收这一点只会**多拦**，不会放行；真要写这种名字，走子代理或一次性豁免。
 *
 * 逐段处理（**保留原来的分隔符**，UNC `\\server\share` 与盘符 `C:` 都不动）：
 *   · 段是 `.` / `..` ⇒ 原样保留（`path.resolve/normalize` 已经把 `..` 折叠过了，
 *     这里是防御性的，绝不把 `..` 吃掉）；
 *   · 其余段 ⇒ 去掉尾随的 `[.\s]`。
 * ⚠ **只用于"判扩展名 / 判是不是代码"**，`ledgerScopePath` 用的是**没去尾**的那一份 ——
 *   否则 `proj\.warden.\x.js` 会被当成账本放行（那是**放宽**，本项目明令不许）。
 * @param {string} p
 * @returns {string}
 */
function trimWindowsTail(p) {
  const s = String(p)
  if (s.length === 0) return s
  return s.split(/([\\/])/).map((seg, i) => {
    if (i % 2 === 1) return seg                       // 分隔符本身
    if (seg === '.' || seg === '..') return seg       // 绝不吃掉相对段
    return seg.replace(/[.\s]+$/, '')
  }).join('')
}

/**
 * ★★ **判决用的规范化路径**（R36 复查第 1 条的核心）。
 *
 * 第一版在**未规范化的原始字符串**上按 `/` 分段找 `.warden`、也没按 `:` 截断，
 * 于是这三条**不经 shell** 的路径全被放行（OS 层面真实落点在别处）：
 *   `.warden/../src/a.js` · `src/.warden/../../evil.js` · `.warden\..\src\a.js`
 * 以及 NTFS 备用数据流 `src/foo.js::$DATA`（**实测真造出了 `a.js`**，见 `stripAdsSuffix`）。
 * 另加 R36 复查第 4 条的同类第三条：**尾随点 / 尾随空格**（见 `trimWindowsTail` 的实测口径）。
 *
 * **基目录的判据（查过的，不是猜的）**：`dsh-tool-fs/lib/index.js:225-242`
 * （`session-cwd.js`）逐字写着，fs 工具解析相对路径用的是
 * "the calling agent's per-session workspace (**`exec.agent.session.header.cwd`**) …
 *  rather than `process.cwd()` at the tool boundary"。
 * ⇒ 所以基目录取 **会话工作区 cwd**，`path.resolve(cwd, file)` 与工具的真实落点**同源**：
 *   · 绝对路径 ⇒ `path.resolve` 返回它自己（`..` 照样折叠）⇒ 正确；
 *   · 相对路径 ⇒ 以会话工作区为基 ⇒ 与工具一致；
 *   · 读不到 cwd ⇒ 退成 `path.normalize(file)`（**词法**折叠 `..`），并在返回值里
 *     如实标成 `base:'lexical'`（不假冒"按会话工作区算过"）。
 *
 * ⚠ 有界的已知偏差：`dsh-tool-fs/lib/index.js:252-255` 里，带 sandbox policy 的调用会把基目录
 *   换成 `policyWorkspaceRoot`；本插件在 `tools/pre-execute` 读不到它 ⇒ 以会话工作区近似。
 * @param {string} file 调用方给的原始路径（**原样**，不许先清洗）
 * @param {string|null|undefined} [cwd] 会话工作区（`exec.agent.session.header.cwd`）
 * @returns {{path:string, resolved:string, ledgerPath:string, base:'session-cwd'|'lexical', ads:boolean, winTail:boolean}}
 *   `path` = 判**扩展名**用的名字（已截 ADS、已去 Windows 尾随点/空格）；
 *   `ledgerPath` = 判**豁免面（`.warden` 段）**用的路径（已截 ADS，**不**去尾 —— 见 `trimWindowsTail`）；
 *   `resolved` = **这两步之前**的规范化路径（`fileExemptionWhy` 拿它做
 *   "POSIX 上 `:` 是合法字符"的双保险）；`winTail` = 这次是否做过尾随点/空格修剪。
 */
export function normalizeTargetPath(file, cwd) {
  const raw = typeof file === 'string' ? file : ''
  if (raw.length === 0) {
    return { path: '', resolved: '', ledgerPath: '', base: 'lexical', ads: false, winTail: false }
  }
  const useCwd = typeof cwd === 'string' && cwd.length > 0
  let p = raw
  try {
    p = useCwd ? path.resolve(cwd, raw) : path.normalize(raw)
  } catch { /* 规范化坏了 ⇒ 退回原样（下面照旧判；绝不许抛） */ p = raw }
  const stripped = stripAdsSuffix(p)
  const landed = trimWindowsTail(stripped)
  return {
    path: landed,
    resolved: p,
    ledgerPath: stripped,
    base: useCwd ? 'session-cwd' : 'lexical',
    ads: stripped !== p,
    winTail: landed !== stripped,
  }
}

/**
 * 取小写扩展名（带点）。`.gitignore` 这种"点在开头"的**不算扩展名**（→ `''`）。
 *
 * ⚠ 判扩展名之前做两件事（顺序不能换）：
 *   ① 按 `:` 截掉 NTFS 备用数据流：`x.js::$DATA` 的真实扩展名是 **`.js`**（不是 `.js::$data`）；
 *   ② 去掉 Windows 会自己丢掉的尾随点/空格：`x.js.` / `x.js␠` 的真实文件名就是 `x.js`。
 *   ⚠ 但 **POSIX 上 `:` 是合法文件名字符**（没有 ADS）⇒ 单靠这一个函数会把 `foo:bar.js` 看成
 *     无扩展名。所以 `fileExemptionWhy` 会**同时**算"截断"与"不截断"两种扩展名，任一认出是代码就拦
 *     —— 这样堵 Windows 的 ADS **不会**反过来在 POSIX 上放宽。
 *     ★ 而且 R36 复查第 5 条把这条双保险**挪到了文档豁免之前**：原来文档支排在代码支前面，
 *       于是 `a.md:x.js` / `README.md:payload.js`（不改判据前是 deny、之后变成 allow）
 *       恰恰从那条"双保险"里漏了出去 —— 文件头那句"不会在 POSIX 上放宽"被证伪。
 * @param {string} file
 * @returns {string}
 */
export function fileExtension(file) {
  return basenameExt(stripAdsSuffix(String(file).replace(/\\/g, '/')))
}

/**
 * 取基础名的小写扩展名。**不截 ADS**（给 `fileExemptionWhy` 做双保险用），
 * 但**照做 Windows 尾随点/空格的修剪**（同一类落盘语义，没理由只做一半）。
 * @param {string} p
 * @returns {string}
 */
function basenameExt(p) {
  const base = trimWindowsTail(String(p).replace(/\\/g, '/')).split('/').pop() ?? ''
  const b = base.toLowerCase()
  const dot = b.lastIndexOf('.')
  return dot > 0 ? b.slice(dot) : ''
}

/**
 * ★ `.warden/**` 豁免的**判据路径**（R36 复查第 2 条）。
 *
 * **这一条是上一轮新引入的 deny→allow，必须修**：「审查」实测，夹具 `cwd = …\proj\.warden\sub`
 * 时 `x.js` / `src/a.js` / `.warden/../src/a.js` / `sub/x.ts` / `deep/nest/y.cpp` …
 * **8/8 条路径全部 allow(why=exempt-ledger)**（同一批路径在普通 cwd 下 8/8 全 deny）。
 * 根因：上一轮把 cwd 引进 `fileExemptionWhy` 之后，`.warden` 是在
 * `path.resolve(cwd, file)`（**绝对落点**）上找的 ⇒ **cwd 自己在 `.warden` 里**时，
 * 解析出来的每一段都带着那个 `.warden` ⇒ **整片放行**。
 * 改前那个函数**签名里根本没有 cwd**：所以这条放行是**这一轮才出现的**，不是我继承来的。
 *
 * **判据（两步，写清在这里）**：
 *   ① 先规范化（`path.resolve(cwd, file)` → 截 ADS → 去 Windows 尾随点/空格）；
 *   ② 再看"**这个落点相对 cwd 的那一段**"：
 *      · 落点在 cwd **里面**（`path.relative` 不以 `..` 开头）⇒ **只判那一段相对路径**：
 *        - `cwd = …\.warden\sub`、`file = 'x.js'` ⇒ 相对段 `x.js`（**不含 `.warden`**）⇒ 不是账本 ⇒ `x.js` 照拦 ✓
 *        - `cwd = …\proj`、`file = '.warden/../src/a.js'` ⇒ 落点 `proj\src\a.js` ⇒ 相对段 `src/a.js` ⇒ 照拦 ✓
 *        - `cwd = …\proj`、`file = '.warden/SPEC.md'` ⇒ 相对段 `.warden/SPEC.md` ⇒ 是账本 ⇒ 放行 ✓
 *      · 落点在 cwd **外面**（`..` 开头 / 另一个盘 / 没有 cwd）⇒ 判**绝对落点**：
 *        - 显式写的 `D:\proj\.warden\SPEC.md`，或 `cwd = …\.warden\sub` 时写的 `../ROUNDS.jsonl`
 *          （它在 `.warden` 里）⇒ 照旧放行 ✓
 *        - 没有 cwd（读不到 header）⇒ 只能判词法落点，行为与以前一致。
 * ⚠ 有界的残留（如实写，别当没看见）：段名是 `.warden␠`（**带尾随空格**）时本判据认不出来 ⇒
 *   那一层里的代码文件**照拦**（更严的一侧，不是绕过）。
 * @param {string} file
 * @param {string} [cwd] 会话工作区
 * @returns {string} 用来找 `.warden` 段的那条路径（空串 = 无从判起）
 */
export function ledgerScopePath(file, cwd) {
  const norm = normalizeTargetPath(file, cwd)
  // ⚠ 用 `ledgerPath`（**没去尾随点/空格**的那一份）：`proj\.warden.\x.js` 绝不许被当成账本 ——
  //   那是一处**放宽**，而这条判据存在的理由就是"别放宽"。
  if (norm.ledgerPath.length === 0) return ''
  if (typeof cwd !== 'string' || cwd.length === 0) return norm.ledgerPath   // 没有基目录 ⇒ 只能判词法落点
  let rel = null
  try {
    rel = path.relative(path.resolve(cwd), norm.ledgerPath)
  } catch { return norm.ledgerPath }
  if (rel.length === 0) return norm.ledgerPath
  // 落点在 cwd 外面（`..` 开头 / 不同盘符 ⇒ path.relative 会给绝对路径）⇒ 判绝对落点
  if (rel.startsWith('..') || path.isAbsolute(rel)) return norm.ledgerPath
  return rel
}

/**
 * 路径是否落在 `.warden/` 里（**任意一层**叫 `.warden` 就算）。
 * 用"分段相等"而不是 `includes('.warden/')`：后者对 `.warden` 结尾、
 * 或 `x.warden/y` 这种相似名字会判错。
 *
 * ⚠ **先规范化再分段**（R36 复查）：`.warden/../src/a.js` 的词法尾巴里**没有** `.warden`
 *   —— 第一版没规范化 ⇒ 把它当成账本放行了，而真实落点是 `src/a.js`。
 * ⚠ **判据路径不是绝对落点，而是"相对 cwd 的那一段"**（R36 复查第 2 条）——
 *   否则 `cwd` 自己恰好在 `.warden` 里时会**整片放行**（见 `ledgerScopePath` 的注释）。
 * @param {string} file
 * @param {string} [cwd] 会话工作区（有就按它 `path.resolve`；没有就只做词法规范化）
 * @returns {boolean}
 */
export function isLedgerPath(file, cwd) {
  const scope = ledgerScopePath(file, cwd)
  if (scope.length === 0) return false
  return scope.replace(/\\/g, '/').split('/').includes('.warden')
}

/**
 * 这个路径为什么**不被拦**（不需要任何口令）。
 * 顺序：**账本 → 代码（双保险）→ 文档 → 不是代码 → 认不出来**。
 *
 * ⚠ **规范化在前**（R36 复查）：豁免面与扩展名都在 `path.resolve(cwd, file)` 的结果上判，
 *   不在调用方给的原始字符串上判 —— 否则"判决与真实落点分叉"，就是那两条绕过。
 * ⚠ **代码支排在文档支之前**（R36 复查第 5 条）：原来文档支先判，于是
 *   `a.md:x.js` / `README.md:payload.js` 在文档支就 `exempt-doc` 放行了，
 *   "两种算法任一认出是代码就拦"这条双保险**在文档支上根本没生效** ——
 *   文件头那句「这样堵 Windows 的 ADS **不会**反过来在 POSIX 上放宽」当时是**假话**。
 * ⚠ `.warden/**` 的豁免**没有被取消**：规范化**之后**再看它是不是真在 `.warden` 里
 *   （`.warden/SPEC.md` 照旧直接放行；`.warden/../src/a.js` 不再算账本）。
 * @param {string} file
 * @param {{codeExtensions:string[], docExtensions:string[]}} opts
 * @param {string} [cwd] 会话工作区（`exec.agent.session.header.cwd`，见 `normalizeTargetPath`）
 * @returns {'exempt-ledger'|'exempt-doc'|'not-code'|'unknown-ext'|null} `null` = 该拦
 */
export function fileExemptionWhy(file, opts, cwd) {
  if (typeof file !== 'string' || file.length === 0) return null
  const norm = normalizeTargetPath(file, cwd)
  if (isLedgerPath(file, cwd)) return 'exempt-ledger'
  const ext = fileExtension(norm.path)      // 截 ADS + 去尾随点/空格 之后（= Windows 上的真实落点）
  const extRaw = basenameExt(norm.resolved) // **截 ADS 之前**（POSIX 上 `:` 是合法文件名字符，没有 ADS）
  // ★ 双保险：**两种算法任一认出是代码 ⇒ 按代码拦**（**排在文档豁免之前**，两支都成立）。
  //   只认"截断后"会在 POSIX 上把 `foo:bar.js` 看成无扩展名 ⇒ 那是**放宽**（本项目明令不许）。
  //   只认"不截断"则漏掉 Windows 的 `x.js::$DATA` ⇒ 那正是本条要修的绕过。
  //   只判文档支（原来那样）则漏掉 `a.md:x.js` ⇒ 那正是 R36 复查第 5 条抓到的 deny→allow。
  if (ext !== '' && opts.codeExtensions.includes(ext)) return null
  if (extRaw !== '' && opts.codeExtensions.includes(extRaw)) return null
  if (ext !== '' && opts.docExtensions.includes(ext)) return 'exempt-doc'
  if (ext === '') return 'unknown-ext'                           // 无扩展名 ⇒ 认不出来 ⇒ 放行
  return 'not-code'
}

/**
 * ★ R36 的判决 —— 纯函数，`apply` 只负责副作用（探针 / 账本 / 计数）。
 *
 * 判据顺序（**每一条都要能单独测**，`why` 就是那个"为什么没拦"的凭证）：
 *   ① `codeGate === 'off'` ⇒ 关；
 *   ② 工具不在 `codeTools` 里 ⇒ 不是写代码的工具；
 *   ③ **子代理 ⇒ 放行**（它就是该写代码的那个人；判据见 `isSubagent`）；
 *   ④ **代码（两种扩展名算法任一认出）⇒ 不豁免、继续往下走**；
 *      `.warden/**` / `*.md` / 非代码扩展名 / 认不出来的扩展名 ⇒ 放行
 *      （**代码支排在文档支之前**，见 `fileExemptionWhy`）；
 *   ⑤ 有显式豁免（`token` / `env`）⇒ 放行；
 *   ⑥ 否则 ⇒ `deny`（`warn` 档则降级成 `warn`）。
 *
 * ⚠ 第 ④ 条里"**认不出来 ⇒ 放行**"是**故意**的 fail-open，和 `isSubagent` 的
 *   "读不到 ⇒ 当主代理"方向相反。理由不一样，别搞混：
 *     · 主/子判错的代价不对称（子代理被拦=没人能写代码 ⇒ 必须 fail-closed）；
 *     · "这是不是代码"判错的代价是**误伤**，而用户上次就是因为误伤才把闸关掉的。
 *   两侧都在这里写清楚了，改的时候别只改一边。
 * @param {{codeGate:string, codeTools:string[], codeExtensions:string[], docExtensions:string[]}} opts
 * @param {{tool:string, file:string|null, subagent:boolean, exempt?:('token'|'env'|null), cwd?:string|null}} input
 *   `cwd` = 会话工作区：**落点先按它规范化**（`path.resolve(cwd, file)`）再判；
 *   `.warden/**` 那一条的判据是**这个落点相对 cwd 的那一段**（见 `ledgerScopePath` ——
 *   否则"cwd 恰好在 `.warden` 里"会整片放行），扩展名按落点的 basename 判
 *   （不传 cwd 就只做词法规范化）。
 * @returns {{action:'allow'|'deny'|'warn', why:string}}
 */
export function codeGateDecision(opts, input) {
  if (opts.codeGate === 'off') return { action: 'allow', why: 'gate-off' }
  const tool = String(input?.tool ?? '')
  if (!opts.codeTools.includes(tool)) return { action: 'allow', why: 'not-code-tool' }
  if (input?.subagent === true) return { action: 'allow', why: 'subagent' }
  const file = input?.file
  if (typeof file !== 'string' || file.length === 0) {
    return { action: opts.codeGate === 'warn' ? 'warn' : 'deny', why: 'no-path' }
  }
  const exemptFile = fileExemptionWhy(file, opts, input?.cwd)
  if (exemptFile !== null) return { action: 'allow', why: exemptFile }
  if (input?.exempt === 'token' || input?.exempt === 'env') {
    return { action: 'allow', why: `exempt-${input.exempt}` }
  }
  return { action: opts.codeGate === 'warn' ? 'warn' : 'deny', why: 'main-agent-writes-code' }
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
 * 探针里的路径**只留末尾两段** —— 探针是有界观测，不是又一个日志库
 * （而且绝对路径里可能带用户名，没必要往盘上抄）。
 * @param {unknown} file
 * @returns {string}
 */
function shortPath(file) {
  if (typeof file !== 'string' || file.length === 0) return '(无)'
  const segs = file.replace(/\\/g, '/').split('/').filter((s) => s.length > 0)
  return segs.slice(-2).join('/')
}

// ───────────────────────────────────────────── R36 一次性豁免（**必须留痕**）

/**
 * 读这个 agent 的会话 id / 工作区（探针与账本都要用它署名）。
 * 只读**叶子字段**，不整对象序列化（活数据硬规矩）。
 * @param {unknown} agent
 * @returns {{id:string|null, cwd:string|null}}
 */
export function agentWhereabouts(agent) {
  const out = { id: null, cwd: null }
  try {
    const header = agent !== null && typeof agent === 'object' ? agent.session?.header : undefined
    if (typeof header?.id === 'string') out.id = header.id
    if (typeof header?.cwd === 'string') out.cwd = header.cwd
  } catch { /* 读不到就 null */ }
  return out
}

/**
 * 豁免痕迹**可以往哪几个 `.warden/` 写**。
 *
 * ⚠ 只认这两个方向，**绝不"就近新建一个 `.warden`"**：
 *   本项目实测踩过「两个项目读到对方守则」——在容器目录（例如 `<WORKSPACE>`）
 *   随手建 `.warden` 就是那次事故的形状。所以：
 *     · 工程根（有 `.git` 的那层）⇒ 可以建 `.warden/`；
 *     · 工作区里**已经有** `.warden/` ⇒ 可以写（不新建）；
 *     · 其它情况 ⇒ **没有可写账本 ⇒ 豁免不算数**（见 `codeDenyReason` 的 `exempt-untraced`）。
 * @param {unknown} agent
 * @returns {string[]} 候选 `.warden` 目录（有序，先写的赢）
 */
export function ledgerDirsFor(agent) {
  const { cwd } = agentWhereabouts(agent)
  const out = []
  try {
    const root = findProjectRoot(cwd).root
    if (root !== null) out.push(path.join(root, '.warden'))
  } catch { /* 找不到根就算了 */ }
  try {
    if (typeof cwd === 'string' && cwd.length > 0 && existsDir(path.join(cwd, '.warden'))) {
      out.push(path.join(cwd, '.warden'))
    }
  } catch { /* 同上 */ }
  return out
}

/**
 * 把一次豁免**写进账本**。返回写成功的 `.warden` 目录，全失败返回 `null`。
 *
 * ⚠ 返回值是**判决的一部分**：`null` ⇒ 这次豁免不算数（照样 deny）。
 *   "必须留痕"在这里是硬条件，不是口号 —— 否则这道闸就有一个**无声**的绕过口。
 * @param {string[]} dirs `ledgerDirsFor()` 给的候选
 * @param {Record<string, unknown>} entry 要记的东西（会补上 `at`）
 * @returns {string|null}
 */
export function recordExemption(dirs, entry) {
  if (!Array.isArray(dirs) || dirs.length === 0) return null
  const line = `${JSON.stringify({ at: new Date().toISOString(), kind: 'code-gate-exemption', ...entry })}\n`
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, EXEMPTION_LEDGER), line, 'utf8')
      return dir
    } catch { /* 换下一个 */ }
  }
  return null
}

/**
 * 取一次性豁免 token 文件：**取出即消费**（删掉），返回它读到的内容与是否删成功。
 *
 * 候选位置与 `ledgerDirsFor` 同源（工程根 → 工作区已有的 `.warden`），
 * 相对路径来自 `opts.codeExemptToken`（默认 `.warden/ALLOW-MAIN-WRITE`）。
 * @param {unknown} agent
 * @param {{codeExemptToken:string}} opts
 * @returns {{file:string, body:string, consumed:boolean}|null}
 */
export function takeExemptionToken(agent, opts) {
  const { cwd } = agentWhereabouts(agent)
  const bases = []
  try {
    const root = findProjectRoot(cwd).root
    if (root !== null) bases.push(root)
  } catch { /* 找不到根就算了 */ }
  if (typeof cwd === 'string' && cwd.length > 0) bases.push(cwd)
  for (const base of bases) {
    const file = path.join(base, opts.codeExemptToken)
    if (!existsFile(file)) continue
    let body = ''
    try { body = fs.readFileSync(file, 'utf8') } catch { /* 读不动也算它存在 */ }
    let consumed = false
    try { fs.rmSync(file); consumed = true } catch { /* 删不掉 ⇒ 下次还在，痕迹里能看出来 */ }
    return { file, body, consumed }
  }
  return null
}

/**
 * 环境变量豁免开了没有。**只认显式的真值**（`1` / `true` / `yes` / `on`）——
 * 设成 `0` / 空串**不算**，否则"设了却没生效"会变成另一类静默失效。
 * @param {{codeExemptEnv:string}} opts
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
export function envExempt(opts, env = process.env) {
  try {
    const raw = env?.[opts.codeExemptEnv]
    if (typeof raw !== 'string') return false
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
  } catch {
    return false
  }
}

/**
 * 从工具结果里取出正文 —— 只读 `content` 里的 `text` 块，**不整对象序列化**
 * （服务/事件/结果都是活数据，这条是硬规矩）。有界：判决在尾部，但也不拼超大结果。
 * @param {unknown} result 工具执行结果
 * @returns {string}
 */
export function textOfResult(result) {
  const blocks = result !== null && typeof result === 'object' ? result.content : undefined
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text
      if (out.length > 400000) break
    }
  }
  return out
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

/**
 * 分诊闸：读 `.warden/VOTES.jsonl`，返回**未决议**的议题列表。
 *
 * "未决议" = 没有一个选项拿到过半（4/7 席）票。
 * 这是 `warden.mjs` 的 `tallyVotes` 的**简化版**（不处理异议 / 附D条件 / 账目矛盾）——
 * 作为 present 闸的"有没有没投完的票"检查够用，精确计票仍由 `warden.mjs vote --topic` 做。
 *
 * ⚠ `TRIAGE_VOTE_ROLES` 与 `warden.mjs` 的 `VOTE_ROLES` **必须一致**（7 席有票）。
 *   角色名单只有一张（`ROLE_REGISTRY`）；这里不 import warden.mjs（它是脚本不是模块），
 *   所以6所以硬编码 + 注释标注。加 / 删席位时两处一起改。
 */
const TRIAGE_VOTE_ROLES = ['监督员', '审查', '记录', '支线守门员', '提问闸门', '资料员', '方向员']
const TRIAGE_MAJORITY = Math.floor(TRIAGE_VOTE_ROLES.length / 2) + 1

export function readPendingVotes(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return []
  const candidates = []
  try {
    const root = findProjectRoot(cwd).root
    if (root !== null) candidates.push(path.join(root, '.warden', 'VOTES.jsonl'))
  } catch { /* 找不到根就算了 */ }
  candidates.push(path.join(cwd, '.warden', 'VOTES.jsonl'))
  let votesFile = null
  for (const p of candidates) { if (existsFile(p)) { votesFile = p; break } }
  if (votesFile === null) return []
  let lines
  try { lines = fs.readFileSync(votesFile, 'utf8').split('\n') } catch { return [] }
  const latest = new Map()
  for (const line of lines) {
    if (!line.trim()) continue
    let v
    try { v = JSON.parse(line) } catch { continue }
    if (!v || typeof v.topic !== 'string' || typeof v.role !== 'string') continue
    if (!TRIAGE_VOTE_ROLES.includes(v.role)) continue
    if (!latest.has(v.topic)) latest.set(v.topic, new Map())
    const m = latest.get(v.topic)
    const prev = m.get(v.role)
    const at = Date.parse(String(v.at ?? '')) || 0
    if (prev === undefined || at >= prev.at) m.set(v.role, { choice: String(v.choice ?? ''), at })
  }
  const pending = []
  for (const [topic, m] of latest) {
    const counts = {}
    for (const { choice } of m.values()) counts[choice] = (counts[choice] || 0) + 1
    const max = Math.max(0, ...Object.values(counts))
    if (max < TRIAGE_MAJORITY) pending.push(topic)
  }
  return pending
}

// ─────────────────────────────────────────────────────────── 观测（有界）

/** 探针**每次 `apply()`** 最多写几行（额度是 `makeProbe()` 的闭包局部量，每次 `apply()` 各一份）—— 观测自己不许变成噪音 */
const PROBE_MAX_LINES = 8
/**
 * ★★ **角色闸的 `deny` 单独保底几行**（R36 复查第 3 条）。
 *
 * 为什么必须分开：code 闸**每一次调用**都可能写一行 `deny`，而总预算只有 8 行
 * ⇒ 「角色闸真的响了」与「角色闸的行被预算挤掉了」在证据上**又分不开**
 * （那正是这个探针要消灭的那种"两件事看起来一样"）。
 * 实测（改前，`{"mode":"gate"}` + 连发 8 次 `x1..x8.js`）：第 9 次写 `x.txt`
 * **确实被角色闸拒**（返回 `{kind:'deny', reason:'【九月项目团 · 角色协议还没启动】…'}`），
 * 而工程根探针里 `gate:"role"` 那一行**根本没写进去**（7 行全是 code 闸的）。
 * ⇒ 这 8 行**不占用** `PROBE_MAX_LINES`，也**只给角色闸的 `deny`**用（`reserved:true`）。
 *   为什么是 8（不是 2）：出厂自检里有**好几个不同的 agent**，每个都能各拒一次
 *   （`:313` / `:319` / `:338` …），额度太小就会在这些夹具上先被用光，等于没保底。
 *   8 行 + 8 行 = 每次 `apply()` 最多 16 行，仍然是有界观测，不会变成第二个日志库。
 */
const PROBE_ROLE_RESERVE = 8
/**
 * **挂载时（还没有 agent）最多缓存几行**，等拿到 agent 再 backfill 到真实工程根
 * （`mounted` / `config-invalid` / `config-unknown-keys` / `prompt-service-missing`，
 * 正常最多 2~3 行）。见文件头"挂载时的两行原来只会扔给 process.cwd()"。
 */
const PROBE_MAX_PENDING = 3
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
 *   · `deny` —— 闸真的响过（**角色闸那一行有专用保底额度**，见 `PROBE_ROLE_RESERVE`）；
 *   · `pre-execute-threw` —— 判据抛异常（fail-open 了，但不静默）。
 *
 * 落盘位置（**R36 复查第 7 条修过**）：
 *   · **带 agent 的行** ⇒ `<工程根>/.warden/team-guard-probe.jsonl` → `<cwd>` → `<tmpdir>`，第一个写得进去的赢；
 *   · **挂载时的行（还没有 agent，`dirsFor(null)` 只能拿到 `process.cwd()`）** ⇒
 *     ① 先按老路落 `cwd`→`tmpdir`（**保底**：证明"装上了"不会因为读不到会话就消失），
 *     ② **同时缓存**，等**第一次拿到 agent** 时 **backfill** 到那个 agent 的**真实工程根**
 *        （带 `backfill:true`）—— 于是 `mounted` / `config-invalid` 不再只扔在进程 cwd，
 *        出厂自检里那条「★ 探针落到工程根 `.warden/` 里（不是乱扔）」才**真的**成立。
 * 探针自己坏了**绝不许**影响工具调用。
 * @returns {(event:string, extra?:object, agent?:unknown, opts?:{reserved?:boolean}) => void}
 */
function makeProbe() {
  let written = 0
  let reservedWritten = 0
  /** 挂载时（没有 agent）写下的那几行 —— 拿到 agent 后 backfill 到真实工程根 */
  const pending = []
  const makeLine = (event, extra) => JSON.stringify({ at: new Date().toISOString(), ev: event, pid: process.pid, ...(extra ?? {}) }) + '\n'
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
  /** 写到第一个写得进去的地方；返回是否落盘成功（**不抛**） */
  const writeLine = (line, dirs) => {
    for (const dir of dirs) {
      try {
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, PROBE_FILE)
        // 总大小闸：跨多次挂载也不许把这个文件养大（每次 apply() 8 行；跨挂载的总量由这个字节闸兜底）
        try {
          if (fs.statSync(file).size > PROBE_MAX_BYTES) continue
        } catch { /* 文件还不存在 ⇒ 继续 */ }
        fs.appendFileSync(file, line, 'utf8')
        return true
      } catch { /* 换下一个 */ }
    }
    return false
  }
  return function probe(event, extra, agent, opts) {
    try {
      const reserved = opts !== undefined && opts.reserved === true
      const hasAgent = agent !== null && agent !== undefined
      // ① 挂载时（还没有 agent）：保底写 cwd/tmpdir，并缓存起来等 backfill
      if (!hasAgent) {
        writeLine(makeLine(event, extra), dirsFor(null))
        if (pending.length < PROBE_MAX_PENDING) pending.push({ event, extra })
        return
      }
      // ② 第一次拿到 agent：把挂载时那几行补记到**这个 agent 的真实工程根**
      if (pending.length > 0) {
        const dirs = dirsFor(agent)
        for (const p of pending.splice(0, pending.length)) {
          writeLine(makeLine(p.event, { ...(p.extra ?? {}), backfill: true }), dirs)
        }
      }
      // ③ 常规写入：总预算 + 角色闸的专用保底额度（**互不挤占**）
      if (reserved) {
        if (reservedWritten >= PROBE_ROLE_RESERVE) return
        reservedWritten += 1
      } else {
        if (written >= PROBE_MAX_LINES) return
        written += 1
      }
      writeLine(makeLine(event, extra), dirsFor(agent))
    } catch { /* 观测自己坏了绝不许影响工具调用 */ }
  }
}

// ─────────────────────────────────────────────────────────── 插件

/**
 * 装四种形态：常驻协议段、实时状态快照、第一次写文件前的角色闸、
 * ★ 以及 R36 的「主代理不写代码」硬闸。
 * @param {import('@deepseek-ai/cordis').Context} ctx preset 的 standing scope
 */
export function apply(ctx) {
  const opts = loadOptions()
  if (opts.mode === 'off') return

  /** 有界观测探针（证明"被装上 / 被派发 / 响过"，见 makeProbe 的注释） */
  const probe = makeProbe()
  /** 前两次工具调用留痕用 */
  let toolSeen = 0
  /** ★ 子代理那一半的探针：**每进程只写一行**（原来一行不留 ⇒ 证不了那一半真被放行） */
  let subagentSkipProbed = false

  // ★★ **配置读不出来 ⇒ 不静默回默认**（R36 复查第 2 条）。这里只是**多写一行探针**；
  //    说给模型听的那两处是状态行与协议段（都是每一步/每次请求都在的位置）。
  if (opts.configIssue !== null && opts.configIssue !== undefined) {
    probe('config-invalid', {
      file: opts.configIssue.file, kind: opts.configIssue.kind, line: opts.configIssue.line,
      note: '配置文件**存在**但读不出来 ⇒ 现在用的是默认值（这与"没写配置"不是一回事）',
    })
  }
  if (Array.isArray(opts.unknownKeys) && opts.unknownKeys.length > 0) {
    probe('config-unknown-keys', { keys: opts.unknownKeys.slice(0, 8) })
  }

  /** 每个 agent 自己的状态（WeakMap：agent 回收即回收，不跨会话残留） */
  const sessions = new WeakMap()

  function stateOf(agent) {
    if (agent === null || typeof agent !== 'object') return null
    let st = sessions.get(agent)
    if (st === undefined) {
      // check 三个字段是分开的：`checked`=跑过没有，`checkPassed`/`checkFailed`=**过没过**。
      // 只记"跑过"就是那句假话的来源（见 parseCheckVerdict 的注释）。
      st = {
        engaged: false, recorded: false, checked: false, checkPassed: null, checkFailed: null, denies: 0,
        // ★ R36：这道硬闸自己的计数。**必须有**，否则"闸装了但从没响过"与
        //   "闸根本没装上"在证据上分不开（本项目那句「没查到 ≠ 查了没问题」）。
        codeDenies: 0, codeExempts: 0, codeWhy: null,
        // ★★ 角色闸**自己**的最近一次判据（`deny` / `allow`）—— 两道闸**分开报**要用的那一半
        //   （R36 复查第 3 条：合并成一行时，"哪道闸响的"就没法单独看）。
        roleWhy: null,
        // ★ 多点门控：脑子审查是否已参与（交付前必须有）
        brainEngaged: false,
        // ★ 多点门控：done 闸 / present 闸各自的计数（与角色闸的 denies 分开）
        doneDenies: 0, presentDenies: 0,
      }
      sessions.set(agent, st)
    }
    return st
  }

  /**
   * ★ R36 的**副作用那一半**：读豁免、写痕迹、记账、发探针。
   * 判决本身在纯函数 `codeGateDecision` 里（那样才测得动）。
   *
   * 返回 `null` ⇒ 放行（继续走后面那个角色闸）；返回对象 ⇒ 直接就是给 cordis 的判决。
   * @param {{name?:unknown, arguments?:unknown, agent?:unknown}} exec
   * @param {object|null} st
   * @returns {{kind:'deny'|'warn', reason:string}|null}
   */
  function runCodeGate(exec, st) {
    const tool = String(exec?.name ?? '')
    if (opts.codeGate === 'off' || !opts.codeTools.includes(tool)) return null
    const agent = exec?.agent
    // 子代理：**永远放行**（它就是该写代码的那个人）。
    //   ⚠ 判决**一点没放宽**；这里加的只是**可观测性**（R36 复查第 4 条）：原来 `return null`
    //     一行不留 ⇒ 探针只能证"主代理被拦过"，**证不了"子代理那一半真的被放行了"**。
    //     **每进程只写一行**，不给它添噪音。
    if (isSubagent(agent)) {
      if (!subagentSkipProbed) {
        subagentSkipProbed = true
        probe('code-subagent-skip', {
          tool, file: shortPath(targetPathOf(exec?.arguments)),
          why: 'subagent', note: '子代理一律放行 —— 这一行只证明"那一半真的走到了"',
        }, agent)
      }
      return null
    }

    const args = exec?.arguments
    const file = targetPathOf(args)
    // ★★ 规范化：基目录 = **会话工作区**（`dsh-tool-fs/lib/index.js:225-242` 的判据，
    //    见 `normalizeTargetPath` 的注释）。判决**只认这个规范化之后的结果**。
    const cwd = agentWhereabouts(agent).cwd
    const norm = typeof file === 'string' && file.length > 0 ? normalizeTargetPath(file, cwd) : null
    const exemptFile = typeof file === 'string' ? fileExemptionWhy(file, opts, cwd) : null

    // ① 文件级豁免（`.warden/**` / `*.md` / 非代码 / 认不出来）—— **不需要口令**
    if (exemptFile !== null) {
      if (st !== null) st.codeWhy = exemptFile
      return null
    }

    // ② 显式豁免：一次性 token 文件 → 环境变量。**都要留痕，留不上就不算数**
    //   ⚠ 只在**路径读得出来**时才走豁免：读不出路径的调用本身是坏的
    //     （`file_path` 在 `write`/`edit` 里是必填），豁免救不了它 ——
    //     往下走只会**白烧掉用户的一个一次性 token**。
    let exemptVia = null
    let traceNote = null
    const hasPath = typeof file === 'string' && file.length > 0
    const token = hasPath ? takeExemptionToken(agent, opts) : null
    if (hasPath && token !== null) {
      const dirs = ledgerDirsFor(agent)
      const where = recordExemption(dirs, {
        via: 'token', tool, file, ...agentWhereabouts(agent),
        tokenFile: token.file, tokenConsumed: token.consumed,
      })
      if (where !== null) {
        exemptVia = 'token'
        traceNote = where
      } else {
        // 痕没留上 ⇒ 这次豁免不算数。**把 token 放回去**，别白烧掉用户的一次性口令。
        let restored = false
        try { fs.writeFileSync(token.file, token.body, 'utf8'); restored = true } catch { /* 放不回就只能报出来 */ }
        probe('code-exempt-untraced', { tool, file: shortPath(file), tokenFile: token.file, restored, dirs: dirs.length }, agent)
        return {
          kind: 'deny', gate: 'code', why: 'exempt-untraced',
          reason: codeDenyReason(file, findProjectRoot(agentWhereabouts(agent).cwd).root, wardenPath(), opts, 'exempt-untraced'),
        }
      }
    } else if (hasPath && envExempt(opts)) {
      const where = recordExemption(ledgerDirsFor(agent), {
        via: 'env', envVar: opts.codeExemptEnv, tool, file, ...agentWhereabouts(agent),
      })
      if (where !== null) {
        exemptVia = 'env'
        traceNote = where
      } else {
        probe('code-exempt-untraced', { tool, file: shortPath(file), envVar: opts.codeExemptEnv, dirs: 0 }, agent)
        return {
          kind: 'deny', gate: 'code', why: 'exempt-untraced',
          reason: codeDenyReason(file, findProjectRoot(agentWhereabouts(agent).cwd).root, wardenPath(), opts, 'exempt-untraced'),
        }
      }
    }

    const verdict = codeGateDecision(opts, { tool, file, subagent: false, exempt: exemptVia, cwd })
    if (st !== null) st.codeWhy = verdict.why

    if (verdict.action === 'allow') {
      if (exemptVia !== null) {
        if (st !== null) st.codeExempts += 1
        // 每一处豁免都留一行探针：**豁免是最该被看见的动作**（它是一次放行）
        probe('code-exempt', { tool, via: exemptVia, where: traceNote, file: shortPath(file) }, agent)
      }
      return null
    }

    if (st !== null) st.codeDenies += 1
    if (verdict.action === 'warn') {
      // `warn` 档：只留痕 + 计数，**放行**（用户显式要求"别因为没说的事停下"时用）
      probe('code-warn', { tool, why: verdict.why, file: shortPath(file), denies: st === null ? 0 : st.codeDenies }, agent)
      return null
    }
    const root = findProjectRoot(agentWhereabouts(agent).cwd).root
    // 只有在**规范化结果与原始字符串不同**时才多写一句 —— 那正是几条绕过被堵掉的现场，
    // 模型看见"判的是什么名字"才不会以为插件在无理取闹。
    // ⚠ R36 复查第 4 条：**带尾随点/空格时不许说"真实落点"** —— 那句在本机是半真半假
    //   （Node 的 fs 会把 `x.js.` 落成**另一个名字**，只有 cmd/PowerShell 的重定向才会丢尾随点），
    //   所以那种情况**如实说这是"故意收紧"**，不冒充 OS 落点。
    let normNote = ''
    if (norm !== null && norm.path !== file) {
      const tailSteps = []
      if (norm.ads) tailSteps.push('截掉 NTFS 备用数据流后缀')
      if (norm.winTail) tailSteps.push('去掉尾随点/空白（Windows 丢 ASCII 空格与点；这里连 U+00A0 之类的空白也一并去掉）')
      normNote = norm.winTail
        ? `调用参数给的是 \`${file}\`，判据用的是 \`${norm.path}\``
          + `（已按会话工作区规范化${tailSteps.length > 0 ? `：${tailSteps.join('；')}` : ''}）。`
          + '⚠ 这是**故意收紧**（零歧义的代码名一律按代码拦），**不是**"跟着 OS 落点走"：'
          + '本机实测 Node 的 fs 会把 `x.js.` 落成**另一个名字**（只有 shell 重定向才会丢尾随点）。'
        : `调用参数给的是 \`${file}\`，**真实落点**是 \`${norm.path}\``
          + `（已按会话工作区规范化${norm.ads ? '，并截掉 NTFS 备用数据流后缀' : ''}）`
          + ' —— 判据落在**真实落点**上，不在原始字符串上。'
    }
    const reason = codeDenyReason(file, root, wardenPath(), opts, verdict.why, normNote)
    // ⚠ 事件名**故意统一成 `deny`**（不是 `code-deny`）：探针的语义是"**闸响了**"，
    //   而不是"哪一道闸响了"。分成两个名字之后，只看 `deny` 行的人会以为闸从没响过
    //   —— 那正是这个探针要消灭的那种"两件事看起来一样"。是**哪道闸**写进 `gate` 字段：
    //   **角色闸那条路径上 `gate` 一定是 `"role"`**（见下面 handler 里那一行）。
    probe('deny', {
      gate: 'code', why: verdict.why, tool, file: shortPath(file),
      denies: st === null ? 0 : st.codeDenies,
      // ★ 规范化证据（R36 复查第 1 条）：判决用的路径 / 基目录 / 有没有截 ADS。
      //   只在"与原始字符串不同"时印 raw+normalized，免得给正常调用添噪音。
      ...(norm === null ? { pathBase: 'none' }
        : {
          pathBase: norm.base,
          ...(norm.path !== file ? { raw: shortPath(file), normalized: shortPath(norm.path) } : {}),
          ...(norm.ads ? { ads: true } : {}),
          ...(norm.winTail ? { winTail: true } : {}),   // ★ R36 复查第 4 条：尾随点/空格被修剪过
        }),
      // ★★ 让"角色闸**单独**被验"有据可查（R36 复查第 3 条）：这次调用**角色闸会不会也拒**。
      //   用**纯函数** `gateDecision` 算，没有任何副作用；于是即便 code 闸抢答了，
      //   角色闸的判决仍然**分开**留在证据里 ——
      //   否则"角色闸真响过"与"code 闸顺手替它响了"在探针上长得一模一样（那正是 5 条断言假绿的根）。
      roleWouldDeny: st === null ? null : gateDecision(opts, st, tool, false).action === 'deny',
    }, agent)
    // ★ R36 复查第 3 条：判决里带**稳定的机读字段** —— `gate` = 哪道闸响的，`why` = 判据名。
    //   于是"角色闸单独会不会拒"不必再靠 `reason` 首行的字符串匹配（那是脆的）：
    //   `deny.gate === 'role'` / `deny.gate === 'code'` 就能断言。
    //   安全性（查过的）：`dsh-tools/lib/index.js:3116` 派发瀑布、`:3117` 读 `gate.kind === "ask"`、
    //   `:3127` 读 `decision.kind` / `decision.reason` —— **多余字段不校验、是惰性的**。
    return { kind: 'deny', gate: 'code', why: verdict.why, reason }
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
      // ★★ **配置读不出来必须说**（R36 复查第 2 条）：用户逐字照文档写了 `{"codeGate":"off"}`，
      //   带 BOM 时 `JSON.parse` 抛 → 空 catch 吞 → **静默回默认**，而他在验证时只能看到"闸照拦"。
      //   空 catch 的代价就是「配置坏了」与「配置没写」在证据上长得一模一样 —— 这个文件也被骗过一次。
      if (opts.configIssue !== null && opts.configIssue !== undefined) {
        const ci = opts.configIssue
        // ⚠ 行号**认不出来就说认不出来**，不许猜（Node 有些 JSON 报错不带 `position`——
        //   例如 `Unexpected token ','`。猜出来的行号会把用户骗到别的地方去）。
        const at = ci.line === null || ci.line === undefined ? '行号认不出来（Node 没给定位）/ ' : `第 ${ci.line} 行 / `
        lines.push(`· ⚠ **插件配置 \`${ci.file}\` 存在，但读不出来**（${at}${ci.kind}）：${ci.message}`)
        lines.push(`  ⇒ 现在用的是**默认值**（mode=${opts.mode} ｜ codeGate=${opts.codeGate}）。`
          + '⚠ 这**不是**"没写配置" —— 修好它再判断闸的行为，'
          + '**别把"配置没生效"读成"闸不管用"**。')
      }
      if (Array.isArray(opts.unknownKeys) && opts.unknownKeys.length > 0) {
        // 拼错一个字段（`codeGate` → `codegate`）就是"照文档写了却静默无效"，必须报出来。
        lines.push(`· ⚠ 配置里有**认不出来的字段**：${opts.unknownKeys.map((k) => `\`${k}\``).join(' / ')}`
          + '（被忽略 —— 这正是"写了却没生效"的常见原因）。认得的字段见插件文件头「可调项」。')
      }
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
        lines.push('· 本实例：状态不可用')
      } else {
        // ⚠ check 那一格必须**说真话**：`✓` 只能在**真的通过**时印。
        //   第一版印的是"跑过没有" ⇒ 在 `check-exit=1` 的同一步里印 `check ✓`，
        //   模型据此跟用户说"做完了"。那是这个文件最严重的一个 bug（2026-09-23 实测）。
        const checkCell = st.checkPassed === true
          ? 'check ✓（通过了）'
          : st.checkPassed === false
            ? `check **✗（未通过 ${st.checkFailed ?? '?'} 条）**`
            : (st.checked ? 'check ✗（跑过，但**没认出判决**）' : 'check ✗（还没跑）')
        lines.push(`· 本实例（状态按 agent 实例记，续跑会重置）：角色${st.engaged ? '已参与 ✓' : '**还没有任何角色参与**'}`
          + ` ｜ record ${st.recorded ? '✓' : '✗'} ｜ ${checkCell}`)
        // ★ R36：这道硬闸**每一步都在状态里露面**。它是一条"默认就开、新窗口自动生效"的
        //   行为约束，模型看不见它就会一头撞上来（撞上了也有拒绝理由兜底，但那是浪费一步）。
        if (opts.codeGate !== 'off') {
          const gateCell = opts.codeGate === 'warn' ? 'warn（只提醒）' : 'enforce（真 deny）'
          lines.push(`· **主代理不写代码**：codeGate=${gateCell} ｜ 本次实例已拦 ${st.codeDenies} 次`
            + (st.codeExempts > 0 ? ` ｜ 已用豁免 ${st.codeExempts} 次（**都写进了账本**）` : '')
            // ★ R36 复查第 7 条：`st.codeWhy` 原来是**只写不读的死状态**（初始化 + 两处赋值，
            //   全文没有任何地方读它）⇒ 现在在这里读出来：与角色闸那一格的
            //   `最近一次判据` 对称，"这次为什么放行 / 为什么拦"在每一步的上下文里都看得见。
            + (st.codeWhy !== null ? ` ｜ 最近一次判据：\`${st.codeWhy}\`` : '')
            + ' ｜ 代码一律派 `subagent_coder`；`.warden/**` 与 `*.md` 不拦')
        }
        // ★★ **两道闸分开报**（R36 复查第 3 条）—— 这是"角色闸能被**单独**验"的那个观测口。
        //   即便上面那道 code 闸把 `write` 抢答了，这一行仍然只讲**角色闸自己**的判决，
        //   判据是纯函数 `gateDecision`（与 handler 里真正返回判决的同源、与探针 `gate:"role"` 同源）。
        //   ⇒ 一个夹具只要把 codeGate 关掉（或换成非代码文件），就能只靠这一行 + `gate:"role"` 那一行
        //     验"角色闸单独会响"，不必依赖 code 闸顺手替它响。
        {
          // ★★ R36 复查第 6 条：这一格原来**会印假话** ——
          //   工具集合写死成 `['write','edit']`，**完全没跟 `opts.mutatingTools` 走**，
          //   原因串（"角色已参与 / 本会话已拦过一次"）也是写死的。实测夹具
          //   `{"mode":"gate","mutatingTools":["str_replace"]}`：
          //     状态行印「会 allow（角色已参与 / 本会话已拦过一次）」，
          //     而真派发 `str_replace` ⇒ **deny**（纯函数 `gateDecision`：write=allow · edit=allow · str_replace=deny）。
          //   这正是本文件自己痛骂过的"check ✓ 假话"同一类：**印出来的必须与真判决同源**。
          //   ⇒ 现在 ① 工具集合取 `opts.mutatingTools`（闸真正管的那一份，只此一份）；
          //     ② 判决逐条过 `gateDecision`；③ 原因由**实际返回值**推出来，不再有写死的结论句。
          const covered = Array.isArray(opts.mutatingTools) ? opts.mutatingTools : []
          const denyTools = covered.filter((t) => gateDecision(opts, st, t, false).action === 'deny')
          const allowTools = covered.filter((t) => !denyTools.includes(t))
          const list = (arr) => arr.map((t) => `\`${t}\``).join('/')
          const toolsCell = covered.length === 0 ? '**一个工具都不管**（mutatingTools 是空的）' : list(covered)
          const allowWhy = st.engaged
            ? '角色已参与'
            : st.denies >= opts.maxDeniesPerSession
              ? `本会话已拦过 ${st.denies} 次（上限 ${opts.maxDeniesPerSession}）`
              : '判据说放行'
          const roleCell = opts.mode !== 'gate'
            ? `mode=${opts.mode}（**不拦** —— 要真拦：team-guard.json 写 {"mode":"gate"}）`
            : covered.length === 0
              ? '没有工具会被拦（这条闸现在是空转的）'
              : denyTools.length === covered.length
                ? '**会 deny**（角色还没参与）'
                : denyTools.length > 0
                  ? `**对 ${list(denyTools)} 会 deny**（${list(allowTools)} 放行：${allowWhy}）`
                  : `会 allow（${allowWhy}）`
          lines.push(`· **角色闸**（③，只管 ${toolsCell}）：${roleCell} ｜ 本次实例已拒 ${st.denies} 次`
            + (st.roleWhy !== null ? ` ｜ 最近一次判据：\`${st.roleWhy}\`` : ''))
        }
        if (st.checkPassed === false) {
          // ★ 最硬的一条：check 红了就**不许**宣布完成。这是用户 2026-09-23 亲口骂的那件事
          //   （「工作没做完就说做完交工了！！」）。
          lines.push(`→ ⚠ **check 未通过 ${st.checkFailed ?? '?'} 条 —— 现在不许说"完成 / 修好 / 交付"**。`
            + '要么修到 exit 0；要么在正文里**逐条**说明这一条为什么现在处理不了、'
            + '以及它**是不是用户提的要求**（不是用户提的，就不该拿它挡住交付）。')
        } else if (!st.engaged) {
          // ⚠ 「**动手写文件之前**」这五个字是**出厂 `team-guard.selftest.mjs` 逐字断言**的
          //   （`未参与时状态里出现"动手写文件之前"`）。上一轮改写成"产出之前"把那条断言改红了，
          //   而那条断言与 R36 无关 —— 本轮把它改回来（**只是措辞，一个字的行为都没动**）。
          lines.push('→ 这不是琐事的话，**动手写文件之前**先做第 0 步：init → 同一条消息里并行派 资料员 + 方向员 → 拿到维度清单再写代码。'
            + '（**一句话能说完的琐事不必** —— 改错别字、写个快捷方式、查个数，直接干。）')
        } else if (!st.recorded) {
          lines.push('→ 本轮收尾别忘了 `record`；说"完成 / 修好 / 交付"之前必须 `check`（exit 0 才算过）。')
        } else if (proj.root !== null && readWardenState(proj.root).brain === 0) {
          lines.push('→ 脑子一次都没跑过：交付前派 **1 个**（默认 1 个；只有冲突 / 查得不细 / 要探索更多做法时才派第 2 个）。')
        }
        // ★ 多点门控状态：done 闸 + present 闸 + brain 参与
        lines.push(`· **done 闸**（⑥）：${st.checkPassed === true ? 'check 已通过 ✓ → record --status done 放行' : 'check 未通过 → **record --status done 会被拦**'}`
          + ` ｜ 已拦 ${st.doneDenies} 次`)
        lines.push(`· **present 闸**（⑦）：${st.brainEngaged ? '脑子已审查 ✓ → present 放行' : '脑子没审查 → **present 会被拦**'}`
          + ` ｜ 已拦 ${st.presentDenies} 次`)
        if (!st.brainEngaged && st.engaged) {
          lines.push('→ 角色已参与但**脑子还没审查**：交付前至少派 1 个脑子（`brain brief` → `brain record` → `brain audit`）。')
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
      text: (assembly) => (isSubagent(assembly?.agent) ? '' : protocolText(wardenPath(), opts.configIssue)),
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

      // ★ 「监听器**真的被派发过**」这一行必须打在**最前面**（「审查」E02）。
      //   ⚠ 它原来在闸判之后：于是**被拦下的调用**不会留下 `tool` 行，
      //     "闸真响了" 与 "监听器根本没挂上" 又被搅成一团 —— 正是 E02 那条指控的形状。
      //     R36 的硬闸会拦掉一整个会话里最早的几次 `write` ⇒ 这个坑**必然会踩到**
      //     （装了 R36 之后 selftest 的 `★ 探针证明监听器真的被派发过` 当场从 ✓ 变 ✗ 才发现）。
      if (st !== null && toolSeen < 2) {
        toolSeen += 1
        probe('tool', {
          tool, engaged: st.engaged, denies: st.denies, codeDenies: st.codeDenies,
          // ★★ 两道闸**分开**：这一格是**角色闸**（③，纯函数 `gateDecision`）对**这次调用**的判决。
          //   它在 handler 最前面算、与后面真正返回的那个判决**同源**；于是即便 code 闸后来抢答，
          //   角色闸的判决也**单独**留在探针里 —— 这正是"角色闸能单独被验"要的观测口。
          roleGate: gateDecision(opts, st, tool, isSubagent(exec?.agent)).action,
        }, exec?.agent)
      }

      // ★★ R36：**主代理不写代码** —— 先于角色闸判。
      //   先判它的理由：它是**无条件的硬闸**（不受 mode / maxDenies 影响），
      //   而角色闸默认 `mode: 'gate'` 也只在"一个会话最多一次"的额度里拦（`remind` 则完全不拦）。
      //   两个都该拒时，给模型看的应该是**更具体、更可操作**的那一段（派 `subagent_coder`）。
      const codeGate = runCodeGate(exec, st)
      if (codeGate !== null) return codeGate

      // ★★ 多点门控：角色不是只在第一次写文件时参与，而是贯穿整个任务。
      //   这些闸与 mode 无关、不受 maxDeniesPerSession 限制（重试不会放行），
      //   因为它们守的是"完成 / 交付"这两个**不可糊弄**的决策点。

      // ⑥ done 闸：声称 done 前必须 check 通过
      //   治"验收糊弄"：跑了一小时、上亿 token，关键问题只解决了半个，最后交一张含糊的账。
      if (st !== null && !isSubagent(exec?.agent) && isDoneClaimCall(tool, exec?.arguments)) {
        if (st.checkPassed !== true) {
          st.doneDenies += 1
          probe('deny', {
            gate: 'done', why: 'done-without-check',
            checkPassed: st.checkPassed, doneDenies: st.doneDenies,
          }, exec?.agent, { reserved: true })
          return {
            kind: 'deny', gate: 'done', why: 'done-without-check',
            reason: doneGateReason(wardenPath()),
          }
        }
      }

      // ⑦ present 闸：交付前必须脑子审查过
      //   治"自查变自夸"：AI 自己说"做完了"不算数，必须有独立审查。
      if (st !== null && !isSubagent(exec?.agent) && isPresentCall(tool, exec?.arguments)) {
        if (!st.brainEngaged) {
          st.presentDenies += 1
          probe('deny', {
            gate: 'present', why: 'present-without-brain',
            brainEngaged: st.brainEngaged, presentDenies: st.presentDenies,
          }, exec?.agent, { reserved: true })
          return {
            kind: 'deny', gate: 'present', why: 'present-without-brain',
            reason: presentGateReason(wardenPath()),
          }
        }
        // ⑦+ 分诊验证：脑子审查过了，再检查有没有未决议的投票
        if (opts.triageGate !== 'off') {
          const triCwd = agentWhereabouts(exec?.agent).cwd
          if (typeof triCwd === 'string' && triCwd.length > 0) {
            const pending = readPendingVotes(triCwd)
            if (pending.length > 0) {
              st.presentDenies += 1
              probe('deny', {
                gate: 'present', why: 'pending-votes', topics: pending.slice(0, 5),
                presentDenies: st.presentDenies,
              }, exec?.agent, { reserved: true })
              return {
                kind: 'deny', gate: 'present', why: 'pending-votes',
                reason: triageGateReason(wardenPath(), pending),
              }
            }
          }
        }
      }

      if (st !== null) {
        if (isEngagementCall(tool, exec?.arguments)) st.engaged = true
        if (isRecordCall(tool, exec?.arguments)) st.recorded = true
        if (isCheckCall(tool, exec?.arguments)) st.checked = true
        if (isBrainRecordCall(tool, exec?.arguments)) st.brainEngaged = true
        const verdict = gateDecision(opts, st, tool, isSubagent(exec?.agent))
        // ★ 角色闸**自己**的判据落进状态：状态行靠它把两道闸**分开报**（R36 复查第 3 条）。
        st.roleWhy = verdict.action
        if (verdict.action === 'deny') {
          st.denies += 1
          // ⚠⚠ `gate` **必须**是 `'role'`，而且这是**角色闸唯一的探针出口**。
          //   R36 复查实测的假绿就是在这里：`codeGate` 抢答时这一行**根本不会写**，
          //   于是只看"有没有 `deny` 行"的断言把 code 闸的响声当成了角色闸的响声。
          //   ⇒ 要验角色闸**单独**会响，必须让调用走到这里（夹具用非代码文件 / 关掉 codeGate），
          //     并**显式断言 `"gate":"role"`**。
          // ★★ R36 复查第 3 条（**这一条防的是"改完之后连角色闸自己都验不到"**）：
          //   · `reserved: true` ⇒ 走 `PROBE_ROLE_RESERVE` 的**专用额度**，不被 8 行总预算挤掉
          //     （实测：连发 8 次 `x1..x8.js` 之后第 9 次 `x.txt` 被角色闸拒，这一行原来根本写不进去）；
          //   · 带上 `why` / `engaged` / `denies` / `mode` / `maxDenies`：**这一行自己就是完整凭据**，
          //     不必再去别处拼上下文。
          probe('deny', {
            gate: 'role', why: 'role-not-engaged', tool, denies: st.denies,
            engaged: st.engaged, mode: opts.mode, maxDenies: opts.maxDeniesPerSession,
          }, exec?.agent, { reserved: true })
          // ★ 判决对象带**稳定的机读字段**（同上）：`gate:'role'` 比 `reason` 首行的字符串稳。
          return {
            kind: 'deny', gate: 'role', why: 'role-not-engaged',
            reason: denyReason(wardenPath(), opts.maxDeniesPerSession),
          }
        }
      }
    } catch (e) {
      // fail-open，但**不许静默**：留一行痕迹（有界），否则"看守坏了"和"没被派发"分不开
      probe('pre-execute-threw', { err: String((e && e.message) || e).slice(0, 200) })
    }
    return next()
  })

  // ④ 把 `check` 的**真实判决**读回来 —— 治"跑过就算过"那句假话（见 parseCheckVerdict）
  ctx.on('tools/post-execute', (exec, result, next) => {
    try {
      if (isCheckCall(String(exec?.name ?? ''), exec?.arguments)) {
        const st = stateOf(exec?.agent)
        if (st !== null) {
          const verdict = parseCheckVerdict(textOfResult(result))
          st.checked = true
          st.checkPassed = verdict === null ? null : verdict.passed
          st.checkFailed = verdict === null ? null : verdict.failed
          probe('check-verdict', { passed: st.checkPassed, failed: st.checkFailed }, exec?.agent)
        }
      }
    } catch { /* 读判决坏了绝不许影响工具调用 */ }
    return next()
  })
}
