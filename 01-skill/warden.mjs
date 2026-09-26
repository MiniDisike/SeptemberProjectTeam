#!/usr/bin/env node
/**
 * warden.mjs —— 需求监督员 / 交付审查 / 数据账本（三合一，一个脚本）
 *
 * 中心不是记账，是这一张表：
 *
 *   你要的（逐字）  |  实际给的  |  状态  |  轮次/时间/token  |  这笔钱买到了什么
 *
 * cost 只是两个列；重点是把「需求」和「实际交付」摆在一起，让偏差和浪费一眼可见。
 *
 * 子命令：
 *   init            在工程里建 .warden/ 骨架，并打印当前会话里你说过的话（供锁定需求）
 *   check           主检查：需求锚定 / 偏差申报 / 验收证据 / 档位回归   exit 0=过 1=有问题 2=用法错
 *   report          生成 .warden/REPORT.md（人读的性价比表）
 *   history <档位>   查某个档位数据改过几次、每次花了多少、哪一版更精细
 *
 * 设计原则（都是被真实事故逼出来的）：
 *  1. 需求「原话」必须能在会话日志里**逐字找到** → AI 改写不了你的需求。
 *  2. 交付 ≠ 需求时，不许悄悄换成好做的 → 必须填**偏差申报单**，公式固定，理由不够就不许改，
 *     而且**默认选项必须是"照原样做"**：替代品在你点头之前不能当交付。
 *  3. 档位数据（花了很多轮才调好的手感）被后续改动覆盖 → 报警，并告诉你原来那版是哪一轮、多精细。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { decodeSession, listSessions, summarize, currentSessionId, sessionsRoot, workspaceDirOfSession, encodeWorkspace, fmtInt, fmtDur } from './bill.mjs';

export const WARDEN_DIR = '.warden';
/** warden.mjs 自己所在的目录 —— 实验台（lab）是**随 skill 走的**，不在工程根下也能找到 */
export const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * =========================== 角色注册表（单一事实源） ===========================
 *
 * ⚠ 为什么必须只有**一张**名单（实测，2026-09-16）：
 *   角色原来是**散在五处**的 —— `ROLE_REMIT`（谁有票）、`WORK_ROLES`（谁有任务书）、
 *   `FINDING_ROLES`（谁能往发现台账署名）、`ROLE_STAMP`（谁的印章）、preset（谁被派活）。
 *   后果实测：`资料员`/`方向员` 在代码里出现 **36 处**，**却不在投票名单** ⇒
 *   **不投也算"票齐"** ⇒ **新角色的意见可以被静默忽略**。
 *   加第八个角色时只要漏改一处，就再犯一次 ⇒ 所以：**这里才是名单，别处一律从它派生**，
 *   由 `roleRegistryAudit()` 在 `check` 里盯着漂移（注册表里有人、派生名单里没有 = 报错）。
 *
 * 字段：
 *   `vote`    有没有**投票权**（进 `VOTE_ROLES` 才计票）
 *   `added`   **首次获得投票权的时刻**。⚠ 只给"老议题"用：加一席**不许追溯**要求老议题
 *             凑齐新票（否则新席位 = 永久否决权，见 `tallyVotes` 里 roster 那一段）。
 *             没写 `added` 的 = 开天辟地就在册。
 *   `finding` 能不能往发现台账（FINDINGS.jsonl）署名
 *   `duty`    有这一段 = 它是"干活角色"，`role brief` 会给它生成任务书
 *
 * ⚠ **还没做完的**：`AI测试用户` 的六条约束（讨论C）现在**只落地了第①条**
 *   （不进多数计票、但它的话必须被单独列出来，不许静默消失）。
 *   剩下五条（一轮只许说一条 / 只在产品跑通一次完整流程后才开口 /
 *   不许当交付证据、不许当用户授权 / 解除它的异议不许由它自己 `--address`）
 *   **还没做** —— 别把这一行当成那五条已经生效了。
 */
export const ROLE_REGISTRY = [
  {
    id: '监督员',
    // 职称：用户要求角色说话前加一个名字与职称的显示（R6）—— 名字用 `id`，职称用 `title`。
    title: '需求监督员',
    vote: true,
    finding: true,
    stamp: '【监督 · 监督员】',
    remit: '① 用户原话锚定：这事有没有违背用户**逐字**说过的话？② 保证各角色正确运行：别的角色有没有在**它自己的职责**上尽职、有没有越权替别人下判断？',
    duty: '既盯需求原点，也盯**别的角色本身跑得对不对**（它报的事实有没有出处、它的判决能不能被机器复核）',
    when: '每轮收尾、以及任何角色下了"事实性"判断之后',
    hard: '报「事实」必须给 --source（出处）：实测方向员把 R27 说成已划走、复核不成立',
    how: 'node warden.mjs find add --by 监督员 --text "复核结论" --source "出处/命令" --ref R#',
  },
  { id: '审查', title: '证据审查员', vote: true, remit: '证据：有没有证据支撑？自称算不算数？' },
  { id: '记录', title: '事实记录员', vote: true, remit: '事实：数据/口径/数字对不对？能不能复算？' },
  { id: '支线守门员', title: '覆盖面守门员', vote: true, remit: '覆盖面：这会不会让某条支线被丢掉、或让项目跑偏？' },
  { id: '提问闸门', title: '用户注意力闸门员', vote: true, remit: '用户注意力：这事值不值得占用用户的时间？' },
  {
    id: '资料员',
    title: '资料查证员',
    vote: true,
    // 这一席位是**后来加的**：它之前投过的票数为 0。写死这个时刻，老议题才不会被追溯要求补票。
    added: '2026-09-16T16:32:24.977Z',
    finding: true,
    stamp: '【资料 · 资料员】',
    remit: '外部事实：这条依据**查过没有、有没有出处**？查不到就该标"提案"，不许当事实用。',
    duty: '事实性问题**不靠猜**：自己去查（DSH 源码 / 官方文档 / 搜索），给出处，结论要**落到某条 R#**',
    when: '遇到"这个库/格式/API 到底怎么用"、要引用外部事实、或要核一条机制/一个数的时候',
    hard: '报「事实」必须给 --source（出处）；查不到就标 --kind 提案，不许编',
    how: 'node warden.mjs find add --by 资料员 --text "查到什么" --source "出处" --ref R#',
  },
  {
    id: '方向员',
    title: '工程方向员',
    vote: true,
    added: '2026-09-16T16:32:24.977Z',
    finding: true,
    stamp: '【方向 · 工程方向员】',
    remit: '方向与影响面：这会不会让工程**少掉一条本来能走的方向**？要改一件已确认完成的东西时，影响面接住了没有、备份做了没有？',
    duty: '横向给"工程还能往哪些方向做"并**排优先级**；每个方向必须指回一条用户原话或已登记痛点',
    when: '每轮定"下一轮做什么"之前；**要改一件已确认完成的东西之前**（接手备份与影响面）',
    hard: '指不回原话的必须标 AI提案；并接手「档位备份」职责：动手前 snapshot、收尾 diff',
    how: 'node warden.mjs find add --by 方向员 --text "还能往哪做" --why "指回哪条原话" --ref R#',
  },
  {
    // 讨论C 定下来的**第八席**：产品舒适性的使用者视角。
    // 它**没有投票权** —— 但不是"可以被忽略"：它的意见由 tallyVotes 单独列出来（outsiders）。
    id: 'AI测试用户',
    title: '产品使用者',
    vote: false,
    added: '2026-09-16T16:32:24.977Z',
    stamp: '【使用 · AI测试用户】',
    remit: '产品舒适性：**只当使用者、不看内部理由** —— 这一步跑起来真的能用、好用吗？要跑通一次完整流程之后才开口。',
  },
];

/** 职称表（从注册表派生）—— `名字 · 职称：原话` 里那半截 */
export const ROLE_TITLE = Object.fromEntries(ROLE_REGISTRY.map((r) => [r.id, r.title ?? r.id]));

/**
 * 角色发言的**显示形态** —— 用户 R6 要的就是这一个格式：
 *   角色说话前加一个**名字与职称**的显示
 * ⇒ `审查 · 证据审查员：<这个角色的原话>`
 *
 * ⚠ **一个字都不许在这里加工**：不加"它认为"、不截断、不换行、不合并。
 *   用户明确要求不许把角色的话隐藏后通过自己转述——
 *   这个函数一旦开始"润色"，它就又变成转述了。所以它只做拼前缀这一件事。
 */
export function roleSpeech(role, text) {
  return `${role} · ${ROLE_TITLE[role] ?? role}：${String(text ?? '')}`;
}


export const ROLE_REMIT = Object.fromEntries(ROLE_REGISTRY.map((r) => [r.id, r.remit]));
export const VOTE_ROLES = ROLE_REGISTRY.filter((r) => r.vote).map((r) => r.id);
export const ALL_ROLE_IDS = ROLE_REGISTRY.map((r) => r.id);

/** 席位是什么时候开始有票的（毫秒时间戳）；没写 `added` 的 = 开天辟地就在册（0） */
export const SEAT_ADDED_AT = Object.fromEntries(
  ROLE_REGISTRY.map((r) => [r.id, r.added ? (Number.isFinite(Date.parse(r.added)) ? Date.parse(r.added) : 0) : 0]),
);

/**
 * 名单漂移审计 —— **注册表是名单，别处只能是它的派生**。
 * 返回不一致项（空数组 = 没漂移）。任何一条都该让 `check` 出声：
 * 少一条就是"某个角色可以被静默忽略"的老病复发。
 */
export function roleRegistryAudit({ voteRoles = VOTE_ROLES, findingRoles = null, workRoles = null, stamps = null } = {}) {
  const bad = [];
  const ids = new Set(ALL_ROLE_IDS);
  if (ids.size !== ROLE_REGISTRY.length) bad.push(`注册表里有重复的角色 id：${ALL_ROLE_IDS.join('、')}`);
  for (const r of ROLE_REGISTRY) {
    if (!String(r.remit ?? '').trim()) bad.push(`角色「${r.id}」没写职责（remit）—— 没有职责的票没法判它有没有越权`);
    // 职称：用户 R6 要「名字与职称」——少一个，那一行就显示不全（`审查 · 审查：…` 是退化的）
    if (!String(r.title ?? '').trim()) bad.push(`角色「${r.id}」没写职称（title）—— 用户要的显示形态是「名字 · 职称：原话」`);
    if (r.vote && !voteRoles.includes(r.id)) bad.push(`角色「${r.id}」在注册表里有票，但不在 VOTE_ROLES 里`);
  }
  for (const id of voteRoles) if (!ids.has(id)) bad.push(`VOTE_ROLES 里的「${id}」不在注册表里`);
  if (Array.isArray(findingRoles)) for (const id of findingRoles) if (!ids.has(id)) bad.push(`FINDING_ROLES 里的「${id}」不在注册表里`);
  if (Array.isArray(workRoles)) for (const id of workRoles) if (!ids.has(id)) bad.push(`WORK_ROLES 里的「${id}」不在注册表里`);
  if (Array.isArray(stamps)) {
    const vals = new Set(stamps);
    for (const r of ROLE_REGISTRY) if (r.stamp && !vals.has(r.stamp)) bad.push(`角色「${r.id}」的印章「${r.stamp}」没在 ROLE_STAMP 里登记`);
  }
  return bad;
}

/**
 * 工程根 = 从 start 往上找**最近的有 `.git` 的祖先**（和 DSH 找 skill 用的同一条规则）。
 * 找不到就用 start 本身。
 *
 * 为什么必须这样：`.warden` 原来是按"当前目录"找的，于是
 * `<WORKSPACE>\.warden`（三维绘图的守则）落在了**会话工作区根**上，
 * 而真正的工程在 `<PROJECT>`。
 * 那个工作区有 24 个会话、装着一堆不相干的工程 —— 谁在那儿跑 warden 都会读到别人的守则。
 * 实测确认：两个项目的守则确实互相可见。这条规则就是堵它。
 */
export function findProjectRoot(start) {
  return findProjectRootVia(start).root;
}

/**
 * 和 `findProjectRoot` 同一个判定，但**告诉你它是怎么判出来的**：
 *   `via: 'git'`             —— 找到 `.git`，这是正路（工程根 = 有 `.git` 的那一层）
 *   `via: 'ancestor-warden'` —— 一路往上**没有 `.git`**，退而取了"祖先里装着 `.warden` 的那一层"
 *   `via: 'self'`            —— 什么都没找到，就用 start 自己
 *
 * ⚠ **为什么要单独把这个说出来**（实测事故，2026-09-16 由「审查」坐实）：
 *   在一个**没有 `.git`、没有 `.warden`** 的目录里跑 `init`，
 *   它会在**祖先的 `.warden`** 里建骨架、本地什么都没建、**exit 0、零提示**；
 *   随后裸跑 `warden.mjs` 会打出**隔壁项目的欠账表**（R14/R19/R27…）。
 *   用户描述这个现象为"两个项目读到了对方的守则"—— 这就是那条路。
 *   ⇒ 光有 `findProjectRoot` 不够：**"我这次落在谁的账本上"必须能被问出来**，
 *     否则调用方（`init`）没法在"你以为在这儿建、其实建到别人账上了"的时候拦住你。
 */
export function findProjectRootVia(start) {
  const abs = path.resolve(start);
  let d = abs;
  let wardenOwner = null;   // 没有 .git 时的退路：最近的、装着 .warden 的那一层
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return { root: d, via: 'git' };
    if (!wardenOwner && fs.existsSync(path.join(d, WARDEN_DIR))) wardenOwner = d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  // 实测踩过：从工程根的**子目录**（比如 .warden 自己）跑命令时，原来会原样返回子目录 →
  // 找不到 .warden → 报"先跑 init"，让人以为工程从没建过。退路改成"谁装着 .warden 就是谁"。
  if (wardenOwner) {
    // 祖先（**不是自己**）装着 .warden ⇒ 这是一条**静默路**，调用方要当心
    return { root: wardenOwner, via: path.resolve(wardenOwner) === abs ? 'self' : 'ancestor-warden' };
  }
  return { root: abs, via: 'self' };
}

/** 找出祖先目录里"错位的" .warden（不在工程根上的那些）—— 这是历史上真实踩过的坑 */
export function findStrayWardens(projectRoot) {
  const out = [];
  let d = path.dirname(path.resolve(projectRoot));
  for (;;) {
    const p = path.join(d, WARDEN_DIR);
    if (fs.existsSync(p)) {
      const cfg = readConfig(p);
      out.push({ dir: p, claims: cfg.projectRoot ?? '(没写归属)' });
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

/**
 * 这个目录是不是"装着别的工程"的容器（自己没有 .git，但下面有）。
 * 为什么要判：`<WORKSPACE>` 自己没有 .git，却装着 <目录> / <记忆库> 等一堆工程，
 * 而 `.warden` 落在它上面 —— 于是**谁在那个工作区跑 warden 都会读到别人的守则**（实测踩过）。
 * 在容器目录里跑 warden 一律拒绝，逼你到真正的工程根去。
 */
export function findNestedProjects(dir, maxDepth = 3) {
  if (fs.existsSync(path.join(dir, '.git'))) return [];
  const SKIP = new Set(['node_modules', '.git', '.godot', 'target', '.warden', 'dist', 'build', '.venv', 'shots']);
  const found = [];
  const walk = (d, depth) => {
    if (depth >= maxDepth) return;
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (fs.existsSync(path.join(p, '.git'))) found.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  return found;
}

/**
 * ★ **容器守卫的逐条台账**（2026-09-17 新增；清单第 12 条的第三句，母需求 R5）。
 *
 * 为什么要有它（「方向员」实测、我复核）：
 *   第 12 条原文要求「`check` **必须打印每条被忽略路径及理由**」——而这一句**完全没实现**：
 *   `findNestedProjects` 全仓只有 1 个调用点（CLI 前置守卫），`check()` 根本不调用它；
 *   深度截断（`maxDepth`）与 SKIP 名单都是**静默丢弃、零输出**。
 *   后果（实测）：`findNestedProjects('<WORKSPACE>')` 报 48 条，而 `<工程>` /
 *   `<工程>-worktree` **一条都看不见**（深度 4 > 3）——**没人能看出守卫漏了谁**，
 *   只能靠手工扫（方向员就是这么扫出来的）。
 *
 * ⚠ **只做输出，不动拒绝逻辑**（方向员的建议，我采纳）：
 *   实测证明按第 12 条字面把 `.git` 判据改成「真 git(HEAD+refs)」会**误杀真 worktree**
 *   （`<工程>-worktree\.git` 是文件、内容是 `gitdir: …`，它是真项目但没有 HEAD/refs），
 *   而 46 个实验沙箱**全是真 git**、一条都筛不掉。所以这一轮只补"看得见"。
 *
 * 返回：{ projects: [...], ignored: [{path, reason}] } —— 每条被枚举到的东西都有归宿。
 */
export function containerAudit(dir, maxDepth = 3) {
  const projects = [];
  const ignored = [];
  if (fs.existsSync(path.join(dir, '.git'))) {
    return { selfIsProject: true, projects, ignored };
  }
  const SKIP = new Set(['node_modules', '.git', '.godot', 'target', '.warden', 'dist', 'build', '.venv', 'shots']);
  const walk = (d, depth, rel) => {
    if (depth >= maxDepth) {
      // ⚠ 这里就是"假阴性"的来源：到了深度上限就**静默停**。现在如实记下来。
      ignored.push({ path: rel || '.', reason: `到了深度上限 maxDepth=${maxDepth}，**不再往下看**（里面的真项目会看不见）` });
      return;
    }
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) {
      ignored.push({ path: rel || '.', reason: '读不动这个目录：' + String((e && e.code) || e) });
      return;
    }
    for (const e of es) {
      const child = rel ? rel + '/' + e.name : e.name;
      if (!e.isDirectory()) {
        if (e.name === '.git') ignored.push({ path: child, reason: '`.git` 是**文件**（不是目录）—— 这通常是 worktree 或工具缓存的痕迹' });
        continue;
      }
      if (SKIP.has(e.name)) { ignored.push({ path: child, reason: `在 SKIP 名单里（${e.name}）` }); continue; }
      const p = path.join(d, e.name);
      if (fs.existsSync(path.join(p, '.git'))) projects.push(p);
      else walk(p, depth + 1, child);
    }
  };
  walk(dir, 0, '');
  return { selfIsProject: false, projects, ignored };
}

/** 身份守卫：这个 .warden 是不是本工程的？不是就拒绝，别让两个项目的守则互相污染。 */
export function guardProject(projectRoot, dir) {
  if (!fs.existsSync(dir)) return null;
  const cfg = readConfig(dir);
  if (cfg.projectRoot && path.resolve(cfg.projectRoot) !== path.resolve(projectRoot)) {
    return [
      '拒绝操作：这个 .warden 属于**另一个工程**。',
      `  它记的工程根： ${cfg.projectRoot}`,
      `  你现在在：     ${projectRoot}`,
      '  继续下去会让两个项目的守则互相污染（历史上真发生过）。',
      '  真要在这儿用，就把那个 .warden 搬到它自己的工程根，或者删掉它重来。',
    ].join('\n');
  }
  return null;
}

// ------------------------------------------------------------------ 文件骨架
const SPEC_TEMPLATE = `# 需求锁定表（append-only：**只许追加，不许改写已锁定的条目**）

> 规矩：每条需求的「原话」必须是用户**逐字**说过的话。检查器会回到会话日志里核对 ——
> 改写过的、我替用户总结的，都会被抓出来。这就是防需求漂移的地基。
>
> 每条格式（字段名必须一致）：
>
> ## R1 · 一句话标题
> - 原话: <用户逐字原话，可跨句，不要改写>
> - 出处: session:<会话id>#<消息序号> 或 <文件路径>
> - 为什么: <用户解释过的理由 —— 这是他为什么非要这样的原因>
> - 必须: <必须满足的点，用；分隔>
> - 不要: <用户**明确**说过不要的，用；分隔；没说过就留空>
> - 子项: <这条需求有几个必经子项，用 | 或 , 分隔。写了它，报 done 就必须声明覆盖了哪几个 ——
>          "关键问题只解决半个"就是靠这一列抓的>
> - 锁定: <日期>

`;

const CLAIMS_TEMPLATE = `# 原话认领表（append-only：**一行一条，只增不改**）
#
# 病根（事故 I26）：VOICE.jsonl（用户说过的）与 SPEC.md（我们在做的）**没有任何连线** ——
# 一条原话要变得"会被做"，必须有人手工写进 SPEC 成 R#；没人写就只躺在 VOICE 里，
# 而 check/report/map 三张表都不看它。这张表就是那条连线。
#
# 一行一条：
# {"voice":"<session-id>#20","kind":"需求","ref":"R13","why":"…","at":"…","by":"…"}
#   kind ∈ 需求   （已变成 SPEC 需求，ref 写 R#，且那个 R# 必须真的在 SPEC.md 里）
#          非要求 （闲聊、提问、情绪；why 写依据）
#          已答过 （ref 写指回哪一句）
#          撤回   （用户自己撤回了）
#   voice 用 "<session前缀>#<seq>"，要和 VOICE.jsonl 里的 session+seq 对得上（session 允许前缀匹配）
#
# 用法：node warden.mjs claims              看还有哪些原话没人认领
#       node warden.mjs claims add --voice "<session-id>#20" --kind 需求 --ref R13 --why "…"
`;

const DEVIATIONS_TEMPLATE = `# 偏差申报单（当"我要给的"和"你要的"不一样时，必须先填这里）

> 规矩：**没填这张单子的偏差 = 硬失败。** 填了但理由撑不住 = 也不许改。
> 默认选项永远是「照原样做」—— 替代品在用户点头之前不能当交付。
>
> 每条格式：
>
> ## D1 · R1 拟由【你要的】改为【我要给的】
> - 需求: R1
> - 你要的: <照抄 SPEC 里那条>
> - 要给的是: <我实际打算做的>
> - 差异: <具体差在哪，要能看出损失>
> - 为什么必须偏离: <必填，≥20 字>
> - 为什么这比照原样做更好: <必填，≥20 字；说不出就说明不该改>
> - 你会损失什么: <必填>
> - 选项:
>   1. 照原样做
>   2. <替代方案>
> - 推荐: 1
> - 用户决定: 待定

`;

// 模板必须是**注释**，不能是一条像样的记录 ——
// 否则 agent 啥都没干，光留个模板就能满足"这条需求有推进记录"（实测踩过）。
const ROUNDS_TEMPLATE = `# 每轮一行 JSON。真正的记录用 \`node warden.mjs record --req R# ...\` 追加，别手写。
# 字段：round / requirement / status(not_started|in_progress|done|partial|blocked|deviated)
#       delivered / evidence / why / missing_half(partial 必填) / values / at
# 空壳记录（delivered、evidence、why 全空）会被当成占位符判失败。
`;

const PARAMS_TEMPLATE = `# 要盯住的「档位数据」——花了很多轮才调好、最怕被后续功能改坏的那些值。
#
# kind 支持：
#   rust_const  —— 从 Rust 源码里读 \`const NAME: f32 = 1.30;\`
#   json_field  —— 从 JSON 文件按点号路径取值
#   jsonl_last  —— 从 JSONL 最后一条记录按点号路径取值
#
# 用法：node warden.mjs record 会**自己**把这些值读出来，和你写进 ROUNDS 的值对账。
# 对不上 = 硬失败（你记的和实际的不一样）。
watches: []
# 示例（<工程>）：
# watches:
#   - id: ripple_period
#     label: 涟漪周期(秒)
#     kind: rust_const
#     file: <你的工程>/src/plugins/example.rs
#     name: RIPPLE_PERIOD_DEFAULT
#   - id: drag_slop_px
#     label: 拖拽容差(px)
#     kind: rust_const
#     file: <你的工程>/src/plugins/example.rs
#     name: DRAG_SLOP_PX
`;

function ensureSkeleton(root, { quiet } = {}) {
  const dir = path.join(root, WARDEN_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    ['SPEC.md', SPEC_TEMPLATE],
    ['DEVIATIONS.md', DEVIATIONS_TEMPLATE],
    ['ROUNDS.jsonl', ROUNDS_TEMPLATE],
    ['params.yml', PARAMS_TEMPLATE],
    ['CLAIMS.jsonl', CLAIMS_TEMPLATE],
  ];
  for (const [name, body] of files) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) { fs.writeFileSync(p, body, 'utf8'); if (!quiet) console.log(`建了 ${p}`); }
  }
  // 账本必须自带**身份** —— 不然按目录找就会串项目（实测踩过）
  const cfg = readConfig(dir);
  if (!cfg.projectRoot) {
    cfg.projectRoot = root;
    cfg.createdAt = cfg.createdAt ?? new Date().toISOString();
    writeConfig(dir, cfg);
    if (!quiet) console.log(`记下归属：${root}`);
  } else if (path.resolve(cfg.projectRoot) !== path.resolve(root)) {
    console.log(`⚠ 这个 .warden 记的工程根是 ${cfg.projectRoot}，不是 ${root}`);
    console.log('  先解决归属再往下做，否则两个项目的守则会互相污染。');
  }
  return dir;
}

// ------------------------------------------------------------------ 解析
/** 解析 SPEC.md → [{id, title, quote, source, why, must[], mustNot[], locked, items[]}] */
export function parseSpec(text) {
  text = deBom(text);
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^##\s+(R\d+)\s*[·:：]\s*(.*)$/.exec(line);
    if (h) {
      cur = { id: h[1], title: h[2].trim(), quote: '', source: '', why: '', must: [], mustNot: [], locked: '', items: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = /^[-*]\s*(原话|出处|为什么|必须|不要|锁定|子项|quote|source|why|must|must_not|locked|items|sub)\s*[:：]\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (key === '原话' || key === 'quote') cur.quote = val;
    else if (key === '出处' || key === 'source') cur.source = val;
    else if (key === '为什么' || key === 'why') cur.why = val;
    else if (key === '必须' || key === 'must') cur.must = splitList(val);
    else if (key === '不要' || key === 'must_not') cur.mustNot = splitList(val);
    else if (key === '锁定' || key === 'locked') cur.locked = val;
    else if (key === '子项' || key === 'items' || key === 'sub') cur.items = splitList(val);
  }
  return out;
}

/** `|` / `,` / `，` / `、` / `;` / `；` 都当分隔符（子项和"必须"都用它） */
function splitList(v) {
  return String(v).split(/[；;、,，|]/).map((s) => s.trim()).filter(Boolean);
}

/** 解析 DEVIATIONS.md → [{id, requirement, asked, delivering, delta, why, whyBetter, loss, options[], recommended, decision}] */
export function parseDeviations(text) {
  text = deBom(text);
  const out = [];
  let cur = null;
  let inOptions = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^##\s+(D\d+)\s*[·:：]\s*(.*)$/.exec(line);
    if (h) {
      cur = { id: h[1], title: h[2].trim(), requirement: '', asked: '', delivering: '', delta: '', why: '', whyBetter: '', loss: '', options: [], recommended: '', decision: '' };
      out.push(cur); inOptions = false; continue;
    }
    if (!cur) continue;
    if (/^[-*]\s*(选项|options)\s*[:：]\s*$/.test(line) || /^[-*]\s*(选项|options)\s*[:：]/.test(line)) { inOptions = true; continue; }
    const kv = /^[-*]\s*([^:：]+)\s*[:：]\s*(.*)$/.exec(line);
    if (kv) {
      inOptions = false;
      const key = kv[1].trim(); const val = kv[2].trim();
      if (key === '需求' || key === 'requirement' || key === 'R') cur.requirement = val;
      else if (key === '你要的' || key === 'asked') cur.asked = val;
      else if (key === '要给的是' || key === 'delivering') cur.delivering = val;
      else if (key === '差异' || key === 'delta') cur.delta = val;
      else if (key === '为什么必须偏离' || key === 'why') cur.why = val;
      else if (key === '为什么这比照原样做更好' || key === 'why_better') cur.whyBetter = val;
      else if (key === '你会损失什么' || key === 'loss') cur.loss = val;
      else if (key === '推荐' || key === 'recommended') cur.recommended = val;
      else if (key === '用户决定' || key === 'decision') cur.decision = val;
      continue;
    }
    const opt = /^(\d+)[.)、]\s*(.+)$/.exec(line);
    if (opt && (inOptions || cur.options.length)) { cur.options.push(opt[2].trim()); continue; }
  }
  return out;
}

export function readRounds(dir) {
  const p = path.join(dir, 'ROUNDS.jsonl');
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of readText(p).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    try { const o = JSON.parse(s); if (o && typeof o === 'object') out.push(o); } catch { /* 坏行跳过，check 会报 */ }
  }
  return out;
}

/** 极简 YAML 子集：只认 `watches:` 下的 `- key: value` 列表 */
export function parseParams(text) {
  text = deBom(text);
  const watches = [];
  let cur = null;
  let inW = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^watches\s*:/.test(line)) { inW = true; continue; }
    if (!inW) continue;
    if (/^\S/.test(line) && line.trim()) { inW = false; continue; }
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) {
      cur = {};
      watches.push(cur);
      const kv = /^(\w+)\s*:\s*(.*)$/.exec(item[1].trim());
      if (kv) cur[kv[1]] = stripQ(kv[2]);
      continue;
    }
    if (!cur) continue;
    const kv = /^\s+(\w+)\s*:\s*(.*)$/.exec(line);
    if (kv) cur[kv[1]] = stripQ(kv[2]);
  }
  return watches.filter((w) => w.id && w.kind);
}

const stripQ = (v) => String(v).trim().replace(/^["']|["']$/g, '');

/**
 * 去掉 UTF-8 BOM。**必须做** —— Windows 上 PowerShell 的 `Set-Content -Encoding utf8`、
 * 记事本"另存为 UTF-8" 都会在开头塞一个 \ufeff，正则 `^watches:` 就永远匹配不上，
 * 结果是"配置看着没问题、脚本读到 0 个档位"（实测踩过）。
 */
export const deBom = (s) => String(s ?? '').replace(/^\uFEFF/, '');
/** 读文本文件并去 BOM */
export function readText(p) {
  return deBom(fs.readFileSync(p, 'utf8'));
}

/** 读一个档位的当前值 */
export function readWatch(root, w) {
  try {
    if (w.kind === 'rust_const') {
      const p = path.join(root, w.file);
      if (!fs.existsSync(p)) return { ok: false, err: `文件不存在 ${w.file}` };
      const re = new RegExp(`(?:pub\\s+)?const\\s+${w.name}\\s*:\\s*\\w+\\s*=\\s*(-?[\\d._]+)\\s*;`);
      const m = re.exec(fs.readFileSync(p, 'utf8'));
      if (!m) return { ok: false, err: `源码里找不到 const ${w.name}` };
      return { ok: true, value: Number(m[1].replace(/_/g, '')) };
    }
    if (w.kind === 'gd_const') {
      // GDScript: const NAME := 1.30  或  const NAME: float = 1.30
      const p = path.join(root, w.file);
      if (!fs.existsSync(p)) return { ok: false, err: `文件不存在 ${w.file}` };
      const re = new RegExp(`^const\\s+${w.name}\\s*(?::\\s*\\w+)?\\s*:?=\\s*(-?[\\d._]+)`, 'm');
      const m = re.exec(fs.readFileSync(p, 'utf8'));
      if (!m) return { ok: false, err: `GDScript 里找不到 const ${w.name}` };
      return { ok: true, value: Number(m[1].replace(/_/g, '')) };
    }
    if (w.kind === 'file_hash') {
      // 「这个文件有没有被动过」—— 对纯结构（没有数值常量的）最有用
      const p = path.join(root, w.file);
      if (!fs.existsSync(p)) return { ok: false, err: `文件不存在 ${w.file}` };
      return { ok: true, value: hashFile(p) };
    }
    if (w.kind === 'gd_funcs') {
      // API 面：函数的**个数**。改了数据结构把某个函数删了/改名了，这里会变。
      const p = path.join(root, w.file);
      if (!fs.existsSync(p)) return { ok: false, err: `文件不存在 ${w.file}` };
      return { ok: true, value: listFuncs(fs.readFileSync(p, 'utf8')).length };
    }
    if (w.kind === 'json_field') {
      const p = path.join(root, w.file);
      if (!fs.existsSync(p)) return { ok: false, err: `文件不存在 ${w.file}` };
      const v = dig(JSON.parse(fs.readFileSync(p, 'utf8')), w.path);
      return v === undefined ? { ok: false, err: `路径取不到值 ${w.path}` } : { ok: true, value: v };
    }
    if (w.kind === 'jsonl_last') {
      const p = path.join(root, w.file);
      if (!fs.existsSync(p)) return { ok: false, err: `文件不存在 ${w.file}` };
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const v = dig(JSON.parse(lines[i]), w.path);
          if (v !== undefined) return { ok: true, value: v };
        } catch { /* 跳过坏行 */ }
      }
      return { ok: false, err: `最后一条记录里取不到 ${w.path}` };
    }
    return { ok: false, err: `不认识的 kind: ${w.kind}` };
  } catch (exc) {
    return { ok: false, err: exc.message };
  }
}

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
}

/** 列出文件里的函数名（GDScript） */
export function listFuncs(text) {
  // ⚠ 实测（2026-09-16）：原来只认 GDScript 的 `func`，于是在**本项目的 Rust 源码**上
  //   4 个文件全是 "0 个函数" —— `diff` 的"哪个函数没了"那一栏等于废的。
  //   现在四种语言都收：Rust `fn` / GDScript `func` / JS `function` / Python `def`。
  const out = new Set();
  for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/gm)) out.add(m[1]);
  for (const m of text.matchAll(/^\s*(?:static\s+)?func\s+([A-Za-z_]\w*)/gm)) out.add(m[1]);
  for (const m of text.matchAll(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of text.matchAll(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm)) out.add(m[1]);
  return [...out];
}

function dig(o, dotted) {
  let cur = o;
  for (const k of String(dotted ?? '').split('.')) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(k) ? cur[Number(k)] : cur[k];
  }
  return cur;
}

// ------------------------------------------------------------------ 会话日志：逐字核对原话
let _corpusEntries = null;
let _corpusKey = null;
/**
 * 「这次到底扫了几个窗口」—— R37 要求**输出里明写**。
 * 为什么单独留一份旁路统计：`corpusEntries` 的返回类型是数组，好几个调用方按数组用，
 * 不能为了报个数就改返回形状（那会去动完好的功能）。
 */
let _corpusStats = {
  mode: 'all', scoped: false, session: null,
  windows: 0, sessionsSeen: 0, skippedOtherWindows: 0, subagentSessions: 0, noDiskWindows: 0,
};
export const corpusScanStats = () => ({ ..._corpusStats });

/**
 * 只收**真用户**消息。实测 DSH 把系统注入也记成 user/message，靠 data.source.kind 区分：
 *   user(129) / plugin(68) / agent-instructions(19) / subagent-settled(9) / agent-message(6) / goal(2) / skill-catalog(1)
 * 不筛的话，AI 把自己写的东西塞进 agent-message 就能冒充"用户原话"。
 * 保留 time/seq —— 校验"用户批准偏差"时必须能判断这句话是不是发生在交付替代品**之后**。
 *
 * ★ R37：`session` 给了就**只扫那一个窗口**；`allWindows` 才扫全集。
 *   **默认（什么都不给）保持全集** —— `check` 走这条默认路，它拿 SPEC 里的引文逐字核对，
 *   而 SPEC 的引文本就来自**多个窗口**；把 check 也收窄会把合法的跨窗口引文全判成
 *   "查无实据" ⇒ 那是**改坏完好的功能**（L42 ⑧ 钉着这一条）。
 */
export function corpusEntries(root, { force, session, allWindows } = {}) {
  // 到哪里去找"用户原话"：
  //  ① .warden/config.json 里点名的工作区（需要跨会话/跨窗口核对时用）
  //  ② 认「当前会话实际落在哪个工作区目录」—— 工程在子目录、.git 在子目录里是常态
  //  ③ 退回按工程根编码
  const dirNames = quoteDirNames(root);
  const want = allWindows ? null : (String(session ?? '').trim() || null);
  const key = `${want ?? '*'}|${dirNames.join('|')}`;
  if (_corpusEntries && !force && _corpusKey === key) return _corpusEntries;
  const out = [];
  /**
   * ★ 「几个窗口」的口径：**只有 `session-<uuid>` 才是用户的窗口**，裸 uuid 是**子代理会话**
   *   （它第一条"用户消息"其实是父代理派发的提示词）。口径必须与 `voices` 一致 ——
   *   两个命令各说各话等于没报。
   *   ⚠ 这里**只改计数口径，不改收哪些消息** —— 收消息的规则属于 `check` 的判定。
   */
  const seenWindows = new Set();
  const noDiskWindows = new Set();
  let subagentSessions = 0;
  let sessionsSeen = 0; let skippedOtherWindows = 0;
  for (const s of listSessions({ dirName: dirNames })) {
    sessionsSeen += 1;
    /**
     * ★ 子代理会话**先判**（原来"窗口过滤"排在它前面 ⇒ scoped 时子代理被当成"别的窗口"
     *   提前 skip，`子代理会话 N 个` 就**永远是 0**，与同一行"共见到 S 个会话"自相矛盾）。
     *   ⚠ 仍然**只计数、不 `continue`**：收不收这些消息属于 `check` 的判定，动它会改坏完好的功能。
     */
    if (!s.sessionId.startsWith('session-')) subagentSessions += 1;
    if (want && s.sessionId !== want) { skippedOtherWindows += 1; continue; }
    try {
      const { events } = decodeSession(s.file);
      const wroteDisk = sessionWroteDisk(events);
      for (const e of events) {
        if (e.type !== 'user/message') continue;
        if (e.data?.source?.kind !== 'user') continue;
        /**
         * ★ **只取正文文本，不要 `JSON.stringify(e)`**（2026-09-17 修，事故 I54）。
         *
         * 缺陷（被**另一个窗口**独立发现，我复核成立）：这里原来存的是 `JSON.stringify(e)`，
         *   于是语料里的反斜杠是**转义过的 `\\`**，而用户原话里是单个 `\`
         *   ⇒ **凡「原话」里带 Windows 路径，`check` 的逐字核对必然不通过**。
         *   实测：`corpus.includes('<HOME>\...\<需求对照表>.md完善九月项目团的制作')`
         *   = false，而语料里那一段其实是 `<WORKSPACE>\\...`。
         *   这条对本用户尤其致命 —— **他的消息经常就是一条文件路径**（他习惯把文件丢过来说"完善这个"），
         *   于是那些原话**永远无法被认定为"他说过"**，正好落进「说过的事情被丢掉」那口井。
         *
         * ⚠ 同一类 bug 在 `assistantEntries` 里**早就修过**（那边的注释写着"不要 JSON.stringify(e)"），
         *   用户这一侧当时漏了 —— 同一类缺陷只修一半。
         *   副作用同样是好的：不会拿 JSON 的键名/元数据（`type`/`seq`/`source`…）去误配。
         *   `raw` 保留整个事件，供需要完整记录的地方用（目前没有消费者依赖它）。
         */
        const c = e.data?.content;
        const text = Array.isArray(c) ? c.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
        if (!text) continue;
        out.push({ text, raw: JSON.stringify(e), time: e.time ?? null, seq: e.seq ?? null, session: s.sessionId });
        // 只有**真的贡献了原话**的主窗口才算进"扫了几个窗口"（空窗口不算查过）
        if (s.sessionId.startsWith('session-')) {
          seenWindows.add(s.sessionId);
          if (!wroteDisk) noDiskWindows.add(s.sessionId);
        }
      }
    } catch { /* 单文件失败不影响整体 */ }
  }
  _corpusEntries = out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  _corpusKey = key;
  _corpusStats = {
    mode: want ? (String(session ?? '').trim() ? 'session' : 'mine') : 'all',
    scoped: !!want, session: want,
    windows: seenWindows.size, sessionsSeen, skippedOtherWindows, subagentSessions,
    noDiskWindows: noDiskWindows.size,
  };
  return _corpusEntries;
}

/** 去哪些工作区找用户原话（编码后的目录名） */
export function quoteDirNames(root) {
  const dir = path.join(root, WARDEN_DIR);
  const cfg = readConfig(dir);
  if (Array.isArray(cfg.quoteWorkspaces) && cfg.quoteWorkspaces.length) {
    return cfg.quoteWorkspaces.map((w) => encodeWorkspace(w));
  }
  const auto = workspaceDirOfSession(currentSessionId());
  return [auto ?? encodeWorkspace(root)];
}

// ================================================== 窗口隔离 + 总账本（R37）
/**
 * ★ **每个窗口有自己单独负责的一本账**（用户 2026-09-24 逐字）：「（用户原话已隐去 —— 公开版不留逐字）」
 *
 * **污染是双向实测的**，不是"我这边脏了"：
 *   · 本窗口实测：`voices` 报「已认领 191 / 共 389 · 未认领 198」—— 那 198 条里大部分不是这个窗口说的，
 *     因为扫描扫的是 **DSH 会话日志全集**，而所有窗口的日志在同一个 `~/.dsh/sessions/` 下；
 *   · 反向：`quoteWorkspaces` 点名一个装着好几个工程的目录，等于把**同目录下所有工程的所有窗口**
 *     混成一本账（隔壁工程的截图逐字写着「30 条待认领（其中 28 条是隔壁插件的窗口留在同一本账里的）」）。
 *
 * 所以取数规则：**默认只扫本窗口**；扫全集必须**显式**（`--all-windows` / `--session <id>`），
 * 而且输出里**必须明写扫了几个窗口** —— 没写出来，就等于没查。
 * ⚠ **不是**把"扫全集"删掉（那会毁掉跨窗口核对）：`--all-windows` 就是那条显式的路。
 */
export function resolveWindowScope(root, { session, allWindows } = {}) {
  const explicit = String(session ?? '').trim();
  if (allWindows) return { mode: 'all', scoped: false, session: null, why: '--all-windows（显式扫全集）' };
  if (explicit) return { mode: 'session', scoped: true, session: explicit, why: `--session ${explicit}（显式指定窗口）` };
  const env = String(currentSessionId() ?? '').trim();
  // 主窗口 id 形如 `session-<uuid>`；**子代理会话是裸 uuid** —— 它没有"用户在这个窗口说过的话"。
  if (env && env.startsWith('session-')) return { mode: 'mine', scoped: true, session: env, why: 'DSH_SESSION_ID（本窗口）' };
  return {
    mode: 'unknown', scoped: false, session: null,
    why: env ? `DSH_SESSION_ID=${env} 不是主窗口 id（子代理会话没有自己的用户原话账）` : '环境里没有 DSH_SESSION_ID',
  };
}

/**
 * 认不出本窗口时**一律拒收**（exit 2），不替你猜。
 * 为什么：静默按全集扫**就是**这次要修的污染本身；而"0 条"被读成"没问题"是最坏的一类假通过。
 */
export function unknownWindowNotice(scope, cmd) {
  return [
    `[拒收] 认不出「本窗口」是哪一本账 —— ${scope.why}。`,
    '  **不替你猜**：静默按全集扫，就是这次要修的污染本身。',
    '  两条明确的出路（选一条）：',
    `    · 只扫本窗口：  node warden.mjs ${cmd} --session <本窗口会话id>`,
    `    · 扫全集：      node warden.mjs ${cmd} --all-windows`,
  ].join('\n');
}

/** 本窗口自己的那本原话账：`.warden/voices/<会话id>.jsonl` —— 「各自窗口先写入单独的」 */
export function voiceFileFor(dir, session) {
  return path.join(dir, 'voices', `${String(session).replace(/[^\w.-]/g, '_')}.jsonl`);
}

/**
 * 取**位置参数**（关键词 / 文件路径）：跳过 `--flag`，并把带值 flag 的**值**也跳掉。
 *
 * ⚠ 实测踩过：`voices --session session-BBBB` 里，`session-BBBB` 会被
 *   `filter(a => !a.startsWith('--'))` 当成**关键词**去查 —— "显式指定了一个窗口"变成
 *   "查一个叫 session-BBBB 的词"，返回 0 条还报得理直气壮。这类洞一旦发生就是**静默查错东西**。
 */
export function positionalArgs(argv, valueFlags = []) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a.startsWith('--')) { if (valueFlags.includes(a)) i += 1; continue; }
    out.push(a);
  }
  return out;
}

/**
 * `QUESTIONS.jsonl` 里**最近一条还没判决的问题** —— 硬伤 D 的判据 ②。
 *
 * 硬伤 D 的事故原样：`ask --verdict decide --reason "我决定这么做"`
 *   → 落盘 `{"resolved":"decide","reason":"我决定这么做","question":""}`。
 * `question` 从**脏值**变成**空串**，而空串**不是修复** —— 它变成"静默的空输入 + exit 0"，
 * 判决记录**无法与任何问题对上**（既不能复核、也不能推翻）。
 * ⇒ 判决必须能对上**一个具体问题**：命令行给了就用它；没给就从这里取一条**明说取自哪里**；
 *   两处都没有 ⇒ **拒收 exit 2，一个字节都不写**。
 */
export function lastPendingQuestion(file) {
  if (!fs.existsSync(file)) return null;
  const lines = readText(file).split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  const judged = new Set();
  for (const l of lines) {
    let o = null; try { o = JSON.parse(l); } catch { continue; }
    if (o && o.resolved && o.question) judged.add(String(o.question));
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let o = null; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (!o || !o.question) continue;      // 空 question 的坏记录**不算**一条待决问题
    if (o.resolved) continue;             // 已经判决过的
    if (judged.has(String(o.question))) continue;   // 同一个问题已经判过了
    return { question: String(o.question), at: o.at ?? null };
  }
  return null;
}

// ------------------------------------------------------------------ 总账本
/**
 * 跨窗口的那一本：`.warden/LEDGER.jsonl`（**未做完项的汇总 + 各窗口完成状态**）。只增不改。
 *
 * 逐字对得上：
 *   · 「但也有一个总账本」     → 全工程一本，所有窗口读得到；
 *   · 「各自窗口先写入单独的」 → 原话先落 `.warden/voices/<窗口>.jsonl`（见 syncVoices）；
 *   · 「做完后就标记做完」     → `ledger done --req R#` 写一笔 `status:"done"`，带**窗口 id + 时间**；
 *   · 「未做完的写入总账本」   → `ledger flush` / 收尾 `results` 自动落这一笔
 *                              （**不做完就静默消失 = 事故**，所以这一笔是强制的）；
 *   · 「总账每条可辨出处」     → 每条**必有** `window` + `projectRoot` + `at`。
 */
const LEDGER_FILE = 'LEDGER.jsonl';

/**
 * 账本标识：`<工程目录名>-<工程根 sha256 前 6 位>`。
 * ★ **R# 不跨账**：需求号只在**它自己那本账**里有效。跨账引用**必须**写成 `<账本id>#R37`
 *   （同号不同物是"静默错认"的温床）。标识由**工程根绝对路径**派生（大小写不敏感）
 *   ⇒ 同一工程的所有窗口算出同一个标识，隔壁工程算出不同的 ⇒ 天然分账。
 */
export function ledgerIdOf(root) {
  const abs = path.resolve(root);
  const base = (path.basename(abs) || 'root').replace(/[^\w.-]/g, '_');
  const h = crypto.createHash('sha256').update(abs.toLowerCase()).digest('hex').slice(0, 6);
  return `${base}-${h}`;
}

/** `R37` → 本账；`<账本id>#R37` → 指定账；其它 → null（拒收，不许瞎认） */
export function parseLedgerReq(s) {
  const t = String(s ?? '').trim();
  const m = /^(.+?)#(R\d+)$/.exec(t);
  if (m) return { ledger: m[1].trim(), req: m[2] };
  if (/^R\d+$/.test(t)) return { ledger: null, req: t };
  return null;
}

/**
 * 读总账本：合法行与**坏行**分开返回。
 * 坏行不许静默吞掉 —— 吞掉会让"未做完"**少算**，而少算正是"不做完就静默消失"那口井。
 */
export function readLedger(dir) {
  const p = path.join(dir, LEDGER_FILE);
  const entries = []; const bad = [];
  if (!fs.existsSync(p)) return { entries, bad, file: p };
  readText(p).split(/\r?\n/).forEach((l, i) => {
    const s = l.trim();
    if (!s || s.startsWith('#')) return;
    let o; try { o = JSON.parse(s); } catch { bad.push({ n: i + 1, why: '不是合法 JSON' }); return; }
    if (!o || typeof o !== 'object') { bad.push({ n: i + 1, why: '不是一个 JSON 对象' }); return; }
    if (!o.ledger) { bad.push({ n: i + 1, why: '缺 ledger（账本标识）—— 看不出这个 R# 属于哪本账' }); return; }
    if (!/^R\d+$/.test(String(o.req ?? ''))) { bad.push({ n: i + 1, why: `req「${o.req}」不是裸 R#（跨账要在 ledger 字段里分开写）` }); return; }
    if (!o.window) { bad.push({ n: i + 1, why: '缺 window（窗口/会话 id）—— 看不出是谁写的' }); return; }
    if (!o.projectRoot) { bad.push({ n: i + 1, why: '缺 projectRoot（工程根）—— 看不出是哪本账' }); return; }
    if (!o.at) { bad.push({ n: i + 1, why: '缺 at（时间）' }); return; }
    if (!['open', 'done', 'reopen'].includes(String(o.status))) { bad.push({ n: i + 1, why: `status「${o.status}」不认识（只能是 open / done / reopen）` }); return; }
    entries.push(o);
  });
  return { entries, bad, file: p };
}

export function appendLedger(dir, rec) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, LEDGER_FILE);
  fs.appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8');
  return p;
}

/**
 * 归并总账：key = `账本|R#`。
 *
 * ★ **`done` 是"粘"的 —— 不许被后来的 `open` 悄悄盖回去。**
 *   场景：窗口 A 做完 R37、标了 done；窗口 B 收尾时把 R37 当成"自己还没做完"、又写了一笔 open。
 *   若按"后写为准"，那条 done 就被抹掉了 ⇒ **别的窗口会以为这件还没做**，
 *   而这正是用户要的那件事（「做完后就标记做完」）当场失效。
 *   所以：done 一旦立住，后来的 open **不改状态**，只记进 `postDoneOpen` **明着报出来**。
 *   真要重开，得显式 `ledger reopen --req R#`（把话说清楚，而不是靠一次手滑的 flush）。
 */
export function ledgerState(dir) {
  const { entries, bad, file } = readLedger(dir);
  const byKey = new Map();
  for (const e of entries) {
    const k = `${e.ledger}|${e.req}`;
    let it = byKey.get(k);
    if (!it) {
      it = {
        ledger: e.ledger, req: e.req, status: 'open', title: '', note: '',
        window: e.window, projectRoot: e.projectRoot, at: e.at, n: 0,
        doneAt: null, doneBy: null, reopenedAt: null, reopenedBy: null,
        windows: [], postDoneOpen: [],
      };
      byKey.set(k, it);
    }
    it.n += 1;
    if (!it.windows.includes(String(e.window))) it.windows.push(String(e.window));
    it.at = e.at; it.window = e.window;
    if (e.title) it.title = e.title;
    if (e.note) it.note = e.note;
    const isDone = String(e.status) === 'done';
    const isReopen = String(e.status) === 'reopen';
    if (isDone) {
      it.status = 'done';
      if (!it.doneAt || String(e.at) >= String(it.doneAt)) { it.doneAt = e.at; it.doneBy = e.window; }
    } else if (isReopen) {
      // 显式重开：只有这一条能把 done 打回 open（不许靠一次手滑的 flush 达成）
      it.status = 'open';
      it.reopenedAt = e.at; it.reopenedBy = e.window;
    } else if (it.status === 'done') {
      it.postDoneOpen.push({ at: e.at, window: e.window, note: e.note ?? '' });
    }
  }
  const items = [...byKey.values()].sort((a, b) => `${a.ledger}|${a.req}`.localeCompare(`${b.ledger}|${b.req}`));
  return { items, entries, bad, file };
}

/**
 * 本窗口**还没做完**的项 —— 收尾必须写进总账的东西。
 * 两个来源（先总账、后开工清单）：
 *   ① 总账里本账本 + 本窗口、状态不是 done 的项（"做完就标记做完"没做，就得一直挂着）；
 *   ② 退路：本窗口还没往总账写过东西时，用 `RECON.jsonl` 里本窗口最后一次 `needs` 的 `planned`
 *      —— 否则一个新窗口收尾时会"什么都没写"（= 不做完就静默消失）。
 */
export function unfinishedForWindow(dir, session, root, ledgerId) {
  const st = ledgerState(dir);
  // ⚠ 用 `windows.includes` 而不是 `window ===`：后者是"最后一次动它的人"，
  //   会把"本窗口也开过这一项"漏掉（那正是"未做完就静默消失"的入口）。
  const out = st.items
    .filter((x) => x.ledger === ledgerId && x.windows.includes(String(session)) && String(x.status) !== 'done')
    .map((x) => ({ req: x.req, title: x.title ?? '', why: '总账里还没被标记做完' }));
  if (out.length) return out;
  try {
    const rp = path.join(dir, RECON_FILE);
    if (fs.existsSync(rp)) {
      let planned = null;
      for (const line of readText(rp).split(/\r?\n/)) {
        const s = line.trim(); if (!s.startsWith('{')) continue;
        let o = null; try { o = JSON.parse(s); } catch { continue; }
        if (o && o.kind === 'needs' && String(o.session ?? '') === String(session)) planned = o;
      }
      if (planned && Array.isArray(planned.planned) && planned.planned.length) {
        const lastByReq = new Map();
        for (const r of readRounds(dir)) {
          const id = String(r.requirement ?? ''); if (!id) continue;
          const cur = lastByReq.get(id);
          if (!cur || Number(r.round ?? 0) >= Number(cur.round ?? 0)) lastByReq.set(id, r);
        }
        /**
         * ★★ **总账里已经 done 的项，绝不许再从"开工清单"这条路被重新写回 open。**
         *
         * 实测（P-M19 自己的证据脚本 `r37_musts.mjs` 的 ③-2 抓到的）：
         *   `ledger done --req R1` 之后再跑一次 `results`，它会**又**写一笔 `open` ——
         *   因为这条退路只看"最新一轮的 ROUNDS 状态"，而账本里那条 done 它**没看**。
         *   后果正对着用户那句话（「**做完后就标记做完**…不许留着让别的窗口重复做」）：
         *   别的窗口收尾时会把一件**已经做完**的事重新报成"未做完"。
         *   ⚠ `ledgerState` 那边 done 仍然是"粘"的（不会被 open 盖回去），
         *     所以这不是数据被抹掉，而是**账本里凭空多出噪音 + 收尾报错数** —— 一样要治。
         * 判据：`st.items` 里 `账本|R#` 状态为 done ⇒ 跳过。
         */
        const doneInLedger = new Set(
          st.items.filter((x) => x.ledger === ledgerId && String(x.status) === 'done').map((x) => String(x.req)),
        );
        for (const id of planned.planned) {
          if (doneInLedger.has(String(id))) continue;   // ★ 总账说它做完了 ⇒ 不许再报"未做完"
          const last = lastByReq.get(String(id));
          if (last && String(last.status) === 'done') continue;
          out.push({
            req: String(id), title: '',
            why: `开工清单（RECON）里要做的，收尾时还没 done（最新第 ${last ? last.round : '—'} 轮 ${last ? last.status : '没有轮次'}）`,
          });
        }
      }
    }
  } catch { /* 退路读不动就只用总账里的（不是静默通过：上面若也没有，调用方会明说 0 条） */ }
  return out;
}

/** 收尾落账：把本窗口未做完的项写进总账（每项一笔 `open`，带窗口 id / 工程根 / 时间） */
export function flushWindowToLedger(root, dir, { session, ledgerId, note = '' } = {}) {
  const items = unfinishedForWindow(dir, session, root, ledgerId);
  const at = new Date().toISOString();
  for (const it of items) {
    appendLedger(dir, {
      at, ledger: ledgerId, req: it.req, title: it.title,
      status: 'open', window: session, projectRoot: path.resolve(root),
      note: note || `收尾写入总账：${it.why}`,
    });
  }
  return { added: items.length, items, at };
}

export function readConfig(dir) {
  const p = path.join(dir, 'config.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(readText(p)); } catch { return {}; }
}

export function writeConfig(dir, cfg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

const squash = (s) => String(s ?? '').replace(/\s+/g, '');

/** 用户有没有真的说过这句（真用户消息，注入的不算） */
export function findUserSaying(root, text) {
  const q = squash(text);
  if (!q) return null;
  return corpusEntries(root).find((e) => squash(e.text).includes(q)) ?? null;
}

export function corpusText(root, opts) {
  return corpusEntries(root, opts).map((e) => e.text).join('\n').replace(/\s+/g, '');
}

/**
 * 只看"用户说过没有"是不够的 —— **用户会把你写的东西贴回来**。
 * 实测事故（2026-09-16）：一处引文在 VOICE.jsonl 里逐字命中，于是被判"用户原话"，
 * 但那句「穿梭感还没做出来：WASD 飞行只在漫游模式下有效…」**是 AI 写的缺陷清单**，
 * 用户只是把它贴回来了。**"用户在消息里提到了" ≠ "用户说的"。**
 *
 * 判别法：同一段文字如果**更早出现在 assistant 消息里** → 用户在引述 AI，不是原创。
 */
let _aiEntries = null;
export function assistantEntries(root, { force } = {}) {
  if (_aiEntries && !force) return _aiEntries;
  const out = [];
  for (const s of listSessions({ dirName: quoteDirNames(root) })) {
    if (!s.sessionId.startsWith('session-')) continue;
    try {
      const { events } = decodeSession(s.file);
      for (const e of events) {
        if (e.type !== 'assistant/message') continue;
        // ★ 只取**正文文本**，不要 JSON.stringify(e)：
        //   实测踩过 —— JSON 里 `"` 会变成 `\"`，而松散化只去标点不去反斜杠，
        //   于是 AI 文本永远比用户引文多一个 '\' → **引述检测永远不命中**（假阴性）。
        //   副作用也好：不会拿 JSON 的键名/元数据去误配（假阳性）。
        const c = e.data?.message?.content;
        const text = Array.isArray(c) ? c.filter((b) => b?.text).map((b) => b.text).join('\n') : '';
        if (!text) continue;
        out.push({ text, time: e.time ?? null, session: s.sessionId });
      }
    } catch { /* 跳过 */ }
  }
  _aiEntries = out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  return _aiEntries;
}

/** 这句话是不是用户"引述"的（更早出现在 AI 的产出里） */
export function isQuotedFromAI(root, quote, userHit) {
  const q = loose(quote);            // ⚠ 必须用 loose（去标点/markdown）——
  if (!q || q.length < 12) return false;  // 只比空白的话，AI 原文与你引的差一个引号就漏判（实测踩过）
  for (const a of assistantEntries(root)) {
    if (!loose(a.text).includes(q)) continue;
    if (userHit?.time == null || a.time == null || a.time <= userHit.time) return true;
  }
  return false;
}

// ------------------------------------------------------------------ 检查
/**
 * 「查出来没做」闸（用户 2026-09-16 提出；
 *   核心诉求：查出来不解决反而添垃圾形成干扰）
 *
 * check 原来只查"这条需求**从没有过**任何一轮记录"，不查"有过记录、但最新一轮还停在
 * not_started / partial / blocked"。于是长期不动的那批照样 exit 0 —— 痛点从"没发现"
 * 变成"发现了还堆在清单上"。
 *
 * 判定：取每条需求**轮次号最大**的那一轮，status ∈ {not_started, partial, blocked} 即算"未解决"。
 * 为什么只计数、不硬失败：跟"原话认领"同一套理由 —— 历史欠账一次性硬失败会变成噪音、
 * 然后被无视（见 claims 水位线的设计说明）。它靠两处被看见：check 的提醒行 +
 * 插件推给用户的那一行（"N 条查出来还没做"）+ REPORT.md 尾部一行。
 */
export function staleRequirements(spec, rounds) {
  const byReq = new Map();
  for (const r of rounds ?? []) {
    const id = String(r?.requirement ?? '');
    if (!id) continue;
    const arr = byReq.get(id) ?? [];
    arr.push(r);
    byReq.set(id, arr);
  }
  const out = [];
  for (const s of spec) {
    const mine = byReq.get(s.id) ?? [];
    if (!mine.length) continue; // 完全没轮次的，另有硬失败管
    const last = mine.reduce((a, b) => (Number(b.round ?? 0) >= Number(a.round ?? 0) ? b : a));
    const st = String(last.status ?? '');
    if (st === 'not_started' || st === 'partial' || st === 'blocked') {
      out.push({
        id: s.id,
        status: st,
        round: Number(last.round ?? 0),
        half: String(last.missing_half ?? '').trim(),
        parked: isParked(s),
      });
    }
  }
  return out;
}

/**
  * 「划到别的线上」的需求（用户 R19 要求不要一直出现 + R21 要求只显示对用户有影响的内容）。
 * 判据**只看标题行**，而且标记必须写在**括号里**（`（…本轮不实现…）` / `(…)` / `【…】`）。
 * 为什么这么严：
 *   · 只看标题 = 正文短句随手可加，能消掉欠账就等于给"把账藏起来"开后门；
 *   · 还要求括号 = 光是**提到**这个词（比如标题写"只有正文写了'本轮不实现'的需求"）
 *     不该被算成已划走 —— 实测就是这么踩的坑（夹具 R3 的标题里带这个字样，被误判成划走）。
 * 实测来源（2026-09-16）：R17 标题就是「…（**本轮不实现**，属另一条实现线）」——
 * 这种条目永远不可能清零，却被当成欠账推给用户，正是"一直挂在那儿"的来源。
 */
const PARKED_RE = /[（(【][^）)】]{0,60}(?:本轮不实现|属另一条实现线)[^）)】]{0,60}[）)】]/;
export function isParked(specItem) {
  return PARKED_RE.test(String(specItem?.title ?? ''));
}

export function check(root, { specText, devText, rounds, watches } = {}) {
  const dir = path.join(root, WARDEN_DIR);
  const fails = []; const warns = [];
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);

  /**
   * ★ 角色名单漂移（注册表 vs 各处派生名单）。
   *   实测教训：`资料员`/`方向员` 在代码里出现 36 处、**却不在投票名单** ⇒ 不投也算"票齐"
   *   ⇒ **新角色的意见可以被静默忽略**。所以每次 check 都问一遍"名单还一致吗"，
   *   少一条就**硬失败**（不是警告）—— 加第八个角色时漏改一处，就在这里被抓住。
   */
  for (const b of roleRegistryAudit({
    findingRoles: FINDING_ROLES,
    workRoles: WORK_ROLES.map((r) => r.id),
    stamps: Object.values(ROLE_STAMP),
  })) fails.push(`[角色] ${b}`);

  const specRaw = specText ?? read('SPEC.md');
  const devRaw = devText ?? read('DEVIATIONS.md');
  if (specRaw == null) { fails.push(`[结构] 缺 ${WARDEN_DIR}/SPEC.md —— 先跑 warden.mjs init，把你的需求逐字锁进去。`); return { fails, warns, spec: [], devs: [], rounds: [] }; }
  const spec = parseSpec(specRaw);
  /**
   * 重复需求号 = 硬失败（2026-09-17 实测事故）：我追加新需求时**没查空号**，直接写了个 R45，
   * 而 R45 早就存在 —— 册子里于是有**同一个号两条正文**，"引用 R45"指向哪一条说不清了。
   * 这种账本级歧义必须机械拦：`--ref R45`、认领、轮次、报告全都建在号上。
   */
  const dupIds = [...new Set(spec.map((s) => s.id).filter((id, i, arr) => arr.indexOf(id) !== i))];
  if (dupIds.length) {
    fails.push(`[结构] SPEC.md 里有**重复的需求号**：${dupIds.join('、')} —— 同一个号两条正文，`
      + '引用它到底指哪一条说不清。把其中一条改成空号（先看现有号，别猜）。');
  }
  const devs = parseDeviations(devRaw ?? '');
  const rds = rounds ?? readRounds(dir);
  const ws = watches ?? parseParams(read('params.yml') ?? '');

  if (!spec.length) fails.push('[需求] SPEC.md 里一条需求都没有 —— 没有锁定的需求，就没法判断"给的对不对"。');

  const corpus = corpusText(root);

  /**
   * 哪些需求的偏差是**用户真的批准过**的。
   * 这里必须比"用户说过这句话"更严 —— 否则 AI 只要把用户原本的需求原文
   * 抄进「用户决定」，就能把"不要立方体"洗成"同意用立方体"。
   */
  const approvedReqs = new Set();
  for (const d of devs) {
    const decided = String(d.decision ?? '').trim();
    if (!decided || /^(待定|-|pending|空)?$/i.test(decided)) continue;
    if (!d.requirement) continue;
    const hit = findUserSaying(root, decided);
    const echoesRequirement = spec.some((s) => s.id === d.requirement && squash(s.quote).includes(squash(decided)));
    if (hit && !echoesRequirement) approvedReqs.add(d.requirement);
  }

  const roundsByReq = new Map();
  for (const r of rds) {
    const k = String(r.requirement ?? '');
    if (!roundsByReq.has(k)) roundsByReq.set(k, []);
    roundsByReq.get(k).push(r);
  }

  for (const s of spec) {
    const tag = `[${s.id}]`;
    if (!s.quote || s.quote.length < 8) fails.push(`${tag} 缺「原话」或太短 —— 必须逐字抄用户说过的话，不是我的总结。`);
    if (!s.source) fails.push(`${tag} 缺「出处」—— 要能指回哪次会话/哪句话。`);
    if (!s.why) warns.push(`${tag} 没写「为什么」—— 用户解释过的理由是他为什么非要这样的关键，缺了很容易被"优化"掉。`);
    if (!s.must.length && !s.mustNot.length) fails.push(`${tag} 「必须」和「不要」都是空的 —— 这条需求没法验收。`);

    // ① 原话逐字核对（防 AI 改写需求）
    // ★ 实测踩过（「监督员」角色黑盒复现）：corpus 为空串时这里被整段跳过，而 check 仍报通过 ——
    //   **AI 写的东西能静默占住「原话」槽**。这就是 RF1 那条「没查到东西 ≠ 查了没问题」。
    if (s.quote && !corpus) {
      fails.push(`${tag} **这次什么都没核对** —— 用户真消息语料是空的，`
        + '「原话逐字比对」整段被跳过。这**不等于**"原话没问题"。'
        + '先跑 `node warden.mjs voices`，或用 `sources --add <工作区>` 指对地方。');
    } else if (s.quote && corpus) {
      const q = s.quote.replace(/\s+/g, '');
      if (!corpus.includes(q)) {
        // ⚠ 措辞必须把"我没扫到"也算进去：原来只写"要么原话被改写了"，
        //   把人推向**改写用户原话**（那正是这个 skill 要防的）。
        fails.push(`${tag} 你写的「原话」在**这次扫到的**语料里逐字找不到。三种可能：`
          + '① 原话被改写了（需求漂移）；② 出处不对；③ **这次没扫到那句话**（覆盖度不足）。'
          + '先排除 ③：跑 `node warden.mjs voices` 同步，并确认 `sources` 指的工作区是对的。');
      }
    }

    // ② 必须有推进记录
    const mine = roundsByReq.get(s.id) ?? [];
    if (!mine.length) {
      fails.push(`${tag} 从来没有哪一轮声明在推进这条需求 —— 要么真没做，要么做了没说（那成本也没归到它头上）。`);
    }

    // ③ 状态与证据
    const done = mine.filter((r) => r.status === 'done');
    for (const r of mine) {
      if (!['not_started', 'in_progress', 'done', 'partial', 'blocked', 'deviated', 'withdrawn', 'superseded'].includes(String(r.status))) {
        fails.push(`${tag} 第 ${r.round} 轮的 status 不认识：${JSON.stringify(r.status)}`);
      }
      // 终态必须说清依据：撤回 / 被别的需求承接，都不许"悄悄撤"
      // （方向员 2026-09-16 实测：有 5 条欠账其实是用户已经否掉的，却还在被推给他 —— 那条路也是"添垃圾"）
      if ((r.status === 'withdrawn' || r.status === 'superseded') && !String(r.why ?? '').trim()) {
        fails.push(`${tag} 第 ${r.round} 轮标了 ${r.status} 但没写 --why —— 撤回/被承接必须说清依据（指回哪条用户原话或哪个 R#），不许悄悄撤。`);
      }
      // 空壳记录：什么都没说，不能拿来顶"这条需求有人在做"
      const blank = !String(r.delivered ?? '').trim() && !String(r.evidence ?? '').trim() && !String(r.why ?? '').trim();
      if (blank) {
        fails.push(`${tag} 第 ${r.round} 轮是**空壳记录**（delivered / evidence / why 全空）—— 占位符不算推进过这条需求。`);
      }
      if (r.status === 'done' && !String(r.evidence ?? '').trim()) {
        fails.push(`${tag} 第 ${r.round} 轮标了 done 但没给证据 —— 自称不算证据。`);
      }
      if (r.status === 'partial' && !String(r.missing_half ?? '').trim()) {
        fails.push(`${tag} 第 ${r.round} 轮标了 partial 但没写「哪一半没做」—— 半成品必须说清缺哪半。`);
      }
    }
    if (done.length && done.some((r) => !String(r.evidence ?? '').trim())) {
      // 已在上面逐条报过
    }

    /**
      * ⑤ 子项覆盖度：**"半个当整个"**（用户最痛的那条 —— 跑了很久、花了大量 token，关键问题只解决了半个）。
     * 原来 check 只校验"done 有没有证据"，不知道这条需求有几个子项，
     * 所以只做了一半、附上任意证据就能 exit 0 放行 —— **比"没做"更坏**：没做至少记录是诚实的。
     * 现在：SPEC 里声明了 `子项` 的需求，最新记录标 done 时必须声明并覆盖全部子项。
     */
    if (s.items.length) {
      const last = mine[mine.length - 1];
      if (last && last.status === 'done') {
        const cov = Array.isArray(last.covered) ? last.covered.map((x) => String(x).trim()) : [];
        const miss = s.items.filter((it) => !cov.includes(it));
        if (miss.length) {
          fails.push(`${tag} 第 ${last.round} 轮标了 done，但「子项」还差 **${miss.join('、')}**（覆盖 ${s.items.length - miss.length}/${s.items.length}）—— 半个不许当整个：补齐后再报 done，或者改用 --status partial --missing_half "…"。`);
        }
        // ⚠ 待改（见事故 I9 / 规则 R9）：这里本该再核一次**证据绑定**（手写账本绕过 record 的也要抓）。
        //   本轮试过加，但把本控制 ㊹（"覆盖齐全时放行"）弄红了 —— 现行契约只收子项名。
        //   要改就得**连同用例一起改**（record 侧收 `子项名=路径:行` + selftest ㊶㊷㊹ + L2/L13 夹具），
        //   别只改一半。**不许为了让改动通过而放宽检查，也不许留着红。**
      }
    }

    // ④ 交付物撞「不要」= 硬失败（除非这条偏差已经由用户真的批准过）
    const deliveredBlob = mine.map((r) => `${r.delivered ?? ''} ${r.why ?? ''}`).join(' ');
    /**
     * ⚠ **否定式不算违规**（2026-09-17 修；我自己踩到的假阳性）。
     *   实测：R15 的「不要」里有一条是 `跨窗口污染`，而我在 `--why` 里**逐字引用用户的要求**
     *   「…能×掉、修正后自清、**不跨窗口污染**」⇒ 匹配器只看到子串 `跨窗口污染`，
     *   于是判我"交付里出现了用户不要的东西"——**分不清 X 与「不 X」**。
     *   这是 A3（"不许把用户的否定写成正说"）的**镜像**：也不许把否定读成正说。
     *   处理：命中但**紧邻前面是否定词**（不/别/勿/没/未/无/禁止/杜绝）⇒ 只提醒、不判违规。
     *   ⚠ 它仍是**启发式**：真正的违规可以靠加一个"不"字绕过 —— 所以**提醒要照发**，别静默。
     */
    const NEG_BEFORE = /[不别勿没未无]\s*$|禁止\s*$|杜绝\s*$/;
    for (const bad of s.mustNot) {
      if (!bad) continue;
      /**
       * ⚠ **必须扫全部命中，不能只看第一处**（2026-09-17 我自己的正控抓到的洞）：
       *   只查第一处时，若第一处正好是「不跨窗口污染」这种否定写法，
       *   后面的**真违规**就被 `continue` 一起跳过了 ⇒ **判据形同虚设**。
       */
      let violation = false; let negOnly = false; let from = 0; let firstNeg = '';
      for (;;) {
        const at = deliveredBlob.indexOf(bad, from);
        if (at < 0) break;
        const before = deliveredBlob.slice(Math.max(0, at - 10), at);
        if (!NEG_BEFORE.test(before)) { violation = true; break }
        if (!negOnly) firstNeg = before.trim();
        negOnly = true;
        from = at + bad.length;
      }
      if (violation && !approvedReqs.has(s.id)) {
        const declared = devs.some((d) => d.requirement === s.id);
        fails.push(
          declared
            ? `${tag} 你说过**不要**【${bad}】，交付里出现了它，而且对应的偏差申报单**还没得到你本人批准** —— 替代品在你点头前不算交付。`
            : `${tag} 你说过**不要**【${bad}】，但交付里出现了它 —— 这正是"要齿轮给你正方形"。要改的话必须填偏差申报单，不能悄悄换。`,
        );
      } else if (negOnly && !violation) {
        warns.push(`${tag} 交付/理由里出现了「${bad}」，但每一处前面都是**否定词**（"…${firstNeg}"）—— 按「不${bad}」这种写法算**合规**，不当违规报。⚠ 启发式：加一个"不"字就能绕过，所以还是提醒你看一眼。`);
      }
    }

    /**
     * ★★ **每条「不要」都必须被逐条交代**（2026-09-17 新增；用户报的真事故）。
     *
     * 上面那个 `deliveredBlob.includes(不要那句话)` 的判据**结构上不可能响**（详见 `record` 里那段注释）——
     *   真实事故里它命中 **0 次**，而 `check` 一直报"需求监督通过"。所以这里补一条**能响**的：
     *   `done` 的那一轮，必须对**每一条**「不要」都给出 `--avoided "不要项=怎么避开的"`。
     * ⚠ 它判的是"有没有**显式回应**"，不是"交付物到底违没违规"（后者机器判不了，要人对着产物判）。
     *   但"沉默通过"变成"必须说清楚"，就足以让这次事故在**交付前**暴露出来。
     */
    const lastRow = mine.reduce((a, b) => (Number(b.round ?? 0) >= Number(a.round ?? 0) ? b : a), mine[0]);
    if (lastRow && String(lastRow.status) === 'done' && s.mustNot.length) {
      const av = Array.isArray(lastRow.avoided) ? lastRow.avoided.map((x) => String(x).trim()) : [];
      const missNot = s.mustNot.filter((it) => String(it).trim() && !av.some((a) => a === it || a.startsWith(it + '=')));
      if (missNot.length) {
        fails.push(`${tag} 第 ${lastRow.round} 轮标了 done，但**有 ${missNot.length} 条「不要」没有被交代过**：`
          + ` ${missNot.map((m) => '「' + String(m).slice(0, 40) + '」').join('、')}`
          + ' —— 用户逐字说过这些是他**不要**的。'
          + ' 补法：`node warden.mjs record --req ' + s.id + ' --status done --avoided "不要项=怎么避开的" …`。'
          + ' ⚠ 机器判不了"交付物到底违没违规"，但它保证**每一条「不要」都被显式回应过** —— 沉默不再等于通过。');
      }
    }
  }

  // ⑤-0 「查出来没做」闸 —— 判定见 staleRequirements 的注释（核心诉求：查出来不解决反而添垃圾）
  // ⚠ 划到别的线上的（标题写明"本轮不实现/属另一条实现线"）**不进这一行** ——
  //   用户 R19 要求不要一直出现 + R21 要求只显示对用户有影响的内容：
  //   永远清零不了的条目会把这一行**结构性地**钉死，然后就变成他说的"添垃圾形成干扰"。
  //   它们不消失，只是从"推给他的提示"降级成"check 里列着"（下面那一行）。
  const staleAll = staleRequirements(spec, rds);
  const stale = staleAll.filter((x) => !x.parked);
  const parked = staleAll.filter((x) => x.parked);
  if (stale.length) {
    warns.push(`[查出来没做] 已登记、但**最新一轮仍未解决**的有 ${stale.length} 条（**只计数、不算失败**）：`
      + stale.slice(0, 12).map((x) => `${x.id}(${x.status}${x.round ? `·第${x.round}轮` : ''})`).join('、')
      + (stale.length > 12 ? ` …（共 ${stale.length} 条）` : '')
      + '\n   为什么不硬失败：同「原话认领」——历史欠账一次性硬失败会变成噪音、然后被无视。'
      + '\n   但要能被看见：这个计数会写进插件快照（PLUGIN-LIVE.json 的 staleCount）**给 AI 看**；'
      + '**不推给用户**（用户 R43：正常运行就一个字都不显示，只有 check 硬失败或插件自身故障才出一行）。REPORT.md 尾部也有一行。'
      + '\n   消掉它的两条路：真去做；或者 record 一轮 --status blocked --why "为什么停着"。');
  }
  if (parked.length) {
    warns.push(`[已划走] 另有 ${parked.length} 条最新一轮仍未解决、但 SPEC 标题里写明"本轮不实现/属另一条实现线"，`
      + `**不计入推给用户的提示**（只在这里列着）：`
      + parked.map((x) => `${x.id}(${x.status}${x.round ? `·第${x.round}轮` : ''})`).join('、')
       + '\n   为什么不推给他：这类条目永远清零不了，留着就会把提示钉死在那儿（用户要求：不要一直出现在这里）。');
  }

  // ⑤-0b 发现台账（R28/R29）：资料员/方向员的产出必须署名 + 有出处 + 指到"做"上
  const fd = checkFindings(dir, spec.map((s) => s.id));
  for (const f of fd.fails) fails.push(f);
  for (const w of fd.warns) warns.push(w);

  // ⑤-0c 档位备份闸（用户：动关键数据之前要能随时复盘）—— 这一步归**方向员**，check 只提醒
  const sn = checkSnapshots(root, dir, ws);
  for (const f of sn.fails) fails.push(f);
  for (const w of sn.warns) warns.push(w);

  // ⑤ 偏差申报单
  const declared = new Set(devs.map((d) => d.requirement).filter(Boolean));
  for (const d of devs) {
    const tag = `[${d.id}]`;
    const need = [['为什么必须偏离', d.why, 20], ['为什么这比照原样做更好', d.whyBetter, 20], ['你会损失什么', d.loss, 6], ['差异', d.delta, 6]];
    for (const [name, val, min] of need) {
      if (!val || val.length < min) fails.push(`${tag} 「${name}」缺失或太短（要 ≥${min} 字）—— 理由撑不住就不该改需求。`);
    }
    if (!d.asked || !d.delivering) fails.push(`${tag} 必须写清「你要的」和「要给的是」—— 这两句摆在一起，荒诞一眼就能看出来。`);
    if (!d.requirement) fails.push(`${tag} 没写它对应哪条需求（「需求: R#」）。`);
    if (d.options.length < 2) fails.push(`${tag} 至少给用户 2 个选项（必须含「照原样做」）—— 不能替用户做决定。`);
    if (d.options.length && !d.options[0].includes('照原样')) {
      fails.push(`${tag} 选项 1 必须是「照原样做」—— 默认应当是用户原本要的东西，而不是我的替代品。`);
    }
    const recIdx = String(d.recommended).trim();
    const decided = String(d.decision).trim();
    const pending = !decided || /^(待定|-|pending|空)?$/i.test(decided);
    if (pending && recIdx && recIdx !== '1') {
      fails.push(`${tag} 推荐了选项 ${recIdx} 但用户还没表态 —— **替代品在用户点头之前不能当交付**，推荐只能是「照原样做」。`);
    }
    if (!pending) {
      const hit = findUserSaying(root, decided);
      const owner = spec.find((s) => s.id === d.requirement);
      if (!hit) {
        fails.push(`${tag} 「用户决定」写了「${decided}」，但在**真用户消息**里找不到这句 —— 不许替用户拍板（注入的文本不算）。`);
      } else if (owner && squash(owner.quote).includes(squash(decided))) {
        fails.push(`${tag} 「用户决定」引用的其实是**原始需求本身**（原话里就有这句），那不是"同意改成替代品" —— 别拿用户原本的要求给自己签名。`);
      } else {
        const devRound = rds
          .filter((r) => r.requirement === d.requirement && r.at)
          .map((r) => Date.parse(r.at))
          .filter((t) => Number.isFinite(t))
          .sort((a, b) => a - b)[0];
        if (devRound && hit.time && hit.time < devRound) {
          fails.push(`${tag} 「用户决定」引用的那句话发生在交付替代品**之前**（${new Date(hit.time).toLocaleString('zh-CN')} < ${new Date(devRound).toLocaleString('zh-CN')}）—— 那时候还没有这个偏差可批准。`);
        }
      }
    }
  }
  // 有 mustNot 被撞但没申报 → 已在上面的 ④ 报过；这里补一条总览
  for (const s of spec) {
    const mine = roundsByReq.get(s.id) ?? [];
    const deviated = mine.some((r) => r.status === 'deviated');
    if (deviated && !declared.has(s.id)) {
      fails.push(`[${s.id}] 有轮次标了 deviated（偏离了需求），但没有对应的偏差申报单 —— 未申报的偏差 = 硬失败。`);
    }
  }

  // ⑥ 档位回归：声明要盯的数据，当前值 vs 上次记录
  for (const w of ws) {
    const cur = readWatch(root, w);
    if (!cur.ok) { warns.push(`[档位 ${w.id}] 读不到当前值：${cur.err}`); continue; }
    const hist = rds.filter((r) => r.values && Object.prototype.hasOwnProperty.call(r.values, w.id));
    if (!hist.length) { warns.push(`[档位 ${w.id}] 从来没有记录过值 —— 它被改坏时你不会有任何记录可查。`); continue; }
    const last = hist[hist.length - 1];
    const lastVal = last.values[w.id];
    if (!sameValue(lastVal, cur.value)) {
      /**
       * ★★ **改成硬失败**（2026-09-17）：原来只 warn、exit 仍是 0 ⇒ "check exit 0 才算过"在
        *   用户最怕的那件事上失效（花一天调好的手感被后续功能改坏、还找不回来）。看见了却不拦 = 没拦。
       */
      fails.push(`[档位 ${w.id}] 当前值 ${cur.value} 与账本最后一版 ${lastVal}（第 ${last.round} 轮）**不一致** —— 它被改过了，`
        + '而账本没有跟上。用户最怕的就是这件事，所以这是**硬失败**。'
        + `\n   两条出路：① 真改了 → \`node warden.mjs record --req <R#> --status <…>\` 记一轮（它会自己读源码值）；② 没想改 → 改回去。`);
    }
  }

  // ⑦ 规则册：`提案` 且票已收齐的规则 → 提示"待推进"。**只提示，不因此失败**
  //    （票是齐了但可能是平票/有异议没回应，那还是未决 —— 所以这里只说"待推进"，结论归 rule status。）
  const pending = pendingRuleAdvances(dir);
  const pendingRules = pending.filter((p) => p.kind === '待推进');
  if (pendingRules.length) {
    warns.push(`[规则册] 有 ${pendingRules.length} 条规则票已齐、待推进：${pendingRules.map((p) => `${p.rule.id}（${p.tally.state}${p.tally.conditional.length ? `；${p.tally.conditional.length} 张附条件` : ''}）`).join('、')} —— 跑 node warden.mjs rule status --id ${pendingRules[0].rule.id} 看结论（只是提示，不算失败）。`);
  }
  const condRules = pending.filter((p) => p.kind === '待并条件');
  if (condRules.length) {
    warns.push(`[规则册] 有 ${condRules.length} 条规则在「${RULE_PENDING_CONDITIONS}」（${condRules.map((p) => p.rule.id).join('、')}）—— 票里附了条件，条件没并进正文之前不许当通过，跑：node warden.mjs rule amend --id ${condRules[0].rule.id} --text "…"（只是提示，不算失败）`);
  }

  // ⑧ 窗口传递层（VOICE）快照是不是落后了 —— **权威层自己会过期**（设计文档 L10）。
  //    实测事故：ARCH 的 R13 原话在原始日志第 4287 行有、VOICE.jsonl 里查无（只同步到 seq 19）。
  //    陈旧 = 硬失败（"归属核查不可信"时不该宣布完成）；从没建过 = 只提醒（那是"还没用起来"）。
  //    为什么敢让它拦："跑一次 node warden.mjs voices" 就能消掉 —— 是可修复的，不是噪音。
  const vs = voiceStaleness(root, dir);
  /**
   * ⚠ 这里**只提醒、不硬失败**（2026-09-16 改）。为什么降级：
   *   ① 影响面已被「记录」角色核实是**窄的** —— `quotes` 的引文核对直接读原始日志、不走 VOICE，
   *      真正受影响的只有 `ask`（问过没问过）与 `voices` 自己；
   *   ② 它的判据是**不解压 zstd 的 mtime 比较**（便宜），所以**别处注入的消息**（群聊、通知、插件提示）
   *      会把日志 mtime 写新、却没有任何新的用户原话 —— 实测今天就这样把 check 打红过一次
   *      （群聊里另一个窗口的一句话 → exit 1，而 `voices` 跑完**一条都没新增**）。
    *   ③ 用户明确要求窗口间不能互相实时影响造成干扰：硬失败意味着**别的窗口聊天能拦住我的主线**。
   * 保留它可见（check 的提醒行 + REPORT + 插件镜像），跑一次 `voices` 即可消掉。
   */
  if (vs.stale) warns.push(`[窗口传递层] ${voiceStaleWarning(vs)}`);
  else if (vs.missing && vs.latestLogMs) warns.push(`[窗口传递层] 还没有 ${WARDEN_DIR}/VOICE.jsonl —— 用户在窗口里说过的话没落盘，跑一下：node warden.mjs voices`);

  /**
   * ⑨ 原话认领闸（事故 I26）：**VOICE.jsonl（用户说过的）与 SPEC.md（我们在做的）之间原本没有任何连线。**
   *    一条原话要变得"会被做"，必须有人手工写进 SPEC 成 R#；没人写就只躺在 VOICE 里，
   *    而 check/report/map 三张表都不看它 ⇒ check 会 exit 0 报"13 条需求全部一致"，
   *    却查不出"从没进过清单"的要求 —— 这类缺口原来连计数都没有。
   *
   *    **水位线（别改成全量硬失败）**：146 条历史原话不可能一次认领完，全量硬失败会变成噪音、
   *    然后被无视。所以只对水位线**之后**新增的原话硬失败；水位线之前的只计数、只提示。
   */
  const cl = claimsStatus(root, dir);
  if (cl.bad.length) {
    fails.push(`[原话认领] ${WARDEN_DIR}/${CLAIMS_FILE} 有 ${cl.bad.length} 行读不懂（${cl.bad.slice(0, 3).map((b) => `第 ${b.n} 行：${b.why}`).join('；')}）—— 坏行会被当成"没认领"，已认领的数字就不可信了。`);
  }
  // 手写进 CLAIMS.jsonl 的"需求"类认领，也要核它在 SPEC 里真的存在（不能靠 add 的守卫，那绕得过去）
  const specIds = spec.map((s) => s.id);
  for (const c of cl.claims) {
    if (c.kind !== '需求') continue;
    if (!specIds.includes(String(c.ref))) {
      fails.push(`[原话认领] 认领 ${c.voice} 成了需求「${c.ref}」，但 SPEC.md 里没有这条 —— "认领成需求"的意思是它已经进了清单；进没进要能指到 R#，否则闸门被静音了、东西还是没进清单。`);
    }
  }
  if (cl.created) {
    warns.push(`${WATERMARK_SET_NOW}\n   （水位线 ${cl.since}；当前 ${cl.total} 条历史原话只计数、不追责。让原话"会被做"：node warden.mjs claims）`);
  }
  if (cl.after.length) {
    fails.push(`[原话认领] 水位线（${cl.since}）之后有 ${cl.after.length} 条用户原话**没有任何认领**：\n`
      + cl.after.slice(0, 10).map((v) => `     · ${voiceKey(v)}  ${oneLine(v.text, 40)}`).join('\n')
      + (cl.after.length > 10 ? `\n     …（还有 ${cl.after.length - 10} 条：node warden.mjs claims --all）` : '')
      + '\n   一条原话要"会被做"，必须有人认领它：需求 → 先写进 SPEC 成 R#，再 claims add --kind 需求 --ref R#；'
      + '闲聊/提问/情绪 → --kind 非要求 --why "依据"；已经答过的 → --kind 已答过 --ref "指回哪一句"。'
       + '\n   为什么这是硬失败（I26 实测）：用户说过的真正在栏目里滚动的模样在 VOICE 里逐字在册，'
      + '却从未进过 SPEC，而 check 一直 exit 0 报"需求全部一致"。');
  } else if (cl.unclaimed.length) {
    warns.push(`[原话认领] 水位线之前还有 ${cl.unclaimed.length} 条历史原话没认领（**只计数、不算失败**）—— ${claimsSummary(cl)}。水位线之后新增的才会硬失败。`);
  }
  if (cl.orphans.length) {
    warns.push(`[原话认领] 有 ${cl.orphans.length} 条认领现在指不到任何 VOICE 记录（例：${cl.orphans.slice(0, 3).map((c) => c.voice).join('、')}）—— 认领没作废，但它现在指不到原话了。`);
  }

  /**
   * ★ **把角色仪表接进 check 的提醒**（2026-09-17 新增）。
   *
   * 为什么（脑子A 第①条，原文）：「报警对象错位：唯一去向是用户 notice，而用户逐字把责任给了监督员
   *   （VOICE 198-199「监督员要保证几个角色是正确在运行」）；**没有任何路径把 rolesLine 交给监督员**。
   *   给不能改的人看，不给该改的角色看。」
   * ⇒ 这一行现在**同时也进 check**（`warns`，只计数不硬失败）：AI/监督员跑 check 时就看得见，
   *   而不是只在用户那一行飘过去。**不是替代 notice，是多给一条能改的人看得到的路。**
   * ⚠ 只计数、不硬失败：它是"呈现"，不是交付判据（旧版把它当判决，已被两个脑子证伪）。
   */
  try {
    const rolesLine = rolesHealthLine(path.join(root, WARDEN_DIR));
    if (rolesLine) warns.push(`[角色] ${rolesLine}`);
  } catch (e) { /* 仪表自己坏了不许影响 check */ }

  /**
   * ★ **容器守卫的逐条台账**（清单第 12 条第三句 / 母需求 R5）。
   *   为什么：这一句原来**完全没实现** —— 深度截断与 SKIP 名单都是静默丢弃、零输出，
   *   于是"守卫漏了谁"没人看得出来（实测：从 `<HOME>` 看，要保护的 2 个真项目 0 可见、
   *   46 个实验沙箱全可见，而 check 一个字都不说）。
   *   ⚠ **只加输出，不改拒绝逻辑**（方向员的建议）：按字面改 `.git` 判据会误杀真 worktree。
   */
  /**
   * ★ **R14 的强制面**（2026-09-17 新增；审查第二遍点名：「`check` 无任何『本轮跑没跑过』的校验 ⇒ 习惯面没过」）。
   *
   * 用户 R14 逐字：「（用户原话已隐去 —— 公开版不留逐字）」
   *   ⇒ 规矩：**报了 done 就必须有一次收尾对账**（`node warden.mjs results`）。
   *   判据：存在某轮 `status=done` 且轮号 **>** 最后一条 `kind=results` 记录的 `lastRound` ⇒ 硬失败。
   * ⚠ 只卡 `done`（"说做完了"那一刻）；`partial`/`in_progress` 不卡 —— 否则每轮都要跑，就成盖章机了。
   */
  try {
    const rp = path.join(root, WARDEN_DIR, RECON_FILE);
    if (fs.existsSync(rp)) {
      let lastResultsRound = -1;
      for (const line of fs.readFileSync(rp, 'utf8').split(/\r?\n/)) {
        const s = line.trim(); if (!s.startsWith('{')) continue;
        let o = null; try { o = JSON.parse(s) } catch { continue }
        if (o && o.kind === 'results') lastResultsRound = Math.max(lastResultsRound, Number(o.lastRound ?? 0));
      }
      const doneAfter = rds.filter((r) => String(r.status) === 'done' && Number(r.round ?? 0) > lastResultsRound);
      if (doneAfter.length) {
        const ids = [...new Set(doneAfter.map((r) => String(r.requirement ?? '')))].join('、');
        fails.push(`[R14 对账] 有 ${doneAfter.length} 轮报了 **done**（涉及 ${ids}），但**那之后没有任何一次收尾对账** ——`
           + ' 用户要求：结束时给结果清单并对账，从来没有实现过。'
          + ' 跑一次：`node warden.mjs results`（它会打出结果清单 + 对账行，并记进 RECON.jsonl）。'
          + '（只卡 done：partial/in_progress 不卡，否则就成了盖章机。）');
      }
    } else if (rds.some((r) => String(r.status) === 'done')) {
      fails.push('[R14 对账] 有 done 的轮次，但**从来没有跑过对账**（`.warden/RECON.jsonl` 不存在）——'
        + ' 用户要求：对账必须真正实现，不能只提醒。'
        + ' 跑一次：`node warden.mjs results`（它会打出结果清单 + 对账行，并记进 RECON.jsonl）。');
    }
  } catch (e) { warns.push(`[R14 对账] ⚠ 对账台账读不动（这一条不是"没问题"，是"没查成"）：${String(e.message).slice(0, 120)}`); }

  /**
    * ★★ **脑子也要能被看见**（用户反馈：脑子不见了，很久没看到它了）。
   *   机制没被删（BRAIN.jsonl / brain 命令 / feed 拼接都在）。真问题是两件事：
   *     ① 用子代理跑脑子却没落账 ⇒ 判决从没进过界面；
   *     ② **check 根本不看脑子台账** —— brainStatus() 能算出「★ 改过但未复审」，
   *        但没有任何地方调它 ⇒ "改了高风险产物却没重新派脑子"是隐形的。
   *   ⇒ 这里补第②条的接线：脑子的状态作为一行 `[脑子] …` 进 check 输出，
   *     插件会把它解析出来顶到**界面那一行**（与 `[角色]` 同一套机制）。
   *   ⚠ 只**提醒**、不硬失败：脑子是给"高风险产物"用的，不是每轮必跑；硬失败会把它变成盖章机。
   */
  try {
    const bs = brainStatus(path.join(root, WARDEN_DIR), root);
    const items = Array.isArray(bs.out) ? bs.out : [];
    const changed = items.filter((x) => String(x.state).includes('改过但未复审'));
    const conflicted = items.filter((x) => String(x.state).includes('冲突'));
    const single = items.filter((x) => x.state === '单审');
    if (changed.length || conflicted.length) {
      const all = changed.concat(conflicted).slice(0, 3);
      const head = all.map((x) => `${x.artifact}（${String(x.state)}）`).join('；');
      warns.push(`[脑子] ★ ${changed.length + conflicted.length} 个高风险产物**结论不成立**（改过未复审 ${changed.length} / 冲突未裁决 ${conflicted.length}）：`
        + head + (items.length > 3 ? `；…另有 ${items.length - 3} 个产物` : '')
        + '。要重新派脑子：`node warden.mjs brain brief --artifact <产物>`。');
    } else if (single.length) {
      // ⚠ 用户 2026-09-25 逐字：「（用户原话已隐去 —— 公开版不留逐字）」
      //   ⇒ 单审**不是默认**，而是按需：只在 conflict / shallow / explore 三种触发条件成立时才派。
      //   这一行不再是"你还差一个"的催促，而是"审过了，没问题"的确认。
      warns.push(`[脑子] ${single.map((x) => x.artifact).join('、')} 已审过（单审）。`
        + `只在 ${BRAIN_TRIGGER_IDS.join(' / ')} 三种触发条件成立时才加派第 2 个`
        + `（\`brain brief --artifact <产物> --trigger <哪一种>\`）。`);
    } else if (items.length) {
      warns.push(`[脑子] ${items.length} 个产物有复审记录、且审的就是当前版本。`);
    } else {
      // ★ 默认不审 —— 随手小改动不需要派脑子；只在冲突/不细致/需要探索时才派。
      //   不再把"没审"当成"需要处理的事"推到 AI 面前。
      warns.push('[脑子] 没有审查记录 —— 随手小改动不必审；'
        + `只在 ${BRAIN_TRIGGER_IDS.join(' / ')} 三种触发条件成立时才派脑子`
        + `（\`brain brief --artifact <产物> --trigger <哪一种>\`）。`);
    }
  } catch (e) {
    warns.push(`[脑子] ⚠ 脑子台账读不动（这一条不是"没问题"，是"没查成"）：${String(e.message).slice(0, 120)}`);
  }

  try {
    const audit = containerAudit(root);
    if (!audit.selfIsProject && (audit.projects.length || audit.ignored.length)) {
      // ⚠ 内层**不许用反引号**：`` `…`.git`…` `` 语法上是合法的 tagged template，
      //   但运行时抛异常，而这里的 try/catch 会把它**悄悄吞掉**（2026-09-17 实测踩到：
      //   加了半天台账却一个字都不出，正是本项目一直在防的"看不见的失败"）。
      const head = '[容器守卫] 这个目录自己**没有 .git**，但下面是容器：枚举到 '
        + String(audit.projects.length) + ' 个有 .git 的子目录；'
        + '另有 **' + String(audit.ignored.length) + ' 条被我忽略**（每条给理由 —— 这就是"我没看见谁"的台账）：';
      const shown = audit.ignored.slice(0, 8).map((x) => '\n     · ' + x.path + ' —— ' + x.reason).join('');
      const more = audit.ignored.length > 8 ? '\n     …（还有 ' + String(audit.ignored.length - 8) + ' 条：node warden.mjs guard）' : '';
      warns.push(head + shown + more);
    }
  } catch (e) {
    // ⚠ 不许静默：台账自己坏了要**说出来**（否则就是"没查到 ≠ 查了没问题"）。
    warns.push('[容器守卫] ⚠ 逐条台账自己坏了（这一条不是"没问题"，是"没查成"）：' + String((e && e.message) || e).slice(0, 160));
  }

  return { fails, warns, spec, devs, rounds: rds };
}

// ------------------------------------------------------------------ 报告
export function buildReport(root, { spec, devs, rounds }) {
  const dir = path.join(root, WARDEN_DIR);
  const { turns } = currentCost(root);
  const byTurn = new Map(turns.map((t) => [t.turn, t]));
  const lines = [];
  const active = devs.filter((d) => !d.decision || /待定|pending|-/.test(d.decision));
  lines.push('# 需求 → 交付 → 成本（这笔钱买到了什么）');
  lines.push('');
  lines.push(`生成时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push('');
  if (active.length) {
    lines.push('## ⚠ 未定夺的偏差（替代品在用户点头前都不算交付）');
    lines.push('');
    for (const d of active) {
      lines.push(`**${d.id}**`);
      lines.push('');
      lines.push('```');
      lines.push(`  你要的     ${d.asked || '（没写）'}`);
      lines.push(`  要给的是   ${d.delivering || '（没写）'}      ← ${d.delta || '差异没写'}`);
      lines.push(`  为什么改   ${d.why || '（没写）'}`);
      lines.push('```');
      lines.push('');
    }
  }
  lines.push('## 主表');
  lines.push('');
  lines.push('| 需求 | 你要的（逐字） | 实际给的 | 状态 | 子项覆盖 | 轮次 | 时间 | token | 这笔钱买到了什么 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  const grand = { rounds: 0, ms: 0, tokens: 0 };
  for (const s of spec) {
    const mine = rounds.filter((r) => r.requirement === s.id);
    let ms = 0; let tok = 0;
    for (const r of mine) {
      const t = byTurn.get(Number(r.round));
      if (t) { ms += t.wallMs ?? 0; tok += t.usage.total; }
    }
    grand.rounds += mine.length; grand.ms += ms; grand.tokens += tok;
    const status = mine.length ? mine[mine.length - 1].status : 'not_started';
    const delivered = mine.map((r) => r.delivered).filter(Boolean).join(' / ') || '—';
    const verdict = valueVerdict(status, mine, tok, s);
    // 子项覆盖（`2/3`）—— 这一列比任何叙述都直观：半个就是半个，没法糊过去
    const last = mine[mine.length - 1];
    const cov = Array.isArray(last?.covered) ? last.covered.map((x) => String(x).trim()) : [];
    const itemsCol = s.items?.length ? `${s.items.filter((it) => cov.includes(it)).length}/${s.items.length}` : '—';
    lines.push(`| ${s.id} | ${oneLine(s.quote, 40)} | ${oneLine(delivered, 40)} | ${zhStatus(status)} | ${itemsCol} | ${mine.length} | ${fmtDur(ms)} | ${fmtInt(tok)} | ${verdict} |`);
  }
  lines.push('');
  lines.push(`**合计**：${grand.rounds} 轮 · ${fmtDur(grand.ms)} · ${fmtInt(grand.tokens)} token`);

  /**
   * 原话认领行（事故 I26）—— **必须**在主表里出现。
   * 为什么：主表上面每一行都是"我们已经写进 SPEC 的需求"，它天然看不见
   * "用户说过、但从没进过清单"的那部分。这一行就是那个缺口的计数，
   * 下面再列前 5 条未认领的原话（截 40 字），让"被丢掉的"没法再隐形。
   */
  const cl = claimsStatus(root, dir);
  lines.push('');
  lines.push(`原话认领：${claimsSummary(cl)}　（${new Date().toLocaleString('zh-CN')}；水位线 ${cl.since || '（还没有）'}`
    + `${cl.after.length ? ` · **水位线之后新增未认领 ${cl.after.length} 条 → check 会失败**` : ''}）`);

  /**
   * 「查出来没做」行 —— 主表上面每行都是"在推进或已交付"的需求；
   * 这一行专门计数那些**登记了、最新一轮却还停在 not_started / partial / blocked** 的，
   * 让"发现了还堆着"没法再隐形（用户 2026-09-16 原话：查出来不解决反而添垃圾形成干扰）。
   */
  const staleAllList = staleRequirements(spec, rounds);
  const staleList = staleAllList.filter((x) => !x.parked);
  const parkedList = staleAllList.filter((x) => x.parked);
  lines.push('');
  lines.push(`查出来没做：**${staleList.length} 条**已登记但最新一轮仍未解决　（${new Date().toLocaleString('zh-CN')}）`
    + (staleList.length ? `\n- ${staleList.map((x) => `\`${x.id}\`(${x.status})`).join('、')}` : '')
    + (parkedList.length ? `\n（另有 \`${parkedList.length}\` 条标题写明"本轮不实现/属另一条实现线"，**不计入**：`
      + `${parkedList.map((x) => x.id).join('、')}）` : ''));

  /**
   * 发现台账行（R28/R29）—— 两个新角色（资料员 / 方向员）查到的东西。
   * 「还没落到做」= 没指到任何 R#；这一栏就是为了让"查了不做"没法隐形。
   */
  const fItems = readFindings(dir).items;
  const fNoRef = fItems.filter((x) => !String(x.ref ?? '').trim()).length;
  lines.push('');
  lines.push(`发现台账：共 **${fItems.length}** 条（资料员/方向员）· **还没落到做 ${fNoRef} 条**`
    + (fItems.length ? `\n- ${fItems.slice(-5).map((x) => `\`${x.by}\`(${x.ref || '未落地'})`).join('、')}` : '　（空）'));

  /**
   * 档位备份行（用户 2026-09-16：动关键数据前要自动备份，"随时复盘参考"）。
   * 职责已从「记录」转交「方向员」—— 记录只管记账，方向员负责"动手前先备份、收尾 diff 一遍"。
   */
  let snapInfo = { snaps: 0, drifted: [] };
  try {
    const pw = fs.existsSync(path.join(dir, 'params.yml')) ? parseParams(fs.readFileSync(path.join(dir, 'params.yml'), 'utf8')) : [];
    snapInfo = checkSnapshots(root, dir, pw);
  } catch (e) { /* 读不了就算了 */ }
  lines.push('');
  lines.push(`档位备份：**${snapInfo.snaps}** 份快照 · **动过没备份 ${snapInfo.drifted.length}** 个档位　`
    + `（归方向员；备份用 \`node warden.mjs snapshot --label "动之前"\`，复盘用 \`diff\`）`
    + (snapInfo.drifted.length ? `\n- ${snapInfo.drifted.map((x) => `\`${x.id}\` ${x.before}→${x.now}`).join('、')}` : ''));
  if (cl.unclaimed.length) {
    lines.push('');
    lines.push(`未认领的原话（前 5 条，共 ${cl.unclaimed.length} 条）：`);
    for (const v of cl.unclaimed.slice(0, 5)) {
      const after = cl.since && String(v.at ?? '') > cl.since ? '★水位线之后' : '';
      lines.push(`- \`${voiceKey(v)}\`（${v.at ? new Date(v.at).toLocaleString('zh-CN') : '?'}）${after}${oneLine(v.text, 40)}`);
    }
  }

  const covered = rounds.filter((r) => {
    if (!r.requirement) return false;
    if (spec.some((s) => s.id === r.requirement)) return false;
    // 挂在**架构支线**上的轮次不算"多给的" —— 用户给的是总目标，
    // 架构是 AI 提的，所以"推进支线"是正当事，不能报成浪费。
    const archPath = path.join(dir, 'ARCH.md');
    if (fs.existsSync(archPath)) {
      const arch = parseArch(readText(archPath));
      if (arch.branches.some((b) => b.id === r.requirement)) return false;
    }
    return true;
  });
  if (covered.length) {
    lines.push('');
    lines.push('## 多给的（没有哪条需求要它）');
    lines.push('');
    for (const r of covered) lines.push(`- 第 ${r.round} 轮：${r.delivered || r.why || '（没写）'}  （声明给了 ${r.requirement}，SPEC 里没这条）`);
  }
  // 规则册：**文本规则占比**是要盯的指标（占比越高 = 越依赖模型自觉 = 越不可靠）
  const rs = ruleStats(dir);
  lines.push('');
  lines.push(`规则册：${rs.total} 条（硬 ${rs.hard} / 文本 ${rs.text}，文本占比 ${rs.pct}%）${rs.folded ? `（另有已否决/已废止 ${rs.folded} 条，未计入）` : ''}`);
  return lines.join('\n') + '\n';
}

function oneLine(s, n) {
  const t = String(s ?? '').replace(/[\r\n|]/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : (t || '—');
}

function zhStatus(s) {
  return { not_started: '未开始', in_progress: '进行中', done: '已交付', partial: '**半交付**', blocked: '卡住', deviated: '**偏差**' }[s] ?? s;
}

function valueVerdict(status, mine, tok, spec) {
  if (!mine.length) return '还没动';
  if (status === 'deviated') return '⚠ 给的不是你要的';
  if (status === 'partial') return `半成品：${oneLine(mine[mine.length - 1].missing_half, 24)}`;
  if (status === 'done') return spec.must.length ? '按需求交付（见证据）' : '自称完成（无验收点）';
  return '还在做';
}

// ------------------------------------------------------------------ 成本
export function currentCost(root) {
  const sid = currentSessionId();
  const list = listSessions({ workspace: root });
  const target = sid ? list.find((s) => s.sessionId === sid) : list[list.length - 1];
  if (!target) return { turns: [], session: null, note: '找不到当前会话日志' };
  const { events } = decodeSession(target.file);
  const sum = summarize(events);
  return { turns: sum.turns, session: target.sessionId, total: sum.total };
}

/**
 * 值比较。**不能一律用 Number()** ——
 * `file_hash` 这类档位的值是十六进制字符串，Number("da45…") 是 NaN，
 * 而 `NaN !== NaN` 恒为真 → 会报"值变了"而其实一模一样（实测踩过，
 * 告警里两个值打印出来完全相同，一眼假）。
 */
export function sameValue(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return String(a) === String(b);
  const na = Number(a); const nb = Number(b);
  const aNum = typeof a === 'number' || (typeof a === 'string' && a.trim() !== '' && Number.isFinite(na));
  const bNum = typeof b === 'number' || (typeof b === 'string' && b.trim() !== '' && Number.isFinite(nb));
  if (aNum && bNum) return na === nb;
  return String(a) === String(b);
}

// ------------------------------------------------------------------ 窗口传递层（VOICE）
/** 会往磁盘写东西的工具名 */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'notebook_edit', 'str_replace_editor']);

/**
 * 一个会话有没有"写进磁盘记录"。
 * 用户的原话已隐去 —— 核心诉求：没写进磁盘记录的会话不需要归属进来。
 * —— 单独问 AI 一些不相干的事情的会话，不该混进这个子项目的窗口传递层。
 */
export function sessionWroteDisk(events) {
  for (const e of events) {
    if (e.type === 'tool/call') {
      const n = String(e.data?.name ?? '');
      if (WRITE_TOOLS.has(n)) return true;
      // pwsh / bash 里带重定向或写文件命令的也算
      if (n === 'pwsh' || n === 'bash' || n === 'shell') {
        const a = String(e.data?.arguments ?? '');
        if (/Out-File|Set-Content|Add-Content|>\s*[^|]|writeFileSync|Copy-Item|New-Item|mkdir|tee /.test(a)) return true;
      }
      if (n === 'present') return true;
    }
    if (e.type === 'deliverables/presented') return true;
  }
  return false;
}

/**
 * 第二层，也是**最重要**的一层：把用户在**每个窗口**说过的每一句话逐字落盘。
 *
 * 为什么必须有它：第一层（SPEC 的总目标/需求）是**汇总过的**，抽象本身就会丢掉信息。
 * 用户的原话丢进去很快被忽视，最后交付一个"四不像"。
 * 实测事故：用户 16:05 已经回答过"木材工艺链"是什么，16:17 又被问了一遍。
 *
 * 只收 `data.source.kind === "user"` 的真用户消息（注入的不算）；
 * 只收**写过磁盘**的会话（纯问答的窗口不归属进来 —— 用户明确要求过）。
 */
export function syncVoices(root, dir, { rebuild = false, session, allWindows = false, mergeAggregate = false } = {}) {
  /**
   * ★ R37「各自窗口先写入单独的」：给了 `session`（或默认本窗口）时，
   *   这次同步**只扫那一个窗口**，而且**写进它自己那本** `.warden/voices/<会话id>.jsonl`。
   *   汇总本 `.warden/VOICE.jsonl` 只在**显式扫全集**（`--all-windows`）时才当目标。
   *
   * 为什么必须分文件写（而不是"写同一个文件但只追加本窗口"）：
   *   ① `--rebuild` 会**先清空**目标文件 —— 若 scoped 也拿汇总本当目标，一次
   *      `voices --rebuild` 就把别的窗口的原话**全抹掉**（那是不可逆的事故）；
   *   ② 用户原话是「各自窗口先写入单独的」—— 分文件就是那句话的字面实现。
   */
  const want = allWindows ? null : (String(session ?? '').trim() || null);
  const dirNames = quoteDirNames(root);
  const p = want ? voiceFileFor(dir, want) : path.join(dir, 'VOICE.jsonl');
  const seen = new Set();
  if (!rebuild && fs.existsSync(p)) {
    for (const l of readText(p).split(/\r?\n/)) {
      if (!l.trim()) continue;
      try { const o = JSON.parse(l); seen.add(`${o.session}|${String(o.text).slice(0, 60)}`); } catch { /* 坏行 */ }
    }
  }
  // scoped 时也要并上汇总本里属于本窗口的旧行，否则第一次分账会把老原话当成"新增"再写一遍
  if (!rebuild && want && fs.existsSync(path.join(dir, 'VOICE.jsonl'))) {
    for (const l of readText(path.join(dir, 'VOICE.jsonl')).split(/\r?\n/)) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l);
        if (String(o.session ?? '') !== want) continue;
        seen.add(`${o.session}|${String(o.text).slice(0, 60)}`);
      } catch { /* 坏行 */ }
    }
  }
  const fresh = [];
  const skipped = { subagent: 0, noDisk: 0, otherWindow: 0 };
  const scanned = new Set();
  let sessionsSeen = 0;
  for (const s of listSessions({ dirName: dirNames })) {
    sessionsSeen += 1;
    /**
     * ★ 子代理会话**先判**（原来"窗口过滤"排在它前面 ⇒ scoped 时**子代理会话被当成"别的窗口"
     *   提前 skip**，`跳过：子代理会话 N 个` 就**永远是 0**，与同一行"共见到 M 个会话"自相矛盾）。
     *   ⚠ 仍然**只计数、不 continue** 到收消息那一步之外：收消息的规则一个字没动。
     */
    // ① 子代理会话：它第一条"用户消息"是**父代理派发的提示词**，不是用户说的话。
    //    判别：主会话 id 是 `session-<uuid>`，子代理会话是裸 `<uuid>`。
    if (!s.sessionId.startsWith('session-')) { skipped.subagent += 1; continue; }
    // ★ R37：默认只扫**本窗口**。别的窗口的原话不进这本账。
    //    两个计数器因此**互不重叠**：子代理只进 subagent，别的窗口只进 otherWindow。
    if (want && s.sessionId !== want) { skipped.otherWindow += 1; continue; }
    // ② 没写过磁盘的会话：用户说"没有进行记录的就不需要归属进来"（纯问答的窗口）
    const { events } = decodeSession(s.file);
    if (!sessionWroteDisk(events)) { skipped.noDisk += 1; continue; }
    let n = 0;
    for (const e of events) {
      if (e.type !== 'user/message' || e.data?.source?.kind !== 'user') continue;
      const text = (e.data.content ?? []).map((c) => c.text ?? '').join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      n += 1;
      const key = `${s.sessionId}|${text.slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // `kind` 是「监督员」发现的洞：VOICE 原来只有 session,seq,at,text,wrote，
      // **无法从 VOICE 自身区分"用户真说"与"别处复述"**。新记录补上 kind:"user"；
      // 老记录**一个字都不动**，读取时缺省当 user（见 voiceIsUser）。
      fresh.push({ session: s.sessionId, seq: n, at: e.time ? new Date(e.time).toISOString() : null, text, wrote: true, kind: 'user' });
    }
    if (n > 0) scanned.add(s.sessionId);   // 只有**真的有原话**的窗口才算"扫到了"（空窗口不算查过）
  }
  fresh.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const header = want
    ? `# 本窗口（${want}）的原话账：只有这个窗口的用户消息。逐字，按时间，只增不改。\n`
      + '# 总账本 / 别的窗口：.warden/LEDGER.jsonl 与 node warden.mjs voices --all-windows。\n'
    : '# 窗口传递层：用户在每个窗口说过的每一句话（逐字，按时间）。只增不改。\n'
      + '# ★ R37：这是**汇总本**。默认取数只看本窗口（.warden/voices/<会话id>.jsonl）；\n'
      + '#   要看这个汇总本必须显式：node warden.mjs voices --all-windows。\n'
      + '# 只收①主会话（不带 session- 前缀的是子代理会话，不算用户）②写过磁盘的会话（纯问答的窗口不归属进来）。\n';
  /**
   * ★★ **「要清成 0 条 ⇒ 拒收」** —— 实测的数据事故（原样）：
   *   BEFORE: winRows=27  aggRows=42
   *   --- 把本窗口的会话日志移走（模拟日志被归档 / 轮转 / 删）---
   *   $ node warden.mjs voices --rebuild
   *     新增 0 条，**累计 27 条** → …\.warden\voices\session-….jsonl   ← 打印的"累计 27 条"是**假**的
   *   EXIT=0    AFTER: winRows=0    ← 本窗口那本被清成只剩注释头；再跑普通 voices 也**不会自我修复**
   *
   * 病根两处，必须一起治：
   *   ① `--rebuild` 走的是**无条件** `writeFileSync` —— `fresh` 为空时它照样覆盖，把一本有 27 行的账清成 0 行；
   *   ② `total` 原来是"本窗口那本 ∪ 汇总本里属于本窗口的行"⇒ **盘上已经 0 条，它却报"累计 27 条"**。
   *
   * 判据（两条，缺一不可）：
   *   · **目标文件只在"新内容非空"或"目标不存在"时才许写**；要清成 0 条 ⇒ **拒收 + 非 0 退出**；
   *     "会话日志**不可用/被移走**"与"这个窗口**真的**没说过话"**不是一回事** ——
   *     扫到 0 条**区分不了**这两者时就**不替用户清账**。
   *   · **"累计 N 条"必须报盘上真实的条数**（`countRows(p)`），不许把汇总本里的行并进来充数。
   */
  const countRows = (f) => (fs.existsSync(f)
    ? readText(f).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).length
    : 0);
  const rowsBefore = countRows(p);
  if (rebuild && !fresh.length && rowsBefore > 0) {
    return {
      file: p, added: 0, total: rowsBefore, skipped, rebuild: true, rowsOnDisk: rowsBefore,
      scoped: !!want, session: want, mode: want ? (String(session ?? '').trim() ? 'session' : 'mine') : 'all',
      windowsScanned: scanned.size, sessionsSeen,
      refused: {
        kind: 'empty-rebuild',
        rowsBefore,
        why: `这次扫到 0 条原话，而目标文件 ${p} 里现在有 ${rowsBefore} 行 —— --rebuild 会把它**清空**`,
      },
    };
  }
  if (rebuild) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, header + fresh.map((v) => JSON.stringify(v)).join('\n') + (fresh.length ? '\n' : ''), 'utf8');
  }
  else if (fresh.length) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, (fs.existsSync(p) ? '' : header) + fresh.map((v) => JSON.stringify(v)).join('\n') + '\n', 'utf8'); }
  /**
   * ★「各自窗口先写入单独的」：本窗口那本**必须真的建出来，而且不能是个空壳**。
   * 若这次没有新增（原话早在汇总本里了）就不建文件 ⇒ 这本账永远是 0 条，
   * 读的人会以为"这个窗口一句话都没说过" —— 那又是"0 输入当没问题"。
   * 所以没有文件、**或盘上已经是 0 条**时，把本窗口在汇总本里的原话**落一份到它自己这本**。
   * ⚠ 后半个条件让**已经被清空过的账能自我修复**（原来只认"文件不存在"，所以永远是 0）。
   * ⚠ 只在 `mine` 非空时写正文，否则就造出一个"0 条的空壳"（那正是上面那口井）。
   */
  if (want && countRows(p) === 0) {
    const mine = loadVoices(dir, { session: want });
    if (mine.length) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, header + mine.map((v) => JSON.stringify(v)).join('\n') + '\n', 'utf8');
    } else if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, header, 'utf8');
    }
  }
  /**
   * ★★ **汇总本必须跟着更新** —— 硬伤 A / 硬伤 B 的产品侧修法。
   *
   * 事故原样（判定性实验）：
   *   [3] 按新默认只跑 scoped voices  → 本窗口账 rows=1，**汇总本 rows=2（没变）**
   *   [4] 现在 check 该不该报"水位线之后有 1 条未认领"？→ check exit=1 但只说
   *       「水位线之前还有 2 条历史原话没认领（只计数、不算失败）」—— **那条新原话它看不见，硬失败不响**；
   *   [5] 只有 `voices --all-windows` 之后才响。
   *   [B] check 的提醒「还没有 .warden/VOICE.jsonl —— …跑一下：node warden.mjs voices」
   *       ⇒ 照它给的那条命令跑一次，**提醒还在**（scoped 不写汇总本）——
   *       违反它自己引用的「**可修复的才配当提醒**」。
   *
   * 根因：`check` 的原话认领闸读的是**汇总本**，而 scoped `voices` 只写各窗口那本
   *   ⇒ **正常流下闸门静默失效**，还把"水位线之前的历史"当成全部报出来 ——
   *   这正是本项目最忌的「**0 输入当没问题**」。
   *
   * ⚠ **判定逻辑一个字没动**：`check` 的判据仍然是"水位线之后有未认领 ⇒ 硬失败"。
   *   这里改的是**取数 / 落盘** —— 让汇总本真的有那条原话。
   * ⚠ **绝不 rebuild 汇总本**：只 `append` + 按 `session|text` 去重。这正是原来
   *   "scoped 不许写汇总本"那条理由①的正解（怕 `--rebuild` 把别的窗口的原话一次抹掉）：
   *   **只增不改就永远抹不掉**。理由②（「各自窗口先写入单独的」）仍然成立 ——
   *   本窗口那本**先写**，而用户同一句话里也说了「**但也有一个总账本**」，汇总本就是那个总账本。
   *
   * 谁传这个开关：**只有 `voices` 命令**。`ask` 走同一套 `syncVoices`，但它按设计
   *   **不写汇总本**（L42 ⑦ 钉着这条）⇒ 默认 false，不许顺手打开。
   */
  let aggregate = null;
  if (want && mergeAggregate) {
    const aggPath = path.join(dir, 'VOICE.jsonl');
    const aggHeader = '# 窗口传递层：用户在每个窗口说过的每一句话（逐字，按时间）。只增不改。\n'
      + '# ★ R37：这是**汇总本**。默认取数只看本窗口（.warden/voices/<会话id>.jsonl）；\n'
      + '#   要看这个汇总本必须显式：node warden.mjs voices --all-windows。\n'
      + '# 只收①主会话（不带 session- 前缀的是子代理会话，不算用户）②写过磁盘的会话（纯问答的窗口不归属进来）。\n';
    const keyOf = (v) => `${v.session}|${String(v.text).slice(0, 60)}`;
    const have = new Set();
    if (fs.existsSync(aggPath)) {
      for (const l of readText(aggPath).split(/\r?\n/)) {
        if (!l.trim() || l.startsWith('#')) continue;
        try { have.add(keyOf(JSON.parse(l))); } catch { /* 坏行：不动它，也不因它拒写 */ }
      }
    }
    /**
     * 并进去的是本窗口**全部**在册原话（本窗口那本 ∪ 汇总本里属于它的行），不只是这次新增的 ——
     * 这样"汇总本被删过 / 曾经落后"的旧账也能被**一次普通 voices** 修回来。
     */
    const mineAll = loadVoices(dir, { session: want });
    const add = mineAll.filter((v) => !have.has(keyOf(v)));
    try {
      if (add.length) {
        fs.mkdirSync(path.dirname(aggPath), { recursive: true });
        fs.appendFileSync(aggPath,
          (fs.existsSync(aggPath) ? '' : aggHeader) + add.map((v) => JSON.stringify(v)).join('\n') + '\n', 'utf8');
      }
      // ⚠ 本窗口一条原话都没有、汇总本也不存在时**不建空壳**（那正是"0 输入当没问题"）。
      aggregate = { file: aggPath, added: add.length, rows: countRows(aggPath), exists: fs.existsSync(aggPath) };
    } catch (e) {
      aggregate = { file: aggPath, added: 0, rows: countRows(aggPath), exists: fs.existsSync(aggPath), error: String(e.message) };
    }
  }
  /** ★「累计 N 条」= **盘上真实的条数**（不能用"∪ 汇总本里属于本窗口的行"：那是假数） */
  const total = countRows(p);
  // 水位线：记下"这次同步时原始日志最新到哪一秒"。
  // 为什么必须有它：VOICE 里最新一条的 `at` 是**用户说话的时间**，不是同步的时间 ——
  // 只拿它跟 .zstd 的 mtime 比，会得出"同步过也还是落后"的假警报（跑完 voices 也消不掉）。
  const after = listSessions({ dirName: dirNames });
  const latestLogMtime = after.reduce((m, s) => (s.mtimeMs > m ? s.mtimeMs : m), 0);
  /**
   * ★ R37：分账之后**水位线也分账**（「可修复的才配当提醒」）。
   *   只有一条全局水位线时：scoped 同步只覆盖一个窗口 —— 若还去写全局那条，
   *   等于拿"我只同步了一个窗口"去证明"汇总本已经同步到位"（**假证据**）；
   *   若不写，`voices` 又永远消不掉那个提醒（**修不好的假警报**）。
   *   ⇒ 各窗口写各自的 `voices/<会话id>.sync.json`，全局那条只在扫全集时才动。
   */
  const winLatestMtime = (() => {
    let mx = 0;
    for (const s of after) if (!want || s.sessionId === want) { if (s.mtimeMs > mx) mx = s.mtimeMs; }
    return mx;
  })();
  const myLogMtime = want ? winLatestMtime : latestLogMtime;
  if (!want) {
    try {
      fs.writeFileSync(path.join(dir, VOICE_SYNC_FILE),
        JSON.stringify({ at: new Date().toISOString(), latestLogMtime, total, added: fresh.length }, null, 2), 'utf8');
    } catch { /* 水位线是辅助信息，写不下不该影响同步本身 */ }
  } else {
    try {
      fs.mkdirSync(path.join(dir, 'voices'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'voices', `${want}.sync.json`),
        JSON.stringify({ at: new Date().toISOString(), session: want, latestLogMtime: winLatestMtime, total, added: fresh.length }, null, 2), 'utf8');
    } catch { /* 同上 */ }
  }
  return {
    file: p, added: fresh.length, total, rowsOnDisk: total, skipped, rebuild, latestLogMtime: myLogMtime,
    scoped: !!want, session: want, mode: want ? (String(session ?? '').trim() ? 'session' : 'mine') : 'all',
    // 「扫了几个窗口」—— 输出里必须明写这个数（R37）
    windowsScanned: scanned.size, sessionsSeen,
    // 硬伤 A/B：这次把本窗口的原话并进汇总本了吗（`null` = 这次没走合并那条路）
    aggregate,
  };
}

const VOICE_SYNC_FILE = 'VOICE.sync.json';
const VOICE_STALE_GRACE_MS = 10 * 60 * 1000;

/**
 * VOICE 快照是不是**落后于原始日志**了 —— 权威层的自我体检（设计文档 L10）。
 *
 * 实测事故：ARCH 的一句 R13 原话在原始会话日志第 4287 行**有**，而 `VOICE.jsonl` 里**查无**
 * （VOICE 只同步到 seq 19）。重跑 `voices` 后 133 → 143 条，那句才补上。
 * **工具的权威层自己会过期** —— 所以这里把它体检出来，而不是等它去冤枉用户。
 *
 * 判据（便宜，不解压 zstd）：`VOICE.jsonl` 最新一条的时间 / 上次同步的水位线
 * vs 相关会话目录里 `.zstd` 的 mtime。落后超过 grace（默认 10 分钟）→ stale。
 * 水位线的意义：**跑过 `voices` 就能消掉这个警报**（否则它是个永远修不好的假警报）。
 *
 * `missing`：`VOICE.jsonl` 压根没建过 —— 那是"这层还没用起来"，不是"过期了"，两者分开报。
 */
export function voiceStaleness(root, dir, { graceMs = VOICE_STALE_GRACE_MS } = {}) {
  const voicePath = path.join(dir, 'VOICE.jsonl');
  const sessions = listSessions({ dirName: quoteDirNames(root) });
  const latestLogMs = sessions.reduce((m, s) => (s.mtimeMs > m ? s.mtimeMs : m), 0);
  const voices = loadVoices(dir);
  const latestVoiceMs = voices.reduce((m, v) => {
    const t = Date.parse(v.at ?? '');
    return Number.isFinite(t) && t > m ? t : m;
  }, 0);
  let sync = null;
  try { sync = JSON.parse(readText(path.join(dir, VOICE_SYNC_FILE))); } catch { sync = null; }
  const watermarkMs = Number(sync?.latestLogMtime ?? 0) || 0;
  /**
   * ★ R37：分账之后，"同步到哪了"要**按窗口各算** —— 否则 scoped 同步永远消不掉这个警报
   *   （判据是「**可修复的才配当提醒**」）。
   *
   * 一个窗口的 baseline = max(
   *   ① 全局水位线 `VOICE.sync.json` —— 扫全集那次**确实**覆盖了每个窗口；
   *   ② 它自己的水位线 `.warden/voices/<会话id>.sync.json` —— scoped 同步只覆盖它自己；
   *   ③ 它在册原话里最新一条的 `at`）
   * 它落后 = **它自己的**会话日志 mtime 比 baseline 还新（超过 grace）。
   * 任何一个窗口落后 ⇒ 整体报 stale（`worstWindow` 指出是哪个）。
   * 没有任何窗口信息时（还没分过账）退回老口径，行为与以前一致。
   */
  const perWindowLog = new Map();
  for (const s of sessions) {
    const cur = perWindowLog.get(s.sessionId) ?? 0;
    if (s.mtimeMs > cur) perWindowLog.set(s.sessionId, s.mtimeMs);
  }
  const perWindowMark = new Map();
  try {
    for (const f of fs.readdirSync(path.join(dir, 'voices'))) {
      if (!f.endsWith('.sync.json')) continue;
      try {
        const o = JSON.parse(readText(path.join(dir, 'voices', f)));
        const sid = String(o?.session ?? f.slice(0, -'.sync.json'.length));
        perWindowMark.set(sid, Number(o?.latestLogMtime ?? 0) || 0);
      } catch { /* 坏水位线 = 没有水位线 */ }
    }
  } catch { /* 还没有 voices/ 目录 = 一个窗口都还没分过账 */ }
  const perWindowVoiceAt = new Map();
  for (const v of voices) {
    const sid = String(v.session ?? '');
    if (!sid) continue;
    const t = Date.parse(v.at ?? '');
    if (Number.isFinite(t)) perWindowVoiceAt.set(sid, Math.max(perWindowVoiceAt.get(sid) ?? 0, t));
  }
  let behindMs = latestLogMs - Math.max(latestVoiceMs, watermarkMs);   // 没有窗口信息时的老口径
  let worstWindow = null;
  let windowBehindMs = -Infinity;
  for (const sid of new Set([...perWindowLog.keys(), ...perWindowVoiceAt.keys()])) {
    const logMs = perWindowLog.get(sid);
    if (!logMs) continue;   // 只在册原话、原始日志已经不在的窗口：没法比，不瞎判
    const b = logMs - Math.max(watermarkMs, perWindowMark.get(sid) ?? 0, perWindowVoiceAt.get(sid) ?? 0);
    if (b > windowBehindMs) { windowBehindMs = b; worstWindow = sid; }
  }
  if (Number.isFinite(windowBehindMs)) behindMs = windowBehindMs;
  const missing = !fs.existsSync(voicePath);
  return {
    missing, stale: !missing && latestLogMs > 0 && behindMs > graceMs,
    latestVoiceMs, latestLogMs, watermarkMs, behindMs, graceMs, worstWindow,
    count: voices.length, sessions: sessions.length,
  };
}

export const fmtWall = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN') : '（没有）');

/** check / quotes 共用的那句警告（措辞固定，机器好 grep） */
export function voiceStaleWarning(st) {
  return `⚠ VOICE 快照落后于原始日志（VOICE 最新 ${fmtWall(st.latestVoiceMs)} / 会话日志最新 ${fmtWall(st.latestLogMs)}，差 ${fmtDur(st.behindMs)}）—— 归属核查不可信，先跑：node warden.mjs voices`;
}

/**
 * 读窗口传递层。
 * · **不给 `session`**（老行为，不动）：读汇总本 `.warden/VOICE.jsonl` —— `check` 的 VOICE 体检、
 *   `roles`、`brief` 的"其它窗口"都走这条，改它会把完好的功能改坏。
 * · **给了 `session`**（R37）：只读**本窗口那一本** —— 先读窗口自己的 `.warden/voices/<id>.jsonl`，
 *   再并上汇总本里属于本窗口的行（旧数据还没分账时，这一步保证"立刻就能只扫本窗口"），
 *   最后按 `session#seq` 去重。别的窗口的行**一条都不进来**。
 *   ⚠ 这一步就是硬伤 A 里说的「**汇总本 ∪ 各窗口本**」的并集口径 —— 少了它，
 *     "汇总本里那条本窗口的原话"会被 scoped 视图当成不存在。
 */
export function loadVoices(dir, { session } = {}) {
  const want = String(session ?? '').trim();
  const read1 = (p) => {
    if (!fs.existsSync(p)) return [];
    const out = [];
    for (const l of readText(p).split(/\r?\n/)) {
      if (!l.trim() || l.startsWith('#')) continue;
      try { out.push(JSON.parse(l)); } catch { /* 坏行 */ }
    }
    return out;
  };
  const p = path.join(dir, 'VOICE.jsonl');
  if (!want) return read1(p);
  const rows = [...read1(voiceFileFor(dir, want)), ...read1(p).filter((v) => String(v?.session ?? '') === want)];
  const seen = new Set();
  return rows.filter((v) => {
    const k = voiceKey(v);
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

// ------------------------------------------------------------------ 原话认领（事故 I26：VOICE ↔ SPEC 之间那条**不存在的连线**）
/**
 * 病根（I26 实测）：`VOICE.jsonl`（用户说过的，逐字在册）与 `SPEC.md`（我们在做的，R#）
 * **没有任何连线**。一条原话要变得"会被做"，必须有人**手工**写进 SPEC 成 R#；没人写就只躺在
 * VOICE 里，而 `check`/`report`/`map` **三张表都不看它** ——
 * 于是 `check` 会 exit 0 报"13 条需求全部一致"，却查不出"从没进过清单"的要求。
 * 这类缺口原来**连计数都没有**。
 *
 * 活病例：用户提过角色说话要像网游聊天区的显示风格（角色名更小更细灰色、`某某某：XXX`）
 * +「**真正在栏目里滚动的模样**」，而 SPEC/MAP/ARCH/REPORT/DEVIATIONS/ROUNDS 里
 * `滚动|栏目|聊天区|角色名|字号|字体` **命中 0**。
 *
 * 补法：`.warden/CLAIMS.jsonl`（append-only）逐条认领 VOICE 里的原话。
 */
const CLAIMS_FILE = 'CLAIMS.jsonl';
const CLAIMS_WATERMARK_FILE = 'CLAIMS.watermark.json';

// ------------------------------------------------- 发现台账（R28 / R29，2026-09-16）
// 用户要一个"查资料"的角色 + 一个"工程更多方向"的角色，并且明确说：
//   「用户的痛点你们其实能查到，已经有过几次了，但查出来是一回事，
//     查出来完全不去解决反而更添垃圾用法在里面形成干扰。」
// 所以"发现"不是写段总结就完事 —— 它必须①署名（哪个角色）②资料员报事实必须给**出处**
// ③**指到某条 R#**（= 真的接进"做"的清单）；指不到的只能按 AI 提案计数，
// 并且会被 check 数进"还没落到做"，被插件推到用户面前。
const FINDINGS_FILE = 'FINDINGS.jsonl';
/** 派活台账（2026-09-17 新增）：谁被派了什么活、依据哪条 R# —— 补的是"责任"那一侧 */
const DUTY_FILE = 'DUTY.jsonl';
/** 对账台账（2026-09-17 新增）：开工清单 / 收尾对账各一条 —— 让 R14 的"习惯"变成可校验的 */
const RECON_FILE = 'RECON.jsonl';

/**
 * ★ **R19 的计数逻辑**（从会话事件里数：主代理自己写了几个文件 / 派了几次单）。
 *
 * 为什么抽成导出的纯函数：**判据必须能被用例直接测**，不许只活在 CLI 的打印里
 *   （本项目的老毛病：代码里"看着有"，一跑就发现是死的）。用例见 `L32_delegation.mjs`。
 *
 * ⚠ 它是**代理**判据：派单 ≠ 派得好；主代理少量自己写也可能完全正确。
 *   所以它只报**事实与数**，只在一件极端事上表态：**有写、却一次单都没派**。
 */
export function delegationStats(events) {
  const WRITE_TOOLS = new Set(['write', 'edit']);
  const byPath = new Map();
  let writes = 0;
  const dispatches = [];
  for (const e of events ?? []) {
    if (!e || e.type !== 'tool/call') continue;
    const name = String(e.data?.name ?? '');
    if (WRITE_TOOLS.has(name)) {
      writes += 1;
      try {
        const a = JSON.parse(String(e.data?.arguments ?? '{}'));
        const p = String(a.file_path ?? a.path ?? '');
        if (p) byPath.set(p, (byPath.get(p) ?? 0) + 1);
      } catch (e2) { /* 参数解不开就只计数 */ }
    } else if (/^subagent/.test(name)) {
      let label = name;
      try {
        const a = JSON.parse(String(e.data?.arguments ?? '{}'));
        if (a.description) label = name + ' · ' + String(a.description).slice(0, 40);
      } catch (e2) { /* 只记名字 */ }
      dispatches.push(label);
    }
  }
  const files = [...byPath.entries()].map(([path, n]) => ({ path, n })).sort((a, b) => b.n - a.n);
  return {
    writes, files, dispatches,
    /** 用户要求：不要所有代码都由主代理一个人顺序写 —— 这一条极端情形才是硬判定 */
    soloWriter: writes > 0 && dispatches.length === 0,
  };
}
/**
 * 谁可以往发现台账里署名。**监督员也算一个** —— 它要能记下"这条复核后不成立"
 * （实测：方向员报 P0 时说「R17、R27 的 SPEC 标题就写着本轮不实现」，实读只有 R17 写了；
 *   结论方向没错，但幅度被说过头了 —— 这种事必须落到台账上，不然"派了要验"就只是句话）。
 *
 * ⚠ 从 `ROLE_REGISTRY` 派生（`finding: true`）—— **别再在这里手写名单**：
 *   手写名单和投票名单就是两套口径，实测漏过一次（新角色不在投票名单 ⇒ 意见可被静默忽略）。
 */
const FINDING_ROLES = ROLE_REGISTRY.filter((r) => r.finding).map((r) => r.id);

/**
 * "干活角色"的角色卡（用户 2026-09-16 要的：一个负责查询资料、一个负责工程更多方向）。
 * 为什么要做成数据 + `role brief` 命令：光写在文档里 = 靠人记得去派；
 * 派一次要手写一整套任务书 = 累，于是就不会派。给个命令，派发变成一条命令行的事。
 *
 * ⚠ 同样从 `ROLE_REGISTRY` 派生（写了 `duty` 的 = 有任务书）。
 */
const WORK_ROLES = ROLE_REGISTRY.filter((r) => r.duty)
  .map((r) => ({ id: r.id, stamp: r.stamp, duty: r.duty, when: r.when, hard: r.hard, how: r.how }));


export function readFindings(dir) {
  const p = path.join(dir, FINDINGS_FILE);
  if (!fs.existsSync(p)) return { items: [], bad: [] };
  const items = []; const bad = [];
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s || s.startsWith('#')) continue;
    try {
      const o = JSON.parse(s);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('不是对象');
      items.push(o);
    } catch { bad.push({ n: i + 1, raw: oneLine(s, 60) }); }
  }
  return { items, bad };
}

/** 台账的硬规则（check 用）。返回 { fails, warns, items, noRef, sourced }。 */
export function checkFindings(dir, specIds) {
  const fails = []; const warns = [];
  const f = readFindings(dir);
  for (const b of f.bad) fails.push(`[发现] ${FINDINGS_FILE} 第 ${b.n} 行读不懂：${b.raw}`);
  const voicesForPtr = loadVoices(dir);
  const badPtrs = [];
  let noRef = 0; let sourced = 0;
  for (const x of f.items) {
    const by = String(x.by ?? '').trim();
    const text = String(x.text ?? '').trim();
    const source = String(x.source ?? '').trim();
    const ref = String(x.ref ?? '').trim();
    const kind = String(x.kind ?? '').trim() || (ref ? '事实' : '提案');
    if (!text) { fails.push('[发现] 有一条发现是空的（text 必填）。'); continue; }
    if (!by) { fails.push(`[发现] 有一条没署名（by）—— 是资料员查的还是方向员提的，必须说清：${oneLine(text, 40)}`); continue; }
    if (!FINDING_ROLES.includes(by)) { fails.push(`[发现] by「${by}」不在角色表里（只能是 ${FINDING_ROLES.join(' / ')}）—— 角色得先真的存在。`); continue; }
    if (kind === '事实' && (by === '资料员' || by === '监督员') && !source) {
      fails.push(`[发现] ${by}的这条**没给出处**（--source）—— 查资料/下判断都不许靠猜：${oneLine(text, 40)}`);
    }
    if (source) sourced++;
    if (ref) {
      if (!specIds.includes(ref)) fails.push(`[发现] 指到了 ${ref}，但 SPEC.md 里没有这条 —— 发现要落到"做"上，不许指空。`);
    } else noRef++;
    // 指针要解析得到（规则 R23 / 事故 I34）：历史条目只提醒，新条目在 find add 当场被拒
    for (const c of `${text} ${source}`.matchAll(/session-[0-9a-z-]+#\d+/gi)) {
      if (!findVoiceByRef(voicesForPtr, c[0])) badPtrs.push(c[0]);
    }
  }
  if (badPtrs.length) {
    warns.push(`[发现] 有 ${badPtrs.length} 处引用的原话指针**解析不到**（${[...new Set(badPtrs)].slice(0, 3).join('、')}）`
      + ' —— 指针要对得上，否则"引用了某句话"是空的（规则 R23 / 事故 I34）。历史条目只提醒；新条目 `find add` 当场拒收。');
  }
  if (noRef) {
    warns.push(`[发现] 有 ${noRef} 条发现**还没落到做**（没有 --ref，按 AI 提案算）—— 光查出来不接进清单，`
      + '就是用户说的"添垃圾形成干扰"。（共 ' + String(f.items.length) + ' 条发现，其中有出处 ' + String(sourced) + ' 条）');
  }
  return { fails, warns, items: f.items, noRef, sourced };
}

/** 写一条发现（CLI 用）。硬规则在这里也拦一道，别等 check。 */
export function addFinding(dir, rec, specIds) {
  const by = String(rec.by ?? '').trim();
  const text = String(rec.text ?? '').trim();
  const source = String(rec.source ?? '').trim();
  const ref = String(rec.ref ?? '').trim();
  const kind = String(rec.kind ?? '').trim() || (ref ? '事实' : '提案');
  if (!FINDING_ROLES.includes(by)) return { ok: false, code: 2, why: `--by 只能是 ${FINDING_ROLES.join(' / ')}（现在传的是「${by || '空'}」）—— 发现必须署名，不然没人认领。` };
  /**
   * 指针闸（规则 R23 的可机检部分 / 事故 I34）。
   * 正文或出处里出现的 `session-xxxx#N` 必须**真的解析得到** —— 否则"引用了某句话"是空的。
   * 我差点据前缀误判别人的正确指针，所以这条闸拦的是**指错**，不是"引了没用"。
   */
  const cited = [...`${text} ${source}`.matchAll(/session-[0-9a-z-]+#\d+/gi)].map((m) => m[0]);
  if (cited.length) {
    const bad = cited.filter((c) => !findVoiceByRef(loadVoices(dir), c));
    if (bad.length) {
      return { ok: false, code: 2, why: `引用的原话指针解析不到：${bad.join('、')} —— 指针要对得上。先跑 node warden.mjs voices 同步；或者改成你真正查过的那一条。` };
    }
  }
  if (kind === '事实' && (by === '资料员' || by === '监督员') && !source) {
    return { ok: false, code: 2, why: `${by}报「事实」必须给 --source（出处）—— 查不到就标 --kind 提案，不许编。` };
  }
  if (!text) return { ok: false, code: 2, why: '--text 必填（发现了什么，一句话）。' };
  if (!['事实', '提案'].includes(kind)) return { ok: false, code: 2, why: '--kind 只能是 事实 / 提案。' };
  if (kind === '事实' && by === '资料员' && !source) {
    return { ok: false, code: 2, why: '资料员报「事实」必须给 --source（出处）—— 查资料不许靠猜。查不到就标 --kind 提案。' };
  }
  if (ref && !specIds.includes(ref)) {
    return { ok: false, code: 2, why: `--ref ${ref} 在 SPEC.md 里没有这条 —— 发现要落到"做"上，就得指一条真需求（或先把它锁成 R#）。` };
  }
  const record = { at: new Date().toISOString(), by, kind, text, source, ref, why: String(rec.why ?? '').trim() };
  /**
   * ★ **补上 session**（2026-09-17）：实测发现台账 **0/65 条**带会话号，而票与发言是 100% 带 ——
   *   于是"这条发现是哪个会话产出的"**根本无从判断**，跨窗口隔离也就做不到发现那一层。
   *   只对**新写入**的生效（append-only，老条目不追溯改写）。
   */
  const sid = currentSessionId();
  if (sid) record.session = sid;
  fs.appendFileSync(path.join(dir, FINDINGS_FILE), JSON.stringify(record) + '\n', 'utf8');
  return { ok: true, record };
}

/**
 * ==================== 派活台账（DUTY.jsonl）· 2026-09-17 新增 ====================
 *
 * **为什么要有它**（两个「脑子」独立审完、结论一致，都点名这是根）：
  *   用户要的是各司其职的呈现。而"某角色没产出"这件事有**两种完全不同的原因**：
 *     (a) 派了活、它没干；  (b) 本来就没活给它干。
 *   旧账本**只有产出侧**（ROUNDS 里没有 role/branch/duty，三本账实测命中数全 0）
 *   ⇒ 这两种在数据上**根本分不开** ⇒ 仪表只能瞎猜，于是恒真、假阳性、停产时沉默全来了。
 *   脑子B 的原话：「它测的是**记账习惯**，不是劳动。」
 *
 * **本台账补的就是"责任"那一侧**：谁、在什么时候、被派了什么活、依据哪条 R#。
 *   有了它，判据才能变成 **责任 ∧ 无产出**（=「派了活没干」），而不是"你最近没产出"。
 *
 * 硬规则（脚本拦，不靠自觉）：
 *   · `--role` 必须在册，且**不能是"结构上没有产出渠道"的席位**（那类席位不干活，派了也白派）；
 *   · `--what` 要有实质内容（≥6 个非空白字符）—— 只写"查一下"不算派活；
 *   · `--ref` 必须指到 SPEC 里真有的 R#（派活不能无凭据）。
 */
export function addDuty(dir, rec, specIds) {
  const role = String(rec.role ?? '').trim();
  const what = String(rec.what ?? '').trim();
  const ref = String(rec.ref ?? '').trim();
  const why = String(rec.why ?? '').trim();
  if (!ALL_ROLE_IDS.includes(role)) {
    return { ok: false, code: 2, why: `--role 必须在册，现在传的是「${role || '空'}」。在册的是：${ALL_ROLE_IDS.join(' / ')}` };
  }
  if (!VOTE_ROLES.includes(role) && !FINDING_ROLES.includes(role)) {
    return { ok: false, code: 2, why: `「${role}」是**结构上没有产出渠道**的席位（vote:false 且无 finding 渠道）—— 派给它也产不出东西，所以不许派活（这是设计事实，不是它偷懒）。` };
  }
  if (what.replace(/\s+/g, '').length < 6) {
    return { ok: false, code: 2, why: '--what 要有实质内容（≥6 个非空白字符）—— 只写"查一下"不算派活，那样记下来也分不清"派了没干"。' };
  }
  if (!/^R\d+$/.test(ref) || !specIds.includes(ref)) {
    return { ok: false, code: 2, why: `--ref 必须指到 SPEC.md 里真有的需求号（形如 R13）。现在传的是「${ref || '空'}」；SPEC 现在有的是：${specIds.join('、') || '（一条都没有）'}` };
  }
  const record = { at: new Date().toISOString(), role, what, ref, why, session: currentSessionId() ?? '' };
  fs.appendFileSync(path.join(dir, DUTY_FILE), JSON.stringify(record) + '\n', 'utf8');
  return { ok: true, record };
}

/** 读派活台账（坏行不静默吞：记进 bad 供 check 报出来） */
export function readDuties(dir) {
  const p = path.join(dir, DUTY_FILE);
  if (!fs.existsSync(p)) return { items: [], bad: [] };
  const items = []; const bad = [];
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const s = lines[i].trim();
    if (!s || s.startsWith('#')) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && o.role) items.push(o); else bad.push(i + 1);
    } catch { bad.push(i + 1); }
  }
  return { items, bad };
}
/** kind 只能这四种 —— 认领不是"打勾"，要说清这条原话变成了什么 */
export const CLAIM_KINDS = ['需求', '非要求', '已答过', '撤回'];
/** 水位线自动落位时打的那句（措辞固定，机器好 grep） */
export const WATERMARK_SET_NOW = '⚠ 已把水位线设在现在 —— 从现在起，新的用户原话必须被认领，否则 check 会失败';

/** `"<session-id>#20"` → {prefix, seq}；不合法返回 null */
export function parseVoiceRef(ref) {
  const m = /^(\S.*?)#(\d+)$/.exec(String(ref ?? '').trim());
  if (!m) return null;
  return { prefix: m[1].trim(), seq: Number(m[2]) };
}

/** 一条 VOICE 记录的身份：`<session>#<seq>` */
export const voiceKey = (v) => `${v?.session}#${v?.seq}`;

/**
 * VOICE 记录的 kind：老记录没有这个字段（**不动老记录**），读取时缺省当 user。
 * 为什么必须有：VOICE 自身原来分不出"用户真说"与"别处复述"。
 */
export const voiceIsUser = (v) => (v?.kind ?? 'user') === 'user';

/** 按 `session-xxxx#N` 找 VOICE 记录：session 允许**前缀匹配**（VOICE 里存的是全 uuid） */
export function findVoiceByRef(voices, ref) {
  const p = parseVoiceRef(ref);
  if (!p) return null;
  return voices.find((v) => voiceKey(v) === `${p.prefix}#${p.seq}`)
    ?? voices.find((v) => String(v.session ?? '').startsWith(p.prefix) && Number(v.seq) === p.seq)
    ?? null;
}

/**
 * 读 CLAIMS.jsonl：合法行与**坏行**分开返回。
 * 坏行不许静默吞掉 —— 吞掉会让"已认领"多算，而多算正是这个闸要防的假通过。
 */
export function readClaimLines(dir) {
  const p = path.join(dir, CLAIMS_FILE);
  const claims = []; const bad = [];
  if (!fs.existsSync(p)) return { claims, bad };
  readText(p).split(/\r?\n/).forEach((l, i) => {
    const s = l.trim();
    if (!s || s.startsWith('#')) return;
    let o;
    try { o = JSON.parse(s); } catch { bad.push({ n: i + 1, why: '不是合法 JSON' }); return; }
    if (!o || typeof o !== 'object') { bad.push({ n: i + 1, why: '不是一个 JSON 对象' }); return; }
    if (!CLAIM_KINDS.includes(String(o.kind))) { bad.push({ n: i + 1, why: `kind「${o.kind}」不认识（只能是 ${CLAIM_KINDS.join(' / ')}）` }); return; }
    if (!parseVoiceRef(o.voice)) { bad.push({ n: i + 1, why: `voice「${o.voice}」不是 <session前缀>#<seq> 的形式` }); return; }
    claims.push(o);
  });
  return { claims, bad };
}

/** 水位线 `{"since":"…"}`；没有 / 读不懂 → null */
export function readClaimsWatermark(dir) {
  const p = path.join(dir, CLAIMS_WATERMARK_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    const o = JSON.parse(readText(p));
    return o && typeof o.since === 'string' && o.since ? o : null;
  } catch { return null; }
}

function writeClaimsWatermark(dir, since, extra = {}) {
  const p = path.join(dir, CLAIMS_WATERMARK_FILE);
  fs.writeFileSync(p, JSON.stringify({ since, at: new Date().toISOString(), ...extra }, null, 2), 'utf8');
  return p;
}

/**
 * 原话认领的全貌：共几条 / 已认领几条 / 未认领几条 / **水位线之后**还有几条没认领。
 *
 * **为什么要有水位线**（关键设计，别改成全量硬失败）：
 * 146 条历史原话不可能一次认领完，**全量硬失败会变成噪音、然后被无视**。
 * 所以只对**水位线之后**新增的原话要求认领：
 *   水位线之后有未认领 → 硬失败（"不用记得也会响"的那部分）；
 *   水位线之前的未认领  → 只计数、只提示。
 * 第一次运行（没有水位线文件）时自动把水位线设成"当前 VOICE 最新一条" ——
 * 这样历史的 143 条不会立刻把 check 弄红，但**从此不再漏新的**。
 */
/**
 * ★ R37：`session` 给了就**只算本窗口那本账**（`loadVoices(dir,{session})` 的并集口径）；
 *   不给就是全集 —— `check` / `report` / `brief` 走的仍是这条，**判定一个字没改**。
 *
 * ⚠ **全局水位线只在扫全集时才设**（`createWatermark` 由调用方按窗口口径决定）：
 *   scoped 一次只覆盖一个窗口，拿它去设那条**全局**水位线是**假证据**，而且两头都会出事 ——
 *   推后 ⇒ 别的窗口新说的原话被静默放过；提前 ⇒ 一大堆历史原话突然变成"水位线之后"让 check 硬失败。
 */
export function claimsStatus(root, dir, { createWatermark = true, session } = {}) {
  const want = String(session ?? '').trim();
  const voices = loadVoices(dir, want ? { session: want } : {}).filter(voiceIsUser);
  const { claims, bad } = readClaimLines(dir);
  const claimedKeys = new Set();
  const orphans = [];
  for (const c of claims) {
    const v = findVoiceByRef(voices, c.voice);
    if (!v) { orphans.push(c); continue; }
    claimedKeys.add(voiceKey(v));
  }
  const unclaimed = voices
    .filter((v) => !claimedKeys.has(voiceKey(v)))
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  let watermark = readClaimsWatermark(dir);
  let created = false;
  if (!watermark && createWatermark && voices.length) {
    const since = voices.reduce((m, v) => (String(v.at ?? '') > m ? String(v.at) : m), '');
    try {
      writeClaimsWatermark(dir, since, { auto: true, total: voices.length });
      watermark = { since, at: new Date().toISOString(), auto: true };
      created = true;
    } catch { watermark = null; }
  }
  const since = watermark?.since ?? '';
  // 水位线之后的判据：ISO 时间字符串直接比大小（VOICE 的 at 都是 toISOString）
  const after = since ? unclaimed.filter((v) => String(v.at ?? '') > since) : unclaimed.slice();
  return {
    total: voices.length, claimedCount: voices.length - unclaimed.length,
    unclaimed, after, since, watermark, created, claims, bad, orphans,
    /** 「这次取数来自 N 个窗口」—— 只报条数不报窗口数，读者没法判断口径（R37） */
    windows: new Set(voices.map((v) => String(v.session ?? ''))).size,
    scoped: !!want, session: want || null,
  };
}

/** 认领现状的一句话（check / report / claims 三处共用同一口径，免得数字打架） */
export function claimsSummary(cl) {
  return `已认领 ${cl.claimedCount} / 共 ${cl.total} · **未认领 ${cl.unclaimed.length}**`;
}

/**
 * 认领一条原话（append-only）。
 * 硬拒（exit 2）：kind 非法 / voice 格式不对 / voice 在 VOICE.jsonl 里找不到 /
 * 需求类认领的 ref 不是 R# 或那个 R# 还没进 SPEC（否则就是"认领成了需求，但 SPEC 里没有它"——
 * 那是 I26 换了个马甲：闸门被静音了，东西还是没进清单）。
 */
export function addClaim(dir, { voice, kind, ref, why, by, specIds } = {}) {
  const k = String(kind ?? '');
  if (!CLAIM_KINDS.includes(k)) {
    return { ok: false, code: 2, why: `--kind 只能是 ${CLAIM_KINDS.join(' / ')}，你给的是「${k}」` };
  }
  if (!parseVoiceRef(voice)) {
    return { ok: false, code: 2, why: `--voice 要写成 <session前缀>#<seq>（例：<session-id>#20），你给的是「${voice ?? ''}」` };
  }
  const v = findVoiceByRef(loadVoices(dir), voice);
  if (!v) {
    return { ok: false, code: 2, why: `--voice「${voice}」在 ${WARDEN_DIR}/VOICE.jsonl 里找不到 —— 先跑 node warden.mjs voices 同步，别认领一条不存在的原话` };
  }
  const r = String(ref ?? '').trim();
  if (k === '需求') {
    if (!/^R\d+$/.test(r)) return { ok: false, code: 2, why: `kind=需求 时 --ref 必须写 SPEC 里的需求号（形如 R13），你给的是「${r}」` };
    const ids = specIds ?? [];
    if (ids.length && !ids.includes(r)) {
      return { ok: false, code: 2, why: `SPEC.md 里没有 ${r} —— 「认领成需求」的意思是**它已经进了清单**。先把这条原话锁定成 SPEC 的一条 R#，再来认领（否则闸门被静音了，东西还是没进清单）。现在有的是：${ids.join('、')}` };
    }
  } else if (k === '已答过' && !r) {
    return { ok: false, code: 2, why: 'kind=已答过 时 --ref 要写清"指回哪一句"（哪条原话/哪个文件），不能空着' };
  } else if (k === '非要求' && !String(why ?? '').trim()) {
    return { ok: false, code: 2, why: 'kind=非要求 时 --why 必须写依据（凭什么说它是闲聊/提问/情绪），不能空着' };
  }
  const rec = {
    // **一律存完整键**（规则 R23 的可机检部分）。为什么：短前缀认领会造成"两套口径"——
    // 方向员实测有 3 条短前缀认领，在"按 key 查表"的地方被误报成"没归宿"。
    // 入口归一化比事后处处兼容可靠。历史里的短前缀键读取时仍由 findVoiceByRef 兜住。
    voice: voiceKey(v), kind: k, ref: r,
    why: String(why ?? '').trim(),
    at: new Date().toISOString(),
    by: String(by ?? currentSessionId() ?? ''),
  };
  fs.appendFileSync(path.join(dir, CLAIMS_FILE), JSON.stringify(rec) + '\n', 'utf8');
  return { ok: true, record: rec, voice: v };
}

/**
 * 关键词检索用户原话（空格分隔的英文词用 AND；中文靠下面的候选排序）。
 * ★ R37：`session` 给了就**只在本窗口那本账里查** —— 原来拿几十个窗口混在一起的汇总本查，
 *   于是"隔壁窗口说过什么"会被当成"用户已经答过"（污染的正源之一）。
 */
export function searchVoices(dir, kw, { session } = {}) {
  const words = String(kw ?? '').split(/[\s,，、]+/).filter(Boolean);
  if (!words.length) return [];
  return loadVoices(dir, session ? { session } : {}).filter((v) => words.every((w) => v.text.includes(w)));
}

/**
 * 中文问句找"可能已经答过"的候选。
 *
 * 为什么不能只用关键词：中文没空格，而且**用户的答案里往往根本没有问句里的词**。
 * 实测：问"木材工艺链是有意放着还是被漏掉了"，用户答的是
 * 「木材工艺链是我的一个比喻…不是要去掉，反而是要加强」—— 字面只有"木材工艺链"五字重合。
 * 所以这里改成：**按最长公共子串 + n-gram 重合度排序，把候选捞出来**，
 * 判断"是不是真答过"交给"脑子"那一层（脚本判不准，这点必须诚实）。
 */
export function rankVoices(dir, question, top = 5, { session } = {}) {
  const q = squash(question);
  if (q.length < 4) return [];
  const grams = new Set();
  for (let n = 3; n <= 5; n += 1) for (let i = 0; i + n <= q.length; i += 1) grams.add(q.slice(i, i + n));
  return loadVoices(dir, session ? { session } : {})
    .map((v) => {
      const t = squash(v.text);
      let hit = 0;
      for (const g of grams) if (t.includes(g)) hit += 1;
      return { ...v, score: hit, lcs: lcsSubstrLen(q, t), cov: grams.size ? hit / grams.size : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => (b.lcs - a.lcs) || (b.score - a.score))
    .slice(0, top);
}

/** 在工程文档里找"这个问题能不能自己查出来"的线索 */
function findInDocs(root, kw, limit = 5) {
  const words = String(kw ?? '').split(/[\s,，、？?]+/).filter((w) => w.length >= 2);
  if (!words.length) return [];
  const out = [];
  const walk = (d, depth) => {
    if (depth > 2 || out.length >= limit) return;
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (out.length >= limit) return;
      if (e.isDirectory()) { if (!['node_modules', '.git', '.godot', 'target', '.warden', 'shots', 'refs'].includes(e.name)) walk(path.join(d, e.name), depth + 1); continue; }
      if (!/\.(md|txt|gd|rs|json|yml)$/.test(e.name)) continue;
      const p = path.join(d, e.name);
      let t = '';
      try { t = readText(p); } catch { continue; }
      if (words.some((w) => t.includes(w))) out.push(path.relative(root, p));
    }
  };
  walk(root, 0);
  return out;
}

// ------------------------------------------------------------------ 快照 / 对比
function snapshotsDir(dir) { return path.join(dir, 'snapshots'); }

/**
 * 把 params.yml 里点名的**源文件**整个拷一份 + 记指纹。
 * 为什么不只是记哈希：用户要的是"出问题能拉出来比较"—— 得留着内容，不只是指纹。
 */
export function takeSnapshot(root, dir, label) {
  const ws = parseParams(fs.readFileSync(path.join(dir, 'params.yml'), 'utf8'));
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = String(label ?? 'snapshot').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40);
  const snapDir = path.join(snapshotsDir(dir), `${ts}-${safe}`);
  const filesDir = path.join(snapDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const values = {}; const files = [];
  for (const w of ws) {
    const r = readWatch(root, w);
    if (r.ok) values[w.id] = r.value;
    if (!w.file) continue;
    const src = path.join(root, w.file);
    if (!fs.existsSync(src) || files.some((f) => f.path === w.file)) continue;
    const bytes = fs.readFileSync(src);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const text = bytes.toString('utf8');
    fs.writeFileSync(path.join(filesDir, w.file.replace(/[\\/]/g, '__')), bytes);
    files.push({ path: w.file, sha, bytes: bytes.length, funcs: listFuncs(text), text: undefined, copy: w.file.replace(/[\\/]/g, '__') });
  }
  const manifest = { label: String(label ?? ''), at: new Date().toISOString(), session: currentSessionId(), values, files };
  fs.writeFileSync(path.join(snapDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { snapDir, manifest };
}

export function listSnapshots(dir) {
  const d = snapshotsDir(dir);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => fs.existsSync(path.join(d, n, 'manifest.json'))).sort();
}

/**
 * 「要改一件**已经确认完成**的东西」闸（用户 2026-09-16 提出；
 *   核心要求：要改已确认完成的东西时，需要备份，再交给资料员和方向员来规划）。
 *
 * 判定：这条需求**上一轮是 done**、而这次要写的 status 不是 done ⇒ 就是在改已确认完成的东西。
 * 那时三道**硬失败**（同 `rule reopen --force --why` 的精神：已定稿的东西不许悄悄动）：
 *   ① `--why` 说清为什么要改
 *   ② 在那轮 done **之后**有过一次 snapshot（备份）—— 没有就先跑 snapshot
 *   ③ 交出规划：`--plan "…"`，或发现台账里有一条指到本 R# 且晚于那轮 done 的记录（资料员/方向员写的）
 */
export function reopenGate(root, dir, reqId, newStatus, why, plan) {
  const rounds = readRounds(dir).filter((r) => String(r.requirement ?? '') === String(reqId));
  rounds.sort((a, b) => Number(a.round ?? 0) - Number(b.round ?? 0));
  const last = rounds[rounds.length - 1];
  if (!last || String(last.status) !== 'done') return { ok: true };
  if (String(newStatus) === 'done') return { ok: true };
  const doneAt = Date.parse(String(last.at ?? '')) || 0;
  if (!String(why ?? '').trim()) {
    return { ok: false, code: 2, why: `${reqId} 上一轮（第 ${last.round} 轮）是 **done**，你现在要改它 —— 必须写 --why 说清为什么改一件已经确认完成的事。` };
  }
  const snaps = listSnapshots(dir);
  let snapName = ''; let snapAt = 0;
  for (const s of snaps) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(snapshotsDir(dir), s, 'manifest.json'), 'utf8'));
      const t = Date.parse(String(m.at ?? '')) || 0;
      if (t > snapAt) { snapAt = t; snapName = s; }
    } catch (e) { /* 坏快照跳过 */ }
  }
  if (!snapName || snapAt <= doneAt) {
    return {
      ok: false, code: 2,
      why: `${reqId} 上一轮（第 ${last.round} 轮，${String(last.at ?? '')}）是 **done**，你要改它，但**那之后没有备份过**。\n`
        + `   先跑：node warden.mjs snapshot --label "改 ${reqId} 之前"\n`
        + '   （用户定的：改已经确认完成的东西之前必须先备份 —— 出问题能拉出当时那份精确数据复盘）',
    };
  }
  const planTxt = String(plan ?? '').trim();
  // **两个角色都要交**（用户要求：两个角色都交规划——
  // 是"和"，不是"或"）。原来只要**任一条**发现就能过，实测一个角色交差就放行了（2026-09-16 抓到）。
  const byRole = new Set();
  try {
    for (const x of readFindings(dir).items) {
      if (String(x.ref ?? '') !== String(reqId)) continue;
      if ((Date.parse(String(x.at ?? '')) || 0) <= doneAt) continue;
      byRole.add(String(x.by ?? '').trim());
    }
  } catch (e) { /* 台账读不了就当没有 */ }
  const have = new Set(byRole);
  // --plan 这条是**文本级**的（不检查内容），所以只认「资料员：说了点什么」这种写法 ——
  // 光把两个角色名念一遍（"资料员 方向员"）不算规划。机检那条路是台账，这条只是方便入口。
  //
  // ⚠ 2026-09-17 实测修的一处：原来是 `${r}\s*[:：]\s*\S{6,}` —— 它要求冒号后**紧跟着**非空白字符，
  //   于是最自然的写法「资料员： 查了…」（冒号后打一个空格）被判成"没规划"、整条 record 被拒收。
  //   `\s*` 只吃掉了"冒号前"的空白，冒号后那一个空格把 `\S` 卡死了。
  //   实测反例（正控）：`--plan "资料员： 查了 warden.mjs 的 reopenGate，结论是最小长度 6 够用"` → 拒收。
  //   现在改成：冒号后允许空白，但**这一段的实质内容要有 6 个以上非空白字符**
  //   （判据不变：只念名字、或冒号后什么都没写，依然过不了）。
  for (const r of ['资料员', '方向员']) {
    // 用**字符串切分**而不是拼正则：临时拼正则时 `${r === '资料员' ? '(方向员|$)' : '$'}` 这种
    //   模板串里带括号/美元号，一改就容易拼出非法正则（本轮就这么炸过一次，SyntaxError at 1858）。
    //   判据本身很简单：找到「角色名 + 冒号」，取到**下一个角色名**（或串尾）为止，数非空白字符。
    let body = '';
    const at = planTxt.indexOf(r);
    if (at >= 0) {
      const after = planTxt.slice(at + r.length);
      const colon = after.search(/[:：]/);
      if (colon >= 0) {
        let seg = after.slice(colon + 1);
        for (const other of ['资料员', '方向员']) {
          if (other === r) continue;
          const cut = seg.indexOf(other);
          if (cut >= 0) seg = seg.slice(0, cut);
        }
        body = seg;
      }
    }
    if (body.replace(/\s+/g, '').length >= 6) have.add(r);
  }
  const lack = ['资料员', '方向员'].filter((r) => !have.has(r));
  if (lack.length) {
    return {
      ok: false, code: 2,
      why: `备份有了（\`${snapName}\`），但**规划还差 ${lack.join(' + ')}** —— 用户要的是两个角色都过一遍：\n`
        + '   ① 在 record 里直接写规划：--plan "资料员：… 方向员：…"\n'
        + '   ② 让他们各写一条（进发现台账、可机检）：\n'
        + `        node warden.mjs find add --by 资料员 --text "要改什么、依据是什么" --source "出处" --ref ${reqId}\n`
        + `        node warden.mjs find add --by 方向员 --text "改了会影响什么、还有哪些方向" --why "指回哪条原话" --ref ${reqId}`,
    };
  }
  return { ok: true, note: `改已确认完成的东西：备份在 \`${snapName}\`；规划来自 ${planTxt ? '--plan' : '发现台账'}（资料员 + 方向员都在）` };
}

/**
 * 「档位动过但没备份」闸（用户 2026-09-16 提出；
 *   核心要求：要改动关键数据时，自动备份一份当前项目的精确数据，防止后续改动不如意时可复盘参考）。
 *
 * 用户要的第 3 件事就是花一天调好的手感被后续功能改坏、找不回来—— `snapshot` 早就能做，
 * 但它**挂在"记录"那一栏、而且没人被要求去跑**，所以本项目一份快照都没有（实测）。
 * 现在：**这一步归「方向员」**（多方位思考 + 提醒），check 负责把"动过却没备份"当场点出来。
 *
 * 判定：拿 params.yml 里盯着的每个档位，比当前值与**最近一次快照**里记的值；不同 = drifted。
 */
export function checkSnapshots(root, dir, watches) {
  const warns = []; const fails = [];
  const ws = watches ?? [];
  const snaps = listSnapshots(dir);
  if (!ws.length) return { warns, fails, snaps: snaps.length, drifted: [] };
  if (!snaps.length) {
    warns.push(`[档位未备份] params.yml 里盯着 ${ws.length} 个档位，但**一份快照都没有** —— `
      + '万一后面改坏了，没有"当时那份精确数据"可复盘。先跑：node warden.mjs snapshot --label "动之前"');
    return { warns, fails, snaps: 0, drifted: [] };
  }
  const last = snaps[snaps.length - 1];
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(snapshotsDir(dir), last, 'manifest.json'), 'utf8')) } catch (e) { /* 读不了就当没记 */ }
  const drifted = [];
  if (manifest && manifest.values) {
    for (const w of ws) {
      const r = readWatch(root, w);
      if (!r.ok) continue;
      const before = manifest.values[w.id];
      if (before === undefined) continue;
      if (String(before) !== String(r.value)) drifted.push({ id: w.id, label: w.label || w.id, before, now: r.value });
    }
  }
  if (drifted.length) {
    // ★★ 2026-09-17 改成硬失败：看见了却不拦 = 没拦（原来只 warn，exit 仍是 0）
    fails.push(`[档位未备份] 有 ${drifted.length} 个被盯的档位，从最近一次快照（\`${last}\`）之后**动过却没有新快照**：`
      + drifted.map((x) => `${x.id} ${x.before}→${x.now}`).join('、')
      + '\n   这正是用户最怕的第 3 件事（"花了一天调好的手感被改坏、还找不回来"）。'
      + '\n   这一步现在归**方向员**：动手前先 `snapshot`，收尾 `diff` 一遍看"哪个函数没了 / 哪个值变了"。');
  }
  return { warns, fails, snaps: snaps.length, drifted };
}

function lineDiff(aText, bText) {
  const a = aText.split(/\r?\n/); const b = bText.split(/\r?\n/);
  const n = a.length; const m = b.length;
  if (n * m > 4_000_000) return ['（文件太大，跳过逐行比较；快照里存了原文，可用 git diff --no-index 看）'];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = []; let i = 0; let j = 0; let shown = 0;
  const push = (s) => { if (shown < 60) { out.push(s); shown += 1; } else if (shown === 60) { out.push('  …（还有更多，只列前 60 行）'); shown += 1; } };
  while (i < n && j < m) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (dp[i + 1][j] >= dp[i][j + 1]) { push(`  - 老 ${i + 1}: ${a[i]}`); i += 1; } else { push(`  + 新 ${j + 1}: ${b[j]}`); j += 1; }
  }
  while (i < n) { push(`  - 老 ${i + 1}: ${a[i]}`); i += 1; }
  while (j < m) { push(`  + 新 ${j + 1}: ${b[j]}`); j += 1; }
  return out.length ? out : ['  （内容相同）'];
}

export function diffAgainst(root, dir, which) {
  const names = listSnapshots(dir);
  if (!names.length) return { ok: false, msg: '还没有任何快照。先跑：node warden.mjs snapshot --label "动之前"' };
  const pick = which ? [...names].reverse().find((n) => n.includes(which)) : names[names.length - 1];
  if (!pick) return { ok: false, msg: `找不到匹配「${which}」的快照。现有：${names.join(' / ')}` };
  const snapDir = path.join(snapshotsDir(dir), pick);
  const manifest = JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8'));
  // 「0 个文件 → 报'没有改动'」是同一类假通过：它其实是"我啥也没比"。
  if (!(manifest.files ?? []).length) {
    return {
      ok: false,
      msg: `这个基线里**一个文件都没有**（${manifest.files ? '0 个' : '没记'}）—— 那是 params.yml 的 watches 是空的。\n`
        + '  所以"和基线一模一样、没有改动"这句话**现在没有依据**：它比的是零个文件。\n'
        + '  先把要盯的源文件写进 .warden/params.yml 的 watches，再跑：node warden.mjs snapshot --label "动之前"',
    };
  }
  const lines = [];
  lines.push(`对比基线：${pick}`);
  lines.push(`           ${manifest.label || '（没写标签）'} · ${new Date(manifest.at).toLocaleString('zh-CN')}`);
  lines.push('');

  let changed = 0;
  for (const f of manifest.files) {
    const cur = path.join(root, f.path);
    if (!fs.existsSync(cur)) { lines.push(`★ 文件没了：${f.path}`); changed += 1; continue; }
    const bytes = fs.readFileSync(cur);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    if (sha === f.sha) continue;
    changed += 1;
    const nowFuncs = listFuncs(bytes.toString('utf8'));
    const gone = f.funcs.filter((x) => !nowFuncs.includes(x));
    const added = nowFuncs.filter((x) => !f.funcs.includes(x));
    lines.push(`★ 改了：${f.path}   (${f.sha} → ${sha})`);
    if (gone.length) lines.push(`   ⚠ 函数没了（调用方会炸）：${gone.join(', ')}`);
    if (added.length) lines.push(`   + 新函数：${added.join(', ')}`);
    const oldCopy = path.join(snapDir, 'files', f.copy);
    if (fs.existsSync(oldCopy)) {
      lines.push(...lineDiff(fs.readFileSync(oldCopy, 'utf8'), bytes.toString('utf8')));
    }
    lines.push('');
  }

  const nowValues = {};
  for (const w of parseParams(fs.readFileSync(path.join(dir, 'params.yml'), 'utf8'))) {
    const r = readWatch(root, w);
    if (r.ok) nowValues[w.id] = r.value;
  }
  const vChanged = [];
  for (const [k, v] of Object.entries(manifest.values ?? {})) {
    if (nowValues[k] !== undefined && String(nowValues[k]) !== String(v)) vChanged.push(`   ${k}: ${v} → ${nowValues[k]}`);
  }
  if (vChanged.length) { lines.push('★ 档位值变了：'); lines.push(...vChanged); lines.push(''); }

  if (!changed && !vChanged.length) lines.push('（和这个基线一模一样，没有改动）');
  return { ok: true, msg: lines.join('\n'), snap: pick };
}

// ------------------------------------------------------------------ 归属核查
// 「把某句话归给用户」这种写法——查它到底是不是用户说的。
// 真实事故：kernel/shape2.gd 用「因为用户的原话就是：…」给一整套设计当理由，
// 而那句话在全部会话日志里一个字都查不到（跨 3 行注释写的，按行匹配抓不到，
// 所以这里按"归属词所在行 + 后几行"拼成一段再抽引文）。
//
// **精度比召回重要**：`用户明确指定的 substeps` 这种是形容词用法，不是引文。
// 第一版把这类也算成"查无实据"，46 条里大半是误判 —— 检查器一吵就没人看了。
// 所以现在要求两条之一才认：① 有「」『』“” 包起来的引文；② 归属词后紧跟冒号（原话就是：）。
const ATTR_STRONG = /(用户原话|用户的原话|原话就是|原话是|原话为|用户说|用户说过|您说|您说过|按您的口径|按用户的口径)/;
const ATTR_COLON = /(用户明确|用户要求|用户点名|用户提出|用户希望|您点名|您提到|您要求)\s*[:：]/;
const QUOTE_SPAN_RE = /[「『“"]([^」』”"]{6,})[」』”"]/;
// 显式引文槽位：`（原话：X）` —— 作者明说了哪段是原话，别再按行去猜（见 extractAttributedQuote）
const EXPLICIT_QUOTE_RE = /[（(]\s*(?:用户)?(?:的)?原话\s*[:：]\s*([^）)]{4,}?)\s*[）)]/;
const SCAN_EXT = ['.md', '.gd', '.tscn', '.txt'];
const SCAN_SKIP = ['.godot', '.git', 'node_modules', '.warden', 'shots'];

// 引文必须像人话：至少 6 个汉字，且不能是代码
const CJK_RE = /[\u4e00-\u9fa5]/g;
const looksLikeProse = (s) => {
  const cjk = (s.match(CJK_RE) ?? []).length;
  if (cjk < 6) return false;
  if (/[=(){}\[\];]|^\s*(func|var|const|if|for|return)\b/.test(s)) return false;
  return true;
};

function stripDecor(line) {
  return line.replace(/^\s*(#+|\/\/+|\*+|>+|\|\s*)/, '').replace(/\s+$/, '');
}

/** 从一段文本里抽出被归属给用户的引文（只认真正的引文，不认形容词用法） */
export function extractAttributedQuote(blob, matchIndex) {
  const tail = blob.slice(matchIndex);
  /**
   * ① **显式槽位最优先**：`（原话：X）` / `(原话：X)` / `（用户原话：X）`。
   * 为什么：行内常常先写一段自己的总结、再在括号里给出逐字原话，例如
   *   自然语言直接操作当前功能：用户说精细一点，它晓得是当前使用的功能精细一点儿…（原话：用户说精细一点…）（<session-id>） 关键词: 精细一点
   * 走"归属词+冒号取整行"会把**整行（含总结）**吞成引文 → 括号里那句真的原话反被判"查无实据"。
   * 实测事故（2026-09-16，ARCH.md:145）：`quotes` 因此报了一处查无实据。
   * 有了显式槽位，就不该再猜这行的边界 —— 作者已经明说了哪段是原话。
   */
  const slot = EXPLICIT_QUOTE_RE.exec(tail) ?? EXPLICIT_QUOTE_RE.exec(blob);
  if (slot) {
    const q = slot[1].replace(/^[\s「『“"]+/, '').replace(/[\s，,、；;：:」』”"]+$/, '').trim();
    if (q) return q;
  }
  const span = QUOTE_SPAN_RE.exec(tail);
  if (span && span.index <= 120) return span[1].trim();
  // 没有引号 → 只认"归属词 + 冒号"这种明确的引文引入
  const head = blob.slice(Math.max(0, matchIndex - 4), matchIndex + 40);
  if (!/[:：]/.test(head)) return '';
  const after = tail.replace(/^[^:：]{0,40}[:：]/, '').replace(/^[\s「『“"]+/, '');
  let cut = after
    .split(/[。！？\n]/)[0]
    .split(/关键词\s*[:：]/)[0]                    // 别把 `关键词: xxx` 吞进引文
    .split(/[（(]?\s*session-[0-9a-f]{4,}/i)[0];  // 别把 `（session-xxxx）` 吞进引文
  // 归属词写在括号里时（…（用户原话：xxx）…），引文到右括号为止 —— 但只在括号不配对时才砍，
  // 免得误伤引文里合法出现的括号（例：「漫游(R)模式」）。
  const openN = (cut.match(/[（(]/g) ?? []).length;
  const closeN = (cut.match(/[）)]/g) ?? []).length;
  if (closeN > openN) {
    const li = Math.max(cut.lastIndexOf('）'), cut.lastIndexOf(')'));
    if (li >= 0) cut = cut.slice(0, li);
  }
  return cut.replace(/[，,、；;：:\s]+$/, '').replace(/[」』”"]+$/, '').trim();
}

/** 归属核查要扫哪些文件（用户点名了就用点名的，没点名就按扩展名走一遍工程） */
export function quoteTargets(root, files) {
  const targets = [];
  if (files && files.length) {
    for (const f of files) targets.push(path.isAbsolute(f) ? f : path.join(root, f));
    return targets;
  }
  const walk = (d) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SCAN_SKIP.includes(e.name)) walk(p); continue; }
      if (SCAN_EXT.some((x) => e.name.endsWith(x))) targets.push(p);
    }
  };
  walk(root);
  return targets;
}

export function scanAttributions(root, { files } = {}) {
  const targets = quoteTargets(root, files);
  const findings = [];
  for (const p of targets) {
    let lines;
    try { lines = readText(p).split(/\r?\n/); } catch { continue; }
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      let phrase = null;
      const a = ATTR_STRONG.exec(raw);
      if (a) phrase = a[0];
      else {
        const b = ATTR_COLON.exec(raw);
        if (b) phrase = b[1];
      }
      if (!phrase) continue;
      // 归属词所在行 + 后 4 行，拼成一段再抽引文（引文常常写在下一行）
      const blob = [raw, ...lines.slice(i + 1, i + 5)].map(stripDecor).join('\n');
      const quote = extractAttributedQuote(blob, Math.max(0, blob.indexOf(phrase)));
      if (!quote || !looksLikeProse(quote)) continue;
      findings.push({ file: path.relative(root, p), line: i + 1, phrase, quote });
    }
  }
  return findings;
}

/** 归一化：去空白 + 去 markdown 强调 + （可选）去标点 */
const deMark = (s) => String(s ?? '').replace(/[*`_~]/g, '');
const dePunct = (s) => String(s ?? '').replace(/[\s，。、；：！？,.;:!?「」『』“”"'（）()【】\[\]—…\\-]/g, '');
const loose = (s) => dePunct(deMark(s));

/** 最长公共子串长度（滚动数组，O(|a|*|b|)） */
export function lcsSubstrLen(a, b) {
  if (!a.length || !b.length) return 0;
  const n = a.length;
  const m = Math.min(b.length, 6000); // 单条消息截到 6000，防爆炸
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  let best = 0;
  for (let i = 1; i <= n; i += 1) {
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j += 1) {
      cur[j] = ai === b.charCodeAt(j - 1) ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) best = cur[j];
    }
    const t = prev; prev = cur; cur = t;
    cur.fill(0);
  }
  return best;
}

// 归一化后的用户消息（按需构建并缓存）
let _looseMsgs = null;
let _looseKey = null;
function corpusLooseMessages(root) {
  const entries = corpusEntries(root);
  const key = `${entries.length}:${_corpusKey}`;
  if (_looseMsgs && _looseKey === key) return _looseMsgs;
  _looseMsgs = entries.map((e) => {
    // ⚠ 2026-09-17：`e.text` 现在**已经是正文文本**（见 corpusEntries 的注释），
    //   不再需要 JSON.parse。留着 try 是为兼容"万一有人喂旧形状"（旧形状是 JSON 串）。
    let text = String(e.text ?? '');
    if (text.startsWith('{')) {
      try { text = (JSON.parse(text).data?.content ?? []).map((c) => c.text ?? '').join(' '); } catch { /* 就当正文 */ }
    }
    return { loose: loose(text), raw: text.replace(/\s+/g, ' ').trim(), session: e.session };
  }).filter((m) => m.loose.length >= 4);
  _looseKey = key;
  return _looseMsgs;
}

/**
 * 查一句引文到底是不是用户说的。
 * 短引文（≤80 字）用**最长公共子串相似度**——窗口覆盖度对"只差一个字"的写法会全落空
  * （实测：用户说的和文档里写的存在细微差异，逐字核对才能发现）。
 * 长引文才退回窗口覆盖度（LCS 对长文本太贵）。
 */
export function verifyQuote(root, quote, corpus) {
  const blob = corpus ?? corpusText(root);
  const q = squash(quote);
  if (q.length < 6) return { verdict: 'too-short', ratio: 0, quote };
  if (blob.includes(q)) {
    // 逐字命中了 —— 但**还要看是不是用户引述 AI**（用户会把你写的清单贴回来）
    const hit = findUserSaying(root, quote);
    if (isQuotedFromAI(root, quote, hit)) {
      return { verdict: 'quoted-from-ai', ratio: 1, quote, note: '在用户消息里逐字命中，但那句更早出现在 AI 的产出里 —— 用户在**引述**，不是他说的' };
    }
    return { verdict: 'verbatim', ratio: 1, quote };
  }
  // 只差标点/markdown 强调 → 仍算逐字，但要注明
  const blobLoose = loose(blob);
  const qLoose = loose(quote);
  if (qLoose.length >= 6 && blobLoose.includes(qLoose)) {
    return { verdict: 'verbatim', ratio: 1, punctuationOnly: true, quote };
  }

  if (qLoose.length <= 80) {
    let best = 0; let bestMsg = null;
    for (const m of corpusLooseMessages(root)) {
      const len = lcsSubstrLen(qLoose, m.loose);
      if (len > best) { best = len; bestMsg = m; }
    }
    const ratio = qLoose.length ? best / qLoose.length : 0;
    // 短引文路径也要能判"逐字" —— 否则 ratio=1.0 会显示成"改写(100%)"（审查者实测抓到误报）
    const verdict = ratio >= 0.98 ? 'verbatim' : ratio >= 0.6 ? 'paraphrase' : 'unfounded';
    return { verdict, ratio, bestMatch: bestMsg?.raw?.slice(0, 160), quote };
  }

  // 长引文：滑窗覆盖度
  const W = 10; const STEP = 5;
  let total = 0; let hit = 0; let firstMiss = null;
  for (let i = 0; i + W <= qLoose.length; i += STEP) {
    total += 1;
    const seg = qLoose.slice(i, i + W);
    if (blobLoose.includes(seg)) hit += 1;
    else if (!firstMiss) firstMiss = { at: i, seg };
  }
  const ratio = total ? hit / total : 0;
  // 长引文路径也要能判"逐字"—— 否则 ratio=1.0 会被显示成"改写(100%)"（实测踩过）
  const verdict = ratio >= 0.98 ? 'verbatim' : ratio >= 0.6 ? 'paraphrase' : 'unfounded';
  return { verdict, ratio, firstMiss, quote };
}

export function runQuoteAudit(root, { files } = {}) {
  const corpus = corpusText(root);
  /**
   * ★ R37：引文核对一律按**全集**取数（口径见 quotes 命令那段注释）。
   *   `windowStats` 就是"这次扫了几个窗口"的原始数字 —— 输出里必须明写，
   *   否则读者没法判断这次查的是哪本账（口径与 `voices` 一致：裸 uuid 不算窗口）。
   */
  const windowStats = corpusScanStats();
  const targets = quoteTargets(root, files);
  // 「扫了几个文件」必须报出来 —— 扫了 0 个文件却说"没发现问题"，是最坏的一类假通过（实测踩过）
  const scannedFiles = targets.filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const found = scanAttributions(root, { files });
  const results = found.map((f) => ({ ...f, ...verifyQuote(root, f.quote, corpus) }));
  return { corpusSize: corpus.length, results, scannedFiles: scannedFiles.length, targets: targets.length, windowStats };
}

// ------------------------------------------------------------------ 架构总图
/**
 * 用户给的是**总目标**；具体架构是 AI 用资料与创造力提的 —— 所以架构里的东西
 * **不要求有用户原话**。真正的风险是：AI 在一条支线上不断深入，把别的支线悄悄丢掉，
 * 而每一轮单独看都"有道理"。所以这里把支线显式化，按"最近动过没有"排出来。
 */
export function parseArch(text) {
  text = deBom(text);
  const lines = text.split(/\r?\n/);
  const goal = { text: '', attribution: '', quote: '', reason: '' };
  const branches = [];
  let cur = null;
  let inItems = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^-\s*总目标\s*[:：]/.test(line)) { goal.text = line.replace(/^-\s*总目标\s*[:：]\s*/, ''); cur = null; inItems = false; continue; }
    const h = /^##\s+([A-Z])\s*[·:：]\s*(.*)$/.exec(line);
    if (h) {
      cur = { id: h[1], title: h[2].trim(), attribution: '', quote: '', reason: '', reqs: [], items: [] };
      branches.push(cur); inItems = false; continue;
    }
    if (!cur) {
      const g = /^-\s*(归属|原话|理由)\s*[:：]\s*(.*)$/.exec(line);
      if (g) {
        if (g[1] === '归属') goal.attribution = g[2].trim();
        else if (g[1] === '原话') goal.quote = g[2].trim();
        else goal.reason = g[2].trim();
      }
      continue;
    }
    if (/^-\s*子项\s*[:：]?\s*$/.test(line)) { inItems = true; continue; }
    const item = /^-\s*(.+)$/.exec(line);
    if (inItems && item) {
      const body = item[1].trim();
      const reqs = [...body.matchAll(/\[(R\d+)\]/g)].map((x) => x[1]);
      const kw = /关键词\s*[:：]\s*(\S+)/.exec(body);
      const name = body.replace(/\[R\d+\]/g, '').replace(/关键词\s*[:：]\s*\S+/, '').trim();
      cur.items.push({ name, reqs, keyword: kw ? kw[1] : null });
      continue;
    }
    const kv = /^-\s*(归属|原话|理由|需求)\s*[:：]\s*(.*)$/.exec(line);
    if (kv) {
      if (kv[1] === '归属') cur.attribution = kv[2].trim();
      else if (kv[1] === '原话') cur.quote = kv[2].trim();
      else if (kv[1] === '理由') cur.reason = kv[2].trim();
      else if (kv[1] === '需求') cur.reqs = kv[2].split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return { goal, branches };
}

/** 渲染"一扫便知"的架构图：支线 × 覆盖度 × 最近活动 × 归属可信度 */
export function renderMap(root, arch) {
  const dir = path.join(root, WARDEN_DIR);
  const rounds = readRounds(dir);
  const { spec } = check(root);
  const corpus = corpusText(root);
  const byRound = new Map(rounds.map((r) => [Number(r.round), r]));
  const maxRound = rounds.reduce((m, r) => Math.max(m, Number(r.round) || 0), 0);
  const out = [];
  const bar = (ok, total, w = 10) => {
    const n = total ? Math.round((ok / total) * w) : 0;
    return '█'.repeat(n) + '░'.repeat(Math.max(0, w - n));
  };

  out.push('# 架构总图（总目标 → 支线 → 子项）');
  out.push('');
  out.push(`**总目标**：${arch.goal.text || '（没写）'}`);
  if (arch.goal.quote) {
    const v = verifyQuote(root, arch.goal.quote, corpus);
    out.push(`**归属**：${arch.goal.attribution || '（没写）'} ${v.verdict === 'verbatim' ? '✅逐字' : v.verdict === 'paraphrase' ? `⚠️改写(${(v.ratio * 100).toFixed(0)}%)` : '★查无实据'}`);
  }
  out.push('');
  out.push('| 支线 | 覆盖 | 进度 | 子项 | 最近动过 | 归属 |');
  out.push('|---|---|---|---|---|---|');

  const detail = [];
  for (const b of arch.branches) {
    let done = 0; let part = 0; let none = 0; let unjudgeable = 0;
    const rows = [];
    let lastRound = null;
    for (const it of b.items) {
      // 状态来源：① 挂在某条需求上 → 看那条需求在账本里的状态 ② 关键词在轮次记录里出现过
      const reqRounds = rounds.filter((r) => it.reqs.includes(String(r.requirement)));
      const kwHits = it.keyword ? rounds.filter((r) => `${r.delivered ?? ''} ${r.why ?? ''}`.includes(it.keyword)) : [];
      const hitRounds = [...new Set([...reqRounds, ...kwHits].map((r) => Number(r.round)))]
        .filter((n) => Number.isFinite(n)).sort((a, x) => a - x);
      const reqStatus = it.reqs.length
        ? (reqRounds.some((r) => r.status === 'done') ? 'done'
          : reqRounds.length ? 'partial' : 'none')
        : (kwHits.length ? 'partial' : 'none');
      if (hitRounds.length) lastRound = Math.max(lastRound ?? 0, hitRounds[hitRounds.length - 1]);
      const mark = reqStatus === 'done' ? '✅' : reqStatus === 'partial' ? '⚠️' : '❌';
      if (reqStatus === 'done') done += 1;
      else if (reqStatus === 'partial') part += 1;
      else none += 1;
      /**
       * ⚠ **"没查到" ≠ "没做过"**（实测洞，2026-09-16 由「支线守门员」坐实）。
       *   原来这一格在没有任何命中时直接写「**从未**」、「**从未动过**」——
       *   而判据只是"支线有没有挂到 R#、关键词有没有在轮次记录里出现"：
       *   实测 **26 条支线里 18 条挂靠数 = 0**、`ROUNDS.jsonl` 里 **0 个 `branch` 字段**
       *   ⇒ 那种情况下打出的"从未动过"很可能是**账本没记**，不是**产品没有**。
        *   用户关心的是支线被丢掉—— 这句话必须能被信任，所以**判不了就说判不了**。
       */
      const noBasis = !it.reqs.length && !it.keyword;   // 既没挂 R#、也没关键词 ⇒ 没有判据
      const neverCell = hitRounds.length
        ? '第 ' + hitRounds.join('/') + ' 轮'
        : (noBasis ? '**判断不了**（没挂 R#、没关键词）' : '**账本里没记过**');
      rows.push(`| ${mark} | ${it.name} | ${it.reqs.join(' ') || '（无需求覆盖）'} | ${neverCell} |`);
      if (!hitRounds.length && noBasis) unjudgeable += 1;
    }
    const total = b.items.length;
    const gap = lastRound === null ? null : maxRound - lastRound;
    const recent = lastRound === null
      ? (unjudgeable === total && total > 0
        ? '**判断不了**（整条支线既没挂 R#、也没关键词命中 —— 账本里查不到，不等于没做）'
        : '**账本里没记过**（有判据、但没有任何一轮命中）')
      : `第 ${lastRound} 轮${gap > 0 ? `（${gap} 轮前）` : '（本轮）'}`;
    let attr = b.attribution || '（没写）';
    if (b.quote) {
      const v = verifyQuote(root, b.quote, corpus);
      attr += v.verdict === 'verbatim' ? ' ✅' : v.verdict === 'paraphrase' ? ` ⚠️${(v.ratio * 100).toFixed(0)}%` : ' ★查无实据';
    }
    // 进度条按"完成算 1、半交付算 0.5" —— 只数 done 会把"整链走通但没收尾"显示成 0 覆盖，那是误导
    const score = total ? (done + part * 0.5) / total : 0;
    out.push(`| **${b.id} · ${b.title}** | ${bar(Math.round(score * total), total)} ${done}✅ ${part}⚠️ ${none}❌ | | | ${recent} | ${attr} |`);
    detail.push({ b, rows, done, part, none, total, lastRound, gap, unjudgeable });
  }
  out.push('');
  // 失衡告警：只在超阈值时出声
  const stale = detail.filter((d) => d.lastRound === null || d.gap >= 3);
  if (stale.length) {
    out.push('## ⚠ 可能需要你拍板：支线失衡');
    out.push('');
    for (const d of stale) {
      // ⚠ 措辞不许越界：**判不了就说判不了**，别把"账本没记"说成"产品没做"（见上面 neverCell 那段）
      const head = d.lastRound !== null
        ? `已经 ${d.gap} 轮没动了（最后在第 ${d.lastRound} 轮）`
        : (d.unjudgeable === d.total && d.total > 0
          ? '**判断不了**：整条支线既没挂 R#、也没关键词命中 —— **账本里查不到，不等于产品里没做**'
          : '**账本里从头到尾没有记过它**（有判据，但没有任何一轮命中）');
      out.push(`**${d.b.id} · ${d.b.title}** —— ${head}`);
      if (d.none) out.push(`- 其中 ${d.none}/${d.total} 条子项在账本里找不到动过的痕迹`);
      out.push('- 一句话确认即可：**这条支线是你有意先放着，还是被漏掉了？**');
      out.push('');
    }
  }
  out.push('## 逐条明细');
  out.push('');
  for (const d of detail) {
    out.push(`### ${d.b.id} · ${d.b.title}`);
    if (d.b.quote) out.push(`> 用户原话：${d.b.quote}`);
    if (d.b.reason) out.push(`> 理由：${d.b.reason}`);
    out.push('');
    out.push('| | 子项 | 需求 | 动过的轮次 |');
    out.push('|---|---|---|---|');
    out.push(...d.rows);
    out.push('');
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ 角色戳
/**
 * 为什么是「权限 · 职务」而不是只写职务：
 * 模型真正要区分的是**这条能不能拦住我**，不是谁说的。
 * 「审查员说的」和「支线守门员说的」在模型眼里可能一样软，但效力天差地别 ——
 * 一个是 exit code 强制的硬规则，一个只是等你判断的信号。
 *
 * 为什么只在**块首**盖一个、不逐行盖：
 * 实测逐行前缀让语料 +14%（+1072 token），而块首一行只 +40 token。
 * 逐行前缀是在花 token 买模型本来就知道的信息（那话是它自己写的）。
 *
 * 为什么让脚本盖：凡是要模型"记得写前缀"的规则，最后都会被忘掉。
 */
export const ROLE_STAMP = {
  check: '【硬规则 · 审查员】',
  quotes: '【硬规则 · 审查员】',
  diff: '【硬规则 · 记录员】',
  report: '【记录 · 记录员】',
  history: '【记录 · 记录员】',
  map: '【信号 · 支线守门员】',
  keeper: '【记录 · 记录员】',
  gate: '【硬规则 · 提问闸门】',
  rules: '【记录 · 记录员】',
  research: '【资料 · 资料员】',
  direction: '【方向 · 工程方向员】',
  supervisor: '【监督 · 监督员】',
  user: '【使用 · AI测试用户】',
};

// ------------------------------------------------------------------ 角色与权力
/**
 * 角色现场判决 —— 排版照"网游聊天框"来：一行一个角色，`角色：判决`，
 * 小字/灰/细，前面一个细竖线做行首标记，不要大标题。
 * 终端里用 ANSI 灰；用户把它贴进 GUI 时用引用块渲染成灰色细体。
 */
export function rolesView(root, { color = false } = {}) {
  const dir = path.join(root, WARDEN_DIR);
  const cfg = readConfig(dir);
  const spec = fs.existsSync(path.join(dir, 'SPEC.md')) ? parseSpec(readText(path.join(dir, 'SPEC.md'))) : [];
  const rounds = readRounds(dir);
  const devs = fs.existsSync(path.join(dir, 'DEVIATIONS.md')) ? parseDeviations(readText(path.join(dir, 'DEVIATIONS.md'))) : [];
  const ws = fs.existsSync(path.join(dir, 'params.yml')) ? parseParams(readText(path.join(dir, 'params.yml'))) : [];
  const archPath = path.join(dir, 'ARCH.md');
  const voices = loadVoices(dir);
  const questions = fs.existsSync(path.join(dir, 'QUESTIONS.jsonl'))
    ? readText(path.join(dir, 'QUESTIONS.jsonl')).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const { fails, warns } = check(root);

  const G = color ? '\x1b[90m' : '';   // 灰
  const D = color ? '\x1b[2m' : '';    // 细
  const R = color ? '\x1b[0m' : '';
  const lines = [];
  const say = (who, power, verdict) => lines.push(`${G}· ${R}${D}${who}${R}${G}：${power}${R} ${verdict}`);

  lines.push(`${G}· ${D}角色现场判决 —— ${cfg.subProject ?? '（子项目还没写）'}${R}`);
  const verified = spec.length;
  say('监督员　', '【硬规则】能拦住"完成"', verified
    ? `${verified} 条需求（${spec.slice(0, 4).map((s) => s.id).join(' ')}${verified > 4 ? ` …共 ${verified}` : ''}）`
    : '· 一条需求都没锁，它没法判断"给的对不对"');
  say('审查　　', '【硬规则】exit code 说话', fails.length
    ? `★ 不通过 ${fails.length} 条 —— ${String(fails[0]).slice(0, 70)}`
    : `通过 · ${rounds.length} 轮记录 · ${devs.length} 条偏差申报`);
  const unrecorded = ws.filter((w) => !rounds.some((r) => r.values && Object.prototype.hasOwnProperty.call(r.values, w.id)));
  say('记录　　', '【记录】纯事实', `档位 ${ws.length} 项${unrecorded.length ? `（${unrecorded.length} 项从没记过值）` : '全有值'} · 你的原话 ${voices.length} 条`);
  if (!fs.existsSync(archPath)) {
    say('支线守门员', '【信号】只提醒不拦', '⚠ 还没有 ARCH.md —— 支线没写下来，谈不上"哪条被丢了"');
  } else {
    const arch = parseArch(readText(archPath));
    const stale = renderMap(root, arch).split('\n').filter((l) => l.includes('判断不了') || l.includes('账本里没记过') || l.includes('轮没动'));
    say('支线守门员', '【信号】只提醒不拦', `${arch.branches.length} 条支线${stale.length ? ` · ⚠ ${stale.length} 条需要你拍板` : ' · 都在动'}`);
  }
  const blocked = questions.filter((q) => q.mechanical === 'blocked').length;
  const pending = questions.filter((q) => q.mechanical === 'pass' && !q.resolved).length;
  say('提问闸门　', '【硬规则】能拦住"提问"', questions.length
    ? `记了 ${questions.length} 次 · 拦下 ${blocked} · 没过脑子关 ${pending}`
    : '还没走过闸门（这个子项目一次都没试）');
  if (!cfg.subProject) lines.push(`${G}· ${D}提醒：config.json 里加 "subProject" 写下这是哪个子项目${R}`);
  if (warns.length) lines.push(`${G}· ${D}（信号 ${warns.length} 条，不拦）${R}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ 脑子角色组
/**
 * 「脑子」是一个**可以扩编的审查角色**：
 *   1 个脑子不够 → 派 2 个（互相独立、拿到同样的材料、都不给别人的结论）
 *   2 个脑子冲突 → 加 1 个裁判（拿到两份判决，判谁对）
 *
 * 为什么做成命令：如果只是"我记得派了两个"，那又是自我申报。
 * 这里把"派了谁、判了什么、有没有冲突、有没有裁判"全部落盘并**机械判定**。
 *
 * 判"冲突"的规则（机械）：
 *   ① 两份判决的 verdict 不同（accept vs reject）
 *   ② 都 reject 但提出的问题**重合度 < 50%**（各说各的，等于没共识）
 */
const BRAIN_FILE = 'BRAIN.jsonl';

export function readBrainRecords(dir) {
  const p = path.join(dir, BRAIN_FILE);
  if (!fs.existsSync(p)) return [];
  return readText(p).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function recordBrain(dir, rec) {
  fs.appendFileSync(path.join(dir, BRAIN_FILE), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n', 'utf8');
}

/** 产物指纹 —— 用来判"审过之后有没有又改过" */
export function artifactHash(root, artifact) {
  const p = path.isAbsolute(artifact) ? artifact : path.join(root, artifact);
  try {
    if (!fs.statSync(p).isFile()) return null;
  } catch { return null; }
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
}

/**
 * 复核一个脑子的指控**是否成立** —— 这一步必须机器做，不能靠人。
 *
 * 实测事故（2026-09-16）：脑子 G 对 ARCH 第三版提了 9 条指控，其中 **4 条经复核不成立**：
 *   ① 把已经标了「用户贴回（AI清单）」的引文，说成"标成了用户原话"；
 *   ② 把用户自己写给另一个窗口的话，说成"贴回的 AI 文本"；
 *   ③ 把已经标了 (AI词) 的数字，说成"没标"；
 *   ④ 把 VOICE.jsonl 里真实存在的文件名，说成"查无"。
 * **一个脑子冤枉人，就能否掉一份产物。** 所以指控也要有证据、也要能被机器驳倒 ——
 * 判"产物有没有问题"的权力，不能大于"能不能复现这句话"的义务。
 *
 * claim 形状：`{ code, needle, check }`，check 取值：
 *   voice-has        这段字在用户真消息里逐字有     （指控"用户说过"）
 *   voice-lacks      这段字在用户真消息里逐字没有   （指控"用户没说过"）
 *   artifact-has     产物里有这段字
 *   artifact-lacks   产物里没有这段字               （指控"漏了"）
 *   ai-authored      这段字**更早**出现在 AI 的产出里（指控"这是 AI 写的"）
 *   unlabeled        含这段字的那一行没有带 (AI词)   （指控"AI 造的数没标"）
 * 返回 `{ ok, detail }`：ok = 指控成立。
 */
export function verifyClaim(root, artifact, claim) {
  const needle = String(claim?.needle ?? '');
  if (!needle) return { ok: false, detail: '没写 needle，无法复核' };
  const ap = path.isAbsolute(artifact) ? artifact : path.join(root, artifact);
  let atext = '';
  try { atext = readText(ap); } catch { return { ok: false, detail: `读不到产物 ${artifact}` }; }
  const inArtifact = atext.includes(needle);
  const lines = atext.split(/\r?\n/);
  const lineHasLabel = lines.some((l) => l.includes(needle) && /\(AI词\)|（AI词）/.test(l));
  const corpusAll = corpusEntries(root);
  const voiceHit = corpusAll.find((e) => e.text.includes(needle)) ?? null;
  // ★ 覆盖度闸（「监督员」角色黑盒复现的漏洞）：语料里一条真用户消息都没有时，
  //   原来会把一条 voice-has 指控**驳回**成"用户真消息里逐字查无" exit 1 ——
  //   而用户其实真说过，只是这次没扫到。**这就是"没查到东西 ≠ 查了没问题"。**
  //   覆盖度不足时：不许判冤，也不许判真，只许说"没法判"。
  const coverage = corpusAll.length;
  const covNote = `（本次扫到 ${coverage} 条真用户消息）`;
  if (coverage === 0 && (claim.check === 'voice-has' || claim.check === 'voice-lacks')) {
    return { ok: false, detail: `★ **覆盖度不足，不能判** —— ${covNote}，语料是空的。`
      + '先跑 `node warden.mjs voices` 或确认 `sources` 指的工作区对不对；'
      + '在此之前**既不能说用户说过、也不能说他没说过**。' };
  }
  switch (claim.check) {
    case 'voice-has': return { ok: !!voiceHit, detail: voiceHit ? `用户确实说过（${voiceHit.session}）${covNote}` : `用户真消息里逐字查无${covNote}` };
    case 'voice-lacks': return { ok: !voiceHit, detail: voiceHit ? `用户其实说过（${voiceHit.session}）—— 指控不成立${covNote}` : `用户确实没说过${covNote}` };
    case 'artifact-has': return { ok: inArtifact, detail: inArtifact ? '产物里确实有' : '产物里没有' };
    case 'artifact-lacks': return { ok: !inArtifact, detail: inArtifact ? '产物里其实**有** —— 指控不成立' : '产物里确实没有' };
    case 'ai-authored': {
      const q = loose(needle);
      const hit = q.length >= 12 ? assistantEntries(root).find((a) => loose(a.text).includes(q)) : null;
      return { ok: !!hit, detail: hit ? `AI 先写过（${hit.session}）` : (q.length < 12 ? '太短（<12 字），机器不敢判' : 'AI 的产出里找不到') };
    }
    case 'unlabeled': return { ok: inArtifact && !lineHasLabel, detail: !inArtifact ? '产物里没这段字' : (lineHasLabel ? '那一行其实标了 (AI词) —— 指控不成立' : '那一行确实没标 (AI词)') };
    default: return { ok: false, detail: `不认识的 check：${claim.check}` };
  }
}

/** 把一份审查记录里的指控逐条机器复核；返回 { total, ok, failed } */
export function auditClaims(root, rec) {
  const claims = Array.isArray(rec?.claims) ? rec.claims : [];
  const rows = claims.map((c) => ({ ...c, ...verifyClaim(root, rec.artifact, c) }));
  return { total: rows.length, ok: rows.filter((r) => r.ok).length, failed: rows.filter((r) => !r.ok), rows };
}

/**
 * 「第 2 个脑子」的**触发条件**。
 *
 * 用户 2026-09-2x 逐字：「（用户原话已隐去 —— 公开版不留逐字）」
 *
 * ⚠ 这条**推翻**了原来那张表（"总目标 / 架构 / 交付验收 → 2 个脑子（必须两个）"）。
 *   一次性派两个的代价是双份成本，而且第二个脑子在**没有触发条件**时只是在复述第一个 ——
 *   那正是本项目 §一①「差异化」判据要抓的"摆设"：**一个角色的价值 = 它提出的、别人提不出来的东西**。
 *   所以现在是**按需**（默认 0 个，只在触发条件成立时才派）；第 2 个只在下面三种条件下派，
 *   而且**必须把是哪种记下来**（`brain record --trigger`）—— 否则事后分不清
 *   "真的需要两个"还是"照旧习惯派了两个"。
 */
export const BRAIN_TRIGGERS = {
  conflict: '结论 / 来源冲突：两份判断（或两个来源）不一致 —— 要判**哪边成立**，并给可机检的证据',
  shallow: '不细致：第 1 个脑子给的问题太笼统、没证据、或明显没看完 —— 要**逐条给出能在文件里 grep 到的原话**',
  explore: '要探索更多可能：需要"**还有哪些做法 / 哪些坑**"，不是"这行不行" —— 除 accept/reject 外另给 ≥3 条别的做法与各自代价',
};
/** 三个触发条件的 id（顺序固定，输出里直接用它） */
export const BRAIN_TRIGGER_IDS = Object.keys(BRAIN_TRIGGERS);

/**
 * 审理状态。判"这份产物能不能定稿"：
 *   0 个脑子 → 没审（随手小改动不必审；只在 conflict / shallow / explore 时才需要）
 *   1 个脑子 → 单审（按需派出；只有冲突 / 不细 / 要探索更多时才加派第 2 个）
 *   2 个脑子一致 → 可以定稿
 *   2 个脑子冲突且无裁判 → ★ 不许定稿
 *   有裁判 → 按裁判的判
 */
export function brainStatus(dir, root) {
  const recs = readBrainRecords(dir);
  const byArtifact = new Map();
  for (const r of recs) {
    if (r.role === 'judge') continue;
    const k = r.artifact ?? '（没写产物）';
    if (!byArtifact.has(k)) byArtifact.set(k, []);
    byArtifact.get(k).push(r);
  }
  const judges = recs.filter((r) => r.role === 'judge');
  const out = [];
  let blocking = 0;
  for (const [artifact, list] of byArtifact) {
    const latest = new Map();
    for (const r of list) latest.set(r.brain ?? '?', r);   // 同一个脑子只算最后一次
    const brains = [...latest.values()];
    const judge = [...judges].reverse().find((j) => (j.artifact ?? '（没写产物）') === artifact);
    // ★ 改过但未复审：审完之后产物又变了 → 那次审查结论作废
    //   （这条是机械的，不靠 agent 记得 —— 教训：不要把自己的设限当外部约束，把该做的下一步跳过去）
    //
    // ★★ 但"整份一个哈希"会把**没被碰过的支线**一起作废（支线守门员真实反对，核实后成立）：
    //   实测 ARCH.md 有 28 条支线，每次只改一两条，而 8 个脑子的审查**全部**被标成作废；
    //   重审永远先排热门支线 → 冷支线永远排不上队 = **用流程把冷支线静默丢掉**。
    //   所以改成：记录里存了 `sections`（每个 `^## ` 块单独的哈希）时，**只比它覆盖过的那些章节**；
    //   覆盖的章节都没变 → 这份审查仍然有效；变了 → 只标那几个章节作废，并打印是哪几个。
    const nowHash = root ? artifactHash(root, artifact) : null;
    const nowSections = root ? sectionHashes(root, artifact) : null;
    const fresh = []; const staleOnes = [];
    for (const b of brains) {
      const sv = sectionVerdict(b, nowSections);
      b.sectionVerdict = sv;
      if (sv.legacy) {
        // 老记录没章节指纹 → 退回整份比，并在输出里注明
        if (nowHash && b.artifactHash === nowHash) fresh.push(b); else staleOnes.push(b);
        continue;
      }
      if (sv.changed.length) staleOnes.push(b); else fresh.push(b);
    }
    const stale = !!(nowHash && staleOnes.length && fresh.length === 0);
    brains.length = 0; brains.push(...fresh);   // 之后一律只按"投这一版票的脑子"算
    const changedKeys = [...new Set(staleOnes.flatMap((b) => b.sectionVerdict?.changed ?? []))];
    const legacyStale = staleOnes.filter((b) => b.sectionVerdict?.legacy).length;
    const secNote = changedKeys.length
      ? `★ ${changedKeys.slice(0, 8).join('、')}${changedKeys.length > 8 ? ` 等 ${changedKeys.length}` : ''} ${changedKeys.length} 个章节变了`
      : '';
    const extraNote = (staleOnes.length && fresh.length)
      ? `（${secNote || `另有 ${staleOnes.length} 个脑子审的是旧版`}，其余 ${fresh.length} 份审查仍然有效${legacyStale ? `；其中 ${legacyStale} 份是老记录无章节指纹，只能整份比` : ''}）`
      : '';
    let state; let note = '';
    if (stale) {
      state = '★ 改过但未复审';
      note = changedKeys.length
        ? `${secNote} —— 而 ${staleOnes.length} 份审查覆盖的正是这些章节，**结论作废，必须重新派脑子**`
        : `产物已变（现在 ${nowHash}），${staleOnes.length} 份审查是针对旧版的（或没留指纹、无法证明审的是这一版）—— **结论作废，必须重新派脑子**`;
      blocking += 1;
    }
    else if (brains.length === 0) { state = '没审'; }
    else if (brains.length === 1) {
      state = '单审';
      // ⚠ 措辞是**判据的一部分**：原来写"高风险产物要求 2 个"，
      //   读起来像"单审 = 欠账" ⇒ 于是每次都习惯性派两个（用户明确否掉了这个做法）。
      //   现在如实说：默认就是 1 个，第 2 个要**触发条件**。
      const trg = brains[0].trigger && BRAIN_TRIGGERS[brains[0].trigger] ? `（这一份是第 2 个脑子，触发条件：${brains[0].trigger}）` : '';
      note = `（按需派出；只有 ${BRAIN_TRIGGER_IDS.join(' / ')} 三种触发条件成立时才派第 2 个）${trg}：` + brains[0].verdict;
    }
    else {
      const vs = new Set(brains.map((b) => b.verdict));
      // 问题集重合度：**所有脑子两两算 Jaccard 再平均**（原来只比前两个，4 个脑子也报"两个"）
      const sets = brains.map((b) => new Set(String(b.issues ?? '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean)));
      let pairSum = 0; let pairN = 0;
      for (let i = 0; i < sets.length; i += 1) {
        for (let j = i + 1; j < sets.length; j += 1) {
          const inter = [...sets[i]].filter((x) => sets[j].has(x)).length;
          const union = new Set([...sets[i], ...sets[j]]).size;
          pairSum += union ? inter / union : 1;
          pairN += 1;
        }
      }
      const overlap = pairN ? pairSum / pairN : 1;
      const allEmpty = sets.every((s) => s.size === 0);
      const conflict = vs.size > 1;   // 只有**判决不同**才算冲突
      const n = brains.length;
      const verdicts = brains.map((b) => b.verdict).join(' vs ');
      if (judge) { state = '已裁决'; note = `${verdicts}（${n} 个）→ 裁判：${judge.verdict}｜${judge.reason ?? ''}`; }
      else if (conflict) { state = '★ 冲突·未裁决'; note = `判决 ${verdicts}（${n} 个）—— **不许定稿**`; blocking += 1; }
      else if (allEmpty) { state = '一致'; note = `${n} 个脑子都判 ${brains[0].verdict}，都没提问题`; }
      else if (overlap < 0.5) { state = '一致·互补'; note = `${n} 个脑子都判 ${brains[0].verdict}，但问题集两两平均重合度只 ${(overlap * 100).toFixed(0)}% —— **互补，各份都要改**（不算冲突，不用叫裁判）`; }
      else { state = '一致'; note = `${n} 个脑子都判 ${brains[0].verdict}，问题两两平均重合度 ${(overlap * 100).toFixed(0)}%`; }
    }
    out.push({ artifact, brains: fresh.length || staleOnes.length, state, note: note + extraNote, list: fresh.length ? fresh : staleOnes });
  }
  return { out, blocking, judges: judges.length };
}

/**
 * 给"脑子"的任务书 —— 项目无关，任何产物都能审。
 *
 * `trigger`（可选）∈ {@link BRAIN_TRIGGER_IDS}：说明**为什么加派第 2 个脑子**。
 * 它只描述"哪里需要更细 / 更多可能"，**绝不透露任何人的结论** ——
 * 独立性是这一层唯一的价值，一旦给了别人的判决，它就变成评论者而不是独立审查者。
 */
export function brainBrief(root, artifact, trigger) {
  const dir = path.join(root, WARDEN_DIR);
  const rel = path.relative(root, artifact).replace(/\\/g, '/');
  const trg = trigger !== undefined && Object.hasOwn(BRAIN_TRIGGERS, trigger) ? trigger : undefined;
  return [
    `你的角色是「**脑子**」—— 一个独立审查者。你的任务不是执行，是**判断**：判断下面这份产物该不该被接受。`,
    '',
    '**你没被告知任何人的结论。你看到的原始材料就是全部。**',
    ...(trg === undefined ? [] : [
      '',
      `## ⚠ 你是**第 2 个脑子** —— 加派你的触发条件是 \`${trg}\``,
      `  ${BRAIN_TRIGGERS[trg]}`,
      '',
      '  · 触发条件只说"哪里需要更细 / 更多可能"，**没有告诉你第 1 个脑子判了什么** ——',
      '    不许去猜、不许去找它的记录（找到就等于破坏独立性，这次审查作废）。',
      ...(trg === 'explore' ? [
        '  · 除了 accept / reject，**必须另给 ≥3 条别的做法**，每条写：做法 / 代价 / 什么条件下它更好。',
      ] : []),
      ...(trg === 'shallow' ? [
        '  · 上一轮的问题是"太笼统、没证据" ⇒ 你**每条判断都必须附一句能在文件里 grep 到的原话**，',
        '    否则这条判断按"没有证据"作废。',
      ] : []),
      ...(trg === 'conflict' ? [
        '  · 有两份判断不一致 ⇒ 你要**独立判定哪边成立**，并给出可机检的证据（针/检查方式），',
        '    不要折中成"两边都有道理"。',
      ] : []),
    ]),
    '',
    '## 被审产物',
    `  ${artifact}`,
    '',
    '## 你可以读的原始材料（只读，不许改任何文件）',
    `  ${path.join(dir, 'VOICE.jsonl')}      用户在每个窗口说过的每一句话（逐字，最权威）`,
    `  ${path.join(dir, 'SPEC.md')}          已锁定的需求（逐字原话）`,
    `  ${path.join(dir, 'ARCH.md')}          架构（如果被审的就是它，那是被审对象）`,
    `  ${path.join(dir, 'MAP.md')}           渲染出来的架构图`,
    `  ${root}                              工程目录（只读）`,
    '',
    '## 你必须要回答的',
    '  ① **归属对不对**：标成"用户原话"的，真的是用户说的吗？有没有把 AI 自己的提案/总结标成用户原话？',
    '  ② **有没有把比喻做成字面清单**（或反过来：把用户的比喻删掉、压成工程描述）？',
    '  ③ **有没有漏掉整块内容**？给出：漏了什么 + 在哪条原话里能看到（引原话）。',
    '  ④ **有没有多余/错位/重复**的条目？',
    '',
    '## 规矩',
    '  · 每条判断都要**引原话或给数据**（"133 条里命中 N 条"）。',
    '  · **不许编**。查不到就写"查不到"。',
    '  · 不要写任何文件。',
    '  · 你的结论可以否定这份产物 —— 那正是要你来的原因。',
    '',
    '## 交回格式（简短，别写作文）',
    '  verdict: accept | reject',
    `  issues:  用逗号分隔的问题短名（例如"总目标被截断,漏7条支线,F/R9错位"）`,
    '  然后逐条给证据。',
    '  ★ 另交 `claims`：`[{"code":"E07","needle":"能在文件里 grep 到的原样字符串","check":"artifact-lacks"}]`',
    '    —— 没有可机检指控的判决，机器无法复核（`brain audit` 会说"这次没复核任何东西"）。',
    '',
    '## 交回之后（由调度方执行）',
    `  node warden.mjs brain record --artifact ${rel} --brain ${trg === undefined ? 'A' : 'B'} --verdict reject --issues "…"${trg === undefined ? '' : ` --trigger ${trg}`}`,
  ].join('\n');
}

// ------------------------------------------------------------------ 角色投票（冲突时）
/**
 * 冲突时**不叫裁判拍板**，而是**让在册角色各按自己的职责投票**；
 * 每个角色的票必须**从它自己的职责出发**（记录不投"用户原话"的票，那是监督员的活）；
 * 思考仍然由"脑子"承担 —— 脚本只做计票，不做判断。
 *
 * 为什么按职责分权：各角色看的是**不同的东西**（原话 / 证据 / 事实 / 覆盖面 / 注意力 / 外部出处 / 方向影响面）。
 * 让它们用一个标准投票，就等于把七个角色压成一个 —— 那要这些角色干什么。
 *
 * ⚠ 名单（`ROLE_REMIT` / `VOTE_ROLES`）**不在这里定义** —— 单一事实源是文件开头的
 * `ROLE_REGISTRY`。实测教训：名单散在多处 ⇒ 新角色不在投票名单 ⇒ 不投也算"票齐" ⇒
 * **新角色的意见可以被静默忽略**（`资料员`/`方向员` 就是这么被漏掉的）。
 */
const VOTE_FILE = 'VOTES.jsonl';

export function readVotes(dir) {
  const p = path.join(dir, VOTE_FILE);
  if (!fs.existsSync(p)) return [];
  return readText(p).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function recordVote(dir, rec) {
  fs.appendFileSync(path.join(dir, VOTE_FILE), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n', 'utf8');
}

/**
 * 计票。脚本只算数，**不判断**：
 *   · 每个角色最多一票（后投的覆盖先投的）
 *   · 平票 / 缺席 → **未决**，交给脑子继续想（不许硬定）
 *   · 每个角色的票必须带理由，且理由要落在它的职责里（这一点由脑子判断，脚本只提示）
 *   · **附条件的同意 ≠ 干净的同意**：`--conditions` 写了的票单独列出来（`conditional`），
 *     推进规则时要用它拦住"条件被丢掉、票照算"。
 */
export function tallyVotes(dir, topic) {
  const votesAll = readVotes(dir);
  const all = votesAll.filter((v) => v.topic === topic);
  if (!all.length) return { topic, state: '没有投票', counts: {}, votes: [], missing: VOTE_ROLES, roster: VOTE_ROLES, rosterFrom: '默认', outsiders: [], outsiderNote: null, selfAddressed: [], selfAddressedNote: null, conditional: [], conditionalVotes: [], winCount: 0, majorityNeeded: Math.floor(VOTE_ROLES.length / 2) + 1, hasMajority: false, majorityBase: VOTE_ROLES.length, majorityBaseNote: null, ruleAt: null, ruleFloor: [], accountContradiction: null, accountNote: null };
  const voters = new Set(VOTE_ROLES);
  const latest = new Map();
  const outsiders = [];     // 投了票但**没有投票权**的角色（含名字写错的）—— 出声，但**不计票**
  for (const v of all) {
    if (v.role === '脑子' || v.role === '裁判') continue;
    // ⚠ 没有投票权的席位**不许改变结果**（实测洞：任何字符串都算一个"角色"，
    //   于是名字写错的一票会进 counts、甚至可能翻转 winner；`AI测试用户` 也会被当成普通票算进去）。
    //   但也**不许静默丢掉** —— 它进 outsiders，由 `vote` / `rules` 单独打出来。
    if (!voters.has(v.role)) { outsiders.push(v); continue; }
    latest.set(v.role, v);
  }
  const counts = {};
  for (const v of latest.values()) counts[v.choice] = (counts[v.choice] ?? 0) + 1;
  const options = [...new Set(all.filter((v) => v.options).flatMap((v) => String(v.options).split(',')))];
  const cast = [...latest.values()];
  // ★ 应到名单（roster）—— **加一席不许追溯卡死老议题**。
  //   实测教训（「监督员」算出来的）：`VOTE_ROLES` 一旦从 5 席加到 7 席，
  //   **所有老议题永远差 2 票** ⇒ 全卡「缺席·未决」⇒ **这个席位成了永久否决权**。
  //   判断分两级：
  //     ① 票记录里写了 `roster` 的 → **照它**（投票时那一刻的在册名单，最准；`vote cast` 会写）
  //     ② 老票没写 → 按席位是**什么时候开始有票的**（`SEAT_ADDED_AT`）与本议题**首次投票时刻**比：
  //        席位加进来的时刻 **晚于**本议题第一次投票 ⇒ 本议题当时它还不是席位，**不计入应到**。
  //   ⚠ 我第一版用的是"这角色在本文件里有没有更早投过票"来推断——**那个办法有洞**：
  //     本议题开完票之后、别的角色在**另一个议题**上首次投票，会被误判成"当时不在册"，
  //     于是这个席位从本议题的应到名单里**掉了**（票没投也照样算齐）。所以改成问注册表要时刻。
  const _ts = (v) => { const n = Date.parse(String(v?.at ?? '')); return Number.isFinite(n) ? n : null; };
  /**
   * ★★ **P-M3 修（2026-09-24，「审查」的 outsider.mjs 实测出 ①→② 的反例，原样输出见任务书）**：
   *   `_firstAt`（= "票的时刻"，判据⑤ `accountContradiction` 与 `_inferred` 都由它推）原来取的是
   *   **该 topic 全部记录**的 `at` 最小值 —— **含 `outsiders`**（无票席位 `AI测试用户`、名字写错的角色）。
   *   实测：一份**干净 7/7 同意**（票都落在规则进册之后）⇒ `多数：同意` exit 0、`rule status` 落「试行」；
   *   只要**再手写一条根本不是票的早期记录**（`AI测试用户`，或把名字写成 `审查员`）⇒
   *   `_firstAt` 被它拉到 2026-09-01 ⇒ 判据⑤ 判「账目自相矛盾」⇒ 同一份干净 7/7 变成**永久提案**。
   *   ⇒ **一条没有投票权的记录能冻住整份决议**，而状态文案却写着"**票**的时刻"。
   *
   *   修法（**与 `_voted` 同口径**）：`_firstAt` 只认**有票席位**（`voters.has(v.role)`）写的记录 ——
   *   无票席位的出声照样进 `outsiders` 并单独印出来（`outsiderNote`），但**不参与**"票的时刻"。
   *   ⚠ **不是放宽**：`_firstAt` 仍取**有票席位全部记录**（含被后投覆盖的早期记录）的 `at` 最小值 ——
   *     所以「手写小名单 + `at` 提前」那条 R904 夹具（3 条早票**都是在册席位**投的）照旧被拦住（L38 负控④回归）。
   *     变的只有一件事：**不是票的记录，不再被当成票的时刻**。
   */
  const _times = all.filter((v) => voters.has(v.role)).map(_ts).filter((n) => n !== null);
  const _firstAt = _times.length ? Math.min(..._times) : null;
  let recordedRoster = null;    // 最早那条带 roster 的记录里的名单
  let recordedAt = null;
  for (const v of all) {
    if (!Array.isArray(v.roster) || !v.roster.length) continue;
    const t = _ts(v); if (t === null) continue;
    if (recordedAt === null || t < recordedAt) { recordedAt = t; recordedRoster = v.roster; }
  }
  /**
   * ★★ **过半闸的分母不许由票记录单独决定**（P-M2 修；2026-09-24 实测出两条路，都给了原样输出）：
   *   路 A：同样 7 票 A=2/B=1/C=1/D=1/E=1/F=1，只在**最早那条**记录里手写
   *         `roster:["监督员","审查"]` ⇒ 分母变 2 ⇒ `2/2` ⇒ 输出 `结果：**多数：A**` **exit 0**；
   *   路 B：只把 `at` 提前到 2026-09-01（**不碰 roster**）⇒ 按加入时刻推出 5 席 ⇒
   *         `A=3/7` 却按 `3/5` 算 ⇒ 又变成 `多数：A` **exit 0**。
   *   两条路形状相同：**分母被缩到比"实际投了票的在册席位"还小** ——
   *   同一张票在分子里算一整张、在分母里只算半张 ⇒ **一张票当两票用**。
   *
   * 判据（两层，**都不许缩小分母**；写在这里是因为它是"判据"而不是"实现细节"）：
   *   ① `roster`（应到名单，管「缺席」）：票里记的 / 按加入时刻推出来的，**再并上实际投了票的在册席位**。
   *      一个席位既然投了票，它就是应到 —— 把投票人排除在应到之外是自相矛盾（路 A 就是靠这个自相矛盾得逞的）。
   *   ② `majorityBase`（**过半闸的分母**）：取 ①、实际投票席位数、以及**按 `SEAT_ADDED_AT` 在首票时刻
   *      推出的名单** 三者**最大**。第三条是给「加一席不追溯」留的路。
   *
   * 为什么**不会误伤老议题**（L15 的「加席位不追溯」）：
   *   · 老议题首票时刻早于新席位加入 ⇒ 推出来的就是**当时**那 5 席 ⇒ `majorityBase = 5`，
   *     3/5 仍然算多数（**不追溯**）—— 判据 ② 里**没有任何一项是"今天的 7 席"**，
   *     所以老议题不会因为今天有 7 席就被追溯要求多凑 2 票（那正是 L15 要防的"新席位 = 永久否决权"）。
   *   · L15 ③「票里记了 roster=5、但时刻晚于新席位加入」照旧按记录的 5 席算 `roster`（缺席 0，用例断言不变红），
   *     只是过半闸的分母取 `max(5, 5, 7) = 7` —— `5/7` 照样过半；
   *     而它拦住的正是"手写一个更小的名单"那条路（同一个判据，两头都不吃亏）。
   *
   * ★★ **P-M2b 补：上面①②还是被"两条腿合并着走"通了**（2026-09-24「审查」造的反例，原样输出见任务书）：
   *   夹具：`rule propose R904`（规则进册时刻 = 今天）之后，**手写** 3 条票
   *   （监督员/审查/记录 全同意，`at:"2026-09-01T00:00:00.000Z"`，**首条带 `roster:[那 3 席]`**），
   *   其余 4 席**一票不投** ⇒
   *     · `_inferred` 按**首票时刻**（2026-09-01）推 = **5**（为保 L15「不追溯」，这个数本身没错）；
   *     · 而 `roster` 被手写成 3 ⇒ `missing = 0`（**缺席闸被同一条记录清零**）；
   *     · `majorityBase = max(3, 3, 5) = 5` ⇒ `3 > 5/2` ⇒ 输出 `结果：**多数：同意**`、exit 0，
   *       `rule status` 照旧**落盘成「试行」**（RULES.jsonl 末条 `status:"试行"`）。
   *   形状：**把没投票的席位从"应到"里删掉** ⇒ 缺席闸读到 0 ⇒ 分母只剩"当时在册"的 5 席。
   *   对照（同一条夹具）：`at` 改回现在 ⇒ 未决；`at` 提前但**不手写 roster** ⇒ `missing=2` ⇒ 缺席·未决。
   *   ⇒ **这个洞要两条腿同时用**（手写小名单 + 改 `at`）。
   *
   * ★ **P-M2b 的判据：规则议题的"账目下限"钉在 RULES.jsonl 的进册时刻上**（判据③④⑤）：
   *   ③ **规则议题的应到名单（`roster`）不许低于"该规则该修订进册那一刻的在册席位"**
   *      （`ruleFloor = VOTE_ROLES ∩ SEAT_ADDED_AT ≤ 规则进册时刻`）。
   *      理由：规则进册那一刻，那些席位**已经在册**了 —— 它们只是"没投票"，不是"不该到"。
   *      把已在册的席位从应到里删掉，就是**用一条记录把缺席闸清零**（R904 那条路的根因）。
   *   ④ 于是 `majorityBase` 也不可能小于 `ruleFloor.length`。
   *   ⑤ **票的时刻早于规则进册时刻 ⇒ 账目自相矛盾 ⇒ 一律未决**（`accountContradiction`）：
   *      规则还不存在就有人投票，这份账在时间轴上不成立 —— 而它照旧被判「多数」，
   *      正是因为它把"首票时刻"当成了议题的起点（`_inferred` 由它推）。
   *      这条是审查给的**可机检判据**：RULES.jsonl 里 R904 自己的 `at` = 2026-09-24…，
   *      而票声称 2026-09-01 ⇒ 票早于规则存在。
   *
   * ⚠ **这条判据的边界（诚实标出，不许说大）**：
   *   · ③④ **不依赖票记录**：`ruleAt` 取自 `RULES.jsonl`（`appendRule` 用脚本自己的钟写的），
   *     `ruleFloor` 取自角色注册表的 `SEAT_ADDED_AT`。所以**手写 `VOTES.jsonl` 绕不过它** ——
   *     把 `roster` 写小 ⇒ 下限把那些席位补回应到；把 `at` 提前 ⇒ 下限仍按规则进册时刻算。
   *   · 它**能被绕过的路**是改 **`RULES.jsonl` 自己的 `at`**（把规则进册时刻也提前/改写）——
   *     那是另一条**还没修**的洞（AGENTS.md 机制洞清单里「直接改 `RULES.jsonl` 正文 → 旧票原样跟着」那条）。
   *     本判据只保证"**票记录单方面说了不算**"，**不保证"整本账被重写"也能查出来**。
   *   · ⑤ 是"票的 `at`"与"RULES.jsonl 的 `at`"**互相印证**：只改票的 `at` 会让它**报警**，
   *     不是绕过，是被抓住。
   *   · **老议题（非 `rule:` 议题）没有"进册时刻"可言** ⇒ ③④⑤ 对它们一律不生效，
   *     L15 的「加席位不追溯」一个字没动（`majorityBase` 仍然可以小于今天的 7 席 —— 那是设计要的）。
   */
  const _inferred = _firstAt === null
    ? VOTE_ROLES                              // 时间戳全读不到 ⇒ 退回旧行为，**不静默放宽**
    : VOTE_ROLES.filter((r) => (SEAT_ADDED_AT[r] ?? 0) <= _firstAt);
  const _voted = VOTE_ROLES.filter((r) => latest.has(r));   // 实际投了票的在册席位
  /**
   * ★ 判据③：规则议题的"进册时刻"（`ruleAt`）与它那一刻的在册席位（`ruleFloor`）。
   *   `ruleAt` = **同一个 id + 同一个 topic** 的记录里**最早**的那条的时刻。
   *   为什么取最早、不取最新：状态推进（试行/定稿）也是**追加**记录，每条都带自己的 `at`；
   *   取最新的话，一条已经推进过的规则再跑一次 `rule status`，就会被它**自己后来的记录**
   *   判成"票早于规则进册"（假阳性）—— 那是把正常操作判成作弊。
   *   取不到（不是 `rule:` 议题 / 规则册里没有这条 / `at` 读不出来）⇒ ③④⑤ 全部不生效，退回 P-M2 行为。
   */
  const _ruleM = /^rule:(.+?)(?:@\d+)?$/.exec(String(topic ?? ''));
  let ruleAt = null;
  let ruleFloor = [];
  if (_ruleM) {
    const rid = _ruleM[1];
    let best = null;
    for (const rec of readRuleRecords(dir)) {
      if (rec?.kind === 'revision') continue;          // 修订记录不是规则本身（`readRules` 同口径）
      if (String(rec?.id ?? '') !== rid) continue;
      if (String(rec?.topic ?? '') !== String(topic)) continue;
      const t = _ts(rec);
      if (t === null) continue;
      if (best === null || t < best) best = t;
    }
    if (best !== null) {
      ruleAt = best;
      ruleFloor = VOTE_ROLES.filter((r) => (SEAT_ADDED_AT[r] ?? 0) <= ruleAt);
    }
  }
  // 并集里只留**现在还有效**的席位（名单里写了但已从注册表删掉的名字会被剔掉，避免幽灵席位卡住）
  const _union = (a, b) => [...new Set([...(a ?? []), ...(b ?? [])])].filter((r) => voters.has(r));
  const _recorded = recordedRoster ? '票里记的' : (_firstAt === null ? '默认（时间戳读不到）' : '按席位加入时刻');
  const _baseRoster = recordedRoster ?? (_firstAt === null ? VOTE_ROLES : _inferred);
  const _rosterNoFloor = _union(_baseRoster, _voted);
  // ★ 判据③：再并上"规则进册那一刻的在册席位"。
  //   老议题的 `ruleFloor` 是空的 ⇒ 这一行对它们**一个字都没改**（L15「不追溯」照旧）。
  const roster = (() => {
    const r = _union(_rosterNoFloor, ruleFloor);
    return r.length ? r : VOTE_ROLES;             // 算空了 ⇒ 补回默认（不许把应到名单算成空）
  })();
  const _floorMattered = roster.length > _rosterNoFloor.length;
  const rosterFrom = !_rosterNoFloor.length
    ? '默认（应到名单算空了）'
    : (_floorMattered ? `${_recorded} + 规则进册时刻的在册席位（判据③的下限）` : _recorded);
  // ★ 过半闸的分母：三者取最大（`roster` 里已经含判据③的下限，所以它也 ≥ `ruleFloor.length`）。
  //   ⚠ **不是"只许变大不许变小"**（P-M2b 把这句话改掉了，它被 R904 那条路证伪过）——
  //     分母**可以**小于"今天在册的席位数"，那正是 L15 要的「加一席不追溯」（老议题按当时的名单）。
  //     它真正保证的只有两条：**不小于实际投票席位数**（判据②）、
  //     **不小于规则进册那一刻的在册席位数**（判据③④）。
  const majorityBase = Math.max(roster.length, _voted.length, _inferred.length, ruleFloor.length);
  const missing = roster.filter((r) => !latest.has(r));
  /**
   * ★ 判据⑤：票的时刻早于规则进册时刻 ⇒ **账目自相矛盾**（审查给的可机检判据）。
   *   只在 `rule:` 议题上判 —— 别的议题没有"规则进册时刻"这个东西。
   *   `voteAt` / `ruleAt` 用 ISO 字符串**原样给出**：让读的人自己复核，而不是听一句结论。
   */
  const accountContradiction = (ruleAt !== null && _firstAt !== null && _firstAt < ruleAt)
    ? { voteAt: new Date(_firstAt).toISOString(), ruleAt: new Date(ruleAt).toISOString() }
    : null;
  /** 判据③⑤ 的说明行（只在**真的起作用**时打出来，不给干净议题添噪音） */
  const accountNote = (() => {
    const parts = [];
    if (ruleAt !== null && _floorMattered) {
      parts.push(`本议题是规则议题：规则 ${topic} 进册时刻 ${new Date(ruleAt).toISOString()}，`
        + `那一刻在册席位 ${ruleFloor.length} 席 —— **应到名单不许低于它**`
        + `（这条下限来自 ${RULES_FILE} 与角色注册表，**不来自票记录**）。`);
    }
    if (accountContradiction) {
      parts.push(`票的时刻 ${accountContradiction.voteAt} **早于**规则进册时刻 ${accountContradiction.ruleAt}`
        + ' —— 规则还不存在就有人投票，这是**自相矛盾的账**：按票里记的名单算，'
        + '等于把当时已在册、只是没投票的席位从"应到"里删掉。');
    }
    return parts.length ? parts.join(' ') : null;
  })();
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const tied = top.length > 1 && top[0][1] === top[1][1];
  const unclear = cast.filter((v) => !String(v.reason ?? '').trim() || String(v.reason).trim().length < 10);
  // 「异议必须被回应」—— 实测教训：3:2 的多数是靠**程序理由**（证据/可复算/别烦用户）赢的，
  // 而两张反对票是**实质风险**（会丢用户原话 / 会丢掉整条支线）。多数票根本没回应它们。
  // 所以：**有反对票而没人回应 → 不算定**，交给脑子继续想。反对票的担忧常常是对的。
  const winner = top[0]?.[0];
  const dissenters = cast.filter((v) => v.choice !== winner);
  /**
   * 「异议必须被回应」—— 实测教训：3:2 的多数是靠**程序理由**（证据/可复算/别烦用户）赢的，
   * 而两张反对票是**实质风险**（会丢用户原话 / 会丢掉整条支线）。多数票根本没回应它们。
   * 所以：**有反对票而没人回应 → 不算定**，交给脑子继续想。反对票的担忧常常是对的。
   *
   * ⚠ **实测洞（2026-09-16 由「审查」跑出来，现修）**：原来只收"谁的名字被点到"，
   *   于是**反对者自己补一票带 `--address 自己`** 就能把自己的异议标记成"已回应" ⇒
   *   `未决` 立刻变成 `多数：同意`、exit 1 → exit 0。
   *   **"异议未回应即未决"可以被异议方自己绕过** —— 这条闸门等于白装。
   *   改法：`--address` 记的是"**我在回应谁**"，所以按 **收件人 → 谁回应了它** 收；
   *   一个异议若**只被它自己回应过**，仍然算**未回应**。
   *   （想撤回异议是另一件事，而且是允许的：**重新投一票把 choice 改成同意** —— 那是明确的、
   *     有据可查的改主意，不是偷偷把自己的异议标记成"已回应"。）
   */
  const addressedBy = new Map();      // 收件人角色 → 回应过它的角色集合
  for (const v of all) {
    if (!v.address) continue;
    for (const r of String(v.address).split(/[,，、]/)) {
      const k = r.trim(); if (!k) continue;
      if (!addressedBy.has(k)) addressedBy.set(k, new Set());
      addressedBy.get(k).add(v.role);
    }
  }
  const selfAddressed = [];           // 只被自己"回应"过的异议（**不算解决**，但要说出来）
  const unaddressed = [];
  for (const v of dissenters) {
    const who = addressedBy.get(v.role);
    if (!who) { unaddressed.push(v.role); continue; }
    const byOthers = [...who].filter((x) => x !== v.role);
    if (!byOthers.length) { selfAddressed.push(v.role); unaddressed.push(v.role); continue; }
  }
  /**
   * ★ **过半闸**（2026-09-24，「记录」角色算出来的洞 —— 加在第 -1 步）：
   *   状态机原来**只有四支**，末支是**裸的** `多数：${winner}`，全文 `过半|半数|majority` **0 命中**
   *   ⇒ **没有任何"过半"判据**。可复现的反例（静态可复算）：
   *     7 票投 A=2 / B=1 / C=1 / D=1 / E=1 / F=1 ⇒ `top[0][1]=2 ≠ top[1][1]=1` ⇒ `tied=false`；
   *     missing=0；理由都 ≥10 字；5 张异议票各自**被别人** `address` 过 ⇒ `unaddressed=[]`
   *     ⇒ 走到裸「多数：A」，而 A 只有 **2/7 = 28.6%**，design 议题 **exit 0**。
   *   ⇒ **机制会在 2/7 票时宣布"多数"。**
   *
   *   判据：`winner` 的票数必须**严格过半**（`> majorityBase / 2`）。分母是**本议题当时的应到名单**
   *   （`roster` —— 加一席不追溯，见上面那一段），**不是实到票数**：
   *   分母取实到的话"3 人投票、2 票同意"就成了 66% 的多数 —— 那正是把**缺席当成同意**。
   *
   *   ⚠ **P-M2 补（判据本身的洞）**：P-M1 的分母直接用了 `roster.length`，而 `roster` 在
   *     "票里记了 `roster` 字段"时**照票记录**、否则**按首票时刻推** —— 两条路都能把分母改小
   *     （手写小名单 / 只改 `at` 时间戳），于是 `2/7`、`3/7` 又能被宣布成"多数"。
   *     现在分母改用 `majorityBase`（= 应到名单、**实际投票席位数**、按加入时刻推出的名单 三者取最大；
   *     判据与"为什么不会误伤老议题"写在上面 roster 那一段里）。
   *     这**不是**放宽、也不是收紧老议题：老议题首票时刻早 ⇒ 推出来的就是当时那 5 席 ⇒ 分母仍是 5。
   *
   *   ⚠ 四支老分支的**措辞一个字都没改**（缺席·未决 / 平票·未决 / 有票没理由·未决 /
   *     `多数：X（异议未回应：…）· 未决`）。过半闸只**插在宣布"多数"之前**：
   *     没过半时不许说"多数"，改说「未决·分歧」。
   */
  const winCount = counts[winner] ?? 0;
  const majorityNeeded = Math.floor(majorityBase / 2) + 1;
  const hasMajority = winCount > majorityBase / 2;
  let state;
  if (missing.length) state = '缺席·未决';
  else if (tied) state = '平票·未决';
  else if (unclear.length) state = '有票没理由·未决';
  else if (!hasMajority) state = `未决·分歧（最高票 ${winner} 只有 ${winCount}/${majorityBase}，未过半；过半要 ${majorityNeeded} 票）`;
  else if (unaddressed.length) state = `多数：${winner}（异议未回应：${unaddressed.join('、')}）· 未决`;
  else state = `多数：${winner}`;
  /**
   * ★ 判据⑤的**闸门**：账目自相矛盾（票的时刻早于规则进册时刻）⇒ **无论上面算出什么，一律未决**。
   *   为什么它必须是独立闸门、而不是只写进注释：
   *   上面那四支里有一支是**裸的** `多数：${winner}` —— 一份"7 席全在规则进册之前就投了同意"的
   *   手写账能顺着那一支走到 `多数`（`missing=0`、没过半也不成立），于是 `advanceRule` 会**落盘成「试行」**。
   *   加上这一条，它才真的推不动（`ruleUnresolved` / `pendingRuleAdvances` 也各有一支认它）。
   *   ⚠ **不改上面四支的措辞**（老用例的断言一个字没动）—— 只在后面**追加**一句；
   *     已经未决的（缺席/平票/…）保留原文，读的人仍然看得到"最直接的那条原因"。
   */
  if (accountContradiction) {
    state = /未决/.test(state)
      ? `${state}（另：票的时刻早于规则进册时刻 —— 账目自相矛盾）`
      : '未决·账目自相矛盾（票的时刻早于规则进册时刻）';
  }
  // 分母被抬高的情形要**说出来**（透明：读的人得知道"应到名单"和"过半闸分母"为什么不是同一个数）
  /**
   * ⚠ **P-M2b 改措辞**：原来这句写的是「分母**只许变大不许变小**」——
   *   而 R904 那条路**证伪了它**（分母确实被缩到 5 过：`max(3, 3, 5)`）。
   *   现在只说它**真正保证的两条**，并明写它**可以**变小到哪儿 —— 宁可说得窄，不说一句自己做不到的话。
   */
  const majorityBaseNote = majorityBase > roster.length
    ? `过半闸的分母是 ${majorityBase}，而应到名单只有 ${roster.length} 席（来源：${rosterFrom}）——`
      + ` 实际投票的在册席位 ${_voted.length} 席、按加入时刻推出 ${_inferred.length} 席。`
      + ` 分母真正保证的只有两条：**不小于实际投票席位数**（${_voted.length}）、`
      + `**不小于规则进册那一刻的在册席位数**（${ruleFloor.length}）—— 比它们小就等于一张票当两张用。`
      + ` ⚠ 它**可以**小于"今天在册的 ${VOTE_ROLES.length} 席"（那是「加一席不追溯」要的，老议题按当时的名单）；`
      + ' 所以"分母只许变大不许变小"这句**是错的**，已经删掉（P-M2b：实测被缩到 5 过）。'
    : null;
  // 只被自己"回应"过的异议：单列一句 —— 不许让"自己给自己解除异议"看起来像已回应
  const selfAddressedNote = selfAddressed.length
    ? `异议只被它自己"回应"过（**不算解决**，异议方必须由别人回应）：${selfAddressed.join('、')}`
    : null;
  // 没有投票权的席位出声了 ⇒ 单独挂一个字段，**不许假装没看见**
  // （讨论C：`AI测试用户` 压不过多数，但**不能被静默忽略**）
  // ⚠ 故意**不并进 `state`** —— `state` 是计票状态机的输入，往里塞展示文字是 muddle；
  //   另外 `advanceRule` 会把它写进台账的 transition，所以"出声"这件事仍然落进记录里。
  const outsiderNote = outsiders.length
    ? `无权席位已出声（不计票）：${[...new Set(outsiders.map((v) => `${v.role}=${v.choice}`))].join('、')}`
    : null;
  // 附条件的票：**同意是自愿给的，条件不能被吞**。单独列出来，
  // 推进规则时用它拦住"条件丢了、票照算"（实测：19 条规则里 18 条附了硬边界，tally 只认 choice）。
  const conditionalVotes = cast.filter((v) => String(v.conditions ?? '').trim());
  return {
    topic, state, counts, votes: cast, missing, roster, rosterFrom, outsiders, outsiderNote,
    tied, unclear, options, winner, dissenters, unaddressed, selfAddressed, selfAddressedNote,
    // 过半闸的见证数据（**机读字段** —— 别让消费者去解析 `state` 里那句话）
    winCount, majorityNeeded, hasMajority,
    // ★ 过半闸的**分母**（P-M2）：`roster` 管"缺席"，`majorityBase` 管"过半" —— 两个数分开报，
    //   消费者（ruleUnresolved / unresolvedFixes / pendingRuleAdvances）一律读 `majorityBase`。
    majorityBase, majorityBaseNote,
    // ★ 判据③④⑤ 的见证数据（P-M2b，**机读** —— 别让消费者去解析 `state` 里那句话）：
    //   `ruleAt`            规则（该修订）进册时刻的毫秒戳；不是规则议题 / 取不到 = null
    //   `ruleFloor`         那一刻的在册席位（应到名单的下限；老议题 = []）
    //   `accountContradiction`  {voteAt, ruleAt}（ISO）—— 票早于规则进册；没有 = null
    //   `accountNote`       给人读的说明行（只在判据真的起作用时非空）
    ruleAt, ruleFloor, accountContradiction, accountNote,
    conditional: conditionalVotes.map((v) => v.role), conditionalVotes,
  };
}

/**
 * ==================== 「未决」的消费者（照 B4 可满足性护栏接线） ====================
 *
 * ★ 实测洞（2026-09-24，「支线守门员」复算出来的）：机制**已经**会把它判成「未决」
 *   （缺席 / 平票 / 有票没理由 / 异议未回应），却**没有任何东西把"未决"绑到"实施"那一步** ——
 *   `advanceRule` 只在 `rule:<id>@<n>` 这条路径上被调（见 `vote cast` 里那个 `rm` 分支），
 *   **design 议题没有任何推进/实施挂钩** ⇒ 机制说了"未决"、照样通电。
 *   **这正是事故 I60 的形状**（一条**不可满足**的红接成了 steer：干活再多也不会变绿 ⇒ 只能一直试）。
 *
 * 所以按 **B4 可满足性护栏**接线：`vote --topic` 的输出里，**每条"未决"都附一条
 * "现在就能跑、跑完这条原因就没了"的命令**；**给不出可跑命令的 ⇒ 明写「这是不可满足的未决」**
 * （不许只印一句"交给脑子继续想"就完事）。
 *
 * ⚠ **只接线，不造权**：不给任何角色否决权，只把"哪条路能解除"摆到台面上。
 * ⚠ **不动 `advanceRule` 的 `rule:` 路径**（那是另一个议题）。
 * ⚠ 命令里的 `…` 是**要人来填的判断**（投什么 / 为什么），**不是**脚本替他们签字 ——
 *   角色分权与"票必须带理由"这两条判据一个字都没变。
 *
 * 返回**要打印的行**（数组）。它只读 tally 的结果：不写盘、不改台账、不返回值。
 */
export function unresolvedFixes(topic, t) {
  const q = (s) => `"${String(s ?? '')}"`;
  const cast = (role, choice, reason, extra = '') =>
    `node warden.mjs vote cast --topic ${q(topic)} --role ${role} --choice ${choice} --reason ${reason}${extra}`;
  const out = [];
  const counts = t.counts ?? {};
  const roster = t.roster ?? VOTE_ROLES;
  const votes = t.votes ?? [];
  const winner = t.winner;
  const winCount = counts[winner] ?? 0;
  /**
   * ★ 过半需要几票 —— 分母用 `majorityBase`（P-M2），**不是** `roster.length`：
   *   两者在"票里记了更小的名单"这类情形下会不一样（`roster` 管缺席、`majorityBase` 管过半），
   *   分母取小了会给出"差 0 票"这种自相矛盾的解除建议。两个数相等时输出与以前**逐字相同**。
   */
  const base = Number.isFinite(t.majorityBase) ? t.majorityBase : roster.length;
  const need = Math.floor(base / 2) + 1;               // 过半需要几票（严格过半：> base/2）
  const missing = t.missing ?? [];
  const halfShort = winner !== undefined && winCount < need;

  // ① 缺席 —— 补那一席的票：**一跑就少一席缺席**（最便宜的一条）
  for (const role of missing) {
    out.push(`    · 缺席「${role}」→ 补它的票（投什么是**这一席自己的选择**，脚本不替它投）：`);
    out.push(`      ${cast(role, '"同意|反对|…（它自己的选择）"', '"…（理由 ≥10 字，落在它的职责里）"')}`);
  }
  // ② 平票 —— 让并列的一项里某一席**重新投票**改选另一项（后投的覆盖先投的，票数一跑就变）
  if (t.tied) {
    const topN = Math.max(...Object.values(counts));
    const tiedOpts = Object.entries(counts).filter(([, n]) => n === topN).map(([c]) => c);
    const from = tiedOpts[0];
    const to = tiedOpts[1];
    const mover = votes.find((v) => v.choice === from);
    if (mover) {
      out.push(`    · 平票（${JSON.stringify(counts)}）→ 让并列的一项里某一席**重新投票**改选另一项`
        + `（后投的覆盖先投的，一跑票数就变${need - winCount > 1 ? '；⚠ 改一票只是**不平票**，可能还没过半 —— 见下面那条' : '；改一票就过半'}）：`);
      out.push(`      ${cast(mover.role, q(to), `"我改主意了：改投 ${to}，理由是 …（≥10 字）"`)}`);
      out.push(`      （它现在投的是 ${from}；**这一席必须自己愿意改**，脚本不替它改）`);
    } else {
      out.push('    · 平票 → **判断不了**哪一席能改投（票里读不到并列项的具体投票人）—— 别猜。');
    }
  }
  // ③ 有票没理由 —— 同一席**重新投同一票 + 补理由**（后投的覆盖先投的，一跑就解除）
  for (const v of (t.unclear ?? [])) {
    out.push(`    · 没理由「${v.role}」（它现在投的是 ${v.choice}）→ 重投同一票、把理由补上：`);
    out.push(`      ${cast(v.role, q(v.choice), '"…（≥10 字：为什么这么投，落在它的职责里）"')}`);
  }
  // ④ 异议未回应 —— 由**别人** `--address` 回应它（自己回应自己不算，见 tallyVotes 那一段）
  for (const role of (t.unaddressed ?? [])) {
    const who = votes.find((v) => v.choice === winner && v.role !== role);
    if (who) {
      out.push(`    · 异议未回应「${role}」→ 由**别人**回应它（自己回应自己不算）：`);
      out.push(`      ${cast(who.role, q(winner), `"回应 ${role} 的异议：…（逐条答复它的担忧）"`, ` --address ${q(role)}`)}`);
    } else {
      out.push(`    · 异议未回应「${role}」→ **判断不了**该由谁回应（票里找不到投「${winner}」的别人）—— 别猜。`);
    }
  }
  // ⑤ 未过半（新加的闸）—— 最高票没到 `majorityBase/2` 以上
  if (halfShort) {
    const gap = need - winCount;
    out.push(`    · 未过半（最高票 ${winner}=${winCount}/${base}，过半要 ${need} 票）→`);
    if (missing.length) {
      out.push(`      **现在还判断不了**：有 ${missing.length} 席缺席，它们投完可能就过半了 ——`);
      out.push('      先把上面那些缺席的票补上，再回来看这一条（缺席还没补齐时不许说"不可满足"）。');
    } else if (gap === 1 && !t.tied) {
      const donor = votes.find((v) => v.choice !== winner);
      if (donor) {
        out.push(`      差 **1 票**：让**别人**改投「${winner}」就过半（一条命令，跑完这条原因就没了）：`);
        out.push(`      ${cast(donor.role, q(winner), `"我改主意了：改投 ${winner}，理由是 …（≥10 字）"`)}`);
      } else {
        out.push('      **判断不了**该由谁改投（票里找不到投别的选项的人）—— 别猜。');
      }
    } else if (gap === 1) {
      out.push('      差 **1 票** —— 上面那条"改投"跑完就**同时**解掉平票与未过半（不用再来一条）。');
    } else {
      out.push('      **这是不可满足的未决**：一条命令解除不了它 ——');
      out.push(`      要让「${winner}」涨到 ${need} 票，至少得 **${gap} 席同时改投**同一选项`
        + '（改一席最多 +1，仍不过半）；计票器里没有"替他们改"的命令。');
      out.push('      真实的路只有两条（都不在计票器里）：① 重开一个**选项收敛**的议题'
        + '（选项先由角色提名，别再让一个人写候选集）；② 派脑子复审，让它给一个不违反任何条件的收敛方案。');
    }
  }
  // ⑥ 账目自相矛盾（P-M2b）—— 票的时刻早于规则进册时刻
  /**
   * 这一支**给不出"跑完这条原因就没了"的命令**，因为问题不在票的多少，而在**账的时间轴**。
   *
   * ⚠ **P-M3 修（2026-09-24，「审查」的 remedy.mjs 实测出建议①按字面跑不通，原样输出见任务书）**：
   *   原来这里写「① 把票**重新投一次**（新写进去的记录带新的 `at`，会落在规则进册之后）」——
   *   **那条路跑不通**：`VOTES.jsonl` 是 **append-only**，重投只是**追加**记录，
   *   而"票的时刻"取的是**最早那条** ⇒ 早票永远留着、账目自相矛盾照旧。
   *   实测：按建议①用 `vote cast` 重投那 3 席 ⇒ exit 1、**仍含**"账目自相矛盾"；
   *        7 席全部重投一遍 ⇒ exit 1、**仍含**"账目自相矛盾"；
   *        而建议②（`rule amend` 开新修订号）⇒ 新议题上 exit 0、**不含**"账目自相矛盾"。
   *   ⇒ 按 A6 把这一支如实分成两半：**本议题这一支不可满足**（给不出可跑命令，明写出来），
   *     出路只有"换议题"那条 —— 而且它**不是**"补一票"，是换一个议题重新开账。
   *   ⚠ 「手改 `VOTES.jsonl` 删掉旧记录」**能**让这句话消失，但计票器**没有这条命令**；
   *     而且那正是 P-M2/P-M2b 要防的"手写票记录改变结论" ⇒ **不把它算作合法出路**（这里如实写出来，
   *     是为了不假装"没有这条路"，不是推荐它）。
   */
  if (t.accountContradiction) {
    out.push(`    · 账目自相矛盾（票的时刻 ${t.accountContradiction.voteAt} 早于规则进册时刻 ${t.accountContradiction.ruleAt}）→`);
    out.push('      **这是不可满足的未决：本议题给不出"跑完这条原因就没了"的命令**'
      + '（A6 —— 给不出可跑命令的，明写出来，不编一条跑不通的）。');
    out.push('      补票 / 改投 / **重投**都解不掉它：这份账在时间轴上不成立（规则还不存在就有人投票），');
    out.push('      而"票的时刻"取的是**该议题在册席位记录里最早的那一条**，`VOTES.jsonl` 又是 append-only ⇒ 旧记录永远留着。');
    out.push('      ⚠ 这里原来写的「① 把票**重新投一次**（新记录带新的 `at`）」—— **实测跑不通**，已经删掉。');
    out.push('      ⚠ 「手改 `VOTES.jsonl` 删掉旧记录」**能**让它消失，但计票器没有这条命令，'
      + '而且那正是要防的"手写票记录改变结论" —— **不算合法出路**。');
    out.push('      唯一真实的出路（不是补一票，而是**换一个议题重新开账**）：');
    out.push(`        ① 重开一个修订号：\`node warden.mjs rule amend --id … --text "…"\` ⇒ 新议题 \`rule:<id>@<n+1>\` 从新的时刻开始，`);
    out.push('           **再在新议题上把票投一遍**；旧议题（`@<n>`）那份账**原样留着**，不假装它被修好了。');
  }
  // A6：**输入为 0 不许报成功** —— 走到这里一条都没给出来，说明"未决原因没被覆盖"，那是接线漏了
  if (!out.length) {
    out.push('    （这一支没给出命令 —— 说明有未决原因没被这里覆盖，那是**接线漏了**，别当它已解除）');
  }
  return out;
}

// ------------------------------------------------------------------ 规则册（可投票的规则）
/**
 * 规则不是一次定终身的，它是**可投票**的：
 *   · 一条规则必须有**指得到的证据**（`INCIDENTS.jsonl` 里的事故 id，或 lab 里的实验 L1、L6、L9、L10 这种）才许进册；
 *   · 状态按五个角色的票**机械推进**：`提案` → `试行` →（显式 `--promote`）`定稿` / `否决` / `废止`；
 *   · 平票 / 缺席 / 有异议没被回应 → **一律不变**，交回脑子继续想（脚本只算数，不做价值判断）。
 *
 * 为什么每条必须**诚实**标 `enforced`：
 *   `code` = 有 exit code / 脚本在拦它（**投票改不掉，改它要改代码**）
 *   `text` = 只是约定（**它没被强制，别假装它被强制**）
 * 一条只写在文本里、没有任何程序拦它的规则**不会被执行** —— 这是这个 skill 反复踩的坑。
 * 所以 `rules` 把两类分开列，并把「文本规则占比」当成要盯的指标打出来。
 */
const RULES_FILE = 'RULES.jsonl';

/* ==========================================================================
 * 补丁块 A —— 常量与插件解析（插在 warden.mjs 的 `const RULES_FILE = ...` 附近）
 * ========================================================================== */

/**
 * ★ 怎么找到 `handover-gate.js` —— **先问真源，再退回候选**。
 *
 * ⚠ 第一版写死三个"猜的"位置（`$DSH_HOME/plugin` 等），**实测全部落空**：
 *   `.dsh` 底下**根本没有** `plugin` 目录，那份文件不在 `$DSH_HOME` 里。
 *   ⇒ 这就是"不许猜"的现场：猜出来的三条路**一条都不通**，命令一律拒收。
 *   真源是 **`cordis.patch.yml` 里那一行 `name:`**（本机 =
 *   `<WORKSPACE>/task-warden/plugin/handover-gate.js`）—— 实测：
 *     `<HOME>\.dsh\profiles\desktop\cordis.patch.yml:118-119`
 *       `- id: handover-gate`
 *         `name: <WORKSPACE>/task-warden/plugin/handover-gate.js`
 *   ⇒ 所以顺序是：**① 读 patch yml 里点名的那一份**（真源），
 *     **② 环境变量 `WARDEN_HANDOVER_GATE`**（显式覆盖，给别的机器用），
 *     **③ 与 `warden.mjs` 同目录的那一份**（同源副本，公开包里就是它）。
 *   三条都不通 ⇒ **拒收 exit 2 并列出找过哪些**，**绝不退回"猜一份常量"**。
 */
export function candidatePaths() {
  const out = [];
  const env = String(process.env.WARDEN_HANDOVER_GATE || '').trim();
  if (env) out.push(env);
  // ① 真源：本机 profile 的 cordis.patch.yml 里点名的那一行
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  for (const prof of ['desktop', 'web', 'headless']) {
    const yml = path.join(dshHome, 'profiles', prof, 'cordis.patch.yml');
    try {
      if (!fs.existsSync(yml)) continue;
      const txt = String(fs.readFileSync(yml, 'utf8'));
      // 抓 `- id: <x>` 与紧随的 `name:`，只认名字里带 handover-gate 的那一条
      const re = /-\s*id:\s*([^\s]+)\s*\r?\n\s*name:\s*([^\r\n]+)/g;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const name = m[2].trim();
        if (!/handover-gate/i.test(name)) continue;
        const p = path.isAbsolute(name) ? name : path.resolve(path.dirname(yml), name);
        if (out.indexOf(p) < 0) out.push(p);
      }
    } catch (e) { /* 读不动这个 profile 就试下一个 */ }
  }
  // ③ 与 warden.mjs 同目录的那一份（skill 目录里若随包发了副本）
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const p = path.join(here, 'handover-gate.js');
    if (out.indexOf(p) < 0) out.push(p);
  } catch (e) { /* 记不上就算了 */ }
  return out;
}

const HANDOVER_LEDGER_NAME = 'HANDOVER-GATE.jsonl';

/**
 * 解析 `handover-gate.js` 并取出 `_internals`。
 * 返回 `{ ok:true, I, from }` 或 `{ ok:false, why, tried:[...] }`（**绝不抛**）。
 */
export function loadHandoverGate() {
  const tried = [];
  let require_ = null;
  try {
    require_ = createRequire(import.meta.url);
  } catch (e) {
    return { ok: false, why: 'createRequire 不可用：' + String((e && e.message) || e), tried };
  }
  for (const p of candidatePaths()) {
    tried.push(p);
    try {
      if (!p || !fs.existsSync(p)) continue;
      const m = require_(p);
      const I = m && m._internals;
      if (!I || typeof I.buildAutoDraft !== 'function' || typeof I.isHandoverName !== 'function') {
        return { ok: false, why: `找到了 ${p}，但它没有 _internals.buildAutoDraft / isHandoverName（版本不匹配？）`, tried };
      }
      return { ok: true, I, from: p };
    } catch (e) {
      // 单个候选坏了就试下一个；全坏了才报
      tried[tried.length - 1] = `${p}  —— 载入失败：${String((e && e.message) || e)}`;
    }
  }
  return { ok: false, why: '没有任何一条路能拿到 handover-gate.js（真源 = cordis.patch.yml 里点名的那个 name）', tried };
}
export const RULE_STATUSES = ['提案', '试行', '定稿', '否决', '废止', '待并条件'];
export const ENFORCED_KINDS = ['code', 'text'];
const RULE_YES = '同意';
const RULE_NO = '反对';
export const RULE_PENDING_CONDITIONS = '待并条件';

/** 在册生效的（能算进"文本规则占比"的）状态 —— 已否决/已废止不算 */
const RULE_LIVE = new Set(['提案', '试行', '定稿', RULE_PENDING_CONDITIONS]);

/** 某个议题是不是「全员同意且零反对」—— 零反对有两种解释：①规则确实好 ②角色在顺从 */
export function unanimousNoDissent(t) {
  if (!t || t.state === '没有投票' || !t.votes.length) return false;
  if (t.missing.length || t.tied) return false;
  // ★ 用**议题当时的应到名单**（t.roster），不是**今天的** VOTE_ROLES。
  //   实测教训：`VOTE_ROLES = Object.keys(ROLE_REMIT)`，从 5 席加到 7 席之后，
  //   老议题永远凑不齐 7 票 ⇒ 一律返回 false ⇒ 「全员同意且零反对」这条判据
  //   对**所有已有议题**失效（不是变得严格，是变成死代码）。
  //   加一席的作用应该是"以后的新议题要多问一个人"，不是"追溯作废过去的判决"。
  /**
   * ⚠ **未申报的行为改动 —— P-M2b 如实申报（任务书第 2 条）**：
   *   `t.roster` 在 P-M2 里从"票里记的名单"变成了**并集**
   *   （票里记的 ∪ 实际投票的在册席位 ∪ 规则进册时刻的下限），这一行的语义跟着变了。
   *   实测那类旧场景：**「票里记了 5 席 + 今天 7 席都投了票」** ——
   *     · P-M2 之前：`roster` = 记录的 5 席 ⇒ `need = 5`、`votes.length = 7` ⇒ **false**；
   *     · P-M2 之后：`roster` = 并集 7 席 ⇒ `need = 7`、`votes.length = 7` ⇒ **true**。
   *   即：**从 false 变 true**（"零反对·疑似顺从"这条审查标记会亮起来）。
   *
   *   **选择：申报，不改回去**。理由（三条，都可复核）：
   *     ① 它**不控制推进**，只控制"疑似顺从"这条**审查标记**
   *        （`suspicionFlag` / `zeroDissentDetail` / `rulesView` 的 flags）——
   *        方向是**更严**（多要一次说明），不是更松，不会放过任何东西；
   *     ② 并集正是本文件现在认定的"应到名单"（判据①③）。一边不信任"票里记的小名单"、
   *        一边又拿它当 `need`，就是**同一个数在两处用两套口径** —— 那正是 P-M2 要治的病；
   *     ③ 并集语义下这一行是**恒等**的：`missing` 为空 ⇒ `roster ⊇ votes`（并集性质）
   *        且 `roster ⊆ votes`（没有缺席）⇒ `roster.length === votes.length`。
   *        改回"记录名单"会造出一个**与缺席判据互相矛盾**的分支（缺席闸说 0，这一行说没齐）。
   */
  const need = Array.isArray(t.roster) ? t.roster.length : VOTE_ROLES.length;
  if (t.votes.length !== need) return false;
  return t.votes.every((v) => v.choice === RULE_YES);
}

/** 有没有人写明"我为什么没有反对"（写在 --address 里）—— 没有就是"写不出来" */
export function dissentExplained(t) {
  return (t?.votes ?? []).filter((v) => String(v.address ?? '').trim());
}

/**
 * ==================== 「角色是不是摆设」的机械仪表 ====================
 *
 * 用户 2026-09-16 的原话（逐字）：「（用户原话已隐去 —— 公开版不留逐字）」
 *   「**监督员要保证几个角色是正确在运行。**」
 *
 * 所以"呈现"和"摆设"的差别**必须可机检**，否则又是一句文本期望。这里只算数，判据分两类，
 * 并且**在输出里逐条标明哪一类**（把代理判据说成硬判据，就是这套东西最该防的病）：
 *
 *   【硬】票数 / 反对数 / 反对率 / 附条件数 / 缺席议题数 —— 全部来自 `VOTES.jsonl`，可逐条复算。
 *   【代理】"独有项"：同一议题里，把某个角色的理由与**别的角色**的理由比，
 *          归一化后**字符二元组 Jaccard ≥ 0.8** 就算"同构"。
 *          ⚠ 这是**代理**判据 —— 文字不像 ≠ 观点真的独立；文字像 ≈ 它没提供独立视角。
 *            真实的"提不出来"要靠人读（§一 ①②④ 的原始判据是语义的）。
 *
 * 由它产出监督员**唯一被用户指定过的那一行**（§6.1 逐字给的形态）：
 *   角色在跑：7/8 有效（方向员本轮无独有项 → 未提供独立视角）
 *   **连续 3 个议题某角色都没有独有项 ⇒ 报「该角色当前是装饰」。**
 */
export function rolesHealth(dir, { minVotes = 8, windowTopics = 3, similarThresh = 0.8 } = {}) {
  const votesAll = readVotes(dir).filter((v) => VOTE_ROLES.includes(v.role));
  /** 归一化：去掉空白与标点，只留字与数字（不同角色用不同标点不该算"不同观点"） */
  const norm = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
  const bigrams = (s) => { const o = new Set(); for (let i = 0; i + 1 < s.length; i += 1) o.add(s.slice(i, i + 2)); return o; };
  const similar = (a, b) => {
    const x = norm(a); const y = norm(b);
    if (x.length < 8 || y.length < 8) return false;          // 太短的不判（不许拿"同意"两个字判同构）
    const A = bigrams(x); const B = bigrams(y);
    if (!A.size || !B.size) return false;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter += 1;
    return inter / (A.size + B.size - inter) >= similarThresh;
  };
  // 议题按"首次出现时间"排序（越后越新）—— 用来算"连续 N 个议题"
  const firstAt = new Map();
  for (const v of votesAll) {
    const t = Date.parse(String(v.at ?? ''));
    const cur = firstAt.get(v.topic);
    if (cur === undefined || (Number.isFinite(t) && t < cur)) firstAt.set(v.topic, Number.isFinite(t) ? t : 0);
  }
  const topics = [...new Set(votesAll.map((v) => v.topic))]
    .sort((a, b) => (firstAt.get(a) ?? 0) - (firstAt.get(b) ?? 0));
  const perTopic = new Map();
  for (const t of topics) perTopic.set(t, votesAll.filter((v) => v.topic === t));
  const findings = (() => { try { return readFindings(dir).items; } catch { return []; } })();
  /**
   * ★ 按**轮次**的"连续 N 轮无产出"判据（2026-09-17 加；「审查」实测指出原判据不可判）。
   *
   * 病根：原来只有"连续 N 个**议题**无独有项"这一条，而本账只有 **2 个议题** < windowTopics(3)
   *   ⇒ `tailNoUnique >= 3` **恒为假**，那条 flag 永远不会亮 —— 一个"永远不会触发"的检查
   *   等于没有检查（同 I47 那类"看着有、其实不响"）。
   * 现在补一条**与议题无关**的硬判据：从账本最后一轮往回数，**最近 N 轮里这个角色一条产出都没有**
   *   （产出 = 投过票 或 有一条发现台账）⇒ 它是装饰。
   *   · 产出按**时间**算（票的 at / 发现的 at），轮次按 ROUNDS.jsonl 的 at 排序；
   *   · **账本本身少于 windowRounds 轮时不许报**（那只是"还没轮到"）。
   * 口径写进返回值，外面能复算。
   */
  const roundsAll = (() => { try { return readRounds(dir); } catch { return []; } })();
  const roundTimes = roundsAll.map((r) => Date.parse(String(r.at ?? '')) || 0).filter((t) => t > 0);
  const totalRounds = roundTimes.length;
  const lastOutAt = new Map();
  for (const v of votesAll) {
    const t = Date.parse(String(v.at ?? '')) || 0;
    if (!t) continue;
    const cur = lastOutAt.get(String(v.role)) ?? 0;
    if (t > cur) lastOutAt.set(String(v.role), t);
  }
  for (const f of findings) {
    const t = Date.parse(String(f.at ?? '')) || 0;
    if (!t) continue;
    const who = String(f.by ?? '').trim();
    const cur = lastOutAt.get(who) ?? 0;
    if (t > cur) lastOutAt.set(who, t);
  }
  const windowRounds = 3;
  /**
    * ★★ 2026-09-17 **重新设计**（两个「脑子」独立审完、结论一致；用户反馈：
    *    一次零星产出就触发 6 个角色报警是噪音，让脑子思考为什么要报警。）
   *
   * 被证伪的旧判据（两条，都留档以免重犯）：
   *   ① 「一条产出都没有」—— 对 `AI测试用户` **恒真**（`vote:false` + 无 `finding` 渠道 +
   *      本函数又不读 `ROLE_SPEECH`），而 `effective` 的分母含它 ⇒ **上限 7/8，"8/8" 结构上不可达**。
   *      一个永远红的判据不能当闸（谁接进 check/CI 就永久红）—— 事故 I50。
   *   ② 「最近 N 轮无产出（且别人在产出）」—— 它测的是**有没有产出通道**，不是**有没有干活**：
   *      判据要求"别人在干"，于是**全席停摆时必然沉默**（停产不能被发现）；
   *      又把"别人"**跨渠道**比（有 finding 渠道的人算"活"，投票角色背锅）⇒ <另一个工程> 假阳性 5 条。
   *      它还是个阈值悬崖：工作区账本里**一个发现就让 1/8 ↔ 7/8 翻转，角色行为一个字节没变**。
   *
   * 新设计（三件事，全部可复算）：
   *   甲、**有活可干才算**：活 = 窗口内**新首投的议题**；窗口内 0 个新议题 ⇒ 投票席位不计分、不判缺席。
   *   乙、**判据 = 缺席哪条活**（见下面行内注释）。
   *   丙、**无产出渠道的席位不进分母、不报警**，单列成设计事实。
   *   丁、**全线停摆单独报**：窗口内全席 0 产出 ⇒ 报"全线停摆"，而不是"7/8 有效"。
   */
  const boundary = totalRounds >= windowRounds ? roundTimes[Math.max(0, totalRounds - windowRounds)] : null;
  const topicsInWindow = boundary === null ? [] : topics.filter((t) => (firstAt.get(t) ?? 0) >= boundary);
  const productionsInWindow = (() => {
    if (boundary === null) return 0;
    let n = 0;
    for (const v of votesAll) if ((Date.parse(String(v.at ?? '')) || 0) >= boundary) n += 1;
    for (const f of findings) if ((Date.parse(String(f.at ?? '')) || 0) >= boundary) n += 1;
    return n;
  })();
  const stalled = boundary !== null && productionsInWindow === 0;
  /**
   * ★ **派活侧**（2026-09-17 新增，补两个脑子都点名的那个根）。
   *   窗口内给某角色派了几条活（`DUTY.jsonl` 里 `at >= boundary` 的条数）。
   *   有了它，「没产出」才能被拆成两种完全不同的东西：
   *     · 派了活、它没干  ⇒ **该报**（责任 ∧ 无产出）；
   *     · 本来就没派活    ⇒ **不许报**（没活干不许判，脑子A 闸4 / 脑子B §5.2）。
   *   台账不存在时 `dutiesInWindow` 全是 0 ⇒ 判据自动退化成"只看缺席"，**不会因此乱报**。
   */
  const dutiesAll = (() => { try { return readDuties(dir).items; } catch { return []; } })();
  const dutiesInWindowByRole = new Map();
  /** ★ 细判据：某条派活算"干了"= 该角色有一条 **ref 与它相同** 且 **时间不早于派活** 的发现。 */
  const dutyMissedByRole = new Map();
  for (const d of dutiesAll) {
    const t = Date.parse(String(d.at ?? '')) || 0;
    if (boundary !== null && t < boundary) continue;
    const k = String(d.role ?? '').trim();
    dutiesInWindowByRole.set(k, (dutiesInWindowByRole.get(k) ?? 0) + 1);
    /**
     * ⚠ 2026-09-17 细化（我自己诊断出来的）：原来判"有没有产出"用的是**任意**产出 ——
     *   结果方向员在窗口内**投了一张无关的票**（rule:R4@1）就被算成"干完了"，
     *   而我派给它的那条活（依据 R5）根本没动。
     *   ⇒ 现在按**那条活的依据**核：该角色要有一条 `ref === 派活的 ref` 且 `at >= 派活时刻` 的发现。
     *   （这两个角色的产出通道就是 `find add --ref R#`，所以这个判据与工作流一致。）
     */
    const ref = String(d.ref ?? '').trim();
    const done = findings.some((f) => String(f.by ?? '').trim() === k
      && String(f.ref ?? '').trim() === ref
      && (Date.parse(String(f.at ?? '')) || 0) >= t);
    if (!done) dutyMissedByRole.set(k, (dutyMissedByRole.get(k) ?? 0) + 1);
  }
  const outputsInWindowByRole = new Map();
  for (const v of votesAll) {
    const t = Date.parse(String(v.at ?? '')) || 0;
    if (boundary !== null && t < boundary) continue;
    const k = String(v.role ?? '');
    outputsInWindowByRole.set(k, (outputsInWindowByRole.get(k) ?? 0) + 1);
  }
  for (const f of findings) {
    const t = Date.parse(String(f.at ?? '')) || 0;
    if (boundary !== null && t < boundary) continue;
    const k = String(f.by ?? '').trim();
    outputsInWindowByRole.set(k, (outputsInWindowByRole.get(k) ?? 0) + 1);
  }
  const noChannelSeats = ALL_ROLE_IDS.filter((r) => !VOTE_ROLES.includes(r) && !FINDING_ROLES.includes(r));
  const scoredSeats = ALL_ROLE_IDS.filter((r) => VOTE_ROLES.includes(r) || FINDING_ROLES.includes(r)).length;

  const rows = ALL_ROLE_IDS.map((role) => {
    const hasVote = VOTE_ROLES.includes(role);      // ⚠ 无票席位也要**被看见**（分母是 8，不是 7）
    const latest = new Map();                                  // 每个议题最多一票（后投的覆盖先投的）
    for (const t of topics) for (const v of perTopic.get(t)) if (v.role === role) latest.set(t, v);
    const cast = [...latest.entries()].map(([topic, v]) => ({ topic, ...v }));
    const no = cast.filter((v) => v.choice === RULE_NO).length;
    const cond = cast.filter((v) => String(v.conditions ?? '').trim()).length;
    const dissentRate = cast.length ? no / cast.length : null;
    // 【代理】独有项 / 同构
    let unique = 0; let iso = 0;
    const uniqueByTopic = new Map();
    for (const v of cast) {
      const peers = ALL_ROLE_IDS.filter((x) => x !== role)
        .map((x) => (perTopic.get(v.topic) ?? []).filter((y) => y.role === x).pop())
        .filter(Boolean);
      const dup = peers.find((p) => similar(v.reason, p.reason));
      if (peers.length && dup) { iso += 1; uniqueByTopic.set(v.topic, false); } else { unique += 1; uniqueByTopic.set(v.topic, true); }
    }
    // 连续 N 个（最新的）议题都没有独有项 ⇒ 装饰
    let tailNoUnique = 0;
    for (let i = topics.length - 1; i >= 0; i -= 1) {
      if (uniqueByTopic.get(topics[i]) === undefined) continue;   // 它没在这个议题上投过票 —— 跳过，不算"没独有项"
      if (uniqueByTopic.get(topics[i])) break;
      tailNoUnique += 1;
      if (tailNoUnique >= windowTopics) break;
    }
    const findingCount = findings.filter((f) => String(f.by ?? '').trim() === role).length;
    /**
     * ★ **发现的同构检测**（2026-09-17 新增，补 R8 的核心缺口）。
     *
      * 用户 R8 的核心诉求：方向员存在的意义是给出**不同的多方建议**的可能；
      *   同构时这一点没有对错，是好的。
     * ⚠ 缺口：原来的同构检测只比**投票理由**，而两个干活角色（资料员/方向员）的**真实产出通道是发现台账**
     *   （`find add`）—— 检测器根本覆盖不到它们。实测：三本账的"同构"计数**全是 0**（一次都没响过）。
     * ⇒ 现在把**发现**也纳入：同一个 `ref` 下，本角色的发现与**别的角色**的发现同构 ⇒
     *   标【代理】未提供独立视角（与投票那条同一条免责：Jaccard ≥ 0.8 是**代理**判据，文字不像 ≠ 观点真独立）。
     */
    const myFindings = findings.filter((f) => String(f.by ?? '').trim() === role);
    let findingIso = 0;
    for (const f of myFindings) {
      const ref = String(f.ref ?? '').trim();
      const peers = findings.filter((g) => String(g.by ?? '').trim() !== role
        && String(g.ref ?? '').trim() === ref
        && (ref !== '' || true));
      if (peers.some((g) => similar(f.text, g.text))) findingIso += 1;
    }
    const canVote = VOTE_ROLES.includes(role);
    const canFind = FINDING_ROLES.includes(role);
    const hasChannel = canVote || canFind;
    const flags = [];                                          // 每条都标【硬】/【代理】
    /**
     * 乙、**判据 = 缺席哪条活**（两个脑子一致要的那一条，且有真命中）。
     *   议题 t 满足 ①`firstAt(t)` 在窗口内 ②`|cast(t)| ≥ 2` ③本席位在名册里
     *   而本席位没投 ⇒ 记一条「缺席 t（N 席到 M 席）」。
     *   名册与 `tallyVotes` **同一套**（`VOTE_ROLES` ∧ `SEAT_ADDED_AT ≤ firstAt`）——
     *   旧代码这里不用 `SEAT_ADDED_AT`，同一本账出现两套名册（脑子A 第⑤条）。
     */
    const missed = [];
    if (canVote) {
      /**
       * ⚠ **不设时间窗口**（2026-09-17 修）：第一版沿用"最近 3 轮"，结果**把真阳性滤掉了** ——
       *   脑子A 找到的那条 `rule:R9@1`（应到 5 实到 3，缺席 = 支线守门员、提问闸门）
       *   首投时间早于窗口边界，于是**一条真事实被窗口挡在门外**。
       *   "这次投票到了 3 席 / 应到 5 席"是**对某一次具体投票的事实陈述**，与它多老无关。
       *   为了不刷屏：全账扫，按议题时间**从新到旧**收集，**只印最近 3 条**，并带上总数。
       */
      const allMiss = [];
      for (const t of topics) {
        const castT = perTopic.get(t) ?? [];
        const first = firstAt.get(t) ?? 0;
        const roster = VOTE_ROLES.filter((r) => (SEAT_ADDED_AT[r] ?? 0) <= first);
        if (roster.length < 2 || castT.length < 2) continue;
        if (!roster.includes(role)) continue;
        if (castT.some((v) => v.role === role)) continue;
        allMiss.push({ topic: t, roster: roster.length, cast: castT.length, at: first });
      }
      allMiss.sort((a, b) => b.at - a.at);
      for (const m of allMiss.slice(0, 3)) missed.push(m);
      missed.total = allMiss.length;
    }
    if (missed.length) {
      const more = missed.total > missed.length ? `，另有 ${missed.total - missed.length} 次更早的` : '';
      flags.push('【硬】缺席有活可干的事：' + missed.map((m) => m.topic + '（' + m.roster + '席应到实到' + m.cast + '席）').join('、') + more);
    }
    /**
     * ★ **派了活没干**（2026-09-17 新增）—— 这是补上"责任侧"之后唯一能正面回答
     *   「这个角色是不是摆设」的**硬**判据：有派活记录、窗口内却 0 产出。
     *   与上面那条的区别：缺席管的是"**投票**该到没到"，这条管的是"**任何**派出去的活"。
     *   台账为空 ⇒ 这条永远不响（不会乱报）。
     */
    const myDuties = dutiesInWindowByRole.get(role) ?? 0;
    const myDutyMissed = dutyMissedByRole.get(role) ?? 0;
    if (myDutyMissed > 0) {
      flags.push(`【硬】派了活没干：窗口内给它派了 ${myDuties} 条活，其中 ${myDutyMissed} 条**没有对应的产出**（判据：该角色没有一条 ref 与派活相同、时间不早于派活的发现）`);
    }
    if (canVote && cast.length >= minVotes && no === 0) flags.push('【硬】疑似顺从：票够多而**一次反对都没有**');
    if (cast.length >= 2 && iso === cast.length) flags.push('【代理】未提供独立视角：每一条理由都与同议题别的角色同构');
    if (myFindings.length && findingIso === myFindings.length) {
      flags.push(`【代理】未提供独立视角：${myFindings.length} 条发现**每一条**都与别的角色在同一条 R# 下的发现同构（代理判据 Jaccard≥0.8，需人读）`);
    }
    if (canVote && cast.length && tailNoUnique >= windowTopics) flags.push(`【代理】最近 ${tailNoUnique} 个议题都没有独有项（需人读）`);
    if (canVote && cast.length && cond / cast.length >= 0.5) flags.push(`【硬】${cond}/${cast.length} 张票附了条件（它在用条件代替反对）`);
    return {
      role, title: ROLE_TITLE[role] ?? role, hasVote: canVote, canFind, hasChannel,
      votes: cast.length, dissent: no, dissentRate, conditional: cond,
      unique, isomorphic: iso, findingIso, tailNoUnique, findings: findingCount, missed, flags,
    };
  });
  /**
   * ★ 「有效」的口径（2026-09-17 修；「审查」第二遍点名这条是洞）：
   *   原来 `effective` **只排**「缺席有活可干」，**不排**「派了活没干」——
   *   于是**被派了活却零产出的席位照样算"有效"**，而那正是派活回路要抓的事（自相矛盾）。
   *   现在：**带【硬】标记的席位一律不算有效**（硬标记 = 可复算的事实：缺席 / 派了活没干 /
   *   零反对的顺从 / 附条件代替反对）；【代理】标记（独有项、同构）**单独计数为"需人读"**，
   *   不混进分子 —— 这是"代理判据不许当硬判据"的同一原则。
   */
  const effective = rows.filter((r) => r.hasChannel && !r.flags.some((f) => String(f).includes('【硬】'))).length;
  const needsReading = rows.filter((r) => r.hasChannel && r.flags.length && !r.flags.some((f) => String(f).includes('【硬】'))).length;
  return {
    topics: topics.length, topicsInWindow: topicsInWindow.length, rounds: totalRounds, windowRounds,
    boundary: boundary === null ? null : new Date(boundary).toISOString(),
    stalled, productionsInWindow, scoredSeats,
    dutiesInWindow: [...dutiesInWindowByRole.values()].reduce((a, b) => a + b, 0),
    dutiesByRole: Object.fromEntries(dutiesInWindowByRole),
    noChannelSeats: noChannelSeats,
    roles: rows, effective, needsReading, total: rows.length,
  };
}

/**
 * 监督员那一行（§6.1 逐字指定的形态）—— **只一行**，且**只印事实 + 见证数据**。
 *
 * 2026-09-17 重写：旧版印的是**判决**（"该角色当前是装饰"），而判决的两条来源都被证伪
  *   （一条对 AI测试用户 恒真、一条与"有没有活干"无关）。用户要的是各司其职的呈现，
 *   所以现在这一行必须**自带见证数据**（窗口多少轮 / 新议题几个 / 计分席位几个），
 *   让读到的人能自己复算，而不是只能信这句话（脑子A 的第 5 条、脑子B 的 §5.4）。
 */
export function rolesHealthLine(dir, opts) {
  const h = rolesHealth(dir, opts);
  const noCh = (h.noChannelSeats || []).join('、');
  const tailNoCh = noCh ? `；结构上无产出渠道（设计如此，不计分）：${noCh}` : '';
  const witness = `窗口 ${h.windowRounds} 轮 / 新议题 ${h.topicsInWindow} 个 / 计分席位 ${h.scoredSeats}`
    + (h.dutiesInWindow ? ` / 派活 ${h.dutiesInWindow} 条` : '');
  const bad = h.roles.filter((r) => r.hasChannel && r.flags.length);
  /**
   * ⚠ 2026-09-17 修：原来 `stalled` 分支**直接 return**，把逐角色的 flags 全吞了 ——
   *   而"全线停摆"时恰恰最该看的是**「派了活没干」**（有人被派了活却整轮没动）。
   *   现在两件事都印：先报停摆，再印逐角色的问题。
   */
  const parts = bad.map((r) => {
    const dutyMiss = r.flags.find((f) => /派了活没干/.test(f));
    if (dutyMiss) return `${r.role}${dutyMiss.replace('【硬】派了活没干：', '派了活没干：')}`;
    const miss = r.flags.find((f) => /缺席有活可干/.test(f));
    if (miss) return `${r.role}${miss.replace('【硬】缺席有活可干的事：', '缺席 ')}`;
    if (r.flags.some((f) => /疑似顺从/.test(f))) return `${r.role} ${r.votes} 票零反对 → 疑似顺从（需人读）`;
    if (r.flags.some((f) => /未提供独立视角/.test(f))) return `${r.role}本轮无独有项 → 未提供独立视角`;
    if (r.flags.some((f) => /附了条件/.test(f))) return `${r.role} ${r.conditional} 张票附条件`;
    return `${r.role} 有标记（需人读）`;
  });
  const tailParts = parts.length ? `；${parts.join('；')}` : '';
  if (h.stalled) {
    return `角色在跑：**全线停摆** —— 最近 ${h.windowRounds} 轮里 ${h.scoredSeats} 个计分席位 0 产出`
      + `（${witness}${tailParts}）${tailNoCh}`;
  }
  if (!bad.length) return `角色在跑：${h.effective}/${h.scoredSeats} 计分席位有效（${witness}）${tailNoCh}`;
  return `角色在跑：${h.effective}/${h.scoredSeats} 计分席位有效（${witness}${tailParts}）${tailNoCh}`;
}

/**
 * ==================== 角色发言的落盘之家 + 「不许转述」的启发式检测 ====================
 *
 * 用户 R6（核心诉求）：
 *   角色说的话要直接显示，不许 AI 把角色的话隐藏后通过自己来转述。
 *   上下文要保持干净，角色说话前加一个名字与职称的显示。
 *
 * 两件事必须分开说，不然又会"把代理判据说成硬判据"：
 *   【硬】① 角色的发言有一处**逐字的家**（`ROLE_SPEECH.jsonl`），谁在什么时候原话说了什么，可反查；
 *        ② 显示形态是 `名字 · 职称：原话`（`roleSpeech()`），少了职称就报错；
 *   【代理】③ "主代理有没有把角色的话转述掉" —— 只能**启发式**判：
 *        产物里出现「角色名 + 说/认为/指出/建议/觉得/要求」这种**间接引语**，而同一份产物里
 *        既没有 `名字 · 职称：` 的原话行、也没有引号包起来的原话 ⇒ **疑似转述**。
 *        ⚠ 命中 ≠ 证明转述了（可能是"我向用户转述了审查的原话，原话在别处"）；
 *          没命中 ≠ 没转述（文雅一点的转述它抓不到）。**所以它是提醒，不是判决。**
 */
const ROLE_SPEECH_FILE = 'ROLE_SPEECH.jsonl';

export function readRoleSpeech(dir) {
  const p = path.join(dir, ROLE_SPEECH_FILE);
  if (!fs.existsSync(p)) return [];
  return readText(p).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function recordRoleSpeech(dir, { role, text, ref, topic, by }) {
  const rec = {
    at: new Date().toISOString(),
    role,
    title: ROLE_TITLE[role] ?? role,      // 职称随发言一起存：将来改了注册表，历史发言仍显示当时的职称
    text: String(text ?? ''),
    ref: String(ref ?? '').trim(),
    topic: String(topic ?? '').trim(),
    session: currentSessionId(),
    by: by ?? null,
  };
  fs.appendFileSync(path.join(dir, ROLE_SPEECH_FILE), JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

/**
 * 【代理】转述检测。返回命中的句子（不是"结论"）。
 * 判据：同一段文本里，某角色名后面跟着**间接引语动词**（说/认为/指出/建议/觉得/要求/强调/提醒），
 *   而**这段文本里没有**该角色的 `名字 · 职称：` 原话行、也没有引号包起来的引用 ⇒ 命中。
 */
export function roleParaphraseScan(text, { roles = ALL_ROLE_IDS } = {}) {
  const src = String(text ?? '');
  const hasSpeechLine = (role) => new RegExp(`${role}\\s*[·・]\\s*[^：:\\n]{1,12}[：:]`).test(src);
  const hits = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // 已经是"名字 · 职称：原话"的行 → 那是**正牌发言**，不算转述
    if (/^[^\s]{1,8}\s*[·・]\s*[^：:\n]{1,12}[：:]/.test(line)) continue;
    for (const role of roles) {
      const m = new RegExp(`${role}\\s*(?:则|又|也|还|就)?\\s*(说|认为|指出|建议|觉得|要求|强调|提醒|判断|判定)`).exec(line);
      if (!m) continue;
      const quoted = /[「『“"][^」』”"]{6,}[」』”"]/.test(line);   // 同一行里有引号引起来的原话 → 放过
      if (quoted) continue;
      if (hasSpeechLine(role)) continue;                          // 同一份产物里有它的原话行 → 放过
      hits.push({ role, verb: m[1], line: oneLine(line, 120) });
    }
  }
  return hits;
}

/** 一段文本按 `^## ` 切成块，每块单独算哈希 —— 别让"改一条"作废整份审查 */
export function sectionHashes(root, artifact) {
  const p = path.isAbsolute(artifact) ? artifact : path.join(root, artifact);
  let text = '';
  try {
    if (!fs.statSync(p).isFile()) return null;
    text = readText(p);
  } catch { return null; }
  const out = {};
  let key = '(抬头)';
  let buf = [];
  const flush = () => {
    const body = buf.join('\n').replace(/[ \t]+$/gm, '');
    const h = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
    let k = key;
    let n = 2;
    while (k in out) { k = `${key}#${n}`; n += 1; }
    out[k] = h;
  };
  for (const line of text.split(/\r?\n/)) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      flush();
      const title = h2[1].trim();
      const id = /^([^\s·:：\-—|]+)/.exec(title);
      key = id && id[1] ? id[1] : title;
      buf = [line];
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** 一份审查记录覆盖的章节，现在是仍然有效、还是哪几个变了 */
export function sectionVerdict(rec, nowSections) {
  const covered = rec?.sections && typeof rec.sections === 'object' ? Object.keys(rec.sections) : [];
  if (!covered.length) return { legacy: true, changed: [], kept: covered };
  if (!nowSections) return { legacy: false, unreadable: true, changed: ['（读不到产物）'], kept: [] };
  const changed = covered.filter((k) => nowSections[k] !== rec.sections[k]);
  const kept = covered.filter((k) => nowSections[k] === rec.sections[k]);
  return { legacy: false, unreadable: false, changed, kept };
}

/** 读 RULES.jsonl 原始记录（容忍 UTF-8 BOM、空行、# 注释、坏行） */
export function readRuleRecords(dir) {
  const p = path.join(dir, RULES_FILE);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of readText(p).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    try { const o = JSON.parse(s); if (o && typeof o === 'object') out.push(o); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 规则册 = 每个 id 的**最后一条**规则记录（状态推进是追加，后写的算数）。
 * `kind:"revision"` 的记录**不是规则本身**，只作修订历史 —— 不许把它当成规则读出来。
 */
export function readRules(dir) {
  const all = readRuleRecords(dir);
  const byId = new Map();
  const revisions = [];
  for (const r of all) {
    if (r.kind === 'revision') { revisions.push(r); continue; }
    if (!r.id) continue;
    byId.set(r.id, r);
  }
  return { rules: [...byId.values()], revisions, all };
}

/** topic 里的修订号：rule:R7@2 → 2 */
export function ruleRev(topic) {
  const m = /@(\d+)\s*$/.exec(String(topic ?? ''));
  return m ? Number(m[1]) : 1;
}

/** 自动分配 id：R1、R2…递增，跳过已经用掉的 */
export function nextRuleId(rules) {
  const used = new Set(rules.map((r) => String(r.id)));
  for (let i = 1; i < 100000; i += 1) if (!used.has(`R${i}`)) return `R${i}`;
  return `R${Date.now()}`;
}

/** 事故收集器（L8）：规则的证据可以指向这里面某条事故的 id */
export function readIncidents(dir) {
  const p = path.join(dir, 'INCIDENTS.jsonl');
  if (!fs.existsSync(p)) return [];
  return readText(p).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/**
 * lab 里**真实存在**的实验名（L1、L6 这种）—— 证据要能指到它。
 *
 * 搜索根必须包含 **warden.mjs 自己所在的目录**：实验台是随 skill 走的（多个项目共用），
 * 它**不在工程根下**。实测事故（RF1 同一种病）：工程根 `<WORKSPACE>` 下没有 `experiments/lab`，
 * 而 lab 明明在 `<THIS_REPO>\experiments\lab` —— 只搜工程根就永远找不到，
 * 然后 **静默降级成"认下、但没法核对"**，而输出还写着"证据认得"。那是拿"没核对"当"通过了"。
 */
export function discoverLabIds(root) {
  const roots = [
    path.join(root, 'experiments', 'lab'),
    path.join(root, 'lab'),
    path.join(root, 'experiments'),
    path.join(root, '.warden', 'lab'),
    path.join(SELF_DIR, 'experiments', 'lab'),
    path.join(SELF_DIR, 'lab'),
  ];
  const ids = new Set();
  const paths = new Map();     // L6 → 那个实验文件的绝对路径（要读它的**内容**，不能只看文件名）
  const hits = [];
  let found = false;
  for (const d of roots) {
    if (!fs.existsSync(d)) continue;
    const labish = /lab[\\/]?$/i.test(d.replace(/[\\/]+$/, ''));   // 名字里带 lab 的才算"实验台"
    if (labish) found = true;
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      const m = /^(L\d+)/i.exec(e.name);
      if (m) {
        const id = m[1].toUpperCase();
        ids.add(id);
        if (!paths.has(id)) paths.set(id, path.join(d, e.name));
        if (!hits.includes(d)) hits.push(d);
      }
    }
  }
  if (ids.size) found = true;   // 就算只是 experiments/ 下扫到了 L*，也算找到了台子
  return { ids, found, roots: hits, paths };
}

/**
 * 一个 lab 文件**算不算实验** —— 光有文件名不算。
 *
 * 实测洞（2026-09-16 由「审查」坐实）：证据闸门原来**只验"这个文件名在不在"**：
 *   编一个不存在的 `L99` 会被拒（真拦），但**塞一个只写 `console.log('自称满意')`、
 *   没有数字也没有断言的 `L97` 却能被收进册**。
 *   ⇒ 于是"拿一个空壳文件假称有实验"可以给任意规则背书 —— 那正是
 *     "**一条规则是不是真被强制，不能靠读代码判，要跑一个反例看它拦不拦**"要防的事。
 * 判据（机械、便宜）：文件里**至少有一个断言调用**（`c.check(` / `assert(` / `expect(` / `throw new Error(`）。
 *   不要求跑起来（`rule propose` 里跑整套实验太慢）；**但"没有任何断言"的文件一定不是实验**。
 *   ⚠ 这拦的是"空壳冒充实验"，不是"实验写得好不好"：**断言数不等于断言有力**，
 *     真实的"实验写得敷衍"要靠人读（本文件顶部就写着这条）。
 */
export function labQuality(p) {
  let text = '';
  try { text = readText(p); } catch { return { ok: false, why: `读不到 ${p}` }; }
  const asserts = (text.match(/\b(?:c\.check|assert|expect|throw new Error)\s*\(/g) ?? []).length;
  const bytes = Buffer.byteLength(text, 'utf8');
  const onlySkip = asserts === 0 && /c\.skip\s*\(/.test(text);
  if (!asserts) {
    return {
      ok: false, asserts, bytes,
      why: `那个文件里**一个断言都没有**（${bytes} 字节：只有 console.log/文字，没有 c.check/assert/expect/throw）`
        + (onlySkip ? '，而且它只调用了 c.skip（跳过不是通过）' : '')
        + ' —— **空壳文件不算实验，不能给规则背书**',
    };
  }
  return { ok: true, asserts, bytes, why: `${asserts} 处断言、${bytes} 字节` };
}

/**
 * 规则的证据必须**指得到**：要么是 `INCIDENTS.jsonl` 里某条事故的 id，
 * 要么是 lab 里一个真实存在的实验（L1、L6、L9…）。指不到 → 拒收。
 * 为什么：本轮血的教训 —— 有规则是"一个作者、没投票、没实验"直接写进 AGENTS.md 的。
 *
 * **不许静默降级**：核对不了就要说出来（`verified:false` + `⚠`），
 * 不能把"没核对"包装成"证据认得" —— 那和 `quotes` 扫 0 个文件却报"没问题"是同一种病。
 */
export function checkRuleEvidence(root, dir, evidence) {
  const ev = String(evidence ?? '').trim();
  if (!ev) return { ok: false, why: '没给 --evidence' };
  const hits = [];
  for (const inc of readIncidents(dir)) {
    for (const k of ['id', '事故id', '事故']) {
      const id = String(inc[k] ?? '').trim();
      // ★ 必须**整词匹配**，不能用 ev.includes(id)：
      //   实测踩过 —— "I17".includes("I1") 为真，于是每条引用 I1x 的规则都会虚报"也引用了 I1"，
      //   事故归属变得不可判定（`记录`/lab 两方都独立报过这一点）。
      if (id && new RegExp(`(^|[^0-9A-Za-z])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`).test(ev)) hits.push(id);
    }
  }
  if (hits.length) return { ok: true, verified: true, how: `事故 ${[...new Set(hits)].join('、')}（INCIDENTS.jsonl）`, note: '' };
  const lab = discoverLabIds(root);
  const mentioned = [...new Set((ev.match(/[Ll]\d+(?![0-9])/g) ?? []).map((s) => s.toUpperCase()))];
  if (lab.found && lab.ids.size) {
    const inLab = mentioned.filter((m) => lab.ids.has(m));
    if (inLab.length) {
      /**
       * ★ **文件名在 ≠ 那是实验**。逐个读内容验一遍：
       *   空壳（没有断言的文件）不许给规则背书 —— 实测洞：只写 `console.log('自称满意')` 的 `L97` 会被收进册。
       *   只要有一个被点名的实验是空壳，就**拒收**（不能"挑一个能看的算数"）。
       */
      const bad = inLab
        .map((id) => ({ id, q: labQuality(lab.paths.get(id)) }))
        .filter((x) => !x.q.ok);
      if (bad.length) {
        return {
          ok: false,
          why: `证据点名的实验里，有**空壳**：${bad.map((b) => `${b.id}（${b.q.why}）`).join('；')}`,
          how: `实验 ${inLab.join('、')}`,
        };
      }
      const detail = inLab.map((id) => `${id}: ${labQuality(lab.paths.get(id)).why}`).join('；');
      return { ok: true, verified: true, how: `实验 ${inLab.join('、')}（lab：${lab.roots[0] ?? '?'}）`, note: `已核过内容：${detail}` };
    }
    return { ok: false, why: `证据里提到的实验名在 lab 里不存在（lab 里只有 ${[...lab.ids].join('、')}）` };
  }
  if (lab.found && !lab.ids.size) {
    return { ok: false, why: '找到了 lab 目录，但里面一个实验（L1、L6…）都没有 —— 指不到就拒收' };
  }
  const guess = mentioned.filter((m) => /^L\d+$/.test(m));
  if (guess.length) {
    return {
      ok: true,
      verified: false,
      how: `实验 ${guess.join('、')}`,
      note: `⚠ 证据没法核对：lab 一个候选根都没找到（找过：工程根下的 experiments/lab、lab、experiments、.warden/lab 和 warden.mjs 同级的 experiments/lab）—— 按命名规则先认下，**但这不等于核对通过**`,
    };
  }
  return { ok: false, why: '既没提到 INCIDENTS.jsonl 里的事故 id，也没提到 lab 里的实验名（L1、L6、L9、L10 这种）' };
}

/** 追加一条记录（规则册 append-only：状态推进 = 追加一条新的，后写的算数） */
export function appendRule(dir, rec) {
  fs.appendFileSync(path.join(dir, RULES_FILE), JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

/** 提一条规则：**没有证据的规则不许进册**；新规则一律是「提案」，topic = rule:<id>@1 */
export function proposeRule(root, { id, text, evidence, enforced, by }) {
  const dir = path.join(root, WARDEN_DIR);
  const { rules } = readRules(dir);
  const kind = enforced ?? 'text';
  if (!text || !String(text).trim()) return { err: '缺 --text（规则本身要写出来）' };
  if (!ENFORCED_KINDS.includes(kind)) {
    return { err: `--enforced 只能是 code（被 exit code 强制）或 text（只是建议），收到的是 ${JSON.stringify(kind)}` };
  }
  const rid = id ? String(id) : nextRuleId(rules);
  if (id && !/^R\d+$/.test(rid)) return { err: `--id 形如 R7，收到的是 ${JSON.stringify(id)}` };
  if (rules.some((r) => r.id === rid)) return { err: `${rid} 已经被用了 —— 换一个 id，或者不传让它自动分配` };
  const ev = checkRuleEvidence(root, dir, evidence);
  if (!ev.ok) return { err: `证据指不到任何事故或实验：${ev.why}`, noEvidence: true };
  const rule = {
    id: rid, text: String(text).trim(), status: '提案', enforced: kind,
    evidence: String(evidence).trim(), topic: `rule:${rid}@1`,
    at: new Date().toISOString(), by: by ?? null,
  };
  appendRule(dir, rule);
  return { rule, evidenceHow: ev.how, evidenceNote: ev.note, evidenceVerified: ev.verified !== false };
}

/**
 * 打回「提案」，修订号 +1（@1 → @2）—— **旧票不污染新票**（topic 变了）。
 * 留痕：旧文本 / 旧状态 / 谁提的 / 为什么，写成一条 `{"kind":"revision",…}` 记录。
 * `定稿` 的规则默认不能改（改硬规则要改代码），要 `--force`。
 */
export function reopenRule(dir, { id, why, force = false, by }) {
  const { rules } = readRules(dir);
  const rule = rules.find((r) => r.id === id);
  if (!rule) return { err: `规则册里没有 ${id}` };
  const wasFinal = rule.status === '定稿';
  if (wasFinal && !force) {
    return { err: `${id} 是**定稿**：默认不能再改。要改加 --force 并说明理由（改硬规则要改代码）。`, wasFinal };
  }
  const rev = ruleRev(rule.topic) + 1;
  const topic = `rule:${rule.id}@${rev}`;
  const at = new Date().toISOString();
  const conds = tallyVotes(dir, rule.topic).conditionalVotes ?? [];
  appendRule(dir, {
    kind: 'revision', id: rule.id, at, by: by ?? null, why: String(why ?? ''), force: !!force,
    from: { text: rule.text, status: rule.status, enforced: rule.enforced, evidence: rule.evidence, topic: rule.topic },
    to: { status: '提案', topic },
    conditions: conds.map((v) => ({ role: v.role, choice: v.choice, conditions: v.conditions, at: v.at ?? null })),
  });
  const next = {
    id: rule.id, text: rule.text, status: '提案', enforced: rule.enforced,
    evidence: rule.evidence, topic, at, by: by ?? null,
  };
  appendRule(dir, next);
  return { rule: next, prev: rule, rev, wasFinal };
}

/**
 * 未决原因（脚本只算数：平票 / 缺席 / 有异议没被回应 / **未过半** 都算未决）
 *
 * ★ **P-M2：过半闸必须接进 rule 路径**（实测事故，原样输出见任务书）：
 *   P-M1 给 `tallyVotes` 加了过半闸，`vote --topic` 会印「未决·分歧（…未过半…）」、exit 1，
 *   但 `rule status` 的「未决原因」行照旧写「（没有 —— 票收齐了，也没有没被回应的异议）」、
 *   「推进」行照旧写「多数：同意 → 可以定稿」，`advanceRule` 照旧**落盘成「试行」** ——
 *   落盘证据是 RULES.jsonl 末条**同一条记录里同时写着** `"status":"试行"` 与
 *   `"transition":{"tally":"未决·分歧（…未过半…）"}`。⇒ **过半闸在 `rule:` 路径上是装饰。**
 *   根因：本函数（`ruleUnresolved`）是 `advanceRule` / `rule status` / `pendingRuleAdvances`
 *   共用的唯一"能不能推进"判据，而它**不认 `hasMajority`**。现在认了。
 *
 * 判据：**未过半 ⇒ 未决**（分母是 `majorityBase`，不是实到票数、也不许被单条记录缩小）。
 *   为什么放在"有票没理由"之后、"异议没被回应"之前：与 `tallyVotes` 里状态机的分支顺序一致，
 *   读的人不会看到"票况说未过半、未决原因却只字不提"。
 *   多种原因同时成立时**全都说出来**（原来只报第一条，会让"未过半"被"缺席"之类盖住）。
 *   ⚠ 只有一条原因时，输出与改动前**逐字相同**（老用例的断言不受影响）。
 */
function ruleUnresolved(t) {
  if (t.state === '没有投票' || !t.votes.length) return '还没有票（五个角色一个都没投）';
  const base = Number.isFinite(t.majorityBase) ? t.majorityBase : (t.roster ?? VOTE_ROLES).length;
  const reasons = [];
  if (t.missing.length) reasons.push(`缺席：${t.missing.join('、')}`);
  if (t.tied) reasons.push(`平票：${JSON.stringify(t.counts)}`);
  if (t.unclear.length) reasons.push(`有票没理由（<10 字）：${t.unclear.map((v) => v.role).join('、')}`);
  // ★ 过半闸：没过半 ⇒ 未决（这就是"2/7 不许当多数"那条闸在 rule 路径上的落点）
  if (t.hasMajority === false) {
    reasons.push(`未过半：最高票「${t.winner}」只有 ${t.winCount}/${base} 票（过半要 ${t.majorityNeeded ?? (Math.floor(base / 2) + 1)} 票）—— 不许推进`);
  }
  if (t.unaddressed.length) reasons.push(`异议没被回应：${t.unaddressed.join('、')}`);
  /**
   * ★ 判据⑤（P-M2b）：**账目自相矛盾 ⇒ 未决**（票的时刻早于规则进册时刻）。
   *   它**必须**在这里也有一支：本函数是 `advanceRule` / `rule status` / `pendingRuleAdvances`
   *   共用的**唯一**"能不能推进"判据。只改 `tallyVotes` 的 `state` 而不认这里，
   *   `rule status` 就会照旧写「未决原因：（没有）」并**落盘成「试行」** ——
   *   那正是 P-M1 被打脸的那条（同一条记录里同时写着 `status:"试行"` 与 `tally:"未决…"`）。
   *   ⚠ 放在**最后**追加：只有一条原因时，输出与改动前**逐字相同**（老用例的断言不受影响）。
   */
  if (t.accountContradiction) {
    reasons.push(`账目自相矛盾：票的时刻 ${t.accountContradiction.voteAt} 早于规则进册时刻 ${t.accountContradiction.ruleAt}`
      + '（规则还不存在就有人投票，这份账在时间轴上不成立）');
  }
  return reasons.length ? reasons.join('；') : null;
}

function writeRuleStatus(dir, rule, status, t, extra = {}) {
  return appendRule(dir, {
    ...rule, status, at: new Date().toISOString(), by: currentSessionId(),
    // `outsiderNote` 一并落账：没有投票权的席位出声了（讨论C：压不过多数，但不许被静默忽略）。
    // 不写进台账的话，"它说过话"这件事只活在当时的终端输出里。
    transition: { from: rule.status, to: status, tally: t.state, counts: t.counts, roster: t.roster, outsiderNote: t.outsiderNote ?? null },
    ...extra,
  });
}

/** 零反对票的审查标记 —— 推进时把它**写进记录**（否则"顺从"这条审查只活在当下的输出里） */
function suspicionFlag(t) {
  return (unanimousNoDissent(t) && !dissentExplained(t).length)
    ? { zeroDissent: true, suspicion: '未决·疑似顺从（零反对且没人说明为什么没有反对）' }
    : {};
}

/**
 * 按 tallyVotes 的结果**机械推进**（脚本只算数，不做价值判断）：
 *   提案 --(多数：同意 且 无未决)--> 试行 --(显式 --promote)--> 定稿
 *   任何阶段「多数：反对」--> 否决
 *   平票 / 缺席 / 有异议没被回应 / 还没投票 --> **不变**
 *   **有票附了 --conditions --> 待并条件**（条件不并进正文，就不许当干净的同意用）
 * `code`：0 = 定下来了（或压根还没投票）· 1 = 未决（有票却没定下来）
 */
export function advanceRule(dir, rule, { promote = false } = {}) {
  const t = tallyVotes(dir, rule.topic);
  const noVotes = t.state === '没有投票' || !t.votes.length;
  const base = { tally: t, changed: false, rule, status: rule.status, code: noVotes ? 0 : 1, detail: [] };
  if (rule.status === '定稿') {
    return { ...base, code: 0, msg: `定稿 —— 投票不会再自动改它。要改跑：rule reopen --id ${rule.id} --force --why "…"（改硬规则要改代码）` };
  }
  if (rule.status === '否决' || rule.status === '废止') {
    return { ...base, code: 0, msg: `已${rule.status} —— 投票不自动复活它。要复活跑：rule reopen --id ${rule.id} --why "…"` };
  }
  const why = ruleUnresolved(t);
  if (why) return { ...base, msg: `未决，交回脑子继续想（${why}）` };
  if (t.winner === RULE_NO) {
    const rec = writeRuleStatus(dir, rule, '否决', t);
    return { ...base, code: 0, changed: true, rule: rec, status: '否决', msg: '票是「多数：反对」→ 否决（脚本只算数，不做价值判断）' };
  }
  if (t.winner !== RULE_YES) {
    return { ...base, code: 0, msg: `多数是「${t.winner}」，既不是同意也不是反对 —— 不变` };
  }
  /**
   * ★ 附条件的同意（`vote cast --conditions "…"`）**不是干净的同意**：
   *   实测事故 —— 一个角色对 19 条规则投了 18 条同意，每条都附硬边界，还写明"否则保留改投反对的权利"；
   *   而 tallyVotes 原来只认 choice，**条件被吞掉，规则照算通过**。
   *   所以：有附条件的票 → 不许推进，记「待并条件」，条件并入正文后再重新投票（topic 变了，旧票不污染）。
   */
  if (t.conditional.length) {
    const already = rule.status === RULE_PENDING_CONDITIONS;
    if (!already) writeRuleStatus(dir, rule, RULE_PENDING_CONDITIONS, t);
    return {
      ...base,
      code: 0,
      changed: !already,
      status: RULE_PENDING_CONDITIONS,
      msg: `★ ${t.conditional.length} 张票附了条件，条件必须先并入规则正文，然后按新文本重新投票`
        + `（状态记为「${RULE_PENDING_CONDITIONS}」，**不许直接推进**）`,
      detail: [
        ...t.conditionalVotes.map((v) => `    · ${v.role} 的条件：${v.conditions}`),
        `    并入：node warden.mjs rule amend --id ${rule.id} --text "…（并入条件后的新文本）"`,
        '    为什么要这样：票是自愿给的，条件不能被吞 —— 吞掉条件等于替投票人签字。',
      ],
    };
  }
  if (rule.status === RULE_PENDING_CONDITIONS) {
    return { ...base, code: 0, msg: `状态是「${RULE_PENDING_CONDITIONS}」但现在没有附条件的票 —— 说明条件已并入新文本；用 rule amend 走到新修订号再重投` };
  }
  if (rule.status === '提案') {
    const rec = writeRuleStatus(dir, rule, '试行', t, suspicionFlag(t));
    const detail = zeroDissentDetail(t, rule.topic);
    return { ...base, code: 0, changed: true, rule: rec, status: '试行', msg: '多数：同意 且 无未决 → 提案 推进到 试行', detail };
  }
  if (rule.status === '试行') {
    if (!promote) {
      return { ...base, code: 0, msg: `多数：同意 → 可以定稿，但要**显式**动作：node warden.mjs rule status --id ${rule.id} --promote`, detail: zeroDissentDetail(t, rule.topic) };
    }
    const rec = writeRuleStatus(dir, rule, '定稿', t, suspicionFlag(t));
    return { ...base, code: 0, changed: true, rule: rec, status: '定稿', msg: '显式 --promote + 多数：同意 → 试行 推进到 定稿', detail: zeroDissentDetail(t, rule.topic) };
  }
  return { ...base, code: 0, msg: `状态「${rule.status}」没有可推进的下一步` };
}

/**
 * 零反对票的提示（**只提示，不让命令失败** —— 用户要的是一个审查，不是一个盖章机）。
 * 全员同意且零反对时，必须有人写明"我为什么没有反对"；写不出来 → 标 `未决·疑似顺从`。
 */
export function zeroDissentDetail(t, topic) {
  if (!unanimousNoDissent(t)) return [];
  const explained = dissentExplained(t);
  const out = ['    ★ 零反对票有两种解释：①规则确实好 ②角色在顺从（**顺从比反对更危险**）。'];
  if (explained.length) {
    out.push(`    已有人写明为何不反对：${explained.map((v) => `${v.role}「${oneLine(v.address, 40)}」`).join('、')} —— 这一关过了。`);
  } else {
    out.push('    请至少一个角色用 vote cast --address "…" 写明"我为什么没有反对"：');
    out.push(`      node warden.mjs vote cast --topic ${topic} --role 审查 --choice ${RULE_YES} --reason "…" --address "我为什么没有反对：…"`);
    out.push('    写不出来 → 这条只能算 **未决·疑似顺从**（现在按"无异议"处理，但审查记在账上）。');
  }
  return out;
}

/**
 * `rule amend --id R7 --text "…（并入条件后的新文本）"`：
 * 把新文本写进规则，**修订号 +1**（@1 → @2），状态回到「提案」，
 * 并把**上一版有哪些条件**作为历史留痕（kind:"revision"）。
 */
export function amendRule(dir, { id, text, why, by, force = false }) {
  const { rules } = readRules(dir);
  const rule = rules.find((r) => r.id === id);
  if (!rule) return { err: `规则册里没有 ${id}` };
  if (!text || !String(text).trim()) return { err: '缺 --text（并入条件后的新文本）' };
  const wasFinal = rule.status === '定稿';
  if (wasFinal && !force) {
    return { err: `${id} 是**定稿**：默认不能再改。要改加 --force 并说明理由（改硬规则要改代码）。`, wasFinal };
  }
  const t = tallyVotes(dir, rule.topic);
  const conds = t.conditionalVotes ?? [];
  const rev = ruleRev(rule.topic) + 1;
  const topic = `rule:${rule.id}@${rev}`;
  const at = new Date().toISOString();
  appendRule(dir, {
    kind: 'revision', id: rule.id, at, by: by ?? null, amend: true, force: !!force,
    why: String(why ?? '').trim() || 'amend：把投票时附的条件并入规则正文',
    from: { text: rule.text, status: rule.status, enforced: rule.enforced, evidence: rule.evidence, topic: rule.topic },
    to: { status: '提案', topic },
    // 上一版有哪些条件 —— 这是必须留下来的历史（否则"条件被吞"照样查不出来）
    conditions: conds.map((v) => ({ role: v.role, choice: v.choice, conditions: v.conditions, at: v.at ?? null })),
  });
  const next = {
    id: rule.id, text: String(text).trim(), status: '提案', enforced: rule.enforced,
    evidence: rule.evidence, topic, at, by: by ?? null,
  };
  appendRule(dir, next);
  return { rule: next, prev: rule, rev, conditions: conds, wasFinal };
}

/** 规则册统计：只在册生效的（提案/试行/定稿/待并条件）算占比，已否决/已废止单独数 */
export function ruleStats(dir) {
  const { rules } = readRules(dir);
  const live = rules.filter((r) => RULE_LIVE.has(r.status));
  const hard = live.filter((r) => r.enforced === 'code').length;
  const text = live.filter((r) => r.enforced !== 'code').length;
  return {
    total: live.length, hard, text, folded: rules.length - live.length,
    pct: live.length ? Math.round((text / live.length) * 100) : 0,
  };
}

/**
 * check 用：`提案` 且五个角色的票都**收齐了** → 提示"待推进"（只提示，不拦）
 *
 * ★ P-M2：**未过半的不许报成"待推进"**。原来只挡 `!votes.length` 与 `missing`，
 *   于是 3/7 同意（票收齐、没人缺席）的规则会被 `check` 印成"票已齐、待推进"，
 *   跑 `rule status` 才知道根本推不动 —— 那句"待推进"是在骗人去点一个点不动的按钮。
 *   （平票 / 有异议没被回应**仍然**照旧报"待推进"：那是本函数**原有**的松弛，
 *     代码里那段注释明确把结论交给 `rule status`；本次只加过半闸这一条，不顺手改别的。）
 */
export function pendingRuleAdvances(dir) {
  const { rules } = readRules(dir);
  const out = [];
  for (const r of rules) {
    const t = tallyVotes(dir, r.topic);
    if (r.status === '提案') {
      if (!t.votes.length || t.missing.length) continue;
      // ★ 过半闸：没过半 ⇒ 不是"待推进"，是"推不动"（改它的判据见 tallyVotes 里 roster 那一段）
      if (t.hasMajority === false) continue;
      // ★ 判据⑤（P-M2b）：账目自相矛盾 ⇒ 同样推不动，**不许**报成"票已齐、待推进"
      if (t.accountContradiction) continue;
      out.push({ rule: r, tally: t, kind: '待推进' });
    } else if (r.status === RULE_PENDING_CONDITIONS) {
      out.push({ rule: r, tally: t, kind: '待并条件' });
    }
  }
  return out;
}

/** `warden rules`：硬规则和文本规则**分开列**，已否决/已废止折叠在最后 */
export function rulesView(root) {
  const dir = path.join(root, WARDEN_DIR);
  const { rules, revisions } = readRules(dir);
  const L = [];
  L.push(`${ROLE_STAMP.rules} 规则册 · ${path.join(dir, RULES_FILE)}`);
  L.push('');
  if (!rules.length) {
    L.push('  （册子还是空的 —— 一条规则都没有）');
    L.push('');
    L.push('  提一条：node warden.mjs rule propose --text "…" --evidence "L1 实测：…" --enforced text');
    L.push('  规矩：**没有证据的规则不许进册**（证据要么指 INCIDENTS.jsonl 里的事故 id，要么指 lab 里的实验 L1、L6、L9、L10 这种）。');
    return { text: L.join('\n'), code: 0 };
  }
  const live = rules.filter((r) => RULE_LIVE.has(r.status));
  const hard = live.filter((r) => r.enforced === 'code');
  const soft = live.filter((r) => r.enforced !== 'code');
  const gone = rules.filter((r) => r.status === '否决' || r.status === '废止');
  const dump = (r) => {
    const t = tallyVotes(dir, r.topic);
    const revs = revisions.filter((x) => x.id === r.id).length;
    const flags = [];
    if (t.conditional.length) flags.push(`${t.conditional.length} 张附条件`);
    if (unanimousNoDissent(t) && !dissentExplained(t).length) flags.push('零反对·**未决·疑似顺从**（已按"无异议"处理，但审查记在账上）');
    else if (unanimousNoDissent(t)) flags.push('零反对·已说明为何不反对');
    else if (r.suspicion) flags.push(r.suspicion);
    // 没有投票权的席位出过声 ⇒ 挂在规则上，**不许被静默忽略**（讨论C）
    if (t.outsiderNote) flags.push(t.outsiderNote);
    L.push(`  ${String(r.id).padEnd(4)}[${r.status}] ${r.topic}${revs ? `   修订 ${revs} 次` : ''}   票：${t.state}${flags.length ? `   ⚑ ${flags.join(' / ')}` : ''}`);
    L.push(`      ${oneLine(r.text, 92)}`);
    L.push(`      证据：${oneLine(r.evidence, 84)}`);
    if (t.conditional.length) for (const v of t.conditionalVotes) L.push(`      条件（${v.role}）：${oneLine(v.conditions, 78)}`);
  };
  L.push(`── enforced: code（被 exit code 强制 —— 投票改不掉它，改它要改代码）${hard.length} 条`);
  if (!hard.length) L.push('  （没有）'); else for (const r of hard) dump(r);
  L.push('');
  L.push(`── enforced: text（只是建议 —— 没有程序拦它）${soft.length} 条`);
  if (!soft.length) L.push('  （没有）'); else for (const r of soft) dump(r);
  L.push('');
  if (gone.length) {
    L.push(`── 已否决 / 已废止（折叠在这里，别让它们消失）${gone.length} 条`);
    for (const r of gone) dump(r);
    L.push('');
  }
  const pct = live.length ? Math.round((soft.length / live.length) * 100) : 0;
  L.push(`文本规则 ${soft.length} 条 / 硬规则 ${hard.length} 条 —— 文本规则占比 ${pct}%`);
  L.push('  提示：文本规则占比越高，说明这个 skill 越依赖模型自觉、越不可靠 —— 这个数字本身就是要盯的指标。');
  if (gone.length) L.push(`  （另有已否决/已废止 ${gone.length} 条，没计入上面的占比 —— 它们已经不在册生效了）`);
  const needAmend = live.filter((r) => r.status === RULE_PENDING_CONDITIONS);
  if (needAmend.length) {
    L.push('');
    L.push(`★ ${needAmend.length} 条规则在「${RULE_PENDING_CONDITIONS}」：票里附了条件，条件没并进正文之前**不许当通过** ——`);
    L.push(`    node warden.mjs rule amend --id ${needAmend[0].id} --text "…（并入条件后的新文本）"   ← 并完修订号 +1，要重新投票`);
  }
  return { text: L.join('\n'), code: 0 };
}

/** `warden rule status --id R7 [--promote]`：单条详情 + 按票机械推进 */
export function ruleDetail(root, id, { promote = false } = {}) {
  const dir = path.join(root, WARDEN_DIR);
  const { rules, revisions } = readRules(dir);
  const rule = rules.find((r) => r.id === id);
  if (!rule) return { err: `规则册里没有 ${id}`, code: 2 };
  const L = [];
  L.push(`${ROLE_STAMP.rules} 规则 ${rule.id} · ${rule.status}`);
  L.push('');
  L.push(`  topic：${rule.topic}（修订号 ${ruleRev(rule.topic)}）`);
  L.push(`  enforced：${rule.enforced}${rule.enforced === 'code'
    ? ' —— 被 exit code 强制（投票改不掉它，改它要改代码）'
    : ' —— 只是建议：**没有程序拦它，别假装它被强制**'}`);
  L.push(`  文本：${rule.text}`);
  L.push(`  证据：${rule.evidence}`);
  if (rule.at) L.push(`  进册：${new Date(rule.at).toLocaleString('zh-CN')}${rule.by ? `  · 由 ${rule.by}` : ''}`);
  const mine = revisions.filter((r) => r.id === id);
  L.push('');
  L.push(`  修订历史（${mine.length} 次）：`);
  if (!mine.length) L.push('    （没改过）');
  for (const r of mine) {
    L.push(`    ${r.from?.topic ?? '?'} → ${r.to?.topic ?? '?'}   ${r.at ? new Date(r.at).toLocaleString('zh-CN') : '?'}${r.force ? '  [--force]' : ''}${r.amend ? '  [amend]' : ''}`);
    L.push(`      旧状态 ${r.from?.status ?? '?'} → 提案；旧文本：${oneLine(r.from?.text, 70)}`);
    L.push(`      为什么：${r.why || '（没写）'}${r.by ? `   （${r.by}）` : ''}`);
    for (const c of (r.conditions ?? [])) L.push(`      上一版附的条件（${c.role}，投的是 ${c.choice ?? '?'}）：${oneLine(c.conditions, 76)}`);
  }
  const t = tallyVotes(dir, rule.topic);
  L.push('');
  L.push(`  当前票数：${JSON.stringify(t.counts)}${t.missing.length ? `   缺席：${t.missing.join('、')}` : ''}`);
  for (const role of (t.roster ?? VOTE_ROLES)) {
    const v = t.votes.find((x) => x.role === role);
    L.push(`    ${role.padEnd(6)}${v ? `${v.choice}   ${oneLine(v.reason, 56)}` : '（缺席）'}`);
    if (v && String(v.conditions ?? '').trim()) L.push(`           ⚑ 附条件：${oneLine(v.conditions, 70)}`);
    if (v && String(v.address ?? '').trim()) L.push(`           ↳ 回应：${oneLine(v.address, 70)}`);
  }
  // 本议题开启之后才加进来的席位：**不许追溯卡死它**，但要说出来（不然读的人以为"没人缺席"）
  const _laterSeats = VOTE_ROLES.filter((r) => !(t.roster ?? VOTE_ROLES).includes(r));
  if (_laterSeats.length) L.push(`    （${_laterSeats.join('、')} 是本议题开启之后才加的席位，不计入应到）`);
  L.push(`  票况：${t.state}    （应到名单来源：${t.rosterFrom ?? '默认'}）`);
  if (t.majorityBaseNote) L.push(`  ⚑ ${t.majorityBaseNote}`);
  if (t.accountNote) L.push(`  ⚑ ${t.accountNote}`);
  if (t.selfAddressedNote) L.push(`  ⚠ ${t.selfAddressedNote}`);
  if (t.outsiderNote) L.push(`  ⚑ ${t.outsiderNote}`);
  const why = ruleUnresolved(t);
  L.push(`  未决原因：${why ?? '（没有 —— 票收齐了，也没有没被回应的异议）'}`);
  if (t.conditional.length) {
    L.push(`  ★ ${t.conditional.length} 张票附了条件 —— 条件并进正文之前，这些"同意"不算干净：`);
    for (const v of t.conditionalVotes) L.push(`      ${v.role}：${oneLine(v.conditions, 76)}`);
  }
  const adv = advanceRule(dir, rule, { promote });
  L.push('');
  L.push(`  推进：${adv.msg}`);
  const detail = (adv.detail && adv.detail.length) ? adv.detail : zeroDissentDetail(t, rule.topic);
  for (const d of detail) L.push(d);
  if (adv.changed) L.push(`  现在的状态：**${adv.status}**（已追加写回 ${WARDEN_DIR}/${RULES_FILE}）`);
  return { text: L.join('\n'), code: adv.code };
}

// ------------------------------------------------------------------ CLI
/* ==========================================================================
 * 补丁块 B —— 子命令实现
 * ========================================================================== */

/**
 * ★★ **本单实测出来的一个真 bug（不许悄悄绕过它，要说出来）**：
 *   `handover-gate.js:1094` 的 `lastRoundOf()` 读的是 **`o.req`**，
 *   而 `warden.mjs record` 写进 `.warden/ROUNDS.jsonl` 的字段名是 **`requirement`**
 *   （`warden.mjs:5507` `requirement: req`）。实测：
 *     · 拿**真账本**（`F:\<USER>\Documents\GitHub\coco26\.warden\ROUNDS.jsonl`）喂它 ⇒
 *       返回 **`"? / partial"`** —— 需求号那一半**永远是 `?`**；
 *     · 手写一条 `{"req":"R10","status":"x"}` 它才认（而账本里**没有**这种行）。
 *   ⇒ 后果：**草稿里"本轮 record"那一行永远是 `? / <status>`，需求号丢了** ——
 *     而这一行正是"接手的人知道这轮在推进哪条需求"的唯一来源。
 *
 * ⚠ **我不改 `handover-gate.js`**（任务书明令：它正被另一单碰着，会撞墙）。
 *   做法：**在本文件里做一次规范化** —— 把 `requirement` 映射成 `req` 之后**自己算**，
 *   并**优先**用自己算的（它认两种字段名）；`lastRoundOf` 只当退路。
 *   这样即使那边以后修好了，本命令**照样对**（向后兼容，不会双重修复出问题）。
 *   ➜ 这条要**报给主代理**：`handover-gate.js` 那份是**独立的真 bug**，
 *     影响的是**它自己**自动草稿里那一行（不只我这边的显式命令）。
 */
export function lastRoundNormalized(root, I) {
  const p = path.join(root, '.warden', 'ROUNDS.jsonl');
  try {
    if (!fs.existsSync(p)) return '';
    const lines = String(fs.readFileSync(p, 'utf8')).split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l) continue;
      let o = null;
      try { o = JSON.parse(l); } catch (e) { continue; }
      if (!o || typeof o !== 'object') continue;
      // ★ 两种字段名都认：`req`（插件口径）与 `requirement`（warden.mjs 的真实口径）
      const req = String(o.req ?? o.requirement ?? '').trim();
      const st = String(o.status ?? '').trim();
      if (!req && !st) continue;
      return (req || '?') + ' / ' + (st || '?');
    }
    return '';
  } catch (e) {
    // 读不动就退回插件那份（它至少还能给出 status 那一半）
    try { return I.lastRoundOf(root); } catch (e2) { return ''; }
  }
}

/**
 * 本轮的"改动清单"从哪里来（**这是本命令唯一一处"猜"，必须写清**）。
 *
 * ★ **实测结论（2026-09-26）**：`handover-gate.js` 的 `draftDirtyNow()` 拿的是
 *   **插件内存 state**（`state.pending` / 本回合脏桶）—— 那条路只有在**插件的写闸
 *   判定链**上才成立（它靠 `onToolResult` 记账）。
 *   而**显式命令**跑在**另一个进程**里：它**没有**那份内存 state。
 *   ⇒ 所以本命令**不用** `draftDirtyNow`，改用**可从盘上复算**的判据：
 *
 *     ① 优先 `--files a,b,c`（**显式声明**，人来给）—— 最可靠，永远是第一顺位；
 *     ② 否则用 `git status --porcelain`（工程根必须是 git 仓库）——
 *        只取 **修改/新增/重命名** 的**文件**（不取目录），
 *        **排除 `.warden` / `.dsh`**（沿用 `AUTO_DRAFT_EXCLUDE_DIRS` 的口径）；
 *     ③ 两条都拿不到 ⇒ **`no-dirty`，不写**（**不许**退回"整个工作区都算改动"）。
 *
 * ⚠ **第 ② 条的已知偏差，如实标注**：
 *   · 它算的是"**相对 HEAD 的未提交改动**"，**不是**"这一轮改的"。
 *     若一轮里改了又 commit，它**看不见** ⇒ 会判 `no-dirty` ⇒ **不写**。
 *     这是**fail-closed** 的方向（宁可不写，也不许写一份改动清单是错的草稿），
 *     但它意味着：**要求准确的清单，就显式给 `--files`。**
 *   · `git status` 会把**别的会话/子代理**改的文件也算进来（本仓实测有并发写同一棵树）
 *     ⇒ 清单可能**偏大**。这一条**没法从盘上消除**，所以草稿里明写来源。
 *   · **无 git 的工程**（`.git` 不存在）⇒ 第 ② 条拿不到 ⇒ 只能靠 `--files`。
 *
 * 返回 `{ paths, dropped, src }`；`src` 会**逐字写进草稿与留痕**（不许静默换口径）。
 */
export function collectDirtyFiles(root, opts = {}) {
  const explicit = Array.isArray(opts.files) ? opts.files.filter((s) => String(s || '').trim()) : [];
  if (explicit.length) return { paths: explicit.map((s) => String(s)), dropped: 0, src: '显式声明 --files' };

  let out = '';
  let code = null;
  try {
    const { spawnSync } = require_childProcess();
    const r = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
      cwd: root, encoding: 'utf8',
      // ⚠ 必须 `pipe` 才拿得到输出。**本沙箱里 pipe 会 EPERM**（见文末"没能验证"）——
      //   被拒时下面是 catch 分支 ⇒ 判 no-dirty ⇒ 不写（fail-closed），不是静默成功。
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r && r.error) throw r.error;
    code = r ? r.status : null;
    if (code !== 0) throw new Error(`git status 退出码 ${code}`);
    out = String(r.stdout || '');
  } catch (e) {
    return { paths: [], dropped: 0, src: '（拿不到：' + String((e && e.message) || e).slice(0, 80) + '）', failed: true };
  }

  const seen = new Map();
  let dropped = 0;
  // `-z` 分隔空字节；重命名是 "R  new\0old\0" 两段，这里只关心**新路径**
  const parts = out.split('\0').filter((s) => s.length >= 4);
  for (const p of parts) {
    const flag = p.slice(0, 2);
    if (flag[0] === 'R' || flag[0] === 'C') continue; // 重命名/复制的旧路径段，跳过
    const rel = p.slice(3);
    if (!rel) continue;
    const seg = rel.replace(/\\/g, '/').split('/');
    if (seg.length >= 2 && (seg[0] === '.warden' || seg[0] === '.dsh')) { dropped += 1; continue; }
    const k = rel.toLowerCase();
    if (!seen.has(k)) seen.set(k, path.join(root, rel));
  }
  return { paths: Array.from(seen.values()).sort(), dropped, src: 'git status --porcelain（相对 HEAD 的未提交改动）' };
}

/** 延迟取 `node:child_process`（顶层静态 import 也可以，这里只为把依赖收在一处） */
function require_childProcess() {
  return { spawnSync: _spawnSync };
}
let _spawnSync = null;
try {
  // eslint-disable-next-line
  _spawnSync = (await import('node:child_process')).spawnSync;
} catch (e) { _spawnSync = null; }

/**
 * append 一行留痕到 `.warden/HANDOVER-GATE.jsonl`（记录② 的落点）。
 *
 * ⚠ **为什么是 `HANDOVER-GATE.jsonl`**：任务书给了"或你论证更合适的位置"。
 *   论证：**同一个文件名、同一个目录**已经是这个功能的账
 *   （`handover-gate.js:652` 的候选顺序就是 `<root>/.warden/HANDOVER-GATE.jsonl`）。
 *   另起一本 ⇒ 查"跑过没跑过"要翻两个文件 ⇒ 记录② 想解决的"C 与 B 不可区分"
 *   会**原样复发**（两个账本各记一半，谁也不全）。所以**并进同一本**。
 *   ⚠ 与插件写的那本**共用一个文件**，所以字段名刻意与它**不冲突**：
 *   插件写 `ev`，本命令写 `ev: 'handover-cmd'` + `kind`；两边的行都能被同一套 grep 捞出来。
 *
 * ⚠ **写留痕失败怎么办**（盘不可写）：
 *   草稿**已经写成了** ⇒ **不许**因为留痕失败就报"整体失败"（那是把已成功的事说成失败）。
 *   做法：草稿保留、**明写"留痕失败"**、exit code 用 **0**（写成功）但**在正文显著位置报警**，
 *   并且**不**把 `--dry` 的路径算进来。反过来，如果**草稿没写成**、留痕也失败 ⇒ exit 非 0。
 */
export function appendHandoverLedger(root, row) {
  const p = path.join(root, WARDEN_DIR_NAME, HANDOVER_LEDGER_NAME);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, path: p, why: String((e && e.message) || e).slice(0, 160) };
  }
}

const WARDEN_DIR_NAME = '.warden';

/** 谁调的 —— **主代理**（提问闸门那条硬要求：执行者必须是主代理） */
function callerOf() {
  const sid = String(process.env.DSH_SESSION_ID || '').trim();
  return {
    by: '主代理',
    session: sid || null,
    pid: process.pid,
    at: new Date().toISOString(),
  };
}

/**
 * ★★ **本命令的唯一入口**。
 *
 * `argv` = `handover` 之后的参数（例如 `['draft','--next','…','--dry']`）。
 * 返回 **exit code**（0/1/2），**绝不抛**。
 *
 * 判定顺序（**写在这里，代码就按这个顺序**）：
 *   1. 认子命令（`draft` / `log`）—— 不认识 ⇒ 用法错 exit 2
 *   2. `draft`：
 *      a. 同时给 `--next` 与 `--no-next` ⇒ **拒**（两个声明互相打架，不替人挑一个）exit 2
 *      b. 两个都没给 ⇒ **拒**（`no-declaration`）exit 2
 *      c. `--no-next` ⇒ **只留痕、不写草稿、不动写闸** ⇒ exit 0
 *      d. `--next` ⇒ 载入插件 → 工程根 → 改动清单 → `buildAutoDraft` → 四道阀 → 写/不写
 *   3. `log`：把留痕读出来（**只读**）
 */
export async function runHandoverDraft(argv, ctx = {}) {
  const out = ctx.out || ((s) => console.log(s));
  const err = ctx.err || ((s) => console.log(s));
  try {
    const a = Array.isArray(argv) ? argv.slice() : [];
    const sub = String(a[0] || '').trim();
    const rest = a.slice(1);
    const has = (f) => rest.includes(f);
    const opt = (n) => {
      const i = rest.indexOf(`--${n}`);
      return i >= 0 && i + 1 < rest.length && !String(rest[i + 1]).startsWith('--') ? rest[i + 1] : undefined;
    };

    if (sub === 'log') return handoverLog(rest, ctx, out);
    if (sub !== 'draft') {
      err('用法错：handover 只有两个子命令 —— `draft`（收口时写一次）与 `log`（查跑过没跑过）。');
      err('  node warden.mjs handover draft --next "下一步是什么"');
      err('  node warden.mjs handover draft --no-next "活已做完，只需用户 push"');
      err('  node warden.mjs handover log [--last N] [--json]');
      return 2;
    }

    const root = ctx.root;
    const dry = has('--dry');
    const next = opt('next');
    const noNext = opt('no-next');

    /* ── a. 两个声明打架 ⇒ 拒 ───────────────────────────────────────────── */
    if (next !== undefined && noNext !== undefined) {
      err('[拒收] 你同时给了 `--next` 和 `--no-next` —— 这是两个**互相打架**的声明。');
      err('  `--next "…"`     = 这一轮做完还有后续 ⇒ **写**交接草稿');
      err('  `--no-next "…"`  = 这一轮明确完成、无后续 ⇒ **不写**，只留痕');
      err('  不替你挑一个：你说的是哪一种？删掉另一个再来。');
      return 2;
    }

    /* ── b. 什么都没声明 ⇒ 拒（这也是"默认什么都不做"的守卫） ───────────── */
    if (next === undefined && noNext === undefined) {
      err('[拒收] 没有声明「这一轮做完**还有没有后续**」—— 所以什么都不做。');
      err('  为什么必须有这一句：交接的写入判据是**显式声明**，不是从账本里猜。');
      err('    实测 `.warden/ROUNDS.jsonl` 114 条里 `plan` 只有 1 条非空、`branch` 0 条');
      err('    ⇒ 账本里**没有**可靠信号能判"有没有后续"。');
      err('  两条正路（选一条）：');
      err('    · 有后续、要留交接：node warden.mjs handover draft --next "把 X 推到远端，然后重跑自检"');
      err('    · 已做完、无后续：  node warden.mjs handover draft --no-next "活已做完，只需用户 push"');
      return 2;
    }

    /* ── c. --no-next：正规出口。只留痕，不写草稿，不动写闸 ─────────────── */
    if (noNext !== undefined) {
      const text = String(noNext).trim();
      if (!text) {
        err('[拒收] `--no-next` 后面那句话是空的（只有空白 = 没声明）。');
        err('  说清**为什么算"明确完成、无后续"** —— 这一句就是这一轮的判定依据。');
        return 2;
      }
      const who = callerOf();
      if (dry) {
        out('（--dry）会留痕这样一行，**不落盘**：');
        out('  ' + JSON.stringify({
          ev: 'handover-cmd', kind: 'no-next-declared', at: who.at, by: who.by,
          session: who.session, root, reason: text, wrote_draft: false,
        }));
        out('');
        out('⇒ --dry：不写草稿（本来就是），也**不落盘**留痕。');
        return 0;
      }
      const led = appendHandoverLedger(root, {
        ev: 'handover-cmd', kind: 'no-next-declared', at: who.at, by: who.by,
        session: who.session, pid: who.pid, root: root,
        reason: text,          // ← 显式声明的那句**原话**，不加工
        wrote_draft: false,
        next_src: '--no-next',
      });
      out('✓ 记下：这一轮 = **明确完成、无后续**（不写交接草稿）。');
      out('  为什么算无后续：' + text);
      out('  留痕：' + (led.ok ? led.path : '★ 写不进（' + led.why + '）'));
      out('');
      out('  ⚠ 这条命令**不消写闸欠账**（故意的）—— 要消欠账，就得真写一份交接（--next）。');
      out('    否则"被写闸拒时随手跑一次清欠账"就会变成新的坏习惯（监督员① 点名的那个坑）。');
      return led.ok ? 0 : 0;   // 留痕失败**不改** exit code：这一轮的声明已经生效
    }

    /* ── d. --next：真写路径 ───────────────────────────────────────────── */
    const nextText = String(next).trim();
    if (!nextText) {
      err('[拒收] `--next` 后面那句话是空的（只有空白 = 没声明有后续）。');
      err('  ⚠ 这一条就是安全阀 (3)：**未声明有后续 ⇒ 不写**。');
      return 2;
    }

    // d-0. 工程根（**问就能问出来**，见 warden.mjs 的 findProjectRootVia 那一段）
    const via = ctx.projVia || 'unknown';
    const wdir = path.join(root, WARDEN_DIR_NAME);
    if (!fs.existsSync(wdir)) {
      err('[拒收] 这个工程根下没有 `' + WARDEN_DIR_NAME + '`：' + root);
      err('  留痕与 record 都要写在那儿，没有它 = 这一轮没有账可挂。');
      err('  先跑：node warden.mjs init');
      return 2;
    }

    // d-1. 插件（复用它已有的安全阀口径；**找不到就拒收，不猜常量**）
    const g = loadHandoverGate();
    if (!g.ok) {
      err('[拒收] 找不到可用的 `handover-gate.js` —— **不猜一份常量**（猜错会让覆盖保护失效）。');
      err('  找过这些位置：');
      for (const t of g.tried) err('    · ' + t);
      err('  它在哪：装上 task-warden 插件的那一层；或设 `DSH_HOME` 指到你的 `.dsh`。');
      err('  ⚠ 宁可不写，也不许用一份可能已经过期的标记串去动别人的文件。');
      return 2;
    }
    const I = g.I;

    // d-2. 改动清单（口径来源会**逐字**写进草稿与留痕）
    const dirty = collectDirtyFiles(root, { files: (opt('files') || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean) });
    const filt = I.draftPaths(root, dirty.paths);
    const allPaths = filt.paths;
    const droppedTotal = (filt.dropped || 0) + (dirty.dropped || 0);

    // d-3. 目标文件名 + 安全阀 (1)
    const dateKey = I.localDateKey(new Date());
    if (!dateKey) {
      err('[拒收] 算不出今天的日期（`localDateKey` 返回空）—— **不猜**，这一轮不写。');
      return 2;
    }
    const target = path.join(root, I.autoDraftName(dateKey));
    const targetName = path.basename(target);
    const recognized = I.isHandoverName(targetName);

    let exists = false;
    try { exists = fs.existsSync(target); } catch (e) { exists = false; }
    if (exists) {
      const mine = I.hasAutoMark(target);
      if (!mine) {
        err('[拒收] **绝不覆盖**：目标文件已经存在，而且首行不是 `' + I.HANDOVER_AUTO_MARK + '`。');
        err('  目标：' + target);
        err('  判据不是"文件存不存在"，而是"**它是不是机器自己写的**"。');
        err('  读不出来（权限/编码）也当成"不是我的" ⇒ 不写（fail-closed 方向）。');
        err('  ⇒ 这是**别人的文件**（用户/主代理手写的）。要么换个日期/换个名字，要么先自己处理它。');
        const who0 = callerOf();
        appendHandoverLedger(root, {
          ev: 'handover-cmd', kind: 'refused:foreign-exists', at: who0.at, by: who0.by,
          session: who0.session, pid: who0.pid, root: root, target: target,
          next_src: '--next', wrote_draft: false, why: '目标已存在且无 AUTO 标记 ⇒ 绝不覆盖',
        });
        return 1;
      }
    }

    // d-4. 安全阀 (2)：零改动 ⇒ 不写
    const round = lastRoundNormalized(root, I);
    const text = I.buildAutoDraft({
      at: new Date().toISOString(),
      root: root,
      paths: allPaths,
      dropped: droppedTotal,
      round: round,
      next: nextText,
      nextSrc: '--next（显式命令 handover draft）',
      rerun: (opt('rerun') || '').trim(),
    });

    if (!allPaths.length) {
      err('[拒收] 这一轮的改动清单是**空的** ⇒ 不写（安全阀 (2)：零改动不写）。');
      err('  清单来源：' + dirty.src);
      err('  ⇒ 要准确的清单，显式给：--files "src/a.rs,crates/b/src/lib.rs"');
      err('  ⚠ 不许退回"整个工作区都算改动" —— 那会把噪声当内容写进交接。');
      const who0 = callerOf();
      const led = appendHandoverLedger(root, {
        ev: 'handover-cmd', kind: 'refused:no-dirty', at: who0.at, by: who0.by,
        session: who0.session, pid: who0.pid, root: root, target: target,
        next_src: '--next', wrote_draft: false,
        dirty_src: dirty.src, why: '零改动 ⇒ 不写',
      });
      if (!led.ok) err('  （留痕也没写成：' + led.why + '）');
      return 1;
    }

    // d-5. `--dry`：只打印会写什么，**不落盘**（安全阀 (4)）
    const bytes = I.utf8ByteLength(text);
    if (dry) {
      out('（--dry）**不落盘**。本来会写这些：');
      out('  目标文件： ' + target);
      out('  文件名会被 isHandoverName() 认成交接文件吗： **' + (recognized ? '会' : '不会') + '**');
      out('  字节数：   ' + bytes);
      out('  清单来源： ' + dirty.src);
      out('  排除掉：   ' + droppedTotal + ' 条（工程根外 / 在 .warden、.dsh 下）');
      out('  本轮 record：' + (round || '（读不到最后一条）'));
      out('  目标已存在：' + (exists ? '是（是机器自己的草稿 ⇒ 允许覆盖）' : '否（新建）'));
      out('');
      out('──────── 草稿正文（逐字）────────');
      out(text.replace(/\n$/, ''));
      out('────────────────────────────────');
      return 0;
    }

    // d-6. 写
    let wrote = false; let writeWhy = '';
    try {
      fs.writeFileSync(target, text, 'utf8');
      wrote = true;
    } catch (e) {
      wrote = false; writeWhy = String((e && e.message) || e).slice(0, 160);
    }

    const who = callerOf();
    const led = appendHandoverLedger(root, wrote
      ? {
        ev: 'handover-cmd', kind: 'auto-draft-written', at: who.at, by: who.by,
        session: who.session, pid: who.pid, root: root, target: target,
        bytes: bytes, files: allPaths.length, dropped: droppedTotal,
        round: round || null, next_src: '--next', next: nextText,
        dirty_src: dirty.src, recognized_as_handover: recognized, wrote_draft: true,
      }
      : {
        ev: 'handover-cmd', kind: 'refused:write-failed', at: who.at, by: who.by,
        session: who.session, pid: who.pid, root: root, target: target,
        next_src: '--next', wrote_draft: false, why: writeWhy,
      });

    if (!wrote) {
      err('[失败] 写不进这个文件：' + target);
      err('  原因：' + writeWhy);
      err('  这一轮**没有**写成交接（不许说成写成了）。');
      if (!led.ok) err('  （留痕也没写成：' + led.why + '）');
      return 1;
    }

    out('✓ 写好交接草稿：' + target + '（' + bytes + ' 字节）');
    out('  文件名会被 isHandoverName() 认成交接文件吗： **' + (recognized ? '会' : '不会') + '**');
    out('  改动文件：' + allPaths.length + ' 个（排除 ' + droppedTotal + ' 条）');
    out('  本轮 record：' + (round || '（读不到最后一条）'));
    out('  下一步（逐字）：' + nextText);
    out('  留痕：' + (led.ok ? led.path : '★ 写不进（' + led.why + '）← 草稿已写成，但"跑过没跑过"这条证据缺了'));
    if (!led.ok) {
      out('');
      out('  ⚠ **留痕失败** —— 记录② 要的正是"命令跑没跑过"这条可查痕迹，它现在缺了。');
      out('    草稿是真写成了（上面那行），所以 exit code 仍是 0，**不把成功说成失败**；');
      out('    但这件事**必须**报出来：没有留痕，C（显式命令）与 B（什么都不做）又不可区分了。');
    }
    return 0;
  } catch (e) {
    // ★ 绝不抛：兜底也给人话，不甩栈
    err('[失败] handover 命令内部出错（已兜住，没有甩栈）：' + String((e && e.message) || e));
    err('  这一轮**什么都没写**。请把上面这一行报给主代理。');
    return 2;
  }
}

/** `handover log` —— 把留痕读出来（**只读**） */
function handoverLog(rest, ctx, out) {
  const root = ctx.root;
  const json = rest.includes('--json');
  const i = rest.indexOf('--last');
  const last = i >= 0 ? Math.max(1, Number(rest[i + 1]) || 20) : 20;
  const p = path.join(root, WARDEN_DIR_NAME, HANDOVER_LEDGER_NAME);
  if (!fs.existsSync(p)) {
    out('[查不到] 没有这本留痕：' + p);
    out('  ⚠ "查不到" **不等于** "没跑过" —— 它是"这本账还没被建起来"。');
    out('    第一次跑 `handover draft …` 之后就有了。');
    return 2;
  }
  let rows = [];
  try {
    rows = String(fs.readFileSync(p, 'utf8')).split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch (e) { return { _bad: l.slice(0, 120) }; }
    });
  } catch (e) {
    out('[失败] 读不动这本留痕：' + p + ' —— ' + String((e && e.message) || e));
    return 2;
  }
  const mine = rows.filter((r) => r && r.ev === 'handover-cmd');
  const tail = mine.slice(-last);
  if (json) { out(JSON.stringify({ path: p, total: rows.length, cmd: mine.length, rows: tail }, null, 2)); return 0; }
  out('留痕：' + p);
  out('  总行数 ' + rows.length + '（其中本命令写的 ' + mine.length + ' 条）· 下面是最新 ' + tail.length + ' 条：');
  for (const r of tail) {
    out('  · ' + String(r.at || '?') + '  ' + String(r.kind || '?')
      + (r.target ? '  → ' + r.target : '')
      + (r.reason ? '  「' + r.reason + '」' : '')
      + (r.why ? '  （' + r.why + '）' : ''));
  }
  const written = mine.filter((r) => r.kind === 'auto-draft-written').length;
  const noNextN = mine.filter((r) => r.kind === 'no-next-declared').length;
  const refused = mine.filter((r) => String(r.kind || '').startsWith('refused:')).length;
  out('');
  out('  ⇒ 写成交接 ' + written + ' 次 · 声明无后续 ' + noNextN + ' 次 · 被拒 ' + refused + ' 次。');
  out('  ⚠ 「声明无后续」**不是**"任务做完了"的证据 —— 它只证明有人这么声明过。');
  return 0;
}

function main(argv) {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'check';
  // 工程根按 .git 认，不按当前目录 —— 否则会话工作区里会串项目（实测踩过）
  const cwdAbs = path.resolve(process.cwd());
  const { root, via } = findProjectRootVia(cwdAbs);
  const wdir = path.join(root, WARDEN_DIR);

  /**
   * ★ 身份守卫⓪（**最外面这一道**，2026-09-16 由「审查」坐实后补上）：
   *   在一个**既没有 `.git`、也没有 `.warden`** 的目录里跑命令，
   *   原来会**静默**落到祖先的 `.warden` 上：`init` 在祖先账本里建骨架、本地零提示、**exit 0**；
   *   读命令则直接打出**隔壁项目的欠账表**（R14/R19/R27…）。
    *   用户描述这个现象为两个项目读到了对方的守则—— 这就是那条路，而且它**不报错**。
   *
   * ⚠ 这一道**对所有命令生效**（不只 `init`）。
   *   我第一版只卡 `init`、给读命令留一句"账本是从上层借来的"提醒 —— 那是错的：
   *   `via === 'ancestor-warden'` **只可能**发生在"你这层什么都没有、上层装着 .warden"的时候
   *   （你这层有 `.warden` → 就是 `self`；有 `.git` → 就是 `git`），
   *   所以那句提醒**永远打不出来**，是死代码；而"静默读到别人账本"正是事故本身。
   *   永久回归用例 `experiments/lab/L3_isolation.mjs` ① 也明确要求"容器目录里必须被拒绝"。
   *
   * 读命令会不会被误伤？会的那一种情况（**无 `.git` 工程的子目录**）恰恰就是本次事故的路径 ——
   * 想要它，就显式说 `--allow-ancestor`。判断的确定性来自 `.git`：**先 `git init` 再跑，就不会歧义**。
   */
  if (cmd !== 'help' && via === 'ancestor-warden' && !argv.includes('--allow-ancestor')) {
    const mine = fs.existsSync(path.join(cwdAbs, WARDEN_DIR));
    const myGit = fs.existsSync(path.join(cwdAbs, '.git'));
    if (!mine && !myGit) {
      console.log('拒绝操作：**你要动的不是这个目录的账本。**');
      console.log(`  你在这里：       ${cwdAbs}    （既没有 .git，也没有 .warden）`);
      console.log(`  它却要落到：     ${root}    （这一层装着 .warden）`);
      console.log('\n  为什么拒绝：在这层跑下去，**建/读/写的都是那个工程的守则**，而你本地什么都不会有 ——');
      console.log('  实测发生过「两个项目读到了对方的守则」，而且它原来是 **exit 0、零提示**（用户吃了这个亏）。');
      console.log('\n  三条出路：');
      console.log('    1) cd 到真正的工程根（有 .git 的那一层）再跑 —— 这是正路；');
      console.log(`    2) 你就是要**在 ${cwdAbs} 建一个新工程的账**：先在这里 \`git init\`（工程根按 .git 认）；`);
      console.log('    3) 你确实要给上层那个工程干活：显式加 `--allow-ancestor` 再说一遍（那时你会看到一行提醒）。');
      return 2;
    }
  }
  // 显式 --allow-ancestor 放行时，仍然**出声**：别让人以为自己在读自己的账本
  if (via === 'ancestor-warden' && cmd !== 'help') {
    console.log(`⚠ 账本是从**上层**借来的（你显式 --allow-ancestor 了）：${root}`);
  }

  // 身份守卫①：在一个"装着别的工程"的容器目录里跑 → 拒绝，逼你到工程根
  // init 例外：init 正是"声明这里是我的工程根"的动作（它写 projectRoot），必须放它过。
  if (cmd === 'guard') {
    /**
     * `guard` —— 把容器守卫**看到/忽略了什么**全量打出来（清单第 12 条第三句）。
     * 为什么要有这条命令：原来 `findNestedProjects` 的深度截断与 SKIP 名单都是
     * **静默丢弃、零输出**，于是"守卫漏了谁"没人看得出来。check 里只印前 8 条，
     * 全量在这里。（这条命令**只读**，不改任何东西。）
     */
    const a = containerAudit(root);
    console.log(`${ROLE_STAMP.keeper} 容器守卫 · 逐条台账 · ${root}`);
    console.log('');
    if (a.selfIsProject) {
      console.log('  这个目录自己就有 `.git` ⇒ 它是工程根，容器守卫不适用（projects/ignored 都是 0）。');
      return 0;
    }
    console.log(`  它自己没有 .git，但下面是容器。枚举到 **${a.projects.length}** 个有 .git 的子目录：`);
    for (const p of a.projects) console.log(`    ✓ ${path.relative(root, p) || p}`);
    console.log('');
    console.log(`  被忽略 **${a.ignored.length}** 条（每条给理由 —— 这就是"我没看见谁"的台账）：`);
    for (const x of a.ignored) console.log(`    · ${x.path} —— ${x.reason}`);
    console.log('');
    console.log('  ⚠ 只读台账：它**不改**拒绝逻辑。要改判据（例如按"真 git(HEAD+refs)"）之前先看这份，');
    console.log('    因为实测「`<工程>-worktree` 的 .git 是文件（worktree）」会被字面判据误杀。');
    return 0;
  }

  if (cmd !== 'help' && cmd !== 'init' && !argv.includes('--force')) {
    const nested = findNestedProjects(root);
    // **例外**：config.json 里显式声明了"这里就是工程根" → 听它的。
    // 显式声明高于启发式：一个窗口=一个项目（源码放子目录）是合理用法。
    const cfg0 = readConfig(wdir);
    const declared = cfg0.projectRoot && path.resolve(cfg0.projectRoot) === path.resolve(root);
    /**
     * ★ **declared 豁免必须出声**（2026-09-17 加；「方向员」实测、我采纳）。
     *
     * 它为什么重要：这是「两个项目读到对方守则」那条历史事故**剩下的唯一入口**。
     *   实测：`<WORKSPACE>\.warden\config.json` 自报 `projectRoot` ⇒ 容器守卫**静默放行、exit 0**，
     *   一个字都不说 —— 于是"这个目录其实装着 52 个别的工程"这件事，跑的人完全不知道。
     *   ⚠ 只**加一行提示**，**不改拒绝逻辑**（显式声明高于启发式是合理设计，方向员也这么判）。
     *   ⚠ 这是 **AI 提案**（方向员 D4），不是用户逐字要求过的 —— 记在案，别当用户要求引用。
     */
    if (declared && !fs.existsSync(path.join(root, '.git')) && nested.length) {
      console.log(`⚠ 这个目录**没有 .git**，是按 .warden/config.json 的**自报**当工程根的（declared 豁免）。`);
      console.log(`  它下面其实装着 ${nested.length} 个有 .git 的目录 —— 别把它们的需求读成本工程的（历史事故：「两个项目读到了对方的守则」）。`);
      console.log('  想改用真正的工程根：cd 到那个子目录，或者清掉 .warden/config.json 里的 projectRoot。');
    }
    if (nested.length && !declared) {
      console.log('拒绝操作：你现在这个目录**装着别的工程**，不是一个工程根。');
      console.log(`  你在这里： ${root}   （没有 .git）`);
      console.log('  它下面有这些工程：');
      for (const n of nested.slice(0, 6)) console.log(`    ${n}`);
      console.log('\n  为什么拒绝：.warden 落在容器目录上，**谁在这个工作区跑都会读到同一个守则** ——');
      console.log('  实测发生过两个项目读到对方守则。请 cd 到具体工程根再跑。');
      console.log('  如果你就是要把这里当工程根（一个窗口=一个项目，源码放子目录里），');
      console.log('  在 .warden/config.json 里显式声明 projectRoot 即可（显式声明高于启发式判断）。');
      return 2;
    }
  }
  // 身份守卫②：账本不是本工程的，就别往下做
  if (cmd !== 'init' && cmd !== 'help') {
    const bad = guardProject(root, wdir);
    if (bad) { console.log(bad); return 2; }
  }
  // 祖先目录里有错位的 .warden（不在工程根上）→ 只提醒，因为它可能正是别人在用
  if (cmd === 'init') {
    const stray = findStrayWardens(root);
    if (stray.length) {
      console.log('⚠ 发现祖先目录里有**错位**的 .warden（不在它自己的工程根上）：');
      for (const s of stray) console.log(`    ${s.dir}   它自报的工程根：${s.claims}`);
      console.log('  这个账本按新规则**不会**被本工程读到（好事）；但它可能是别的窗口正在用的。');
      console.log('  要么把它搬回它自己的工程根，要么删掉重来。\n');
    }
  }
  const has = (f) => argv.includes(f);
  if (cmd === 'handover') {
    // ★ R10 定案（C 方案 · 显式命令）：只有显式跑这一条才写交接草稿；
    //   默认什么都不做 —— 不跑 ⇒ 与今天一字不差；执行者 = 主代理（不是"让用户去跑"）；
    //   攒批口径 = 轮收口时写一次（这条命令自己的语义就是"收口时跑一次"）。
    // ⚠ runHandoverDraft 是 async ⇒ 不能把它 return 给同步的 main()（那样 exitCode 会收到
    //   一条 Promise ⇒ ERR_INVALID_ARG_TYPE 甩栈）。这一支自己收干净：
    //     · 这里同步返回 0（占位；真正的码由下面 .then 设到 process.exitCode）；
    //     · 失败路径在 runHandoverDraft **内部**已经兜住了（它自己 try/catch，绝不抛）。
    runHandoverDraft(argv.slice(1), { root, projVia: via }).then(
      (code) => { process.exitCode = Number.isInteger(code) ? code : 2; },
      (e) => {
        console.log('[失败] handover 命令没兜住（这是本命令的 bug，请报给主代理）：' + String((e && e.message) || e));
        process.exitCode = 2;
      },
    );
    return 0;
  }

  if (cmd === 'help' || has('--help') || has('-h')) { console.log(HELP); return 0; }
  if (cmd === 'init') {
    const dir = ensureSkeleton(root);
    console.log(`\n骨架在 ${dir}`);
    const sid = currentSessionId();
    console.log(`当前会话：${sid ?? '（环境里没有 DSH_SESSION_ID）'}`);
    console.log('\n下一步：把用户说过的话**逐字**填进 SPEC.md 的「原话」，别改写。');
    return 0;
  }
  if (cmd === 'record') {
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log(`[用法] 先跑：node warden.mjs init`); return 2; }
    const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
    const rounds = readRounds(dir);
    const nextRound = arg('round') ? Number(arg('round')) : (rounds.reduce((m, r) => Math.max(m, Number(r.round) || 0), 0) + 1);
    const req = arg('req');
    const status = arg('status') ?? 'in_progress';
    if (!req) { console.log('[用法] 必须给 --req R1（本轮在推进哪条需求）—— 成本就是靠它归到需求上的。'); return 2; }

    /**
     * ★ 需求必须**在 SPEC.md 里真的存在**，才许记轮次。
     *
     * 实测洞（2026-09-16 由「审查」坐实）：在**空 SPEC** 下 `record --req R1` **exit 0、零警告**，
     * 要等 `report`/`check` 才说"SPEC 里没这条" —— 那时成本已经花掉了。
     * 两个后果，都很坏：
     *   ① 这一笔变成"**挂在不存在需求上的记录**"（真实事故：删掉某条规则的 `试行` 行之后，
     *      4 处引用立刻变成指向不存在的需求）；
     *   ② "我做了 R7"这句话**无法核对** —— 而整个 skill 存在的理由就是"给的对不对能核对"。
     * ⇒ 在**写账本之前**就拒收：先按用户原话把需求逐字锁进 SPEC.md，再记轮次。
     *   **不许"先记着、回头补 SPEC"** —— 那正是把它挂在不存在的需求上。
     */
    const specPathForReq = path.join(dir, 'SPEC.md');
    if (!fs.existsSync(specPathForReq)) {
      console.log(`[拒收] 没有 ${WARDEN_DIR}/SPEC.md —— 先把用户的原话逐字锁进去（append-only），再记轮次。`);
      return 2;
    }
    const specRowsNow = parseSpec(readText(specPathForReq));
    const specIdsNow = specRowsNow.map((x) => x.id);
    const specRowNow = specRowsNow.find((x) => x.id === req);
    if (!specIdsNow.includes(req)) {
      console.log(`[拒收] SPEC.md 里**没有**这条需求：${req}`);
      console.log(`  SPEC 现在有的需求号：${specIdsNow.join('、') || '（一条都没有 —— SPEC 是空的）'}`);
      console.log('  写错号的代价是"这一轮白干、而且没人知道"：先把需求按用户原话逐字锁进 SPEC.md，再记轮次。');
      console.log('  （不许"先记着、回头补 SPEC" —— 那就是把记录挂在不存在的需求上。）');
      return 2;
    }

    /**
     * ★★ **原话逐字核对**（2026-09-25 新增；用户报的真事故：AI 改写用户原话来让自己更容易"完成"）。
     *
     * 事故现场：AI 把 SPEC.md 里 R3 的「原话」从「加入与替换」改写成「加入和替换」，
     *   引号内还塞了 `**`（markdown 加粗）。check 抓到了（reject），但那是**事后**的 ——
     *   AI 可以不跑 check、或忽略结果、或先 record 了再说。
     *   而改写后的原话要求更宽松 ⇒ AI 更容易"完成" ⇒ **有动机改**。
     *
     * ⇒ 在 **record 这一步**就拦：SPEC.md 里这条需求的「原话」必须与用户真消息语料逐字一致，
     *   否则拒收。这样 AI 改写原话**没有用** —— 即使改了 SPEC，也 record 不了、也就 done 不了。
     *   ⚠ 语料为空时不拦（可能只是没同步，不是改写）—— 与 check 的处理一致。
     *   ⚠ `too-short` 不拦（太短的原话由 check 的"缺原话或太短"判据管）。
     */
    if (specRowNow && specRowNow.quote && specRowNow.quote.length >= 8) {
      const corpus = corpusText(root);
      if (corpus) {
        const vq = verifyQuote(root, specRowNow.quote, corpus);
        if (vq.verdict !== 'verbatim' && vq.verdict !== 'too-short') {
          console.log(`[拒收] ${req} 的「原话」在用户真消息语料里逐字找不到 —— 你改写了用户原话。`);
          console.log(`  SPEC 里写的：${String(specRowNow.quote).slice(0, 80)}`);
          console.log(`  判据：${vq.verdict}${vq.ratio != null ? `（相似度 ${Math.round(vq.ratio * 100)}%）` : ''}`);
          console.log('  为什么拒收：改写用户原话 = 需求漂移。AI 改写后要求变宽松，更容易"完成" ——');
          console.log('    这正是整套机制存在的理由。把原话改回用户逐字说过的那句话，再 record。');
          console.log('  （如果语料还没同步：先跑 `node warden.mjs voices`，然后重试。）');
          return 1;
        }
      }
    }

    // 脚本自己读当前值（权威）
    const ws = parseParams(fs.readFileSync(path.join(dir, 'params.yml'), 'utf8'));
    const actual = {}; const unreadable = [];
    for (const w of ws) {
      const r = readWatch(root, w);
      if (r.ok) actual[w.id] = r.value; else unreadable.push(`${w.id}: ${r.err}`);
    }
    for (const u of unreadable) console.log(`提醒: [档位] 读不到当前值 —— ${u}`);

    // 与 AI 写进来的值对账（用户选的就是"两者都要 + 交叉验证"）
    const declaredRaw = arg('values');
    if (declaredRaw) {
      let declared = {};
      try { declared = JSON.parse(declaredRaw); }
      catch { console.log(`[用法] --values 不是合法 JSON：${declaredRaw}`); return 2; }
      const bad = [];
      for (const [k, v] of Object.entries(declared)) {
        if (!(k in actual)) continue;
        if (!sameValue(v, actual[k])) bad.push(`  ${k}: 你写 ${v}，源码里实际是 ${actual[k]}`);
      }
      if (bad.length) {
        console.log('[对账失败] 你记的档位值和源码里读出来的**不一致**：');
        for (const b of bad) console.log(b);
        console.log('值以源码为准 —— 请重新确认后再说一遍"这轮改了什么"。');
        return 1;
      }
      console.log(`[对账通过] ${Object.keys(declared).length} 个档位值与你记录的一致。`);
    }

    // 要改"已经确认完成"的东西？先备份、再交出规划（用户 2026-09-16 定的流程）
    const reopen = reopenGate(root, dir, req, status, arg('why'), arg('plan'));
    if (!reopen.ok) { console.log(`[拒收] ${reopen.why}`); return reopen.code ?? 2; }
    if (reopen.note) console.log(`[记录员] ${reopen.note}`);

    const rec = {
      round: nextRound,
      requirement: req,
      status,
      delivered: arg('delivered') ?? '',
      evidence: arg('evidence') ?? '',
      why: arg('why') ?? '',
      plan: arg('plan') ?? '',
      session: currentSessionId(),
      at: new Date().toISOString(),
    };
    // --no-values：回填历史轮次时用。
    // 回填时我们只知道**现在**的值，写进去会伪造出"这几轮值动过"的假历史。
    if (argv.includes('--no-values')) {
      rec.values = null;
      rec.backfilled = true;
    } else {
      rec.values = actual;
    }
    if (status === 'partial' && arg('missing_half')) rec.missing_half = arg('missing_half');
    /**
     * 子项覆盖度：报 done 时必须声明覆盖了哪几个子项。
     * 为什么在**记录这一步**就拦：等 check 才发现，成本已经花掉了（跑了一小时上亿 token 只做半个）；
     * 而且 check 只能看到账本里写了什么 —— 记录这一步是唯一能问"你到底做了几个"的地方。
     */
    const specRows = fs.existsSync(path.join(dir, 'SPEC.md')) ? parseSpec(readText(path.join(dir, 'SPEC.md'))) : [];
    const specRow = specRows.find((x) => x.id === req);
    const coveredRaw = arg('covered') ? splitList(arg('covered')) : [];
    // ⚠ 待改（见事故 I9 / 规则 R9）：这里现在**只收子项名，不绑证据** —— 而名字是纯自称，
    //   实验 L13 的负控证明「只做 1/3、自称覆盖 3/3」照样 exit 0。正确做法是要求 `子项名=路径:行`
    //   并在 check 里复核。**本轮试过改，但把 selftest 的 1 条正控和 L13 的 3 条正控弄红了** ——
    //   那些用例编码的是旧契约，必须**连同用例一起改**，不许为了让改动通过而放宽检查，也不许留着红。
    //   所以先恢复可用状态，另派一次协调改动。
    const covered = coveredRaw.map((x) => String(x).trim()).filter(Boolean);
    const coveredEvidence = [];
    /**
     * ★★ **「不要」也要被逐条交代**（2026-09-17 新增；用户报的真事故：隔壁窗口一用就失灵）。
     *
     * 事故现场（我从 `<session-id>` 的日志里逐条挖出来的）：
      *   用户原话已隐去 —— 核心诉求：要自由创作，不要被锁定成平面的偷懒代码。
     *   隔壁窗口**确实**把它锁进了 SPEC（`R7 不要: 不要把方向锁成平面（用户逐字：…）`），
     *   也**确实**跑了 `check`（日志里 `需求监督通过` 出现 7 次、`check exit=0`），
     *   然后交付了一个**锁在一张平面上**的实现 —— 用户当场否掉（才补出 R11）。
     *
     * **根因**：`check` 的「交付物撞不要」判据做的是
     *   `deliveredBlob.includes(不要那句话)` —— 拿**一整句自然语言**去 `includes` **交付散文**。
     *   而"不要"天生就是一句话（用户的原话），交付散文里不会出现这一整句
     *   ⇒ **这条判据结构上永远不可能响**（那个会话里 `你说过**不要**` 出现 **0 次**，
     *      而 R7 的"不要"在 SPEC 里躺了 6 次）。
     *   ⇒ 它给了人"有这道闸"的错觉，实际是**死的**。这正是用户说的"一用就失灵"。
     *
     * **修法**（与 `--covered` 同一套思路，不发明第二套）：`done` 时，
     *   若这条需求有「不要」项，**必须逐条交代怎么避开的**：`--avoided "不要项=怎么避开的"`。
     *   缺一条就拒收 —— 逼它**说出来**。说出来之后，那句话是真是假**由人（或「审查」）对着产物判**，
      *   但**再也不能"悄悄"换**（用户明确要求：不许悄悄换）。
     *   ⚠ 如实标注：它**不是**"机器能判交付物有没有违规"（那做不到）；
     *     它保证的是**每一条「不要」都被显式回应过**，把沉默失败变成可见的声明。
     */
    const mustNotRaw = arg('avoided') ? splitList(arg('avoided')) : [];
    const mustNot = (specRow && Array.isArray(specRow.mustNot)) ? specRow.mustNot.filter((x) => String(x).trim()) : [];
    const avoided = mustNotRaw.map((x) => String(x).trim()).filter(Boolean);
    if (status === 'done' && mustNot.length) {
      const missNot = mustNot.filter((it) => !avoided.some((a) => a === it || a.startsWith(it + '=')));
      if (missNot.length) {
        console.log(`[拒收] ${req} 有 ${mustNot.length} 条「不要」，而你这次只交代了 ${mustNot.length - missNot.length} 条。`);
        console.log('  没交代的：');
        for (const m of missNot) console.log(`    · ${m}`);
        console.log('  ⇒ 逐条说清**怎么避开的**：--avoided "不要项=怎么避开的"');
        console.log('  为什么拒收（真实事故）：隔壁窗口把「我不要的是被锁定成平面的偷懒代码」锁进了 SPEC、');
        console.log('    也跑了 check（报"需求监督通过"），然后交付了一个锁在平面上的实现 ——');
        console.log('    因为旧判据拿**整句自然语言**去 includes **交付散文**，结构上永远不可能响（那个会话里它命中 0 次）。');
        console.log('    现在：**每一条「不要」都必须被显式回应**，沉默不再等于通过。');
        console.log('    真伪仍要人对着产物判 —— 但至少不能再"悄悄"。');
        return 1;
      }
    }
    if (avoided.length) rec.avoided = avoided;
    if (status === 'done' && specRow && specRow.items.length) {
      const miss = specRow.items.filter((it) => !covered.includes(it));
      if (miss.length) {
        console.log(`[拒收] ${req} 声明了 ${specRow.items.length} 个必经子项，而你这次只报告覆盖了 ${specRow.items.length - miss.length} 个。`);
        console.log(`  还差：${miss.join('、')} —— 要么补齐，要么改用 --status partial --missing_half "…"`);
        console.log(`  （补齐后重报：--status done --covered "${specRow.items.map((it) => `${it}=src/xxx.js:12`).join(',')}"）`);
        console.log('  为什么拒收：「跑了一小时上亿的 token，关键问题几个只解决了半个」就是要靠这一步抓的 ——');
        console.log('  done 却只覆盖一半，会让"半个"看起来像"整个"，比压根没做更坏（没做至少记录是诚实的）。');
        return 1;
      }
    }
    if (covered.length || (specRow && specRow.items.length)) rec.covered = covered;
    if (coveredEvidence.length) rec.coveredEvidence = coveredEvidence;
    if (status === 'partial' && arg('missing_half')) rec.missing_half = arg('missing_half');
    fs.appendFileSync(path.join(dir, 'ROUNDS.jsonl'), JSON.stringify(rec) + '\n', 'utf8');

    const { turns } = currentCost(root);
    const t = turns.find((x) => x.turn === nextRound);
    console.log(`已记第 ${nextRound} 轮：${req} / ${status}${rec.delivered ? ' / ' + rec.delivered : ''}`);
    if (specRow && specRow.items.length) {
      console.log(`子项覆盖：${covered.length}/${specRow.items.length}${covered.length ? `（${covered.join('、')}）` : ''}`);
    }
    console.log(`档位快照 ${Object.keys(actual).length} 项${Object.keys(actual).length ? '：' + Object.entries(actual).map(([k, v]) => `${k}=${v}`).join(' ') : ''}`);
    console.log(t ? `本轮成本（实时）：${fmtDur(t.wallMs)} / ${fmtInt(t.usage.total)} token` : '本轮成本：会话日志里还没落盘（轮次结束后再查就有了）');
    console.log('别忘了：node warden.mjs check');
    return 0;
  }
  if (cmd === 'vote') {
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const sub = argv[1];
    const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
    if (sub === 'cast') {
      const role = opt('role'); const choice = opt('choice'); const topic = opt('topic');
      if (!role || !choice || !topic) { console.log('[用法] vote cast --topic "争议点" --role 记录 --choice A --reason "…" [--conditions "附条件的硬边界"] [--address "回应谁的异议"]'); return 2; }
      // ★ 记票时**把当时的在册名单一起写进去** —— 这是"加席位不追溯卡死老议题"的最准判据
      //   （比"按席位加入时刻推断"准：名单是那一刻的真实快照）。老票没这个字段，走推断。
      recordVote(dir, {
        topic, role, choice,
        options: opt('options') ?? '', reason: opt('reason') ?? '', address: opt('address') ?? '',
        conditions: opt('conditions') ?? '', session: currentSessionId(),
        roster: VOTE_ROLES.slice(),
      });
      console.log(`${ROLE_STAMP.gate} 记票：${role} → ${choice}`);
      const known = ALL_ROLE_IDS.includes(role);
      console.log(`  它的职责：${ROLE_REMIT[role] ?? `（**不是角色注册表里的名字** —— 这一票不会计票，只当"有人出声"。注册表里的名字：${ALL_ROLE_IDS.join('、')}）`}`);
      if (known && !VOTE_ROLES.includes(role)) {
        console.log('  ★ 这个席位**没有投票权**（讨论C：它压不过多数）—— 但它的意见会被单独列出来、并写进规则台账的 transition，');
        console.log('    **谁也不能说"没看见"**。⚠ 它的六条约束目前只落地了"出声不许被静默忽略"这一条；');
        console.log('    「一轮只许说一条 / 只在产品跑通一次完整流程后开口 / 不许当验收证据」等还没做，别当它们已经生效。');
      }
      if (ROLE_REMIT[role] && !String(opt('reason') ?? '').trim()) console.log('  ⚠ 没写理由 —— 没理由的票会被判"未决"');
      /**
       * ★ `--address` 里点了**自己的名字** ⇒ 这不算回应（实测洞：反对者自己补一票带
       *   `--address 自己`，原本就能把自己的异议标成"已回应"，`未决` 直接变 `多数`）。
       *   在**投票的当下**就说清楚，别等到读结果时才发现闸门被绕过。
       */
      if (String(opt('address') ?? '').split(/[,，、]/).map((x) => x.trim()).includes(role)) {
        console.log(`  ⚠ --address 里点了**你自己**（${role}）—— **这不算回应异议**：`);
        console.log('     `--address` 记的是"**我在回应谁**"，而异议必须由**别人**回应。');
        console.log(`     你要是想撤回自己的异议，就**重新投一票把 --choice 改成同意**（那是有据可查的改主意，允许）。`);
      }
      if (String(opt('conditions') ?? '').trim()) {
        console.log('  ★ 这张票**附了条件** —— 同意是自愿给的，条件不会被吞：');
        console.log(`    条件：${opt('conditions')}`);
        console.log('    规则册联动：附条件的票**不许直接推进** —— 状态会记成「待并条件」，条件并进正文后要重新投票。');
      }
      // 规则册联动：这条 topic 是某条规则的票 → 按 tally 的结果**机械推进**（脚本只算数，不做价值判断）
      const rm = /^rule:(\S+?)@(\d+)$/.exec(String(topic));
      if (rm) {
        const { rules } = readRules(dir);
        const rule = rules.find((r) => r.id === rm[1] && r.topic === topic);
        if (!rule) {
          console.log(`  ⚠ 规则册里没有 ${rm[1]} 的 ${topic} —— 旧修订号的票不生效（要重新投票就用规则当前的 topic）`);
        } else {
          const adv = advanceRule(dir, rule, {});
          console.log(`  ★ 规则册联动（${rule.id}）：${adv.msg}`);
          if (adv.changed) console.log(`     现在的状态：**${adv.status}**`);
        }
      }
      return 0;
    }
    const topic = opt('topic') ?? argv.slice(1).filter((a) => !a.startsWith('--')).join(' ');
    // 列出议题（没指定就列全部）
    const topics = [...new Set(readVotes(dir).map((v) => v.topic).filter(Boolean))];
    if (!topic) {
      console.log(`${ROLE_STAMP.gate} 角色投票 · 现有议题\n`);
      if (!topics.length) { console.log('  还没有投票。冲突时开一个：vote cast --topic "…" …'); return 0; }
      for (const t of topics) {
        const r = tallyVotes(dir, t);
        console.log(`  「${t}」 → ${r.state}  ${JSON.stringify(r.counts)}`);
        if (r.outsiderNote) console.log(`      ${r.outsiderNote}`);
      }
      return 0;
    }
    const r = tallyVotes(dir, topic);
    console.log(`${ROLE_STAMP.gate} 角色投票 · 「${topic}」\n`);
    const _roster = r.roster ?? VOTE_ROLES;
    console.log(`  ${_roster.length} 个在册角色各按自己的职责投票（应到名单来源：${r.rosterFrom ?? '默认'}；脚本只计票，判断归脑子）：\n`);
    for (const role of _roster) {
      const v = r.votes.find((x) => x.role === role);
      console.log(`  ${role.padEnd(6)}【职责】${ROLE_REMIT[role]}`);
      if (v) console.log(`         票：${v.choice}   理由：${String(v.reason).slice(0, 90) || '（没写）'}`);
      else console.log(`         票：（缺席）`);
    }
    // 本议题开启之后才加进来的席位：**不许追溯卡死它**，但要说出来（不然读的人以为"名单就这么大"）
    const _laterSeats = VOTE_ROLES.filter((x) => !_roster.includes(x));
    if (_laterSeats.length) console.log(`  （${_laterSeats.join('、')} 是本议题开启之后才获得投票权的席位，不计入本议题应到）`);
    console.log('');
    console.log(`  计票：${JSON.stringify(r.counts)}`);
    console.log(`  结果：**${r.state}**`);
    if (r.majorityBaseNote) console.log(`  ⚑ ${r.majorityBaseNote}`);
    if (r.accountNote) console.log(`  ⚑ ${r.accountNote}`);
    if (r.selfAddressedNote) console.log(`  ⚠ ${r.selfAddressedNote}`);
    if (r.outsiderNote) console.log(`  ⚑ ${r.outsiderNote}`);
    if (r.state.includes('未决')) {
      console.log('');
      console.log('  未决 → **交给脑子继续想**，不许硬定。派脑子复审，或补上缺席角色的票（带理由）。');
      if (r.missing.length) console.log(`    缺席：${r.missing.join(', ')}`);
      if (r.tied) console.log(`    平票：${JSON.stringify(r.counts)}`);
      // ★ 过半闸（P-M2）：未决的原因也要印在"未决 → 交给脑子继续想"这一块里，
      //   否则读的人只看到"未决"却看不到"为什么"（实测：rule 路径上这条原因原来整条是隐形的）。
      if (r.hasMajority === false) {
        console.log(`    未过半：最高票 ${r.winner} 只有 ${r.winCount}/${r.majorityBase}（过半要 ${r.majorityNeeded} 票）`
          + ' —— 没过半**不许**说"多数"');
      }
      // ★ 判据⑤（P-M2b）：账目自相矛盾也要印在"为什么未决"这一块里（不许只活在 state 字符串里）
      if (r.accountContradiction) {
        console.log(`    账目自相矛盾：票的时刻 ${r.accountContradiction.voteAt} 早于规则进册时刻 ${r.accountContradiction.ruleAt}`
          + ' —— 规则还不存在就有人投票（P-M2b）');
      }
      /**
       * ★ 「未决」的消费者（**最小接线**）：上面说了"未决"，这里就必须给出**能把它解除的动作** ——
       *   原来 `advanceRule` 只在 `rule:<id>@<n>` 路径被调，**design 议题没有任何推进/实施挂钩** ⇒
       *   机制说了"未决"、照样通电（I60 的形状：一条不可满足的红，谁也解不掉，只能一直试）。
       *   每条"未决"都附一条**现在就能跑、跑完这条原因就没了**的命令；
       *   给不出可跑命令的 ⇒ 明写「这是不可满足的未决」。
       */
      console.log('');
      console.log('  ★ 怎么解除（每条"未决"都附一条**现在就能跑、跑完这条原因就没了**的命令；');
      console.log('     给不出可跑命令的，明写「这是不可满足的未决」—— 不许只印一句"交给脑子继续想"就完事）：');
      for (const line of unresolvedFixes(topic, r)) console.log(line);
    }
    return r.state.includes('未决') ? 1 : 0;
  }
  if (cmd === 'rules') {
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const v = rulesView(root);
    console.log(v.text);
    return v.code;
  }
  if (cmd === 'rule') {
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const sub = argv[1];
    const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
    if (sub === 'propose') {
      const text = opt('text'); const evidence = opt('evidence'); const enforced = opt('enforced') ?? 'text';
      if (!text) {
        console.log('[用法] rule propose --text "…" --evidence "L1 实测：…" [--enforced text|code] [--id R7]');
        console.log('  --evidence 必填，而且必须**指得到**：要么指 INCIDENTS.jsonl 里某条事故的 id，要么指 lab 里的实验名（L1、L6、L9、L10 这种）。');
        return 2;
      }
      if (!ENFORCED_KINDS.includes(enforced)) {
        console.log(`[用法] --enforced 只能是 code（被 exit code 强制）或 text（只是建议），收到的是 ${JSON.stringify(enforced)}。`);
        console.log('  这条必须**诚实**标 —— 没被程序拦的规则就是 text，别假装它被强制。');
        return 2;
      }
      const r = proposeRule(root, { id: opt('id'), text, evidence, enforced, by: currentSessionId() });
      if (r.err) {
        if (r.noEvidence) {
          console.log('[拒收] **没有证据的规则不许进册，请先做实验或记事故。**');
          console.log(`  原因：${r.err}`);
          console.log('  --evidence 要么提到 .warden/INCIDENTS.jsonl 里某条事故的 id，要么提到 lab 里的实验名（形如 L1、L6、L9、L10 这种）。');
        } else {
          console.log(`[用法] ${r.err}`);
        }
        return 2;
      }
      console.log(`${ROLE_STAMP.rules} 收进规则册：${r.rule.id} · ${r.rule.status}`);
      console.log('');
      console.log(`  enforced：${r.rule.enforced}${r.rule.enforced === 'code' ? '（被 exit code 强制）' : '（只是建议 —— 没有程序拦它，别假装它被强制）'}`);
      console.log(`  topic：${r.rule.topic}`);
      console.log(`  文本：${r.rule.text}`);
      console.log(`  证据：${r.rule.evidence}`);
      // 「证据认得」和「⚠ 证据没法核对」必须能分开读 —— 不许把"没核对"写成"认得"（RF1 同一种病）
      if (r.evidenceVerified) {
        console.log(`  证据认得：${r.evidenceHow}`);
        // ★ **凭什么认得**也要打出来（几处断言、多少字节）—— 只说"认得"还是自称；
        //   实测洞：空壳实验也曾被"认得"，就是因为当时只验文件名、不验内容。
        if (r.evidenceNote) console.log(`    ${r.evidenceNote}`);
      } else {
        console.log(`  ⚠ 证据没法核对（${r.evidenceHow}）`);
        console.log(`    ${r.evidenceNote}`);
        console.log('    **按命名规则先认下，但这不等于核对通过** —— lab 建起来后要重新核对这条。');
      }
      console.log('');
      console.log('下一步（五个角色各按职责投一票，理由 <10 字作废）：');
      console.log(`  node warden.mjs vote cast --topic ${r.rule.topic} --role 审查 --choice 同意 --reason "…"`);
      console.log('  角色：监督员 / 审查 / 记录 / 支线守门员 / 提问闸门');
      console.log(`  投完看结论：node warden.mjs rule status --id ${r.rule.id}`);
      return 0;
    }
    if (sub === 'reopen') {
      const id = opt('id'); const why = String(opt('why') ?? '').trim(); const force = argv.includes('--force');
      if (!id) { console.log('[用法] rule reopen --id R7 --why "为什么要把这条打回重投" [--force]'); return 2; }
      if (!why) {
        console.log('[用法] rule reopen 必须带 --why "…" —— 每次改都要留痕（谁提的、为什么、旧文本是什么）。');
        return 2;
      }
      const { rules } = readRules(dir);
      const before = rules.find((r) => r.id === id);
      if (before && before.enforced === 'code') {
        console.log('⚠ 这条是被 exit code 强制的，投票改不掉它 —— 改它要改代码。');
      }
      const r = reopenRule(dir, { id, why, force, by: currentSessionId() });
      if (r.err) {
        console.log(`[拒收] ${r.err}`);
        console.log('  （改硬规则要改代码 —— 先把代码改了，再来改规则册里的写法。）');
        return 2;
      }
      console.log(`${ROLE_STAMP.rules} 已打回「提案」：${r.prev.topic} → ${r.rule.topic}（修订号 @${r.rev}）`);
      console.log('');
      console.log(`  旧状态：${r.prev.status}${r.wasFinal ? '（定稿，用了 --force）' : ''}`);
      console.log(`  旧文本：${r.prev.text}`);
      console.log(`  为什么：${why}`);
      console.log(`  留痕：已追加一条 {"kind":"revision",…} 到 ${WARDEN_DIR}/${RULES_FILE}（旧文本/旧状态/谁提的/为什么）`);
      console.log('');
      console.log('旧票不污染新票（topic 变了）—— 重新投票：');
      console.log(`  node warden.mjs vote cast --topic ${r.rule.topic} --role 审查 --choice 同意 --reason "…"`);
      return 0;
    }
    if (sub === 'amend') {
      const id = opt('id'); const text = opt('text'); const why = opt('why'); const force = argv.includes('--force');
      if (!id || !text) {
        console.log('[用法] rule amend --id R7 --text "…（并入条件后的新文本）" [--why "…"] [--force]');
        console.log('  用途：票里附了条件（vote cast --conditions）时，状态会停在「待并条件」——');
        console.log('        把条件并进正文再走这条命令：修订号 +1、状态回「提案」、上一版的条件留痕，然后**重新投票**。');
        return 2;
      }
      const { rules } = readRules(dir);
      const before = rules.find((r) => r.id === id);
      if (before && before.enforced === 'code') {
        console.log('⚠ 这条是被 exit code 强制的，投票改不掉它 —— 改它要改代码。');
      }
      const r = amendRule(dir, { id, text, why, by: currentSessionId(), force });
      if (r.err) { console.log(`[拒收] ${r.err}`); console.log('  （改硬规则要改代码 —— 先把代码改了，再来改规则册里的写法。）'); return 2; }
      console.log(`${ROLE_STAMP.rules} 已并入条件：${r.prev.topic} → ${r.rule.topic}（修订号 @${r.rev}，状态回到「提案」）`);
      console.log('');
      console.log(`  旧文本：${r.prev.text}`);
      console.log(`  新文本：${r.rule.text}`);
      console.log(`  旧状态：${r.prev.status}${r.wasFinal ? '（定稿，用了 --force）' : ''}`);
      if (r.conditions.length) {
        console.log(`  并入的上一版条件（${r.conditions.length} 条，已作为历史留痕）：`);
        for (const c of r.conditions) console.log(`    · ${c.role}：${c.conditions}`);
      } else {
        console.log('  （上一版没有附条件的票 —— 这次是纯文本修订）');
      }
      console.log(`  留痕：已追加一条 {"kind":"revision",…} 到 ${WARDEN_DIR}/${RULES_FILE}`);
      console.log('');
      console.log('★ 修订号变了 = topic 变了 → **旧票不污染新票，要重新投票**：');
      console.log(`  node warden.mjs vote cast --topic ${r.rule.topic} --role 审查 --choice 同意 --reason "…"`);
      return 0;
    }
    if (sub === 'status') {
      const id = opt('id'); const promote = argv.includes('--promote');
      if (!id) { console.log('[用法] rule status --id R7 [--promote]'); return 2; }
      const d = ruleDetail(root, id, { promote });
      if (d.err) { console.log(`[用法] ${d.err}`); return 2; }
      console.log(d.text);
      return d.code;
    }
    console.log('[用法] node warden.mjs rule propose --text "…" --evidence "L1 实测：…" [--enforced text|code] [--id R7]');
    console.log('       node warden.mjs rule reopen --id R7 --why "…" [--force]');
    console.log('       node warden.mjs rule amend  --id R7 --text "…（并入条件后的新文本）" [--why "…"]');
    console.log('       node warden.mjs rule status --id R7 [--promote]');
    console.log('       node warden.mjs rules          （列规则册，看文本规则占比）');
    return 2;
  }
  if (cmd === 'brain') {
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const sub = argv[1];
    const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
    if (sub === 'brief') {
      const a = opt('artifact');
      if (!a) { console.log('[用法] node warden.mjs brain brief --artifact .warden/ARCH.md [--trigger conflict|shallow|explore]'); return 2; }
      const trigger = opt('trigger');
      if (trigger !== undefined && !Object.hasOwn(BRAIN_TRIGGERS, trigger)) {
        console.log(`[用法] --trigger 只能是 ${BRAIN_TRIGGER_IDS.join(' | ')}（你说的：${trigger}）`);
        console.log('  **不传 --trigger = 不派脑子**（随手小改动不必审）；只有触发条件成立时才传它派脑子。');
        return 2;
      }
      const p = path.isAbsolute(a) ? a : path.join(root, a);
      console.log(brainBrief(root, p, trigger));
      if (trigger !== undefined) {
        console.log('');
        console.log(`★ 这是**第 2 个脑子**（触发条件 ${trigger}）。独立性要求：**只给材料，不给任何人的结论**。`);
      }
      return 0;
    }
    if (sub === 'record') {
      const artifact = opt('artifact'); const brain = opt('brain'); const verdict = opt('verdict');
      if (!artifact || !brain || !verdict) { console.log('[用法] brain record --artifact X --brain A --verdict accept|reject [--issues "a,b"] [--role judge] [--reason "…"] [--trigger conflict|shallow|explore]'); return 2; }
      if (!['accept', 'reject'].includes(verdict)) { console.log('[用法] --verdict 只能是 accept 或 reject'); return 2; }
      const trigger = opt('trigger');
      if (trigger !== undefined && !Object.hasOwn(BRAIN_TRIGGERS, trigger)) {
        console.log(`[用法] --trigger 只能是 ${BRAIN_TRIGGER_IDS.join(' | ')}（你说的：${trigger}）`);
        console.log('  --trigger 记的是"**为什么加派了第 2 个脑子**"；派第 1 个时不要传。');
        return 2;
      }
      let claims = [];
      if (opt('claims')) {
        try { claims = JSON.parse(opt('claims')); } catch { console.log('[用法] --claims 必须是 JSON 数组，例：[{"code":"E07","needle":"QE键暂时不加进去","check":"artifact-lacks"}]'); return 2; }
        if (!Array.isArray(claims)) { console.log('[用法] --claims 必须是 JSON 数组'); return 2; }
      }
      recordBrain(dir, { artifact, brain, verdict, issues: opt('issues') ?? '', role: opt('role') ?? 'brain', reason: opt('reason') ?? '', claims, ...(trigger === undefined ? {} : { trigger }), session: currentSessionId(), artifactHash: artifactHash(root, artifact), sections: sectionHashes(root, artifact) });
      console.log(`${ROLE_STAMP.gate} 已记：脑子 ${brain} 对 ${artifact} 判 ${verdict}${trigger === undefined ? '' : ` · 触发条件 ${trigger}`}${opt('issues') ? ` · 问题：${opt('issues')}` : ''}`);
      const st = brainStatus(dir, root);
      console.log('');
      for (const o of st.out) console.log(`  ${o.artifact}  ${o.brains} 个脑子 → ${o.state}  ${o.note}`);
      if (st.blocking) console.log(`\n★ 有 ${st.blocking} 份产物冲突未裁决 —— 不许定稿。派 1 个裁判：brain record --role judge …`);
      return 0;
    }
    if (sub === 'audit') {
      // 机器复核脑子们的指控。**判产物有没有问题的权力，不能大于能不能复现这句话的义务。**
      const a = opt('artifact');
      const all = readBrainRecords(dir).filter((r) => !a || r.artifact === a);
      if (!all.length) { console.log('[用法] 还没有审查记录：node warden.mjs brain brief --artifact .warden/ARCH.md'); return 2; }
      let anyChecked = false; let anyFailed = false; let anyClaim = false;
      for (const r of all) {
        const claims = Array.isArray(r.claims) ? r.claims : [];
        if (!claims.length) {
          console.log(`  脑子 ${r.brain}（${r.artifact}，判 ${r.verdict}）：**没交可机检的指控** —— 它的结论无法被复核`);
          console.log('    （只写了 issues 码。下次要求它带 --claims \'[{"code","needle","check"}]\'）');
          anyChecked = true;
          continue;
        }
        const au = auditClaims(root, r);
        anyChecked = true;
        anyClaim = true;
        console.log(`  脑子 ${r.brain}（${r.artifact}，判 ${r.verdict}）：${au.ok}/${au.total} 条指控成立`);
        for (const row of au.rows) {
          if (row.ok) continue;
          anyFailed = true;
          console.log(`    ✗ ${row.code} 「${String(row.needle).slice(0, 40)}」 → ${row.detail}`);
        }
        if (au.failed.length) console.log(`    ★ ${au.failed.length} 条指控被机器驳回 —— **该脑子的判决要重估，不能直接拿去否掉产物**`);
      }
      // 「一条可机检的指控都没有」时不能说"指控都成立"：
      // 那是把"我啥也没复核"报成"复核过了、没问题"（和 quotes 扫 0 个文件同一类假通过）。
      console.log(!anyClaim
        ? '\n结论：**一条可机检的指控都没有** —— 这次没复核任何东西。这不是"产物没问题"，只是"没东西可查"。'
        : (anyFailed
          ? '\n结论：有指控被机器驳回。先让那个脑子补证据，再决定产物改不改。'
          : '\n结论：所有可机检的指控都成立。'));
      return anyFailed ? 1 : 0;
    }
    // 默认：状态
    const st = brainStatus(dir, root);
    console.log(`${ROLE_STAMP.gate} 脑子角色组 · 审理状态\n`);
    if (!st.out.length) {
      console.log('  还没有任何产物被审过 —— 脑子从没跑过（或跑了没落账）。');
      console.log('  派**第 1 个**脑子：node warden.mjs brain brief --artifact <产物>');
      console.log(`  （默认就 1 个；只有 ${BRAIN_TRIGGER_IDS.join(' / ')} 触发时才 `);
      console.log('    brain brief --artifact <产物> --trigger <哪一种> 加派第 2 个。）');
      return 0;
    }
    for (const o of st.out) {
      console.log(`  ${o.artifact}`);
      console.log(`     ${o.brains} 个脑子 → **${o.state}**  ${o.note}`);
      for (const b of o.list) {
        const sv = b.sectionVerdict;
        const mark = sv && !sv.legacy && sv.changed.length ? `  ✗ 章节变了：${sv.changed.slice(0, 8).join('、')}${sv.changed.length > 8 ? '…' : ''}` : (sv?.legacy ? '  （老记录无章节指纹，只能整份比）' : '');
        console.log(`       · 脑子 ${b.brain}：${b.verdict}${b.issues ? `  — ${b.issues}` : ''}${mark}`);
      }
    }
    console.log('');
    // ⚠ 整句放在**一个字符串里**（原来拆成两行 console.log）：拆断之后，
    //   脱敏脚本按 `「…」` 整块替换时会把中间的 `');` + `console.log('` 一起吃掉 ⇒ 语法坏掉。
    console.log('扩编规则（用户 2026-09-25：「写完代码复查不应该那么久」—— 默认不审，只在触发条件成立时才派）：');
    console.log('  · **默认不派脑子** —— 随手小改动不必审；');
    console.log(`  · 只在 ${BRAIN_TRIGGER_IDS.join(' / ')} 三种触发条件成立时才派脑子，`);
    console.log('    并用 `brain record --trigger <哪一种>` 把理由记下来；');
    console.log('  · 2 个冲突 → 加 1 个裁判（--role judge）；裁决前不许定稿。');
    return st.blocking ? 1 : 0;
  }
  if (cmd === 'roles') {
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    // `roles --health`：用户要的"角色是不是摆设"的机械仪表（§5 ①②）
    if (argv.includes('--health')) {
      const h = rolesHealth(dir);
      h.line = rolesHealthLine(dir);          // ★ 那一行由**这里**产生，插件直接用，不许各自拼一套措辞
      const bad = h.roles.filter((r) => r.flags.length);
      /**
       * ⚠ 退回码口径（2026-09-17 修；「审查」第二遍点名）：原来只看 `bad.length` ——
       *   于是**印出「全线停摆」时仍然 exit 0**，只看退回码的自动化会以为"没问题"。
       *   现在：**全席停摆也算"有角色被查出问题"**（它是一条真结论：最近 N 轮全席 0 产出）。
       */
      const code = (bad.length || h.stalled) ? 1 : 0;
      if (argv.includes('--json')) { console.log(JSON.stringify(h)); return code; }
      console.log(`${ROLE_STAMP.supervisor} 角色健康 · 「角色是不是摆设」的机械仪表`);
      console.log('');
      console.log(`  ${h.line}`);
      console.log('');
      console.log(`  议题 ${h.topics} 个 · 角色 ${h.total} 个（有票 ${VOTE_ROLES.length} / 无票 ${h.total - VOTE_ROLES.length}）`);
      console.log('');
      console.log('  角色        票  反对  反对率   独有  同构  发现  判定');
      for (const r of h.roles) {
        const rate = r.dissentRate === null ? ' —  ' : `${String(Math.round(r.dissentRate * 100)).padStart(3)}%`;
        console.log(`  ${r.role.padEnd(6)}${String(r.votes).padStart(5)}${String(r.dissent).padStart(6)}  ${rate}${String(r.unique).padStart(6)}${String(r.isomorphic).padStart(6)}${String(r.findings).padStart(6)}  ${r.flags.length ? r.flags.join(' / ') : '—'}`);
      }
      console.log('');
      console.log('  ⚠ 判据分两类，**输出里逐条标了**：');
      console.log('    【硬】票数/反对数/反对率/附条件/有无产出 —— 来自 VOTES.jsonl 与 FINDINGS.jsonl，可逐条复算；');
      console.log('    【代理】"独有项/同构"用**字符二元组 Jaccard ≥ 0.8** 判 —— 文字不像 ≠ 观点真独立，');
      console.log('           这是代理判据，真实的"提不出来"要人读。不许把代理判据说成硬判据。');
      console.log('');
      console.log(`  退回码：${code}（有角色被查出问题、**或全席停摆** = 1；**这不代表交付不对**，只代表该角色这一轮的劳动不成立）`);
      return code;
    }
    console.log(rolesView(root, { color: !!process.stdout.isTTY }));
    return 0;
  }
  if (cmd === 'delegation') {
    /**
     * `delegation [会话id]` —— **R19 的机械落点**（用户要求：子代里编程也可以用起来，不然一个干活的太累了；
     *   不要: 所有代码都由主代理一个人顺序写）。
     *
     * 为什么要有：审查第二遍实测指出 —— R19 标了 done，但"L25 是真派单，L26/L27/L28 又是主代理自己写的"，
     *   而**没有任何机械判据**能看出这件事。这条命令数会话里的 `tool/call`：
     *   · 主代理自己 `write`/`edit` 了哪些文件（几次）；
     *   · 派了几次单（`subagent*`）。
     * 判据：**有写、却一次单都没派 ⇒ exit 1**（"一个人顺序写"）。
     * ⚠ 它是**代理**判据：派单 ≠ 派得好；主代理少量自己写也可能是对的。所以只报数与事实，不下"效率"结论。
     */
    const dir = path.join(root, WARDEN_DIR);
    const want = argv[1] && !argv[1].startsWith('-') ? argv[1] : (currentSessionId() ?? '');
    if (!want) { console.log('[用法] node warden.mjs delegation [会话id]'); return 2; }
    const list = (() => {
      // ⚠ `listSessions({})` 默认只看**当前 cwd 编码的那个工作区** —— 在工程根里跑会得到 0 个
      //   （实测：cd task-warden 跑 → "现有 0 个会话"，而 cwd 在 <WORKSPACE> 时是 122 个）。
      //   所以这里**把所有工作区目录都扫一遍**。
      const dirs = new Set(quoteDirNames(root));
      try {
        for (const e of fs.readdirSync(sessionsRoot(), { withFileTypes: true })) if (e.isDirectory()) dirs.add(e.name);
      } catch (e2) { /* 扫不动就只用已知的 */ }
      const out = [];
      for (const d of dirs) {
        try { for (const s of listSessions({ dirName: d })) out.push(s); } catch (e2) { /* 单个工作区失败不影响整体 */ }
      }
      return out;
    })();
    const target = list.find((s) => s.sessionId === want) || list.find((s) => s.sessionId.includes(want));
    if (!target) {
      console.log(`[用法] 找不到会话「${want}」。现有 ${list.length} 个会话；本会话 id = ${currentSessionId() ?? '（未知）'}`);
      return 2;
    }
    let events = [];
    try { events = decodeSession(target.file).events; } catch (e) {
      console.log(`[拒收] 解不开这个会话：${String(e.message).slice(0, 120)}`); return 2;
    }
    if (!events.length) { console.log('[拒收] 这个会话里一个事件都没解出来 —— "0 条"不许当成"没自己写"'); return 2; }
    const st = delegationStats(events);
    const files = new Map(st.files.map((f) => [f.path, f.n]));
    const writes = st.writes;
    const dispatches = st.dispatches;
    console.log(`${ROLE_STAMP.keeper} 派单台账 · ${target.sessionId}`);
    console.log('');
    console.log(`  主代理自己 write/edit：**${writes}** 次，涉及 **${files.size}** 个文件`);
    for (const [p, n] of [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`    · ${n}× ${p}`);
    }
    if (files.size > 8) console.log(`    …（还有 ${files.size - 8} 个）`);
    console.log('');
    console.log(`  派单（subagent*）：**${dispatches.length}** 次`);
    for (const d of dispatches.slice(0, 10)) console.log(`    · ${d}`);
    if (dispatches.length > 10) console.log(`    …（还有 ${dispatches.length - 10} 次）`);
    console.log('');
    const code = (writes > 0 && dispatches.length === 0) ? 1 : 0;
    console.log(`  判定：${code === 1 ? '★ **有写、却一次单都没派** —— 这就是用户说的"一个干活的累死"' : '有写也有派单（派单 ≠ 派得好，这一点要人读）'}`);
    console.log(`  退回码：${code}（⚠ 代理判据：只报事实，不下"效率"结论）`);
    return code;
  }
  if (cmd === 'voices') {
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    /**
     * ★ R37：取数**默认只扫本窗口**（认不出本窗口 ⇒ 拒收 exit 2，不替你猜）。
     *   `--all-windows` 是显式扫全集的那条路；`--session <id>` 显式指定一本账。
     */
    const vScope = resolveWindowScope(root, {
      session: (() => { const i = argv.indexOf('--session'); return i >= 0 ? argv[i + 1] : undefined; })(),
      allWindows: argv.includes('--all-windows'),
    });
    if (vScope.mode === 'unknown') { console.log(unknownWindowNotice(vScope, 'voices')); return 2; }
    // ⚠ 位置参数要跳过带值 flag 的**值**，否则 `--session xxx` 的值会被当成关键词去查（静默查错东西）
    const kw = positionalArgs(argv.slice(1), ['--session']).join(' ');
    if (kw) {
      const scoped = vScope.mode === 'all' ? null : vScope.session;
      const pool = loadVoices(dir, scoped ? { session: scoped } : {}).filter(voiceIsUser);
      const wins = new Set(pool.map((v) => String(v.session ?? '')));
      const hits = searchVoices(dir, kw, scoped ? { session: scoped } : {});
      console.log(`${ROLE_STAMP.keeper} 窗口传递层 · 查「${kw}」→ ${hits.length} 条`);
      console.log(`  窗口口径：${vScope.mode === 'all' ? `全集（${vScope.why}）` : `只扫本窗口 ${scoped}（${vScope.why}）`}`
        + ` —— 查了 **${wins.size} 个窗口**、${pool.length} 条原话`);
      if (vScope.mode !== 'all') console.log('  （别的窗口不在这次范围里 —— 看全集：node warden.mjs voices "关键词" --all-windows）');
      console.log('');
      if (!hits.length) {
        // 「0 条命中」不许说成"用户没说过这个" —— 那也是"没查到东西 ≠ 查了没问题"
        const vsV = voiceStaleness(root, dir);
        console.log('  （这次没查到 —— **不等于"用户没说过"**。可能是关键词不对，也可能 VOICE 快照落后了。）');
        if (vScope.mode !== 'all') console.log('  （也可能这句是**别的窗口**说的：加 --all-windows 再查一次。）');
        if (vsV.stale) console.log(`  ${voiceStaleWarning(vsV)}`);
      }
      for (const h of hits) {
        const d = h.at ? new Date(h.at).toLocaleString('zh-CN') : '?';
        console.log(`── ${d}  [${h.session.slice(0, 14)}]`);
        console.log(`   ${h.text.slice(0, 400)}`);
        console.log('');
      }
      return 0;
    }
    const rebuild = argv.includes('--rebuild');
    /**
     * ★★ `mergeAggregate: true` —— **只有 `voices` 命令走这条**（硬伤 A / B 的产品侧修法）。
     *   scoped 时把本窗口的原话**追加**进汇总本（只增不改，永不 rebuild）。
     *   `ask` 走同一套 `syncVoices` 但**不传**这个开关（它按设计不写汇总本，L42 ⑦ 钉着）。
     */
    const r = syncVoices(root, dir, { rebuild, session: vScope.session, allWindows: vScope.mode === 'all', mergeAggregate: true });
    /**
     * ★★ **拒收路径**：这次 `--rebuild` 会把一本**非空**的账清成 0 条 ⇒ 一个字节都不写。
     * 为什么必须拒收而不是"照做、只提醒"：那是**不可逆**的（原话账没有第二份），
     * 而"扫到 0 条"**区分不了**「日志被归档/移走」与「这个窗口真的没说过话」这两件事 ——
     * 区分不了就不许替用户决定。exit 3 = 数据安全拒收（2 留给用法/环境错，1 留给 check 不通过）。
     */
    if (r.refused) {
      console.log(`${ROLE_STAMP.keeper} 窗口传递层 · --rebuild —— **拒收：没有写任何东西**\n`);
      console.log(`  ${r.refused.why}`);
      console.log(`  （目标文件里的 ${r.refused.rowsBefore} 行**原样还在** —— 盘上真实条数就是 ${r.total} 条，没有被改成 0。）\n`);
      console.log('  为什么不照做："扫到 0 条"有两种原因，**这次分不出来**：');
      console.log('    ① 会话日志**不可用**（被归档 / 轮转 / 移走 / 换了机器）⇒ 盘上其实还在，只是这次扫不到；');
      console.log('    ② 这个窗口**真的**没说过话 ⇒ 这本账本来就该是空的。');
      console.log('  把 ① 当成 ② 写下去，就是**不可逆**地删掉一本真账（实测事故：27 行 → 243 B 的空壳）。\n');
      console.log('  怎么办（两条路，都写出来）：');
      console.log(`    · 先确认日志还在，再重跑：node warden.mjs voices${r.session ? ` --session ${r.session}` : ''} --rebuild`);
      console.log('    · 确要清空这本账：**手工**删/改那个文件（你的手比我的脚本可靠，而且你担得起这个后果）');
      console.log(`    文件：${r.file}`);
      return 3;
    }
    console.log(`${ROLE_STAMP.keeper} 窗口传递层${rebuild ? '（已按当前规则重建）' : '已更新'}`);
    // 「累计 N 条」= **盘上真实的条数**（`r.rowsOnDisk`），不是"本窗口那本 ∪ 汇总本里属于它的行"
    console.log(`  新增 ${r.added} 条，累计 ${r.total} 条（**盘上真实条数**）→ ${r.file}`);
    // 「扫了几个窗口」必须明写（R37）
    console.log(`  窗口口径：${r.scoped ? `只扫本窗口 ${r.session}（${vScope.why}）` : `全集（${vScope.why}）`}`
      + ` —— 有原话的窗口 **${r.windowsScanned} 个**（共见到 ${r.sessionsSeen} 个会话）`);
    // 三个"跳过"类目**互不重叠**（子代理不再被算成"别的窗口"）—— 数字必须能相加对上
    console.log(`  跳过：别的窗口 ${r.skipped.otherWindow} 个 · 子代理会话 ${r.skipped.subagent} 个 · 没写过磁盘的会话 ${r.skipped.noDisk} 个`);
    if (r.scoped) {
      /**
       * ★ 硬伤 A/B：这句话原来写的是「全工程的汇总本在 .warden/VOICE.jsonl（只增不改，不覆盖）」，
       *   读起来像"scoped 不碰汇总本" —— 那正是闸门静默失效的原因。现在**如实报**并了几条。
       */
      const ag = r.aggregate;
      console.log(`  ★ 这本是**本窗口单独的账**；汇总本 .warden/VOICE.jsonl **也同步更新了**`
        + `（只增不改，永不 rebuild/清空）：这次并进 ${ag ? ag.added : 0} 条，汇总本现在 ${ag ? ag.rows : '?'} 条。`);
      console.log('    为什么要并：check 的「原话认领闸」读的是汇总本 —— 不并，正常流下那条硬失败就**静默不响**（判定一个字没动，改的是取数）。');
      console.log('    看全集：node warden.mjs voices --all-windows   ｜   收尾落总账：node warden.mjs ledger flush');
    }
    const all = loadVoices(dir, vScope.mode === 'all' ? {} : { session: vScope.session });
    console.log('\n最近 5 条：');
    for (const v of all.slice(-5)) {
      const d = v.at ? new Date(v.at).toLocaleString('zh-CN') : '?';
      console.log(`  ${d}  ${v.text.slice(0, 90)}`);
    }
    return 0;
  }
  if (cmd === 'ask') {
    // 提问闸门（机械那一半）：已经答过的不许再问；能在文档里查到的，先去查。
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
    /**
     * ⚠ 问题文本要用 `positionalArgs` 取（跳过带值 flag 的**值**）——
     *   否则 `ask "问题" --session session-xxx` 会把**会话 id 当成问题的一部分**去查（静默查错东西）。
     */
    const q = positionalArgs(argv.slice(1), ['--session', '--verdict', '--reason']).join(' ');
    // 记"脑子"那一层的判决（**先于窗口口径**：这是一笔记账，不该被"认不出窗口"挡住）
    const vi = argv.indexOf('--verdict');
    const ri = argv.indexOf('--reason');
    if (vi >= 0 && argv[vi + 1]) {
      const p = path.join(dir, 'QUESTIONS.jsonl');
      const verdict = argv[vi + 1];
      if (!['ask', 'decide'].includes(verdict)) { console.log('[用法] --verdict 只能是 ask（该问）或 decide（该自己定）'); return 2; }
      /**
       * ★★ **判决必须能和某个问题对上** —— 硬伤 D 的修法（判据三条，缺一不可，全都不许静默）：
       *   ① 命令行给了问题 → 用它；
       *   ② 没给 → 从 QUESTIONS.jsonl 里**最近一条还没判决的问题**取（那正是这条判决的对象），
       *      并**明着打印**它是从哪一条取的（带时间戳）—— 不是静默补一个空值；
       *   ③ 两处都没有 → **拒收 exit 2**，一个字节都不写。
       * `--reason` 同理硬拒：没写理由的判决既不能被复核、也不能被推翻 —— 同一个病。
       */
      let question = q;
      let questionFrom = '命令行';
      if (!question) {
        const pend = lastPendingQuestion(p);
        if (pend) { question = pend.question; questionFrom = `QUESTIONS.jsonl 里最近一条还没判决的问题（${pend.at}）`; }
      }
      if (!question) {
        console.log('[用法] --verdict 必须能对上**一个具体问题** —— 这次既没在命令行给问题，');
        console.log('        QUESTIONS.jsonl 里也没有「还没判决的问题」可对。');
        console.log('        写法：node warden.mjs ask "你想问用户的问题" --verdict decide|ask --reason "…"');
        console.log('        为什么硬拒：空 question 会让这条判决**无法与任何问题对上**（实测落盘过 {"question":""}），');
        console.log('        那不是修复，是"静默的空输入 + exit 0"。');
        return 2;
      }
      const reason = String(ri >= 0 ? argv[ri + 1] : '').trim();
      if (!reason) {
        console.log('[用法] --verdict 必须写 --reason "…" —— 没写理由的判决记录既不能被复核、也不能被推翻');
        console.log('        （同一个病："静默的空输入 + exit 0"）。');
        return 2;
      }
      fs.appendFileSync(p, JSON.stringify({
        at: new Date().toISOString(), resolved: verdict, reason, question, questionFrom,
      }) + '\n', 'utf8');
      console.log(`已记：判决对象 = 「${question}」`);
      console.log(`  （这个问题来自：${questionFrom}）`);
      console.log(verdict === 'ask'
        ? '已记：该问用户。记得按「你要的 vs 我给的」+ 含「照原样做」的选项来问。'
        : '已记：该自己定。把结论和依据写进交付，别拿它去占用户的注意力。');
      return 0;
    }
    if (!q) { console.log('[用法] node warden.mjs ask "你想问用户的问题"'); return 2; }
    /**
     * ★★ R37：`ask` 也**按窗口收窄**。两个病一起治：
     *   ① 取数：原来 `searchVoices`/`rankVoices` 拿几十个窗口混在一起的 VOICE 去查 ⇒
     *      **别的窗口说过的话**会被当成"用户已经答过"，把本窗口的问题拦下来（污染的正源之一）；
     *   ② 写数：原来无参 `syncVoices(root, dir)`（= 扫**全集**）**顺手写汇总本** ——
     *      在别的窗口的原话账上，这个动作本身就是污染。⇒ 现在跟着窗口口径走：
     *      scoped 只写本窗口那一本，`--all-windows` 才动汇总本（与 `voices` 完全同一套）。
     */
    const aScope = resolveWindowScope(root, { session: opt('session'), allWindows: argv.includes('--all-windows') });
    if (aScope.mode === 'unknown') { console.log(unknownWindowNotice(aScope, 'ask')); return 2; }
    const aSession = aScope.mode === 'all' ? '' : String(aScope.session ?? '');
    syncVoices(root, dir, { session: aSession || undefined, allWindows: aScope.mode === 'all' });
    const hits = searchVoices(dir, q, aSession ? { session: aSession } : {});
    const ranked = rankVoices(dir, q, 5, aSession ? { session: aSession } : {});
    const docs = findInDocs(root, q);
    const aPool = loadVoices(dir, aSession ? { session: aSession } : {}).filter(voiceIsUser);
    const aWinCount = new Set(aPool.map((v) => String(v.session ?? ''))).size;
    console.log(`${ROLE_STAMP.gate} 提问闸门 · 机械检查\n`);
    // 「这次取数来自几个窗口」必须明写（R37）—— 不写窗口数，读者没法判断这次查的是哪本账
    console.log(`窗口口径：${aScope.mode === 'all' ? `全集（${aScope.why}）` : `只扫本窗口 ${aSession}（${aScope.why}）`}`
      + ` —— **这次取数来自 ${aWinCount} 个窗口**、${aPool.length} 条真用户原话`);
    if (aScope.mode !== 'all') console.log('  （别的窗口不在这次范围里 —— 看全集：node warden.mjs ask "问题" --all-windows）');
    console.log('');
    console.log(`问题：${q}\n`);
    // 机械层只能"提示"，判不准 —— 这一点必须诚实，真正的判断归"脑子"那一层
    let blocked = false;
    const strong = ranked.filter((r) => r.lcs >= 5);
    const weak = ranked.filter((r) => r.lcs < 5);
    if (hits.length || strong.length) {
      blocked = true;
      console.log(`★ 拦下：用户**很可能已经答过**（${hits.length || strong.length} 条）—— 不许再问。`);
      const show = hits.length ? hits : strong;
      for (const h of show.slice(0, 3)) {
        const d = h.at ? new Date(h.at).toLocaleString('zh-CN') : '?';
        console.log(`  ── ${d} [${h.session.slice(0, 14)}]${h.lcs ? `  （最长重合 ${h.lcs} 字）` : ''}`);
        console.log(`     ${h.text.slice(0, 320)}`);
      }
      console.log('');
    } else if (weak.length) {
      console.log(`⚠ 有 ${weak.length} 条**可能相关**（重合很短，脚本判不准）—— 先读一眼再决定要不要问：`);
      for (const h of weak.slice(0, 3)) {
        const d = h.at ? new Date(h.at).toLocaleString('zh-CN') : '?';
        console.log(`  ── ${d}  （最长重合 ${h.lcs} 字）`);
        console.log(`     ${h.text.slice(0, 200)}`);
      }
      console.log('');
    }
    if (docs.length) {
      console.log(`⚠ 工程文档里有 ${docs.length} 处相关线索 —— 先去读，别问：`);
      for (const d of docs) console.log(`    ${d}`);
      console.log('');
    }
    if (!blocked && !weak.length && !docs.length) console.log('机械检查通过：用户没说过、文档里也没查到。\n');
    // 记录（给"脑子"那一层用）
    const p = path.join(dir, 'QUESTIONS.jsonl');
    fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), question: q, voiceHits: hits.length, docHits: docs.length, mechanical: blocked ? 'blocked' : 'pass', gate: 'pending' }) + '\n', 'utf8');
    if (!blocked) {
      console.log('下一步（**脑子**那一半，脚本做不了）：派一个独立子代理审这个问题 ——');
      console.log('  只给它：问题 + .warden/VOICE.jsonl + SPEC.md + ARCH.md + 工程目录（不给你的结论）。');
      console.log('  要求它回答三件事：① 这问题该不该占用用户注意力？');
      console.log('  ② 答案能不能自己查/自己定？该自己定就给结论和依据；');
      console.log('  ③ 非问不可的话，怎么问才对（必须给"你要的 vs 我给的"+含"照原样做"的选项）。');
      console.log('  审完用：node warden.mjs ask --verdict decide|ask --reason "…" 记下判决。');
      console.log('  （硬伤 D：判决必须能对上**一个具体问题** —— 命令行不给就从最近一条待决问题取，都没有则拒收 exit 2。）');
    }
    return blocked ? 1 : 0;
  }
  if (cmd === 'needs' || cmd === 'results') {
    /**
     * 用户 R51（2026-09-17 逐字；**公开版已隐去原文**）：「本轮任务开始给需求清单、结束时给结果清单并对账」
     * 对账，从来没有实现过。」—— 所以这两个命令就是那两张清单，一个开工用、一个收尾用。
     *
     * 口径（不许糊弄）：
     *   · **只给本轮**：本窗口最近 `--last N` 条原话（默认 5），不是全历史（那正是他骂过的"从古至今全砸进去"）。
     *   · **逐条可追**：每条原话 → 归宿的 R# → 那条 R# 的最新一轮（交付/证据/还差哪半）。
     *     指不到结果行的原话就是**对账缺口**，明着报出来。
     *   · 归宿口径与 `brief` / `claimsStatus` 一致（`findVoiceByRef` 兜短前缀）。
     */
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
    const owner = String(opt('session') ?? process.env.DSH_SESSION_ID ?? '').trim();
    const cap = Math.max(1, Number(opt('last') ?? 5) || 5);
    const spec = parseSpec(readText(path.join(dir, 'SPEC.md')) ?? '');
    const specById = new Map(spec.map((s) => [s.id, s]));
    const rounds = readRounds(dir);
    const lastByReq = new Map();
    for (const r of rounds) {
      const id = String(r.requirement ?? ''); if (!id) continue;
      const cur = lastByReq.get(id);
      if (!cur || Number(r.round ?? 0) >= Number(cur.round ?? 0)) lastByReq.set(id, r);
    }
    const voices = loadVoices(dir).filter(voiceIsUser);
    const mine = owner ? voices.filter((v) => String(v.session) === owner) : voices;
    const recent = mine.slice(-cap);
    const claimMap = new Map();
    const cpath = path.join(dir, 'CLAIMS.jsonl');
    if (fs.existsSync(cpath)) {
      for (const line of readText(cpath).split(/\r?\n/)) {
        const s = line.trim(); if (!s) continue;
        let rec = null; try { rec = JSON.parse(s); } catch { continue; }
        if (!rec || !rec.voice) continue;
        claimMap.set(String(rec.voice), rec);
        const t = findVoiceByRef(voices, String(rec.voice));
        if (t) claimMap.set(voiceKey(t), rec);
      }
    }
    const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n) + '…' : t; };
    const hhmm = (t) => { const d = new Date(String(t ?? '')); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '??:??'; };
    const rows = recent.map((v) => {
      const rec = claimMap.get(voiceKey(v)) ?? null;
      const ref = rec && /^R\d+$/.test(String(rec.ref ?? '')) ? String(rec.ref) : '';
      return { v, rec, ref };
    });
    const refIds = [];
    for (const r of rows) if (r.ref && !refIds.includes(r.ref)) refIds.push(r.ref);

    /**
     * ★ **落一条对账记录**（2026-09-17 新增；补 R14 的强制面）。
     *   审查第二遍的原文：「对账只覆盖'最近 N 条原话指到的 R#'，不是本轮实际干的活。
     *   且 `check` 无任何'本轮跑没跑过'的校验 ⇒ **习惯面没过**。」
     *   ⇒ `needs`/`results` 各写一条；`check` 校验「**报了 done 就必须有一次对账**」。
     * ⚠ **必须写在任何 early return 之前**（我第一版写在"有计划"那条分支里，
     *   于是"这几条原话没归宿"提前 return 时什么都没记 —— 而那恰恰是最该记的时候）。
     */
    const maxRoundNow = rounds.reduce((a, r) => Math.max(a, Number(r.round ?? 0)), 0);
    const writeRecon = (kind, extra) => {
      try {
        fs.appendFileSync(path.join(dir, RECON_FILE), JSON.stringify(Object.assign({
          at: new Date().toISOString(), kind, session: owner,
          planned: refIds, quotes: rows.length, lastRound: maxRoundNow,
        }, extra || {})) + '\n', 'utf8');
        console.log(`  （已记进 ${path.join(dir, RECON_FILE)}：${kind === 'needs' ? '开工清单' : '收尾对账'} · 当时最新第 ${maxRoundNow} 轮）`);
      } catch (e) { console.log(`  ⚠ 对账记录没写成：${String(e.message).slice(0, 80)}`); }
    };

    if (cmd === 'needs') {
      console.log(`${ROLE_STAMP.keeper} 【需求清单】开工 · ${owner || '（不知道本窗口）'} 最近 ${rows.length} 条原话`);
      console.log('');
      for (const r of rows) {
        const tag = r.rec ? `【${r.rec.kind}${r.ref ? ' ' + r.ref : ''}】` : '【**还没归宿**】';
        console.log(`  ${hhmm(r.v.at)} #${r.v.seq} ${tag} ${cut(r.v.text, 44)}`);
      }
      console.log('');
      if (!refIds.length) {
        console.log('  ⚠ 这几条原话一条都没指到需求号 —— **先 claims add 或写进 SPEC，再开工**（没有需求号就没有对账的锚）。');
        writeRecon('needs');   // ⚠ 早退分支也要记：这正是最该记的时候
        return 0;
      }
      console.log(`  ▸ 本轮要做的 ${refIds.length} 条需求：`);
      for (const id of refIds) {
        const sp = specById.get(id);
        const last = lastByReq.get(id);
        console.log(`    ${id}  ${sp ? cut(sp.title, 38) : '**SPEC 里没有这条！**'}  → 最新第 ${last ? last.round : '—'} 轮 ${last ? last.status : '（没有轮次）'}`);
      }
      /**
       * ★ 记录由上面统一的 `writeRecon` 写（写在任何 early return 之前）——
       *   这里只补一句提示，不再自己 append（我第一版就是自己 append 且写在 return 之后 ⇒ 没记上）。
       */
      writeRecon('needs');
      return 0;
    }

    // results：结果清单 + 对账
    console.log(`${ROLE_STAMP.keeper} 【结果清单】+ 对账 · 收尾`);
    console.log('');
    /**
     * ★ **本轮实际干的活**（2026-09-17 补；审查第二遍原文：「对账只覆盖'最近 N 条原话指到的 R#'，
     *   不是**本轮实际干的活**」）。做法：读 RECON.jsonl 里最后一条 `kind=needs` 的 `lastRound`，
     *   把它之后**所有**轮次列出来 —— 那才是这一轮真的做了什么。
     */
    let sinceRound = -1;
    try {
      const rp = path.join(dir, RECON_FILE);
      if (fs.existsSync(rp)) {
        for (const line of readText(rp).split(/\r?\n/)) {
          const s = line.trim(); if (!s.startsWith('{')) continue;
          let o = null; try { o = JSON.parse(s) } catch { continue }
          if (o && o.kind === 'needs') sinceRound = Math.max(sinceRound, Number(o.lastRound ?? 0));
        }
      }
    } catch (e) { /* 读不动就按"没跑过 needs"处理 */ }
    const didThisRound = rounds.filter((r) => Number(r.round ?? 0) > sinceRound);
    if (sinceRound >= 0) {
      console.log(`  ▸ **本轮实际干的活**（第 ${sinceRound} 轮之后共 ${didThisRound.length} 轮）：`);
      if (!didThisRound.length) console.log('    （一条轮次都没有 —— 那就是"这一轮什么都没做"，别装作做了）');
      for (const r of didThisRound) {
        const inPlan = refIds.includes(String(r.requirement ?? ''));
        console.log(`    ${inPlan ? '✓在计划里' : '·计划外'} 第 ${r.round} 轮 ${r.requirement} ${r.status}  ${cut(r.delivered, 46)}`);
      }
      const planned = didThisRound.filter((r) => refIds.includes(String(r.requirement ?? '')));
      const unplanned = didThisRound.filter((r) => !refIds.includes(String(r.requirement ?? '')));
      console.log(`      计划内 ${planned.length} 轮 · **计划外 ${unplanned.length} 轮**（计划外不是错，但要说出来）`);
      console.log('');
    } else {
      console.log('  ⚠ 没有找到开工清单（`node warden.mjs needs`）—— 那"对账"就没有基准，只能对"最近几条原话"。');
      console.log('');
    }
    const tally = { done: 0, partial: 0, doing: 0, todo: 0 };
    for (const id of refIds) {
      const sp = specById.get(id);
      const last = lastByReq.get(id);
      const st = String(last?.status ?? '（没有轮次）');
      if (st === 'done') tally.done += 1;
      else if (st === 'partial') tally.partial += 1;
      else if (st === 'in_progress') tally.doing += 1;
      else tally.todo += 1;
      console.log(`  ${id}  ${sp ? cut(sp.title, 36) : '**SPEC 里没有这条！**'}  ·  ${st}${last ? `（第 ${last.round} 轮）` : ''}`);
      console.log(`      交付：${cut(last?.delivered, 62) || '（没写）'}`);
      if (last?.evidence) console.log(`      证据：${cut(last.evidence, 72)}`);
      if (String(last?.missing_half ?? '').trim()) console.log(`      ⚠ 还差：${cut(last.missing_half, 62)}`);
    }
    const gap = rows.filter((r) => !r.rec || (String(r.rec.kind) === '需求' && !r.ref));
    const byKind = {};
    for (const r of rows) { const k = r.rec ? String(r.rec.kind) : '**没归宿**'; byKind[k] = (byKind[k] ?? 0) + 1; }
    console.log('');
    console.log(`  ▸ 对账：需求 ${refIds.length} 条 → 已交付 ${tally.done} · 半交付 ${tally.partial} · 在做 ${tally.doing} · 没做 ${tally.todo}`
      + `　｜　原话 ${rows.length} 条 → ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    for (const g of gap) console.log(`      ✗ 没有归宿：${hhmm(g.v.at)} #${g.v.seq} ${cut(g.v.text, 40)}`);
    if (gap.length) console.log('      （这几条原话**没有归宿、也就没有对应的结果行** —— 这就是对账里的缺口，别当它不存在。）');
    writeRecon('results', { gaps: gap.length, tally: { done: tally.done, partial: tally.partial, doing: tally.doing, todo: tally.todo } });
    /**
     * ★ R37 第 4 条「**未做完的写入总账本**」—— 收尾这一刀必须自己落，不许等人记得。
     *   **不做完就静默消失 = 事故**，所以收尾跑完顺手把本窗口还没做完的项写进总账
     *   （`ledger flush` 是同一个函数的显式入口）。
     *   ⚠ 只有知道本窗口时才写：不知道"这本账记到谁头上"就写，等于瞎记。
     */
    if (owner) {
      const lId = ledgerIdOf(root);
      const fl = flushWindowToLedger(root, dir, { session: owner, ledgerId: lId });
      console.log(`  ▸ 总账本：本窗口**还没做完**的项 → 写了 ${fl.added} 条 → ${path.join(dir, LEDGER_FILE)}`);
      for (const it of fl.items) console.log(`      ○ ${lId}#${it.req}  ${it.title || ''} —— ${it.why}`);
      if (!fl.added) console.log('      （本窗口没有未做完的项 ⇒ 这一笔是**空的**；"空"≠"都做完了"）');
    }
    console.log(`  （全历史主表：node warden.mjs report → ${path.join(dir, 'REPORT.md')}）`);
    return 0;
  }

  if (cmd === 'brief') {
    /**
     * 读用户言的**三层顺序**（用户 2026-09-16 提出 → SPEC.md R41）：
     *   ① 本窗口（本会话自己的任务与原话）→ ② 总项目进度 → ③ 其它窗口（默认只给计数）
     * 为什么要它：用户要求不要一次性把从古至今所有内容砸进去，
     * 但又划了红线：不要改成最开始的完全遗忘。所以：**默认视图有上限，全量一直在盘上**。
     * 还要防说多了又变成一摊子烂账：每条原话的归宿（需求 R# / 非要求 / 已答过 / 撤回）
     * 直接标在行尾，已处理的就不再重复占位。
     */
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
    const owner = String(opt('session') ?? process.env.DSH_SESSION_ID ?? '').trim();
    const ownCap = Math.max(1, Number(opt('own') ?? 5) || 5);
    const voices = loadVoices(dir).filter(voiceIsUser);
    const hhmm = (t) => { const d = new Date(String(t ?? '')); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '??:??'; };
    // 归宿表（防烂账：一条原话处理完就不再重复出现）
    // ⚠ 口径必须与 claimsStatus 一致 —— 用 findVoiceByRef（它支持"短前缀"认领）。
    //   方向员实测：有 3 条认领只写了短前缀（<session-id>#35/#19/#33），
    //   原来这里拿完整 `session#seq` 直接查 Map，会把它们**误报成"没归宿"**（两套口径打架）。
    const cl = claimsStatus(root, dir, { createWatermark: false });
    const claimMap = new Map();
    const cpath = path.join(dir, 'CLAIMS.jsonl');
    if (fs.existsSync(cpath)) {
      for (const line of readText(cpath).split(/\r?\n/)) {
        const s = line.trim(); if (!s) continue;
        let rec = null; try { rec = JSON.parse(s); } catch { continue; }
        if (!rec || !rec.voice) continue;
        claimMap.set(String(rec.voice), rec);
        const target = findVoiceByRef(voices, String(rec.voice));
        if (target) claimMap.set(voiceKey(target), rec);
      }
    }
    const mark = (v) => {
      const rec = claimMap.get(voiceKey(v));
      if (rec) { const k = String(rec.kind ?? ''); return `【${k}${rec.ref ? ' ' + rec.ref : ''}】`; }
      // 水位线之前的旧历史是**故意不追责**的（不能让 145 条把视图撑爆）——
      // 所以标"历史·不追责"而不是"没归宿"：不假装处理过，也不假装是欠账。
      if (cl.since && String(v.at ?? '') <= cl.since) return '【历史·不追责】';
      return '【没归宿】';
    };

    const spec = readText(path.join(dir, 'SPEC.md')) ? parseSpec(readText(path.join(dir, 'SPEC.md'))) : [];
    const rounds = readRounds(dir);
    const lastByReq = new Map();
    for (const r of rounds) {
      const id = String(r.requirement ?? ''); if (!id) continue;
      const cur = lastByReq.get(id);
      if (!cur || Number(r.round ?? 0) >= Number(cur.round ?? 0)) lastByReq.set(id, r);
    }
    const doneN = [...lastByReq.values()].filter((r) => String(r.status) === 'done').length;
    const stale = staleRequirements(spec, rounds).filter((x) => !x.parked);
    const newest = rounds.reduce((a, b) => (Number(b.round ?? 0) > Number(a.round ?? 0) ? b : a), {});
    const mine = owner ? voices.filter((v) => String(v.session) === owner) : [];
    const byOther = new Map();
    for (const v of voices) {
      const s = String(v.session ?? ''); if (!s || s === owner) continue;
      byOther.set(s, (byOther.get(s) ?? 0) + 1);
    }

    console.log(`${ROLE_STAMP.keeper} 读用户言 · 三层（本窗口 → 总项目 → 其它）`);
    console.log('');
    if (!owner) console.log('  ⚠ 不知道本窗口是哪个会话（没给 --session，环境里也没有 DSH_SESSION_ID）—— 只能先看总项目。');
    else console.log(`① 本窗口（${owner}）· 原话共 ${mine.length} 条，这里只给最近 ${Math.min(ownCap, mine.length)} 条：`);
    for (const v of mine.slice(-ownCap)) {
      const t = String(v.text ?? '').replace(/\s+/g, ' ').slice(0, 60);
      console.log(`   ${hhmm(v.at)}  #${v.seq}  ${mark(v)} ${t}${String(v.text ?? '').length > 60 ? '…' : ''}`);
    }
    if (owner && mine.length > ownCap) console.log(`   （还有更早的 ${mine.length - ownCap} 条 —— 要看：node warden.mjs voices "<关键词>"；**不默认砸进来**）`);
    console.log('');
    /**
      * ② 必须是**按窗口算**的（用户 R41：首要负责自己窗口的任务）。
     * 归属口径（方向员给的判据）：取该需求**最新一轮的 session** ——
     * 不能用 SPEC 的「出处」，那会把中途转手的 R# 判错（实测 R9 会算错）。
     */
    const ownStale = owner ? stale.filter((x) => String(lastByReq.get(x.id)?.session ?? '') === owner) : stale;
    const otherStale = owner ? stale.filter((x) => String(lastByReq.get(x.id)?.session ?? '') !== owner) : [];
    // `staleRequirements` 会跳过"一条轮次都没有"的需求（那属于"从没被推进过"）——
    // 方向员实测：d8394e68 的 8 条需求就是这样**完全不出现**在任何视图里。
    const noRound = spec.filter((s) => !lastByReq.has(s.id) && !isParked(s));
    console.log(`② 总项目：需求 ${spec.length} 条 · 已确认完成 ${doneN} · 欠账 ${stale.length} 条`
      + (owner ? `（**本窗口 ${ownStale.length} / 别窗口 ${otherStale.length}**）` : ''));
    if (ownStale.length) console.log(`   · 本窗口的欠账：${ownStale.map((x) => `${x.id}(${x.status})`).join('、')}`);
    if (otherStale.length) console.log(`   · 别窗口的欠账：${otherStale.map((x) => `${x.id}(${x.status})`).join('、')} —— 只报数，别顺手替它做`);
    if (noRound.length) console.log(`   · 另有 ${noRound.length} 条**从没被任何一轮推进过**：${noRound.slice(0, 6).map((s) => s.id).join('/')}${noRound.length > 6 ? '…' : ''}`);
    if (newest && newest.requirement) console.log(`   最新一轮：第 ${newest.round} 轮 · ${newest.requirement} · ${newest.status}`);
    console.log(`   原话归宿：已认领 ${cl.claimedCount} / 共 ${cl.total}${cl.after && cl.after.length ? ` · **水位线之后还有 ${cl.after.length} 条没归宿**` : ' · 水位线之后都处理完了'}`);
    console.log('');
    console.log(`③ 其它窗口：${byOther.size} 个会话、共 ${[...byOther.values()].reduce((a, b) => a + b, 0)} 条原话 —— **默认只计数、不砸进来**（要看：node warden.mjs voices "<关键词>"）。`);
    console.log('');
    console.log(`   全量一直在盘上，不会丢：VOICE.jsonl ${voices.length} 条 · SPEC.md ${spec.length} 条 · ROUNDS.jsonl ${rounds.length} 轮。`);
    return 0;
  }

  if (cmd === 'role') {
    // 两个干活角色的**派发口**（用户 2026-09-16）：一条命令生成给子代理的任务书。
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const sub = argv[1];
    const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

    /**
     * `role say --role 审查 --text "…" [--ref R6] [--topic …]`
      * 用户 R6：角色说的话要直接显示，不许 AI 隐藏后通过自己转述
     *   ⇒ 角色发言要有**逐字的家** + **`名字 · 职称：原话`** 的显示形态。
     *   ⚠ 这个命令**只做两件事**：把它逐字存下来、按那个格式打出来。**不加任何解释、不改写、不截断** ——
     *     一旦开始"顺手润色"，它就又变成转述了。
     */
    if (sub === 'say') {
      const role = opt('role');
      const text = opt('text');
      if (!role || !text) {
        console.log('[用法] role say --role 审查 --text "这个角色的**原话**" [--ref R6] [--topic "哪件事"]');
        console.log(`  --role 只能是注册表里的：${ALL_ROLE_IDS.join(' / ')}`);
        return 2;
      }
      if (!ALL_ROLE_IDS.includes(role)) {
        console.log(`[拒收] 「${role}」不是角色注册表里的名字。注册表里只有：${ALL_ROLE_IDS.join('、')}`);
        console.log('  （写错名字的角色发言，将来没人能反查它是谁说的。）');
        return 2;
      }
      const rec = recordRoleSpeech(dir, { role, text, ref: opt('ref'), topic: opt('topic') });
      // 显示形态由 roleSpeech 统一产生 —— 别处不许自己拼，免得两套措辞
      console.log(roleSpeech(role, rec.text));
      console.log(`  （已逐字追加到 ${path.join(dir, ROLE_SPEECH_FILE)}；职称随发言存下，将来改注册表也不动历史）`);
      return 0;
    }

    /**
     * `role scan <文件>` —— 【代理】转述检测：产物里有没有"角色名 + 说/认为…"这种间接引语，
     * 而同一份产物里既没有它的 `名字 · 职称：` 原话行、也没有引号引用。
     * ⚠ 这是**启发式**：命中 ≠ 证明转述了，没命中 ≠ 没转述。所以 exit 1 表示"疑似"，
     *   报出来给人看，**不许**拿它当"证明某人转述了"。
     */
    if (sub === 'scan') {
      const target = argv.slice(2).filter((a) => !a.startsWith('--')).join(' ');
      if (!target) { console.log('[用法] role scan <文件>   —— 查这份产物里有没有把角色的话转述掉'); return 2; }
      const p = path.isAbsolute(target) ? target : path.join(root, target);
      if (!fs.existsSync(p)) { console.log(`[用法] 找不到文件：${p}`); return 2; }
      const hits = roleParaphraseScan(readText(p));
      console.log(`${ROLE_STAMP.supervisor} 转述检测（**启发式**）· ${p}`);
      console.log('');
      if (!hits.length) {
        console.log('  没扫到"角色名 + 说/认为…"这种间接引语 —— **但没扫到不等于没有**（文雅一点的转述抓不到）。');
        console.log('  用户 R6 要的是：角色的原话**逐字出现**，前面带 `名字 · 职称：`。');
        return 0;
      }
      console.log(`  疑似转述 ${hits.length} 处 —— 它们在替角色说话，而**这份产物里找不到那个角色的原话**：`);
      for (const h of hits) console.log(`    · ${h.role}${h.verb}…：${h.line}`);
      console.log('');
      console.log('  两种收法（都不许"就这么放着"）：');
      console.log('    ① 把原话贴进来：' + `node warden.mjs role say --role ${hits[0].role} --text "…逐字原话…"`);
      console.log('    ② 或者把间接引语删掉，让角色自己说（R6 的原话就是「AI不会把角色的话隐藏」）。');
      console.log('  ⚠ 这是启发式，不是判决：命中说明"该核一下"，不代表你一定转述错了。');
      return 1;
    }

    if (sub === 'brief') {
      const id = opt('role');
      const card = WORK_ROLES.find((r) => r.id === id);
      if (!card) { console.log(`[用法] --role 只能是 ${WORK_ROLES.map((r) => r.id).join(' / ')}`); return 2; }
      const question = String(opt('question') ?? '').trim();
      if (!question) { console.log('[用法] 还要给 --question "要它查/判什么"'); return 2; }
      const ref = String(opt('ref') ?? '').trim();
      const specIds = fs.existsSync(path.join(dir, 'SPEC.md')) ? parseSpec(readText(path.join(dir, 'SPEC.md'))).map((s) => s.id) : [];
      const specLine = fs.existsSync(path.join(dir, 'SPEC.md')) ? readText(path.join(dir, 'SPEC.md')) : '';
      const quoted = ref && specIds.includes(ref)
        ? (specLine.split('\n').find((l, i, all) => String(all[i - 1] ?? '').startsWith(`## ${ref} `) && l.startsWith('- 原话:')) ?? '')
        : '';
      console.log(`${card.stamp} 任务书 —— 派给一个子代理（把下面整段给它，别给它你的结论）`);
      console.log('');
      console.log(`## 你的角色：${card.id}`);
      console.log(`· 职责：${card.duty}`);
      console.log(`· 硬规则：${card.hard}`);
      console.log(`· 什么时候该派你：${card.when}`);
      console.log('');
      console.log(`## 这一次要你回答的问题`);
      console.log(question);
      console.log('');
      console.log('## 可读材料（只读，别改任何文件）');
      // ⚠ 2026-09-17 修：这几行原来**硬编码** `<WORKSPACE>\.warden\…`（脑子A 第⑩条）——
      //   换个工程根就指错账本。现在按**实际工程根**拼，并且把 `role brief` 自己会走的那条
      //   "派活→落账" 回路也印出来。
      const wdir = path.join(root, WARDEN_DIR);
      console.log(`· ${path.join(wdir, 'SPEC.md')}       需求与逐字原话（R# 都在这儿）`);
      console.log(`· ${path.join(wdir, 'VOICE.jsonl')}   用户在每个窗口说过的每一句话（大，用 grep 定位）`);
      console.log(`· ${path.join(wdir, FINDINGS_FILE)} 已经查到的（别重复查）`);
      console.log(`· ${root}                              工程目录（只读）`);
      if (ref) console.log(`· 本次盯住的需求：${ref}${quoted ? ` —— ${quoted.trim()}` : ''}`);
      console.log('');
      console.log('## 交回格式（简短，别写作文）');
      console.log('1) 结论：一句话');
      console.log('2) 依据：每条都能指到文件绝对路径 + 行号 或原话（指不到的写"查不到"，不许猜）');
      console.log('3) 落地：要接进哪条 R#（或明说"只是 AI 提案"）');
      console.log(`4) 我会用这条命令把你的产出记下来：${card.how.replace(/R#$/, ref || 'R#')}`);
      console.log('');
      /**
       * ★ **派活落账**（2026-09-17 新增，R10 剩下的那半）。
       *   为什么要有：两个脑子独立指出「从没派过」与「派了没干」在数据上分不开 ——
       *   补了 `DUTY.jsonl` 之后，这一步是让回路**顺手转起来**的入口：
       *   派单时加 `--record` 就自动记一笔，之后 `roles --health` 才能判「派了活没干」。
       *   ⚠ **默认不记**（不加 `--record` 就不落盘）：`role brief` 只打印，派不派是调用方的事，
       *   替它记一笔等于伪造一次派发。
       */
      const shouldRecord = argv.includes('--record');
      console.log('## 派活要落账（否则仪表分不清"派了没干"与"没活干"）');
      if (shouldRecord) {
        if (!ref || !specIds.includes(ref)) {
          console.log(`  ⚠ 没记：--record 需要 --ref 指到 SPEC 里真有的需求号（现在给的是「${ref || '空'}」）`);
        } else {
          const dr = addDuty(dir, { role: id, what: question, ref, why: 'role brief 派单时自动记账' }, specIds);
          if (dr.ok) {
            console.log(`  ✔ 已记进 ${path.join(wdir, DUTY_FILE)}：${id} ｜ 依据 ${ref}`);
            console.log(`    （之后若窗口内看不到它的产出，roles --health 会报「派了活没干」）`);
          } else {
            console.log(`  ⚠ 没记成：${dr.why}`);
          }
        }
      } else {
        console.log(`  这次**没记**（没加 --record）。想记就重跑一次带 --record，或手动：`);
        console.log(`    node warden.mjs duty add --role ${id} --what "<这次要它做什么>" --ref ${ref || 'R#'}`);
      }
      return 0;
    }

    const f = readFindings(dir);
    const specRows = fs.existsSync(path.join(dir, 'SPEC.md')) ? parseSpec(readText(path.join(dir, 'SPEC.md'))) : [];
    const stale = staleRequirements(specRows, readRounds(dir)).filter((x) => !x.parked);
    console.log(`${ROLE_STAMP.keeper} 干活角色 · 共 ${WORK_ROLES.length} 个`);
    console.log('');
    for (const r of WORK_ROLES) {
      console.log(`  ${r.stamp}`);
      console.log(`    职责：${r.duty}`);
      console.log(`    何时：${r.when}`);
      console.log(`    硬规则：${r.hard}`);
    }
    console.log('');
    console.log('  派发：node warden.mjs role brief --role 资料员 --question "要它查什么" [--ref R#]');
    console.log('');
    console.log(`  现在缺什么：`);
    console.log(`    · 发现台账里还没落到做：${f.items.filter((x) => !String(x.ref ?? '').trim()).length} 条`);
    console.log(`    · 已登记但最新一轮仍未解决：${stale.length} 条${stale.length ? `（${stale.map((x) => x.id).join('、')}）` : ''}`);
    console.log('    · 要改"已确认完成"的东西之前：先 snapshot，再让这两个角色出规划（record 里有硬闸门）');
    return 0;
  }

  if (cmd === 'find') {
    // 发现台账（R28/R29）：两个新角色（资料员 / 方向员）查到的东西写这儿。
    // 硬规则：署名、资料员报事实必须给出处、**必须指到某条 R#**（否则只能算 AI 提案并被计数）。
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const sub = argv[1];
    const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
    const specIds = fs.existsSync(path.join(dir, 'SPEC.md')) ? parseSpec(readText(path.join(dir, 'SPEC.md'))).map((s) => s.id) : [];

    if (sub === 'add') {
      // ⚠ 实测事故：--source 里带双引号时会被 shell 改写，`--ref` 可能整条丢掉
      //   （我第一版就踩了：一条发现落到了"没落地"里，计数就不准了）。
      //   所以另给一个不经过 shell 解析的口子：--json <文件>，从文件读整条记录。
      let rec = { by: opt('by'), text: opt('text'), source: opt('source'), ref: opt('ref'), kind: opt('kind'), why: opt('why') };
      const jsonPath = opt('json');
      if (jsonPath) {
        try {
          // ⚠ PowerShell 的 Set-Content -Encoding UTF8 会写 BOM → JSON.parse 直接抛
          //   "Unexpected token ''"，剥掉再解（实测踩过）。
          const raw = fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, '');
          const fromFile = JSON.parse(raw);
          rec = Object.assign(rec, fromFile);
        } catch (e) { console.log(`[拒收] --json 读不了或不是 JSON：${e.message}`); return 2; }
      }
      const r = addFinding(dir, rec, specIds);
      if (!r.ok) { console.log(`[拒收] ${r.why}`); return r.code ?? 2; }
      // 前缀必须**按署名给**（谁说的就写谁）——
      // 原来只有"资料员 else 方向员"两分支，监督员会被打成【方向 · 工程方向员】（实测踩到）。
      // ⚠ 归属提醒（用户 2026-09-16 澄清）：「提示前带角色名」这个写法是 **AI 提的建议、用户没反对**，
      //   不是用户提的要求（见 SPEC.md R38）。别拿它当"用户要求过"的证据。
      const stampBy = { 资料员: ROLE_STAMP.research, 方向员: ROLE_STAMP.direction, 监督员: ROLE_STAMP.supervisor };
      const stamp = stampBy[r.record.by] ?? ROLE_STAMP.keeper;
      console.log(`${stamp} 记下了 · ${r.record.by} · ${r.record.kind}`);
      console.log(`  ${r.record.text}`);
      if (r.record.source) console.log(`  出处：${r.record.source}`);
      console.log(`  落到：${r.record.ref || '（还没指到 R# —— 按 AI 提案算，会被计数进"还没落到做"）'}`);
      if (r.record.why) console.log(`  依据：${r.record.why}`);
      console.log(`  （append-only 追加到 ${path.join(dir, FINDINGS_FILE)}）`);
      return 0;
    }

    const f = readFindings(dir);
    console.log(`${ROLE_STAMP.keeper} 发现台账 · ${path.join(dir, FINDINGS_FILE)}`);
    console.log('');
    if (!f.items.length) {
      console.log('  （空）—— 资料员/方向员查到东西就写这儿：');
      console.log('    node warden.mjs find add --by 资料员 --text "查到了什么" --source "出处" --ref R28');
      console.log('    node warden.mjs find add --by 方向员 --text "还能往哪做" --why "指回哪条用户原话/已登记痛点"');
      return 0;
    }
    for (const x of f.items) {
      console.log(`  · [${x.by}/${x.kind}] ${oneLine(x.text, 70)}`);
      console.log(`      ${x.source ? `出处 ${x.source}` : '（没出处）'} ｜ 落到 ${x.ref || '（还没指到 R#）'} ｜ ${x.at ?? ''}`);
    }
    const noRef = f.items.filter((x) => !String(x.ref ?? '').trim()).length;
    console.log('');
    console.log(`  共 ${f.items.length} 条 · **还没落到做 ${noRef} 条**`);
    return 0;
  }

  if (cmd === 'duty') {
    /**
     * 派活台账（2026-09-17 新增）。**为什么要它**：两个「脑子」独立审完一致指出 ——
     * 旧账本只有产出侧，"没产出"与"没活干"在数据上分不开，于是仪表只能瞎猜
     * （恒真 / 假阳性 / 停产时沉默）。这一条命令补的就是"责任"那一侧。
     * 用法：`duty add --role 资料员 --what "查 X" --ref R#`；`duty` 看全部。
     */
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const sub = argv[1];
    const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
    const specIds = fs.existsSync(path.join(dir, 'SPEC.md')) ? parseSpec(readText(path.join(dir, 'SPEC.md'))).map((s) => s.id) : [];

    if (sub === 'add') {
      const r = addDuty(dir, { role: opt('role'), what: opt('what'), ref: opt('ref'), why: opt('why') }, specIds);
      if (!r.ok) { console.log(`[拒收] ${r.why}`); return r.code ?? 2; }
      console.log(`${ROLE_STAMP.supervisor} 派了活 · ${r.record.role}`);
      console.log(`  做什么：${r.record.what}`);
      console.log(`  依据：${r.record.ref}${r.record.why ? '（' + r.record.why + '）' : ''}`);
      console.log(`  （append-only 追加到 ${path.join(dir, DUTY_FILE)}）`);
      console.log('');
      console.log('  ⚠ 这一步只是**记账**：派出去之后要在窗口内看到它的产出（票 / 发现台账），');
      console.log('    否则 `roles --health` 会报「派了活没干」。派单口本身用：');
      console.log(`      node warden.mjs role brief --role ${r.record.role} --question "要它做什么" --ref ${r.record.ref}`);
      return 0;
    }

    const d = readDuties(dir);
    console.log(`${ROLE_STAMP.supervisor} 派活台账 · ${path.join(dir, DUTY_FILE)}`);
    console.log('');
    if (!d.items.length) {
      console.log('  （空）—— 派了活就记一笔，这样"没产出"才能和"没活干"分开：');
      console.log('    node warden.mjs duty add --role 资料员 --what "查 X 到底怎么用" --ref R13');
      if (d.bad.length) console.log(`  ⚠ 有 ${d.bad.length} 行读不出来（第 ${d.bad.join('、')} 行）`);
      return 0;
    }
    for (const x of d.items) {
      console.log(`  · ${x.role} ｜ ${oneLine(x.what, 60)} ｜ 依据 ${x.ref} ｜ ${x.at ?? ''}`);
    }
    console.log('');
    const byRole = {};
    for (const x of d.items) byRole[x.role] = (byRole[x.role] ?? 0) + 1;
    console.log(`  共 ${d.items.length} 条 · 按角色：${Object.entries(byRole).map(([k, v]) => k + ' ' + v).join(' / ')}`);
    if (d.bad.length) console.log(`  ⚠ 有 ${d.bad.length} 行读不出来（第 ${d.bad.join('、')} 行）—— 坏行不许静默吞`);
    return 0;
  }

  if (cmd === 'claims') {
    // 原话认领闸（事故 I26）：VOICE.jsonl（用户说过的）与 SPEC.md（我们在做的）之间那条连线。
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const sub = argv[1];
    const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
    /**
     * ★★ R37：`claims` 的取数**按窗口收窄**，与 `voices` / `needs` / `results` 同一套口径。
     *
     * 事故原样：`claims`（默认）在任何窗口都读同一本汇总本 ⇒
     *   `未认领 197 / 共 389`，与真原件**逐字节相同** —— 也就是说 `claims` / `ask` 这两条路
     *   **逐字节没治**，而它们正是"污染的正源"。
     *
     * 三条规矩：
     *   ① 默认只扫本窗口；认不出本窗口 ⇒ **拒收（exit 2）**，不替你猜（静默按全集扫就是污染本身）；
     *   ② 要全集必须**显式** `--all-windows`；
     *   ③ 输出里**必印"这次取数来自 N 个窗口"**（只报条数不报窗口数，读者没法判断口径）。
     *
     * ⚠ **全局水位线只在扫全集时才设**（和 `voices` 的水位线同一个理由）：
     *   scoped 一次只覆盖一个窗口，拿它去设那条**全局**水位线是**假证据**。
     *   `check` 走的仍是**全集**口径（`claimsStatus(root,dir)` 不带 session）⇒ 判定一个字没改。
     */
    const cScope = resolveWindowScope(root, { session: opt('session'), allWindows: argv.includes('--all-windows') });
    if (cScope.mode === 'unknown') { console.log(unknownWindowNotice(cScope, 'claims')); return 2; }
    const cSession = cScope.mode === 'all' ? '' : String(cScope.session ?? '');
    const scopeLine = (cl) => `  窗口口径：${cScope.mode === 'all' ? `全集（${cScope.why}）` : `只扫本窗口 ${cSession}（${cScope.why}）`}`
      + ` —— **这次取数来自 ${cl.windows} 个窗口**、${cl.total} 条真用户原话`
      + (cScope.mode === 'all' ? '' : '（别的窗口不在这次范围里：node warden.mjs claims --all-windows）');

    if (sub === 'add') {
      const specIds = fs.existsSync(path.join(dir, 'SPEC.md')) ? parseSpec(readText(path.join(dir, 'SPEC.md'))).map((s) => s.id) : [];
      const r = addClaim(dir, { voice: opt('voice'), kind: opt('kind'), ref: opt('ref'), why: opt('why'), by: opt('by'), specIds });
      if (!r.ok) { console.log(`[拒收] ${r.why}`); return r.code ?? 2; }
      console.log(`${ROLE_STAMP.keeper} 已认领：${r.record.voice} → 【${r.record.kind}】${r.record.ref || ''}`);
      console.log(`  原话：${oneLine(r.voice.text, 60)}`);
      if (r.record.why) console.log(`  依据：${r.record.why}`);
      console.log(`  （append-only 追加到 ${path.join(dir, CLAIMS_FILE)}）`);
      const cl = claimsStatus(root, dir, { createWatermark: false, session: cSession || undefined });
      console.log(`  现在：${claimsSummary(cl)}${cl.after.length ? ` · **水位线之后仍有 ${cl.after.length} 条未认领**` : ''}`);
      console.log(scopeLine(cl));
      return 0;
    }

    if (sub === 'why') {
      const voice = opt('voice');
      if (!voice) { console.log('[用法] node warden.mjs claims why --voice "<session-id>#20"'); return 2; }
      // ★ 显式 `--voice` 是**按指针查**（不是按窗口取数）：指针可能指向别的窗口，
      //   所以这里仍按**全集**解析。窗口口径只约束"列出来的是谁说的话"，不约束"我指名道姓要看的这一条"。
      const voices = loadVoices(dir);
      const v = findVoiceByRef(voices, voice);
      if (!v) {
        console.log(`[拒收] --voice「${voice}」在 ${WARDEN_DIR}/VOICE.jsonl 里找不到 —— 先跑 node warden.mjs voices 同步。`);
        return 2;
      }
      const { claims, bad } = readClaimLines(dir);
      const mine = claims.filter((c) => {
        const t = findVoiceByRef(voices, c.voice);
        return t && voiceKey(t) === voiceKey(v);
      });
      const d = v.at ? new Date(v.at).toLocaleString('zh-CN') : '?';
      console.log(`${ROLE_STAMP.keeper} 原话认领 · ${voiceKey(v)}（${d}）`);
      console.log(`  原话：${v.text}`);
      console.log(`  记录 kind：${v.kind ?? '（老记录没有 kind，按 user 算）'}`);
      console.log('');
      if (!mine.length) {
        console.log('  未认领 —— 没有任何 CLAIMS.jsonl 记录指向这条原话。');
        console.log('  它现在只躺在 VOICE 里：check/report/map 都不会看它（这就是事故 I26）。');
        console.log(`  认领它：node warden.mjs claims add --voice "${voice}" --kind 需求 --ref R# --why "…"`);
        if (bad.length) console.log(`  ⚠ 另有 ${bad.length} 行 CLAIMS.jsonl 读不懂，上面的"未认领"可能算多了。`);
        return 1;
      }
      for (const c of mine) {
        console.log(`  → 【${c.kind}】${c.ref || '（没写 ref）'}`);
        console.log(`     依据：${c.why || '（没写 why）'}`);
        console.log(`     认领于 ${c.at || '?'}${c.by ? `  by ${c.by}` : ''}`);
      }
      const labels = { 需求: '已变成 SPEC 需求', 非要求: '判定为非要求（闲聊/提问/情绪）', 已答过: '判为已答过', 撤回: '用户撤回了' };
      console.log(`\n  结论：${mine.map((c) => labels[c.kind] ?? c.kind).join('；')}`);
      return 0;
    }

    // 默认：列出**未认领**的真用户消息（★ 按窗口口径收窄；要全集必须显式 --all-windows）
    const cl = claimsStatus(root, dir, { createWatermark: cScope.mode === 'all', session: cSession || undefined });
    const all = argv.includes('--all');
    console.log(`${ROLE_STAMP.keeper} 原话认领 · 未认领的真用户消息\n`);
    console.log(scopeLine(cl));
    if (cScope.mode !== 'all') {
      console.log('  （全局水位线**这次没动** —— 它只在 `--all-windows` 时才设：拿"一个窗口"去设全局水位线是假证据）');
    }
    console.log('');
    if (!cl.total) {
      // 「0 条」不许读成"没问题"/"用户没说过"（A6）—— 三种原因都要说出来
      console.log('  **这次取数 0 条** —— 但这**不等于"用户没说过话"**：');
      console.log(cScope.mode === 'all'
        ? '    · 汇总本可能还没建/是空的：先跑 node warden.mjs voices --all-windows'
        : `    · 本窗口（${cSession}）在这本账里还没有原话：先跑 node warden.mjs voices --session ${cSession}`);
      if (cScope.mode !== 'all') console.log('    · 也可能这些原话是**别的窗口**说的：node warden.mjs claims --all-windows');
      console.log('\n未认领 0 / 共 0');
      return 0;
    }
    if (cl.created) {
      console.log(WATERMARK_SET_NOW);
      console.log(`   （水位线 ${cl.since}；当前 ${cl.total} 条历史原话只计数、不追责）\n`);
    } else {
      console.log(`  水位线 since=${cl.since || '（没有）'}：**之后**新增的未认领会让 check 失败；之前的历史未认领只计数。\n`);
    }
    if (cl.bad.length) console.log(`⚠ ${CLAIMS_FILE} 有 ${cl.bad.length} 行读不懂：${cl.bad.slice(0, 3).map((b) => `第 ${b.n} 行（${b.why}）`).join('；')} —— 坏行会被当成"没认领"，下面的数字要打折看。\n`);
    if (!cl.unclaimed.length) {
      console.log('  没有未认领的原话。');
      console.log(`\n未认领 0 / 共 ${cl.total}`);
      return 0;
    }
    const limit = all ? cl.unclaimed.length : 20;
    for (const v of cl.unclaimed.slice(0, limit)) {
      const d = v.at ? new Date(v.at).toLocaleString('zh-CN') : '?';
      const mark = cl.since && String(v.at ?? '') > cl.since ? '★水位线之后（硬失败）' : '  历史（只计数）';
      console.log(`${mark}  ${voiceKey(v)}  ${d}`);
      console.log(`        ${oneLine(v.text, 80)}`);
    }
    if (cl.unclaimed.length > limit) console.log(`  …（还有 ${cl.unclaimed.length - limit} 条，--all 全列）`);
    console.log('');
    console.log(`未认领 ${cl.unclaimed.length} / 共 ${cl.total}`);
    return 0;
  }
  if (cmd === 'map') {
    // 架构总图：支线 × 覆盖度 × 最近活动 × 归属可信度，一扫便知哪条支线被丢了。
    const dir = path.join(root, WARDEN_DIR);
    const p = path.join(dir, 'ARCH.md');
    if (!fs.existsSync(p)) {
      console.log(`[用法] 还没有 ${WARDEN_DIR}/ARCH.md —— 先把"总目标 → 支线 → 子项"写下来。`);
      console.log('       （总目标必须来自用户原话；支线可以是 AI 提案，但要写日期和理由。）');
      return 2;
    }
    const arch = parseArch(readText(p));
    const md = `${ROLE_STAMP.map} 架构总图\n\n${renderMap(root, arch)}`;
    const outp = path.join(dir, 'MAP.md');
    fs.writeFileSync(outp, md, 'utf8');
    console.log(md);
    console.log(`\n（已写入 ${outp}）`);
    return 0;
  }
  if (cmd === 'quotes') {
    // 归属核查：文档/源码里"把某句话归给用户"的写法，逐句拿去会话日志里验。
    const files = positionalArgs(argv.slice(1), ['--session']);
    // ★ R37：引文核对的**取数一律全集**（这是"回退"，不是"再收窄"）—— 口径见下面那段。
    const givenScopeFlags = ['--session', '--all-windows'].filter((f) => argv.includes(f));
    const { corpusSize, results, scannedFiles, windowStats } = runQuoteAudit(root, { files });
    console.log(`${ROLE_STAMP.quotes} 归属核查\n`);
    /**
     * ★★ 口径如实写成**全集** —— **这是回退**：
     *   上一版（P-M5）把引文语料按窗口收窄，结果一条"逐字为真、来自别的窗口"的用户原话被判
     *   「★查无实据」(exit 1)，而"给一个不存在的窗口 id"时还会打印「用户真语料来自 **0 个窗口**、0 字」
     *   **同时**报「✅ 逐字对上（7 处）」—— 两个数字互相打架（口径谎报）。
     *   ⇒ 语料一律**全集**，这里也**只许写"全集"**。
     *   「扫了几个窗口」仍然要明写（R37 的可读性要求保留）；口径与 `voices` 一致：
     *   **只有 `session-*` 才是用户窗口**，裸 uuid 是子代理会话，单独报出来。
     */
    console.log(`窗口口径：**全集**（引文核对按全历史取数，SPEC 的引文本就跨窗口）`
      + ` —— 真用户语料来自 **${windowStats.windows} 个窗口**（共见到 ${windowStats.sessionsSeen} 个会话，`
      + `其中子代理会话 ${windowStats.subagentSessions} 个 —— 子代理会话**不算窗口**；`
      + `按口径跳掉别的窗口 ${windowStats.skippedOtherWindows} 个）`);
    if (givenScopeFlags.length) {
      // 显式传了旗标却按全集取数 —— **不许静默忽略**（静默是这个项目最坏的一类行为）
      console.log(`  ⚠ 你传了 ${givenScopeFlags.join(' / ')}，但**本命令不按窗口收窄**：`
        + `引文核对一律按**全集**取数（收窄会把别的窗口说过的真话判成"查无实据"）。`);
      console.log('     要看"本窗口说过什么"：node warden.mjs voices   ｜   要落总账：node warden.mjs ledger flush');
    }
    if (windowStats.noDiskWindows) {
      // 口径差异必须说出来，否则 42 vs 38 会被读成"某个命令算错了"
      console.log(`  （其中 **${windowStats.noDiskWindows} 个没写过磁盘**：它们的话在本命令的语料里，`
        + `但按用户要求**不进** voices 那本账 —— 所以 quotes 与 voices 的窗口数本来就会差这么多。）`);
    }
    console.log('');
    /**
     * **「没查到东西」≠「查了没问题」**（实测事故 A6）。
     * 原来传一个不存在的路径 → 扫了 0 处 → 打印"结论：没有发现查无实据的归属" → exit 0。
     * 那是把"我啥也没查"报成了"我查了、没问题" —— 最坏的一类假通过。
     * 所以：0 个文件 = exit 2（路径写错了）；0 处匹配 = 明说"扫了 N 个文件、0 处匹配"。
     */
    if (!scannedFiles) {
      const dir0 = path.join(root, WARDEN_DIR);
      let cand = [];
      try { cand = fs.readdirSync(dir0).filter((x) => x.endsWith('.md')).map((x) => `${WARDEN_DIR}/${x}`); } catch { cand = []; }
      console.log('**没有扫到任何文件 —— 路径写错了吗？**');
      console.log('');
      const given = files.length ? files.join(' ') : `（没给，按扩展名 ${SCAN_EXT.join(' ')} 扫整个工程）`;
      console.log(`  你给的：${given}`);
      console.log(`  实际扫到：0 个文件`);
      console.log(`  ${WARDEN_DIR} 下实际有的是：${cand.length ? cand.join('  ') : '（一个 .md 都没有）'}`);
      console.log('');
      console.log('  这一句必须说清楚：**这次什么都没查**，不是"查了没问题"。');
      return 2;
    }
    const bucket = { verbatim: [], 'quoted-from-ai': [], paraphrase: [], unfounded: [], 'too-short': [] };
    for (const r of results) (bucket[r.verdict] ??= []).push(r);   // 未知判决不再炸整个报告（踩过：新判决没进桶 → TypeError）
    console.log(`扫了 ${scannedFiles} 个文件、${results.length} 处「归给用户」的写法；用户真消息语料 ${fmtInt(corpusSize)} 字（去空白后，来自 ${windowStats.windows} 个窗口）\n`);
    // 权威层体检（L10）：VOICE 快照落后时，先把话说清楚，别让读者把结论当准的
    const vsQ = voiceStaleness(root, path.join(root, WARDEN_DIR));
    if (vsQ.stale) {
      console.log(`${voiceStaleWarning(vsQ)}`);
      console.log('  （注：本命令的引文逐字核对**直接读原始会话日志**，不走 VOICE.jsonl —— 所以它的判定不受这层影响；');
      console.log('    受影响的是提问闸门 ask / 窗口传递层 voices。但"语料层过期"本身就说明该先同步一次。）\n');
    }
    if (!results.length) {
      console.log(`**扫了 ${scannedFiles} 个文件、0 处「归给用户」的写法** —— 这是「没查到东西」，不是「查了没问题」。`);
      console.log('  两种可能：① 这些文件里确实没有把话归给用户的写法；② 我指错了文件，或那种写法没被识别。');
      console.log('  **别把这句读成"归属全部核准"** —— 要断言"没问题"，得先确认扫的是对的文件。');
      return 0;
    }
    const show = (r) => {
      console.log(`  ${r.file}:${r.line}   [${r.phrase}]`);
      console.log(`    引文：${r.quote.slice(0, 110)}${r.quote.length > 110 ? '…' : ''}`);
    };
    if (bucket.verbatim.length) {
      console.log(`✅ 逐字对上（${bucket.verbatim.length} 处）`);
      for (const r of bucket.verbatim) show(r);
      console.log('');
    }
    if (bucket.paraphrase.length) {
      console.log(`⚠ 疑似改写（${bucket.paraphrase.length} 处）—— 用户说过相似的，但不是逐字`);
      for (const r of bucket.paraphrase) {
        show(r);
        console.log(`    相似度 ${(r.ratio * 100).toFixed(0)}%` + (r.bestMatch ? `；最接近的一句是：「${r.bestMatch}」` : ''));
      }
      console.log('');
    }
    if (bucket['quoted-from-ai'].length) {
      console.log(`★ 引述自 AI（${bucket['quoted-from-ai'].length} 处）—— 文字是 AI 先写出来的，用户只是**贴回来**；这不叫"用户原话"`);
      for (const r of bucket['quoted-from-ai']) {
        show(r);
        console.log('    归属必须改成「用户贴回（AI 清单）」，不能写成「用户原话」');
      }
      console.log('');
    }
    if (bucket.unfounded.length) {
      console.log(`★ 查无实据（${bucket.unfounded.length} 处）—— 自称"用户原话"但日志里找不到`);
      for (const r of bucket.unfounded) {
        show(r);
        console.log(`    最像的一句只有 ${(r.ratio * 100).toFixed(0)}% 相似` + (r.bestMatch ? `：「${r.bestMatch}」` : ''));
      }
      console.log('');
    }
    if (bucket['too-short'].length) console.log(`（另有 ${bucket['too-short'].length} 处太短，跳过）`);
    const bad = bucket.unfounded.length + bucket['quoted-from-ai'].length;
    console.log(bad
      ? `\n结论：${bad} 处归属有问题（${bucket.unfounded.length} 处查无实据 + ${bucket['quoted-from-ai'].length} 处其实是引述 AI）—— 要么补一句用户真说过的原话，要么把归属改成「用户贴回（AI 清单）」或「我选的」。`
      : `\n结论：扫了 ${scannedFiles} 个文件、${results.length} 处归属写法，没有发现查无实据的归属，也没有把 AI 写的话算成用户原话。`);
    return bad ? 1 : 0;
  }
  if (cmd === 'sources') {
    // "用户原话"去哪里找。跨窗口/跨会话核对时必须能指过去。
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const i = argv.indexOf('--add');
    const s = argv.indexOf('--set');
    const cfg = readConfig(dir);
    if (i >= 0 && argv[i + 1]) {
      cfg.quoteWorkspaces = [...new Set([...(cfg.quoteWorkspaces ?? []), argv[i + 1]])];
      writeConfig(dir, cfg);
    } else if (s >= 0 && argv[s + 1]) {
      cfg.quoteWorkspaces = [argv[s + 1]];
      writeConfig(dir, cfg);
    } else if (argv.includes('--auto')) {
      delete cfg.quoteWorkspaces;
      writeConfig(dir, cfg);
    }
    const dirs = quoteDirNames(root);
    console.log('核对「用户原话」时会去这些工作区找：');
    for (const d of dirs) {
      const n = listSessions({ dirName: d }).length;
      console.log(`  ${d}   （${n} 个会话，${n ? '' : '⚠ 空的，指错地方了'}）`);
    }
    const entries = corpusEntries(root, { force: true });
    console.log(`\n合计真用户消息 ${entries.length} 条。`);
    if (cfg.quoteWorkspaces) console.log(`（来自 config.json 指定；用 --auto 恢复自动识别，--set <路径> 覆盖）`);
    else console.log('（自动识别：当前会话所在的工作区；跨窗口核对用 --add <路径>）');
    return 0;
  }
  if (cmd === 'snapshot') {
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const i = argv.indexOf('--label');
    const label = i >= 0 ? argv[i + 1] : '';
    const { snapDir, manifest } = takeSnapshot(root, dir, label);
    console.log(`快照存到 ${snapDir}`);
    if (!manifest.files.length) {
      console.log('⚠ 这个快照里**一个文件都没有**（.warden/params.yml 的 watches 是空的）——');
      console.log('  以后 diff 拿它做基线，只会得出"没有改动"这种**没有依据**的结论。');
      console.log(`  先把要盯的源文件写进 ${WARDEN_DIR}/params.yml 的 watches 再重新快照。`);
    }
    console.log(`  文件 ${manifest.files.length} 个：`);
    for (const f of manifest.files) console.log(`    ${f.path}  ${f.sha}  ${f.bytes} 字节  ${f.funcs.length} 个函数`);
    console.log(`  档位值 ${Object.keys(manifest.values).length} 项`);
    console.log('\n以后随时可以：node warden.mjs diff' + (label ? ` ${label}` : ''));
    return 0;
  }
  if (cmd === 'diff') {
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const r = diffAgainst(root, dir, argv[1]);
    console.log(`${ROLE_STAMP.diff} 与基线对比\n`);
    console.log(r.msg);
    return r.ok ? 0 : 2;
  }
  if (cmd === 'ledger') {
    /**
     * ★ **总账本**（R37）：跨窗口可见的一本 —— **未做完项的汇总 + 各窗口完成状态**。
     * 用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」
     *
     * 每条**必有** `window`（会话 id）+ `projectRoot`（工程根）+ `at`（时间）⇒ 别的窗口读得出是谁的、什么时候。
     * `ledger`（账本标识，见 ledgerIdOf）把 R# 钉在**它自己那本账**里 —— **R# 不跨账**：
     *   实测隔壁窗口有 R37/R38，本窗口也有 R37，**指的不是同一件事**；
     *   跨账引用必须写成 `<账本id>#R37`（写裸 R# 会被拒收）。
     */
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log('[用法] 先跑：node warden.mjs init'); return 2; }
    const sub = argv[1] && !argv[1].startsWith('-') ? argv[1] : 'show';
    const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
    const lId = ledgerIdOf(root);
    const stamp = ROLE_STAMP.keeper;
    const scope = resolveWindowScope(root, { session: opt('session'), allWindows: argv.includes('--all-windows') });
    const own = scope.mode === 'all' ? '' : String(scope.session ?? '');
    const refOf = (x) => (x.ledger === lId ? x.req : `${x.ledger}#${x.req}`);
    const badLine = (bad) => `  ⚠ ${bad.length} 行**坏记录**（读不动）—— 不许当成"没有这些记录"（会少算"未做完"）：\n`
      + bad.slice(0, 5).map((b) => `      第 ${b.n} 行：${b.why}`).join('\n');

    if (sub === 'ids') {
      const st = ledgerState(dir);
      const ids = [...new Set([lId, ...st.items.map((x) => x.ledger)])];
      console.log(`${stamp} 总账本 · 账本标识（**R# 不跨账**）\n`);
      console.log(`  本工程：${lId}     工程根 ${path.resolve(root)}`);
      for (const x of ids.filter((i) => i !== lId)) {
        const n = st.items.filter((i) => i.ledger === x).length;
        console.log(`  别的账本：${x}   （${n} 项）★ 引用它必须写成 ${x}#R37 —— 否则"同号不同物"会被静默错认`);
      }
      if (!ids.filter((i) => i !== lId).length) console.log('  （总账里还没出现过别的账本）');
      if (st.bad.length) console.log('\n' + badLine(st.bad));
      return 0;
    }

    if (sub === 'add' || sub === 'done' || sub === 'reopen') {
      if (!own) { console.log(unknownWindowNotice(scope, `ledger ${sub}`)); return 2; }
      const reqRaw = String(opt('req') ?? '').trim();
      const parsed = parseLedgerReq(reqRaw);
      if (!parsed) { console.log(`[用法] --req 只能是 R# 或 <账本id>#R#（收到「${reqRaw}」）`); return 2; }
      const inLedger = String(opt('in') ?? '').trim();
      const target = inLedger || parsed.ledger || lId;
      // ★ R# 不跨账：往**别的**账本里记时，需求号必须带账本标识
      if (target !== lId && !parsed.ledger) {
        console.log(`[拒收] **R# 不跨账** —— 「${parsed.req}」只对账本 ${lId} 有效。`);
        console.log(`  要往别的账本里记，必须带账本标识：--req ${target}#${parsed.req}`);
        console.log('  （实测：隔壁窗口有 R37/R38，本窗口也有 R37 —— 编号一样，**指的不是同一件事**。）');
        return 2;
      }
      if (parsed.ledger && parsed.ledger !== target) {
        console.log(`[拒收] --req 里的账本（${parsed.ledger}）和 --in（${target}）不一致 —— 不猜。`);
        return 2;
      }
      let status = sub === 'done' ? 'done' : sub === 'reopen' ? 'reopen' : String(opt('status') ?? 'open').trim();
      if (status === 'reopen' && sub === 'add' && opt('status') !== 'reopen') status = 'open';
      if (!['open', 'done', 'reopen'].includes(status)) {
        console.log('[用法] --status 只能是 open / done / reopen（重开请用 `ledger reopen --req R#`，别用 add 蒙）');
        return 2;
      }
      /**
       * ★ `reopen` 是**显式**把 done 打回 open 的唯一入口（见 ledgerState 的"done 是粘的"）。
       *   为什么要它：否则"手滑一次 flush"就能把别的窗口标的 done 抹掉；
       *   但完全不给人重开的门又会让 done 变成不可逆的谎 —— 所以门留着，只是必须**说出口**。
       */
      if (status === 'reopen') {
        const st = ledgerState(dir);
        const cur = st.items.find((x) => x.ledger === target && x.req === parsed.req);
        /**
         * ★★ `!cur` ⇒ **拒收**（实测：`ledger reopen --req R2`（R2 从来不存在）→
         *   「⟲ 已显式重开」+ **EXIT=0** ⇒ 在总账里造出一条**幽灵欠账**）。
         * 为什么必须拒：`reopen` 写下的每一笔都会被别的窗口当成"这里有一件没做完的事" ——
         *   凭空造欠账比漏记更坏（没法收敛）。
         */
        if (!cur) {
          console.log(`[拒收] ${target}#${parsed.req} 在总账里**从来没有过** —— 没什么可重开的。`);
          console.log('  重开（reopen）只能用在**已经 done** 的项上（它在总账里的状态是 done，才谈得上"打回未做完"）。');
          console.log(`  你是不是想记一件新的事？那是：node warden.mjs ledger add --req ${parsed.req} --status open`);
          console.log(`  （总账里现有 ${st.items.length} 项 —— 看：node warden.mjs ledger show）`);
          return 2;
        }
        if (String(cur.status) !== 'done') {
          console.log(`[拒收] ${target}#${parsed.req} 现在**不是** done（是 ${cur.status}）—— 没什么可重开的。`);
          return 2;
        }
      }
      const at = new Date().toISOString();
      const rec = {
        at, ledger: target, req: parsed.req, title: String(opt('title') ?? ''),
        status, window: own, projectRoot: path.resolve(root), note: String(opt('note') ?? ''),
      };
      const f = appendLedger(dir, rec);
      console.log(`${stamp} 总账本 · 已记一笔 → ${f}`);
      console.log(`  ${target}#${rec.req}  [${status}]   窗口 ${own}   工程根 ${path.resolve(root)}   ${at}`);
      console.log(status === 'done'
        ? '  ✓ 别的窗口现在看得见「这件做完了」：node warden.mjs ledger show --all-windows'
        : status === 'reopen'
          ? '  ⟲ 已显式重开（把它打回"未做完"）—— 别的窗口看得见是谁重开的、什么时候。'
          : '  · 还没做完 —— 收尾时会被自动写进总账（node warden.mjs results / ledger flush）。');
      return 0;
    }

    if (sub === 'flush' || sub === 'close') {
      if (!own) { console.log(unknownWindowNotice(scope, `ledger ${sub}`)); return 2; }
      const r = flushWindowToLedger(root, dir, { session: own, ledgerId: lId, note: String(opt('note') ?? '') });
      console.log(`${stamp} 总账本 · 收尾：把本窗口**还没做完**的项写进去 → ${path.join(dir, LEDGER_FILE)}`);
      console.log(`  窗口 ${own} → 写了 ${r.added} 条（**不做完就静默消失 = 事故**，所以这一笔是必须的）`);
      for (const it of r.items) console.log(`    · ${lId}#${it.req}  ${it.title || ''}  —— ${it.why}`);
      if (!r.added) {
        console.log('  （本窗口没有未做完的项 ⇒ 这一笔是**空的**：要么总账里都已 done，要么本窗口还没开过工。）');
        console.log('  ⚠ "空"≠"都做完了"：它只说明**总账里没有本窗口的欠账**。');
      }
      return 0;
    }

    if (sub === 'show') {
      const st = ledgerState(dir);
      const all = argv.includes('--all-windows');
      const items = all ? st.items : st.items.filter((x) => x.ledger === lId);
      // `--json`：给机器读（判据可机检）。只输出**我们自己的叶子字段**，不 dump 任何活对象。
      if (argv.includes('--json')) {
        console.log(JSON.stringify({
          ledgerId: lId, projectRoot: path.resolve(root), allWindows: all,
          entries: st.entries.length, bad: st.bad.length,
          items: items.map((x) => ({
            ref: refOf(x), ledger: x.ledger, req: x.req, status: x.status, title: x.title ?? '',
            window: x.window, windows: x.windows, projectRoot: x.projectRoot, at: x.at, note: x.note ?? '',
            writes: x.n, doneAt: x.doneAt, doneBy: x.doneBy,
            reopenedAt: x.reopenedAt, reopenedBy: x.reopenedBy,
            postDoneOpen: x.postDoneOpen,
          })),
        }, null, 2));
        return 0;
      }
      console.log(`${stamp} 总账本 · ${all ? '全集（跨窗口 / 跨账本）' : `本账（${lId}）`}\n`);
      console.log(`  本工程账本 ${lId}   工程根 ${path.resolve(root)}`);
      console.log(`  记录 ${st.entries.length} 笔 → 归并成 ${items.length} 项（按 账本#需求号 归并，后写的那笔为准）`);
      if (!all && st.items.some((x) => x.ledger !== lId)) {
        console.log(`  （另有 ${st.items.filter((x) => x.ledger !== lId).length} 项属于**别的账本** —— 看全集：ledger show --all-windows）`);
      }
      if (st.bad.length) console.log(badLine(st.bad));
      const open = items.filter((x) => String(x.status) !== 'done');
      const done = items.filter((x) => String(x.status) === 'done');
      console.log('');
      console.log(`  未做完 ${open.length} 项 —— 每条都看得出是哪个窗口的（窗口/会话 id + 工程根 + 时间）：`);
      if (!open.length) console.log('    （没有未做完的项）');
      for (const x of open) {
        console.log(`    ○ ${refOf(x)}   [${x.window}]   ${x.title || ''}`);
        console.log(`        工程根 ${x.projectRoot}   最后一次写下 ${x.at}   共 ${x.n} 笔   动过它的窗口：${x.windows.join(' · ')}`);
        if (x.reopenedAt) console.log(`        ⟲ 由 ${x.reopenedBy} 于 ${x.reopenedAt} **显式重开**`);
        if (x.note) console.log(`        备注 ${x.note}`);
      }
      console.log('');
      console.log(`  已做完 ${done.length} 项（别的窗口据此能看见"这件做完了"）：`);
      if (!done.length) console.log('    （还没有标成做完的项）');
      for (const x of done) {
        console.log(`    ✓ ${refOf(x)}   [${x.window}]   ${x.title || ''}`);
        console.log(`        工程根 ${x.projectRoot}   **做完于 ${x.doneAt}（窗口 ${x.doneBy}）**   共 ${x.n} 笔`);
        if (x.postDoneOpen.length) {
          // 不许静默：done 之后还有人写过 open —— done 粘住了，但这件事必须被看见
          console.log(`        ⚠ 做完之后还有 ${x.postDoneOpen.length} 笔 open（**done 没被盖回去**，但这说明有窗口还在把它当未做完）：`);
          for (const p of x.postDoneOpen) console.log(`            · ${p.at}  窗口 ${p.window}  ${p.note}`);
        }
      }
      const byWin = new Map();
      for (const x of items) {
        for (const w of (x.windows.length ? x.windows : [String(x.window ?? '(没写窗口)')])) {
          const c = byWin.get(w) ?? { open: 0, done: 0 };
          if (String(x.status) === 'done') c.done += 1; else c.open += 1;
          byWin.set(w, c);
        }
      }
      console.log('');
      console.log('  ▸ 各窗口完成状态（口径：按"这一项被哪些窗口动过"计，一项被两个窗口动过就算两边各一件）：');
      if (!byWin.size) console.log('    （总账还是空的 —— 还没有窗口写过东西）');
      for (const [w, c] of [...byWin.entries()].sort()) console.log(`    ${w}   未做完 ${c.open} · 已做完 ${c.done}`);
      console.log('');
      console.log('  ★ R# 不跨账：本账里的 R# 只对本账有效；别的账本里的号印成 `<账本id>#R#`。');
      return 0;
    }
    console.log('[用法] node warden.mjs ledger <add|done|reopen|flush|show|ids> ...（看 HELP）');
    return 2;
  }
  if (cmd === 'check') {
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log(`[用法] 这个工程还没有 ${WARDEN_DIR}/ —— 先跑：node warden.mjs init`); return 2; }
    const { fails, warns, spec, devs } = check(root);
    console.log(ROLE_STAMP.check + ' 需求监督检查');
    /**
     * `--quiet`：**只印结论与失败，把提醒压成一行计数**（用户 2026-09-17：「token 使用量应该优化」）。
     * 为什么是提醒行而不是失败行：一轮里我要跑好几次 check，每次都把 7 行提醒重新塞进上下文纯属重复
     * （实测一次完整 check = 1408 字符 / 16 行，其中 7 行是提醒）；而**失败是必须看的**，一条都不许少。
     * 收尾那次（对外宣布完成前）不加 --quiet，照样全量看。
     */
    if (argv.includes('--quiet')) {
      if (warns.length) console.log(`提醒 ${warns.length} 条（要看全文就去掉 --quiet）`);
    } else {
      for (const w of warns) console.log('提醒:', w);
    }
    if (fails.length) {
      console.log(`\n需求监督未通过：${fails.length} 条`);
      for (const f of fails) console.log(' -', f);
      return 1;
    }
    console.log(`需求监督通过：${spec.length} 条需求全部有原话出处、有推进记录、交付与需求一致（偏差 ${devs.length} 条均已申报）。`);
    return 0;
  }
  if (cmd === 'report') {
    const dir = path.join(root, WARDEN_DIR);
    if (!fs.existsSync(dir)) { console.log(`[用法] 先跑：node warden.mjs init`); return 2; }
    const { spec, devs, warns } = check(root);
    // 主表把"我们写进 SPEC 的需求"排得很清楚，但它天然看不见"从没进过清单的原话" ——
    // 所以提醒要照样打出来（原话认领水位线自动落位那句就在这里面）。
    for (const w of warns) console.log('提醒:', w);
    const rounds = readRounds(dir);
    const md = `${ROLE_STAMP.report} 需求 → 交付 → 成本主表\n\n${buildReport(root, { spec, devs, rounds })}`;
    const out = path.join(dir, 'REPORT.md');
    fs.writeFileSync(out, md, 'utf8');
    console.log(md);
    console.log(`\n（已写入 ${out}）`);
    return 0;
  }
  if (cmd === 'history') {
    const id = argv[1];
    if (!id) { console.log('[用法] node warden.mjs history <档位id>'); return 2; }
    const dir = path.join(root, WARDEN_DIR);
    const rounds = readRounds(dir);
    const ws = parseParams(fs.existsSync(path.join(dir, 'params.yml')) ? fs.readFileSync(path.join(dir, 'params.yml'), 'utf8') : '');
    const w = ws.find((x) => x.id === id);
    const { turns } = currentCost(root);
    const byTurn = new Map(turns.map((t) => [t.turn, t]));
    const hist = rounds.filter((r) => r.values && Object.prototype.hasOwnProperty.call(r.values, id));
    if (!hist.length) {
      if (!w) {
        // 档位名打错时，"账本里没有 X 的记录"会被读成"这个档位没被改过" —— 那是假通过。
        console.log(`[用法] ${WARDEN_DIR}/params.yml 里没有档位 ${id}，账本里也没有它的记录 —— 是不是 id 打错了？`);
        const known = ws.map((x) => x.id);
        console.log(`  现在盯着的档位：${known.length ? known.join('、') : '（一个都没有）'}`);
        return 2;
      }
      console.log(`[空] 账本里没有 ${id}（${w.label ?? ''}）的记录 —— 它从没被记录过值。`);
      return 0;
    }
    console.log(`档位 ${id}${w ? `（${w.label ?? ''}）` : ''} —— 改过 ${hist.length} 次：`);
    console.log('');
    console.log('轮次  值        本轮 token   本轮时间   为什么');
    console.log('----  --------  -----------  ---------  ------');
    for (const r of hist) {
      const t = byTurn.get(Number(r.round));
      console.log(
        String(r.round).padStart(4) + '  ' +
        String(r.values[id]).padEnd(8) + '  ' +
        (t ? fmtInt(t.usage.total) : '—').padStart(11) + '  ' +
        fmtDur(t?.wallMs).padEnd(9) + '  ' +
        oneLine(r.why, 40),
      );
    }
    const cur = w ? readWatch(root, w) : null;
    if (cur?.ok) console.log(`\n当前值 ${cur.value}（账本最后一版 ${hist[hist.length - 1].values[id]}，第 ${hist[hist.length - 1].round} 轮）`);
    return 0;
  }
  console.log(HELP);
  return 2;
}

const HELP = `warden.mjs —— 需求监督员 / 交付审查 / 数据账本

  node warden.mjs init              建 .warden/ 骨架
  node warden.mjs needs [--session <id>] [--last N]
      **开工：本轮需求清单**（用户 R51：本轮任务开始给需求清单、结束时给结果清单并对账，从来没有实现过）。
      只给本窗口最近 N 条原话 → 归宿（需求 R# / 非要求 / 已答过 / 还没归宿）→ 本轮要做的 R# 及各自最新状态。
  node warden.mjs results [--session <id>] [--last N]
      **收尾：结果清单 + 逐条对账**。每条 R# 的交付 / 证据 / 还差哪半，最后一行给对账口径：
      需求 N 条 → 已交付 / 半交付 / 没做；原话 N 条 → 有归宿 / **对不上结果的**（缺口明着列出来）。
      只给本轮、有上限 —— 不把全历史砸进去（全历史看 report）。
  node warden.mjs check [--quiet]    检查（exit 0=过 1=有问题 2=用法错）
       --quiet：只印结论与失败，提醒压成一行计数 —— 一轮里要跑多次时用它省上下文；
       收尾那次（宣布完成/交付前）**不要**加，全量看。
  node warden.mjs report            生成 .warden/REPORT.md（需求→交付→成本 主表）
  node warden.mjs history <档位id>   查某个档位改过几次、每次花了多少

  node warden.mjs handover draft --next "把 X 推到远端，然后重跑自检"   [--dry] [--rerun "…"]
  node warden.mjs handover draft --no-next "活已做完，只需用户 push"     [--force] [--dry]
  node warden.mjs handover log [--last N] [--json]
      ★ 交接草稿（R10 定案：**显式命令**，不做自动挂进判定链）。由**主代理在轮收口时跑一次**。
        · --next "…"    = 这一轮做完**还有后续** ⇒ 写一份 交接-<日期>.md 草稿 + 留痕；
        · --no-next "…" = 这一轮**明确完成、无后续** ⇒ **不写草稿**，只留痕（这是"不写"的正规出口）。
          ⚠ 它**不消写闸欠账**（故意的）—— 要消欠账就得真写一份交接，否则会养成
            "被写闸拒时随手跑一次清欠账"的新坏习惯。
        · --dry = 只打印本来会写什么，**不落盘**（连留痕都不写）；
        · --files "a.rs,b/lib.rs" = 显式给本轮改动清单（不给就用 git status，拿不到就不写）；
        · **每次调用**都往 .warden/HANDOVER-GATE.jsonl append 一行
          （auto-draft-written / no-next-declared / refused:why）⇒ "跑过没跑过"可查；
        · 目标文件已存在且首行不是 <!-- AUTO-ONLY --> ⇒ **绝不覆盖**（别人的文件）；
        · 攒批口径 = **轮收口时写一次**，不是每个动作都写；不跑这条命令 ⇒ 与今天一字不差。
          handover log 查跑过没跑过（⚠「声明无后续」**不是**"任务做完了"的证据）。

  node warden.mjs snapshot [--label "动 shape2 之前"]
      把 params.yml 点名的源文件**整个拷一份** + 记指纹和函数清单。
      这是"动手前先备份，出问题拉出来比较"用的。
  node warden.mjs diff [标签片段]
      和最近一次（或指定）快照对比：哪些文件改了、**哪些函数没了**、哪些档位值变了、逐行差异。

  node warden.mjs voices [关键词] [--session <id>] [--all-windows] [--rebuild]
      窗口传递层（**最重要的一层**）：把用户在**每个窗口**说过的每一句话逐字落盘。
      ★ R37（用户 2026-09-24 逐字：「（用户原话已隐去 —— 公开版不留逐字）」）：
        · **默认只扫本窗口**，写进**它自己那本** .warden/voices/<会话id>.jsonl；
        · .warden/VOICE.jsonl 是**汇总本**（总账本）—— 要看它必须**显式** --all-windows；
        · 认不出本窗口（子代理会话 / 环境里没有 DSH_SESSION_ID）⇒ **拒收 exit 2**，不替你猜；
        · scoped 同步会**只增不改**地把本窗口的原话并进汇总本 —— 不并，check 的原话认领闸
          会在正常流下**静默失效**（硬伤 A），它自己给的补救命令也永远消不掉提醒（硬伤 B）。
      带关键词 = 查"用户说过什么"（默认也只在**本窗口那本**里查）。
      为什么它比 SPEC 重要：SPEC 是**汇总过的**，汇总本身就会丢信息 ——
      实测事故：用户 16:05 答过"木材工艺链"是什么，16:17 又被问了一遍。
      新记录带 "kind":"user"（老记录不动，读取时缺省当 user）——
      这样 VOICE 自己能分得清"用户真说"与"别处复述"。
  node warden.mjs ledger <add|done|reopen|flush|show|ids>
      ★ **总账本**（R37）：跨窗口可见的一本 .warden/LEDGER.jsonl —— 未做完项的汇总 + 各窗口完成状态。
      每条都带 **窗口 id + 工程根 + 时间** ⇒ 别的窗口读得出是谁的（不许混成一本看不出出处的账）。
        · ledger done --req R1 --title "…"   = 「做完后就标记做完」（带窗口 id + 时间）；
        · ledger add --req R1 --status open   = 记一件没做完的；
        · ledger reopen --req R1              = **唯一**能把 done 打回 open 的显式入口
          （done 是**粘**的：后来的 open 盖不回去，只记成"做完之后还有人当它没做完"）；
        · ledger flush                        = 把本窗口**还没做完**的项写进总账（收尾 results 自动跑）；
        · ledger show [--all-windows] [--json]。
      ★ **R# 不跨账**：需求号只在**它自己那本账**里有效。跨账引用必须写 <账本id>#R7
        （实测：隔壁窗口有 R37/R38，本窗口也有 R37 —— 编号一样，指的不是同一件事）。
  node warden.mjs find [--all]
      发现台账（.warden/FINDINGS.jsonl）：**资料员 / 方向员**两个角色的产出写这儿。硬规则 ——
      必须署名（--by 资料员|方向员）、资料员报「事实」必须给 --source（出处）、
      **必须指到某条 R#**（--ref）；指不到的只能算 AI 提案，并会被 check 计进"还没落到做"。
      为什么这么严（用户 2026-09-16 提出）：查出来是一回事，查出来完全不去解决反而更添垃圾
      用法在里面形成干扰—— 光查出来不接进清单，就是添垃圾。
      例：node warden.mjs find add --by 资料员 --text "查到什么" --source "出处" --ref R28
          node warden.mjs find add --by 方向员 --text "还能往哪做" --why "指回哪条原话/痛点"
  node warden.mjs role
      两个**干活角色**的角色卡（资料员 / 方向员）+ 现在缺什么。只写进文档 = 只是"记着"，
      派发还要手写整套任务书 = 累 ⇒ 索性就不派了。所以给一个派发口。
   node warden.mjs brief [--session <id>] [--own N]
      **读用户言的三层顺序**（用户 R41）：① 本窗口 → ② 总项目进度 → ③ 其它窗口（默认只给计数）。
      默认给本窗口最近 5 条（--own 可调），别的窗口**只计数、不砸原文**；
      每条行尾标出**归宿**（需求 R#/非要求/已答过/撤回），处理完的就不再占位（防"一摊子烂账"）。
      全量一直在盘上（VOICE/SPEC/ROUNDS），要看用 voices "<关键词>"，**不许因为怕乱就丢**。
   node warden.mjs role brief --role 资料员 --question "要它查什么" [--ref R#]
      直接打印**给子代理的任务书**（职责 / 问题 / 可读材料 / 交回格式），整段丢给 subagent 即可。
   node warden.mjs claims [--all]
      原话认领闸（事故 I26）：**VOICE.jsonl（用户说过的）与 SPEC.md（我们在做的）之间原本没有任何连线。**
      一条原话要变得"会被做"，必须有人手工写进 SPEC 成 R#；没人写就只躺在 VOICE 里，
      而 check/report/map 三张表都不看它 ⇒ check 会 exit 0 报"需求全部一致"，
      却查不出"从没进过清单"的要求 —— 这类缺口原来连计数都没有。
      这里列出**未认领**的真用户消息（默认 20 条，--all 全列），末尾打印「未认领 K / 共 M」。
      ⚠ 硬失败只对**水位线之后**新增的原话：146 条历史不可能一次认领完，
      全量硬失败会变成噪音、然后被无视。水位线记在 .warden/CLAIMS.watermark.json，
      第一次跑自动设成"当前 VOICE 最新一条"。
  node warden.mjs claims add --voice "<session-id>#20" --kind 需求 --ref R13 --why "…"
      认领一条原话（append-only，写 .warden/CLAIMS.jsonl）。
      kind ∈ 需求（已写进 SPEC 成 R#：--ref 必填，且那个 R# 必须真的在 SPEC.md 里）/
              非要求（闲聊、提问、情绪 —— --why 必须写依据）/
              已答过（--ref 写指回哪一句）/ 撤回（用户自己撤回了）。
      kind 非法 / voice 格式不对 / voice 在 VOICE.jsonl 里找不到 → exit 2。
  node warden.mjs claims why --voice "<session-id>#20"
      看某条原话认领成了什么。已认领 → exit 0；存在但没认领 → exit 1；VOICE 里没这条 → exit 2。
  node warden.mjs ask "问题"
      提问闸门（机械那一半）：**已经答过的不许再问**；文档里能查到的先去读。
      过了机械关还有"脑子"那一关：派独立子代理审"这问题值不值得占用用户注意力"。
      exit 1 = 被拦下（已答过）。
  node warden.mjs ask --verdict decide|ask --reason "…"
      记下"脑子"那一层的判决。
  node warden.mjs brain [--artifact X]
      脑子角色组的审理状态：每个产物几个脑子、处于「没审 / 单审 / 一致 / 一致·互补 /
      ★冲突·未裁决 / ★改过但未复审」哪一种。
      ⚠ **默认不派脑子** —— 随手小改动不必审；只在 conflict / shallow / explore 触发条件成立时才派。
      用户原话（2026-09-25）：「（用户原话已隐去 —— 公开版不留逐字）」
  node warden.mjs brain brief --artifact <产物> [--trigger conflict|shallow|explore]
      打印**给脑子的任务书**（职责 / 被审产物 / 可读材料 / 交回格式），整段丢给独立子代理。
      不传 --trigger = 派第 1 个；传了 = **加派第 2 个**，任务书里会写清为什么加派，
      但**仍然不给任何人的结论**（独立性是这一层唯一的价值：给了判决它就只是评论者）。
  node warden.mjs brain record --artifact <产物> --brain A|B --verdict accept|reject
                            [--issues "a,b"] [--claims '[...]'] [--trigger …]
                            [--role judge --reason "…"]
      落账。**必须交 --claims**（可机检指控）：没有它，判决既不能被证实也不能被驳倒。
  node warden.mjs brain audit --artifact <产物>
      机器复核指控：查不出来的指控被驳回，那个脑子的判决要重估。exit 1 = 有被驳回的。
      一条可机检指控都没有时，它会明说"这次没复核任何东西"（不许当成"产物没问题"）。
  node warden.mjs map
      架构总图：总目标 → 支线 → 子项，按 覆盖度 / 最近活动 / 归属可信度 排出来。
      只对「整条支线从没被碰过」或「3 轮以上没动」才出声。写进 .warden/MAP.md。
      为什么需要它：用户给的是总目标，架构是 AI 提的 —— 所以架构不要求有用户原话，
      但 AI 会在一条支线上一路深入、把别的支线悄悄丢掉。这张图就是让"被丢的"看得见。
  node warden.mjs quotes [文件...]
      归属核查：把文档/源码里「用户原话就是…」这类**归给用户**的话逐句拿去会话日志验真。
      区分三档：逐字对上 / 疑似改写 / 查无实据。exit 1 = 有查无实据的。
  node warden.mjs sources [--add <工作区>] [--set <工作区>] [--auto]
      指定"去哪里核对用户原话"（需求在别的窗口/别的会话里说的时用）。

  node warden.mjs rules
      可投票规则册（.warden/RULES.jsonl）：**enforced: code（被 exit code 强制）** 与
      **enforced: text（只是建议）** 分开列，末尾打印"文本规则占比" —— 占比越高，
      说明越依赖模型自觉、越不可靠（这是要盯的指标）。已否决/已废止的折叠在最后。
  node warden.mjs rule propose --text "…" --evidence "L1 实测：…" [--enforced text|code] [--id R7]
      提一条规则。**没有证据的规则不许进册（exit 2）**：--evidence 要么指
      .warden/INCIDENTS.jsonl 里某条事故的 id，要么指 lab 里的实验名（L1、L6、L9、L10 这种）。
      新规则一律是「提案」，topic = rule:<id>@1；id 不传就自动分配（R1、R2…）。
  node warden.mjs rule reopen --id R7 --why "…" [--force]
      打回「提案」，修订号 +1（@1 → @2）—— **旧票不污染新票**（topic 变了）。
      留痕：旧文本/旧状态/谁提的/为什么追加成一条 {"kind":"revision",…}。
      「定稿」的规则默认改不动（要 --force）；enforced: code 的会警告"改它要改代码"。
  node warden.mjs rule amend --id R7 --text "…（并入条件后的新文本）" [--why "…"]
      票里附了条件（vote cast --conditions）时，状态会停在「待并条件」——
      把条件并进正文再走这条：修订号 +1、状态回「提案」、**上一版的条件留痕**，然后重新投票。
  node warden.mjs rule status --id R7 [--promote]
      单条详情（文本/状态/enforced/证据/修订历史/当前票数/附条件/未决原因）+ 按票**机械推进**：
      提案 --(多数：同意 且 无未决 且 **没有附条件的票**)--> 试行 --(显式 --promote)--> 定稿；
      有票附条件 --> **待并条件**（条件不并进正文就不算通过）；
      多数：反对 --> 否决；平票/缺席/有异议没被回应 --> **一律不变**，交回脑子继续想。
      exit 1 = 未决（有票却没定下来）。

  node warden.mjs record --req R1 [--round N] [--status in_progress|done|partial|deviated|blocked]
                        [--delivered "..."] [--evidence "..."] [--why "..."]
                        [--covered "导出 PNG,导出 SVG"] [--missing_half "缺哪半"] [--values '{"ripple_period":1.30}']
     记录本轮：脚本自己读源码里的真实档位值写进账本；
     如果你用 --values 报了值，会和源码对账，**对不上就不许记**。
      如果 SPEC 里这条需求写了「子项」，报 done 就必须用 --covered 声明覆盖了哪几个 ——
      覆盖不全**拒收**（exit 1）：要么补齐，要么诚实报 partial（"关键问题只解决半个"就是这条拦的）。
`;

const invoked = process.argv[1] && path.resolve(process.argv[1]).endsWith('warden.mjs');
if (invoked) process.exitCode = main(process.argv.slice(2));
