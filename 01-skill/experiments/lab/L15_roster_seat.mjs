#!/usr/bin/env node
/**
 * L15 · 加席位不许追溯卡死老议题；没有票的席位不许改变结果、也不许被静默忽略
 *
 * 回归来源（2026-09-17，真实发生）：
 *   ① **加一席 = 分母 +1**：`VOTE_ROLES` 从 5 席加到 7 席之后，
 *      **所有老议题永远差 2 票** ⇒ 全卡「缺席·未决」⇒ 新席位成了**永久否决权**。
 *      「监督员」算出来的代价，不是猜的。
 *   ② 反过来，加完席位**新议题必须要求新席位投票** —— 否则新角色的意见
 *      可以**被静默忽略**（`资料员`/`方向员` 就曾在代码里出现 36 处、却不在投票名单）。
 *   ③ 计票原来是"任何字符串都算一个角色"：名字写错的一票会进 `counts`、甚至翻转 winner；
 *      `AI测试用户`（讨论C 定的**无票**席位）也会被当成普通一票算进去。
 *
 * 判据（全部黑盒：只 `spawn` warden、读 stdout / 退出码 / 台账）：
 *   负控 老议题（首次投票早于新席位加入时刻，票里没记 roster）→ 仍按 **5 席** 计，
 *        **不许**因为新席位而报「缺席·未决」
 *   正控 新议题只投老 5 席 → **必须**报「缺席·未决」并点名少谁（新席位有票，不许被忽略）
 *   正控 新议题投满应到票 → 收齐、能推进
 *   正控 票里**记了 roster** 的老议题 → 以记录的名单为准（哪怕投票时刻晚于新席位加入）
 *   负控 无票席位（`AI测试用户`）投「反对」→ **不许**改变结果，但**必须**被单独列出来
 *   负控 名字写错的角色 → 不许进 counts，单独列出来（出声但不计票）
 */
import fs from 'node:fs';
import path from 'node:path';
import { provision, readJsonl, runWarden, makeCtx, grab } from './common.mjs';

const QUOTE = '加了新角色之后，老议题不能被追溯卡死；没有票的角色也不能改变结果，但它的意见不许被静默忽略。';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 加席位不许追溯卡死老议题
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 分母 +1 会让老议题永远差票 ⇒ 新席位变永久否决权
- 必须: 老议题按当时的在册名单计
- 不要: 让新席位静默改变结果，或让新角色的意见被静默忽略
- 锁定: 2026-09-17
`;

/** 新席位加入之前的时刻（与 warden.mjs 里 SEAT_ADDED 的语义一致：早于它 = 当时还不是席位） */
const BEFORE = '2026-09-16T10:00:00.000Z';
const AFTER = '2026-09-17T02:00:00.000Z';   // 必然晚于任何"加入时刻"

const REASON = '理由落在本角色的职责范围内，长度也够（这条是老的合法票）';

/** 直接往台账里追加一条票（用来伪造"老票"：那时还没有 roster 字段、时刻也更早） */
function appendVote(wdir, rec) {
  fs.appendFileSync(path.join(wdir, 'VOTES.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
}

function voteState(run, topic) {
  const r = run(['vote', '--topic', topic]);
  const m = /结果：\*\*(.+?)\*\*/.exec(r.stdout);
  return { code: r.code, state: m ? m[1] : '(没打出结果)', out: r.stdout };
}

/** 从 `vote --topic X` 输出里读回**应到名单**（黑盒，不 import 内部常量） */
function rosterOf(run, topic) {
  const r = run(['vote', '--topic', topic]);
  const seen = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s{2}(\S+?)\s+【职责】/.exec(line);
    if (m) seen.push(m[1]);
  }
  return seen;
}

export default async function run() {
  const c = makeCtx('L15', '加席位不追溯卡死老议题 / 无票席位不许改变结果');
  const sb = provision('L15_roster_seat', spec('session-lab-L15_roster_seat'));
  const run = (args) => runWarden(sb.dir, args, { sessionId: sb.sessionId });
  fs.writeFileSync(path.join(sb.wdir, 'VOTES.jsonl'), '', 'utf8');

  const all = rosterOf(run, '(还没有的议题)') ;   // 空议题也会打名单（"- 没有投票"时 roster=VOTE_ROLES）
  const OLD5 = all.filter((r) => r !== '资料员' && r !== '方向员');
  c.check('前置 · 能读到应到名单，且现在**多于 5 席**（新角色已经有票）',
    all.length >= 6 && all.includes('资料员'),
    `应到 ${all.length} 席：${all.join('、')}`);

  // ---------- 负控①：老议题（首次投票早于新席位加入，且票里**没有** roster 字段）
  for (const role of OLD5) {
    appendVote(sb.wdir, { at: BEFORE, topic: '老议题', role, choice: '同意', reason: REASON });
  }
  const oldT = voteState(run, '老议题');
  c.check('负控 · 老议题（新席位加入**之前**投的票）→ 仍按当时的名单计，**不许**因新席位报「缺席·未决」',
    oldT.code === 0 && /多数：同意/.test(oldT.state) && !/缺席/.test(oldT.state),
    `结果=「${oldT.state}」（exit=${oldT.code}）`);

  // ---------- 正控①：新议题只投老 5 席 → 必须报缺席并点名
  for (const role of OLD5) {
    run(['vote', 'cast', '--topic', '新议题', '--role', role, '--choice', '同意', '--reason', REASON]);
  }
  const newT = voteState(run, '新议题');
  const missingLine = grab(newT.out, [/缺席：/], 1).join('');
  c.check('正控 · 新议题只投老 5 席 → **必须**「缺席·未决」并点名少谁（新角色的意见不许被静默忽略）',
    newT.code === 1 && /缺席·未决/.test(newT.state) && /缺席：/.test(newT.out),
    `结果=「${newT.state}」（exit=${newT.code}）；${missingLine}`);

  // ---------- 正控②：补上新席位 → 收齐、能推进
  for (const role of all.filter((r) => !OLD5.includes(r))) {
    run(['vote', 'cast', '--topic', '新议题', '--role', role, '--choice', '同意', '--reason', REASON]);
  }
  const newT2 = voteState(run, '新议题');
  c.check('正控 · 补上新席位的票 → 收齐、不再是缺席未决（不是"永远推不动"）',
    newT2.code === 0 && /多数：同意/.test(newT2.state),
    `结果=「${newT2.state}」（exit=${newT2.code}）`);

  // ---------- 正控③：票里**记了** roster 的老议题 → 以记录为准
  const RECORDED = OLD5.slice();   // 只记 5 席，且时刻在"加入之后"
  for (const role of RECORDED) {
    appendVote(sb.wdir, { at: AFTER, topic: '记了名单的议题', role, choice: '同意', reason: REASON, roster: RECORDED });
  }
  const recT = voteState(run, '记了名单的议题');
  c.check('正控 · 票里记了 roster → 以**记录的名单**为准（时刻晚于加入也不追溯要求新席位）',
    recT.code === 0 && /多数：同意/.test(recT.state) && !/缺席/.test(recT.state),
    `结果=「${recT.state}」（exit=${recT.code}）`);

  // ---------- 负控②：无票席位（AI测试用户）投反对 → 不许改变结果，但必须被单独列出来
  const outsider = run(['vote', 'cast', '--topic', '新议题', '--role', 'AI测试用户', '--choice', '反对',
    '--reason', '作为一个只看产品的使用者，这一步我用起来别扭，说不上哪里，但我不满意。']);
  const afterOutsider = voteState(run, '新议题');
  const votes = readJsonl(path.join(sb.wdir, 'VOTES.jsonl')).filter((v) => v.topic === '新议题');
  c.check('负控 · 无票席位投「反对」→ 结果**不许**改变（仍是多数：同意，不是平票/未决）',
    afterOutsider.code === 0 && /多数：同意/.test(afterOutsider.state) && !/平票/.test(afterOutsider.state),
    `结果=「${afterOutsider.state}」（exit=${afterOutsider.code}）；计票行=${grab(afterOutsider.out, [/计票：/], 1).join('')}`);
  c.check('负控 · 无票席位的意见**必须**被单独列出来（不许静默忽略）',
    /无权席位已出声/.test(afterOutsider.out) && /AI测试用户=反对/.test(afterOutsider.out),
    grab(afterOutsider.out, [/无权席位已出声/], 1).join('') || '（没打出来）');
  c.check('正控 · 无票席位的票**如实落进了台账**（VOTES.jsonl 里有它，所以"它说过话"有据可查）',
    votes.some((v) => v.role === 'AI测试用户' && v.choice === '反对'),
    `VOTES.jsonl 里该议题 ${votes.length} 条；角色=${votes.map((v) => `${v.role}:${v.choice}`).join('、')}`);
  c.check('负控 · 记账台词不许把无票席位说成"五个角色之一"（旧文案会把新角色判成不存在）',
    !/不是五个角色之一/.test(outsider.stdout) && /没有投票权/.test(outsider.stdout),
    grab(outsider.stdout, [/没有投票权|不是五个角色之一/], 2).join(' / ') || '（没打出相关行）');

  // ---------- 负控③：名字写错的角色 → 不许进 counts
  const typo = run(['vote', 'cast', '--topic', '新议题', '--role', '审查员', '--choice', '反对',
    '--reason', '这是一个把角色名字写错的票，它不该被当成一个真实角色计票。']);
  const afterTypo = voteState(run, '新议题');
  c.check('负控 · 角色名写错的票**不许**进计票（名字写错不该翻转结果），但要说出来',
    afterTypo.code === 0 && /多数：同意/.test(afterTypo.state) && /无权席位已出声/.test(afterTypo.out) && /审查员=反对/.test(afterTypo.out),
    `结果=「${afterTypo.state}」；${grab(afterTypo.out, [/无权席位已出声/], 1).join('')}`);
  c.check('正控 · CLI 如实告诉投票人"注册表里有哪些名字"（写错了要能自己发现）',
    /不是角色注册表里的名字/.test(typo.stdout) && /AI测试用户/.test(typo.stdout),
    grab(typo.stdout, [/它的职责：/], 1).join('').slice(0, 200));

  // ---------- 负控④：`check` 必须把"名单漂移"当硬失败（这次改动就是被它抓出来的）
  const chk = run(['check']);
  /**
   * ⚠ 2026-09-17 改（**改夹具、不放宽判据**）：原来断言的是 `!/\[角色\]/` ——
   *   那时 check **完全不提角色**。现在 check 会打一行**提醒** `提醒: [角色] 角色在跑：…`
   *   （脑子A 第①条：「那一行的唯一去向是用户的 notice，而用户把责任给了监督员，
   *     没有任何路径把它交给监督员」⇒ 现在同时进 check 的提醒）。
   *   ⇒ 正控要断言的**没变**：没有角色相关的【失败】项。所以判据改成只看失败行
   *   （失败行以 ` - [角色]` 开头；提醒行以 `提醒: [角色]` 开头）。
   */
  const roleFails = chk.stdout.split(/\r?\n/).filter((l) => /^\s*-\s*\[角色\]/.test(l));
  c.check('正控 · 注册表与本文件派生名单一致 → check 里**没有**「[角色]」**失败项**',
    roleFails.length === 0,
    roleFails.length ? roleFails.slice(0, 2).join(' / ').slice(0, 160) : '（没有角色相关失败项；提醒行不算）');

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '老议题不被追溯卡死、新议题必须收齐新席位的票、无票席位改变不了结果但也不许被静默忽略、写错的角色名不进计票。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
