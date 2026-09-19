# task-warden 实验台（`experiments/lab/`）

> 目的：让 task-warden 的每一条规则都**有实验证据**。
> 不是"我（AI）觉得应该这样"，是"这个实验跑出来是这样"。
>
> 铁律：**每发生一次真实翻车，就必须变成一条永久回归用例。**
> 修了 bug 但不留回归，等于下次还会犯 —— 这个 skill 本身就是为这件事存在的。

---

## 怎么跑

```powershell
cd <THIS_REPO>\experiments\lab
node run-all.mjs              # 跑完全部 L1~L20，出汇总表 + 总退出码
node run-all.mjs --verbose    # 连每条检查的明细一起打
node run-all.mjs --only L3,L4 # 只跑指定实验
```

- **总退出码：全 PASS 或 SKIP 才 0，有 FAIL 就 1。**
- 只依赖 Node（这台机器没有可用的 Python）。零第三方依赖。
- 跑之前会打印 `warden.mjs` 的 **sha256 / 字节数 / mtime** —— 这份实验台的结论只对那个版本负责
  （2026-09-16 实测：warden.mjs 当时正被另一个子代理**并发修改**，所以这行必须看）。

### 沙箱在哪、碰了什么

- 全部沙箱在 **`<WORKSPACE>\_lab\<名字>\`**，每个都 `git init` 过（**必须有 `.git`**，
  否则 `findProjectRoot` 会往上串到别的工程 —— 那正是 L3 要测的事故）。
- 假会话日志在 **`<WORKSPACE>\_lab\_sessions\<工作区编码>\<会话id>\session.v3.jsonl.zstd`**（多帧 zstd）。
  "用户原话"从这里核对，所以实验可重复、不依赖真实会话。
- **只读**：`<WORKSPACE>\.warden\`（除 `INCIDENTS.jsonl`）、`<别的工程>\.warden\`、
  `<WORKSPACE>\<目录>\` 下的真实源码。L3/L5/L6/L9 只**读**真实目录，不写。
- **warden.mjs 是黑盒**：实验台只 `spawn` 它、读退出码和 stdout，不 import、不改。

---

## 每个实验在测什么

| 实验 | 翻车模式 | 判据（机械） | 正控 |
|---|---|---|---|
| **L1 齿轮** | 交付≠需求且不申报（"要齿轮给正方形"） | 未申报的替代品 → `check` exit 1；申报单选项1不是「照原样做」→ exit 1；理由<20字 → exit 1 | 如实交付+证据 → exit 0 |
| **L2 半成品** | 一条需求 3 子项只做 2 个就报 done | done 无证据 → exit 1；partial 无 `--missing_half` → exit 1 | 3 子项都有证据 → exit 0 |
| **L3 隔离** | 两个项目读到对方守则 | A/B 各读自己的 SPEC；`sources` 不含对方；容器目录 → 拒绝 | A/B 互不串 |
| **L4 冻结基线** | 调好的手感被改坏 | `--values` 与源码不符 → 拒收 exit 1；源码被改而账本没变 → `check` exit 1 | 一致时 exit 0 |
| **L5 归属洗白** | AI 写的被当成"用户原话" | AI 清单口吻那段 → `unfounded`/`quoted-from-ai`；真用户原话 → `verbatim`（**两个都要对**）；AI 先写、用户贴回 → `quoted-from-ai` | 真原话不误伤 |
| **L6 冤枉** | 审查者冤枉人 | 假指控（已标 `(AI词)` 说成没标 / VOICE 里有的文件名说成查无）→ `brain audit` 驳回并点名；真指控 → 确认 | 只提成立指控 → audit exit 0 |
| **L7 压缩** | 长会话后失忆 | 换全新进程跑一圈工具后 SPEC/VOICE/ROUNDS **逐字不变**；`quotes` 仍验真；`map` 仍报支线「从未动过」 | T0 `selftest` exit 0 |
| **L8 事故收集器** | 翻车不留回归 | 每条事故要么指向真实 `L*.mjs`，要么 `实验:"无"` + `为什么不可机检`≥20字；六起已知事故 I1~I6 一条不少 | 校验器负控 4 类样本 |
| **L9 否定词翻转** | 缺陷被写成"没问题"（"只在"→"不只在"） | 检测器判翻转并指出**两处位置**；逐字相同/普通词改动/整句重写 → 不判翻转 | 真事故对（含 `(R)` 删除）也判得出 |
| **L10 权威层陈旧** | 核查建立在过期 VOICE 上 | 追加新用户消息但不重跑 `voices` → `check` 必须警告"快照落后" | 重跑 `voices` 后警告消失 |
| **L11 假通过** | "我啥也没查"报成"我查了、没问题" | 0 个文件 → exit 2 且不许说"没问题"；扫到文件 0 处匹配 → 明说"扫了 N 个文件、0 处" | 有伪造归属 exit 1；全真原话 exit 0 |
| **L12 附条件同意** | 票里的条件被吞，规则照算通过 | 带 `--conditions` 的票 → 状态停在「待并条件」，不许到「试行」 | 干净票正常推进到「试行」；并入条件后重投才过 |

**每个实验都有正控**（"老老实实做就必须放行"）—— 防止用"一律拒绝"蒙混过关。

### 如实标 SKIP 的地方

- **L7**：T1~T5 的真上下文压缩（DSH 对活体会话做的事）无法从独立 node 进程触发 →
  5 项如实 `skipped`，只做能机械判定的文件级代理。
- **L10**：主判据是 `check` 里"VOICE 快照落后"的警告。**2026-09-16 17:56 另一个子代理把它实现了**
  （`voiceStaleness` + `VOICE.sync.json` 水位线 + 10 分钟 grace），L10 随即转为 **PASS**。
  如果哪天这个警告又被摘掉，L10 会自动退回 **SKIP**（而不是假通过）。
- **L12**：`--conditions` 同理 —— 若 `vote cast` 不认这个参数（投票输出里没有"条件："）→ SKIP。
  实测它已实现 → L12 PASS。

**SKIP 不是通过。** 汇总表里单独一列数出来。

### 夹具上踩过的两个坑（写下来免得下次再踩）

- **L5 的"贴回 AI 文本"不能带括号**：引文抽取器的 `looksLikeProse` 见到 `(` `)` 就当代码跳过，
  含 `(R)` 的句子会**扫不到**（漏报，不是误报）。
- **L10 必须"先改老日志 mtime、再跑 voices"**：水位线记的是**同步那一刻**的日志 mtime；
  顺序反了（先同步再改老）水位线反而变成"现在"，追加新消息也追不出 10 分钟 grace，实验会假 FAIL。

---

## 实测到的 warden 缺口（实验台只报告，不修）

这些是"实验跑出来是这样"的事实，写在对应实验的 `checks` 里（名字带 `【`），`run-all` 会单独汇总。

1. **档位漂移只 warn、不 fail**（L4）：源码常量被改坏时 `check` 只打 `提醒:`，**exit code 仍是 0**。
   而铁律是"`check` exit 0 才算过" —— 于是"花一天调好的手感被改坏"仍会被判通过。
2. **容器目录里没被拦住**（L3①）：在 `<WORKSPACE>\_lab`（没 `.git`、装着别的工程）跑 warden，
   它没有拒绝，而是把上层 `<WORKSPACE>\.warden` 当成了自己的账本 ——
   因为那个 `.warden/config.json` **自己声明了** `projectRoot: <WORKSPACE>`，
   而守卫里"显式声明高于启发式"的例外被应用到了**祖先容器**上。
3. **子项级漏做抓不到**（L2）：一条需求有 3 个必经子项，只做 2 个、但附了任意证据 → `check` exit 0。
   warden 的校验粒度是"这条需求有没有证据"，SPEC 里没有"必经子项"这个结构。
4. **`record` 不拦半成品**（L2）：`--status partial` 不写 `--missing_half`、`--status done` 不带
   `--evidence`，`record` 都**照收**（exit 0），只有事后跑 `check` 才会报。
5. **`--values` 里未知的档位 id 被静默忽略**（L4）：写错 id 不会报错，还打印"对账通过"。
6. **引文抽取会把含括号的句子当代码跳过**（L5 发现）：`looksLikeProse` 见到 `(` `)` 就跳过，
   于是"含 `(R)` 的真用户原话"在 `quotes` 里根本扫不到 —— 这是**漏报**，不是误报。

已经修好、实验台现在替它守着的：`quotes <不存在的路径>` 从"exit 0 且报没问题"改成了 exit 2（L11）。

---

## 加一条新用例

1. 先往 `<WORKSPACE>\.warden\INCIDENTS.jsonl` **追加**一条事故（`实验` 指不到实验就写 `"无"` +
   `为什么不可机检` ≥20 字）。
2. 在 `lab/` 里加 `L<N>_<短名>.mjs`，`export default async function run(ctx)`，
   返回 `{id, name, pass, reason, checks, skipped}`（要 SKIP 就返回 `status:'SKIP'`）。
3. 用 `common.mjs` 的 `provision / makeSandbox / seedSession / runWarden / makeCtx`，
   **负控必须抓到、正控必须放行**。
4. 把它加进 `run-all.mjs` 的 `MODULES`。
