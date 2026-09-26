#!/usr/bin/env node
/**
 * L38 · 过半闸：没过半不许说「多数」，而且**分母不许被票记录缩小**
 *
 * 回归来源（2026-09-24，「审查」实测出三件事，P-M1 刚落地就被打脸；P-M2 修）：
 *
 *   ① **过半闸在 `rule:` 路径上是装饰**。P-M1 给 `tallyVotes` 加了闸，`vote --topic` 会印
 *      「未决·分歧（…未过半…）」exit 1，但 `ruleUnresolved` / `advanceRule` / `pendingRuleAdvances`
 *      都不认它 ⇒ 同一批票，`rule status` 照旧写「未决原因：（没有）」+「推进：多数：同意 → 可以定稿」，
 *      `advanceRule` 照旧**落盘成「试行」**。落盘证据是最狠的一条：
 *      RULES.jsonl 末条**同一条记录里同时写着** `"status":"试行"` 与
 *      `"transition":{"tally":"未决·分歧（…未过半…）"}` —— 机制自己记下了"未决"，却照样通电。
 *
 *   ② **分母可以被一条票记录直接改小**（两条实测路）：
 *      路 A：7 票 A=2/B=1/…，只在**最早那条**记录里手写 `roster:["监督员","审查"]` ⇒ 分母 2 ⇒ `2/2` ⇒ `多数：A`；
 *      路 B：只把 `at` 提前到 2026-09-01（不碰 roster）⇒ 按加入时刻推出 5 席 ⇒ `A=3/7` 按 `3/5` 算 ⇒ 又变成 `多数：A`。
 *      两条路形状相同：**分母被缩到比"实际投了票的在册席位"还小** ⇒ 一张票当两票用。
 *
 *   ③ **P-M2b：上面两条**合并着走**还能通**（审查 2026-09-24 造的反例；路 A / 路 B 都各用 7 票，
 *      所以覆盖不到它）：`rule propose R904` 后**手写** 3 条票（`at` 提前到 2026-09-01、
 *      **首条带 `roster:[那 3 席]`**），其余 4 席**一票不投** ⇒
 *      `_inferred` 按首票时刻推 = 5，`roster` 被手写成 3 ⇒ `missing=0` ⇒ `3 > 5/2` ⇒
 *      `多数：同意` exit 0、`rule status` **落盘成「试行」**。⇒ 洞要**两条腿同时用**。
 *
 * 判据（全部黑盒：只 `spawn` warden、读 stdout / 退出码 / 台账；夹具在 %TEMP% 沙箱里）：
 *   负控 7 席 A=2/…（非 A 票全部被别人 `--address`）→ **必须**「未决·分歧」且 exit 1
 *   正控 7 席全投同意 → **必须**「多数：同意」exit 0（闸不许焊死）
 *   负控 分母洞·路 A（手写小名单）→ 不许出现「多数：」，exit 1
 *   负控 分母洞·路 B（只改 `at`）→ 不许出现「多数：」，exit 1
 *   正控 老议题（首票早于新席位加入、只投老 5 席）→ **仍然**是「多数：同意」（加席位**不追溯**）
 *   说明 分母被抬高时**要打出来**（"应到名单"与"过半闸分母"为什么不是同一个数）
 *   负控 规则路径：`rule:R9@1`（3 同意/2 反对/2 弃权）→ `rule status` exit 1、未决原因写明「未过半」、
 *        **RULES.jsonl 里不许出现「试行」**、`vote cast` 的「规则册联动」行说未决
 *   正控 规则路径：另一条规则 7/7 干净同意 → 照旧推进到「试行」
 *   负控 `check`：未过半的规则**不许**被报成"票已齐、待推进"
 *   正控 `check`：真·过半且停在提案的规则**要**被报成"待推进"（证明上一条不是空跑）
 *   ★ 负控 **残余合并洞**（P-M2b）：`rule:R904@1` 手写 3 席名单 + `at` 提前 ⇒ 未决 exit 1、
 *        根因印成「账目自相矛盾（票的时刻早于规则进册时刻）」、**RULES.jsonl 里不许出现「试行」**
 *   ★ 正控 对照①：同一夹具 `at` 改回现在 ⇒ **仍然**未决（这一支拦住它的是"应到下限"，不是时间矛盾）
 *   ★ 正控 对照②：`at` 提前但**不手写 roster**、只投 3 席 ⇒ 缺席·未决
 *   ★ 正控 同一形状的干净 7/7（`at` 落在规则进册之后）⇒ 照旧推进到「试行」（新判据没把闸焊死）
 *
 * ★★ **P-M3 补（2026-09-24，「审查」在 P-M2b 复验里留下的 3 条非阻断待办，每条都有原样输出）**：
 *   ★ 负控(A6) `run-all --only L99_不存在`（**一个实验都不存在**）⇒ **exit 2**，并列出你找过的名字；
 *        实测原样（修前）：`PASS 0 · FAIL 0 · SKIP 0` + `总退出码 0：0 个 PASS` + **exit 0** ——
 *        "没查到东西"被当成了"跑完了、没问题"（A6 在实验台上的复发）。
 *   ★ 正控(A6) `--only L32`（在册）⇒ exit 0 且那个实验真跑到（闸不许焊死）；
 *   ★ 负控(A6) 点名 3 个只找到 1 个 ⇒ **照旧跑**（exit 0），但缺的那个**必须显式报出来**（不许静默丢）。
 *   ★ 负控 ③ **一条"根本不是票"的手写早期记录不许冻住一份干净的 7/7**：
 *        `_firstAt`（判据⑤与 `_inferred` 都由它推）原来取**该 topic 全部记录**的 `at` 最小值，
 *        **含 `outsiders`**（无票席位 `AI测试用户`、名字写错的角色）⇒ 实测：干净 7/7（票都在规则进册之后）
 *        本来是「多数：同意」exit 0、落「试行」，**再手写一条 `AI测试用户` 的早期记录**就变成
 *        「未决·账目自相矛盾」、`rule status` exit 1、**永久提案**（写错名字的 `审查员` 同理）。
 *        现在 `_firstAt` 与 `_voted` 同口径（**只认有票席位**）。
 *   ★ 正控 ③ 同一形状的干净 7/7（没有任何外人记录）⇒ 照旧「多数：同意」exit 0 + 落「试行」。
 *   ★ 正控 ③ 同一形状，但那条早期记录来自**在册席位** ⇒ **仍然**是「未决·账目自相矛盾」——
 *        证明收窄只排除了"不是票"的记录，**没有**把判据⑤整个删掉。
 *   ★ 回归 ③ R904 那条夹具原样（3 条**在册席位**的早票 + 首条手写小名单）⇒ **仍被拦住**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { provision, readJsonl, runWarden, runNode, makeCtx, grab } from './common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const QUOTE = '没过半就不许说"多数"；也不许靠手写一份名单、或改一个时间戳，把分母改小。';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 过半闸：没过半不许说"多数"，分母不许被票记录缩小
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 7 票投 A=2 就能宣布"多数"；2/7 也照样被写进 RULES.jsonl 成「试行」
- 必须: 没过半 ⇒ 「未决·分歧」+ exit 1；规则路径不许落盘成「试行」；分母只许变大不许变小
- 不要: 让手写的 roster 字段或改过的 at 时间戳把分母改小，也别把闸焊死到老议题上
- 锁定: 2026-09-24
`;

const R_YES = '这条我同意：理由落在本角色的职责范围内，长度也够';
const R_NO = '我反对：这会丢掉用户逐字说过的那句话，风险没人回应，我不改。';
const R_ABS = '我弃权：这一条我看不出该由我这一席来判，理由写在这里也够长。';
const R_FIX = '夹具票：理由长度足够（这是夹具，不是被测行为）。';

/** 新席位（资料员 / 方向员）加入之前的时刻 —— 与 warden.mjs 里 `SEAT_ADDED_AT` 的语义一致 */
const OLD_AT = '2026-09-01T00:00:00.000Z';

/** 直接往台账里追加一条票（精确控制 `at` / `roster` —— 夹具不是被测行为；L15 也是这么伪造老票的） */
function appendVote(wdir, rec) {
  fs.appendFileSync(path.join(wdir, 'VOTES.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
}

function resetVotes(wdir) {
  fs.writeFileSync(path.join(wdir, 'VOTES.jsonl'), '', 'utf8');
}

/** 从 `vote --topic X` 输出里读回结果与退出码 */
function voteState(run, topic) {
  const r = run(['vote', '--topic', topic]);
  const m = /结果：\*\*(.+?)\*\*/.exec(r.stdout);
  return { code: r.code, state: m ? m[1] : '(没打出结果)', out: r.stdout };
}

/** 从 `vote --topic X` 输出里读回**应到名单**（黑盒，不 import 内部常量） */
function rosterOf(run, topic) {
  const seen = [];
  for (const line of run(['vote', '--topic', topic]).stdout.split(/\r?\n/)) {
    const m = /^\s{2}(\S+?)\s+【职责】/.exec(line);
    if (m) seen.push(m[1]);
  }
  return seen;
}

/**
 * 造一批"多选项、最高票不过半"的票（默认 A=2 / B..F 各 1）；
 * **非 A 的票全部被别人 `--address` 回应过** ⇒ `unaddressed` 为空 ⇒
 * 判据只可能卡在"过半"这一条上（否则这个夹具会"因为错的原因"通过）。
 */
function spreadFixture(wdir, topic, roles, { at = null, rosterOnFirst = null, choices = null } = {}) {
  const pick = choices ?? ['A', 'A', 'B', 'C', 'D', 'E', 'F'];
  const others = roles.filter((_, i) => pick[i] !== 'A');
  const t0 = Date.now() - 3600_000;
  roles.forEach((role, i) => {
    const rec = {
      at: at ?? new Date(t0 + i * 1000).toISOString(),
      topic, role, choice: pick[i],
      reason: R_FIX,
      address: pick[i] === 'A' ? others.join(',') : '',
    };
    if (i === 0 && rosterOnFirst) rec.roster = rosterOnFirst;
    appendVote(wdir, rec);
  });
}

/** 规则册里某条规则的**最新**状态（读台账，不看 stdout） */
function ruleStatusOf(wdir, id) {
  const rows = readJsonl(path.join(wdir, 'RULES.jsonl'));
  const recs = rows.filter((r) => r && r.id === id && r.kind !== 'revision' && r.status);
  return recs.length ? recs[recs.length - 1].status : null;
}

export default async function run() {
  const c = makeCtx('L38', '过半闸：没过半不许说「多数」，分母不许被票记录缩小');
  const sb = provision('L38_majority_gate', spec('session-lab-L38_majority_gate'));
  const run = (args) => runWarden(sb.dir, args, { sessionId: sb.sessionId });
  resetVotes(sb.wdir);

  // ---------- 前置：应到名单从 warden 现读（**不许在用例里写死 7**，写死就跟着机制过期）
  const all = rosterOf(run, '(还没有的议题)');
  c.check('前置 · 应到名单从 CLI 现读，且 ≥6 席（过半闸才有分母可言）',
    all.length >= 6,
    `应到 ${all.length} 席：${all.join('、')}`);
  if (all.length < 6) {
    return { id: c.id, name: c.name, status: 'FAIL', pass: false, reason: '读不到应到名单，实验无法进行', checks: c.checks, skipped: c.skipped };
  }

  // ---------- 负控①：过半闸 —— 7 席 A=2/…（非 A 票全被别人回应）⇒ 必须「未决·分歧」exit 1
  spreadFixture(sb.wdir, '过半闸·负控', all);
  const half = voteState(run, '过半闸·负控');
  c.check('负控 · 过半闸：7 席最高票只有 2 票（非同意票全部被别人回应过）→ **必须**「未决·分歧」exit 1',
    half.code === 1 && /未决·分歧/.test(half.state) && /未过半/.test(half.state) && /2\/7/.test(half.state),
    `结果=「${half.state}」（exit=${half.code}）`);
  c.check('负控 · 闸门不许被"异议已回应"绕开：这个夹具里 `unaddressed` 确实是空的（否则它是"因为错的原因"通过）',
    !/异议未回应/.test(half.out) && !/缺席/.test(half.state) && !/平票/.test(half.state),
    grab(half.out, [/计票：/, /结果：/], 2).join(' | ') || '（没打出相关行）');

  // ---------- 正控①：7 席全同意 ⇒ 必须「多数：同意」exit 0（闸不许焊死）
  for (const role of all) run(['vote', 'cast', '--topic', '过半闸·正控', '--role', role, '--choice', '同意', '--reason', R_YES]);
  const full = voteState(run, '过半闸·正控');
  c.check('正控 · 7 席全投同意 → **必须**「多数：同意」exit 0（闸不许焊死）',
    full.code === 0 && /多数：同意/.test(full.state) && !/未过半/.test(full.state),
    `结果=「${full.state}」（exit=${full.code}）`);

  // ---------- 负控②：分母洞·路 A —— 只在最早那条记录里手写 roster:["监督员","审查"]
  spreadFixture(sb.wdir, '分母洞·路A', all, { rosterOnFirst: all.slice(0, 2) });
  const pathA = voteState(run, '分母洞·路A');
  c.check('负控 · 分母洞·路 A（最早那条记录手写 roster=2 席）→ **不许**出现「多数：」，必须 exit 1',
    pathA.code === 1 && !/多数：/.test(pathA.state) && /未决·分歧/.test(pathA.state) && /2\/7/.test(pathA.state),
    `结果=「${pathA.state}」（exit=${pathA.code}）`);

  // ---------- 负控③：分母洞·路 B —— 只把 at 提前到新席位加入之前（不碰 roster）
  //    票是 3 票 A + 4 票别的（A=3/7），跟实测那条"3/7 被当成 3/5"一致
  spreadFixture(sb.wdir, '分母洞·路B', all, { at: OLD_AT, choices: ['A', 'A', 'A', 'B', 'B', 'C', 'C'] });
  const pathB = voteState(run, '分母洞·路B');
  c.check('负控 · 分母洞·路 B（只把 at 提前到 2026-09-01，不碰 roster）→ **不许**出现「多数：」，必须 exit 1',
    pathB.code === 1 && !/多数：/.test(pathB.state) && /未决·分歧/.test(pathB.state) && /3\/7/.test(pathB.state),
    `结果=「${pathB.state}」（exit=${pathB.code}）`);
  c.check('负控 · 路 B 的根因写清了：分母**不是**按加入时刻推出的 5 席（7 席都投了票，就都算应到）',
    /\/7/.test(pathB.state) && !/\/5/.test(pathB.state),
    `结果=「${pathB.state}」`);

  // ---------- 正控②：老议题**不许**被追溯卡死 —— 首票早于新席位加入、只投老 5 席 ⇒ 3/5 仍是多数
  {
    const old5 = all.filter((r) => r !== '资料员' && r !== '方向员');
    const topic = '老议题·不追溯';
    const choices = ['同意', '同意', '同意', '反对', '弃权'];
    old5.forEach((role, i) => appendVote(sb.wdir, {
      at: OLD_AT, topic, role, choice: choices[i], reason: R_FIX,
      address: choices[i] === '同意' ? old5.filter((_, j) => choices[j] !== '同意').join(',') : '',
    }));
    const oldT = voteState(run, topic);
    c.check('正控 · 老议题（首票早于新席位加入，只投老 5 席）→ 3/5 **仍然是「多数：同意」**（加席位不追溯）',
      oldT.code === 0 && /多数：同意/.test(oldT.state) && !/未过半/.test(oldT.state) && !/缺席/.test(oldT.state),
      `结果=「${oldT.state}」（exit=${oldT.code}）；应到 ${old5.length} 席`);
  }

  // ---------- 说明：分母被抬高时**要说出来**（"应到名单"与"过半闸分母"为什么不是同一个数）
  {
    const old5 = all.filter((r) => r !== '资料员' && r !== '方向员');
    const topic = '分母抬高·说明';
    for (const role of old5) appendVote(sb.wdir, {
      at: new Date(Date.now() - 1800_000).toISOString(), topic, role, choice: '同意', reason: R_FIX, roster: old5,
    });
    const lifted = voteState(run, topic);
    c.check('说明 · 票里记了 5 席名单、但今天在册 7 席 → 过半闸分母抬到 7，且**打出来**（不是偷偷改数）',
      lifted.code === 0 && /多数：同意/.test(lifted.state) && /过半闸的分母是 7/.test(lifted.out) && /应到名单只有 5 席/.test(lifted.out),
      `结果=「${lifted.state}」（exit=${lifted.code}）；${grab(lifted.out, [/过半闸的分母/], 1).join('').slice(0, 200) || '（没打出来）'}`);
  }

  // ---------- 规则路径 · 负控：rule:R9@1（3 同意 / 2 反对 / 2 弃权，4 张非同意票均被别人 address）
  const prop = run(['rule', 'propose', '--id', 'R9', '--text', '过半闸必须接进 rule 路径：未过半不许落盘成试行。',
    '--evidence', 'L15 实测：加席位不许追溯卡死老议题', '--enforced', 'code']);
  c.check('前置 · 规则 R9 提进册（证据指到 lab 里的 L15）',
    prop.code === 0 && ruleStatusOf(sb.wdir, 'R9') === '提案',
    `exit=${prop.code}；${grab(prop.stdout, [/收进规则册/], 1).join('')}`);

  const R9_TOPIC = 'rule:R9@1';
  const r9Votes = [
    ['监督员', '同意', R_YES, all.filter((r) => r !== '监督员').slice(2).join(',')],
    ['审查', '同意', R_YES, ''],
    ['记录', '同意', R_YES, ''],
    ['支线守门员', '反对', R_NO, ''],
    ['提问闸门', '反对', R_NO, ''],
    ['资料员', '弃权', R_ABS, ''],
    ['方向员', '弃权', R_ABS, ''],
  ];
  let lastCast = null;
  for (const [role, choice, reason, address] of r9Votes) {
    const args = ['vote', 'cast', '--topic', R9_TOPIC, '--role', role, '--choice', choice, '--reason', reason];
    if (address) args.push('--address', address);
    lastCast = run(args);
  }
  const r9Vote = voteState(run, R9_TOPIC);
  const st9 = run(['rule', 'status', '--id', 'R9']);

  c.check('负控 · `rule:R9@1`（3 同意/2 反对/2 弃权）→ `vote --topic` 是「未决·分歧」exit 1（P-M1 的闸本来就在）',
    r9Vote.code === 1 && /未决·分歧/.test(r9Vote.state) && /3\/7/.test(r9Vote.state),
    `结果=「${r9Vote.state}」（exit=${r9Vote.code}）`);
  c.check('负控 · **`rule status` 的「未决原因」行必须说清是「未过半」**（原来这里写的是"（没有）"——打脸那条）',
    st9.code === 1 && /未决原因：/.test(st9.stdout) && /未过半/.test(st9.stdout) && !/未决原因：（没有/.test(st9.stdout),
    grab(st9.stdout, [/未决原因：/, /推进：/], 2).join(' | ') || '（没打出相关行）');
  c.check('负控 · **不许落盘成「试行」**：RULES.jsonl 里 R9 的最新状态仍是「提案」，且一条「试行」记录都没有',
    ruleStatusOf(sb.wdir, 'R9') === '提案'
      && !readJsonl(path.join(sb.wdir, 'RULES.jsonl')).some((r) => r && r.id === 'R9' && r.status === '试行'),
    `RULES.jsonl 里 R9 最新状态=「${ruleStatusOf(sb.wdir, 'R9')}」；输出里的"现在的状态"行=${grab(st9.stdout, [/现在的状态/], 1).join('') || '（没有，说明没写回）'}`);
  c.check('负控 · `vote cast` 的「规则册联动」行也说未决（不是"推进到 试行"）',
    lastCast !== null && /规则册联动（R9）：未决/.test(lastCast.stdout) && !/现在的状态/.test(lastCast.stdout),
    grab(lastCast ? lastCast.stdout : '', [/规则册联动/], 1).join('') || '（没打出来）');

  // ---------- 规则路径 · 正控：另一条规则 7/7 干净同意 → 照旧推进到「试行」（闸不许焊死）
  const prop2 = run(['rule', 'propose', '--id', 'R902', '--text', '实验台的每个实验都要能机械判定通过/失败。',
    '--evidence', 'L1 实测：未申报的替代品被 check exit 1 拦下', '--enforced', 'code']);
  for (const role of all) run(['vote', 'cast', '--topic', 'rule:R902@1', '--role', role, '--choice', '同意', '--reason', R_YES]);
  const st902 = run(['rule', 'status', '--id', 'R902']);
  c.check('正控 · 另一条规则 7/7 干净同意 → 照旧推进到「试行」（不是"永远推不动"）',
    prop2.code === 0 && ruleStatusOf(sb.wdir, 'R902') === '试行' && st902.code === 0,
    `R902 状态=「${ruleStatusOf(sb.wdir, 'R902')}」；rule status exit=${st902.code}`);

  // ---------- check：未过半的规则不许被报成"待推进"；真·过半且停在提案的**要**被报成"待推进"
  {
    /**
     * ⚠ 这个负控**必须用一个"停在提案"的未过半规则**（R903），不能拿 R9 顶：
     *   R9 是走 CLI 投的票，`vote cast` 会顺手调 `advanceRule` —— 在**没修**的版本里它已经被
     *   落盘成「试行」了，于是 `pendingRuleAdvances`（只看 `提案`）自然不提它，
     *   负控就会"因为错的原因"通过（空跑）。所以另造一条**手写票**的 R903：
     *   不走 CLI ⇒ 状态停在「提案」⇒ 才真正压在 `pendingRuleAdvances` 上。
     */
    run(['rule', 'propose', '--id', 'R903', '--text', '过半闸的判据要能复算，分母不许被单条记录缩小。',
      '--evidence', 'L15 实测：加席位不许追溯卡死老议题', '--enforced', 'code']);
    /**
     * ⚠ **P-M2b 改夹具的 `at`（不是放宽判据）**：原来这里用默认的 `at`（1 小时前），
     *   而 R903 是**刚刚**才提进册的 ⇒ 在新判据⑤下这份账**自己就自相矛盾**（票早于规则），
     *   负控会"因为错的原因"通过（它想压的是"未过半 ⇒ 不许报待推进"）。
     *   夹具必须是**账目自洽**的：票的时刻落在规则进册之后，判据⑤才不插手。
     */
    spreadFixture(sb.wdir, 'rule:R903@1', all, { at: new Date().toISOString() });   // A=2/7，票收齐、无缺席、异议都被别人回应过

    // 正控夹具：手写 7 张干净同意（不走 CLI ⇒ 不会触发 advanceRule ⇒ 状态停在「提案」）
    run(['rule', 'propose', '--id', 'R901', '--text', '过半闸的判据要能复算，分母不许被单条记录缩小。',
      '--evidence', 'L15 实测：加席位不许追溯卡死老议题', '--enforced', 'code']);
    // ⚠ 同上：`at` 必须晚于 R901 的进册时刻（原来写 `now-600s` ⇒ 在新判据⑤下自相矛盾）
    for (const role of all) appendVote(sb.wdir, {
      at: new Date().toISOString(), topic: 'rule:R901@1', role, choice: '同意', reason: R_FIX,
    });
    const chk = run(['check']);
    const pendingLines = chk.stdout.split(/\r?\n/).filter((l) => /待推进/.test(l));
    c.check('负控 · `check` **不许**把未过半的规则报成"票已齐、待推进"（R9 已推进的不算，这里压的是停在「提案」的 R903）',
      pendingLines.length > 0 && !pendingLines.some((l) => /\bR9\b/.test(l) || /R903/.test(l)),
      pendingLines.join(' | ').slice(0, 300) || '（一行"待推进"都没有 —— 说明这条检查是空跑）');
    c.check('正控 · 真·过半且停在「提案」的 R901 **要**被报成"待推进"（证明上一条不是空跑）',
      pendingLines.some((l) => /R901/.test(l)),
      pendingLines.join(' | ').slice(0, 300) || '（没打出来）');
  }

  // ---------- ★ P-M2b · **残余合并洞**：手写小名单 + 把 `at` 提前，两条腿**同时**用
  /**
   * 审查 2026-09-24 造的反例（原样输出见任务书；路 A / 路 B 都各用 7 票 ⇒ 上面那些用例**覆盖不到**这条）：
   *   `rule propose R904` 之后**手写** 3 条票（监督员/审查/记录 全同意，`at` 提前到 2026-09-01，
   *   **首条带 `roster:[那 3 席]`**），其余 4 席**一票不投** ⇒
   *   P-M2 当时输出 `结果：**多数：同意**` exit 0，`rule status` **落盘成「试行」**。
   *   根因：`_inferred` 按首票时刻推 = 5（保 L15 不追溯，这个数没错），而 `roster` 被手写成 3
   *   ⇒ `missing = 0`（缺席闸被同一条记录清零）⇒ `3 > 5/2` ⇒ 多数。
   *
   * 判据（P-M2b，两条一起用）：
   *   ③ 规则议题的**应到名单**不许低于"该规则进册那一刻的在册席位"（下限取自 RULES.jsonl + 注册表）；
   *   ⑤ 票的时刻**早于**规则进册时刻 ⇒ 账目自相矛盾 ⇒ 一律未决（审查给的可机检判据）。
   *
   * ⚠ 这一组放在**最后**：它要 `resetVotes` 把台账清干净（否则前面那些夹具的票会串进来），
   *   而前面所有断言此时都已经跑完，清掉不影响它们。
   */
  {
    resetVotes(sb.wdir);
    const three = all.slice(0, 3);          // 从 CLI 现读的应到名单里取前 3 席（**不写死名字**，名单变了也不假红）
    const handVotes = (topic, { at, roster = null }) => {
      three.forEach((role, i) => {
        const rec = { at, topic, role, choice: '同意', reason: R_FIX };
        if (i === 0 && roster) rec.roster = roster;
        appendVote(sb.wdir, rec);
      });
    };
    const propose = (id) => run(['rule', 'propose', '--id', id,
      '--text', `过半闸的账目下限（${id}）：应到名单不许低于规则进册那一刻的在册席位。`,
      '--evidence', 'L15 实测：加席位不许追溯卡死老议题', '--enforced', 'code']);

    // ---- 负控④：审查那条夹具，**原样**（3 票、`at` 提前、首条手写 roster=那 3 席）
    propose('R904');
    handVotes('rule:R904@1', { at: OLD_AT, roster: three });
    const v904 = voteState(run, 'rule:R904@1');
    const st904 = run(['rule', 'status', '--id', 'R904']);
    c.check('负控 · 残余合并洞（手写 3 席名单 + `at` 提前到 2026-09-01，其余 4 席不投）→ **必须**未决 exit 1、**不许**出现「多数：」',
      v904.code === 1 && /未决/.test(v904.state) && !/多数：/.test(v904.state),
      `结果=「${v904.state}」（exit=${v904.code}）`);
    c.check('负控 · 根因（审查给的可机检判据）：票的时刻早于规则进册时刻 ⇒ 账目自相矛盾，必须印出来（RULES.jsonl 的 at vs 票声称的 at）',
      /账目自相矛盾/.test(v904.out) && /2026-09-01/.test(v904.out) && /早于/.test(v904.out),
      grab(v904.out, [/账目自相矛盾/], 1).join('').slice(0, 260) || '（没打出来）');
    c.check('负控 · 应到名单被补回"规则进册那一刻的在册席位"（缺席闸不再被一条记录清零）⇒ 缺席·未决',
      /缺席·未决/.test(v904.state) && /缺席：/.test(st904.stdout),
      `结果=「${v904.state}」；${grab(st904.stdout, [/未决原因：/], 1).join('')}`);
    c.check('负控 · **不许落盘成「试行」**：RULES.jsonl 里 R904 最新状态仍是「提案」，且一条「试行」记录都没有',
      ruleStatusOf(sb.wdir, 'R904') === '提案'
        && !readJsonl(path.join(sb.wdir, 'RULES.jsonl')).some((r) => r && r.id === 'R904' && r.status === '试行'),
      `RULES.jsonl 里 R904 最新状态=「${ruleStatusOf(sb.wdir, 'R904')}」；rule status exit=${st904.code}；`
        + `"现在的状态"行=${grab(st904.stdout, [/现在的状态/], 1).join('') || '（没有，说明没写回）'}`);

    // ---- 正控③（审查的对照①）：同一夹具把 `at` 改回**现在** ⇒ **仍然**未决
    //      这一支**没有**自相矛盾（`at` 没问题）⇒ 拦住它的是判据③的下限（应到名单被补回 7 席）
    resetVotes(sb.wdir);
    propose('R905');
    handVotes('rule:R905@1', { at: new Date().toISOString(), roster: three });
    const v905 = voteState(run, 'rule:R905@1');
    c.check('正控 · 同一夹具把 `at` 改回现在 → **仍然**未决 exit 1（两条腿缺一条也拦得住）',
      v905.code === 1 && /未决/.test(v905.state) && !/多数：/.test(v905.state),
      `结果=「${v905.state}」（exit=${v905.code}）`);
    c.check('正控 · 这一支的原因**不是**"账目自相矛盾"（`at` 是干净的），而是判据③把应到名单补回 7 席 ⇒ 缺席',
      !/账目自相矛盾/.test(v905.state) && /缺席/.test(v905.state),
      `结果=「${v905.state}」`);

    // ---- 正控④（审查的对照②）：`at` 提前但**不手写 roster**、只投 3 席 ⇒ 缺席·未决
    resetVotes(sb.wdir);
    propose('R906');
    handVotes('rule:R906@1', { at: OLD_AT });
    const v906 = voteState(run, 'rule:R906@1');
    c.check('正控 · `at` 提前但**不手写 roster**、只投 3 席 → **缺席·未决**（对照②：这条在 P-M2 里本来就拦得住）',
      v906.code === 1 && /缺席·未决/.test(v906.state) && !/多数：/.test(v906.state),
      `结果=「${v906.state}」（exit=${v906.code}）`);

    // ---- 正控⑤：同一形状的**干净** 7 席全同意（`at` 落在规则进册之后）⇒ 照旧推进到「试行」
    //      证明上面四条不是"把闸焊死在所有规则议题上"（闸不许焊死）
    resetVotes(sb.wdir);
    propose('R907');
    for (const role of all) appendVote(sb.wdir, {
      at: new Date().toISOString(), topic: 'rule:R907@1', role, choice: '同意', reason: R_FIX,
    });
    const st907 = run(['rule', 'status', '--id', 'R907']);
    c.check('正控 · 干净 7/7 同意（票都在规则进册之后）→ 照旧推进到「试行」（新判据没把闸焊死）',
      st907.code === 0 && ruleStatusOf(sb.wdir, 'R907') === '试行',
      `R907 状态=「${ruleStatusOf(sb.wdir, 'R907')}」；rule status exit=${st907.code}`);
  }

  // ============ ★ P-M3 新增（2026-09-24）：「审查」在 P-M2b 复验里留的 3 条非阻断待办 ============
  /**
   * 三条待办（每条都有原样输出；摘要见本文件开头那段 ★★）：
   *   ① `run-all --only <不存在的实验>` 空跑报绿（**A6 病**）—— 修前 `--only L99_不存在` ⇒ PASS 0/FAIL 0/SKIP 0 + **exit 0**；
   *   ③ 判据⑤ 的 `_firstAt` 原来取**该 topic 全部记录**的 `at` 最小值（**含 `outsiders`**）⇒
   *      一条**根本不是票**的手写早期记录就能把一份干净的 7/7 从"推进试行"冻成"永久提案"；
   *   ④ ⑥ 分支的建议①（"把票重新投一次"）**按字面跑不通**（`VOTES.jsonl` append-only）——
   *      现在那一支按 A6 明写「这是不可满足的未决」，并明写"手改 VOTES.jsonl 不算合法出路"。
   * 全部**真跑子进程**（`runNode` 跑 run-all、`runWarden` 跑 warden），正负控成对。
   */
  {
    // ---------- (a) A6：`--only` 点名的实验一个都不存在 ⇒ exit 2；在册的照旧跑；缺的那个必须报出来
    const RUN_ALL = path.join(HERE, 'run-all.mjs');
    const none = runNode(HERE, RUN_ALL, ['--only', 'L99_不存在']);
    c.check('负控(A6) · `run-all --only L99_不存在`（点名的实验**一个都不存在**）→ **必须 exit 2**，且把你找过的名字列出来',
      none.code === 2 && /一个都没找到/.test(none.stdout) && /L99_不存在/.test(none.stdout) && /总退出码 2/.test(none.stdout),
      `exit=${none.code}；${grab(none.stdout, [/一个都没找到/, /总退出码/], 2).join(' | ') || '（没打出来）'}`);

    const okOne = runNode(HERE, RUN_ALL, ['--only', 'L32']);
    c.check('正控(A6) · `run-all --only L32`（在册）→ exit 0，且那个实验**真的跑到了**（闸不许焊死）',
      okOne.code === 0 && /\[L32\]/.test(okOne.stdout) && /PASS 1/.test(okOne.stdout) && !/一个都没找到/.test(okOne.stdout),
      `exit=${okOne.code}；${grab(okOne.stdout, [/^\[L32\]/, /PASS 1/], 2).join(' | ') || '（没打出来）'}`);

    const partial = runNode(HERE, RUN_ALL, ['--only', 'L32,L99_不存在,L88_也没有这个']);
    c.check('负控(A6) · 点名 3 个只找到 1 个 ⇒ **照旧跑**（exit 0），但缺的那 2 个**必须显式报出来**（不许静默丢掉）',
      partial.code === 0 && /\[L32\]/.test(partial.stdout) && /不在册/.test(partial.stdout)
        && /L99_不存在/.test(partial.stdout) && /L88_也没有这个/.test(partial.stdout),
      `exit=${partial.code}；${grab(partial.stdout, [/不在册/, /没跑/], 2).join(' | ') || '（没打出来）'}`);

    // ---------- (b) 待办③：`_firstAt` 与 `_voted` 同口径（只认**有票席位**）⇒ 不是票的记录不许冻住干净的 7/7
    /**
     * 夹具形状（**与审查的 outsider.mjs 同形**）：
     *   `rule propose` → **手写** 7 张干净同意（`at` = 现在，落在规则进册之后）→
     *   **再追加一条早期记录**（`at` = 2026-09-01），那条记录的角色是：
     *     · 无票席位 `AI测试用户`（注册表里 `vote:false`）→ **不是票**，不许改变结论；
     *     · 写错名字的 `审查员`（真席位叫 `审查`）      → **不是票**，不许改变结论；
     *     · **在册席位**（`all[0]`，真名）              → **是票**，判据⑤ 照旧要拦（**不许放宽**）。
     *   7 票全部**手写**（不走 `vote cast`）⇒ 不会触发 `advanceRule`，状态停在「提案」，
     *   于是后面那次 `rule status` 就是"这份账到底能不能推进"的**干净读数**。
     */
    const clean7 = (id) => {
      resetVotes(sb.wdir);
      run(['rule', 'propose', '--id', id,
        '--text', `过半闸的判据不许被"根本不是票"的记录冻住（${id}）。`,
        '--evidence', 'L15 实测：加席位不许追溯卡死老议题', '--enforced', 'code']);
      for (const role of all) {
        appendVote(sb.wdir, { at: new Date().toISOString(), topic: `rule:${id}@1`, role, choice: '同意', reason: R_FIX });
      }
    };
    const early = (id, role) => appendVote(sb.wdir, {
      at: OLD_AT, topic: `rule:${id}@1`, role, choice: '同意', reason: '一条根本不是票的手写早期记录（夹具）。',
    });

    // 负控 ③-a：**无票席位** `AI测试用户` 的早期记录
    clean7('R910');
    early('R910', 'AI测试用户');
    const v910 = voteState(run, 'rule:R910@1');
    const st910 = run(['rule', 'status', '--id', 'R910']);
    c.check('负控③ · 一条**无票席位**（AI测试用户）的手写早期记录 ⇒ **不许**冻住这份干净的 7/7：仍「多数：同意」exit 0、不含"账目自相矛盾"、且照旧推进到「试行」',
      v910.code === 0 && /多数：同意/.test(v910.state) && !/账目自相矛盾/.test(v910.out)
        && st910.code === 0 && ruleStatusOf(sb.wdir, 'R910') === '试行',
      `结果=「${v910.state}」（exit=${v910.code}）；R910 状态=「${ruleStatusOf(sb.wdir, 'R910')}」；rule status exit=${st910.code}；`
        + `无权席位那一行=${grab(v910.out, [/无权席位已出声/], 1).join('') || '（没打出来 —— 出声也不许被吞）'}`);

    // 负控 ③-b：**写错名字**的角色（`审查员`，真席位是 `审查`）的早期记录
    clean7('R912');
    early('R912', '审查员');
    const v912 = voteState(run, 'rule:R912@1');
    c.check('负控③ · 一条**写错名字**（审查员）的手写早期记录 ⇒ 同上：不许冻住干净的 7/7（名字写错 = 不是票，不许改变结果）',
      v912.code === 0 && /多数：同意/.test(v912.state) && !/账目自相矛盾/.test(v912.out),
      `结果=「${v912.state}」（exit=${v912.code}）`);

    // 正控 ③-a：同一形状的干净 7/7（**没有任何外人记录**）⇒ 照旧「多数：同意」+ 落「试行」
    clean7('R913');
    const v913 = voteState(run, 'rule:R913@1');
    const st913 = run(['rule', 'status', '--id', 'R913']);
    c.check('正控③ · 同一形状的干净 7/7（没有外人记录）⇒ 照旧「多数：同意」exit 0 + 落「试行」（证明上面两条不是"把闸焊死"）',
      v913.code === 0 && /多数：同意/.test(v913.state)
        && st913.code === 0 && ruleStatusOf(sb.wdir, 'R913') === '试行',
      `结果=「${v913.state}」（exit=${v913.code}）；R913 状态=「${ruleStatusOf(sb.wdir, 'R913')}」`);

    // 正控 ③-b（**不许放宽**）：那条早期记录来自**在册席位** ⇒ 判据⑤ 照旧要拦
    clean7('R914');
    early('R914', all[0]);
    const v914 = voteState(run, 'rule:R914@1');
    c.check(`正控③ · 同一形状，但早期记录来自**在册席位**（${all[0]}）⇒ **仍然**「未决·账目自相矛盾」exit 1（收窄只排除"不是票"的记录，判据⑤ 没被删掉）`,
      v914.code === 1 && /未决/.test(v914.state) && /账目自相矛盾/.test(v914.out) && !/多数：/.test(v914.state),
      `结果=「${v914.state}」（exit=${v914.code}）`);

    // 回归 ③：R904 那条夹具**原样**（3 条在册席位的早票 + 首条手写小名单）⇒ 仍被拦住
    resetVotes(sb.wdir);
    run(['rule', 'propose', '--id', 'R911',
      '--text', '过半闸的账目下限（R911）：应到名单不许低于规则进册那一刻的在册席位。',
      '--evidence', 'L15 实测：加席位不许追溯卡死老议题', '--enforced', 'code']);
    {
      const three = all.slice(0, 3);
      three.forEach((role, i) => {
        const rec = { at: OLD_AT, topic: 'rule:R911@1', role, choice: '同意', reason: R_FIX };
        if (i === 0) rec.roster = three;
        appendVote(sb.wdir, rec);
      });
    }
    const v911 = voteState(run, 'rule:R911@1');
    const st911 = run(['rule', 'status', '--id', 'R911']);
    c.check('回归③ · R904 那条夹具**原样**（3 条在册席位的早票 + 首条手写小名单，其余 4 席不投）⇒ **仍被拦住**：未决 exit 1、不许出现「多数：」、RULES.jsonl 不许落「试行」',
      v911.code === 1 && /未决/.test(v911.state) && !/多数：/.test(v911.state)
        && /账目自相矛盾/.test(v911.out) && st911.code === 1 && ruleStatusOf(sb.wdir, 'R911') === '提案'
        && !readJsonl(path.join(sb.wdir, 'RULES.jsonl')).some((r) => r && r.id === 'R911' && r.status === '试行'),
      `结果=「${v911.state}」（exit=${v911.code}）；R911 状态=「${ruleStatusOf(sb.wdir, 'R911')}」；rule status exit=${st911.code}`);

    // ---------- (c) 待办④：⑥ 分支的建议① 不许再被列成"现在就能跑"的命令
    /**
     * 实测（审查的 remedy.mjs）：按建议① 用 `vote cast` 重投那 3 席 ⇒ exit 1、**仍含**"账目自相矛盾"；
     * 7 席全部重投一遍 ⇒ exit 1、**仍含**；而建议②（`rule amend`）⇒ 新议题 exit 0、**不含**。
     * ⇒ 现在那一支按 A6 明写「**这是不可满足的未决**：本议题给不出可跑命令」，
     *   并**明写**"手改 `VOTES.jsonl` 能消失但不算合法出路"；**"重新投一次" 必须被标成跑不通**。
     */
    const v911out = voteState(run, 'rule:R911@1').out;
    c.check('负控④ · ⑥ 分支必须**明写"这一支给不出可跑命令"**（A6），并把"重新投一次"标成**跑不通**（不许再列成可跑命令）',
      /这是不可满足的未决/.test(v911out) && /给不出/.test(v911out)
        && /重新投一次/.test(v911out) && /跑不通/.test(v911out),
      grab(v911out, [/不可满足的未决/, /跑不通/], 2).join(' | ') || '（没打出来）');
    c.check('正控④ · ⑥ 分支仍然给出**唯一真实的那条路**：`rule amend` 换修订号（不是"补一票"）',
      /rule amend/.test(v911out) && /修订号/.test(v911out),
      grab(v911out, [/rule amend/], 1).join('') || '（没打出来）');

    // 正控④（**可跑性**）：真的按那条路走一遍 —— amend 后在新议题上投，**不含**"账目自相矛盾"
    const am = run(['rule', 'amend', '--id', 'R911',
      '--text', '过半闸的账目下限（R911 修订）：应到名单不许低于规则进册那一刻的在册席位。']);
    for (const role of all) run(['vote', 'cast', '--topic', 'rule:R911@2', '--role', role, '--choice', '同意', '--reason', R_YES]);
    const v911b = voteState(run, 'rule:R911@2');
    c.check('正控④ · 按"唯一真实的那条路"走一遍：`rule amend` 换到 `@2` 再投 7 席 ⇒ exit 0、**不含**"账目自相矛盾"（证明那条路真能跑通）',
      am.code === 0 && v911b.code === 0 && !/账目自相矛盾/.test(v911b.out) && /多数：同意/.test(v911b.state),
      `rule amend exit=${am.code}；@2 结果=「${v911b.state}」（exit=${v911b.code}）`);
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '没过半 ⇒ 未决·分歧 exit 1；分母不再被手写 roster 或改过的 at 缩小；rule 路径不再落盘成「试行」，'
        + 'check 也不再把未过半的规则报成"待推进"；**残余合并洞**（手写小名单 + 提前 at）⇒ 账目自相矛盾 + 应到下限 ⇒ 未决、不许落盘；'
        + '同时老议题（3/5）与干净多数（7/7）照旧能推进。'
        + '★ P-M3：`run-all --only <不存在的实验>` ⇒ exit 2（A6），点名缺项逐个报出；'
        + '**不是票**的记录（无票席位 / 名字写错）不许冻住干净的 7/7，而在册席位的早票照旧被拦住（R904 夹具回归）；'
        + '⑥ 分支明写「这是不可满足的未决」并把"重新投一次"标成跑不通，`rule amend` 那条路实测能跑通。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
