# 安装说明 / Install

> 这是 **[README.md](README.md)**（介绍）的配套安装文档。中英双语，内容同构。
> Companion install doc for **[README.md](README.md)**. Bilingual, same structure in both languages.

---

## 中文

### 0. 各部分装到哪

| 目录 | 装到 | 是什么 |
|---|---|---|
| `01-skill/` | `~/.dsh/skills/task-warden/` | **主脚本**（`warden.mjs` 等）+ 实验台。DSH 从这个路径加载 skill |
| `02-preset-roles/` | `~/.dsh/.agent-presets/roles/` | **agent preset**（8 席角色、硬动作）+ **角色协议加固插件 `team-guard.mjs`**。⚠ 必须**整目录**复制：`agent.cordis.yml` 里有 `name: ./team-guard.mjs`，少了那个文件 preset 会挂不上 |
| `03-host-plugin/` | 任意固定目录，建议 `<你的工程>/task-warden/plugin/` | **常驻 Host 插件**：执行前闸、交付闸、自动启用守卫、刷新端 `plugin-io.js`。⚠ **自动启用守卫会改写 `~/.dsh/settings.yaml`**（只改 `agent-presets.default` 那一行，**每次改写前留一份 `settings.yaml.bak-preset-guard-<时间戳>`**） |
| `04-config/` | **不要整个覆盖** —— 照第 3 步手改 | 两处配置 |
| `05-project-docs/` | 工程根（有 `.git` 的那一层） | **公开版不含此目录**（那是"某个项目的账"，含作者自己的原话与机器路径）。要建自己的账本：在工程根跑 `node warden.mjs init` |

**概念**：`01-skill` 是"工具"（装一份）；`.warden` 是"某个项目的账"（每个项目一份，放在它的 `.git` 那一层）。

### 1. 装 skill

把 `01-skill/` 复制到 `~/.dsh/skills/task-warden/`，验证：

```powershell
#   期望末行：`[自检] 通过：该抓的都抓住了，该放行的没误伤。` + exit 0（控制条数与口径见下）。
#   ⚠ 若在**受限沙箱**里跑（子进程不能用管道捕获 stdio ⇒ `spawnSync … EPERM`），
#   会有一批用例因为「沙箱没建起来」而报★不符★ —— 那是**环境**问题，不是装坏了。
node "$HOME/.dsh/skills/task-warden/selftest.mjs"
```

**口径**：2026-09-25 实测，Node v24，包根 `package.json` **不含** `type:module`。

期望：末行 `[自检] 通过：该抓的都抓住了，该放行的没误伤。`，exit 0 ——
该口径下的控制条数**原样**为
`负控 59 条（漂移/糊弄/替用户拍板/假通过）· 正控 43 条（老实台账/该放行的放行）`，
即 **102 条正/负控**。

> ⚠ **本文件不再断言"实验台里有 1 条 FAIL（`L13`）"**。`L13` 是否仍红**没有实测**，
> 所以这里不替它下结论 —— 跑出来是红是绿**以你机器上的实际输出为准**。

### 2. 装 preset

把 `02-preset-roles/` **整个目录**复制到 `~/.dsh/.agent-presets/roles/`（6 个文件一个都不能少 —— 组合文件引用了 `./team-guard.mjs`）。

复制完可以原地自检（不需要 DSH 在跑）：

```sh
cd ~/.dsh/.agent-presets/roles
node preset-selftest.mjs        # 组合形状，62 条
node team-guard.selftest.mjs    # 加固插件逻辑，122 条
```

⚠ **改了 `team-guard.mjs` 必须重启 DSH**：判断 preset 要不要换一代只看 `agent.cordis.yml` 的
`{mtimeMs, size}`（`dsh-agent-presets/lib/index.js` 的 `compositionStamp`），插件文件变了 stamp 不变；
而且就算换代，Node 的 ESM 缓存也会把同一个 URL 的旧模块还给你。只改 `agent.cordis.yml` 时，**新开窗口**即可。

#### 本次改动（相对上一版）

- **新增 `02-preset-roles/team-guard.mjs`**：角色协议从"persona 里的一大段文字"改成三种躲不掉的形态 ——
  ① 常驻协议段（system prompt 最后一节）② 每步刷新的实时状态快照 ③ 第一次 `write`/`edit` 前的角色闸
  （本会话还没派过角色就拒一次；一个会话最多一次；子代理放行；异常 fail-open；带一个有界观测探针）。
- **新增 `subagent_coder`**：写代码时按文件/模块切块，**同一条消息里并行派多个**。
- **行为变化**：脑子（独立审查）**默认只派 1 个** —— 只有 ①结论/来源冲突 ②第 1 个查得不细
  ③要探索更多做法 三种触发条件成立时才派第 2 个，且必须 `--trigger` 记下是哪种。
  原来那张「高风险产物（总目标/架构/交付验收）要 2 个脑子」的表**已作废**。
- **新增两个自检**：`01-skill/brain-policy.test.mjs`（44 条）、`02-preset-roles/preset-selftest.mjs`（62 条）。
- `MANIFEST.json` 已重算（按 LF 归一化后的 sha256）。

### 3. 只改两处配置

**3a. `~/.dsh/profiles/web/cordis.patch.yml`** —— 加一行 `insert`（路径换成你自己的）：

```yaml
- insert:
    - id: warden-watch
      name: <你的工程>/task-warden/plugin/warden-watch.js
```

**3b. `~/.dsh/settings.yaml`** —— 让新窗口默认用它：

```yaml
agent-presets:
  default: roles
```

少了 3b，新窗口拿到的还是标准模式。

### 4. 装工程账本（仅私有版）

把 `05-project-docs/` 的内容复制到工程根（有 `.git` 的那一层）。然后：

```powershell
cd <你的工程根>
node "$HOME/.dsh/skills/task-warden/warden.mjs" check   # exit 0 = 过
```

### 5. 装完的四条自检

```powershell
# 口径：2026-09-25 实测，Node v24，包根 `package.json` **不含** `type:module`
# 主自检（102 条正/负控 = 负控 59 · 正控 43；末行「[自检] 通过：该抓的都抓住了，该放行的没误伤。」+ exit 0）
node "$HOME/.dsh/skills/task-warden/selftest.mjs"
node "<你的工程>/task-warden/plugin/gate.selftest.mjs"                    # 全绿：23 项用例，0 红
node "<你的工程>/task-warden/plugin/preset-default-guard.mjs" --selftest # 期望 32/32
cd "$HOME/.dsh/skills/task-warden/experiments/lab" ; node run-all.mjs     # 实验台：在册 42 个用例（L1~L42）
```

关于实验台（第 4 条）：

- **在册 42 个模块**（`L1`~`L42`）。
- **跑全套耗时不短**（仅 `L41` 单独就要约 55 秒），**期望值以你机器上实际跑出来的为准** ——
  本文件**不写** PASS/FAIL/SKIP 的总数：那套数字**没有实测**，写上去就是编。
- ⚠ `L39` / `L40` 是**空壳**（只有一行注释、**没有 default 导出**）⇒ 跑全套时会被
  **如实 `SKIP`**（不占"通过"，也不许当证据）。这是**文件结构**（`run-all.mjs` 的 `MODULES` 在册 42 条、
  `L39/L40` 无 default 导出即 SKIP），不是跑出来的计数。
- **跑法**：`node run-all.mjs`；只看几条用 `--only L1,L4`（点名了却不在册的会逐条报出来）。
  总退出码：全 PASS/SKIP 才 0，有 FAIL 就是 1。

### 5b. ★ 装完之后，怎么确证「插件真的加载了」

5 个看守插件在正常情况下**本来就不该有任何可见效果**（fail-open，不欠账就一个字不说）
⇒「它没加载」和「它加载了但今天没话说」在用户眼里**长得一模一样**。
所以**不许靠"看效果"判断**，跑这条命令：

```powershell
node "<包根>/03-host-plugin/check-plugins-loaded.mjs"
```

它**只读**（不建目录、不写文件、不启动 DSH），并且**按退出码给你三种互斥的结论**：

| 退出码 | 结论 | 含义 |
|---|---|---|
| **0** | **确证加载** | 落点文件存在，且 `plugins` 里有**全部 6 个**键 |
| **1** | **确证没加载** | 落点文件存在（说明机制能跑），但 `plugins` 里**缺键** |
| **2** | **查不到** | 落点文件**根本不存在** |

**⚠ 第 2 条和第 3 条不是一回事，本脚本绝不把它们合并成一句"OK"：**

- **退出码 1 = 确证没加载，并且它会点名是哪一个。**
  输出形如 `⊗ 没有加载（2）：handover-gate, warden-watch` ——
  **列出来的那个 id，就是那个没被加载的插件**（缺的键 = 没留痕的插件）。
  这是"查过了、有问题"，照着名字去查那个插件为什么没起来。

- **退出码 2 = 查不到，这不是"没问题"。**
  落点文件不存在，**既不证明插件没加载，也不证明加载了**。
  本脚本只知道"这里的痕迹不存在"，**分不出**是下面哪一种：
  ① 插件压根没装上；② 装上了但宿主没跑起它们；③ 跑起来了但这个进程写不进去（沙箱/权限）。
  ⇒ **不要**把退出码 2 当成通过记录。真出 2 的时候，脚本会自己把 4 个候选落点列给你，
  按提示用 `--dir <你确定可写的地方>` 并设 `WARDEN_PLUGIN_LEDGER=<同一个地方>` 重试。

**为什么是 6 个键，不是 5 个：**探针是 **6 个**插件写的 ——
5 个看守（`role-voices` / `handover-gate` / `branch-guard` / `report-spill` / `warden-watch`）
**外加 `context-dedup`**。每一个都在自己的 `apply()` 第一行调用 `markPluginLoadedWithRetry(...)` 留痕，
`PLUGIN-LOADED.json` 的 `plugins` 里就多一个自己的键。所以**全加载 = 6 个键**。
（要自己数：`grep -c "markPluginLoadedWithRetry("` 在 `03-host-plugin/` 下数**调用点**，
函数定义本身不算；**6 个文件各 1 处 = 6 个键**。）

**落点怎么找**（脚本按四级兜底，先命中的先用，来源会打印在"来源:"那行）：
`WARDEN_PLUGIN_LEDGER` → `DSH_HOME/plugin-ledger` → `~/.dsh/plugin-ledger` → `<tmpdir>/dsh-plugin-ledger`。

**先确认脚本自己没坏**（可选，但推荐；全绿才算它的判据可信）：

```powershell
node "<包根>/03-host-plugin/check-plugins-loaded.selftest.mjs"   # 期望：PASS 34，FAIL 0，exit 0
```

> ⚠ 两个可选项注意：
> - `--json` 给机器读，`state` 字段与退出码一一对应（`loaded`/`partial`/`not-found` ⇒ 0/1/2）。
> - **`--dir` 只查、不写。** 它**不会**为你去跑一遍插件来生成落点文件 ⇒
>   指一个从没跑过插件的空目录，你拿到的是 **exit 2（查不到）**，不是 0、也不是 1。
>   要有落点文件，得先让宿主真的加载过一次那些插件。

**口径（别扩大）**：「加载了」= 宿主**调用过它的 `apply()`**（留痕写在 `apply` 第一行）。
这**不**等于"它今天干了活" —— 看守没事可做时本来就一个字都不说。

### 6. 实测踩过的四个坑（别重复）

1. **改了插件代码却不生效** —— `patchReload: live` 只重载"挂哪些插件"，**不重载代码**（Node 的 require 缓存）⇒ **必须重启 DSH**。
   实测：改完 patch 文件等 8 秒，服务器进程的探针没有重新出现。
2. **两份 `warden.mjs` 会分叉** —— `~/.dsh/skills/` 那份是 DSH 真正加载的，工程那份是给实验台用的，**必须逐字节一致**，
   否则实验台在测旧代码、结论不可信。（**本公开包里的实验台在册 42 个模块：L1~L42**；
   其中 `L39`/`L40` 是空壳，见第 5 步。作者自己那份还有更多。）
3. **PowerShell 会改写参数里的引号** —— 带字面 `"` 的值（例如子项名 `监督员职责含"保证角色在跑"`）经 PowerShell 传参会坏掉，
   `record --covered` 会永远对不上。遇到这种参数，用 Node 的 `spawnSync` 直接传 argv 数组。
4. **沙箱可能禁子进程用管道捕获 stdio** —— `spawnSync(..., {encoding:'utf8'})` 可能 `EPERM`。
   要捕获输出就把 stdout/stderr 指到**文件的 fd**（`stdio: ['ignore', fd, fd]`）再读回来。
   `cmd /c "... & echo %errorlevel%"` 读的是**解析期的旧值**，不能用 —— 用 `$LASTEXITCODE`。

### 7. 常用命令

```powershell
$w = "$HOME/.dsh/skills/task-warden/warden.mjs"

node $w init                      # 在工程根建 .warden 骨架
node $w needs  --last 5           # 开工：需求清单（逐条原话 → 归宿 → 要做的 R#）
node $w record --req R7 --status done --delivered "…" --evidence "…" `
               --covered "子项1|子项2" --avoided "不要项=怎么避开的"
node $w check                     # 说"完成"之前必须跑：exit 0 才算过
node $w results --last 5          # 收尾：结果清单 + 逐条对账
node $w roles --health            # 「角色是不是摆设」的机械仪表
node $w delegation                # 主代理自己写了几个文件 / 派了几次单
node $w guard                     # 容器守卫逐条台账（谁被忽略、为什么）
node $w report                    # 生成 .warden/REPORT.md（需求→交付→成本主表）
```

**两条硬规矩**（脚本会拦）：

1. `--status done` 必须 `--covered` 覆盖**全部子项**；若该需求有「不要」，必须 `--avoided` **逐条交代怎么避开的**。
2. 改一件已经 `done` 的东西之前，先 `node $w snapshot --label "改 R# 之前"`，
   再让**资料员和方向员各写一条规划**（`find add`），否则 `record` 拒收。

### 8. ★⚠ `handover-gate` 会**拒绝改文件** —— 先读这一节

**症状**：在一个**有 `.git`、但没有 `交接.md`** 的目录里，`handover-gate` 会
**直接拒绝你的改盘类工具**（`write`/`edit`/`shell`）。它的自述是 **fail-closed 设计**：
"交接文件不存在" ⇒ **拒**，并记一行失败 `handover-missing`（**不静默**）。

> 这是**设计如此**，不是装坏了 —— 也就是说：**装完它之后，你会在自己原来的工程里突然改不动文件。**
> 想继续改，要么补一份 `交接.md`，要么按下面关掉。

**怎么关掉**：

1. **★ 要真正解除"改不动文件"，只有这一条路：从 `cordis.patch.yml` 的 `insert` 列表里
   删掉 `handover-gate` 那两行**（`- id: handover-gate` 与它下面那行 `name:`）。
   包根 `cordis.patch.yml` 第 30–33 行逐字写着：
   「③ handover-gate —— **它会拒绝改文件**…**要关掉它：删掉下面 handover-gate 那两行**；
   或设 `WARDEN_HANDOVER_STEER=off`（**后者只关"收尾提醒"，不关 deny**）。」
   ⇒ **删 insert 行是唯一确定能解 deny 的做法**。增删 insert 行本身是 **live 的**（该文件第 21 行），
   **不必重启**；但改插件 `.js` 代码必须重启 DSH。
2. **环境变量 `WARDEN_HANDOVER_STEER=off`** —— 这是 `handover-gate` **自己的开关**，
   而且**每次现读**（`envNow`）⇒ **不必重启 DSH**，改完立刻生效。
   **但它只关"收尾提醒（steer）"，不关 deny**（见上面 `cordis.patch.yml` 的原话）。

   > 依据：`03-host-plugin/handover-gate.js` 的 `normalizeOpts` 与 `steerEnabled()`；
   > 代码注释逐字写着「`WARDEN_HANDOVER_STEER=off` 可关（**每次现读**，见 normalizeOpts）」。
   > 同一个源文件里另有 `WARDEN_HANDOVER_STEER_MAX_TURN`（默认 `1`）与
   > `WARDEN_HANDOVER_STEER_MAX_SESSION`（默认 `2`），也是现读。

   ⚠ **别把这条当成"改不动文件的解药"** —— 那正是本包差点重复的错：
   把"关提醒"误当成"关 deny"。

**⚠ 不要凭猜设环境变量**：本包此前有过一次教训 —— 有人把 **`WARDEN_HANDOVER_AUTO`**
写进文档，而这个变量名在代码里**搜不到**（我复核：`03-host-plugin/handover-gate.js` 中
`WARDEN_HANDOVER_AUTO` 命中 **0 处**）。
⇒ **凡是你没核实过的开关名，一律不许当成"确定可用"**；写成"见该文件注释"或标「**未核实**」。

> **未核实清单（本节）**：
> - 该变量对其它闸门（例如 `warden-watch` 的 steer）是否同样有效 —— **未核实**
>   （代码里能搜到的是 `handover-gate` 这一侧）。
> - 删掉包根 `cordis.patch.yml` 的那两行之后，是否还有别处会挂载 `handover-gate` —— **未核实**。
> - **若你是照第 3a 步把插件挂到 `~/.dsh/profiles/web/cordis.patch.yml` 的**，
>   要删的是**你自己那个 profile 文件**里的那两行（本文件给的是包根 `cordis.patch.yml` 的形态）——
>   两者要改哪个**取决于你实际挂在哪**，**未核实你的具体挂法**。

### 9. 校验备份完整性

```powershell
node -e "const m=require('./MANIFEST.json'),fs=require('fs'),c=require('crypto'),p=require('path');let bad=0,missing=0;for(const f of m.files){try{const b=fs.readFileSync(p.join('.',f.rel));if(c.createHash('sha256').update(b).digest('hex')!==f.sha256||b.length!==f.size)bad++}catch(e){missing++}}console.log(bad||missing?('有 '+bad+' 个不一致、'+missing+' 个缺失'):('全部 '+m.files.length+' 个一致'));process.exit(bad||missing?1:0)"
```

---

## English

### 0. What goes where

| Directory | Install to | What it is |
|---|---|---|
| `01-skill/` | `~/.dsh/skills/task-warden/` | The main scripts (`warden.mjs`, …) + the lab suite. DSH loads the skill from this path |
| `02-preset-roles/` | `~/.dsh/.agent-presets/roles/` | The agent preset (8 role seats, hard actions) + the **role-protocol hardening plugin `team-guard.mjs`**. ⚠ Copy the **whole directory**: the composition references `./team-guard.mjs`, and the preset will not mount without it |
| `03-host-plugin/` | any fixed directory, e.g. `<your-project>/task-warden/plugin/` | Standing Host plugin: pre-execution gate, delivery gate, auto-enable guard |
| `04-config/` | **Do not overwrite** — hand-edit, see step 3 | Two configuration spots |
| `05-project-docs/` | your project root (the layer with `.git`) | **Private edition only**: one project's ledger + handoff docs |

**Concept**: `01-skill` is the *tool* (install once). A `.warden` ledger is *one project's account*
(one per project, at that project's `.git` layer).

### 1. Install the skill

Copy `01-skill/` to `~/.dsh/skills/task-warden/`, then verify:

```powershell
#   Expected last line: `[自检] 通过：该抓的都抓住了，该放行的没误伤。` + exit 0 (basis below).
#   ⚠ In a **restricted sandbox** (child processes cannot pipe stdio ⇒ `spawnSync … EPERM`)
#   a batch of cases will report ★不符★ because "the sandbox could not be built" —
#   that is an **environment** problem, not a broken install.
node "$HOME/.dsh/skills/task-warden/selftest.mjs"
```

**Basis**: measured 2026-09-25, Node v24, package-root `package.json` **without** `type:module`.

Expected: last line `[自检] 通过：该抓的都抓住了，该放行的没误伤。`, exit 0 —
under that basis the control counts read **verbatim**
`负控 59 条（漂移/糊弄/替用户拍板/假通过）· 正控 43 条（老实台账/该放行的放行）`,
i.e. **102 positive/negative controls**.

> ⚠ **This file no longer asserts "the lab suite has 1 FAIL (`L13`)".** Whether `L13` is still red
> has **not been measured**, so no conclusion is drawn here — red or green,
> **trust whatever your own machine actually prints**.

### 2. Install the preset

Copy `02-preset-roles/` to `~/.dsh/.agent-presets/roles/`.

### 3. Edit exactly two configuration spots

**3a. `~/.dsh/profiles/web/cordis.patch.yml`** — add one `insert` row (path = your own):

```yaml
- insert:
    - id: warden-watch
      name: <your-project>/task-warden/plugin/warden-watch.js
```

**3b. `~/.dsh/settings.yaml`** — make the preset the default for new windows:

```yaml
agent-presets:
  default: roles
```

Without 3b, new windows still get the standard preset.

### 4. Install the project ledger (private edition only)

Copy the contents of `05-project-docs/` into your project root (the layer with `.git`). Then:

```powershell
cd <your-project-root>
node "$HOME/.dsh/skills/task-warden/warden.mjs" check   # exit 0 = pass
```

### 5. Four self-checks after installing

```powershell
# Basis: measured 2026-09-25, Node v24, package-root `package.json` **without** `type:module`
# main self-test (102 positive/negative controls = 59 negative · 43 positive;
# last line 「[自检] 通过：该抓的都抓住了，该放行的没误伤。」+ exit 0)
node "$HOME/.dsh/skills/task-warden/selftest.mjs"
node "<your-project>/task-warden/plugin/gate.selftest.mjs"                # 全绿：23 项用例，0 红
node "<your-project>/task-warden/plugin/preset-default-guard.mjs" --selftest   # expect 32/32
cd "$HOME/.dsh/skills/task-warden/experiments/lab" ; node run-all.mjs     # lab: 42 cases on the books (L1–L42)
```

About the lab suite (4th check):

- **42 modules on the books** (`L1`–`L42`).
- **A full run takes a while** (`L41` alone is about 55 s), and **the expected numbers are whatever
  your own machine actually prints** — this file **does not** state a PASS/FAIL/SKIP total:
  those numbers were **never measured**, and writing them down would be inventing them.
- ⚠ `L39` / `L40` are **empty shells** (one comment line, **no default export**) ⇒ a full run reports
  them as a truthful **`SKIP`** (they do not count as a pass, and must not be used as evidence).
  This is **file structure** (`run-all.mjs`'s `MODULES` lists 42; `L39`/`L40` have no default export
  ⇒ SKIP), not a measured count.
- **How to run**: `node run-all.mjs`; to run only a few, `--only L1,L4` (names you list that are not on
  the books are reported one by one). Overall exit code: 0 only when everything is PASS/SKIP, 1 if any FAIL.

### 6. Four traps we actually hit (do not repeat them)

1. **Editing plugin code has no effect until you restart DSH.** `patchReload: live` reloads *which
   plugins are mounted*, **not their code** (Node's `require` cache). Verified: after editing the
   patch file, the server process's probe did not reappear.
2. **The two `warden.mjs` copies will diverge.** The one under `~/.dsh/skills/` is what DSH loads;
   the one in the project is what the lab uses. They must be **byte-identical**, or the lab silently
   tests stale code and its conclusions are worthless. (This public package ships **42 lab modules
   on the books, L1–L42**; `L39`/`L40` are empty shells, see step 5. The author's own copy has more.)
3. **PowerShell rewrites quotes inside arguments.** A value containing a literal `"` gets mangled, so
   `record --covered` never matches. Pass such arguments through Node's `spawnSync` with an argv array.
4. **Piped stdio in child processes may be blocked** in a sandbox (`EPERM`). To capture output, point
   stdout/stderr at a **file descriptor** (`stdio: ['ignore', fd, fd]`) and read the file back.
   `cmd /c "... & echo %errorlevel%"` reads a stale value — use `$LASTEXITCODE`.

### 7. Everyday commands

Same commands as the Chinese section above. Two hard rules the scripts enforce:

1. `--status done` requires `--covered` for **every** sub-item, and if the requirement has `不要`
   items, `--avoided` for **every one of them**.
2. Before modifying something already marked `done`: `node $w snapshot --label "before changing R#"`,
   then have the *researcher* and *direction* roles each file a plan (`find add`), or `record` refuses.

### 8. ★⚠ `handover-gate` will **refuse your file edits** — read this first

**Symptom**: in a directory that **has `.git` but no `交接.md`**, `handover-gate`
**refuses your disk-writing tools outright** (`write`/`edit`/`shell`). It calls itself a
**fail-closed design**: "handoff file absent" ⇒ **deny**, and it records a failure row
`handover-missing` (it does **not** stay silent).

> This is **by design**, not a broken install — which means: **after installing it, you may suddenly
> be unable to edit files in your own project.** To keep editing, either add a `交接.md` or turn it
> off as below.

**How to turn it off**:

1. **★ The only route that actually clears "I can't edit files": delete the two `handover-gate`
   rows from the `insert` list in `cordis.patch.yml`** (the `- id: handover-gate` row and the `name:`
   row under it). Lines 30–33 of the package-root `cordis.patch.yml` read verbatim:
   「③ handover-gate —— **它会拒绝改文件**…**要关掉它：删掉下面 handover-gate 那两行**；
   或设 `WARDEN_HANDOVER_STEER=off`（**后者只关"收尾提醒"，不关 deny**）。」
   ⇒ **Deleting the insert rows is the only thing certain to clear the deny.** Adding/removing
   insert rows is **live** (line 21 of that file), so **no restart needed**; but editing plugin
   `.js` code does require a DSH restart.
2. **The environment variable `WARDEN_HANDOVER_STEER=off`** — this is `handover-gate`'s **own switch**,
   read **fresh every time** (`envNow`) ⇒ **no DSH restart needed**, it takes effect immediately.
   **But it only turns off the wrap-up steer, not the deny** (see the verbatim quote above).

   > Source: `03-host-plugin/handover-gate.js`, `normalizeOpts` and `steerEnabled()`;
   > the code comment reads verbatim 「`WARDEN_HANDOVER_STEER=off` 可关（**每次现读**，见 normalizeOpts）」.
   > The same source file also has `WARDEN_HANDOVER_STEER_MAX_TURN` (default `1`) and
   > `WARDEN_HANDOVER_STEER_MAX_SESSION` (default `2`), both read fresh as well.

   ⚠ **Do not read that as the cure for "I can't edit files"** — that is exactly the mistake this
   package nearly repeated: mistaking "turns off the reminder" for "turns off the deny".

**⚠ Do not set environment variables on a guess**: this package has been burned once before —
someone wrote **`WARDEN_HANDOVER_AUTO`** into a doc, but that name **cannot be found in the code**
(I re-checked: in `03-host-plugin/handover-gate.js`, `WARDEN_HANDOVER_AUTO` has **0 hits**).
⇒ **Never present a switch name you have not verified as "definitely works"**; write
"see that file's comments", or mark it **unverified**.

> **Unverified list (this section)**:
> - Whether that variable affects other gates (e.g. `warden-watch`'s steer) — **unverified**
>   (what the code does contain is the `handover-gate` side).
> - Whether anything else still mounts `handover-gate` after you delete those two rows from the
>   package-root `cordis.patch.yml` — **unverified**.
> - **If you mounted the plugin into `~/.dsh/profiles/web/cordis.patch.yml` per step 3a**, the rows to
>   delete are in **your own** profile file (what is quoted here is the package-root
>   `cordis.patch.yml` shape) — which of the two you must edit **depends on where you actually
>   mounted it**, and **your specific mount was not verified**.

### 9. Verify the backup's integrity

```powershell
node -e "const m=require('./MANIFEST.json'),fs=require('fs'),c=require('crypto'),p=require('path');let bad=0,missing=0;for(const f of m.files){try{const b=fs.readFileSync(p.join('.',f.rel));if(c.createHash('sha256').update(b).digest('hex')!==f.sha256||b.length!==f.size)bad++}catch(e){missing++}}console.log(bad||missing?('有 '+bad+' 个不一致、'+missing+' 个缺失'):('全部 '+m.files.length+' 个一致'));process.exit(bad||missing?1:0)"
```
