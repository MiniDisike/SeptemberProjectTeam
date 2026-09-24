#!/usr/bin/env node
/**
 * L30 · 「不要」判据要分得清 X 与「不 X」（2026-09-17 我自己踩的假阳性 + 自己写的半修）
 *
 * 事由：R15 的「不要」里有一条是 `跨窗口污染`，而我在 `--why` 里**逐字引用用户的要求**
 *   「…能×掉、修正后自清、**不跨窗口污染**」⇒ 匹配器只看到子串 `跨窗口污染`，
 *   判我"交付里出现了用户不要的东西" —— **分不清 X 与「不 X」**（A3 的镜像）。
 * 修的过程中我自己又写了半修：只检查**第一处**命中 ⇒ 第一处是「不跨窗口污染」时，
 *   后面的**真违规**被一起跳过（**我自己的正控当场抓到**）。
 *
 * 判据（机械）：
 *   ① 正控：交付里**真的**出现违规词（前面不是否定词）⇒ 必须判违规；
 *   ② 负控：只有「不X」这种否定写法 ⇒ 不许判违规，但**要提醒**（不许静默）；
 *   ③ 关键：**先否定、后真违规**（两处都有）⇒ 必须判违规（这就是我第一版漏的那一种）；
 *   ④ 真账本当前状态 ⇒ 不许因此红（防误伤）。
 *
 * 全部在内存里造 rounds 喂 `check(root, {rounds})`，**不写任何账本、不 spawn 子进程**。
 */
import fs from 'node:fs';
import { makeCtx } from './common.mjs';

const WARDEN = 'file:///<HOME>/.dsh/skills/task-warden/warden.mjs';
const ROOT = '<WORKSPACE>\\task-warden';
const BAD = '跨窗口污染';   // R15「不要」里的一条（实读自 SPEC）

export default async function run() {
  const c = makeCtx('L30', '「不要」判据：分得清 X 与「不 X」');

  const mod = await import(WARDEN);
  const specText = fs.readFileSync(ROOT + '\\.warden\\SPEC.md', 'utf8');
  const spec = mod.parseSpec(specText);
  const r15 = spec.find((s) => s.id === 'R15');
  c.check('前置 · R15 的「不要」里确实有这条（为 0 不许报成功）',
    Array.isArray(r15.mustNot) && r15.mustNot.includes(BAD),
    'mustNot=' + JSON.stringify(r15.mustNot));

  const base = fs.readFileSync(ROOT + '\\.warden\\ROUNDS.jsonl', 'utf8')
    .split(/\r?\n/).filter((s) => s.trim().startsWith('{'))
    .map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean);

  const run1 = (delivered, round) => {
    const rounds = base.concat([{ round, requirement: 'R15', status: 'partial', delivered, why: 'x', missing_half: '就这一半' }]);
    const r = mod.check(ROOT, { specText, rounds });
    return {
      bad: r.fails.filter((f) => new RegExp('不要.*' + BAD).test(String(f))).length,
      warn: r.warns.filter((w) => String(w).includes(BAD)).length,
    };
  };

  const a = run1('我们做了' + BAD + '，让别的窗口也看得到', 9001);
  c.check('① 正控 · 真的违规 ⇒ 必须判违规', a.bad === 1, JSON.stringify(a));

  const b = run1('不' + BAD + '，别的窗口看不到', 9002);
  c.check('② 负控 · 只有否定写法 ⇒ 不许判违规', b.bad === 0, JSON.stringify(b));
  c.check('② 但**要提醒**（不许静默放过）', b.warn === 1, JSON.stringify(b));

  const d = run1('我们做到了不' + BAD + '；但我们又加了一处' + BAD, 9003);
  c.check('③ 先否定、后真违规 ⇒ 必须判违规（我第一版漏的就是这种）', d.bad === 1, JSON.stringify(d));

  const real = mod.check(ROOT, { specText });
  c.check('④ 真账本当前状态 ⇒ 不许因此红（防误伤）',
    real.fails.filter((f) => new RegExp('不要.*' + BAD).test(String(f))).length === 0,
    '真账本相关 fails = ' + real.fails.filter((f) => /不要/.test(String(f))).length);

  /**
   * ⑤⑥ 2026-09-18 补（事故 **I32**：用户在 shape_lab 里点名要求修掉的那个假阳性）。
   *
   * 现场：R8 的「不要」项里有一条 `鼠标向右镜头往左`，而用户在**同一句**里用**逗号并列**了两个禁止项
   *   ——「禁止：…，禁止鼠标往左镜头往右，鼠标向右镜头往左这种反向操作。」
   *   否定词「禁止」只在**前一个**前面 ⇒ 「只看命中处前 10 个字符」的判据**永远**判它违规。
   * 更要命的是 `deliveredBlob` 扫**全部轮次**：逐字引用原话的那一笔一旦写进去就**洗不掉**
   *   （append-only），而 `record --avoided` 又**要求**把每条「不要」逐字抄一遍 ⇒ 越守规矩越命中。
   *
   * 新判据：命中处若被包在「**逐字来自该需求原话**」的一段里（与 `s.quote` 的最长公共片段够长）
   *   ⇒ 算**引用**，不算交付。
   * 这两条**成对**：⑤ 证明引用不再误伤，⑥ 证明判据没有被放空（同一个词、换个说法就照抓）。
   */
  const COMMA_BAD = '鼠标向右镜头往左';
  const SPEC_COMMA = [
    '# 需求锁定表（夹具）',
    '',
    '## R90 · 方向不许反（夹具）',
    '- 原话: 以下是项目全局的一个约束：注意保持：鼠标移动向左就是向左，向右就是向右。以人类使用习惯为准。禁止：禁止按A向右，按D向左，禁止鼠标往左镜头往右，'
      + COMMA_BAD + '这种反向操作。AI非常喜欢擅自使用这招，要绝对杜绝。',
    '- 出处: session:session-st0001#1',
    '- 为什么: 夹具：证明「逐字引用用户原话」不再被当成违规',
    '- 必须: 四个轴都跟手',
    '- 不要: ' + COMMA_BAD,
    '- 锁定: 2026-09-18',
    '',
  ].join('\n');

  const run2 = (delivered, round) => {
    const rounds = [{ round, requirement: 'R90', status: 'partial', delivered, why: 'x', missing_half: '夹具' }];
    const r = mod.check(ROOT, { specText: SPEC_COMMA, rounds });
    return {
      bad: r.fails.filter((f) => new RegExp('不要.*' + COMMA_BAD).test(String(f))).length,
      warn: r.warns.filter((w) => String(w).includes(COMMA_BAD)).length,
    };
  };

  const e = run2('本轮没动方向。用户原话：禁止：禁止按A向右，按D向左，禁止鼠标往左镜头往右，'
    + COMMA_BAD + '这种反向操作。', 9101);
  c.check('⑤ 负控 · 命中处被包在「逐字引用用户原话」的一段里（逗号并列、否定词只在前一个）⇒ 不许判违规（I32 的现场）',
    e.bad === 0, JSON.stringify(e));

  const f = run2('本轮把右键拖动的方向改成了' + COMMA_BAD + '，用户说这样手感更好', 9102);
  c.check('⑥ 正控 · 同样的词但**不在**原话的措辞里（真的是交付）⇒ 必须判违规（判据没被放空）',
    f.bad === 1, JSON.stringify(f));

  /**
   * ⑦ **已知缺口（如实记账，不是通过）**：把交付**写成用户原话的措辞**时，引用豁免会被蹭到。
   *   实测（2026-09-18 对照表：10 条夹具，旧判据 vs 新判据）：
   *     引用类 3 条 —— 旧误伤 **3/3**、新误伤 **0/3**；
   *     违规类 7 条 —— 旧抓 **7/7**、新抓 **6/7**（漏的就是这一条）。
   *   要收紧得再加一条「同一句里有交付动词（交付/做了/改成/实现/采用）就不豁免」——
   *   但那会把「本轮**没有交付**任何方向改动；用户原话：…」这类**真引用**重新误伤
   *   ⇒ **先量清再动**（与 A6 同一条纪律）。这里先把缺口钉住：**一旦它被修好，这条会当场翻红**，
   *   提醒下一个人「夹具要跟着改」，而不是让缺口悄悄消失。
   */
  const g = run2('交付的写法照用户那句话：禁止鼠标往左镜头往右，' + COMMA_BAD + '这种反向操作', 9103);
  c.check('【缺口】把交付**写成用户原话的措辞** ⇒ 新判据会放行（引用豁免被蹭到）：违规类 7 条里漏这 1 条',
    g.bad === 0,
    JSON.stringify(g) + ' —— 这是真实缺口，不是实验失败：豁免判据是「与 s.quote 逐字重合够长」，'
    + '所以"用用户原话的措辞去描述交付"能蹭到它。收紧的代价见上面那段注释（会重新误伤真引用）。');

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '「不要」判据扫全部命中：真违规抓得住、纯否定只提醒、先否定后违规也抓得住（我第一版的半修已被钉住）。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
