#!/usr/bin/env node
/**
 * L2 · 半成品实验（只解决半个）
 *
 * 翻车模式：「跑了一小时上亿的 token，关键问题几个只解决了半个」——
 * 一条需求带 3 个子项，只做 2 个就报 done。
 *
 * 判据（**按 warden 的真实规则写**，不按想象的写）：
 *   负控1  报 done 不给证据                        → check exit 1
 *   负控2  报 partial 不写 --missing_half          → check exit 1
 *   正控   3 个子项都做、都有证据                  → check exit 0
 *   诊断   只做 2/3 但**写了证据**                  → warden 抓不到（记成已知缺口，不当通过糊弄）
 */
import { provision, runWarden, makeCtx, grab } from './common.mjs';

const QUOTE = '这一条要三样：① 导出 PNG ② 导出 SVG ③ 导出 JSON；三样都要，少一样都不算完。';

const spec = (sid) => `# 需求锁定表（append-only）

## R2 · 导出三件套
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 三种格式下游都要用，少一种下游就得自己转
- 必须: 导出 PNG；导出 SVG；导出 JSON
- 不要: 只做其中一两样就报完成
- 锁定: 2026-09-16
`;

export default async function run() {
  const c = makeCtx('L2', '半成品实验：只解决半个');
  const sid = 'session-lab-L2_half_done';

  // ---------- 负控1：报 done，无证据
  {
    const sb = provision('L2_half_done', spec(sid));
    const r = runWarden(sb.dir, ['record', '--req', 'R2', '--status', 'done',
      '--delivered', '导出了 PNG 和 SVG（JSON 还没做）', '--why', '这两种先跑通了'],
      { sessionId: sb.sessionId });
    const k = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
    c.check('负控1 · 报 done 不给证据 → 被拒（check exit 1）',
      k.code === 1 && /标了 done 但没给证据/.test(k.stdout),
      `record exit=${r.code}（记录本身被收下）；check exit=${k.code}；${grab(k.stdout, [/标了 done 但没给证据/], 1).join('')}`);
  }

  // ---------- 负控2：报 partial，不写 --missing_half
  {
    const sb = provision('L2_partial_no_missing', spec(sid));
    const r = runWarden(sb.dir, ['record', '--req', 'R2', '--status', 'partial',
      '--delivered', '导出了 PNG 和 SVG', '--evidence', 'src/export.js:10',
      '--why', 'JSON 那条留到下一轮'], { sessionId: sb.sessionId });
    const k = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
    c.check('负控2 · partial 不写 --missing_half → 被拒（check exit 1）',
      k.code === 1 && /标了 partial 但没写/.test(k.stdout),
      `record exit=${r.code}（**write 时不拦**，只提示"别忘了 check"）；check exit=${k.code}；${grab(k.stdout, [/partial/], 1).join('')}`);
  }

  // ---------- 正控：3 个子项都做、都有证据
  {
    const sb = provision('L2_all_three', spec(sid));
    const items = [
      ['导出 PNG', 'src/export/png.js:1'],
      ['导出 SVG', 'src/export/svg.js:1'],
      ['导出 JSON', 'src/export/json.js:1'],
    ];
    for (const [d, e] of items) {
      runWarden(sb.dir, ['record', '--req', 'R2', '--status', 'done',
        '--delivered', d, '--evidence', e, '--why', `${d} 已实现并被测试调用`], { sessionId: sb.sessionId });
    }
    const k = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
    c.check('正控 · 3 个子项都做且有证据 → check exit 0（不误伤）',
      k.code === 0, `check exit=${k.code}；${grab(k.stdout, [/需求监督/], 2).join(' | ')}`);
  }

  // ---------- 诊断（**已知缺口**，不是通过）：只做 2/3 但有证据
  {
    const sb = provision('L2_two_of_three', spec(sid));
    runWarden(sb.dir, ['record', '--req', 'R2', '--status', 'done',
      '--delivered', '导出了 PNG 和 SVG', '--evidence', 'src/export.js:10',
      '--why', '三样里的两样已经跑通'], { sessionId: sb.sessionId });
    const k = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
    c.check('【缺口】只做 2/3 子项、但写了证据 → warden 放行（exit 0）：子项级漏做抓不到',
      k.code === 0,
      `check exit=${k.code} —— warden 只校验「done 有没有证据 / partial 有没有 missing_half」，` +
      '它不知道这条需求有几个子项，所以"半个当整个"只要附了任意证据就过。这是真实缺口，不是实验失败。');
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    pass: ok,
    reason: ok
      ? 'done 无证据、partial 无 missing_half 都抓到了，三条都有证据时放行；同时实测到"子项级漏做"抓不到（已如实列为缺口）。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
