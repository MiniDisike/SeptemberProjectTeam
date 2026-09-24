#!/usr/bin/env node
/**
 * L23 · 角色健康判据（**纯函数**版）—— 本沙箱里**真能跑**，不需要子进程
 *
 * 回归来源：事故 **I50**（2026-09-17，由两个「脑子」独立审出、我逐条复核）：
 *   旧判据「一条产出都没有 ⇒ 该角色当前是装饰」对 `AI测试用户` **恒真**
 *   （vote:false + 不在 FINDING_ROLES + rolesHealth 不读 ROLE_SPEECH）
 *   ⇒ 它每轮必响，而 effective 的分母含它 ⇒ **上限 7/8，"8/8" 结构上不可达**（永远红 = 不能当闸）；
 *   另一条「最近 N 轮无产出（且别人在产出）」测的是**有没有产出通道**，不是**有没有干活**：
 *   它要求"别人在干" ⇒ **全席停摆时必然沉默**（停产不能被发现），还跨渠道比 ⇒ group-chat 5 条假阳性。
 *
 * 为什么这个用例不建沙箱：`rolesHealth(dir)` / `rolesHealthLine(dir)` 是**纯读函数** ——
 *   只要给一个目录、里面放三份 JSONL 就能跑。**不 spawn 子进程 ⇒ 不受本沙箱的 EPERM 限制。**
 *   （对比 L19：它要跑真 CLI，本沙箱只能 SKIP ⇒ 真账上产生全部判决的那条判据，在它自己的用例里跑不到。
 *     脑子A 第⑨条点名的就是这个洞。）
 *
 * 判据（全部机械）：
 *   ① 无产出渠道的席位（AI测试用户）**不进分母**、单列成设计事实，且**不许**被印成"装饰"；
 *   ② 窗口内没有新议题 ⇒ **不判缺席**（没活干不许判）；
 *   ③ 有活可干而某席位没到 ⇒ 报「缺席 <议题>（N席应到实到M席）」；
 *   ④ 全席停摆（窗口内 0 产出）⇒ 报"全线停摆"，**不许**印成"N/M 有效"；
 *   ⑤ 那一行必须带**见证数据**（窗口轮数 / 新议题数 / 计分席位数）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from './common.mjs';

const WARDEN = 'file:///<HOME>/.dsh/skills/task-warden/warden.mjs';

function mkLedger(name, { rounds, votes, findings }) {
  const dir = path.join(os.tmpdir(), 'L23_' + name, '.warden');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.mkdirSync(dir, { recursive: true });
  const w = (f, rows) => fs.writeFileSync(path.join(dir, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  w('ROUNDS.jsonl', rounds || []);
  w('VOTES.jsonl', votes || []);
  w('FINDINGS.jsonl', findings || []);
  return dir;
}

const T = (min) => new Date(Date.UTC(2026, 8, 17, 10, min, 0)).toISOString();
const rounds = (n, startMin) => Array.from({ length: n }, (_, i) => ({
  round: i + 1, requirement: 'R1', status: 'partial', at: T(startMin + i),
}));

export default async function run() {
  const c = makeCtx('L23', '角色健康判据（纯函数）：恒真项、没活干、缺席、停产');

  const mod = await import(WARDEN);
  const { rolesHealth, rolesHealthLine } = mod;

  // ---------- 夹具甲：窗口内有一个"只到 2 席"的议题（有活可干而多数席位没到）
  const A = mkLedger('A', {
    rounds: rounds(6, 0),                                   // 6 轮，窗口=最后 3 轮
    votes: [
      // 议题 t-old：7 席全到（在窗口之外，因为轮次时间在后）
      ...['监督员', '审查', '记录', '支线守门员', '提问闸门', '资料员', '方向员'].map((role) => ({ at: T(0), role, topic: 't-old', choice: '同意', reason: '这是一条足够长的理由用来占位测试用' })),
      // 议题 t-new：只有 2 席到（时间落在最后 3 轮里）。两条理由**故意写得不一样**，
      //   免得触发无关的「未提供独立视角」（那是另一条代理判据，不是本用例要测的）。
      { at: T(4), role: '监督员', topic: 't-new', choice: '同意', reason: '监督员的角度：这条先锚用户原话，原话里没有的我不认' },
      { at: T(4), role: '审查', topic: 't-new', choice: '同意', reason: '审查的角度：证据只认本机实测，自称不算数，这条我复核过' },
    ],
    findings: [],
  });
  const hA = rolesHealth(A);
  const lineA = rolesHealthLine(A);
  c.check('③ 有活可干而席位没到 → 报「缺席 <议题>（N席应到实到M席）」（硬判据）',
    /缺席\s+t-new/.test(lineA) && /席应到实到\s*\d+\s*席/.test(lineA),
    lineA.slice(0, 220));
  c.check('⑤ 那一行带见证数据（窗口轮数 / 新议题数 / 计分席位数）',
    /窗口 3 轮/.test(lineA) && /新议题 \d+ 个/.test(lineA) && /计分席位 \d+/.test(lineA),
    lineA.slice(0, 160));
  c.check('① AI测试用户 在无渠道清单里、且**不参与**装饰判定',
    (hA.noChannelSeats || []).includes('AI测试用户')
    && !hA.roles.filter((r) => !r.hasChannel).some((r) => r.flags.length)
    && !/AI测试用户[^\n]*装饰/.test(lineA),
    'noChannelSeats=' + JSON.stringify(hA.noChannelSeats));
  c.check('① 分母是计分席位（7），不是 8',
    hA.scoredSeats === 7 && !/\d\/8/.test(lineA),
    'scoredSeats=' + hA.scoredSeats + ' / effective=' + hA.effective);

  // ---------- 夹具乙：有轮次、但窗口内**没有任何新议题**（没活干）
  const B = mkLedger('B', {
    rounds: rounds(6, 0),
    votes: [
      ...['监督员', '审查', '记录', '支线守门员', '提问闸门', '资料员', '方向员'].map((role) => ({ at: T(0), role, topic: 't-old', choice: '同意', reason: '这是一条足够长的理由用来占位测试用' })),
    ],
    findings: [],
  });
  const lineB = rolesHealthLine(B);
  c.check('② 窗口内没有新议题 ⇒ **不判缺席**（没活干不许判）',
    !/缺席有活可干/.test(lineB),
    lineB.slice(0, 200));
  c.check('② 但"窗口内 0 产出"要被**单独报成停摆**，不许印成"N/M 有效"',
    /全线停摆/.test(lineB) && !/计分席位有效/.test(lineB),
    lineB.slice(0, 200));

  // ---------- 夹具丙：窗口内有产出、且各席位都到齐（正常盘面）
  const C = mkLedger('C', {
    rounds: rounds(6, 0),
    votes: ['监督员', '审查', '记录', '支线守门员', '提问闸门', '资料员', '方向员'].map((role) => ({ at: T(4), role, topic: 't-new', choice: '同意', reason: '这是一条足够长的理由用来占位测试用' })),
    findings: [{ at: T(4), by: '资料员', text: '一条发现', source: '出处', ref: 'R1' }],
  });
  const lineC = rolesHealthLine(C);
  c.check('③ 全到齐 ⇒ 不许报缺席（正控，防误伤）',
    !/缺席有活可干/.test(lineC),
    lineC.slice(0, 200));
  c.check('④ 有产出 ⇒ 不许报停摆（正控）',
    !/全线停摆/.test(lineC),
    lineC.slice(0, 200));

  // ---------- 夹具丁：**回归 I50 的核心**——三本真账都出现过的那条恒真报警必须消失
  const D = mkLedger('D', { rounds: rounds(6, 0), votes: [], findings: [] });
  const lineD = rolesHealthLine(D);
  c.check('I50 回归 · 一个"永远零产出"的席位不许被印成判决「该角色当前是装饰」',
    !/该角色当前是装饰/.test(lineD) && /结构上无产出渠道/.test(lineD),
    lineD.slice(0, 200));

  for (const d of [A, B, C, D]) {
    try { fs.rmSync(path.dirname(d), { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch (e) { /* 清不掉就算了 */ }
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '新判据在纯函数层被真跑过：无渠道席位不进分母也不判装饰、没活干不判缺席、有活没干才报缺席（带应到/实到席数）、全席停摆单独报、那一行带见证数据。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
