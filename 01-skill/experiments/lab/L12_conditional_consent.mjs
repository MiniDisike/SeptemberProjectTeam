#!/usr/bin/env node
/**
 * L12 · 附条件同意实验（票里的条件被吞掉，规则照算通过）
 *
 * 回归来源（真实发生）：一个角色对一批规则投了同意，**每条都附硬边界**，
 * 还写明"否则保留改投反对的权利"；而 `tallyVotes` 原来只认 choice ——
 * **条件被吞掉，规则照算通过**。吞掉条件等于替投票人签字。
 *
 * 判据：
 *   负控  5 张同意票里有 1 张带 `--conditions` → 规则**不许**推进到「试行」，
 *         状态必须是「待并条件」，而且条件要打出来
 *   正控  另一条规则 5 张干净的同意票 → 正常推进到「试行」（不是"永远不推进"）
 *   补救  条件并进正文（`rule amend`）→ 重新投票 → 才能推进到「试行」
 *
 * ⚠ 依赖：`--conditions` 由另一个子代理在 warden.mjs 里实现。实验台**不许改 warden.mjs**。
 *   能力探测：投票时若 CLI 不认 `--conditions`（不打印"条件："），本实验如实报 **SKIP**。
 */
import path from 'node:path';
import { provision, readJsonl, runWarden, makeCtx, grab } from './common.mjs';

const QUOTE = '票里附了条件，条件没并进规则正文之前，这条规则不许当通过。';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 附条件的同意不是干净的同意
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 吞掉条件等于替投票人签字
- 必须: 附条件的票 → 状态停在「待并条件」
- 不要: 把条件丢掉照算通过
- 锁定: 2026-09-16
`;

/**
 * ⚠ 应到名单（roster）：2026-09-17 起投票席位从 5 加到 7（`资料员` / `方向员` 也拿到了票）。
 *   本实验原先只投 5 张票 —— 那个数字**跟着机制一起过期了**：现在 5 票 = 缺席 2 席，
 *   规则根本推不动，负控会"因为错的原因"通过（假通过）。
 *   所以名单**不在这里手写**，从 CLI 的 `vote` 输出里读回 real 应到名单。
 *   （实验台铁律：warden.mjs 是黑盒，不 import 内部常量。）
 */
const ROLE_FALLBACK = [
  { role: '监督员', reason: '原话锚定：这条规则对得上用户的逐字要求，没有违背。' },
  { role: '审查', reason: '证据：论断有实验和事故表支撑，不是自称。' },
  { role: '记录', reason: '事实：口径清楚，数字能复算，没有偷换分母。' },
  { role: '支线守门员', reason: '覆盖面：不会让某条支线被悄悄丢掉，风险可控。' },
  { role: '提问闸门', reason: '用户注意力：这事脚本能自己判，不必占用户的时间。' },
  { role: '资料员', reason: '外部事实：这条不需要查外部资料，我没有额外出处要补。' },
  { role: '方向员', reason: '方向与影响面：不会让工程少掉一条方向，也不动已确认完成的东西。' },
];

function ruleStatusOf(wdir, id) {
  const rows = readJsonl(path.join(wdir, 'RULES.jsonl'));
  const recs = rows.filter((r) => r && r.id === id && r.kind !== 'revision' && r.status);
  return recs.length ? recs[recs.length - 1].status : null;
}

/** 从 `vote --topic X` 的输出里读回应到名单；读不到就退回内置名单（并如实标注） */
function rosterOf(run, topic) {
  const r = run(['vote', '--topic', topic]);
  const seen = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s{2}(\S+?)\s+【职责】/.exec(line);
    if (m) seen.push(m[1]);
  }
  return seen.length ? seen.map((role) => ROLE_FALLBACK.find((x) => x.role === role) ?? { role, reason: `（${role}：本实验没有为它准备专用理由，用它自己的职责写一句。）` }) : null;
}

export default async function run() {
  const c = makeCtx('L12', '附条件同意：条件被吞掉，规则照算通过');
  const sb = provision('L12_conditional_consent', spec('session-lab-L12_conditional_consent'));
  const run = (args) => runWarden(sb.dir, args, { sessionId: sb.sessionId });

  // ---------- 提两条规则（证据指到 lab 里真实存在的实验 L6）
  const propA = run(['rule', 'propose', '--id', 'R901', '--text', '假指控必须能被机器驳回，驳回的要重估那个脑子。',
    '--evidence', 'L6 实测：两条典型冤案被 brain audit 驳回', '--enforced', 'code']);
  const propB = run(['rule', 'propose', '--id', 'R902', '--text', '实验台的每个实验都要能机械判定通过/失败。',
    '--evidence', 'L1 实测：未申报的替代品被 check exit 1 拦下', '--enforced', 'code']);
  c.check('前置 · 两条规则提进规则册（证据指到 lab 里的 L6 / L1）',
    propA.code === 0 && propB.code === 0 && ruleStatusOf(sb.wdir, 'R901') === '提案',
    `R901 exit=${propA.code}；R902 exit=${propB.code}；${grab(propA.stdout, [/收进规则册/], 1).join('')}`);

  // ---------- 应到名单：**不许在实验里写死**（写死就跟着机制过期）
  const roster = rosterOf(run, 'rule:R901@1') ?? ROLE_FALLBACK;
  c.check('前置 · 应到名单从 warden 现读（不是写死的 5 个）',
    roster.length >= 5 && roster.some((x) => x.role === '资料员'),
    `应到 ${roster.length} 席：${roster.map((x) => x.role).join('、')}`);
  const COND_ROLE = '提问闸门';

  // ---------- 负控：干净的同意 + 1 张**附条件**同意
  for (const { role, reason } of roster) {
    if (role === COND_ROLE) continue;
    run(['vote', 'cast', '--topic', 'rule:R901@1', '--role', role, '--choice', '同意', '--reason', reason]);
  }
  const condVote = run(['vote', 'cast', '--topic', 'rule:R901@1', '--role', COND_ROLE, '--choice', '同意',
    '--reason', '用户注意力：这事脚本能自己判，不必占用户的时间，但我要附一条硬边界。',
    '--conditions', '必须先给 L12 配上机械断言，否则我保留改投反对的权利']);
  const hasCond = /条件：/.test(condVote.stdout);
  const stA = run(['rule', 'status', '--id', 'R901']);
  const statusA = ruleStatusOf(sb.wdir, 'R901');

  // ---------- 正控：另一条规则，全部干净同意
  for (const { role, reason } of roster) {
    run(['vote', 'cast', '--topic', 'rule:R902@1', '--role', role, '--choice', '同意', '--reason', reason]);
  }
  const stB = run(['rule', 'status', '--id', 'R902']);
  const statusB = ruleStatusOf(sb.wdir, 'R902');

  // ---------- 补救：条件并进正文 → 重新投票
  const amend = run(['rule', 'amend', '--id', 'R901', '--why', '把提问闸门附的条件并进正文',
    '--text', '假指控必须能被机器驳回，驳回的要重估那个脑子；并且必须先给该规则配上机械断言（L12）。']);
  for (const { role, reason } of roster) {
    run(['vote', 'cast', '--topic', 'rule:R901@2', '--role', role, '--choice', '同意', '--reason', reason]);
  }
  const stC = run(['rule', 'status', '--id', 'R901']);
  const statusC = ruleStatusOf(sb.wdir, 'R901');

  if (!hasCond) {
    c.skip('负控 · 应到票里 1 张附条件 → 状态必须停在「待并条件」，不许推进到「试行」',
      'warden.mjs 的 `vote cast` 还不认 `--conditions`（投票输出里没有"条件："）—— 该功能由另一个子代理实现，实验台不许改 warden.mjs。'
      + `实测：这条规则的状态是「${statusA}」。`);
    c.skip('补救 · 条件并进正文后重新投票才能推进', '同上：`--conditions` / 「待并条件」尚未实现。');
  } else {
    c.check('负控 · 应到票里 1 张附条件 → 状态必须是「待并条件」，**不许**推进到「试行」',
      statusA === '待并条件' && /待并条件/.test(stA.stdout) && !/·\s*试行/.test(stA.stdout),
      `RULES.jsonl 里 R901 的状态=「${statusA}」；输出：${grab(stA.stdout, [/规则 R901/], 1).join('')}`);
    c.check('负控 · 附条件的票被点名打出来（条件没被吞）',
      /附条件|条件：/.test(condVote.stdout) && /保留改投反对/.test(condVote.stdout),
      grab(condVote.stdout, [/条件：/], 1).join(''));
    c.check('补救 · `rule amend` 并入条件后重新投票 → 才推进到「试行」',
      amend.code === 0 && /并入/.test(amend.stdout) && statusC === '试行',
      `amend exit=${amend.code}；R901 状态=「${statusC}」`);
  }

  c.check('正控 · 另一条规则应到票全干净同意 → 正常推进到「试行」（不是"永远不推进"）',
    statusB === '试行' && /·\s*试行/.test(stB.stdout) && stB.code === 0,
    `RULES.jsonl 里 R902 的状态=「${statusB}」；输出：${grab(stB.stdout, [/规则 R902/], 1).join('')}`);

  const ok = c.checks.every((x) => x.ok);
  const status = hasCond ? (ok ? 'PASS' : 'FAIL') : 'SKIP';
  return {
    id: c.id,
    name: c.name,
    status,
    pass: status !== 'FAIL' && ok,
    reason: hasCond
      ? (ok
        ? '附条件的同意确实被拦住（状态「待并条件」），干净票照常推进，并入条件后重投才过 —— 条件没被吞。'
        : '有检查未通过（见下）。')
      : '**SKIP**：`vote cast --conditions` / 「待并条件」由另一个子代理在 warden.mjs 里实现，实测尚未生效（投票输出里没有"条件："）。'
        + '正控（干净票能推进）已通过。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
