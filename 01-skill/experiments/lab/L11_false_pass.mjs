#!/usr/bin/env node
/**
 * L11 · 假通过实验（"我啥也没查" 被报成 "我查了、没问题"）
 *
 * 回归来源：**真实 bug** —— `node warden.mjs quotes <一个不存在的路径>` 原来扫了 0 个文件，
 * 却打印「结论：没有发现查无实据的归属」并 **exit 0**。
 * 这是最坏的一类 bug：**把"没查到东西"包装成"查了没问题"**，比报错危险得多。
 *
 * 判据：
 *   负控1  0 个文件（路径写错）→ 必须 **exit 2**，并说明没扫到任何文件（不许说"没问题"）
 *   负控2  扫到了文件、但 0 处匹配 → 输出必须能和"查了没问题"**区分开**（明说"扫了 N 个文件、0 处"）
 *   正控1  有伪造归属的文档 → exit 1
 *   正控2  全是真原话的文档 → exit 0，且说清扫了几个文件
 */
import path from 'node:path';
import { provision, writeUtf8, runWarden, makeCtx, grab } from './common.mjs';

const QUOTE = '假通过与真通过必须能区分：扫了 0 个文件，就不许报"没有发现问题"。';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 假通过与真通过必须能区分
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 把"我啥也没查"报成"查了、没问题"，比直接报错危险得多
- 必须: 输入为 0 时 exit 2；0 处匹配要明说扫了几个文件
- 不要: 用"没有问题"掩盖"没查"
- 锁定: 2026-09-16
`;

export default async function run() {
  const c = makeCtx('L11', '假通过实验：没查被报成查了没问题');
  const sb = provision('L11_false_pass', spec('session-lab-L11_false_pass'));

  // 三份样本
  writeUtf8(path.join(sb.dir, 'empty_ok.md'),
    '# 一份没有任何「归给用户」写法的文档\n\n- 这里只是普通说明文字，没有把话归给谁。\n');
  writeUtf8(path.join(sb.dir, 'bad.md'),
    '# 含伪造归属的文档\n\n## A\n- 用户原话：「某功能要在最后阶段一次做完，别分期」\n');
  writeUtf8(path.join(sb.dir, 'good.md'),
    `# 全是真原话的文档\n\n## B\n- 用户原话：「${QUOTE}」\n`);

  // 负控1：路径不存在 → 0 个文件
  const missing = runWarden(sb.dir, ['quotes', 'no_such_file_xyz.md'], { sessionId: sb.sessionId });
  c.check('负控1 · 传一个不存在的路径 → exit 2，且不许报"没有发现问题"',
    missing.code === 2
      && /没扫到|0 个文件|不存在|扫了 0/.test(missing.stdout)
      && !/没有发现查无实据的归属/.test(missing.stdout),
    `exit=${missing.code}；${grab(missing.stdout, [/扫了/, /没查到|没问题|不存在/], 2).join(' | ')}`);

  // 负控2：扫到文件但 0 处匹配 → 必须能与"查了没问题"区分
  const empty = runWarden(sb.dir, ['quotes', 'empty_ok.md'], { sessionId: sb.sessionId });
  c.check('负控2 · 扫到 1 个文件、0 处匹配 → 明说"扫了 N 个文件、0 处"（不是"没问题"）',
    empty.code === 0 && /扫了\s*1\s*个文件/.test(empty.stdout) && /0 处/.test(empty.stdout)
      && /没查到东西|不是「查了没问题」/.test(empty.stdout),
    `exit=${empty.code}；${grab(empty.stdout, [/扫了/, /0 处/], 2).join(' | ')}`);

  // 正控1：有伪造归属 → exit 1
  const bad = runWarden(sb.dir, ['quotes', 'bad.md'], { sessionId: sb.sessionId });
  c.check('正控1 · 有伪造归属 → exit 1 且点名"查无实据"',
    bad.code === 1 && /查无实据/.test(bad.stdout),
    `exit=${bad.code}；${grab(bad.stdout, [/查无实据/, /结论：/], 2).join(' | ')}`);

  // 正控2：全是真原话 → exit 0，且说清扫了几个文件
  const good = runWarden(sb.dir, ['quotes', 'good.md'], { sessionId: sb.sessionId });
  c.check('正控2 · 全是真原话 → exit 0，且"逐字对上"并报出扫了 1 个文件',
    good.code === 0 && /逐字对上/.test(good.stdout) && /扫了\s*1\s*个文件/.test(good.stdout),
    `exit=${good.code}；${grab(good.stdout, [/逐字对上/, /扫了/], 2).join(' | ')}`);

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    pass: ok,
    reason: ok
      ? '0 个文件 → exit 2 且不谎报"没问题"；0 处匹配与"查了没问题"能区分；有伪造归属 exit 1、全真原话 exit 0。'
      : '有检查未通过（见下）—— "没查"仍可能被报成"查了没问题"。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
