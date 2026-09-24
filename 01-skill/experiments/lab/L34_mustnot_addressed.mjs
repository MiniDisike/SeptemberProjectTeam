#!/usr/bin/env node
/**
 * L34 · **每一条「不要」都必须被逐条交代**（2026-09-17 真实事故：隔壁窗口一用就失灵）
 *
 * 事故现场（从 `session-91112cb7` 的日志逐条挖出来的）：
 *   用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」
 *   隔壁窗口**确实**把它锁进了 SPEC（`R7 不要: 不要把方向锁成平面（用户逐字：…）`），
 *   也**确实**跑了 check（日志里 `需求监督通过` 出现 7 次、`check exit=0`），
 *   然后交付了一个**锁在一张平面上**的实现 —— 用户当场否掉，才补出 R11。
 *
 * **根因**：旧的「交付物撞不要」判据是 `deliveredBlob.includes(不要那句话)` ——
 *   拿**一整句自然语言**去 `includes` **交付散文**，而"不要"天生就是一句话
 *   ⇒ **结构上永远不可能响**（那个会话里 `你说过**不要**` 命中 **0 次**，而 R7 的"不要"在 SPEC 里躺了 6 次）。
 *
 * **修法**（与 `--covered` 同一套）：`done` 时若该需求有「不要」项，
 *   必须逐条给 `--avoided "不要项=怎么避开的"`；`check` 对**已经标了 done 的历史轮次**同样校验。
 *
 * 判据（机械，用**临时账本**，不碰真账本、不 spawn 子进程）：
 *   ① 有「不要」+ 标 done + **没交代** ⇒ `check` **硬失败**，且逐条列出没交代的是哪几条；
 *   ② 正控：逐条交代了 ⇒ **不再因此失败**；
 *   ③ 负控：**只交代了一部分** ⇒ 仍硬失败（不许"交代一条算全交代"）；
 *   ④ 负控：**没有「不要」**的需求标 done ⇒ 不受这条影响（防误伤）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from './common.mjs';

const WARDEN = 'file:///<HOME>/.dsh/skills/task-warden/warden.mjs';

function mkLedger(name, { spec, rounds }) {
  const root = path.join(os.tmpdir(), 'L34_' + name);
  const dir = path.join(root, '.warden');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SPEC.md'), spec, 'utf8');
  fs.writeFileSync(path.join(dir, 'ROUNDS.jsonl'), rounds.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return root;
}

const SPEC_WITH = [
  '# 需求账本', '',
  '## R1 · 自由创作', '',
  '- 原话: 这是一句编的原话，只为让 parseSpec 认出这条需求（逐字核对会失败，与本用例无关）',
  '- 为什么: 本用例只测「不要」的强制面',
  '- 必须: 方向自由',
  '- 不要: 不要把方向锁成平面；不许把刷子钉成原点',
  '- 子项: 甲 | 乙',
  '- 锁定: 2026-09-17', '',
].join('\n');

const SPEC_WITHOUT = SPEC_WITH.replace('- 不要: 不要把方向锁成平面；不许把刷子钉成原点\n', '');

const round = (o) => Object.assign({ round: 10, requirement: 'R1', status: 'done', delivered: '做完了', at: '2026-09-17T10:00:00Z', covered: ['甲', '乙'] }, o);

export default async function run() {
  const c = makeCtx('L34', '每条「不要」都必须被逐条交代');

  const mod = await import(WARDEN);
  const hit = (root) => mod.check(root).fails.filter((f) => /没有被交代过/.test(String(f)));

  // ① 有「不要」+ done + 没交代 ⇒ 硬失败，并列出是哪几条
  const a = mkLedger('no_avoided', { spec: SPEC_WITH, rounds: [round({})] });
  const fa = hit(a);
  c.check('① 标了 done 却没交代「不要」⇒ 硬失败', fa.length === 1, fa.length ? String(fa[0]).slice(0, 170) : '★ 没报 —— 那这条判据又成了死的');
  c.check('① 且**逐条列出**没交代的是哪几条（不是只说"有几条"）',
    fa.length === 1 && String(fa[0]).includes('不要把方向锁成平面') && String(fa[0]).includes('不许把刷子钉成原点'),
    fa.length ? String(fa[0]).slice(0, 240) : '');

  // ② 正控：逐条交代 ⇒ 放行
  const b = mkLedger('ok', {
    spec: SPEC_WITH,
    rounds: [round({ avoided: ['不要把方向锁成平面=画布锚在活刷尖，随鼠标移动', '不许把刷子钉成原点=刷尖每帧跟鼠标更新'] })],
  });
  c.check('② 正控 · 逐条交代了 ⇒ 不再因此失败', hit(b).length === 0,
    hit(b).map((f) => String(f).slice(0, 120)).join(' | ') || '（没有这类失败）');

  // ③ 负控：只交代一条 ⇒ 仍失败
  const d = mkLedger('partial_avoided', {
    spec: SPEC_WITH,
    rounds: [round({ avoided: ['不要把方向锁成平面=画布锚在活刷尖'] })],
  });
  const fd = hit(d);
  c.check('③ 负控 · 只交代一条 ⇒ 仍硬失败（不许"交代一条算全交代"）',
    fd.length === 1 && String(fd[0]).includes('不许把刷子钉成原点'),
    fd.length ? String(fd[0]).slice(0, 170) : '★ 没报 —— 那就能靠交代一条糊弄过去');

  // ④ 负控：没有「不要」⇒ 不受影响
  const e = mkLedger('no_mustnot', { spec: SPEC_WITHOUT, rounds: [round({})] });
  c.check('④ 负控 · 没有「不要」的需求标 done ⇒ 不受这条影响（防误伤）',
    hit(e).length === 0, hit(e).map((f) => String(f).slice(0, 120)).join(' | ') || '（没有这类失败）');

  for (const r of [a, b, d, e]) {
    try { fs.rmSync(r, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) } catch (err) { /* 清不掉就算了 */ }
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '「不要」有强制面了：标 done 却没交代会被硬失败并逐条点名；交代齐了放行；只交代一部分不算；没有「不要」的不受牵连。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
