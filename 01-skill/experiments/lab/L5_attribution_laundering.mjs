#!/usr/bin/env node
/**
 * L5 · 归属洗白实验（AI 写的被当成"用户原话"）
 *
 * 回归来源（真实事故）：
 *   · `MAP.md:148` 把用户贴回来的 AI 清单当成了用户原话
 *   · `kernel/shape2.gd` 的伪造引文（「矩形/圆圈/圆孔/中空/洞」在 48 会话 203 条真用户消息里 0 命中）
 *
 * 做法：造一份 doc.md，里面两条都标成「用户原话」——
 *   ① **一段我自己写的、AI 清单口吻**的文字（含 ✅ 勾选表）→ 必须被判 quoted-from-ai 或 unfounded
 *   ② **一句真的**、从权威 `<WORKSPACE>\.warden\VOICE.jsonl` 里**运行时挑出来**的用户原话 → 必须被判 verbatim
 *   **两个都要对**：只抓 AI 不误伤真话，才算过。
 *
 * 附加：
 *   · 另一条负控：AI 先写、用户**贴回来**（真·引述自 AI 路径）→ 必须判 quoted-from-ai
 *   · 缺口核查：`quotes` 传一个不存在的路径时会不会假装"没问题"
 *
 * ★★ **2026-10-05 修一个夹具回归（隐私清洗误伤）**：
 *   上一轮把"用户逐字原话"换成中性措辞时，把**夹具里的两侧样本也一起换了** ⇒
 *   A、B 两行逐字节相同 ⇒ `lineA === lineB` ⇒ ① 和 ② 拿的是同一条的同一个判决
 *   ⇒ **这个用例不再区分"真话"和"假话"，永远是绿的**（而它当时是 SKIP，连红都看不见）。
 *   ⇒ 现在的两条铁律：
 *     ① **仓库存不得有真人原话**（公开版）⇒ 两侧都必须是自造的文本；
 *     ② "真"的那一侧由 `pickRealQuote()` **运行时**从私有账本里挑（仓库里一个字都不留），
 *        "假"的那一侧是自造的 AI 清单，**逐字不在任何用户语料里**。
 *   两侧逐字节不同这条，由下面「夹具自检」钉死（不许等下一次清洗才发现）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  provision, makeSandbox, seedSession, writeUtf8, runWarden, makeCtx, grab, readUtf8, readJsonl,
  encodeWorkspace, REAL_WORKSPACE, REAL_VOICE, REAL_WARDEN_DIR,
} from './common.mjs';

// 「假原话」侧：**一眼就是自造的** AI 清单口吻（✅ 勾选表），冒充"用户原话"。
// ⚠ 它必须逐字不在任何用户语料里 —— 这正是"被冒充的那句话"该有的性质。
const AI_CHECKLIST = '✅ 造型主线 7 项已全部完成 ✅ 木材工艺链 4 项已全部完成 ✅ 布料 3 项已全部完成 ✅ 界面 13 项已全部完成，本窗口收官';

// 真·引述自 AI：这句是 AI 写的缺陷清单，用户只是贴回来了
// ⚠ 不能带括号：归属抽取器把含 `( )` 的引文当成代码跳过（looksLikeProse），那样就扫不到这条
const PASTED_AI = '穿梭感还没做出来：WASD 飞行只在漫游模式下有效，其他模式下按 WASD 只转镜头不起飞。';

/**
 * 一句话能不能当**夹具里的引文**（口径照抄 `warden.mjs`，免得挑到一句夹具自己扫不到的）：
 *   · ≥8 个汉字 —— warden 的 `looksLikeProse` 要求 ≥6，这里留一点余量；
 *   · 不含 `= ( ) { } [ ] ;` —— 同上，这些会被当成代码整条跳过；
 *   · 不含 `「」『』""` 与反斜杠 —— 引号会把夹具里的「」提前闭合并截断引文；
 *   · 不含换行/制表/控制符 —— JSONL 里这些是转义过的，按行 `includes` 会找不到（④ 会红）。
 */
const FIXTURE_UNUSABLE_RE = /[=(){}\[\];「」『』“”"\\]/;
function usableAsFixtureQuote(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s) return false;
  if (/[\u0000-\u001f]/.test(s)) return false;
  if (FIXTURE_UNUSABLE_RE.test(s)) return false;
  return (s.match(/[\u4e00-\u9fa5]/g) ?? []).length >= 8;
}

/**
 * 从权威 VOICE.jsonl 里挑一句**真人原话**（运行时现挑，仓库里一个字都不留）。
 *
 * ⚠ 行结构 `{session, seq, at, text, wrote, kind}` 来自 warden.mjs 写这本账的那段代码，不是猜的；
 *   这里只取 `kind === 'user'` 那些记录的 `.text`（逐字正文）。
 * ⚠ **挑不到就返回空串**，由守卫如实 SKIP —— **不许**造一句自造的顶上：
 *   那样②判的就不是"不误伤真话"，本实验的核心判据直接作废。
 *
 * 候选里取汉字最多的那句：越长的越不可能是 AI 恰好复读过的短句（降 `isQuotedFromAI` 误判）。
 * @returns {string}
 */
function pickRealQuote() {
  let rows = [];
  try { rows = readJsonl(REAL_VOICE); } catch { return ''; }
  let best = '';
  let bestCjk = 0;
  for (const r of rows) {
    const t = (r?.kind === undefined || r.kind === 'user') ? r?.text : '';
    if (!usableAsFixtureQuote(t)) continue;
    const s = String(t).trim();
    if (s.includes(AI_CHECKLIST) || AI_CHECKLIST.includes(s)) continue;   // 两侧必须逐字节不同
    const cjk = (s.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    if (cjk > bestCjk) { best = s; bestCjk = cjk; }
  }
  return best;
}

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 归属核查样本
- 原话: 归属核查：凡是标成"用户原话"的，都必须能在真用户消息里逐字找到，否则就是伪造。
- 出处: session:${sid}#1
- 为什么: 把 AI 自己写的东西算成用户说的，等于替用户签名
- 必须: 标了归属的句子都能逐字核对
- 不要: 把自己的清单写成用户原话
- 锁定: 2026-09-16
`;

/** 解析 `warden quotes` 的分桶输出 → Map<"file:line", 判决> */
function parseBuckets(out) {
  const map = new Map();
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (/逐字对上/.test(line)) cur = 'verbatim';
    else if (/疑似改写/.test(line)) cur = 'paraphrase';
    else if (/引述自 AI/.test(line)) cur = 'quoted-from-ai';
    else if (/查无实据/.test(line)) cur = 'unfounded';
    else if (/处太短/.test(line)) cur = 'too-short';
    const m = /^\s+(\S+):(\d+)\s+\[/.exec(line);
    if (m && cur) map.set(`${m[1]}:${m[2]}`, cur);
  }
  return map;
}

export default async function run() {
  const c = makeCtx('L5', '归属洗白实验：AI 写的被当成用户原话');
  /**
   * ⚠ 公开版：这条用例依赖**作者私有账本**里的 VOICE.jsonl（真实用户在真实窗口说过的话）。
   *   公开包**不发** .warden ⇒ 它在公开用户那里**结构上跑不了**。
   *   ⇒ 如实 SKIP，**不许假装通过、也不许留着红**（"没查到东西 ≠ 查了没问题"）。
   * ⚠ 2026-10-05：原话样本改成**运行时现挑**，这道守卫因此多担一件事 ——
   *   账本在、却挑不出一句能当夹具的（见 `usableAsFixtureQuote`），同样是"结构上跑不了"，也如实 SKIP。
   * ⚠ 2026-10-05 同时补上原来漏掉的 `return`：守卫抛异常时**必须**停下。
   *   原来只 `c.skip(...)` 然后继续往下跑 ⇒ 守卫坏了还照跑（下面那段注释骂的就是这个）。
   */
  let REAL_QUOTE = '';
  try {
    const priv = path.join(REAL_WARDEN_DIR, 'VOICE.jsonl');
    if (!fs.existsSync(priv)) {
      c.skip('整条用例', '私有账本不在（' + priv + '）—— 公开版不发 .warden，这条在公开用户那里跑不了');
      return { id: c.id, name: c.name, status: 'SKIP', pass: true, reason: '私有账本不在，如实跳过', checks: c.checks, skipped: c.skipped };
    }
    REAL_QUOTE = pickRealQuote();
    if (!REAL_QUOTE) {
      c.skip('整条用例', `私有账本在（${priv}），但里面挑不出一句能当夹具的真人原话`
        + '（≥8 个汉字、非代码、不含引号/括号/反斜杠/换行，且必须与 AI 清单逐字节不同）—— 如实跳过，**不造假的顶上**');
      return { id: c.id, name: c.name, status: 'SKIP', pass: true, reason: '挑不出可用的真原话样本，如实跳过', checks: c.checks, skipped: c.skipped };
    }
  } catch (e) {
    // ⚠ 不许静默：守卫自己坏了要说出来（我第一版把 ReferenceError 吞了，守卫等于没写）
    c.skip('守卫自身', '私有账本守卫自己抛了异常：' + String(e && e.message).slice(0, 120));
    return { id: c.id, name: c.name, status: 'SKIP', pass: true, reason: '守卫自身抛异常，如实跳过', checks: c.checks, skipped: c.skipped };
  }

  // ---------- 主沙箱：语料指向真实工作区（sources --add <WORKSPACE>）
  const sb = provision('L5_attribution', spec('session-lab-L5_attribution'));
  const lines = [
    '# 归属核查样本',
    '',
    '## A · 疑似 AI 清单（归属存疑）',
    `- 用户原话：「${AI_CHECKLIST}」`,
    '',
    '## B · 真人原话样本',
    `- 用户原话：「${REAL_QUOTE}」`,
    '',
  ];
  writeUtf8(path.join(sb.dir, 'doc.md'), lines.join('\n'));
  /**
   * ⚠ 按"引文所在的归属行"定位，而且只认 `- 用户原话：「…」` 这种行。
   *   原来是裸 `findIndex(l => l.includes(...))` —— 两侧一旦被换成同一句，
   *   两边都定位到同一行，`lineA === lineB`，① 和 ② 变成同一个断言（夹具失效的根因）。
   */
  const quoteLineOf = (needle) => lines.findIndex((l) => l.startsWith('- ') && l.includes(needle)) + 1;
  const lineA = quoteLineOf(AI_CHECKLIST);
  const lineB = quoteLineOf(REAL_QUOTE);

  c.check('夹具自检 · 假样本与真样本必须逐字节不同（同一句话会让"真/假"失去区别）',
    lineA !== lineB && AI_CHECKLIST !== REAL_QUOTE
      && !AI_CHECKLIST.includes(REAL_QUOTE) && !REAL_QUOTE.includes(AI_CHECKLIST),
    `A 落在 doc.md:${lineA}（${AI_CHECKLIST.length} 字）/ B 落在 doc.md:${lineB}（${REAL_QUOTE.length} 字）；`
    + `逐字节相同=${AI_CHECKLIST === REAL_QUOTE}`);

  const src = runWarden(sb.dir, ['sources', '--add', REAL_WORKSPACE], { sessions: 'real', sessionId: sb.sessionId });
  c.check('前置 · sources --add REAL_WORKSPACE：语料指向真实工作区',
    src.code === 0 && src.stdout.includes(encodeWorkspace(REAL_WORKSPACE)),
    `exit=${src.code}；${grab(src.stdout, [/^--/, /合计真用户消息/], 3).join(' | ')}`);

  const q = runWarden(sb.dir, ['quotes', 'doc.md'], { sessions: 'real', sessionId: sb.sessionId, timeout: 300000 });
  const buckets = parseBuckets(q.stdout);
  const verdictA = buckets.get(`doc.md:${lineA}`);
  const verdictB = buckets.get(`doc.md:${lineB}`);

  c.check('① AI 清单口吻那段（标成「用户原话」）→ 判 quoted-from-ai 或 unfounded',
    verdictA === 'quoted-from-ai' || verdictA === 'unfounded',
    `doc.md:${lineA} 判决=${verdictA ?? '（没扫到）'}；exit=${q.code}`);
  c.check('② 真用户原话那段 → 判 verbatim（不误伤真话）',
    verdictB === 'verbatim',
    `doc.md:${lineB} 判决=${verdictB ?? '（没扫到）'}；exit=${q.code}`);
  c.check('③ quotes 对含伪造归属的文档 exit 1',
    q.code === 1, `exit=${q.code}；${grab(q.stdout, [/结论：/], 1).join('')}`);

  // 真原话的权威性：必须在真实 VOICE.jsonl 里逐字存在
  const voiceHit = fs.existsSync(REAL_VOICE)
    && readUtf8(REAL_VOICE).split(/\r?\n/).some((l) => l.includes(REAL_QUOTE));
  c.check('④ 用的那句"真原话"确实逐字来自权威 VOICE.jsonl',
    voiceHit, voiceHit ? `命中 ${REAL_VOICE}` : `在 ${REAL_VOICE} 里找不到 —— 样本本身不可信`);

  // ---------- 负控：AI 先写、用户贴回来 → 必须判 quoted-from-ai（真实事故那条路）
  {
    const pb = makeSandbox('L5_pasteback');
    writeUtf8(path.join(pb.wdir, 'SPEC.md'), spec('session-lab-L5_pasteback'));
    seedSession(pb, { assistants: [PASTED_AI], users: [PASTED_AI], assistantFirst: true });
    writeUtf8(path.join(pb.dir, 'doc.md'),
      `# 贴回样本\n\n## C · 用户贴回的 AI 文本（归属存疑）\n- 用户原话：「${PASTED_AI}」\n`);
    const r = runWarden(pb.dir, ['quotes', 'doc.md'], { sessionId: pb.sessionId });
    const v = parseBuckets(r.stdout).get('doc.md:4');
    c.check('⑤ 负控 · AI 先写、用户贴回来 → 判 quoted-from-ai（不是 verbatim）',
      v === 'quoted-from-ai', `doc.md:4 判决=${v ?? '（没扫到）'}；exit=${r.code}`);
  }

  // ---------- 附带：不存在的路径**不许**被当成"查了没问题"（完整判据见 L11）
  {
    const r = runWarden(sb.dir, ['quotes', 'no_such_file_xyz.md'], { sessions: 'real', sessionId: sb.sessionId, timeout: 300000 });
    c.check('⑥ 附带 · quotes 传一个不存在的路径 → exit 2，不许报"没有发现问题"（完整判据见 L11）',
      r.code === 2 && !/没有发现查无实据的归属/.test(r.stdout),
      `exit=${r.code}；${grab(r.stdout, [/扫了/, /没问题|不存在|没查到/], 2).join(' | ')}`);
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    pass: ok,
    reason: ok
      ? '伪造归属被抓（unfounded/quoted-from-ai）、真用户原话逐字放行（verbatim）、贴回 AI 文本也被抓；不存在的路径 → exit 2，不谎报"没问题"（完整判据见 L11）。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}