#!/usr/bin/env node
/**
 * L27 · **发现的同构检测**（R8 的核心缺口）—— 纯函数，本沙箱里真能跑
 *
 * 用户 R8 逐字：「（用户原话已隐去 —— 公开版不留逐字）」。
 *
 * 缺口（2026-09-17 实测）：同构检测原来**只比投票理由**，而两个干活角色
 *   （资料员 / 方向员）的**真实产出通道是发现台账**（`find add`）——
 *   检测器根本覆盖不到它们。实测：三本账的"同构"计数**全是 0**（一次都没响过）。
 *
 * 判据（全部机械）：
 *   ① 同一 `ref` 下，本角色的发现与**别的角色**的发现同构（Jaccard ≥ 0.8）⇒
 *      标【代理】未提供独立视角；
 *   ② 正控：发现内容不同 ⇒ **不许**报（防误伤）；
 *   ③ 负控：**只有自己**在某个 ref 下有发现（没有可比对象）⇒ 不许报；
 *   ④ 说明：它是**代理**判据（文字不像 ≠ 观点真独立），输出里必须带这句免责。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from './common.mjs';

const WARDEN = 'file:///<HOME>/.dsh/skills/task-warden/warden.mjs';

function mkLedger(name, { rounds, votes, findings }) {
  const dir = path.join(os.tmpdir(), 'L27_' + name, '.warden');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.mkdirSync(dir, { recursive: true });
  const w = (f, rows) => fs.writeFileSync(path.join(dir, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  w('ROUNDS.jsonl', rounds || []);
  w('VOTES.jsonl', votes || []);
  w('FINDINGS.jsonl', findings || []);
  w('DUTY.jsonl', []);
  return dir;
}

const T = (min) => new Date(Date.UTC(2026, 8, 17, 10, min, 0)).toISOString();
const rounds = (n) => Array.from({ length: n }, (_, i) => ({ round: i + 1, requirement: 'R1', status: 'partial', at: T(i) }));

// 两条**几乎一字不差**的发现（复现"同构"）
const SAME_A = '查证结果：这个库的默认超时是 5 秒，依据是官方文档第 3 节与源码第 12 行，结论可以直接采信。';
const SAME_B = '查证结果：这个库的默认超时是 5 秒，依据是官方文档第 3 节与源码第 12 行，结论可以直接采信。';
// 两条**明显不同**的发现（正控）
const DIFF_B = '方向判断：这个改法会影响三条支线，其中两条的用户可感知影响为零，建议先做低风险那条。';

export default async function run() {
  const c = makeCtx('L27', '发现的同构检测：方向员给了和别人一样的东西要报出来');

  const mod = await import(WARDEN);
  const { rolesHealth, rolesHealthLine } = mod;

  // ---------- ① 负控/正控：两条同构的发现（资料员 vs 方向员，同一条 R#）
  const A = mkLedger('iso', {
    rounds: rounds(6),
    votes: [],
    findings: [
      { at: T(4), by: '资料员', kind: '事实', text: SAME_A, source: '官方文档', ref: 'R1' },
      { at: T(4), by: '方向员', kind: '提案', text: SAME_B, why: '指回 R1', ref: 'R1' },
    ],
  });
  const hA = rolesHealth(A);
  const lineA = rolesHealthLine(A);
  const dir1 = hA.roles.find((r) => r.role === '方向员');
  c.check('① 同一 R# 下与别的角色同构 ⇒ 报「未提供独立视角」',
    dir1.findingIso === 1 && dir1.flags.some((f) => /未提供独立视角/.test(f)),
    'findingIso=' + dir1.findingIso + ' flags=' + JSON.stringify(dir1.flags));
  c.check('① 那一行也把它印出来（不许只算在 JSON 里）',
    /未提供独立视角/.test(lineA),
    lineA.slice(0, 200));
  c.check('④ 免责写清：它是**代理**判据（文字不像 ≠ 观点真独立）',
    /代理判据/.test(lineA) || dir1.flags.some((f) => /代理判据/.test(f)),
    JSON.stringify(dir1.flags).slice(0, 160));

  // ---------- ② 正控：发现内容不同 ⇒ 不许报
  const B = mkLedger('diff', {
    rounds: rounds(6),
    votes: [],
    findings: [
      { at: T(4), by: '资料员', kind: '事实', text: SAME_A, source: '官方文档', ref: 'R1' },
      { at: T(4), by: '方向员', kind: '提案', text: DIFF_B, why: '指回 R1', ref: 'R1' },
    ],
  });
  const hB = rolesHealth(B);
  const dir2 = hB.roles.find((r) => r.role === '方向员');
  c.check('② 正控 · 发现内容不同 ⇒ **不许**报（防误伤）',
    dir2.findingIso === 0 && !dir2.flags.some((f) => /未提供独立视角/.test(f)),
    'findingIso=' + dir2.findingIso);

  // ---------- ③ 负控：只有自己在某个 ref 下有发现（没有可比对象）⇒ 不许报
  const C = mkLedger('lonely', {
    rounds: rounds(6),
    votes: [],
    findings: [{ at: T(4), by: '方向员', kind: '提案', text: SAME_A, why: '指回 R1', ref: 'R1' }],
  });
  const hC = rolesHealth(C);
  const dir3 = hC.roles.find((r) => r.role === '方向员');
  c.check('③ 负控 · 只有自己在那条 R# 下有发现 ⇒ 不许报（没可比对象）',
    dir3.findingIso === 0,
    'findingIso=' + dir3.findingIso);

  for (const d of [A, B, C]) {
    try { fs.rmSync(path.dirname(d), { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch (e) { /* 清不掉就算了 */ }
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '发现台账现在也纳入同构检测：同一 R# 下与别的角色一字不差会被报出来（方向员的真实产出通道终于被覆盖），而内容不同、或只有自己一条时不误伤；并写明这是代理判据。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
