#!/usr/bin/env node
/**
 * L33 · **报了 done 就必须有一次收尾对账**（R14 的强制面）
 *
 * 用户 R14 逐字：「（用户原话已隐去 —— 公开版不留逐字）」
 * 审查第二遍的原文：「对账只覆盖'最近 N 条原话指到的 R#'，**不是本轮实际干的活**。
 *   且 `warden.mjs` 里 grep `needs` 只有命令分发，**check 无任何'本轮跑没跑过'的校验** ⇒ 习惯面没过。」
 *
 * 修法：`needs`/`results` 各写一条 `.warden/RECON.jsonl`；`check` 校验
 *   「**存在某轮 status=done 且轮号 > 最后一条 kind=results 的 lastRound** ⇒ 硬失败」。
 *   ⚠ 只卡 `done`（"说做完了"那一刻）；partial/in_progress 不卡，否则每轮都要跑、就成了盖章机。
 *
 * 判据（机械，全部用**临时账本**，不碰真账本、不 spawn 子进程）：
 *   ① 有 done 轮次、但没有 RECON.jsonl ⇒ **硬失败**，且措辞点名"从来没有实现过"；
 *   ② 有 done 轮次、RECON 里的 results 覆盖到它 ⇒ **不再因此失败**（正控）；
 *   ③ results 只覆盖到更早的轮次（done 在它之后）⇒ **仍然硬失败**（不许被"跑过一次"糊弄）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from './common.mjs';

const WARDEN = 'file:///<HOME>/.dsh/skills/task-warden/warden.mjs';

function mkLedger(name, { rounds, recon }) {
  const root = path.join(os.tmpdir(), 'L33_' + name);
  const dir = path.join(root, '.warden');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.mkdirSync(dir, { recursive: true });
  // 最小 SPEC：够 parseSpec 认出 R1 就行（quote 之类会另有失败，本用例只过滤 R14 那一条）
  fs.writeFileSync(path.join(dir, 'SPEC.md'), [
    '# 需求账本', '',
    '## R1 · 一件小事', '',
    '- 原话: 这句话是编的，只为让 parseSpec 认出这条需求，逐字核对会失败但那与本用例无关',
    '- 为什么: 本用例只测 R14 的对账强制面',
    '- 必须: 有需求清单', '- 子项: 甲 | 乙',
    '- 锁定: 2026-09-17', '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'ROUNDS.jsonl'), rounds.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  if (recon) fs.writeFileSync(path.join(dir, 'RECON.jsonl'), recon.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return root;
}

const DONE = { round: 10, requirement: 'R1', status: 'done', delivered: '做完了', at: '2026-09-17T10:00:00Z', covered: ['甲', '乙'] };
const RECON_OK = [{ at: '2026-09-17T11:00:00Z', kind: 'results', session: '', planned: ['R1'], quotes: 1, gaps: 0, lastRound: 10 }];
const RECON_OLD = [{ at: '2026-09-17T09:00:00Z', kind: 'results', session: '', planned: ['R1'], quotes: 1, gaps: 0, lastRound: 5 }];

export default async function run() {
  const c = makeCtx('L33', '报了 done 就必须有一次收尾对账（R14）');

  const mod = await import(WARDEN);
  const r14Fails = (root) => mod.check(root).fails.filter((f) => /R14 对账/.test(String(f)));

  // ① 有 done、没有 RECON ⇒ 硬失败
  const a = mkLedger('no_recon', { rounds: [DONE], recon: null });
  const fa = r14Fails(a);
  c.check('① 有 done 却没有对账 ⇒ 硬失败，且点名"从来没有跑过对账"',
    fa.length === 1 && /从来没有(实现过|跑过)对账/.test(String(fa[0])),
    fa.length ? String(fa[0]).slice(0, 160) : '★ 没报 —— 那就是"习惯面没过"');

  // ② 正控：对账覆盖到那轮 ⇒ 不再因此失败
  const b = mkLedger('recon_ok', { rounds: [DONE], recon: RECON_OK });
  c.check('② 正控 · 对账覆盖到那轮 ⇒ 不再因此失败',
    r14Fails(b).length === 0,
    r14Fails(b).map((f) => String(f).slice(0, 120)).join(' | ') || '（没有这类失败）');

  // ③ 对账只覆盖更早的轮次 ⇒ 仍然失败
  const d = mkLedger('recon_old', { rounds: [DONE], recon: RECON_OLD });
  c.check('③ 对账只覆盖更早的轮次（done 在它之后）⇒ 仍然硬失败（不许被"跑过一次"糊弄）',
    r14Fails(d).length === 1,
    r14Fails(d).map((f) => String(f).slice(0, 140)).join(' | ') || '★ 没报 —— 跑过一次就永久免检，那是漏洞');

  for (const r of [a, b, d]) {
    try { fs.rmSync(r, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) } catch (e) { /* 清不掉就算了 */ }
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? 'R14 的强制面成立：报 done 而没有对账会被硬失败挡住；对账覆盖到了就放行；只覆盖更早轮次的不算数（跑过一次不等于免检）。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
