# task-warden

> AI 编码代理的监督层（supervision layer）。它不帮你写代码——它盯着"你要求的"和"AI 交付的"是不是同一件事。

---

## 它治什么

三个在 AI 辅助开发中反复发生、每次都让用户吃亏的事故：

| 事故 | 具体表现 |
|---|---|
| **需求漂移** | 你说要 A，收尾给的是 B，而且 B"也是里面要用的"，你还没法说他错 |
| **验收糊弄** | 跑了一小时、上亿 token，关键问题只解决了半个，最后交一张含糊的账 |
| **调好的东西被无声改坏** | 花一天调好的手感/参数，加个新功能就没了，还找不回来 |

典型现场：你要多面体球并解释了为什么，它回头问你「1. 立方体（推荐）2. 多面体 3. 光球」。全权限的话它就直接做立方体了——造汽车要一个齿轮，它给你一个正方形，说做完了。

---

## 项目概况

- **语言**：JavaScript / Node.js（ES Modules，`.mjs` 扩展名）
- **依赖**：零第三方 npm 依赖，只用 Node 内置模块（`fs` / `path` / `os` / `zlib` / `crypto` / `child_process` / `url`）
- **运行要求**：Node 18+（在 Windows + Node 22/24 上验证过）
- **许可证**：MIT
- **运行平台**：DeepSeek Harness (DSH)

---

## 目录结构

```
├── 01-skill/                          # 主脚本（skill 本体）+ 实验台
│   ├── warden.mjs                     # ★ 主脚本（~6000 行）—— 核心监督逻辑
│   ├── bill.mjs                       # 成本计算（从 DSH 会话日志算真实 token）
│   ├── context-audit.mjs              # 上下文审计（按来源分类统计会话字符数）
│   ├── selftest.mjs                   # ★ 自检（~1500 行，约 100 条正/负控）
│   ├── SKILL.md                       # skill 说明文档
│   └── experiments/lab/               # 实验台（L1~L20 回归用例）
│       ├── L1_gear_vs_cube.mjs        # 齿轮实验（要齿轮给正方形）
│       ├── L2_half_done.mjs           # 半成品实验
│       ├── L4_frozen_baseline.mjs     # 冻结基线（调好的被改坏）
│       ├── L5_attribution_laundering.mjs  # 归属洗白（AI 写的冒充用户原话）
│       ├── L9_negation_flip.mjs       # 否定词翻转（缺陷写成"没问题"）
│       ├── L11_false_pass.mjs         # 假通过
│       ├── L18_fake_evidence.mjs      # 假证据
│       └── ...                        # 共 20 个实验
│
├── 02-preset-roles/                   # agent preset（8 席角色定义）
│   ├── preset.yml                     # preset 元信息
│   └── agent.cordis.yml               # ★ 完整 agent preset（角色 + 硬动作）
│
├── 03-host-plugin/                    # 常驻 Host 插件
│   ├── warden-watch.js                # ★ 常驻 Host 半边（重启自动加载）
│   ├── gate.mjs                       # ★ 执行前闸（改已确认完成的东西前先备份）
│   ├── gate.selftest.mjs              # 闸的自检
│   ├── plugin-io.js                   # 插件外部执行体
│   └── preset-default-guard.mjs       # ★ 自动启用守卫（防止 preset 被改掉）
│
└── 04-config/                         # 配置片段
    ├── cordis.patch.yml               # patch 层（挂常驻插件）
    └── settings-片段.yaml             # settings.yaml 片段
```

---

## 四件机械装置（核心机制）

不靠"提醒 AI 自觉"，靠机械装置。每一条规则都有对应的实验证据（L1~L20），每发生一次真实翻车就变成一条永久回归用例。

### 装置一：逐字需求账本 `.warden/SPEC.md`

把用户的**原话**逐字锁成 `R#` 条目，每条带 `必须` / `不要` 两份清单。改写过的原话会被检查器抓出来。

关键点：只认真用户消息（`data.source.kind === "user"`），系统注入不算——否则 AI 把自己写的东西塞进去就能冒充"用户原话"。

### 装置二：`check` 命令（自愿跑的自检）

一轮声称 `done`，却漏了子项、没交代某条「不要」、或没有收尾对账 ⇒ **exit 1**，不许宣布完成。

两道关键判据：
- **交付物撞「不要」= 硬失败**：交付里出现了用户说过的「不要」项（排除否定词前缀的合法引用）
- **每条「不要」都必须被逐条交代**：标 done 时，每一条「不要」都必须显式声明怎么避开的（`--avoided "不要项=怎么避开的"`），缺一条就拒收

### 装置三：交付闸 `present`（非自愿）

`check` 是自愿跑的，但交付闸**不是**——只要还有一条「不要」没被交代过，或某个 `done` 轮次没对账 ⇒ **拒绝交付**，AI 自己绕不过去。

### 装置四：执行前闸 `edit`/`write`/`shell`（当场拦住）

要改一个"被盯住的档位数据"、而它所在的轮次已经 `done`、且那之后没备份过 ⇒ **当场拦住**，并给出该跑的命令。

六条全中才 deny（fail-open 是硬约束：内部任何异常一律 allow——绝不能让一次工具调用因为"看守坏了"而失败）：

1. 工具名 ∈ {edit, write}，且参数里 `file_path` 是非空字符串
2. 目标文件当前存在
3. 从目标文件所在目录往上找最近的 `.git` 那一层，且那一层必须有 `.warden/`
4. 目标文件被该工程 `.warden/params.yml` 的 `watches[].file` 点名
5. 该工程 `.warden/ROUNDS.jsonl` 里整个账本最新一轮的 status 是 `done`
6. `.warden/snapshots/` 里没有 `at` 晚于那条 done 时间的快照

---

## 八个角色席位

7 席有票 + 1 席无票：

| 角色 | 职称 | 有票 | 职责 |
|---|---|---|---|
| 监督员 | 需求监督员 | 是 | 用户原话锚定 + 保证各角色正确运行 |
| 审查 | 证据审查员 | 是 | 证据：有没有证据支撑？自称算不算数？ |
| 记录 | 事实记录员 | 是 | 事实：数据/口径/数字对不对？ |
| 支线守门员 | 覆盖面守门员 | 是 | 覆盖面：会不会让某条支线被丢掉？ |
| 提问闸门 | 用户注意力闸门员 | 是 | 用户注意力：值不值得占用用户时间？ |
| 资料员 | 资料查证员 | 是 | 外部事实：查过没有、有没有出处？ |
| 方向员 | 工程方向员 | 是 | 方向与影响面 |
| AI测试用户 | 产品使用者 | **否** | 产品舒适性（意见是预测，不是授权） |

角色说话**逐字显示**（`名字 · 职称：原话`），**不许被主代理转述**——转述是二次加工，二次加工就是漂移的入口。

---

## 其他约束机制

- **偏差申报单**：想换方向必须填申报单，第一个选项必须是「照原样做」，用户没表态前推荐只能是 1。没填就换 = 硬失败
- **提问闸门**：两道关——机械层查用户已答过的原话和工程文档；脑子层派独立子代理判断该不该占用用户注意力
- **自动启用守卫**：`settings.yaml` 的 `agent-presets.default` 必须等于 `roles`，被改掉会自动改回来（两击规则防假自愈）
- **子项覆盖度检查**：声明了子项的需求标 done 时必须覆盖全部子项，半个不许当整个
- **角色名单漂移审计**：注册表是单一事实源，少一条就是"某个角色可以被静默忽略"
- **原话认领闸**：用户说过的（VOICE.jsonl）与在做的（SPEC.md）之间用 CLAIMS.jsonl 连线
- **否定词翻转检测**：用字符级 LCS diff 判定否定词翻转（缺陷被写成"没问题"）

---

## 一条典型的工作流

```
开工   node warden.mjs needs  --last 5     → 本轮需求清单（逐条原话 + 归宿 + 要做的 R#）
干活   …（改代码 / 派子代理 / 查资料）
记一笔 node warden.mjs record --req R7 --status done --covered "…" --avoided "…"
自检   node warden.mjs check               → exit 0 才算过，不通过不许说"完成"
收尾   node warden.mjs results --last 5    → 结果清单 + 逐条对账（缺口明着列出来）
```

---

## 实验台

`01-skill/experiments/lab/` 包含 L1~L20 共 20 个实验，每个实验都有**正控**（"老老实实做就必须放行"——防止用"一律拒绝"蒙混过关）。期望结果：**16 PASS · 1 FAIL · 3 SKIP**。

那条 FAIL 是 L13：它断言的是一个**已知的真洞**（`--covered` 只收子项名、不绑证据）——是当前正确结果，不是装坏了。

---

## 上下文成本

三层注入架构，有意避免每轮注入大量内容：

1. **每轮固定注入**：仅 preset 角色纪律段约 2-3KB
2. **每轮触发但不进上下文**：常驻插件结果走 host debug 日志，仅发现问题时推一行 UI 卡片
3. **按需进上下文**：命令输出有上限（默认最近 5 条），不许把全历史砸进去

设计动机：模型像忽略长文一样忽略被注入的长上下文。项目自带 `context-audit.mjs` 可按来源分类统计会话字符数。

---

## 它**做不到**什么（诚实边界）

- **机器判不了**"交付物在语义上到底违没违规"——那要人对着产物判。它保证的是**每一条「不要」都被显式回应过**，把**沉默失败**变成**可以核对的声明**
- **shell 闸是启发式**：写动作靠关键词识别，绕过方法显然存在
- 它**不替你思考**，也**不阻止你改需求**——它只要求"改了就说清楚"
- 角色仪表里的【代理】判据（字符二元组同构）**不是硬判据**，输出里逐条标了"需人读"

**总体**：它能挡住结构性偏离（改写需求、沉默通过、悄悄换、验收购弄、调好的被改坏），挡不住语义伪装——但它不假装能挡，而是在每个判不了的地方都标了"需人读"。最后一道防线仍然是人眼。

---

## 设计哲学

不靠"提醒 AI 自觉"，靠机械装置。代码注释里随处可见真实事故的引用（带日期、带根因分析），说明这些规则都是被真实事故逼出来的，不是"我觉得应该这样"。每发生一次真实翻车就变成一条永久回归用例。

---

## 安装

见 **[INSTALL.md](INSTALL.md)**（中英双语：装到哪、只改哪两处配置、四条自检、四个实测踩过的坑）。

## 建议
因为有资料员的查询角色存在，会经常进行搜索，建议给Agent的搜索任务安装免费的搜索插件或API。
---
# task-warden

> A supervision layer for AI coding agents. It does not help you write code—it watches whether "what you asked for" and "what the AI delivered" are the same thing.

---

## What It Fixes

Three incidents that happen repeatedly in AI-assisted development and leave users worse off every time:

| Incident | Concrete Manifestation |
|---|---|
| **Requirement drift** | You ask for A, but at the end you get B, and B is "also something used inside," and you cannot even say it is wrong |
| **Acceptance fudging** | It runs for an hour, hundreds of millions of tokens, the key problem is only half solved, and finally it hands in a vague account |
| **Tuned things silently broken** | A feel/parameter you spent a day tuning disappears when a new feature is added, and you cannot get it back |

Typical scene: You want a polyhedral sphere and explain why; it comes back and asks you "1. Cube (recommended) 2. Polyhedron 3. Light sphere." With full permissions, it would just make the cube—when building a car you need one gear, it gives you a square and says it is done.

---

## Project Overview

- **Language**: JavaScript / Node.js (ES Modules, `.mjs` extension)
- **Dependencies**: zero third-party npm dependencies, only Node built-in modules (`fs` / `path` / `os` / `zlib` / `crypto` / `child_process` / `url`)
- **Runtime requirement**: Node 18+ (verified on Windows + Node 22/24)
- **License**: MIT
- **Runtime platform**: DeepSeek Harness (DSH)

---

## Directory Structure

```
├── 01-skill/                          # Main script (the skill itself) + experiment bench
│   ├── warden.mjs                     # ★ Main script (~6000 lines) — core supervision logic
│   ├── bill.mjs                       # Cost calculation (real tokens from DSH session logs)
│   ├── context-audit.mjs              # Context audit (count session characters by source)
│   ├── selftest.mjs                   # ★ Self-test (~1500 lines, about 100 positive/negative controls)
│   ├── SKILL.md                       # skill documentation
│   └── experiments/lab/               # Experiment bench (L1~L20 regression cases)
│       ├── L1_gear_vs_cube.mjs        # Gear experiment (ask for a gear, get a square)
│       ├── L2_half_done.mjs           # Half-finished experiment
│       ├── L4_frozen_baseline.mjs     # Frozen baseline (tuned thing gets broken)
│       ├── L5_attribution_laundering.mjs  # Attribution laundering (AI-written passed off as user's original words)
│       ├── L9_negation_flip.mjs       # Negation flip (defect written as "no problem")
│       ├── L11_false_pass.mjs         # False pass
│       ├── L18_fake_evidence.mjs      # Fake evidence
│       └── ...                        # 20 experiments total
│
├── 02-preset-roles/                   # agent preset (8-seat role definitions)
│   ├── preset.yml                     # preset metadata
│   └── agent.cordis.yml               # ★ Complete agent preset (roles + hard actions)
│
├── 03-host-plugin/                    # Resident Host plugin
│   ├── warden-watch.js                # ★ Resident Host half (auto-loads on restart)
│   ├── gate.mjs                       # ★ Pre-execution gate (back up before changing something already confirmed done)
│   ├── gate.selftest.mjs              # Gate self-test
│   ├── plugin-io.js                   # Plugin external execution body
│   └── preset-default-guard.mjs       # ★ Auto-enable guard (prevents preset from being changed)
│
└── 04-config/                         # Configuration fragments
    ├── cordis.patch.yml               # patch layer (mount resident plugin)
    └── settings-fragment.yaml         # settings.yaml fragment
```

---

## Four Mechanical Devices (Core Mechanisms)

Not relying on "reminding the AI to be self-disciplined," but on mechanical devices. Every rule has corresponding experimental evidence (L1~L20), and every real failure becomes a permanent regression case.

### Device 1: Verbatim requirement ledger `.warden/SPEC.md`

Locks the user's **original words** verbatim into `R#` entries, each with `must` / `must-not` lists. Rewritten original words are caught by the checker.

Key point: only genuine user messages (`data.source.kind === "user"`) count; system injections do not—otherwise the AI could stuff in what it wrote itself and pass it off as "the user's original words."

### Device 2: `check` command (self-check you run voluntarily)

A round claims `done`, but misses sub-items, fails to address some "must-not," or lacks a closing reconciliation ⇒ **exit 1**, not allowed to declare completion.

Two key criteria:
- **Deliverable hits "must-not" = hard failure**: the delivery contains a "must-not" item the user stated (excluding legitimate references with negation prefixes)
- **Every "must-not" must be addressed one by one**: when marking done, every "must-not" must explicitly declare how it was avoided (`--avoided "must-not item = how avoided"`), missing even one means rejection.

### Device 3: Delivery gate `present` (non-voluntary)

`check` is voluntary, but the delivery gate **is not**—as long as one "must-not" has not been addressed, or some `done` round has not been reconciled ⇒ **refuse delivery**, and the AI cannot get around it itself.

### Device 4: Pre-execution gate `edit`/`write`/`shell` (blocks on the spot)

If you want to modify a "watched parameter data" file, and the round it belongs to is already `done`, and it has not been backed up since then ⇒ **block on the spot**, and give the command that should be run.

All six must match to deny (fail-open is a hard constraint: any internal exception is always allow—never let a tool call fail because "the warden is broken"):

1. Tool name ∈ {edit, write}, and `file_path` in the arguments is a non-empty string
2. Target file currently exists
3. From the target file's directory upward, find the nearest layer with `.git`, and that layer must have `.warden/`
4. Target file is named by `watches[].file` in that project's `.warden/params.yml`
5. In that project's `.warden/ROUNDS.jsonl`, the latest round in the entire ledger has status `done`
6. In `.warden/snapshots/`, there is no snapshot with `at` later than that done time

---

## Eight Role Seats

7 seats with votes + 1 seat without votes:

| Role | Title | Has Vote | Responsibility |
|---|---|---|---|
| Supervisor | Requirement Supervisor | Yes | Anchor to user's original words + ensure each role runs correctly |
| Review | Evidence Reviewer | Yes | Evidence: is there evidence support? Does self-claim count? |
| Record | Fact Recorder | Yes | Facts: are data/definitions/numbers correct? |
| Branch Gatekeeper | Coverage Gatekeeper | Yes | Coverage: will some branch be dropped? |
| Question Gate | User Attention Gatekeeper | Yes | User attention: is it worth taking up the user's time? |
| Researcher | Source Verification Officer | Yes | External facts: has it been checked, is there a source? |
| Direction | Engineering Direction Officer | Yes | Direction and impact scope |
| AI Test User | Product User | **No** | Product comfort (opinions are predictions, not authorization) |

Roles speak **verbatim displayed** (`Name · Title: original words`), **must not be paraphrased by the main agent**—paraphrasing is secondary processing, and secondary processing is the entry point for drift.

---

## Other Constraint Mechanisms

- **Deviation declaration form**: wanting to change direction requires filling out a declaration form; the first option must be "do it as originally planned," and before the user responds the only recommendation can be 1. Changing without filling it out = hard failure
- **Question gate**: two gates—the mechanical layer checks the user's already-answered original words and project documents; the brain layer dispatches an independent sub-agent to judge whether the user's attention should be taken up
- **Auto-enable guard**: `agent-presets.default` in `settings.yaml` must equal `roles`; if changed, it will automatically change it back (two-strike rule prevents fake self-healing)
- **Sub-item coverage check**: requirements that declare sub-items must cover all sub-items when marked done; half is not allowed as the whole
- **Role roster drift audit**: the registry is the single source of truth; missing one means "some role can be silently ignored"
- **Original-words claim gate**: connect what the user said (VOICE.jsonl) and what is being done (SPEC.md) with CLAIMS.jsonl
- **Negation flip detection**: use character-level LCS diff to determine negation flips (defect written as "no problem")

---

## A Typical Workflow

```
Start    node warden.mjs needs  --last 5     → this round's requirement list (verbatim line by line + disposition + R# to do)
Work     …（change code / dispatch sub-agents / look up sources）
Record   node warden.mjs record --req R7 --status done --covered "…" --avoided "…"
Self-check node warden.mjs check             → only exit 0 counts as passing; if not passing, not allowed to say "done"
Wrap up  node warden.mjs results --last 5    → result list + line-by-line reconciliation (gaps listed openly)
```

---

## Experiment Bench

`01-skill/experiments/lab/` contains L1~L20, 20 experiments total. Each experiment has a **positive control** ("if you honestly do it, it must pass"—prevents cheating by "always rejecting"). Expected result: **16 PASS · 1 FAIL · 3 SKIP**.

That one FAIL is L13: it asserts a **known real hole** (`--covered` only accepts sub-item names, does not bind evidence)—this is the current correct result, not a broken setup.

---

## Context Cost

Three-layer injection architecture, intentionally avoiding injecting large amounts of content every round:

1. **Fixed injection every round**: only the preset role discipline section, about 2–3KB
2. **Triggered every round but not entering context**: resident plugin results go through host debug logs; only when a problem is found, push one UI card line
3. **Enter context on demand**: command output has a cap (default latest 5 entries); do not dump the entire history in

Design rationale: models ignore injected long context just as they ignore long documents. The project includes `context-audit.mjs` to count session character counts by source.

---

## What It **Cannot** Do (Honest Boundary)

- **The machine cannot judge** "whether the deliverable semantically violates anything"—that requires a human judging the artifact. What it guarantees is that **every "must-not" has been explicitly responded to**, turning **silent failure** into a **checkable declaration**
- **The shell gate is heuristic**: write actions rely on keyword recognition; bypass methods obviously exist
- It **does not think for you**, and **does not stop you from changing requirements**—it only requires "if you changed it, say so clearly"
- The **【proxy】** criterion in the role dashboard (character bigram isomorphism) **is not a hard criterion**; each item in the output is marked "requires human reading"

**Overall**: It can block structural deviations (rewriting requirements, silent passing, quietly swapping, acceptance cheating, tuned things being broken), but cannot block semantic disguise—but it does not pretend it can; instead, everywhere it cannot judge, it marks "requires human reading." The last line of defense is still human eyes.

---

## Design Philosophy

Not relying on "reminding the AI to be self-disciplined," but on mechanical devices. Real accident references can be seen everywhere in code comments (with dates and root-cause analysis), showing these rules were forced out by real accidents, not "I think it should be this way." Every real failure becomes a permanent regression case.

---

## Installation

See **[INSTALL.md](INSTALL.md)** (bilingual Chinese-English: where to install, exactly which two configuration changes to make, four self-checks, four pitfalls actually encountered).

## Suggestion

Because the researcher role exists and will search frequently, it is recommended to install a free search plugin or API for the Agent's search tasks.



See **[INSTALL.md](INSTALL.md)** (bilingual: where each part goes, the only two config edits, four
self-checks, and four traps we actually hit).
