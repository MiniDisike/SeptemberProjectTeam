# 安装说明 / Install

> 这是 **[README.md](README.md)**（介绍）的配套安装文档。中英双语，内容同构。
> Companion install doc for **[README.md](README.md)**. Bilingual, same structure in both languages.

---

## 中文

### 0. 各部分装到哪

| 目录 | 装到 | 是什么 |
|---|---|---|
| `01-skill/` | `~/.dsh/skills/task-warden/` | **主脚本**（`warden.mjs` 等）+ 实验台。DSH 从这个路径加载 skill |
| `02-preset-roles/` | `~/.dsh/.agent-presets/roles/` | **agent preset**（8 席角色、硬动作） |
| `03-host-plugin/` | 任意固定目录，建议 `<你的工程>/task-warden/plugin/` | **常驻 Host 插件**：执行前闸、交付闸、自动启用守卫、刷新端 `plugin-io.js`。⚠ **自动启用守卫会改写 `~/.dsh/settings.yaml`**（只改 `agent-presets.default` 那一行，**每次改写前留一份 `settings.yaml.bak-preset-guard-<时间戳>`**） |
| `04-config/` | **不要整个覆盖** —— 照第 3 步手改 | 两处配置 |
| `05-project-docs/` | 工程根（有 `.git` 的那一层） | **公开版不含此目录**（那是"某个项目的账"，含作者自己的原话与机器路径）。要建自己的账本：在工程根跑 `node warden.mjs init` |

**概念**：`01-skill` 是"工具"（装一份）；`.warden` 是"某个项目的账"（每个项目一份，放在它的 `.git` 那一层）。

### 1. 装 skill

把 `01-skill/` 复制到 `~/.dsh/skills/task-warden/`，验证：

```powershell
#   那 1 条 FAIL 是 `L13`：它断言的是一个**已知的真洞**（`--covered` 只收子项名、不绑证据，
#   见 warden.mjs 里 I9/R9 的注释）—— **它是当前正确结果**，不是装坏了。
#   3 条 SKIP（L5/L6/L8）依赖**作者私有账本**里的真实用户原话，公开包不发 `.warden`，故如实跳过。
# ⚠ 第 4 条**会红一条**：`L13` 断言的是一个**已知的真洞**（`--covered` 只收子项名、不绑证据，
#   见 warden.mjs 里 I9/R9 的注释）。**19 PASS · 1 FAIL 是当前正确结果**，不是装坏了。
node "$HOME/.dsh/skills/task-warden/selftest.mjs"
```

期望：`[自检] 通过：该抓的都抓住了，该放行的没误伤。`（约 100 条正/负控全绿）

### 2. 装 preset

把 `02-preset-roles/` 复制到 `~/.dsh/.agent-presets/roles/`。

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
# 主自检（约 100 条正/负控）
node "$HOME/.dsh/skills/task-warden/selftest.mjs"
node "<你的工程>/task-warden/plugin/gate.selftest.mjs"                    # 期望 20/20
node "<你的工程>/task-warden/plugin/preset-default-guard.mjs" --selftest # 期望 32/32
cd "$HOME/.dsh/skills/task-warden/experiments/lab" ; node run-all.mjs    # 实验台（期望：**16 PASS · 1 FAIL · 3 SKIP**）
```

### 6. 实测踩过的四个坑（别重复）

1. **改了插件代码却不生效** —— `patchReload: live` 只重载"挂哪些插件"，**不重载代码**（Node 的 require 缓存）⇒ **必须重启 DSH**。
   实测：改完 patch 文件等 8 秒，服务器进程的探针没有重新出现。
2. **两份 `warden.mjs` 会分叉** —— `~/.dsh/skills/` 那份是 DSH 真正加载的，工程那份是给实验台用的，**必须逐字节一致**，
   否则实验台在测旧代码、结论不可信。（**本公开包里的实验台是 L1~L20**；作者自己那份还有 L21~L34。）
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

### 8. 校验备份完整性

```powershell
node -e "const m=require('./MANIFEST.json'),fs=require('fs'),c=require('crypto'),p=require('path');let bad=0,missing=0;for(const f of m.files){try{const b=fs.readFileSync(p.join('.',f.rel));if(c.createHash('sha256').update(b).digest('hex')!==f.sha256||b.length!==f.size)bad++}catch(e){missing++}}console.log(bad||missing?('有 '+bad+' 个不一致、'+missing+' 个缺失'):('全部 '+m.files.length+' 个一致'));process.exit(bad||missing?1:0)"
```

---

## English

### 0. What goes where

| Directory | Install to | What it is |
|---|---|---|
| `01-skill/` | `~/.dsh/skills/task-warden/` | The main scripts (`warden.mjs`, …) + the lab suite. DSH loads the skill from this path |
| `02-preset-roles/` | `~/.dsh/.agent-presets/roles/` | The agent preset (8 role seats, hard actions) |
| `03-host-plugin/` | any fixed directory, e.g. `<your-project>/task-warden/plugin/` | Standing Host plugin: pre-execution gate, delivery gate, auto-enable guard |
| `04-config/` | **Do not overwrite** — hand-edit, see step 3 | Two configuration spots |
| `05-project-docs/` | your project root (the layer with `.git`) | **Private edition only**: one project's ledger + handoff docs |

**Concept**: `01-skill` is the *tool* (install once). A `.warden` ledger is *one project's account*
(one per project, at that project's `.git` layer).

### 1. Install the skill

Copy `01-skill/` to `~/.dsh/skills/task-warden/`, then verify:

```powershell
node "$HOME/.dsh/skills/task-warden/selftest.mjs"
```

Expected: `[自检] 通过：该抓的都抓住了，该放行的没误伤。` (≈100 positive/negative controls, all green).

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
node "$HOME/.dsh/skills/task-warden/selftest.mjs"                        # main self-test
node "<your-project>/task-warden/plugin/gate.selftest.mjs"                # expect 20/20
node "<your-project>/task-warden/plugin/preset-default-guard.mjs" --selftest   # expect 32/32
cd "$HOME/.dsh/skills/task-warden/experiments/lab" ; node run-all.mjs    # lab suite (expect **16 PASS · 1 FAIL · 3 SKIP**)
```

### 6. Four traps we actually hit (do not repeat them)

1. **Editing plugin code has no effect until you restart DSH.** `patchReload: live` reloads *which
   plugins are mounted*, **not their code** (Node's `require` cache). Verified: after editing the
   patch file, the server process's probe did not reappear.
2. **The two `warden.mjs` copies will diverge.** The one under `~/.dsh/skills/` is what DSH loads;
   the one in the project is what the lab uses. They must be **byte-identical**, or the lab silently
   tests stale code and its conclusions are worthless. (This public package ships the lab suite
   **L1–L20**; the author's own copy also has L21–L34.)
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

### 8. Verify the backup's integrity

```powershell
node -e "const m=require('./MANIFEST.json'),fs=require('fs'),c=require('crypto'),p=require('path');let bad=0,missing=0;for(const f of m.files){try{const b=fs.readFileSync(p.join('.',f.rel));if(c.createHash('sha256').update(b).digest('hex')!==f.sha256||b.length!==f.size)bad++}catch(e){missing++}}console.log(bad||missing?('有 '+bad+' 个不一致、'+missing+' 个缺失'):('全部 '+m.files.length+' 个一致'));process.exit(bad||missing?1:0)"
```
