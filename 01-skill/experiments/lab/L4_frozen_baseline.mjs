#!/usr/bin/env node
/**
 * L4 · 冻结基线实验（花一天调好的手感被改坏）
 *
 * 翻车模式：源码里的档位常量被人改了，账本还停在旧值，而**没人知道**。
 *
 * 判据（设计文档）：
 *   · `record --values` 与源码不符 → 拒收（exit 1）
 *   · 源码值被改、账本还是旧值 → `check` exit 1
 */
import path from 'node:path';
import { provision, writeUtf8, runWarden, makeCtx, grab } from './common.mjs';

const QUOTE = '把涟漪周期锁死在 1.30 秒，这个手感是我调了一天才定下来的，后面谁都不许动它。';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 涟漪周期冻结在 1.30 秒
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 这个数是手感调出来的，改了整片水面就不对了
- 必须: 源码常量保持 1.30
- 不要: 无声改掉它
- 锁定: 2026-09-16
`;

const PARAMS = `watches:
  - id: ripple_period
    label: 涟漪周期(秒)
    kind: rust_const
    file: src/ripple.rs
    name: RIPPLE_PERIOD
`;

const src = (v) => `pub const RIPPLE_PERIOD: f32 = ${v};\n`;

export default async function run() {
  const c = makeCtx('L4', '冻结基线实验：调好的手感被改坏');
  const sb = provision('L4_frozen_baseline', spec('session-lab-L4_frozen_baseline'), { paramsYml: PARAMS });
  const SRC = path.join(sb.dir, 'src', 'ripple.rs');
  writeUtf8(SRC, src('1.30'));

  const rec = (values, extra = {}) => runWarden(sb.dir, ['record', '--req', 'R1',
    '--status', extra.status ?? 'done',
    '--delivered', extra.delivered ?? '涟漪周期常量已就位',
    '--evidence', extra.evidence ?? 'src/ripple.rs:1',
    '--why', extra.why ?? '按冻结值实现',
    '--values', JSON.stringify(values)], { sessionId: sb.sessionId });

  // 1) 报对的值 → 收下
  const r1 = rec({ ripple_period: 1.30 });
  c.check('正控1 · --values 与源码一致（1.30）→ 收下',
    r1.code === 0 && /对账通过/.test(r1.stdout), `exit=${r1.code}；${grab(r1.stdout, [/对账/], 1).join('')}`);

  // 2) 报错的值 → 拒收
  const r2 = rec({ ripple_period: 0.80 });
  c.check('负控1 · --values 与源码不符（报 0.80，源码 1.30）→ 拒收',
    r2.code === 1 && /对账失败/.test(r2.stdout), `exit=${r2.code}；${grab(r2.stdout, [/对账失败/, /你写/], 2).join(' | ')}`);

  // 3) 一致时 check 干净
  const k0 = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
  c.check('正控2 · 源码与账本一致时 check exit 0',
    k0.code === 0, `exit=${k0.code}；${grab(k0.stdout, [/需求监督/], 2).join(' | ')}`);

  // 4) 把源码改坏（1.30 → 1.60），账本不动
  writeUtf8(SRC, src('1.60'));
  const k1 = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
  const warnLine = grab(k1.stdout, [/档位 ripple_period/], 1).join('');
  c.check('负控2 · 源码被改成 1.60、账本还是 1.30 → check **必须 exit 1**',
    k1.code === 1,
    `exit=${k1.code}（设计文档要求 1，实际 ${k1.code}）—— 它把漂移当成"提醒"而不是"不通过"。`);
  c.check('【实测事实】漂移确实被看见了，只是没进 exit code', !!warnLine,
    warnLine || '（连提醒都没有）');

  // 5) 缺口：把漂移后的值重新记一遍，会被"源码为准"收下 —— 冻结清单没有独立权威
  const r3 = rec({ ripple_period: 1.60 }, { why: '把源码改后的值记进账本' });
  c.check('【缺口】改坏之后重新记 1.60 会被收下（源码为准）→ 账本"跟上"了坏值，没人拦',
    r3.code === 0, `exit=${r3.code}；${grab(r3.stdout, [/已记第/, /对账/], 2).join(' | ')}`);

  // 6) 缺口（**2026-09-17 已收紧**）：--values 里写不存在的档位 id
  //    ⚠ 这条原来断言的是**缺口存在**（`code === 0`，静默收下）。现在实测 **exit=2（不再静默收下）**
  //      ⇒ 断言跟着改成"**不许静默收下**"。这正是"行为变了就要连同用例一起改"，不许留着红。
  const r4 = rec({ not_a_watch: 9.9 }, { status: 'in_progress', why: '顺手报一个不存在的档位' });
  c.check('负控 · --values 里写不存在的档位 id → **不许静默收下**（原来会，现已收紧）',
    r4.code !== 0,
    `exit=${r4.code}；${grab(r4.stdout, [/对账通过/, /用法|拒收|不存在/], 2).join(' | ')}`);

  // 7) 回改源码 + 重新记录 → 又干净了（正控3）
  writeUtf8(SRC, src('1.30'));
  rec({ ripple_period: 1.30 }, { why: '把值改回来并重新记录' });
  const k2 = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
  c.check('正控3 · 源码与账本重新一致 → check exit 0',
    k2.code === 0, `exit=${k2.code}；${grab(k2.stdout, [/需求监督/], 2).join(' | ')}`);

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    pass: ok,
    reason: ok
      ? '对账（报错值拒收）与一致性检查都成立。'
      : '「源码值被改坏 → check exit 1」**未通过**：warden 只在 stdout 打 `提醒:`，退出码仍是 0 —— ' +
        '也就是说"check exit 0 才算过"这条铁律在这里失效，冻过的值被改坏仍会被判"通过"。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
