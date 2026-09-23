#!/usr/bin/env node
/**
 * L20 · 角色说话要**直接显示**（`名字 · 职称：原话`），不许被主代理转述
 *
 * 回归来源（用户 2026-09-17 逐字，见 skill 账本 SPEC 的 R6）：「（用户原话已隐去 —— 公开版不留逐字）」
 *   ⇒ ① 角色发言有**逐字的家**（`ROLE_SPEECH.jsonl`）；
 *     ② 显示形态是 **`名字 · 职称：原话`**；
 *     ③ 主代理"转述掉角色的话"这件事**能被查出来**（启发式，且必须如实标明是启发式）。
 *
 * 判据（黑盒）：
 *   正控 `role say` 打出来的一行 = `名字 · 职称：原话`，而且**原话一个字没被改**（逐字比对）
 *   正控 发言落进 `ROLE_SPEECH.jsonl`，role/title/text 都在，可反查
 *   负控 `--role` 写错名字 → exit 2（写错名字的发言将来没人能反查是谁说的）
 *   负控 一份只有"审查说…/记录认为…"的产物 → `role scan` **必须命中并 exit 1**
 *   正控 一份带 `名字 · 职称：原话` 的产物 → `role scan` exit 0（不许误伤正牌发言）
 *   说明 转述检测的输出里必须**自己声明这是启发式**（命中≠证明转述）
 */
import fs from 'node:fs';
import path from 'node:path';
import { provision, runWarden, makeCtx, grab, readUtf8, writeUtf8, readJsonl } from './common.mjs';

const QUOTE = '角色说的话就这样显示了，AI不会把角色的话隐藏，然后通过自己来转述谁谁谁说了什么让我怎么样。这样的上下文干净。';

const spec = (sid) => `# 需求锁定表（append-only）

## R6 · 角色说话要直接显示（名字 · 职称：原话）
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 转述是二次加工，就是漂移的入口（A3 一个"不"字把缺陷写成正常）
- 必须: 角色发言有逐字的家；显示形态是「名字 · 职称：原话」；名字与职称只有一张表
- 不要: 把角色的判定压成主代理自己的一句话；把原话截断/改写后当原话用
- 锁定: 2026-09-17
`;

// 一句"角色的原话"，故意带上标点与引号，用来验证**逐字**（不许被清洗）
const SPEECH = '这条我不认：enforced 标的 text，可它明明是被 exit code 拦的 —— 按「写进代码 ≠ 拦得住」，先跑个反例再定。';

export default async function run() {
  const c = makeCtx('L20', '角色说话直接显示（名字 · 职称：原话），不许被转述');
  const sb = provision('L20_role_speech', spec('session-lab-L20_role_speech'));
  const run = (args) => runWarden(sb.dir, args, { sessionId: sb.sessionId });

  // ---------- 正控①：显示形态 + 逐字
  const said = run(['role', 'say', '--role', '审查', '--text', SPEECH, '--ref', 'R6']);
  const firstLine = String(said.stdout).split(/\r?\n/)[0];
  c.check('正控 · `role say` 打出来的一行是 `名字 · 职称：原话`',
    said.code === 0 && /^审查\s*·\s*[^：:\n]+：/.test(firstLine),
    `exit=${said.code}；第一行=${firstLine.slice(0, 90)}`);
  c.check('正控 · **原话一个字没被改**（含标点/引号都逐字对上，不许清洗或截断）',
    firstLine.includes(SPEECH),
    firstLine.includes(SPEECH) ? '逐字对上' : `期望含：${SPEECH.slice(0, 60)}…\n        实际：${firstLine.slice(0, 120)}`);

  // ---------- 正控②：落盘可反查
  const rows = readJsonl(path.join(sb.wdir, 'ROLE_SPEECH.jsonl'));
  const rec = rows[rows.length - 1] ?? {};
  c.check('正控 · 发言落进 ROLE_SPEECH.jsonl，role/title/text 都在（可反查"谁在啥时候原话说了什么"）',
    rows.length === 1 && rec.role === '审查' && String(rec.title ?? '').trim() && rec.text === SPEECH,
    `条数=${rows.length} role=${rec.role} title=${rec.title} 逐字=${rec.text === SPEECH}`);

  // ---------- 负控①：名字写错
  const bad = run(['role', 'say', '--role', '审查员', '--text', '名字写错了的发言']);
  c.check('负控 · `--role` 写错名字 → exit 2（写错名字的发言将来没人能反查是谁说的）',
    bad.code === 2 && /不是角色注册表里的名字/.test(bad.stdout),
    `exit=${bad.code}；${grab(bad.stdout, [/拒收/], 1).join('')}`);

  // ---------- 负控②：只有转述的产物 → 必须命中
  const paraphraseDoc = path.join(sb.dir, 'paraphrase.md');
  writeUtf8(paraphraseDoc, '# 汇报\n\n审查说这样不行，记录也认为口径不对，方向员建议再等等。\n');
  const scanBad = run(['role', 'scan', 'paraphrase.md']);
  c.check('负控 · 只有"审查说…/记录认为…"的产物 → `role scan` **命中并 exit 1**',
    scanBad.code === 1 && /疑似转述/.test(scanBad.stdout) && /审查说/.test(scanBad.stdout),
    `exit=${scanBad.code}；${grab(scanBad.stdout, [/疑似转述/], 1).join('')}`);

  // ---------- 正控③：带正牌发言的产物 → 放行
  const goodDoc = path.join(sb.dir, 'verbatim.md');
  writeUtf8(goodDoc, `# 汇报\n\n审查 · 证据审查员：${SPEECH}\n记录 · 事实记录员：三个数我复算过，对得上。\n`);
  const scanGood = run(['role', 'scan', 'verbatim.md']);
  c.check('正控 · 带 `名字 · 职称：原话` 的产物 → `role scan` exit 0（不许误伤正牌发言）',
    scanGood.code === 0 && /没扫到/.test(scanGood.stdout),
    `exit=${scanGood.code}`);

  // ---------- 说明：必须自己声明是启发式
  c.check('说明 · 转述检测的**输出里自己写着"这是启发式、命中≠证明"**（不许把代理判据说成硬判据）',
    /启发式/.test(scanBad.stdout) && /不代表你一定转述错了|命中 ≠ 证明|命中说明/.test(scanBad.stdout),
    grab(scanBad.stdout, [/启发式/], 2).join(' | '));

  // ---------- 说明：职称表只有一张（写进 help 里也是注册表来的）
  const helpOut = run(['role', 'say']);
  c.check('说明 · 用法提示里列出的角色名**来自注册表**（不是手写的第二份名单）',
    /监督员/.test(helpOut.stdout) && /AI测试用户/.test(helpOut.stdout) && /资料员/.test(helpOut.stdout),
    grab(helpOut.stdout, [/只能是注册表里的/], 1).join('').slice(0, 160));

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '角色发言有逐字的家、显示成「名字 · 职称：原话」；只有转述的产物会被 scan 命中，带原话的放行；且明说了这是启发式。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
