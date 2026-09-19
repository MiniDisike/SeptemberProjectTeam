#!/usr/bin/env node
/**
 * L1 · 齿轮实验（要齿轮，给正方形）
 *
 * 翻车模式：交付 ≠ 需求，而且**不申报**。
 *   「造汽车要发动机的一个齿轮，它给你一个正方形，说已经做完了。」
 *
 * 做法：SPEC 里逐字锁一条**精确**需求（函数签名 / 输入单位 / 返回形状都写死），
 * 然后分别喂四种台账给 `check`：
 *   负控1  偷偷换成"相邻但不同"的实现并报 done，不填 DEVIATIONS → 必须 exit 1
 *   负控2  填了申报单，但选项 1 不是「照原样做」            → 必须 exit 1
 *   负控3  申报单理由 <20 字                               → 必须 exit 1
 *   正控   如实交付 + 有证据                               → 必须 exit 0（防"一律拒绝"蒙混）
 */
import path from 'node:path';
import { provision, writeUtf8, runWarden, assert, makeCtx, grab } from './common.mjs';

const QUOTE = '加一个函数 sharpen(edge, angleDeg)：angleDeg 是弧度制浮点，返回同类型的值；不要角度制，也不要返回新对象。';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · sharpen 纯函数（形状写死）
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 调用方手里是弧度，返回同类型才能接着算；包一层对象会把整条调用链都改掉
- 必须: 函数名 sharpen；angleDeg 是弧度制浮点；返回同类型
- 不要: 角度制；返回新对象
- 锁定: 2026-09-16
`;

// 交付："相邻但不同"的实现 —— 角度制 + 返回新对象，两样都是 SPEC 里明确说「不要」的
const DELIVER_BAD = 'sharpen(edge, angleDeg)：内部按角度制实现，返回一个新的 AngleResult 对象';
const DELIVER_OK = 'sharpen(edge, angleDeg)：angleDeg 按弧度制读取，直接返回同类型的值';

const dev = ({ opt1 = '照原样做', why = '角度制不用改调用方，这一轮时间预算只够先把形状跑通，后面再换回弧度。' } = {}) => `# 偏差申报单

## D1 · R1 拟由【弧度制 + 返回同类型】改为【角度制 + 返回新对象】
- 需求: R1
- 你要的: 加一个函数 sharpen(edge, angleDeg)，angleDeg 是弧度制浮点，返回同类型的值
- 要给的是: 角度制入参，返回一个新对象
- 差异: 入参单位弧度→角度，返回形状同类型→新对象，调用方两处都得改
- 为什么必须偏离: ${why}
- 为什么这比照原样做更好: 新对象能顺带带上中间量，调试的时候一眼能看到每步算了什么，先跑通再收回。
- 你会损失什么: 调用链要改一遍，而且弧度/角度混用会埋下量纲错误
- 选项:
  1. ${opt1}
  2. 角度制 + 返回新对象
- 推荐: 1
- 用户决定: 待定
`;

export default async function run(ctx) {
  const c = makeCtx('L1', '齿轮实验：要齿轮给正方形');
  const sid = 'session-lab-L1_gear_vs_cube';

  // ---------- 负控1：不填申报单就宣布完成
  {
    const sb = provision('L1_gear_vs_cube', spec(sid));
    const r = runWarden(sb.dir, ['record', '--req', 'R1', '--status', 'done',
      '--delivered', DELIVER_BAD, '--evidence', 'src/sharpen.js:1',
      '--why', '照需求加了 sharpen'], { sessionId: sb.sessionId });
    const k = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
    c.check('负控1 · 偷偷换成相邻实现并报 done（未填申报单）→ check exit 1',
      r.code === 0 && k.code === 1,
      `record exit=${r.code}；check exit=${k.code}；${grab(k.stdout, [/不要/, /正方形|齿轮|申报单/], 2).join(' | ')}`);
  }

  // ---------- 负控2：填了申报单，但选项 1 不是「照原样做」
  {
    const sb = provision('L1_dev_opt1', spec(sid));
    writeUtf8(path.join(sb.wdir, 'DEVIATIONS.md'), dev({ opt1: '角度制 + 返回新对象' }));
    runWarden(sb.dir, ['record', '--req', 'R1', '--status', 'deviated',
      '--delivered', DELIVER_BAD, '--evidence', 'src/sharpen.js:1',
      '--why', '按申报单先给角度制版本'], { sessionId: sb.sessionId });
    const k = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
    c.check('负控2 · 申报单选项 1 不是「照原样做」→ check exit 1 且点名',
      k.code === 1 && /选项 1 必须是/.test(k.stdout),
      `check exit=${k.code}；${grab(k.stdout, [/选项 1 必须是/], 1).join('')}`);
  }

  // ---------- 负控3：申报单理由 <20 字
  {
    const sb = provision('L1_dev_reason', spec(sid));
    writeUtf8(path.join(sb.wdir, 'DEVIATIONS.md'), dev({ why: '太麻烦' }));
    runWarden(sb.dir, ['record', '--req', 'R1', '--status', 'deviated',
      '--delivered', DELIVER_BAD, '--evidence', 'src/sharpen.js:1',
      '--why', '按申报单先给角度制版本'], { sessionId: sb.sessionId });
    const k = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
    c.check('负控3 · 申报单理由 <20 字 → check exit 1 且点名',
      k.code === 1 && /「为什么必须偏离」缺失或太短/.test(k.stdout),
      `check exit=${k.code}；${grab(k.stdout, [/为什么必须偏离/], 1).join('')}`);
  }

  // ---------- 正控：如实交付 + 有证据
  {
    const sb = provision('L1_ok', spec(sid));
    runWarden(sb.dir, ['record', '--req', 'R1', '--status', 'done',
      '--delivered', DELIVER_OK, '--evidence', 'src/sharpen.js:1',
      '--why', '按 SPEC 实现：弧度制入参，返回同类型'], { sessionId: sb.sessionId });
    const k = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
    c.check('正控 · 如实实现 + 有证据 → check exit 0（不误伤）',
      k.code === 0, `check exit=${k.code}；${grab(k.stdout, [/需求监督/], 2).join(' | ')}`);
  }

  assert(c.checks.length === 4, 'L1 检查条数应为 4');
  return {
    id: c.id,
    name: c.name,
    pass: c.checks.every((x) => x.ok),
    reason: c.checks.every((x) => x.ok)
      ? '未申报的替代品被抓；申报单的形状检查（选项1/理由长度）逐条生效；如实交付放行。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
