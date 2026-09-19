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

---

## What it is (English)

A **supervision layer that sits outside an AI coding agent**. It does not write code for you — it
watches whether *what you asked for* and *what got delivered* are the same thing.

Three failures keep happening, and each one costs you real work:

| Failure | What it looks like |
|---|---|
| **Requirement drift** | You ask for A; you get B; and B is "also something you'd need", so you can't even call it wrong |
| **Faked acceptance** | An hour of work and a huge token bill; the key problem is half solved, and the final report is vague |
| **Silent destruction of tuned work** | A day of hand-tuned feel or parameters is wiped out by the next feature, unrecoverably |

### How it works — four mechanical devices (not "reminding the AI to be careful")

| Device | What it does |
|---|---|
| **Verbatim requirement ledger** `.warden/SPEC.md` | Locks your **exact words** as `R#` entries, each with `必须` (must) and `不要` (must-not) lists. Reworded quotes get caught |
| **`check`** | A round claims `done` but skipped a sub-item, left a `不要` unaddressed, or has no closing reconciliation ⇒ **exit 1**; you may not declare completion |
| **Delivery gate `present`** | While any `不要` is unaddressed, or a `done` round has no reconciliation ⇒ **delivery is refused**. `check` is voluntary; the delivery gate is not |
| **Pre-execution gate `edit`/`write`/shell | Modifying a *watched* value whose round is already `done`, with no snapshot since ⇒ **blocked on the spot**, with the exact command to run |

### Eight role seats

Seven voting seats (**Supervisor / Reviewer / Recorder / Side-branch Gatekeeper / Attention
Gatekeeper / Researcher / Direction**) plus one non-voting seat (`AI test user`). Roles speak
**verbatim** (`name · title: exact words`) and may **not** be paraphrased by the main agent —
paraphrasing is second-hand processing, and second-hand processing is where drift enters.

### What it does **NOT** do

- It **cannot** machine-decide whether a deliverable *semantically* violates a `不要`. A human must
  judge the artifact. What it guarantees is that **every `不要` was explicitly addressed** — turning
  *silent failure* into *a checkable statement*.
- It does **not** think for you, and it does **not** stop you from changing requirements — it only
  requires that a change be **stated**.

### Install

See **[INSTALL.md](INSTALL.md)** (bilingual: where each part goes, the only two config edits, four
self-checks, and four traps we actually hit).
