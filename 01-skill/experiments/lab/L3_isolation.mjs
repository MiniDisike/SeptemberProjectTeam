#!/usr/bin/env node
/**
 * L3 · 隔离实验（两个项目读到对方守则）
 *
 * 回归来源：真实事故 —— `<WORKSPACE>\.warden` 与 `<HOME>\<别的工程>\.warden`
 * 互相可见，谁在那个工作区跑 warden 都会读到别人的守则。
 *
 * 判据：
 *   ① 在**容器目录**（没 .git、装着别的工程）跑 → 必须被拒绝（exit 2 或明确拒绝信息）
 *   ② 在 A 里跑 report → 读到的是 A 的 SPEC，不含 B 的
 *   ③ 在 B 里跑 report → 读到的是 B 的 SPEC，不含 A 的
 *   ④ `sources` 里绝不含对方工作区
 */
import path from 'node:path';
import {
  LAB_ROOT, provision, runWarden, makeCtx, grab, encodeWorkspace, REAL_WARDEN_DIR, readUtf8,
} from './common.mjs';

const specA = (sid) => `# 需求锁定表（append-only）

## R1 · A 项目专用
- 原话: ALPHA-ISO-A 是本项目专用标记，这条需求只属于 A，别的项目不许读到它。
- 出处: session:${sid}#1
- 为什么: 两个项目的守则混在一起时，谁改了谁都说不清
- 必须: 只有 A 能读到
- 不要: 让 B 读到
- 锁定: 2026-09-16
`;

const specB = (sid) => `# 需求锁定表（append-only）

## R1 · B 项目专用
- 原话: BETA-ISO-B 是本项目专用标记，这条需求只属于 B，别的项目不许读到它。
- 出处: session:${sid}#1
- 为什么: 两个项目的守则混在一起时，谁改了谁都说不清
- 必须: 只有 B 能读到
- 不要: 让 A 读到
- 锁定: 2026-09-16
`;

export default async function run() {
  const c = makeCtx('L3', '隔离实验：两个项目读到对方守则');
  const A = provision('iso_A', specA('session-lab-iso_A'));
  const B = provision('iso_B', specB('session-lab-iso_B'));
  runWarden(A.dir, ['record', '--req', 'R1', '--status', 'done', '--delivered', 'A 的交付',
    '--evidence', 'src/a.js:1', '--why', 'A 项目自己的一轮'], { sessionId: A.sessionId });
  runWarden(B.dir, ['record', '--req', 'R1', '--status', 'done', '--delivered', 'B 的交付',
    '--evidence', 'src/b.js:1', '--why', 'B 项目自己的一轮'], { sessionId: B.sessionId });

  // ---------- ① 在容器目录跑（只跑只读的 vote：它会把"读到的账本里的议题"打出来）
  {
    const r = runWarden(LAB_ROOT, ['vote'], { sessionId: A.sessionId });
    const rejected = r.code === 2 || /拒绝操作/.test(r.stdout);
    c.check('① 在容器目录 D:\\user\\grok\\_lab 跑 → 必须被拒绝',
      rejected,
      `exit=${r.code}；${grab(r.stdout, [/拒绝操作/, /装着别的工程/, /议题/], 3).join(' | ') || '（没有任何拒绝信息）'}`);

    // 这一条只是把**实测事实**记下来（好读账），断言在 ① 里
    const leaked = /ARCH能否定稿|混合会话的范围/.test(r.stdout);
    c.check('【实测事实】容器目录里它读的是谁的账本', true,
      leaked
        ? `exit=${r.code}：输出里出现了只存在于 ${path.join(REAL_WARDEN_DIR, 'VOTES.jsonl')} 的议题 —— ` +
          '说明"在容器目录跑"被静默放行，它把上层真实工程的账本当成了自己的（正是本次事故那条路）。'
        : `exit=${r.code}：被拒绝或没读到上层账本内容。`);
  }

  // ---------- ② / ③ 各自读到自己的 SPEC
  {
    const ra = runWarden(A.dir, ['report'], { sessionId: A.sessionId });
    const rb = runWarden(B.dir, ['report'], { sessionId: B.sessionId });
    c.check('② 在 A 里跑 report → 输出是 A 的 SPEC，不含 B 的',
      ra.code === 0 && ra.stdout.includes('ALPHA-ISO-A') && !ra.stdout.includes('BETA-ISO-B'),
      `exit=${ra.code}；含 ALPHA=${ra.stdout.includes('ALPHA-ISO-A')}；含 BETA=${ra.stdout.includes('BETA-ISO-B')}`);
    c.check('③ 在 B 里跑 report → 输出是 B 的 SPEC，不含 A 的',
      rb.code === 0 && rb.stdout.includes('BETA-ISO-B') && !rb.stdout.includes('ALPHA-ISO-A'),
      `exit=${rb.code}；含 BETA=${rb.stdout.includes('BETA-ISO-B')}；含 ALPHA=${rb.stdout.includes('ALPHA-ISO-A')}`);
    const rep = readUtf8(path.join(A.wdir, 'REPORT.md'));
    c.check('②b A 的 .warden/REPORT.md 落盘内容同样只有 A 的需求',
      rep.includes('ALPHA-ISO-A') && !rep.includes('BETA-ISO-B'),
      `.warden/REPORT.md ${rep.length} 字节`);
  }

  // ---------- ④ sources 里不含对方工作区
  {
    const sa = runWarden(A.dir, ['sources'], { sessionId: A.sessionId });
    const sb = runWarden(B.dir, ['sources'], { sessionId: B.sessionId });
    const myA = encodeWorkspace(A.dir);
    const myB = encodeWorkspace(B.dir);
    c.check('④ A 的 sources 指向 A、不含 B',
      sa.stdout.includes(myA) && !sa.stdout.includes(myB),
      `期望含 ${myA}；实际：${grab(sa.stdout, [/--D-user/], 3).join(' | ')}`);
    c.check('④ B 的 sources 指向 B、不含 A',
      sb.stdout.includes(myB) && !sb.stdout.includes(myA),
      `期望含 ${myB}；实际：${grab(sb.stdout, [/--D-user/], 3).join(' | ')}`);
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    pass: ok,
    reason: ok
      ? 'A/B 各自读自己的守则，sources 不串；容器目录也拒绝了。'
      : '②③④ 通过；①（容器目录必须被拒绝）**未通过**：它没拦住，而是读了上层真实账本 —— 见 checks 里的缺口条目。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
