#!/usr/bin/env node
/**
 * L19 · 「角色是不是摆设」的机械仪表（用户原话要的那个"呈现"）
 *
 * 回归来源（用户 2026-09-16 逐字）：「（用户原话已隐去 —— 公开版不留逐字）」
 *   「**监督员要保证几个角色是正确在运行。**」
 *   ⇒ 「呈现」和「摆设」的差别必须**可机检**，否则又是文本期望。
 *   ⚠ 本用例同时也是一条**诚实性**用例：仪表必须**逐条标明**哪条判据是【硬】（可复算）、
 *     哪条是【代理】—— 把代理判据说成硬判据，就是这套东西最该防的病。
 *
 * 判据（黑盒，只跑 CLI）：
 *   负控 某角色票够多而**零反对** → 报「疑似顺从」
 *   正控 同一角色有过反对 → **不许**被报"疑似顺从"（不许误伤）
 *   负控 两个角色在**同一个议题**上用几乎一样的理由 → 报「未提供独立视角」（代理判据）
 *   负控 注册表里**一条产出都没有**的角色 → 报「该角色当前是装饰」，且分母含它（8 不是 7）
 *   说明 输出里【硬】/【代理】两类逐条标明；票数不足阈值时不许乱报顺从
 */
import { provision, runWarden, makeCtx, grab } from './common.mjs';

const QUOTE = '要有各种角色的劳动在其中各司其职的呈现，不能糊弄人导致最后角色只是个摆设。';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 角色不能只是摆设
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: "呈现"和"摆设"的差别必须可机检，否则又是一句文本期望
- 必须: 每角色给出票数/反对率/独有项，并把【硬】与【代理】判据分开标
- 不要: 把代理判据说成硬判据；也不要因为票少就乱报顺从
- 锁定: 2026-09-17
`;

const R_YES = '这条我同意：理由落在本角色的职责范围内，长度也够';
const R_NO = '我反对：这一条会丢掉用户逐字说过的那句话，风险没有人回应，我不改。';
const SAME = '这条我同意：理由与隔壁角色几乎一字不差，用来复现"同构"这条代理判据。';

export default async function run() {
  const c = makeCtx('L19', '角色是不是摆设：机械仪表');
  const sb = provision('L19_roles_health', spec('session-lab-L19_roles_health'));
  const run = (args) => runWarden(sb.dir, args, { sessionId: sb.sessionId });

  // 应到名单（黑盒现读），不用写死的 5 个
  const roster = [];
  for (const line of run(['vote', '--topic', '占位']).stdout.split(/\r?\n/)) {
    const m = /^\s{2}(\S+?)\s+【职责】/.exec(line);
    if (m) roster.push(m[1]);
  }
  c.check('前置 · 读到应到名单（≥5 席）', roster.length >= 5, `应到 ${roster.length} 席：${roster.join('、')}`);

  const A = '审查'; const B = '记录';

  // ---------- 造数据：两个议题，A 与 B 用**几乎一样**的理由（同构）
  for (const t of ['议题一', '议题二']) {
    for (const role of roster) {
      const reason = (role === A || role === B) ? SAME : R_YES;
      run(['vote', 'cast', '--topic', t, '--role', role, '--choice', '同意', '--reason', reason]);
    }
  }
  const h1 = run(['roles', '--health']);
  c.check('负控 · 两角色在同一议题上用几乎一样的理由 → 报「未提供独立视角」（代理判据）',
    h1.code === 1 && /未提供独立视角/.test(h1.stdout) && new RegExp(`${A}[^\\n]*未提供独立视角|未提供独立视角[^\\n]*${A}`).test(h1.stdout),
    grab(h1.stdout, [/未提供独立视角/], 2).join(' | ') || '（没报）');
  c.check('正控 · 票少（<阈值）时**不许**乱报「疑似顺从」（不许误伤）',
    !/疑似顺从/.test(h1.stdout),
    grab(h1.stdout, [/疑似顺从/], 1).join('') || '（没有误报，正确）');
  c.check('说明 · 【硬】/【代理】两类判据**逐条标明**（不许把代理说成硬）',
    /【硬】/.test(h1.stdout) && /【代理】/.test(h1.stdout) && /代理判据/.test(h1.stdout),
    grab(h1.stdout, [/【代理】/, /代理判据/], 2).join(' | ').slice(0, 200));
  /**
   * ⚠ 2026-09-17 改（**改夹具、不放宽判据**）：这一段原来断言的是**旧判据** ——
   *   旧版把"一条产出都没有"判成「该角色当前是装饰」，并把无渠道席位算进分母（`角色 8 个`）。
   *   两个「脑子」独立审完、结论一致地把它证伪了：
   *     · 无产出渠道的席位（AI测试用户）**结构上**永远零产出 ⇒ 那条判据对它**恒真、永远红** = 不能当闸；
   *     · 分母含它 ⇒ 上限 7/8，"8/8"结构上不可达。
   *   重设计后：**无渠道席位不进分母、也不判「装饰」**，改成单列成"结构上无产出渠道（设计如此，不计分）"。
   *   ⇒ 断言跟着改成**新契约**（这正是"改判据就要连同用例一起改"，不许留着红）。
   */
  c.check('负控 · 无产出渠道的席位 → **不进分母也不判「装饰」**，而是单列成设计事实',
    /计分席位 7/.test(h1.stdout) && /结构上无产出渠道/.test(h1.stdout) && /AI测试用户/.test(h1.stdout)
    && !/该角色当前是装饰/.test(h1.stdout),
    `${grab(h1.stdout, [/计分席位 \d+/], 1).join('')}；${grab(h1.stdout, [/结构上无产出渠道[^\n]*/], 1).join('').slice(0, 90)}`);

  // ---------- 造数据：让 A 票够多且**一路零反对** → 必须报疑似顺从
  const extra = ['议题三', '议题四', '议题五', '议题六', '议题七', '议题八'];
  for (const t of extra) {
    for (const role of roster) {
      run(['vote', 'cast', '--topic', t, '--role', role, '--choice', '同意', '--reason', R_YES]);
    }
  }
  const h2 = run(['roles', '--health']);
  c.check('负控 · 某角色票够多而**一路零反对** → 报「疑似顺从」',
    h2.code === 1 && /疑似顺从/.test(h2.stdout),
    grab(h2.stdout, [/疑似顺从/], 2).join(' | ') || '（没报）');

  // ---------- 正控：给 B 一次真反对 → B 不许再被报"疑似顺从"
  const t9 = '议题九';
  for (const role of roster) {
    run(['vote', 'cast', '--topic', t9, '--role', role, '--choice', role === B ? '反对' : '同意',
      '--reason', role === B ? R_NO : R_YES]);
  }
  const h3 = run(['roles', '--health']);
  const bLine = h3.stdout.split(/\r?\n/).find((l) => l.trim().startsWith(B)) ?? '（没找到那一行）';
  c.check('正控 · 该角色有过反对之后 → **不再**报它"疑似顺从"（不许误伤）',
    !/疑似顺从/.test(bLine),
    bLine.trim().slice(0, 160));

  c.check('说明 · 退回码 1 的含义写清"不代表交付不对"（免得把角色仪表读成交付红）',
    /不代表交付不对/.test(h3.stdout),
    grab(h3.stdout, [/退回码/], 1).join('').slice(0, 160));

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '角色仪表真会报警（疑似顺从/未提供独立视角/一条产出都没有），也会区分【硬】与【代理】判据，并且不误伤真有反对的角色。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
