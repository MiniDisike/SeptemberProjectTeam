#!/usr/bin/env node
/**
 * L9 · 否定词翻转实验（缺陷被写成"没问题"）
 *
 * 回归来源（真实事故）：ARCH 第四版第 236 行 —— AI 原诊断是
 *   「WASD 飞行**只在**漫游(R)模式下有效」（**这是缺陷**），被写成了「**不只在**」。
 * 一个"不"字，缺陷变正常行为，**过了两轮审查才被抓到**。
 *
 * 这不是"漏抄"，是**把用户的抱怨改写成了正常行为** —— 比漏掉更坏，因为看的人以为没问题了。
 *
 * 这里真的实现一个检测器（不是永远返回 true 的假断言）：
 *   · 对两段文本做字符级 LCS diff，切成若干 hunk
 *   · 若**恰好一个** hunk 是插入/删除一个否定词（不/没/未/无/别…），
 *     其余 hunk 全是"装饰性"差异（括号、标点、空白、≤4 个字母数字，如 `(R)`）→ 判**否定词翻转**
 *   · 报出**两处位置**（原文里 / 改写文本里的行、列、偏移）
 *   · 判不了就明说"判不了"（差异太大 / 不是否定词），不硬判
 *
 * 检测器自带负控：逐字相同、非否定词改动、整段重写 → 都必须判**不是**翻转。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeUtf8, makeCtx } from './common.mjs';

// ------------------------------------------------------------------ 检测器
const NEG_TOKENS = ['不只在', '不再', '不能', '不会', '不许', '不要', '没有', '无法', '并非', '不是', '不用', '不', '没', '未', '无', '别'];

const isNegation = (s) => NEG_TOKENS.includes(s);

/** 装饰性差异：只剩括号 / 标点 / 空白 / ≤4 个字母数字（`(R)`、`。`、` `） */
function isCosmetic(s) {
  if (isNegation(s)) return false;
  const core = s.replace(/[（()）\s，。、；：,.;:\-—_*`「」『』“”"']/g, '');
  return /^[A-Za-z0-9]*$/.test(core) && core.length <= 4;
}

function posOf(text, offset) {
  let line = 1; let col = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') { line += 1; col = 1; } else col += 1;
  }
  return { offset, line, col };
}

/** 字符级 LCS diff → hunk 列表 */
function diffHunks(a, b) {
  const n = a.length; const m = b.length;
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * W + j] = a[i] === b[j]
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const hunks = [];
  const push = (op, ch, oPos, wPos) => {
    const last = hunks[hunks.length - 1];
    if (last && last.op === op && last.oEnd === oPos && last.wEnd === wPos) {
      last.text += ch; last.oEnd = oPos + 1; last.wEnd = wPos + 1;
    } else {
      hunks.push({ op, text: ch, oStart: oPos, oEnd: oPos + 1, wStart: wPos, wEnd: wPos + 1 });
    }
  };
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i += 1; j += 1; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { push('del', a[i], i, j); i += 1; }
    else { push('ins', b[j], i, j); j += 1; }
  }
  while (i < n) { push('del', a[i], i, j); i += 1; }
  while (j < m) { push('ins', b[j], i, j); j += 1; }
  return hunks;
}

/**
 * 判一对文本是不是"否定词被翻转"。
 * @returns {{flipped:boolean, reason:string, token?:string, direction?:string,
 *            atOriginal?:{offset,line,col}, atRewritten?:{offset,line,col}, cosmetic?:string[]}}
 */
export function detectNegationFlip(original, rewritten) {
  const a = String(original).replace(/\r\n?/g, '\n');
  const b = String(rewritten).replace(/\r\n?/g, '\n');
  if (a === b) return { flipped: false, reason: '两段逐字相同，没有差异' };
  if (a.length * b.length > 250_000) return { flipped: false, reason: '文本太长，检测器不判' };
  const hunks = diffHunks(a, b);
  const negs = hunks.filter((h) => isNegation(h.text));
  const others = hunks.filter((h) => !isNegation(h.text));
  if (negs.length !== 1) {
    return { flipped: false, reason: `差异里有 ${negs.length} 处否定词改动（要恰好 1 处才敢判），共 ${hunks.length} 处差异` };
  }
  const bad = others.filter((h) => !isCosmetic(h.text));
  if (bad.length) {
    return {
      flipped: false,
      reason: `除否定词外还有 ${bad.length} 处实质改动（如「${bad[0].text.replace(/\n/g, '⏎').slice(0, 12)}」）—— 差异太大，检测器不敢判`,
    };
  }
  const h = negs[0];
  return {
    flipped: true,
    reason: `恰好一处否定词被${h.op === 'ins' ? '插入' : '删除'}（「${h.text}」），其余 ${others.length} 处只是括号/标点差异`,
    token: h.text,
    direction: h.op === 'ins' ? 'negation-inserted' : 'negation-removed',
    atOriginal: posOf(a, h.oStart),
    atRewritten: posOf(b, h.wStart),
    cosmetic: others.map((x) => x.text),
  };
}

/** 在一份文档里定位一小段文字（用来把"两处位置"映射回文档的行列） */
export function locate(doc, snippet) {
  const i = doc.indexOf(snippet);
  return i < 0 ? null : posOf(doc, i);
}

// ------------------------------------------------------------------ 实验
// 真实事故里的两句话（出处：<WORKSPACE>\.warden\<缺陷清单>.md 第 30~31 行）
const ORIG_SENTENCE = 'WASD 飞行只在漫游(R)模式下有效。';
const REWRITE_SENTENCE = 'WASD 飞行不只在漫游模式下有效。';

const docOriginal = [
  '# AI 原诊断（记缺陷用的）',
  '',
  '穿梭感还没做出来：',
  ORIG_SENTENCE,
  '结论：这是缺陷，必修。',
  '',
].join('\n');

const docRewritten = [
  '# ARCH 第四版（节选）',
  '',
  '穿梭感已具备：',
  REWRITE_SENTENCE,
  '结论：正常。',
  '',
].join('\n');

export default async function run() {
  const c = makeCtx('L9', '否定词翻转：缺陷被写成没问题');
  const sbDir = 'D:\\user\\grok\\_lab\\L9_negation_flip';
  fs.mkdirSync(sbDir, { recursive: true });
  writeUtf8(path.join(sbDir, '诊断-原文.md'), docOriginal);
  writeUtf8(path.join(sbDir, 'ARCH-v4-节选.md'), docRewritten);

  // ---------- 主判据：干净的一对（只差一个"不"）
  const clean = detectNegationFlip(ORIG_SENTENCE, REWRITE_SENTENCE);
  const tokAtOrig = ORIG_SENTENCE.slice(clean.atOriginal?.offset ?? -1, (clean.atOriginal?.offset ?? -1) + 1);
  const tokAtNew = REWRITE_SENTENCE.slice(clean.atRewritten?.offset ?? -1, (clean.atRewritten?.offset ?? -1) + 1);
  c.check('① 缺陷句「只在」被写成「不只在」→ 判成否定词翻转，并指出两处位置',
    clean.flipped === true && clean.token === '不' && tokAtOrig === '只' && tokAtNew === '不',
    `flipped=${clean.flipped} token=「${clean.token}」原文位置 ${clean.atOriginal?.line}:${clean.atOriginal?.col}=「${tokAtOrig}」` +
    ` → 改写位置 ${clean.atRewritten?.line}:${clean.atRewritten?.col}=「${tokAtNew}」`);

  // ---------- 两处位置映射回真实文档
  const pOrig = locate(docOriginal, ORIG_SENTENCE);
  const pNew = locate(docRewritten, REWRITE_SENTENCE);
  c.check('② 两处位置能映射回真实文档（诊断 4 行 / ARCH 4 行，且行内容确实不同）',
    pOrig?.line === 4 && pNew?.line === 4 && docOriginal.includes(ORIG_SENTENCE) && docRewritten.includes(REWRITE_SENTENCE),
    `诊断-原文.md:${pOrig?.line}:${pOrig?.col} ｜ ARCH-v4-节选.md:${pNew?.line}:${pNew?.col}`);

  // ---------- 反方向：把"不"删掉也是翻转
  const removed = detectNegationFlip(REWRITE_SENTENCE, ORIG_SENTENCE);
  c.check('③ 反方向（把「不」删掉）也判翻转，方向标 negation-removed',
    removed.flipped === true && removed.direction === 'negation-removed',
    `flipped=${removed.flipped} direction=${removed.direction}`);

  // ---------- 真事故原样（还多了一处 `(R)` 被删）也判得出来
  const real = detectNegationFlip('WASD 飞行只在漫游(R)模式下有效', 'WASD 飞行不只在漫游模式下有效');
  c.check('④ 真事故原样（同时删了 `(R)` 这个括号内容）仍判翻转，且把它记成装饰性差异',
    real.flipped === true && (real.cosmetic ?? []).join('').includes('(R)'),
    `flipped=${real.flipped}；装饰性差异=${JSON.stringify(real.cosmetic ?? [])}`);

  // ---------- 负控三条：不能"一律判翻转"
  const same = detectNegationFlip(ORIG_SENTENCE, ORIG_SENTENCE);
  c.check('负控1 · 两段逐字相同 → 不判翻转',
    same.flipped === false, `flipped=${same.flipped}；${same.reason}`);

  const otherWord = detectNegationFlip('WASD 飞行只在漫游模式下有效。', 'WASD 飞行只在飞行模式下有效。');
  c.check('负控2 · 改的是普通词（漫游→飞行），不是否定词 → 不判翻转',
    otherWord.flipped === false, `flipped=${otherWord.flipped}；${otherWord.reason}`);

  const bigRewrite = detectNegationFlip(
    '穿梭感还没做出来：WASD 飞行只在漫游模式下有效，其他模式下按 WASD 只转镜头不起飞。',
    '穿梭感已经具备：WASD 飞行不只在漫游模式下有效，其他模式下按 WASD 也能起飞。');
  c.check('负控3 · 整句重写（否定词之外还有多处实质改动）→ 明说"判不了"，不硬判',
    bigRewrite.flipped === false, `flipped=${bigRewrite.flipped}；${bigRewrite.reason}`);

  // ---------- 真实事故在磁盘上有据（读活跃目录，只读）
  const evidenceFile = 'D:\\user\\grok\\.warden\\<缺陷清单>.md';
  if (fs.existsSync(evidenceFile)) {
    const txt = fs.readFileSync(evidenceFile, 'utf8').replace(/\*\*/g, '');
    const hit = txt.includes('WASD 飞行只在漫游') && txt.includes('WASD 飞行不只在漫游');
    c.check('⑤ 真实事故在磁盘上有据可查（<缺陷清单>.md 同时记着两句话）',
      hit, `${evidenceFile}：含「只在漫游」=${txt.includes('WASD 飞行只在漫游')}，含「不只在漫游」=${txt.includes('WASD 飞行不只在漫游')}`);
  } else {
    c.skip('⑤ 真实事故在磁盘上有据可查', `${evidenceFile} 不存在（可能被改名/移走）`);
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    pass: ok,
    reason: ok
      ? '检测器真跑通了：干净对、真事故对（含 (R) 删除）、反方向都判翻转并给出两处位置；逐字相同/普通词改动/整句重写都不误判。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
