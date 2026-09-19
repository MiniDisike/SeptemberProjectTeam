#!/usr/bin/env node
/**
 * L18 · 证据闸门：**文件名在 ≠ 那是实验**（空壳文件不许给规则背书）
 *
 * 回归来源（2026-09-16 由「审查」实测坐实）：
 *   证据闸门原来**只验"这个文件名在不在"** —— 编一个不存在的 `L99` 会被拒（真拦），
 *   但**塞一个只写 `console.log('自称满意')`、没有数字也没有断言的 `L97` 却能被收进册**。
 *   ⇒ 拿一个空壳文件假称"有实验撑着"，就能给任意规则背书 ——
 *     而"一条规则是不是真被强制，不能靠读代码判，要跑一个反例看它拦不拦"正是这个 skill 的地基。
 *
 * 判据（黑盒）：
 *   负控 证据指向一个**只写 console.log 的空壳** L97 → **拒收**
 *   负控 证据指向**不存在的** L99 → 拒收（这条原来就对，留着防回归）
 *   负控 证据同时点名"一个真实验 + 一个空壳" → 拒收（**不许挑一个能看的算数**）
 *   正控 证据指向一个**真有断言**的实验 L98 → 收下，并且打印"已核过内容：N 处断言"
 *   正控 证据指向事故 id（INCIDENTS.jsonl）→ 照旧收下（不许误伤另一条路）
 */
import path from 'node:path';
import { provision, runWarden, makeCtx, grab, writeUtf8 } from './common.mjs';

const QUOTE = '证据要指得到那个实验，而且那个实验里得真有断言 —— 空壳文件不算实验。';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 空壳文件不许给规则背书
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 只写 console.log('自称满意') 的 L97 也能进册，等于"自称"就能当证据
- 必须: 点名的实验里至少有一处断言（c.check / assert / expect / throw）
- 不要: 把"文件名存在"当成"实验核实了"
- 锁定: 2026-09-17
`;

export default async function run() {
  const c = makeCtx('L18', '证据闸门：空壳文件不许给规则背书');
  const sb = provision('L18_fake_evidence', spec('session-lab-L18_fake_evidence'));
  const labDir = path.join(sb.dir, 'experiments', 'lab');

  // 空壳：只写一行 console.log，没有任何断言、没有数字
  writeUtf8(path.join(labDir, 'L97_fake_satisfaction.mjs'), "console.log('自称满意');\n");
  // 真实验：有断言、有判定
  writeUtf8(path.join(labDir, 'L98_real_check.mjs'), [
    "import { makeCtx } from './common.mjs';",
    'export default async function run() {',
    "  const c = makeCtx('L98', '一条真的会判定的实验');",
    "  c.check('这条真的会判定通过/失败', 1 + 1 === 2, '1+1=2');",
    "  return { id: 'L98', name: '真实验', status: 'PASS', pass: true, checks: c.checks, skipped: [] };",
    '}',
    '',
  ].join('\n'));
  // 事故表：留一条给"事故 id 那条路"的正控
  writeUtf8(path.join(sb.wdir, 'INCIDENTS.jsonl'), JSON.stringify({ id: 'I1', 现象: '两个项目读到了对方的守则', 对应实验: 'L3' }) + '\n');

  const run = (args) => runWarden(sb.dir, args, { sessionId: sb.sessionId });
  const propose = (id, evidence) => run(['rule', 'propose', '--id', id, '--text', `这条规则用来说清：${evidence}`, '--evidence', evidence, '--enforced', 'text']);

  // ---------- 负控①：空壳文件
  const fake = propose('R901', 'L97 实测：我很满意，已经覆盖到位');
  c.check('负控 · 证据指向**只写 console.log 的空壳** L97 → 拒收（原来会收下）',
    fake.code === 2 && /空壳/.test(fake.stdout) && /一个断言都没有/.test(fake.stdout),
    `exit=${fake.code}；${grab(fake.stdout, [/空壳|一个断言都没有/], 2).join(' | ') || '（竟然收下了）'}`);

  // ---------- 负控②：不存在的实验名
  const missing = propose('R902', 'L99 实测：这条实验根本不存在');
  c.check('负控 · 证据指向**不存在**的 L99 → 拒收（原来就对，留着防回归）',
    missing.code === 2,
    `exit=${missing.code}；${grab(missing.stdout, [/不存在/], 1).join('')}`);

  // ---------- 负控③：真实验 + 空壳混着点名 → 不许挑一个能看的算数
  const mixed = propose('R903', 'L98 实测：真实验撑着；另外也参考 L97');
  c.check('负控 · 同时点名"真实验 L98 + 空壳 L97" → 拒收（**不许挑一个能看的算数**）',
    mixed.code === 2 && /空壳/.test(mixed.stdout) && /L97/.test(mixed.stdout),
    `exit=${mixed.code}；${grab(mixed.stdout, [/空壳/], 1).join('') || '（竟然收下了）'}`);

  // ---------- 正控①：真实验
  const real = propose('R904', 'L98 实测：有断言、能判定通过/失败');
  c.check('正控 · 证据指向**真有断言**的实验 L98 → 收下（不许误伤）',
    real.code === 0 && /收进规则册/.test(real.stdout),
    `exit=${real.code}；${grab(real.stdout, [/收进规则册|证据认得/], 2).join(' | ')}`);
  c.check('正控 · 收下时**打印已核过内容**（几处断言、多少字节）—— "认得了"要说清凭什么认',
    /已核过内容/.test(real.stdout) && /处断言/.test(real.stdout),
    grab(real.stdout, [/已核过内容|证据认得/], 2).join(' | ') || '（没打印核对依据）');

  // ---------- 正控②：事故 id 那条路照旧通
  const inc = propose('R905', '事故 I1：两个项目读到了对方的守则');
  c.check('正控 · 证据指向事故 id（INCIDENTS.jsonl）→ 照旧收下（不许误伤另一条路）',
    inc.code === 0 && /事故 I1/.test(inc.stdout),
    `exit=${inc.code}；${grab(inc.stdout, [/证据认得/], 1).join('')}`);

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '空壳文件（没有断言）不再能给规则背书；真实验与事故 id 两条合法路照旧通，并且会打印"凭什么认得"。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
