# 九月项目团 · 角色协议加固（`preset-roles`）

> 需求：`.warden/SPEC.md` 的 **R25**（逐字原话锁在里面，**公开版已隐去**）。
> 本目录是**工程工作副本**；真正加载的两处在下面「装在哪」一节。

---

## 1. 要解决的是什么（用户逐字）

> （用户原话已隐去 —— 公开版不留逐字）

**病根是形态，不是内容。** 角色协议原来**只是 persona 里的一大段文字**，
位置在 system prompt 开头、和几十条别的规矩混在一起 ⇒ 模型看不见它 ⇒
"角色"变成了用户手动触发的功能。

所以这次不是"再写一段更长的建议"，而是换三种**它躲不掉**的形态。

---

## 2. 三种形态（`team-guard.mjs`）

| # | 形态 | 挂点 | 为什么是它 |
|---|---|---|---|
| ① | **常驻协议段** | `systemPrompt.section`，order **10250** | 排在**所有正文段之后**（persona 后缀是 10200，结构化输出 9900、harness 源码 10000、web 面 10100 都在它前面）—— 模型读 system prompt 时**最后读到**的正文。文本**静态** ⇒ system prompt 字节不变 ⇒ 不破坏 KV cache |
| ② | **每步实时状态快照** | `systemPrompt.context`，order **130** | 走 runtime context 通道（沙箱 110 / 审批 115 / 派单 120 之后）。`RuntimeContextProjection` **只在内容变了才追加一条消息** ⇒ 便宜，而且**每一步请求里都在**。它读的是磁盘上真有的东西（`.warden/`）和本会话真发生过的事（派过角色没有、record 没有） |
| ③ | **第一次写文件前的角色闸** | `tools/pre-execute` waterfall | 本项目自己的结论：**写进代码 ≠ 拦得住**、**没被 exit code 拦的都只是建议**。所以这里是**真拦**：本会话还没有任何角色参与过时，第一次 `write`/`edit` 被拒，理由里给**逐字可抄的命令** |

### 闸的三条硬边界（看守自己坏了绝不许影响用户干活）

1. **一个会话最多拦一次**（`maxDeniesPerSession`，默认 1）—— 它是一次"让协议出现在决策点上"的减速带，不是永久路障；
2. **子代理一律放行**（`session.header.origin === 'subagent'`）—— 实现工程师要能写代码；
3. **任何异常都 fail-open** —— 返回 `next()`，绝不让一次工具调用因为看守坏了而失败。

> ⚠ 一个例外，**故意**不 fail-open：`isSubagent` 读不到 header 时返回 `false`（= 当顶层，闸生效）。
> 两个方向的代价不对称：误判成顶层 ⇒ 子代理被拦一次（有界、可重试）；误判成子代理 ⇒ **闸永远不响**，
> 加固整个静默失效。所以那里取"宁可吵，不许静默"。

### 主代理 / 子代理的分流

协议段与状态快照对**子代理渲染成空串**（`renderPrompt` 会把空段丢掉）——
"第 0 步 / 你是主代理"那套话对资料员/方向员/实现工程师是**错**的，也是纯噪音。
段本身是**函数**（不是常量），就是为了做这个分流；主代理那条路径的字节**恒定**。

---

## 3. 装在哪 / 怎么同步

| 角色 | 路径 |
|---|---|
| **真正加载**（agent preset） | `<HOME>\.dsh\.agent-presets\roles\` |
| **真正加载**（skill） | `<HOME>\.dsh\skills\task-warden\` |
| **工程工作副本**（本目录） | `<WORKSPACE>\task-warden\preset-roles\` |
| **工程工作副本**（skill） | `<WORKSPACE>\task-warden\` |

改完必须**同步过去**，否则改了工作副本等于没改。同步是"覆盖 + 跑自检"：

```powershell
# preset（目标在工作区之外 ⇒ 需要放宽沙箱）
Copy-Item <WORKSPACE>\task-warden\preset-roles\* <HOME>\.dsh\.agent-presets\roles\ -Force
# skill
Copy-Item <WORKSPACE>\task-warden\warden.mjs  <HOME>\.dsh\skills\task-warden\ -Force
Copy-Item <WORKSPACE>\task-warden\SKILL.md   <HOME>\.dsh\skills\task-warden\ -Force
```

**生效时机**：

- **agent preset**：**新开的窗口**（会话创建时挂载）。已经开着的窗口用不上；
- **skill（`SKILL.md` / `warden.mjs`）**：**新会话**才加载。

---

## 4. 怎么关掉 / 怎么调松

同目录放一个可选的 `team-guard.json`（没有 = 用默认；**坏配置也回默认**，加固层自己坏了绝不能让 preset 挂不起来）：

```json
{ "mode": "gate",              // gate = 真拦一次 / remind = 只提醒不拦 / off = 全关
  "maxDeniesPerSession": 1,    // 0 = 不拦；99 = 每次写文件都拦
  "mutatingTools": ["write", "edit"] }
```

**推荐用 `{"mode":"off"}` 关**。也可以用 `agent.cordis.yml` 里 `team-guard` 那行的 `disabled: true`，
但**必须同时放一个 `{"mode":"off"}` 的 `team-guard.json`** ——
`preset-selftest.mjs` 会把"静默 disabled"（没有 json 就关掉）判 **FAIL**：
静默关掉会让下一个人以为加固还在跑。

---

## 5. 怎么验（**判据，不是"我看过了"**）

```powershell
# 形状（不挂载，抓编辑事故：少一行 / 静默关掉 / 协议又抄回 persona / persona 教错命令）
node <WORKSPACE>\task-warden\preset-roles\preset-selftest.mjs        # 62 条
# 插件逻辑（假 ctx 真跑 apply：三种形态真挂上、闸真会响、init 不解锁、探针真落盘、prompt 服务缺失时闸照活）
node <WORKSPACE>\task-warden\preset-roles\team-guard.selftest.mjs    # 122 条
# 脑子政策（黑盒调 CLI）
node <WORKSPACE>\task-warden\brain-policy.test.mjs                   # 44 条（要无沙箱：它 spawnSync）
# warden 主自检
node <WORKSPACE>\task-warden\selftest.mjs                            # exit 0（负控 58 / 正控 42）
```

**成本（实测，不是估的）**：常驻协议段 `protocolText()` = **2207 字符 / 517 个汉字 ≈ 800–1100 token**，
**每个主代理请求都付**（子代理那里渲染成空串，不付）。实时状态快照走 runtime context，
**只有内容变了才追加一条消息**；每步的磁盘成本是 5 次 `statSync` + 一次有界的工程根走查（≤8 次 `statSync`）。
探针是**有界**的：每进程 ≤8 行、文件 ≤64KB。

**运行中怎么知道加固到底装没装、响没响**（「审查」E02 要的那条）：

```powershell
# 1) 探针：挂载与派发的唯一落盘证据
Get-Content <WORKSPACE>\<工程根>\.warden\team-guard-probe.jsonl
#    看到 "ev":"mounted"      ⇒ 这一行被装上、prompt 服务在、两种形态都注册了
#    看到 "ev":"tool"         ⇒ 监听器**真的被派发过**（不是"注册了就算"）
#    看到 "ev":"deny"         ⇒ 闸真的响过
#    什么都没有                ⇒ 可能是没装上/没派发，**不是**"一切正常"
```

**真挂载校验**（唯一能抓"包解析不到 / config 非法 / 行没激活 / 服务漏了 realm"的判据）：
在运行中的 DSH 里用动态 Cordis 包调 `agentPresets.standingKeyFor('roles')`。
可复跑的探针代码（Host 半边，整段贴进 `cordis_define` 的 `code.host`）：

```js
return {
  apply(ctx) {
    harness.registerTool(ctx, harness.defineTool({
      name: 'preset_check',
      description: 'Mount-validate the roles preset.',
      parameters: {},
      output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }] } },
      async execute() {
        const presets = ctx.get('agentPresets')
        if (presets === undefined) return 'agentPresets unavailable'
        const lines = []
        try { await presets.standingKeyFor('roles'); lines.push('standingKeyFor(roles): OK — composition mounted') }
        catch (e) { lines.push('standingKeyFor(roles) FAILED: ' + String(e && e.message)) }
        const inv = await presets.compositionInventory()
        const entry = inv.find((x) => x.id === 'roles')
        for (const r of (entry ? entry.rows : [])) {
          lines.push('  ' + String(r.entryId) + ' | ' + r.moduleName + ' | enabled=' + String(r.enabled) + ' | state=' + String(r.fiberState))
        }
        return lines.join('\n')
      },
    }))
  },
}
```

实测结果（2026-09-23）：

```
roles row: trust=user broken=undefined
standingKeyFor(roles): OK — composition mounted
  row include:agent-presets:team-guard          | ./team-guard.mjs                | enabled=true | state=2
  row include:agent-presets:tool-subagent-coder | @deepseek-ai/dsh-tool-subagent  | enabled=true | state=2
  （其余行 state=2；tool-bash / codex / claude-code 是 enabled=false，本来就这样）
```

`state=2` = 已激活。**注意**：这只证明**装得上**，不证明"第一轮体感对不对"。

### ⚠ 改了文件什么时候生效（**这条最容易踩**）

`dsh-agent-presets` 判断 standing mount 要不要换一代，**只看 `agent.cordis.yml` 的 `{mtimeMs, size}`**
（`lib/index.js:1806-1815` 的 `compositionStamp`）：

| 改了什么 | 生效时机 |
|---|---|
| 只改 `agent.cordis.yml` | **新开的窗口**（stamp 变了 ⇒ 开新一代；已开的窗口留在旧代） |
| 改 `team-guard.mjs`（或任何被行引用的本地插件文件） | **必须重启 DSH** —— stamp 不变 ⇒ 不换代；而且就算换代，Node 的 ESM 缓存也会把同一个 URL 的**旧模块**还给你 |

⇒ **改完任何 preset 文件，最保险就是重启 DSH。**

---

## 6. 独立评审抓出来、已经改掉的（2026-09-23，「方向员」只读评审）

| # | 抓到的 | 严重度 | 改法 |
|---|---|---|---|
| 1 | **`isEngagementCall` 只匹配 `/warden\.mjs/`** ⇒ `init` / `check` / `--help` 全算"角色参与"，而拒绝理由第 1 步**就是**让模型跑 `init` ⇒ **跑一次 init 就解锁，一个角色都没派**，此后每步状态行还印「角色已参与 ✓」 | ★ **会让加固整个失效** | 判据收窄成"角色**真的被派出去 / 产出真的落了账**"：`subagent_liaison`/`subagent_direction` 被调用、或 `find add`、或 `role say`。**不认** `init`/`check`/`record`/`role brief`/`role scan`。回归用例：`team-guard.selftest.mjs` 的「★ 只跑过 init 的会话，write 仍然被拒」 |
| 2 | 状态行按**会话工作区**找 `.warden`，容器目录（`<WORKSPACE>` 没有 `.git`）也被印成「已建」—— 替"两个项目读到对方守则"那条路背书 | 高 | 新增 `findProjectRoot`（往上找最近的 `.git`，有界 8 层，不缓存）。容器目录下**明说**"往上找不到 `.git` / 这不是工程根 / 那个 `.warden` 可能属于上层容器" |
| 3 | 两条 persona 里的 `find add` **缺 `--text`**（`warden.mjs` 强制必填 ⇒ 照抄就 exit 2） | 中 | 补 `--text`，并加回归断言 |
| 4 | `taskChars` / `agent/pre-step` 是**死代码**（赋值了从没读），而拒绝理由承诺了"琐事判断" | 中 | 连同 `lastUserText`/`textOfBlocks` 与那个监听器一起删掉（"琐事放行"实际由 `maxDeniesPerSession=1` 保证，与它无关） |
| 5 | README 推荐的 `disabled: true` 会让 `preset-selftest.mjs` **必然 FAIL** ⇒ 下个 agent 当回归又打开 | 低 | 自检改成"**不许静默关**"：disabled 必须配 `{"mode":"off"}` 的 json；README 改推荐 `mode:off` |
| 6 | 模块头注释还写着"判不出来也放行"，与正文的"不许 fail-open"直接对立 | 低 | 注释改成与正文一致 |

**评审自己标了"未提供独立视角"的**（与改动自带材料重合，它只复核为真）：R36 两条闸的实际先后顺序、
新窗口真实体感、"写进代码 ≠ 拦得住"的动机。

---

## 6.2 「审查」对抗性评审抓出来、已经改掉的（2026-09-23，verdict: reject）

它的核心指控**成立**，而且有一条是我改到一半时的真事：

| # | 抓到的 | 严重度 | 改法 |
|---|---|---|---|
| E00 | **被审文件在它审查期间被改了 4 次，而部署副本一次都没同步**；自检中途还 exit 1 过一次（`ReferenceError: lastUserText is not defined`，我删了导出没删断言） | ★ 高（"改好了"只是工程副本里的字） | 已同步并逐文件 SHA256 核对；**教训**：先跑自检通过再同步，别事后补 |
| E01 | **状态快照报的是别人的账本**（生产实证）：会话 `11622ba2` 的快照原文 `· 工作区：<WORKSPACE>` / `· .warden：已建（轮次 104 ｜ 发现 51 ｜ 角色发言 12 ｜ 脑子 12）`，与 `<WORKSPACE>\.warden` **4/4 精确吻合**；而它真正在做的工程（有 `.git`）账本是 ROUNDS 57 / FINDINGS 59，容器目录 `<WORKSPACE>` **没有 `.git`** | ★ 高 | 就是上面第 2 条 `findProjectRoot` 修的那个；**这条生产实证比我的推断硬** |
| E02 | **零观测**：全文 0 处落盘/计数，异常被空 `catch` 吞掉 ⇒ 「闸响过并放行」与「闸**从没被派发**」在证据上**长得一模一样**（它扫了 9 个 session 日志，严格 needle 命中 0） | ★ 高 | 加 `makeProbe()` 有界探针（每进程 ≤8 行、文件 ≤64KB）：`mounted` / `prompt-service-missing` / `tool` / `deny` / `pre-execute-threw`，落在工程根 `.warden/team-guard-probe.jsonl` |
| E03 | 部署版的参与判据是**子串匹配**（`/warden\.mjs/`）⇒ `Test-Path ...\warden.mjs` 这种**没跑**它的命令也解锁整场会话 | ★ 高 | 与「方向员」的 #1 同一个洞，已收窄 |
| E04 | 拒绝理由**自带绕过口令**（"直接重试本次调用即可放行"）与 `maxDenies=1` 合起来 ⇒ 加固实为一次往返，而文件头却自称"真拦" | 中 | 两处都改成**如实描述**（默认是**减速带**不是路障）；且措辞**跟着配置走**：`maxDenies>1` 时拒绝理由改成"重试不会放行"（有断言钉住） |
| E05 | 协议段"位置最靠后/最后看到的东西"**实测不成立**（生产 system prompt 11402 字，协议段起于偏移 8032，**其后仍有 3370 字**） | 中 | 段位从 9500 挪到 **10250**（persona 后缀 10200 之后），"最后读到"这句才成立；两处自检都有断言钉住这个大小关系 |
| E06 | 本文件是**名单第 9 份硬拷贝**，而 `warden.mjs` 的 `roleRegistryAudit()` **扫不到它** ⇒ 加第九席时这里静默漂移 | 中 | 协议段里**不再抄角色名单**，只留"名单只有一张 = `ROLE_REGISTRY`"的指针 |
| E08 | `inject: ['systemPrompt']` + 单一 `apply` ⇒ prompt 服务一旦不可用，整行停到 waiting，**三种形态连同闸一起静默消失** | 中 | 去掉 `inject`，改 `ctx.get('systemPrompt')` + undefined 检查；**闸不依赖它**（有断言：prompt 服务缺失时闸照样装、照样响） |

它**特意没有**指控的（我照录，避免自夸）：remind 模式不是假的、子代理没被误伤、
子代理 prompt 不抖、三种形态在 roles 会话里确实生效。

它标"查不到"的：两条 `pre-execute` 监听器的**实际注册顺序**、新窗口真实体感。

---

## 7. 诚实的边界（**没验的、和验不了的**）

- ✅ 已验证：preset 能挂载、每一行都激活、闸的判决矩阵、`init` 不解锁、异常 fail-open、
  主/子代理分流、工程根判定（含容器目录）、脑子政策三值、`check` exit 0、
  两个自检在**安装目录里**也 exit 0、探针真落盘、prompt 服务缺失时闸照活。
- ❌ **没验**：新窗口里的**真实体感** —— 协议段是否真的让模型改行为、第一次 `write` 被拒后
  它是否照拒绝理由去做。这需要**开一个新窗口**跑一次真任务。
- ❌ **没验**：与 `warden-watch.js` 那个 host 层 `tools/pre-execute` 闸的**实际先后顺序**
  （两者都是 waterfall 监听器，谁先返回 deny 谁的理由会被看到）。两者都是 deny 语义，不冲突。
- ⚠ **已知不一致**：`<WORKSPACE>\task-warden\warden.mjs` 与 skill 里那份**原来差 1 行**
  （D: 那份有一处注释与代码被粘连成一行，`const stampBy` 被注释掉 ⇒ 那条代码路径会 ReferenceError）。
  本次已用 skill 版覆盖 D: 版修好，两份现在**逐字节一致**。
- ⚠ **刻意没做**：不把 `pwsh` 加进 `mutatingTools`。加了会与 R36 闸的 `judgeShell` 在同一批命令上叠两层判据，
  连 `git status` / `cargo build` 都要过闸 —— 那是添乱。代价是**用 shell 写文件能绕过这个闸**（已知、接受）。
