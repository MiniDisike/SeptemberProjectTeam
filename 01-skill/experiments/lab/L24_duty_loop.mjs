#!/usr/bin/env node
/**
 * L24 · 派活回路（`DUTY.jsonl`）—— 本沙箱里**真能跑**（纯函数，不需要子进程）
 *
 * 回归来源：两个「脑子」独立审完、结论一致点名的那个**根**（事故 I50 的根因）：
 *   "某角色没产出"有两种完全不同的原因 —— **(a) 派了活没干** 与 **(b) 本来就没活干**。
 *   旧账本只有产出侧（三本账的 ROUNDS 里 role/branch/duty 命中数全 0）
 *   ⇒ 这两种在数据上分不开 ⇒ 仪表只能瞎猜（恒真 / 假阳性 / 停产时沉默）。
 *   脑子B 原话：「它测的是**记账习惯**，不是劳动。」
 *   ⇒ 补上"责任"侧之后，判据才能变成 **责任 ∧ 无产出**。
 *
 * 判据（全部机械）：
 *   ① `addDuty` 的四条硬规则：角色必须在册、不许派给"无产出渠道"的席位、
 *      `--what` 要有实质内容、`--ref` 必须指到真有的 R#；
 *   ② 派了活 + 窗口内 0 产出 ⇒ 报「派了活没干」；
 *   ③ 派了活 + 有产出 ⇒ **不许**报（正控，防误伤）；
 *   ④ 没派活 + 0 产出 ⇒ **不许**报「派了活没干」（没活干不许判）；
 *   ⑤ 派活条数要进那一行的**见证数据**（`派活 N 条`）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from './common.mjs';

const WARDEN = 'file:///<HOME>/.dsh/skills/task-warden/warden.mjs';

function mkLedger(name, { rounds, votes, findings, duties }) {
  const dir = path.join(os.tmpdir(), 'L24_' + name, '.warden');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.mkdirSync(dir, { recursive: true });
  const w = (f, rows) => fs.writeFileSync(path.join(dir, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  w('ROUNDS.jsonl', rounds || []);
  w('VOTES.jsonl', votes || []);
  w('FINDINGS.jsonl', findings || []);
  w('DUTY.jsonl', duties || []);
  return dir;
}

const T = (min) => new Date(Date.UTC(2026, 8, 17, 10, min, 0)).toISOString();
const rounds = (n, startMin) => Array.from({ length: n }, (_, i) => ({
  round: i + 1, requirement: 'R1', status: 'partial', at: T(startMin + i),
}));
const SPEC_IDS = ['R1'];

export default async function run() {
  const c = makeCtx('L24', '派活回路：责任 ∧ 无产出（本沙箱可跑）');

  const mod = await import(WARDEN);
  const { rolesHealth, rolesHealthLine, addDuty, readDuties } = mod;

  // ---------- ① addDuty 的四条硬规则
  const dir0 = mkLedger('add', { rounds: rounds(3, 0) });
  const badRole = addDuty(dir0, { role: '不存在的角色', what: '查一件很长的事情', ref: 'R1' }, SPEC_IDS);
  c.check('① 角色不在册 → 拒收', badRole.ok === false && badRole.code === 2, String(badRole.why).slice(0, 120));
  const noChannel = addDuty(dir0, { role: 'AI测试用户', what: '让它预演一下用户会不会别扭', ref: 'R1' }, SPEC_IDS);
  c.check('① 派给"无产出渠道"的席位 → 拒收（那是设计事实，不是它偷懒）',
    noChannel.ok === false && /没有产出渠道/.test(String(noChannel.why)), String(noChannel.why).slice(0, 120));
  const shortWhat = addDuty(dir0, { role: '资料员', what: '查一下', ref: 'R1' }, SPEC_IDS);
  c.check('① --what 太空 → 拒收（"查一下"不算派活）',
    shortWhat.ok === false && /实质内容/.test(String(shortWhat.why)), String(shortWhat.why).slice(0, 120));
  const badRef = addDuty(dir0, { role: '资料员', what: '查一件很长的事情，要给出处', ref: 'R999' }, SPEC_IDS);
  c.check('① --ref 指不到真需求 → 拒收（派活不能无凭据）',
    badRef.ok === false && /R999/.test(String(badRef.why)), String(badRef.why).slice(0, 120));
  const good = addDuty(dir0, { role: '资料员', what: '查清 opencode-go 的周限额口径，给出去处', ref: 'R1' }, SPEC_IDS);
  c.check('① 正控 · 合法派活 → 收下并落盘', good.ok === true && readDuties(dir0).items.length === 1, JSON.stringify(readDuties(dir0).items.length));

  // ---------- ② 派了活 + 窗口内 0 产出 ⇒ 报「派了活没干」
  const A = mkLedger('duty_missed', {
    rounds: rounds(6, 0),
    votes: [], findings: [],
    duties: [{ at: T(4), role: '资料员', what: '查清某库的用法并给出去处', ref: 'R1' }],
  });
  const lineA = rolesHealthLine(A);
  const hA = rolesHealth(A);
  c.check('② 派了活 + 0 产出 → 报「派了活没干」',
    /派了活没干/.test(lineA) && /资料员/.test(lineA),
    lineA.slice(0, 220));
  c.check('② 且该角色**真的被计成有问题**（不是只印一行字）',
    hA.roles.find((r) => r.role === '资料员').flags.some((f) => /派了活没干/.test(f)),
    JSON.stringify(hA.roles.find((r) => r.role === '资料员').flags));
  /**
   * ★ 2026-09-17 补（「审查」第二遍点名的洞）：
   *   `effective` 原来**只排**「缺席有活可干」、**不排**「派了活没干」——
   *   于是**被派了活却零产出的席位照样算"有效"**，而那正是本回路要抓的事（自相矛盾）。
   *   现在：带【硬】标记的席位一律不算有效。这条断言把它钉住。
   */
  c.check('② 被派了活却没产出的席位**不许**算进"有效"（effective 的分母洞，审查第二遍点名）',
    hA.effective === hA.scoredSeats - 1,
    `effective=${hA.effective} / scoredSeats=${hA.scoredSeats}（期望差 1：资料员被派了活却零产出）`);

  // ---------- ③ 正控：派了活且窗口内有产出 ⇒ 不许报
  const B = mkLedger('duty_done', {
    rounds: rounds(6, 0),
    votes: [],
    findings: [{ at: T(4), by: '资料员', text: '查到了：口径是这样', source: '官方文档第 3 节', ref: 'R1' }],
    duties: [{ at: T(4), role: '资料员', what: '查清某库的用法并给出去处', ref: 'R1' }],
  });
  const lineB = rolesHealthLine(B);
  c.check('③ 派了活且有产出 → **不许**报「派了活没干」（正控，防误伤）',
    !/派了活没干/.test(lineB),
    lineB.slice(0, 200));

  // ---------- ④ 没派活 + 0 产出 ⇒ 不许报「派了活没干」（没活干不许判）
  const C = mkLedger('no_duty', { rounds: rounds(6, 0), votes: [], findings: [], duties: [] });
  const lineC = rolesHealthLine(C);
  c.check('④ 没派活 + 0 产出 → 不许报「派了活没干」（只许报停摆）',
    !/派了活没干/.test(lineC) && /全线停摆/.test(lineC),
    lineC.slice(0, 200));

  // ---------- ⑤ 派活条数进见证数据
  c.check('⑤ 派活条数进那一行的见证数据（`派活 N 条`）',
    /派活 1 条/.test(lineA),
    lineA.slice(0, 160));
  c.check('⑤ 停摆时也不许把它吞掉（曾短路吞过）',
    /全线停摆/.test(lineA) && /派了活没干/.test(lineA),
    lineA.slice(0, 200));

  for (const d of [dir0, A, B, C]) {
    try { fs.rmSync(path.dirname(d), { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch (e) { /* 清不掉就算了 */ }
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '派活台账的四条硬规则都拦得住；「责任 ∧ 无产出」这条判据只在**真派了活**时才响（没派活不误伤、有产出不误伤），派活条数进见证数据，停摆时也不会被吞掉。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
