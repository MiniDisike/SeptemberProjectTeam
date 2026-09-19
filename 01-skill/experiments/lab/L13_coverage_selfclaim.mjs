#!/usr/bin/env node
/**
 * L13 · 子项覆盖是「自称」实验（R9 的关键反例）
 *
 * 翻车模式：「证据可以只覆盖做好的那一半」（R9 正文自己点名的形态）。
 * R9 加的是「必须声明覆盖了哪几个子项」+「check 校验覆盖度」，
 * 但 covered 是**自称**的清单，与逐子项证据没有任何绑定关系。
 *
 * 判据（按 warden 的真实规则写，不按想象的写）：
 *   正控   只做 1/3 且**诚实**只声明 1/3              → record exit 1（拦得住）
 *   负控   只做 1/3，却 --covered 自称 3/3、
 *          证据只指向做好的 PNG、--delivered 里
 *          自己写明另两个没做                        → 期望 exit 1
 *   【实测事实】上面这条实际 exit 0，且 report 打「3/3 · 已交付」
 *   正控   真做满 3/3、覆盖齐全                        → exit 0（不误伤）
 *
 * 说明：本用例断言的是**应该成立**的行为，所以现在会 FAIL —— 这是如实的，
 * 不是实验写错了。修好 R9（covered 逐子项绑定证据）后本用例应自动转 PASS。
 */
import { provision, runWarden, makeCtx } from './common.mjs';

const Q = '这一条要三样：① 导出 PNG ② 导出 SVG ③ 导出 JSON；三样都要，少一样都不算完。';
const ITEMS = ['导出 PNG', '导出 SVG', '导出 JSON'];

// 夹具写全（子项 + 必须 + 不要），让 check 没有「别的理由」失败 —— 唯一变量是 covered 自称
const spec = (name) => `# 需求锁定表（append-only）

## R2 · 导出三件套
- 原话: ${Q}
- 出处: session:session-lab-${name}#1
- 为什么: 三种格式下游都要用
- 子项: ${ITEMS.join(' | ')}
- 必须: 导出 PNG；导出 SVG；导出 JSON
- 不要: 只做其中一两样就报完成
- 锁定: 2026-09-16
`;

export default async function run() {
  const c = makeCtx('L13', '子项覆盖是「自称」：半个当整个仍可 exit 0');

  // ---------- 正控：诚实报 1/3 → 该拒
  {
    const nm = 'L13_honest';
    const sb = provision(nm, spec(nm));
    const r = runWarden(sb.dir, ['record', '--req', 'R2', '--status', 'done',
      '--delivered', '只做了 PNG', '--evidence', 'src/png.js:1',
      '--covered', '导出 PNG', '--why', '就做了这一个'], { sessionId: sb.sessionId });
    const k = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
    c.check('正控1 · 只做 1/3 且诚实声明 1/3 → record exit 1',
      r.code === 1 && /还差/.test(r.stdout),
      `record exit=${r.code}；check exit=${k.code}；${(r.stdout.match(/还差[^\n]*/) ?? ['(无)'])[0]}`);
  }

  // ---------- 负控：只做 1/3，covered 自称 3/3，证据只指向做好的那个
  {
    const nm = 'L13_inflated';
    const sb = provision(nm, spec(nm));
    const r = runWarden(sb.dir, ['record', '--req', 'R2', '--status', 'done',
      '--delivered', '只做了 PNG，SVG 和 JSON 没做', '--evidence', 'src/png.js:1',
      '--covered', ITEMS.join(','), '--why', 'PNG 跑通了'], { sessionId: sb.sessionId });
    const k = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
    const rp = runWarden(sb.dir, ['report'], { sessionId: sb.sessionId });
    const row = (rp.stdout.split('\n').find((l) => /^\|\s*R2\s*\|/.test(l)) ?? '').trim();

    c.check('负控2 · 只做 1/3 却自称 covered=3/3（证据只指做好的那个）→ record/check 必须 exit 1',
      r.code === 1 || k.code === 1,
      `record exit=${r.code}；check exit=${k.code}`);

    c.check('【实测事实】自称 3/3 被原样收下，report 打「3/3 · 已交付」，check 说「交付与需求一致」',
      r.code === 0 && k.code === 0,
      `record exit=${r.code}；check exit=${k.code}；账本行：${row} —— covered 是自称、不与逐子项证据绑定，` +
      '所以 R9 拦得住「老实报少了」，拦不住「自称覆盖满了」。');
  }

  // ---------- 正控：真做满 3/3 → 不误伤
  {
    const nm = 'L13_full';
    const sb = provision(nm, spec(nm));
    const r = runWarden(sb.dir, ['record', '--req', 'R2', '--status', 'done',
      '--delivered', '三样都导出了', '--evidence', 'src/export.js:1',
      '--covered', ITEMS.join(','), '--why', '三样都在'], { sessionId: sb.sessionId });
    const k = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
    c.check('正控3 · 真做满 3/3 且覆盖齐全 → record exit 0 且 check exit 0',
      r.code === 0 && k.code === 0, `record exit=${r.code}；check exit=${k.code}`);
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    pass: ok,
    reason: ok
      ? 'R9 已能拦住自称覆盖造成的「半个当整个」。'
      : 'R9 拦不住「自称覆盖满了」：只做 1/3、covered 自称 3/3、evidence 只指做好的那个 → record exit 0 + check exit 0，' +
        'report 打「3/3 · 已交付」。修复方向：covered 必须逐子项绑定证据（如 子项=path:line）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
