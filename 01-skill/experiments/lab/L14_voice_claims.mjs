#!/usr/bin/env node
/**
 * L14 · 原话认领闸（用户说过的 ↔ 我们在做的）
 *
 * 回归来源（真实事故 I26）：用户提过角色说话要像网游聊天区的显示风格（角色名更小更细灰色、`某某某：XXX`）
 * 以及真正在栏目里滚动的模样，查证：`SPEC/MAP/ARCH/REPORT/DEVIATIONS/ROUNDS` 里
 * `滚动|栏目|聊天区|角色名|字号|字体` **命中 0**。
 * 病根：`VOICE.jsonl`（用户说过的）与 `SPEC.md`（我们在做的）**没有任何连线** ——
 * 一条原话要变得"会被做"，必须有人**手工**写进 SPEC 成 R#；没人写就只躺在 VOICE 里，
 * 而 `check`/`report`/`map` **三张表都不看它** ⇒ `check` 会 exit 0 报"13 条需求全部一致"，
 * 却查不出"从没进过清单"的要求，**这类缺口原来连计数都没有**。
 *
 * 判据：
 *  - 正控：第一次 check 自动把水位线设成"当前 VOICE 最新一条"，**水位线之前的历史未认领只计数、不失败**；
 *  - 负控：水位线**之后**新增一条未认领的真用户原话 → `check` **exit 1** 并点出是哪一条；
 *  - 正控：把它认领掉 → `check` 回到 **exit 0**（不许误伤）；
 *  - 负控：`claims add --kind 乱写` / `--voice` 不存在 / `--kind 需求 --ref` 指不到 SPEC 里的 R# → exit 2；
 *  - 负控：`CLAIMS.jsonl` 里手写的坏行不许被静默吞掉（吞掉会让"已认领"多算）；
 *  - 正控：`report` 主表有「原话认领」那一行；`claims` 列表口径是「未认领 K / 共 M」。
 *
 * 沙箱：`<WORKSPACE>\_lab\L14_voice_claims`（带 `.git`），绝不碰 `<WORKSPACE>\.warden`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, seedSession, appendUserFrame, writeUtf8, runWarden, makeCtx, grab, readUtf8, readJsonl } from './common.mjs';

const QUOTE = '我要的是一个多面体球，面可以当落脚点，能画出不共面的笔，不要立方体，也不要光球。';
const H1 = '面板上的七个开关要能一个个单独关掉，别牵连别的功能。';
const H2 = '滚轮一格不许是 2.5 倍，我要的是顺滑的连续变化。';
// 活病例的逐字原话（故意用它当"水位线之后新增"的那条）
const NEWVOICE = '角色说话要像网游聊天区那样，角色名更小更细灰色，我要看真正在栏目里滚动的模样。';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 多面体球作为落笔地基
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 要的是"地基面"，要能切出很多面当落脚点
- 必须: 多面体；面可以当落脚点
- 锁定: 2026-09-16
`;

const voiceLines = (sb) => {
  const p = path.join(sb.wdir, 'VOICE.jsonl');
  return fs.existsSync(p)
    ? readUtf8(p).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).map((l) => JSON.parse(l))
    : [];
};

export default async function run() {
  const c = makeCtx('L14', '原话认领闸：VOICE（用户说过的）↔ SPEC（我们在做的）');
  const sb = makeSandbox('L14_voice_claims');
  writeUtf8(path.join(sb.wdir, 'SPEC.md'), spec(sb.sessionId));
  // 3 条**历史**原话：都会落在水位线**之前**
  seedSession(sb, { users: [QUOTE, H1, H2] });
  const O = (n) => `${sb.sessionId}#${n}`;
  const opt = { sessionId: sb.sessionId };

  runWarden(sb.dir, ['record', '--req', 'R1', '--status', 'done', '--delivered', '多面体球骨架',
    '--evidence', 'src/plug.rs:1', '--why', '搭起来了'], opt);
  const v1 = runWarden(sb.dir, ['voices'], opt);

  // ---------------------------------------------------------------- 前提
  const vs1 = voiceLines(sb);
  c.check('前提 · 3 条历史原话进 VOICE，且新记录自带 "kind":"user"（VOICE 自身能分清"真说"与"复述"）',
    v1.code === 0 && vs1.length === 3 && vs1.every((v) => v.kind === 'user'),
    `voices exit=${v1.code}；${vs1.length} 条，kind=${[...new Set(vs1.map((v) => v.kind))].join(',')}`);

  // ---------------------------------------------------------------- 正控：水位线自动落位 + 历史未认领不失败
  const chkHist = runWarden(sb.dir, ['check'], opt);
  const wm = fs.existsSync(path.join(sb.wdir, 'CLAIMS.watermark.json'))
    ? JSON.parse(readUtf8(path.join(sb.wdir, 'CLAIMS.watermark.json'))) : null;
  const histOk = chkHist.code === 0
    && chkHist.stdout.includes('已把水位线设在现在 —— 从现在起，新的用户原话必须被认领，否则 check 会失败')
    && chkHist.stdout.includes('只计数、不算失败')
    && !!wm?.since;
  c.check('正控 · 第一次 check 自动落水位线；**水位线之前**的 3 条历史未认领只计数、不让 check 失败',
    histOk, `exit=${chkHist.code} 水位线=${wm?.since}；${grab(chkHist.stdout, [/原话认领/], 1).join('') || '（没有原话认领提示）'}`);

  // ---------------------------------------------------------------- 负控：水位线之后新增未认领 → exit 1
  appendUserFrame(sb, NEWVOICE);
  const v2 = runWarden(sb.dir, ['voices'], opt);
  const vs2 = voiceLines(sb);
  const chkNew = runWarden(sb.dir, ['check'], opt);
  const newListed = chkNew.stdout.includes(O(4)) && chkNew.stdout.includes('没有任何认领');
  c.check('负控 · 水位线**之后**新增一条未认领的真用户原话 → check **exit 1**，并点出是哪一条',
    chkNew.code === 1 && newListed && vs2.length === 4,
    `voices exit=${v2.code}；check exit=${chkNew.code}；${grab(chkNew.stdout, [/原话认领/], 1).join('')}`);

  // ---------------------------------------------------------------- 正控：claims 列表口径
  const list = runWarden(sb.dir, ['claims'], opt);
  c.check('正控 · claims 列表：末尾打印「未认领 K / 共 M」，并分清水位线前后',
    list.code === 0 && list.stdout.includes('未认领 4 / 共 4') && list.stdout.includes('★水位线之后（硬失败）'),
    grab(list.stdout, [/未认领/, /水位线之后（硬失败）/], 2).join(' | '));

  // ---------------------------------------------------------------- 负控：add 的三类拒收
  const badKind = runWarden(sb.dir, ['claims', 'add', '--voice', O(4), '--kind', '乱写', '--ref', 'R1', '--why', '随便'], opt);
  const noVoice = runWarden(sb.dir, ['claims', 'add', '--voice', 'session-fixture0#1', '--kind', '需求', '--ref', 'R1', '--why', '随便'], opt);
  const noReq = runWarden(sb.dir, ['claims', 'add', '--voice', O(4), '--kind', '需求', '--ref', 'R99', '--why', '随便'], opt);
  c.check('负控 · claims add --kind 乱写 → exit 2', badKind.code === 2, `exit=${badKind.code}；${grab(badKind.stdout, [/拒收/], 1).join('')}`);
  c.check('负控 · claims add --voice 在 VOICE.jsonl 里找不到 → exit 2', noVoice.code === 2, `exit=${noVoice.code}；${grab(noVoice.stdout, [/拒收/], 1).join('')}`);
  c.check('负控 · claims add --kind 需求 --ref 指不到 SPEC 里的 R# → exit 2（"认领成需求"必须真的进了清单）',
    noReq.code === 2, `exit=${noReq.code}；${grab(noReq.stdout, [/拒收/], 1).join('')}`);
  // 三类拒收都不许留下记录（拒收=没写进去）
  c.check('负控 · 上面三次拒收都不许往 CLAIMS.jsonl 里留下任何一条',
    readJsonl(path.join(sb.wdir, 'CLAIMS.jsonl')).length === 0,
    `CLAIMS.jsonl 现有 ${readJsonl(path.join(sb.wdir, 'CLAIMS.jsonl')).length} 条`);

  // ---------------------------------------------------------------- 正控：认领掉 → exit 0（不许误伤）
  const whyBefore = runWarden(sb.dir, ['claims', 'why', '--voice', O(4)], opt);
  const added = runWarden(sb.dir, ['claims', 'add', '--voice', O(4), '--kind', '已答过', '--ref', O(1), '--why', '这段在第一条原话里已经答过'], opt);
  const chkClaimed = runWarden(sb.dir, ['check'], opt);
  const list2 = runWarden(sb.dir, ['claims'], opt);
  const whyAfter = runWarden(sb.dir, ['claims', 'why', '--voice', O(4)], opt);
  c.check('正控 · 认领掉那条之后 check 回到 **exit 0**（该放的必须放，否则规则会被当噪音）',
    added.code === 0 && chkClaimed.code === 0 && list2.stdout.includes('未认领 3 / 共 4'),
    `add exit=${added.code}；check exit=${chkClaimed.code}；${grab(list2.stdout, [/^未认领/], 1).join('')}`);
  c.check('正控 · claims why 能反查"这条原话认领成了什么"（未认领时 exit 1，认领后 exit 0 且写清 kind/ref）',
    whyBefore.code === 1 && whyBefore.stdout.includes('未认领')
      && whyAfter.code === 0 && whyAfter.stdout.includes('已答过') && whyAfter.stdout.includes(O(1)),
    `未认领时 exit=${whyBefore.code}；认领后 exit=${whyAfter.code}`);

  // ---------------------------------------------------------------- 正控：report 主表那一行
  const rep = runWarden(sb.dir, ['report'], opt);
  const md = readUtf8(path.join(sb.wdir, 'REPORT.md'));
  const line = md.split('\n').find((l) => l.startsWith('原话认领：')) ?? '';
  c.check('正控 · report 主表有「原话认领：已认领 K / 共 M · **未认领 N**」那一行（带时间戳 + 前 5 条未认领）',
    rep.code === 0 && /^原话认领：已认领 \d+ \/ 共 \d+ · \*\*未认领 \d+\*\*/.test(line)
      && md.includes('未认领的原话（前 5 条'),
    line || '（没找到那一行）');

  // ---------------------------------------------------------------- 负控：坏行不许静默吞掉
  fs.appendFileSync(path.join(sb.wdir, 'CLAIMS.jsonl'),
    JSON.stringify({ voice: O(2), kind: '看不懂的kind', ref: '', why: '' }) + '\n', 'utf8');
  const chkBad = runWarden(sb.dir, ['check'], opt);
  c.check('负控 · CLAIMS.jsonl 里手写的坏行不许静默吞掉（吞掉会让"已认领"多算）',
    chkBad.code === 1 && chkBad.stdout.includes('读不懂'),
    `exit=${chkBad.code}；${grab(chkBad.stdout, [/读不懂/], 1).join('')}`);

  const bad = c.checks.filter((x) => !x.ok);
  return {
    id: c.id,
    name: c.name,
    status: bad.length ? 'FAIL' : 'PASS',
    pass: bad.length === 0,
    reason: bad.length
      ? `${bad.length} 条判据没通过：${bad.map((x) => x.name).join('；')}`
      : '原话认领闸真跑通了：水位线之后的新原话没认领就 exit 1（点得出是哪条），认领掉就回到 exit 0，'
        + '历史的未认领只计数不误伤；三类非法认领全部 exit 2 且不留痕；坏行不被静默吞掉；report 主表有那一行。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
