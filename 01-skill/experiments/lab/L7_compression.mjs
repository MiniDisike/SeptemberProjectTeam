#!/usr/bin/env node
/**
 * L7 · 压缩实验（长会话后失忆）
 *
 * 用户最痛的一条：每个窗口人类说过的话丢进去，很快会被忽视。
 * 测法只有一个（见 `压缩测试协议.md`）：**压缩前落盘 → 压缩 → 看它还知不知道**。
 *
 * ⚠ 诚实的边界：真正的"上下文压缩"是 DSH 对**活体会话**做的事，实验台是独立 node 进程，
 * **无法触发压缩**。所以这里做两件事：
 *   ① 能机械判定的部分，全部真跑：SPEC.md / VOICE.jsonl / ROUNDS.jsonl 在"换一个全新进程
 *      （= 内存里什么都没有，和压缩后一样）跑一圈工具"前后**逐字不变**；归属核查仍能验真；
 *      架构图仍知道哪条支线从没被碰过。
 *   ② 做不到的部分（T1/T2/T3/T4/T5 的真压缩场景）**如实标 skipped**，写清为什么，不假装通过。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  LAB_ROOT, SELFTEST, provision, writeUtf8, runWarden, runNode, makeCtx, grab, sha256File, readUtf8,
} from './common.mjs';

const QUOTE = '用户说过的每一句话都要逐字落盘，压缩之后还得能查得到，不能被悄悄改写。';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 原话要活过压缩
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 汇总本身就会丢信息，压缩又把上下文删一遍
- 必须: 原话逐字可查
- 不要: 在压缩里被改写
- 锁定: 2026-09-16
`;

const ARCH = `# 架构总图

- 总目标: 让 task-warden 扛住上下文压缩
- 归属: 用户原话
- 原话: ${QUOTE}

## A · 外置记忆
- 归属: AI提案
- 理由: 把为什么这么定、决定过什么都写到磁盘上
- 子项:
- SPEC 与 VOICE 落盘 [R1] 关键词: 落盘
- 轮次账本 [R1] 关键词: 账本

## B · 木材工艺链
- 归属: AI提案
- 理由: 这一整条支线一直没人碰，压缩后最容易丢
- 子项:
- 砍树
- 原木处理
`;

export default async function run() {
  const c = makeCtx('L7', '压缩实验：长会话后失忆');
  const sb = provision('L7_compression', spec('session-lab-L7_compression'));
  writeUtf8(path.join(sb.wdir, 'ARCH.md'), ARCH);

  runWarden(sb.dir, ['record', '--req', 'R1', '--status', 'done', '--delivered', '外置记忆落盘',
    '--evidence', '.warden/SPEC.md:1', '--why', '把原话与快照写到磁盘'], { sessionId: sb.sessionId });

  // ---------- T0 工具健康：selftest 必须在**没有 .git / 没有 .warden** 的中性目录里跑
  // （selftest 的假工程靠"最近的有 .warden 的祖先"认根；如果 cwd 在沙箱里，会串到沙箱的 .git）
  {
    const neutral = path.join(LAB_ROOT, '_selftest_run');
    fs.mkdirSync(neutral, { recursive: true });
    const r = runNode(neutral, SELFTEST, [], { timeout: 300000 });
    c.check('T0 · 工具健康：selftest.mjs（16 负控 + 3 正控）exit 0',
      r.code === 0,
      `exit=${r.code}；${grab(r.stdout, [/负控 .* 正控/, /\[自检\]/], 2).join(' | ') || r.stderr.slice(0, 200)}`);
  }

  // ---------- 落盘 → 快照指纹
  const v1 = runWarden(sb.dir, ['voices'], { sessionId: sb.sessionId });
  const FILES = ['SPEC.md', 'VOICE.jsonl', 'ROUNDS.jsonl'].map((f) => path.join(sb.wdir, f));
  c.check('① 窗口传递层落盘：VOICE.jsonl 建起来了，且逐字含用户原话',
    fs.existsSync(FILES[1]) && readUtf8(FILES[1]).includes(QUOTE),
    `voices exit=${v1.code}；${grab(v1.stdout, [/累计/, /新增/], 2).join(' | ')}`);

  const before = FILES.map((f) => ({ f, sha: sha256File(f), bytes: fs.statSync(f).size }));
  if (!before[1].bytes) throw new Error('VOICE.jsonl 是空的，实验前提不成立');

  // ---------- "压缩"：全新进程再跑一圈工具（进程内存全丢，只剩磁盘）
  const ck = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
  const mp = runWarden(sb.dir, ['map'], { sessionId: sb.sessionId });
  const rp = runWarden(sb.dir, ['report'], { sessionId: sb.sessionId });
  const v2 = runWarden(sb.dir, ['voices'], { sessionId: sb.sessionId });
  c.check('② 压缩后（全新进程）check / map / report / voices 都能正常跑',
    ck.code === 0 && mp.code === 0 && rp.code === 0 && v2.code === 0,
    `exit: check=${ck.code} map=${mp.code} report=${rp.code} voices=${v2.code}`);

  const after = FILES.map((f) => ({ f, sha: sha256File(f), bytes: fs.statSync(f).size }));
  const changed = before.filter((b, i) => b.sha !== after[i].sha).map((b) => path.basename(b.f));
  c.check('③ SPEC.md / VOICE.jsonl / ROUNDS.jsonl 压缩前后**逐字不变**（sha256 相同）',
    changed.length === 0,
    changed.length ? `变了：${changed.join(', ')}` : before.map((b) => `${path.basename(b.f)}=${b.sha.slice(0, 12)}`).join(' '));

  const dup = /新增\s*(\d+)\s*条/.exec(v2.stdout);
  c.check('④ 再同步一次不产生重复（append-only，靠 session|text 去重）',
    dup && dup[1] === '0', grab(v2.stdout, [/新增/, /累计/], 2).join(' | '));

  // ---------- 归属核查在"压缩后"仍然验真
  writeUtf8(path.join(sb.dir, 'probe.md'), `# 压缩后归属核查\n\n## P1\n- 用户原话：「${QUOTE}」\n`);
  const q = runWarden(sb.dir, ['quotes', 'probe.md'], { sessionId: sb.sessionId });
  c.check('⑤ 压缩后 quotes 仍能验真（真原话=verbatim）',
    /逐字对上/.test(q.stdout) && q.code === 0,
    `exit=${q.code}；${grab(q.stdout, [/逐字对上/, /结论：/], 2).join(' | ')}`);

  // ---------- T4 代理：架构图仍然知道"哪条支线从没被碰过"
  /**
   * ⚠ 措辞在本轮改过（实测洞：原来无论有没有判据都写「**从未动过**」——
   *   而 26 条支线里 18 条挂靠数 = 0，那种情况下"从未动过"很可能是**账本没记**，不是**产品没有**）。
   *   现在有三种说法：有判据但没命中 → 「账本里没记过」；连判据都没有 → 「判断不了」。
   *   ⇒ 这条控**不再钉死某一个词**，改成**钉死语义**：B 支线必须仍被判为"没动过 / 判断不了"，
   *     并且**仍然出现在图里**（外置记忆没把这条支线弄丢）。钉死旧词就是让用例跟着实现一起过期。
   */
  const notMoved = /从未动过|账本里没记过|判断不了/.test(mp.stdout);
  const bVisible = /B\b/.test(mp.stdout);
  c.check('⑥ T4 代理 · 压缩后 map 仍把 B 支线报成"没动过/判断不了"，且**支线没在图上丢掉**',
    notMoved && bVisible && mp.code === 0,
    grab(mp.stdout, [/从未动过/, /账本里没记过/, /判断不了/, /支线失衡/], 2).join(' | '));

  // ---------- 如实标注做不到的部分
  c.skip('T1 原话扛过**真**上下文压缩', '真压缩由 DSH 对活体会话执行，实验台是独立 node 进程，无法触发；已用"全新进程 + 指纹不变 + quotes 仍验真"做代理（见 ③⑤）。');
  c.skip('T2 替代品拦截（真压缩后）', '同上；其机械部分已由 L1 覆盖（未申报的替代品被 check exit 1 拦下）。');
  c.skip('T3 昂贵值保护（真压缩后）', '同上；其机械部分已由 L4 覆盖 —— 且 L4 实测出 warden 对档位漂移只 warn、不 fail。');
  c.skip('T4 支线守门（真压缩后）', '真判据是"压缩后 AI 的第一次回答里主动提到被丢的支线"，需要活体 agent；已用 ⑥ 做机械代理。');
  c.skip('T5 压缩后第一个动作是不是先读 .warden/', '观察活体会话压缩后的首个动作，无机械触发手段；需要人工按《压缩测试协议.md》在真实窗口里跑。');

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    pass: ok,
    reason: ok
      ? `机械部分全过（工具健康、三份外置记忆逐字不变、quotes 仍验真、支线仍可见）；真压缩相关的 5 项如实 skipped。`
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
