#!/usr/bin/env node
/**
 * L6 · 冤枉实验（审查者冤枉人）
 *
 * 回归来源（本轮真实事故）：两个独立"脑子"对同一份文档提了 14 条指控，**经复核只有 4 条成立**。
 * 脑子 G 的 4 条冤、脑子 H 的 1 条冤，形态就是这里的 ①②：
 *   ① 把**已经标了 `(AI词)` 的数字**说成"没标"        → check: unlabeled    → 机器必须驳回
 *   ② 把 **VOICE 里真实存在的文件名**说成"查无"        → check: voice-lacks  → 机器必须驳回
 *   ③ 一条**真指控**（产物里确实漏了用户要的东西）      → check: artifact-lacks → 机器必须确认
 *
 * 判据：`brain audit` exit 1 并点名 ①②；③ 计入"成立"。
 * 正控：换一份产物、只提成立的两条指控 → audit exit 0（防"一律驳回"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  provision, writeUtf8, runWarden, makeCtx, grab, REAL_WORKSPACE, REAL_WARDEN_DIR,
} from './common.mjs';

const QUOTE = '归属与验收都要能被机器复核：标了归属的句子要能逐字核对，漏了的东西要能被指出来。';

// 真·VOICE 里存在的文件名（出处：<WORKSPACE>\.warden\VOICE.jsonl，用户确实说过 4 次）
const VOICE_FILE = 'NEXT-SESSION.md';
// 真·用户要求（出处同上），但产物里确实没有 —— 所以"漏了"这条指控成立
const MISSING_NEEDLE = '不要干扰它';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 归属与验收都要可机检
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 审查者的指控如果查不出来，就能凭一句话否掉产物
- 必须: 指控带 needle；机器能复核
- 不要: 用查不出来的指控否掉产物
- 锁定: 2026-09-16
`;

const ARTIFACT = `# 待审产物

- 相机距离 4.2 米 (AI词)
- 导出：只做了 PNG，SVG / JSON 还欠着
`;

const ARTIFACT2 = `# 待审产物（正控样本）

- 只做了 PNG，SVG / JSON 还欠着
`;

export default async function run() {
  const c = makeCtx('L6', '冤枉实验：审查者冤枉人');
  /**
   * ⚠ 公开版：这条用例依赖**作者私有账本**里的 VOICE.jsonl（真实用户在真实窗口说过的话）。
   *   公开包**不发** .warden ⇒ 它在公开用户那里**结构上跑不了**。
   *   ⇒ 如实 SKIP，**不许假装通过、也不许留着红**（"没查到东西 ≠ 查了没问题"）。
   */
  try {
    const priv = path.join(REAL_WARDEN_DIR, 'VOICE.jsonl');
    if (!fs.existsSync(priv)) {
      c.skip('整条用例', '私有账本不在（' + priv + '）—— 公开版不发 .warden，这条在公开用户那里跑不了');
      return { id: c.id, name: c.name, status: 'SKIP', pass: true, reason: '私有账本不在，如实跳过', checks: c.checks, skipped: c.skipped };
    }
  } catch (e) {
    // ⚠ 不许静默：守卫自己坏了要说出来（我第一版把 ReferenceError 吞了，守卫等于没写）
    c.skip('守卫自身', '私有账本守卫自己抛了异常：' + String(e && e.message).slice(0, 120));
  }
  const sb = provision('L6_false_accusation', spec('session-lab-L6_false_accusation'));
  writeUtf8(path.join(sb.dir, 'artifact.md'), ARTIFACT);
  writeUtf8(path.join(sb.dir, 'artifact2.md'), ARTIFACT2);
  runWarden(sb.dir, ['sources', '--add', REAL_WORKSPACE], { sessions: 'real', sessionId: sb.sessionId });

  const claimsA = [
    { code: 'E01', needle: '相机距离 4.2 米', check: 'unlabeled' },        // 假：那行其实标了 (AI词)
    { code: 'E02', needle: VOICE_FILE, check: 'voice-lacks' },              // 假：VOICE 里真的有这个文件名
    { code: 'E03', needle: MISSING_NEEDLE, check: 'artifact-lacks' },       // 真：产物里确实没有
  ];
  const recA = runWarden(sb.dir, ['brain', 'record', '--artifact', 'artifact.md', '--brain', 'G',
    '--verdict', 'reject', '--issues', 'E01,E02,E03', '--claims', JSON.stringify(claimsA)],
  { sessions: 'real', sessionId: sb.sessionId });
  c.check('前置 · 脑子 G 的 3 条指控已登记',
    recA.code === 0, `exit=${recA.code}；${grab(recA.stdout, [/已记/], 1).join('')}`);

  const au = runWarden(sb.dir, ['brain', 'audit', '--artifact', 'artifact.md'],
    { sessions: 'real', sessionId: sb.sessionId, timeout: 300000 });
  const named = (code) => new RegExp(`✗\\s*${code}\\b`).test(au.stdout);
  const count = (/：(\d+)\/(\d+) 条指控成立/.exec(au.stdout) ?? []).slice(1).join('/');

  c.check('① 假指控「已标 (AI词) 的数字没标」→ 机器驳回并点名 E01',
    named('E01'), `audit exit=${au.code}；成立 ${count || '?'}；${grab(au.stdout, [/✗ E01/], 1).join('')}`);
  c.check(`② 假指控「${VOICE_FILE} 在 VOICE 里查无」→ 机器驳回并点名 E02`,
    named('E02'), `${grab(au.stdout, [/✗ E02/], 1).join('')}`);
  c.check('③ 真指控「产物里漏了用户要的东西」→ 机器确认（不计入驳回）',
    !named('E03') && /^1\/3$/.test(count), `成立 ${count || '?'}，E03 被驳回=${named('E03')}`);
  c.check('④ brain audit 因存在被驳回的指控而 exit 1',
    au.code === 1, `exit=${au.code}；${grab(au.stdout, [/结论：/], 1).join('')}`);

  // ---------- 正控：只有成立指控时，audit 必须放行（防"一律驳回"）
  const claimsC = [
    { code: 'E10', needle: MISSING_NEEDLE, check: 'artifact-lacks' },
    { code: 'E11', needle: MISSING_NEEDLE, check: 'voice-has' },
  ];
  runWarden(sb.dir, ['brain', 'record', '--artifact', 'artifact2.md', '--brain', 'K',
    '--verdict', 'reject', '--issues', 'E10,E11', '--claims', JSON.stringify(claimsC)],
  { sessions: 'real', sessionId: sb.sessionId });
  const au2 = runWarden(sb.dir, ['brain', 'audit', '--artifact', 'artifact2.md'],
    { sessions: 'real', sessionId: sb.sessionId, timeout: 300000 });
  const count2 = (/：(\d+)\/(\d+) 条指控成立/.exec(au2.stdout) ?? []).slice(1).join('/');
  c.check('正控 · 只提成立指控（artifact-lacks + voice-has）→ audit exit 0，2/2 成立',
    au2.code === 0 && count2 === '2/2', `exit=${au2.code}；成立 ${count2 || '?'}`);

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    pass: ok,
    reason: ok
      ? '两条假指控被机器驳回并点名，真指控被确认；只提成立指控时 audit 放行。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
