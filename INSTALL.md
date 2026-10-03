# 安装说明 / Install

> 这是 **[README.md](README.md)**（介绍）的配套安装文档。中英双语，内容同构。
> Companion install doc for **[README.md](README.md)**. Bilingual, same structure in both languages.

> ⚠ **2026-10-03 整节重写。** 旧版本让你做的三件事，在当前 DSH 上**已经不管用了**，
> 照做出来的结果是"看起来装上了、其实什么都没挂"，或者更糟 —— 直接让 GUI 拒绝新建会话。
> 改动与理由见第 3 节，别拿旧版步骤去对照。

---

## 中文

### 0. 一条命令

```powershell
git clone https://github.com/MiniDisike/SeptemberProjectTeam.git
cd SeptemberProjectTeam
node install.mjs
```

就这样。装完**重启 DSH**、**新开一个窗口**，两步缺一不可（第 8 节说为什么）。

`install.mjs` 会做这些事，每一件都对应一个**实测踩过的坑**：

| 它做的事 | 不做会怎样 |
|---|---|
| 剥掉包根 `package.json` 的 UTF-8 BOM、全仓 CRLF→LF | 带 BOM 时 DSH 的 peer-deps 校验 `JSON.parse` 失败，**每一行插件**都被标成 `disabling profile plugin row` 而静默不加载 |
| skill 镜像到 `~/.dsh/skills/task-warden/` | 两份 `warden.mjs` 会分叉，实验台在测旧代码 |
| 6 个宿主插件装到 `<包根>/plugin/` | —— |
| 由 `02-preset-roles/agent.cordis.yml` 生成 preset 声明 | 少了这一步，preset 根本不存在 |
| **逐行核对 preset 里的包名与装机包的真实清单**，缺包的自动 `disabled: true` | 引用一个 DSH 已不发布的包 ⇒ `auditRows()` 判 failed ⇒ preset `broken` ⇒ **GUI 拒绝「新建会话」** |
| 把插件行与 preset 声明写进 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的托管块 | —— |
| 顺手修掉 profile 里上一轮手工插入的旧行、重复的 `default:` 键 | 两套同名行并存，行为取决于加载顺序 |
| 把 registry 的 `default` **和** `selectedDefault` 都对齐 | `defaultId` 是 `selectedDefault ?? default` ⇒ 只写 `default` 而 `selectedDefault` 还指着别的 id，**装了等于没装** |
| 每次改 profile 之前自动备份 | —— |
| 装完自检 8 项 | —— |

常用开关：

```powershell
node install.mjs --dry-run            # 只打印计划，一个字节都不写
node install.mjs --check              # 只体检，不写；退出码即结论
node install.mjs --verify-boot        # 额外用一次性 profile 真启动一次，验 preset 真的挂得上（慢，约 40 秒）
node install.mjs --refresh-manifest   # 改了包里的文件之后，重算 MANIFEST.json
node install.mjs --keep-selected      # 不动 registry 的 selectedDefault（你自己在 GUI 里选过 preset 时用）
node install.mjs --selftest           # 装完把包里 7 个自检全跑一遍（慢）
node install.mjs --repo-only          # 维护者用：只去 BOM/CRLF + 重算 MANIFEST，**一个字都不往机器上装**
node install.mjs --profile <名>       # 指定 profile（默认自动探测，一般是 desktop）
node preflight.mjs                    # 维护者/贡献者用：能不能发（有没有绑本机路径、有没有夹带隐私）
node preflight.mjs --all              # 连未追踪的本地文件一起查（查本机垃圾用）
```

> `preflight.mjs` 是**公有化的守门人**：查写死的本机路径、凭据、个人邮箱、
> 不该进库的文件（`.warden/`、`install-out/`、交接文件、调试日志、`.merkle-snapshot.json`），
> 以及 BOM / CRLF 这两个"静默把整包插件废掉"的老坑。退出码即结论。
> ⚠ 它**只**能证明"可移植 + 干净"，证不了"装得上" —— 那是 `--verify-boot` 的事。

### 1. 各部分装到哪

| 目录 | 装到 | 是什么 |
|---|---|---|
| `01-skill/` | `~/.dsh/skills/task-warden/` | **主脚本**（`warden.mjs` 等）+ 实验台 |
| `02-preset-roles/` | `<包根>/preset-roles/` | **agent preset 的源**：8 席角色 + 角色协议加固插件 `team-guard.mjs`。⚠ 整目录复制 |
| `03-host-plugin/` | `<包根>/plugin/` | **常驻 Host 插件** 6 个：执行前闸、交付闸、交接闸、支线守门员、上下文去重、报告落盘 |
| `04-config/` | 不参与加载 | 说明文档 + 一个空的 `[]`（内容见文件内注释） |
| `install-out/` | 本机生成 | `all.patch.yml`（可当 `--patch` 用）、`verify.patch.yml`、`boot.log`、`dump-config.log` |

**概念**：`01-skill` 是"工具"（装一份）；`.warden` 是"某个项目的账"（每个项目一份，放在它的 `.git` 那一层）。

### 2. 装完自检

```powershell
node install.mjs --check              # 8 项安装体检，不写任何东西
node install.mjs --selftest           # 把包里 7 个自检全跑一遍
```

`--check` 查这 8 项，有一条不过就非零退出：编码/BOM、skill 两份逐字节一致、6 个插件在、
`team-guard.mjs` 在、`package.json` 能被 `JSON.parse`、preset 里启用的行包都在、
profile 托管块齐全且没有重影、profile 文件是顶层 YAML 数组。

`--selftest` 跑这 7 个：

| 自检 | 期望 |
|---|---|
| skill 主自检（`01-skill/selftest.mjs`） | 102 条（负控 59 + 正控 43），末行「[自检] 通过：该抓的都抓住了，该放行的没误伤。」 |
| `01-skill/brain-policy.test.mjs` | 44 条 |
| `03-host-plugin/gate.selftest.mjs` | 全绿：23 项用例，0 红 |
| `03-host-plugin/preset-default-guard.mjs --selftest` | 32/32 |
| `03-host-plugin/check-plugins-loaded.selftest.mjs` | 34/34 |
| `02-preset-roles/preset-selftest.mjs` | 62 条 |
| `02-preset-roles/team-guard.selftest.mjs` | 208 条 |

> ⚠ 在**受限沙箱**里跑会有用例因为"子进程不能用管道捕获 stdio（`spawnSync` EPERM）"而红 ——
> 那是**环境**问题，不是装坏了。
> ⚠ `preset 形状` 只证明组合文件**形状**对；真正的判据是运行中 DSH 里的 `standingKeyFor('roles')`。

再确证「插件真的加载了」（这一步**只能**在重启 DSH 之后做）：

```powershell
node "<包根>/plugin/check-plugins-loaded.mjs"
```

| 退出码 | 结论 | 含义 |
|---|---|---|
| **0** | **确证加载** | `plugins` 里有**全部 6 个**键 |
| **1** | **确证没加载** | 落点文件在，但缺键；输出会点名缺的是哪一个 |
| **2** | **查不到** | 落点文件根本不存在。**这不是"没问题"**，分不出"没装 / 宿主没跑 / 写不进去" |

「加载了」= 宿主**调用过它的 `apply()`**（留痕写在 `apply` 第一行）。
这**不等于**"它今天干了活" —— 看守没事可做时本来就一个字都不说。

### 3. ⚠ 当前 DSH 上**已经退役**的三种做法（旧版 INSTALL 就是这么写的）

这一节是本次重写的主要理由。每一条都对着装机包核实过，不是推测。

| 旧做法 | 现在的实际情况 | 依据 |
|---|---|---|
| 把 `02-preset-roles/` 复制到 `~/.dsh/.agent-presets/roles/` | **没有任何东西再读这个目录。** preset 现在是 profile patch 里一行 `@deepseek-ai/dsh-agent-preset`，它的 `config.plugins` 就是原 `agent.cordis.yml` 的内容 | `dsh-agent-preset/lib/index.js:7-19`（`Config` = `{id, name, description, order, plugins}`） |
| 改 `~/.dsh/settings.yaml` 的 `agent-presets.default` | 该文件被导入一次后就改名成 `settings.yaml.imported`。**默认值现在在 profile patch 的 `agent-preset-registry` 行里** | `dsh-agent-preset-registry/lib/index.js:471-473`（`Config` = `{default: 必填, selectedDefault: volatile}`） |
| 在 `cordis.patch.yml` 里手写 `name: ./03-host-plugin/warden-watch.js` | 相对路径**只能**在 patch 的 `insert` 直属行里用；写在 `config.plugins` 里的 name **不会被转成 `file://` URL** ⇒ 裸 Windows 绝对路径在 `import()` 里报 `ERR_UNSUPPORTED_ESM_URL_SCHEME` | `dsh-app-boot/lib/index.js:3537-3545` |

**`selectedDefault` 这一条最容易被忽略**：

```js
get defaultId() { return this.config.selectedDefault.get() ?? this.config.default; }   // registry:493-494
```

`selectedDefault` 是 volatile 字段，**它在的时候说了算**。
只写 `default: roles` 而 `selectedDefault` 还停在 `cordis`，GUI 就会继续拿标准模式开会话，
而你会以为"装上了没生效"。`install.mjs` 默认两个一起对齐；你要保留自己的选择就加 `--keep-selected`。

### 4. preset 里那些"看起来像路径"的东西

- **`<WORKSPACE>` 这种占位符是最危险的一种。** DSH 解析不了它，会当成**相对路径**去找，
  结果是插件静默不加载（只打一行警告）。本包 2026-09-25 起所有路径一律**运行时推导**
  （`new URL(…, import.meta.url)` / `os.homedir()` / `os.tmpdir()` / 环境变量），包里不写死路径。
- `02-preset-roles/agent.cordis.yml` 里 `name: ./team-guard.mjs` 是**唯一**保留的相对名 ——
  它靠 `Include` 按 composition 所在目录解析（`classifyRowSpecifier`）。
  但那是在 preset **目录**语义下；被 `install.mjs` 抄进 profile patch 的 `config.plugins` 后，
  就必须改写成 `file:///` 绝对 URL。安装器会自动改。
- **Windows 路径一律写 `file:///`。** 顶层 `insert` 行两种写法都能过，统一用 URL 是为了不再分情况。

### 5. ⚠ 一旦 DSH 升级，preset 可能整体挂掉

`install.mjs` 每次都会**按装机包的真实清单**逐行核对 preset 里的包名，
把"这机器上没有"的那些自动 `disabled: true`（只改生成物，不动源文件）。

但有两类它判不了，会**如实列出来**而不是默默放过：

1. `disabled: !!js …` 这种运行期表达式（静态判不出来）；
2. 包在、但**子路径没导出**（例如 `@deepseek-ai/dsh-tool-subagent-control/list-agents`）。

真挂了的表现是 **GUI 拒绝「新建会话」**，而**启动日志往往是干净的** ——
`agent-preset-registry` 的 `diagnostic()` 是**惰性**的，只有 GUI 列 preset 或建会话时才求值。
所以查这类问题要直接对着装机包核对每一行，别指望看日志。

### 5b. 为什么 `--verify-boot` 不用空壳 profile 验

一个只有 `cordis.yml: []` 的临时 profile 里没有 `shell` 服务、没有 `agent-preset-registry` 行，
于是 `warden-watch` 与 `preset-roles` 都会停在 `pending` ——
**那是试验台的缺陷，不是安装的缺陷**，照着它下结论等于自己骗自己。
`--verify-boot` 因此用 `--from-default-profile web` 建一个**真组合**的一次性 profile
（出厂可选的只有 `acp` / `headless` / `sdk` / `sdk-minimal` / `web`；
`desktop` 由 Electron 应用自己管，CLI 不让直接 boot），然后看两样东西：

1. 启动日志里没有 `disabling profile plugin row` / `agent preset …:` / `did not activate`；
2. 6 个插件都在 `PLUGIN-LOADED.json` 留了痕。

**这仍不是"新建会话一定成功"的证明** —— `diagnostic()` 惰性，最后那一步只能在 GUI 里点。

### 6. 工程账本

在你的工程根（有 `.git` 的那一层）：

```powershell
node "$HOME/.dsh/skills/task-warden/warden.mjs" init    # 建 .warden 骨架
node "$HOME/.dsh/skills/task-warden/warden.mjs" check   # exit 0 = 过
```

**不要**在 task-warden 仓库里造 `.warden` 账本 —— 那是别人的仓库，造了会污染 `git status`。

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
**直接拒绝你的改盘类工具**（`write`/`edit`/`shell`）。它的自述是 **fail-closed 设计**。

> 这是**设计如此**，不是装坏了 —— 也就是说：**装完它之后，你会在自己原来的工程里突然改不动文件。**

**怎么关掉**：

1. **★ 要真正解除"改不动文件"，只有这一条路：从 profile patch 的托管块里
   删掉 `handover-gate` 那两行**（`- id: handover-gate` 与它下面那行 `name:`）。
   增删 insert 行本身是 **live 的**（`@deepseek-ai/dsh-hmr` 监听 patch 文件），不必重启；
   但改插件 `.js` 代码必须重启 DSH。
   （下次跑 `install.mjs` 会把它加回来 —— 想永久关掉就改 `install.mjs` 顶部的 `PLUGIN_IDS`。）
2. **环境变量 `WARDEN_HANDOVER_STEER=off`** —— `handover-gate` 自己的开关，每次现读 ⇒ 不必重启。
   **但它只关"收尾提醒（steer）"，不关 deny**。

   > 依据：`03-host-plugin/handover-gate.js` 的 `normalizeOpts` 与 `steerEnabled()`；
   > 同一源文件里另有 `WARDEN_HANDOVER_STEER_MAX_TURN`（默认 `1`）与
   > `WARDEN_HANDOVER_STEER_MAX_SESSION`（默认 `2`），也是现读。

⚠ **别把"关提醒"误当成"关 deny"** —— 那正是本包差点重复的错。

⚠ **不要凭猜设环境变量**：本包此前有过一次教训 —— 有人把 **`WARDEN_HANDOVER_AUTO`**
写进文档，而这个变量名在代码里**搜不到**（`03-host-plugin/handover-gate.js` 中命中 **0 处**）。
⇒ **凡是你没核实过的开关名，一律不许当成"确定可用"**；写成"见该文件注释"或标「**未核实**」。

> **未核实清单（本节）**：
> - 该变量对其它闸门（例如 `warden-watch` 的 steer）是否同样有效 —— **未核实**。
> - 删掉托管块里那两行之后，是否还有别处会挂载 `handover-gate` —— **未核实**。

### 9. 实测踩过的坑（别重复）

1. **改了插件代码却不生效** —— `patchReload: live` 只重载"挂哪些插件"，**不重载代码**
   （Node 的 require 缓存）⇒ **必须重启 DSH**。
2. **两份 `warden.mjs` 会分叉** —— `~/.dsh/skills/` 那份是 DSH 真正加载的，
   仓库里 `01-skill/` 那份给实验台用，**必须逐字节一致**。`install.mjs` 的镜像保证这一点。
3. **PowerShell 会改写参数里的引号** —— 带字面 `"` 的值经 PowerShell 传参会坏掉，
   `record --covered` 会永远对不上。遇到这种参数，用 Node 的 `spawnSync` 直接传 argv 数组。
   ⚠ 同理，**`Set-Content -Encoding utf8` 在 Windows PowerShell 5.1 上会写 BOM** ——
   profile 目录里的 `package.json` 带 BOM 的话，DSH 启动时直接
   `SyntaxError: Unexpected token`（`readProfileManifest`）。用
   `[System.IO.File]::WriteAllText()` 或 Node 的 `fs.writeFileSync`。
4. **CRLF 会让 MANIFEST 校验整片变红** —— `.gitattributes` 现在写了 `* text=auto eol=lf`；
   校验口径是**LF 归一化后**的 sha256。`install.mjs` 每次都会先把全仓归一化。
5. **沙箱可能禁子进程用管道捕获 stdio** —— `spawnSync(..., {encoding:'utf8'})` 可能 `EPERM`。
   要捕获输出就把 stdout/stderr 指到**文件的 fd**（`stdio: ['ignore', fd, fd]`）再读回来。
6. **不要按命令行子串找 DSH 进程去 `Stop-Process`** —— GUI 宿主会派生工具 shell，
   宽过滤会把会话自己的 shell 一起杀掉。用 `job_kill`，或只 kill 你自己 `spawn` 出来的句柄。

### 10. 校验 MANIFEST

```powershell
node install.mjs --check              # 顺带就查了
node install.mjs --refresh-manifest   # 改过包里文件之后重算
```

手工校验：

```powershell
node -e "const m=require('./MANIFEST.json'),fs=require('fs'),c=require('crypto'),p=require('path');let bad=0,missing=0;for(const f of m.files){try{const b=fs.readFileSync(p.join('.',f.rel));if(c.createHash('sha256').update(b).digest('hex')!==f.sha256||b.length!==f.size)bad++}catch(e){missing++}}console.log(bad||missing?('有 '+bad+' 个不一致、'+missing+' 个缺失'):('全部 '+m.files.length+' 个一致'));process.exit(bad||missing?1:0)"
```

> ⚠ sha256 按 **LF 归一化、去 BOM** 后的字节算。

---

## English

### 0. One command

```powershell
git clone https://github.com/MiniDisike/SeptemberProjectTeam.git
cd SeptemberProjectTeam
node install.mjs
```

Then **restart DSH** and **open a new window** — both are required (§8).

`install.mjs` handles everything, and every step exists because a real install broke without it:

| What it does | What breaks without it |
|---|---|
| Strips the UTF-8 BOM from the package-root `package.json`, normalizes CRLF → LF | With a BOM, DSH's peer-deps validation fails at `JSON.parse` and **every plugin row** is marked `disabling profile plugin row` — silent, no plugin loads |
| Mirrors the skill to `~/.dsh/skills/task-warden/` | The two copies of `warden.mjs` diverge and the lab tests stale code |
| Installs the 6 standing Host plugins to `<repo>/plugin/` | — |
| Generates the preset declaration from `02-preset-roles/agent.cordis.yml` | Without it the preset simply does not exist |
| **Checks every preset row against the real package list of your DSH build** and auto-`disable`s missing ones | One unresolvable package ⇒ `auditRows()` reports failed ⇒ preset `broken` ⇒ **the GUI refuses to create a session** |
| Writes the plugin rows and the preset declaration into a managed block in `~/.dsh/profiles/<profile>/cordis.patch.yml` | — |
| Cleans up hand-inserted legacy rows and duplicate `default:` keys | Two rows with the same id, resolved by load order |
| Aligns registry `default` **and** `selectedDefault` | `defaultId` is `selectedDefault ?? default` — writing only `default` means "installed but no effect" |
| Backs up the profile file before every write | — |
| Runs 8 post-install checks | — |

Flags: `--dry-run`, `--check`, `--verify-boot`, `--selftest`, `--refresh-manifest`, `--keep-selected`, `--profile <name>`.
Maintainers / contributors also get `node install.mjs --repo-only` (normalize + recompute MANIFEST,
installs nothing) and `node preflight.mjs` (the public-release gate: baked-in machine paths,
credentials, personal data, files that must not be committed, BOM/CRLF).

### 1. What goes where

| Directory | Install to | What it is |
|---|---|---|
| `01-skill/` | `~/.dsh/skills/task-warden/` | The main scripts (`warden.mjs`, …) + the lab suite |
| `02-preset-roles/` | `<repo>/preset-roles/` | The agent preset source: 8 role seats + the role-protocol hardening plugin `team-guard.mjs` |
| `03-host-plugin/` | `<repo>/plugin/` | The 6 standing Host plugins |
| `04-config/` | not loaded | Documentation plus an inert `[]` |
| `install-out/` | generated locally | `all.patch.yml` (usable via `--patch`), `verify.patch.yml`, `boot.log`, `dump-config.log` |

**Concept**: `01-skill` is the *tool* (install once). A `.warden` ledger is *one project's account*
(one per project, at that project's `.git` layer).

### 2. Post-install checks

```powershell
node install.mjs --check        # 8 checks; non-zero exit if any fails
node install.mjs --selftest     # run all 7 packaged self-checks
node "<repo>/plugin/check-plugins-loaded.mjs"   # run this AFTER restarting DSH
```

| Exit code | Conclusion |
|---|---|
| **0** | Confirmed loaded — all **6** keys in `plugins` |
| **1** | Confirmed **not** loaded — the file exists but keys are missing; the output names them |
| **2** | Not found — the ledger file does not exist. **This is not "fine"** |

"Loaded" means the host **called its `apply()`**. It does **not** mean it did anything today.

### 3. ⚠ Three mechanisms the old instructions used that this DSH has **retired**

| Old instruction | Reality now | Source |
|---|---|---|
| Copy `02-preset-roles/` to `~/.dsh/.agent-presets/roles/` | **Nothing reads that directory any more.** A preset is now an inserted `@deepseek-ai/dsh-agent-preset` row whose `config.plugins` holds the old composition | `dsh-agent-preset/lib/index.js:7-19` |
| Edit `~/.dsh/settings.yaml` (`agent-presets.default`) | That file is imported once and renamed `settings.yaml.imported`. **The default now lives in the `agent-preset-registry` row** of the profile patch | `dsh-agent-preset-registry/lib/index.js:471-473` |
| Hand-write `name: ./03-host-plugin/warden-watch.js` in a patch | Relative names are anchored **only** for rows directly in a patch's `insert` list, never inside `config.plugins` ⇒ a bare Windows absolute path reaches `import()` as-is and throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` | `dsh-app-boot/lib/index.js:3537-3545` |

**`selectedDefault` is the easy one to miss**:

```js
get defaultId() { return this.config.selectedDefault.get() ?? this.config.default; }   // registry:493-494
```

`selectedDefault` is volatile and **wins when present**. Setting only `default: roles` while
`selectedDefault` still says `cordis` leaves you on the standard preset with no visible error.
`install.mjs` aligns both; pass `--keep-selected` to preserve your own GUI choice.

### 4. Placeholders that look like paths

`<WORKSPACE>`-style placeholders are the most dangerous kind: DSH cannot resolve them, treats them
as **relative** paths, and the plugin silently fails to load. Every path in this package is derived
at runtime. `name: ./team-guard.mjs` is the single remaining relative name; `install.mjs` rewrites
it to an absolute `file:///` URL when it copies the composition into the profile patch.

### 5. ⚠ A DSH upgrade can break the whole preset

`install.mjs` checks every preset row against the real package list on every run and auto-disables
what your machine does not ship. Two classes it cannot decide are **listed, not hidden**:
`disabled: !!js …` runtime expressions, and packages that exist but do not export the subpath used.

When it breaks the symptom is **"the GUI refuses to create a session"** while the boot log stays
clean — `diagnostic()` is **lazy** and is only evaluated when the GUI lists presets or creates a
session. Check each row against the shipped packages; do not rely on logs.

### 5b. Why `--verify-boot` does not use an empty profile

A profile whose `cordis.yml` is `[]` has no `shell` service and no `agent-preset-registry` row, so
`warden-watch` and `preset-roles` both sit in `pending` — **that is a flaw in the test rig, not in the
install**, and treating it as a verdict would be self-deception. `--verify-boot` therefore builds a
throwaway profile from `--from-default-profile web` (the shipped choices are `acp` / `headless` /
`sdk` / `sdk-minimal` / `web`; `desktop` is managed by the Electron app and the CLI refuses to boot it),
then checks two things: no `disabling profile plugin row` / `agent preset …:` / `did not activate` in
the boot log, and all 6 plugins present in `PLUGIN-LOADED.json`.

This is still **not** proof that creating a session succeeds — `diagnostic()` is lazy, and only the
GUI can answer that.

### 6. Project ledger

```powershell
node "$HOME/.dsh/skills/task-warden/warden.mjs" init    # in the project root (the .git layer)
node "$HOME/.dsh/skills/task-warden/warden.mjs" check   # exit 0 = pass
```

**Do not** create a `.warden` ledger inside the task-warden repo — it would pollute `git status`.

### 7. Everyday commands

Same as the Chinese section: `init`, `needs`, `record`, `check`, `results`, `roles --health`,
`delegation`, `guard`, `report`.

### 8. ★⚠ `handover-gate` will **refuse your file edits**

In a directory that **has `.git` but no `交接.md`**, `handover-gate` denies `write`/`edit`/`shell`.
It is **by design** — which means after installing it you may suddenly be unable to edit files.

1. **The only route that actually clears the deny** is deleting the `handover-gate` rows from the
   managed block in your profile patch. Adding/removing insert rows is **live**; editing plugin
   `.js` code requires a DSH restart. (The next `install.mjs` run re-adds them — edit
   `PLUGIN_IDS` at the top of `install.mjs` to leave it out for good.)
2. `WARDEN_HANDOVER_STEER=off` turns off the wrap-up steer only — **not** the deny.

⚠ Never present a switch name you have not verified: `WARDEN_HANDOVER_AUTO` was once written into
this package's docs and has **0 hits** in `03-host-plugin/handover-gate.js`.

### 9. Traps we actually hit (do not repeat)

1. Editing plugin code needs a **DSH restart** (`patchReload: live` reloads *which* plugins mount,
   not their code — Node's `require` cache).
2. The two `warden.mjs` copies will diverge unless the installer mirrors them.
3. PowerShell rewrites quotes inside arguments; and **`Set-Content -Encoding utf8` on Windows
   PowerShell 5.1 writes a BOM**, which makes DSH's `readProfileManifest` throw `SyntaxError`.
   Use `[System.IO.File]::WriteAllText()` or Node.
4. CRLF makes the MANIFEST check go entirely red; `.gitattributes` now pins `* text=auto eol=lf`
   and the installer normalizes before hashing.
5. Child processes may not be allowed to pipe stdio in a sandbox (`EPERM`); point stdio at a file fd.
6. **Never `Stop-Process` DSH by command-line substring** — the GUI host spawns tool shells and a
   broad match kills the session's own shell. Use `job_kill`, or kill only the handle you spawned.

### 10. Verify MANIFEST

```powershell
node install.mjs --check
node install.mjs --refresh-manifest   # after editing any shipped file
```
