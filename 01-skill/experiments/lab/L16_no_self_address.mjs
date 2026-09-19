#!/usr/bin/env node
/**
 * L16 · 「异议未回应即未决」不许被**异议方自己**绕过
 *
 * 回归来源（2026-09-16 由「审查」实测坐实，记录在 `待填进插件-逐条清单.md` §7.5 与 skill 账本）：
 *   4 同意 / 1 反对、无人回应 → 确实是 `未决`、exit 1；
 *   但**反对者自己补一票带 `--address 自己`**，就能把它推进成 `多数：同意`、exit 0。
 *   ⇒ **"异议未回应即未决"这条闸门可以被异议方自己绕过** —— 闸门等于白装。
 *
 * 根因：原来只收"**谁的名字被点到**"，不区分"**是谁点的**"。
 *   `--address` 记的是"**我在回应谁**"，所以必须按 **收件人 → 谁回应了它** 收；
 *   一个异议**只被它自己回应过** ⇒ 仍然算**未回应**。
 *
 * 判据（黑盒）：
 *   负控 4 同意 / 1 反对、没人回应 → `未决`、exit 1
 *   负控 **反对者自己** `--address 自己`（保持反对）→ **仍然 `未决`、exit 1**（这就是那条洞）
 *   正控 **多数方**有人 `--address 反对者` → 真的解开了：`多数：同意`、exit 0（不许把闸门焊死）
 *   正控 反对者**重新投票把 choice 改成同意**（合法的改主意）→ `多数：同意`、exit 0
 *   说明 投票当下就警告"点了自己不算回应"
 */
import { provision, readJsonl, runWarden, makeCtx, grab } from './common.mjs';

const QUOTE = '有反对票而没人回应就不算定；但反对者不能自己把自己的异议标记成"已回应"。';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 异议未回应即未决，且不许自己解除
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 反对者自己补一票带 --address 自己，就能把闸门绕过去
- 必须: 异议只被自己"回应"过 ⇒ 仍算未回应
- 不要: 为了让闸门"看起来管用"而把合法的改主意/别人回应也一起焊死
- 锁定: 2026-09-17
`;

const R = '这条我同意：理由落在本角色的职责范围内，长度也够';
const R_NO = '我反对：这一条会丢掉用户逐字说过的那句话，风险没人回应，我不改。';

export default async function run() {
  const c = makeCtx('L16', '异议未回应即未决：不许被异议方自己绕过');
  const sb = provision('L16_no_self_address', spec('session-lab-L16_no_self_address'));
  const run = (args) => runWarden(sb.dir, args, { sessionId: sb.sessionId });
  const TOPIC = '自己给自己解除异议';

  // 应到名单从 warden 现读（黑盒），并在四张同意票上 + 一张反对票
  const listOut = run(['vote', '--topic', TOPIC]).stdout;
  const roster = [];
  for (const line of listOut.split(/\r?\n/)) {
    const m = /^\s{2}(\S+?)\s+【职责】/.exec(line);
    if (m) roster.push(m[1]);
  }
  c.check('前置 · 能读到应到名单（≥5 席）', roster.length >= 5, `应到 ${roster.length} 席：${roster.join('、')}`);
  if (roster.length < 5) {
    return { id: c.id, name: c.name, status: 'FAIL', pass: false, reason: '读不到应到名单，实验无法进行', checks: c.checks, skipped: c.skipped };
  }
  const DISSENTER = roster[roster.length - 1];
  const MAJORITY = roster[0];

  // ---------- 负控①：4 同意 / 1 反对、没人回应 → 未决
  for (const role of roster.slice(0, -1)) {
    run(['vote', 'cast', '--topic', TOPIC, '--role', role, '--choice', '同意', '--reason', R]);
  }
  run(['vote', 'cast', '--topic', TOPIC, '--role', DISSENTER, '--choice', '反对', '--reason', R_NO]);
  const s1 = run(['vote', '--topic', TOPIC]);
  c.check('负控 · 4 同意 / 1 反对、没人回应 → 「未决」exit 1',
    s1.code === 1 && /未决/.test(s1.stdout) && /异议未回应/.test(s1.stdout),
    `exit=${s1.code}；${grab(s1.stdout, [/结果：/], 1).join('')}`);

  // ---------- 负控②：**反对者自己**带 --address 自己，保持反对 → 仍须未决
  const selfOut = run(['vote', 'cast', '--topic', TOPIC, '--role', DISSENTER, '--choice', '反对', '--reason', R_NO, '--address', DISSENTER]);
  const s2 = run(['vote', '--topic', TOPIC]);
  c.check('负控 · **反对者自己**写 `--address 自己` → **仍然「未决」exit 1**（这条洞就是本实验的回归对象）',
    s2.code === 1 && /未决/.test(s2.stdout) && new RegExp(`异议未回应[^\\n]*${DISSENTER}`).test(s2.stdout),
    `exit=${s2.code}；${grab(s2.stdout, [/结果：/], 1).join('')}`);
  c.check('说明 · 只被自己"回应"过的异议被**点名说清**（不许看起来像已回应）',
    /只被它自己/.test(s2.stdout) && new RegExp(`只被它自己[^\\n]*${DISSENTER}`).test(s2.stdout),
    grab(s2.stdout, [/只被它自己/], 1).join('') || '（没打出来）');
  c.check('说明 · 投票当下就警告"点了自己不算回应"，并指出合法出路（重新投票改 choice）',
    /这不算回应异议/.test(selfOut.stdout) && /重新投一票把 --choice 改成同意/.test(selfOut.stdout),
    grab(selfOut.stdout, [/这不算回应异议/], 1).join('') || '（没打出来）');

  // ---------- 正控①：**多数方**有人回应反对者 → 真的解开
  run(['vote', 'cast', '--topic', TOPIC, '--role', MAJORITY, '--choice', '同意', '--reason',
    '回应你的异议：用户那句话在 SPEC 的 R1 里逐字保留着，不会丢，我把原文贴进正文。', '--address', DISSENTER]);
  const s3 = run(['vote', '--topic', TOPIC]);
  c.check('正控 · **多数方**回应了反对者 → 真的解开：「多数：同意」exit 0（不许把闸门焊死）',
    s3.code === 0 && /多数：同意/.test(s3.stdout) && !/未决/.test(s3.stdout),
    `exit=${s3.code}；${grab(s3.stdout, [/结果：/], 1).join('')}`);

  // ---------- 正控②：反对者**重新投票改 choice** → 合法的改主意，允许
  const TOPIC2 = '自己改主意是允许的';
  for (const role of roster.slice(0, -1)) {
    run(['vote', 'cast', '--topic', TOPIC2, '--role', role, '--choice', '同意', '--reason', R]);
  }
  run(['vote', 'cast', '--topic', TOPIC2, '--role', DISSENTER, '--choice', '反对', '--reason', R_NO]);
  const before = run(['vote', '--topic', TOPIC2]);
  const flip = run(['vote', 'cast', '--topic', TOPIC2, '--role', DISSENTER, '--choice', '同意', '--reason',
    '我改主意了：被说服了，同意；理由写在这里，长度也够。']);
  const after = run(['vote', '--topic', TOPIC2]);
  const votes = readJsonl(`${sb.wdir}\\VOTES.jsonl`).filter((v) => v.topic === TOPIC2 && v.role === DISSENTER);
  c.check('正控 · 反对者**重新投票把 choice 改成同意** → 允许（那是明确、有据可查的改主意）',
    before.code === 1 && after.code === 0 && /多数：同意/.test(after.stdout) && votes.length === 2,
    `改之前 exit=${before.code}；改之后 exit=${after.code}；台账里该角色 ${votes.length} 条票（两条都留着，能反查改过主意）`);
  c.check('正控 · 改主意这件事**不许被当成"偷偷解除异议"**（台账留两次投票，不是覆盖掉）',
    votes.length === 2 && votes[0].choice === '反对' && votes[1].choice === '同意' && flip.code === 0,
    `choices=${JSON.stringify(votes.map((v) => v.choice))}`);

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '异议只被自己"回应"过 → 仍算未回应（闸门绕不过去）；多数方回应、反对者改主意这两条合法出路仍然通。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
