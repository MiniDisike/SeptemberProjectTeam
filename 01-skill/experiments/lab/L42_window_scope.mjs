#!/usr/bin/env node
/**
 * L42 · **按窗口取数**（R37）：本窗口 vs 全集 —— 这一层原来是**零用例**的
 *
 * 为什么必须补这一条（审查 2026-09-24 的话，原样）：
 *   「`selftest` 里 `ledger` 出现 **0** 次，`experiments/lab` 下没有 R37 的用例 ⇒
 *     "58/42 全绿"证明不了新功能。」
 * 而 P-M5 那一轮**真的**因为"没有用例"漏掉了四条硬伤，其中两条是"改坏了完好功能"：
 *   ① `scoped --rebuild` 把本窗口那本账清成 0 行（**数据事故**：27 行 → 243 B 的空壳），
 *      而打印出来的"累计 27 条"是把汇总本的行并进来算的**假数**；
 *   ② `quotes` 的收窄把一条**逐字为真、来自别的窗口**的用户原话判成「★查无实据 exit 1」；
 *   ③ `claims` / `ask` **逐字节没治**（与真原件 `git diff --no-index` = exit 0），而它们正是污染的正源；
 *   ④ `check` 的引文核对**不许动**（SPEC 的引文本就跨窗口）。
 *
 * 本用例**真的起子进程**跑 `warden.mjs`（不是 import 内部函数）——
 * 因为这几条全是"退出码 / 落盘 / 口径"层面的事，模拟不出来。
 * 正负控成对：收窄与全集各自都验；"该拒的拒"与"该放的放"都验。
 * ⚠ **不许硬编码作者机路径**：被测文件一律从 common.mjs 的 `WARDEN`（= DSH 真正加载的那份）取。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  makeCtx, makeSandbox, seedSession, appendUserFrame, runWarden, writeUtf8, readUtf8, encodeWorkspace,
  LAB_SESSIONS, userEvent, writeToolEvent, WARDEN,
} from './common.mjs';

const MINE = 'session-l42-mine';        // 本窗口（主会话：`session-<uuid>`）
const OTHER = 'session-l42-other';      // 别的窗口
const SUBAGENT = 'a1b2c3d4-1111-4222-8333-444455556666';   // 子代理会话：**裸 uuid**

const Q1 = '本窗口第一句真话：每个窗口有自己单独负责的那一本账。';
const Q2 = '本窗口第二句真话：未做完的写入总账本。';
const Q3 = '本窗口第三句真话：做完后就标记做完。';
/** 别的窗口的**长引文**（松散化后 > 80 字）—— 走的是"长引文滑窗覆盖度"那条路，收窄就必然被判查无实据 */
const O1 = '别的窗口说过的逐字真话这条引文来自另一个窗口但仍然是我说的所以引文核对必须按全集取数任何按窗口收窄的核验都会把真话冤成查无实据那就是改坏完好的功能这件事';
const O2 = '不要在修改时改掉完好的功能';
/**
 * 系统注入（形状照抄 DSH 的运行期上下文，`data.source.kind === 'plugin'`）。
 * ⚠ 真实的那段是英文，而 `looksLikeProse` 要求**至少 6 个汉字**才会去验 ——
 *   这里用中文写，是为了让"注入的话被拿去当用户原话"这件事**真的能走到判定**（否则会 0 处匹配）。
 */
const INJ = '本期运行期上下文如下这一份快照取代了更早的那一份这一条是系统注入的不是用户说的话';
const FAKE = '这句是编的从来没有人说过这一句完全不存在于任何窗口的语料里面应当被判成查无实据。';

/** 造一条"会话日志"（多帧 zstd）。⚠ `seedSession` 会清掉整个工作区目录，别的窗口只能用这个补。 */
function addSession(projectDir, sid, users, { injected } = {}) {
  const sdir = path.join(LAB_SESSIONS, encodeWorkspace(projectDir), sid);
  fs.mkdirSync(sdir, { recursive: true });
  const t0 = Date.now() - 10 * 60 * 1000;
  const evs = users.map((t, i) => userEvent(t, t0 + (i + 1) * 1000, i + 1));
  if (injected) {
    evs.push({
      type: 'user/message', seq: 900, time: t0 + 500,
      data: { content: [{ type: 'text', text: injected }], source: { kind: 'plugin' }, role: 'user', id: 'p1' },
    });
  }
  evs.push(writeToolEvent(t0 + 300000));   // 写过磁盘 ⇒ 不会被 voices 当"纯问答的窗口"跳过
  fs.writeFileSync(path.join(sdir, 'session.v3.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(evs.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')));
  return sdir;
}
/** 往已有日志**追加一帧**（用来给本窗口塞一条"系统注入"） */
function appendInjected(sessionFile, text) {
  fs.appendFileSync(sessionFile, zlib.zstdCompressSync(Buffer.from(JSON.stringify({
    type: 'user/message', seq: 901, time: Date.now() - 9 * 60 * 1000,
    data: { content: [{ type: 'text', text }], source: { kind: 'plugin' }, role: 'user', id: 'p2' },
  }) + '\n', 'utf8')));
}
const rowsOf = (p) => (fs.existsSync(p)
  ? readUtf8(p).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).length
  : -1);
const numOf = (s, re) => { const m = re.exec(String(s ?? '')); return m ? Number(m[1]) : NaN; };
const out = (r) => String((r?.stdout ?? '') + (r?.stderr ?? ''));

export default async function run() {
  const c = makeCtx('L42', '按窗口取数（R37）：本窗口 / 全集 / 子代理 / 注入 / rebuild 不许清账 / 总账');

  c.check('前置 · 被测 warden.mjs 存在（为 0 不许报成功）', fs.existsSync(WARDEN), WARDEN);
  if (!fs.existsSync(WARDEN)) {
    return { id: c.id, name: c.name, status: 'FAIL', pass: false, reason: '被测 warden.mjs 不存在', checks: c.checks, skipped: c.skipped };
  }

  // ------------------------------------------------------------------ 夹具
  const sb = makeSandbox('L42_window_scope');
  seedSession(sb, { sessionId: MINE, users: [Q1, Q2, Q3] });
  appendInjected(sb.sessionFile, INJ);                 // 注入记在**本窗口**日志里（DSH 就是这么记的）
  addSession(sb.dir, OTHER, [O1, O2]);
  addSession(sb.dir, SUBAGENT, ['子代理会话里的第一条"用户消息"其实是父代理派发的提示词不是用户自己说的。']);
  writeUtf8(path.join(sb.wdir, 'SPEC.md'), `# 需求锁定表

## R1 · 夹具需求
- 原话: ${Q1}
- 出处: session:${MINE}#1
- 必须: 夹具
- 锁定: 2026-09-24
`);
  writeUtf8(path.join(sb.wdir, 'DEVIATIONS.md'), '# 偏差申报单\n');

  const WINFILE = path.join(sb.wdir, 'voices', `${MINE}.jsonl`);
  const AGGFILE = path.join(sb.wdir, 'VOICE.jsonl');
  const run = (args, sid = MINE) => runWarden(sb.dir, args, { sessionId: sid });

  // ================================================== ① 默认只扫本窗口
  const vMine = run(['voices', '--session', MINE]);
  const mineRows = rowsOf(WINFILE);
  c.check('① 默认只扫本窗口：写进 `.warden/voices/<本窗口>.jsonl`，且正好只有本窗口的 3 条原话',
    vMine.code === 0 && /只扫本窗口/.test(out(vMine)) && mineRows === 3,
    `exit=${vMine.code} rows=${mineRows}；${out(vMine).split('\n').filter((l) => /窗口口径|新增/.test(l)).join(' | ')}`);
  c.check('① 负控：别的窗口的原话**一条都没混进**本窗口那本账',
    mineRows === 3 && !readUtf8(WINFILE).includes(O1) && !readUtf8(WINFILE).includes(O2),
    `rows=${mineRows} 含 O1=${readUtf8(WINFILE).includes(O1)} 含 O2=${readUtf8(WINFILE).includes(O2)}`);

  // ================================================== ② --all-windows 扫全集，且条数不同
  const vAll = run(['voices', '--all-windows']);
  const aggRows = rowsOf(AGGFILE);
  c.check('② --all-windows 扫全集：汇总本正好 3+2=5 条',
    vAll.code === 0 && aggRows === 5 && /全集/.test(out(vAll)),
    `exit=${vAll.code} aggRows=${aggRows}`);
  c.check('② 两者**条数不同**（3 ≠ 5）—— 收窄是真的收窄，不是只在文字上说说',
    mineRows === 3 && aggRows === 5 && mineRows !== aggRows,
    `本窗口 ${mineRows} 条 / 全集 ${aggRows} 条`);

  // ================================================== ③ 子代理会话不算窗口
  c.check('③ 子代理会话（裸 uuid）**不算窗口**：窗口数是 2（本窗口 + 别的窗口），不是 3',
    /有原话的窗口 \*\*2 个\*\*/.test(out(vAll)),
    out(vAll).split('\n').filter((l) => /窗口口径/.test(l)).join(' | '));
  c.check('③ 子代理会话的原话**不进账**（那第一条"用户消息"是父代理派的提示词）',
    !readUtf8(AGGFILE).includes('父代理派发的提示词') && !readUtf8(WINFILE).includes('父代理派发的提示词'),
    `汇总本含=${readUtf8(AGGFILE).includes('父代理派发的提示词')}`);
  c.check('③ 负控：本窗口 = **裸 uuid**（子代理会话）时 `voices` **拒收 exit 2**，不替它猜一本账',
    run(['voices'], SUBAGENT).code === 2,
    `exit=${run(['voices'], SUBAGENT).code}；${out(run(['voices'], SUBAGENT)).split('\n')[0]}`);
  c.check('③ scoped 下"子代理会话 N 个"**不再是 0**（口径数字必须自洽）',
    /子代理会话 1 个/.test(out(vMine)),
    out(vMine).split('\n').filter((l) => /跳过/.test(l)).join(' | '));

  // ================================================== ④ 系统注入不算用户原话
  c.check('④ 系统注入（source.kind=plugin）**不算用户原话**：两本账里都找不到它，行数也没多',
    !readUtf8(AGGFILE).includes(INJ) && !readUtf8(WINFILE).includes(INJ) && mineRows === 3 && aggRows === 5,
    `汇总本含=${readUtf8(AGGFILE).includes(INJ)} 本窗口含=${readUtf8(WINFILE).includes(INJ)}`);
  writeUtf8(path.join(sb.dir, 'inj.md'), `# 注入\n- 用户原话：「（用户原话已隐去 —— 公开版不留逐字）」\n`);
  const qInj = run(['quotes', 'inj.md']);
  c.check('④ 负控：把注入的话当"用户原话"引 → 必须被判**查无实据 exit 1**',
    qInj.code === 1 && /查无实据/.test(out(qInj)),
    `exit=${qInj.code}；${out(qInj).split('\n').filter((l) => /查无实据|逐字对上|结论/.test(l)).join(' | ')}`);

  // ================================================== ⑤ scoped --rebuild 不许清空本窗口那本账
  const b1 = run(['voices', '--session', MINE, '--rebuild']);
  c.check('⑤ 正控：日志还在时 `--rebuild` 正常重建（exit 0，仍是 3 行）',
    b1.code === 0 && rowsOf(WINFILE) === 3,
    `exit=${b1.code} rows=${rowsOf(WINFILE)}`);
  // 把本窗口的日志移走（模拟日志被归档 / 轮转 / 删）
  fs.rmSync(path.join(LAB_SESSIONS, encodeWorkspace(sb.dir), MINE), { recursive: true, force: true });
  const b2 = run(['voices', '--session', MINE, '--rebuild']);
  c.check('⑤ ★负控：日志不可用时 `--rebuild` **拒收（exit ≠ 0）**，并且**一个字节都没写**',
    b2.code !== 0 && rowsOf(WINFILE) === 3 && /拒收/.test(out(b2)),
    `exit=${b2.code} rows=${rowsOf(WINFILE)}（改前这里是 exit=0 + rows=0）`);
  c.check('⑤ ★「累计 N 条」必须报**盘上真实的条数**（不许把汇总本的行并进来充数）',
    numOf(out(b2), /盘上真实条数就是\s*(\d+)\s*条/) === rowsOf(WINFILE) && rowsOf(WINFILE) === 3,
    `拒收时打印的盘上真实条数=${numOf(out(b2), /盘上真实条数就是\s*(\d+)\s*条/)} 盘上=${rowsOf(WINFILE)}（改前：打印「累计 3 条」而盘上是 0 行）`);
  addSession(sb.dir, MINE, [Q1, Q2, Q3]);                   // 日志放回来
  const b3 = run(['voices', '--session', MINE]);
  c.check('⑤ 正控：日志回来后同步 **不重复、不丢**（仍是 3 行，新增 0，累计=盘上）',
    b3.code === 0 && rowsOf(WINFILE) === 3 && numOf(out(b3), /新增\s*(\d+)\s*条/) === 0
      && numOf(out(b3), /累计\s*(\d+)\s*条/) === rowsOf(WINFILE),
    `exit=${b3.code} rows=${rowsOf(WINFILE)} 新增=${numOf(out(b3), /新增\s*(\d+)\s*条/)} 累计=${numOf(out(b3), /累计\s*(\d+)\s*条/)}`);
  writeUtf8(WINFILE, `# 本窗口（${MINE}）的原话账：只有这个窗口的用户消息。逐字，按时间，只增不改。\n`);
  const b4 = run(['voices', '--session', MINE]);
  c.check('⑤ 正控：账被清成空壳时，普通 `voices` **能自我修复**（从汇总本把本窗口的原话落回来）',
    rowsOf(WINFILE) === 3,
    `rows=${rowsOf(WINFILE)}（改前：只认"文件不存在"，所以永远是 0）`);

  // ================================================== ⑥ 总账本：done 粘住 / R# 不跨账 / reopen 不存在的 R#
  const c1 = run(['ledger', 'done', '--req', 'R1', '--title', '夹具']);
  const j1 = JSON.parse(out(run(['ledger', 'show', '--json'])));
  const item = (j) => (j.items ?? []).find((x) => x.req === 'R1') ?? null;
  c.check('⑥ 正控：`ledger done --req R1` → 总账里是 done',
    c1.code === 0 && item(j1)?.status === 'done',
    `exit=${c1.code} status=${item(j1)?.status}`);
  run(['ledger', 'add', '--req', 'R1', '--status', 'open', '--note', '别的窗口手滑了一次']);
  const j2 = JSON.parse(out(run(['ledger', 'show', '--json'])));
  c.check('⑥ ★done 是"粘"的：后来的 open **不许**把它盖回去（只记成"做完之后还有人当它没做完"）',
    item(j2)?.status === 'done' && (item(j2)?.postDoneOpen ?? []).length === 1,
    `status=${item(j2)?.status} postDoneOpen=${(item(j2)?.postDoneOpen ?? []).length}`);
  const rp = run(['ledger', 'reopen', '--req', 'R1']);
  const j3 = JSON.parse(out(run(['ledger', 'show', '--json'])));
  c.check('⑥ 正控：显式的 `reopen` 仍能把 done 打回 open（合法的门不许被焊死）',
    rp.code === 0 && item(j3)?.status === 'open',
    `exit=${rp.code} status=${item(j3)?.status}`);
  const ghost = run(['ledger', 'reopen', '--req', 'R99']);
  const j4 = JSON.parse(out(run(['ledger', 'show', '--json'])));
  c.check('⑥ ★负控：`reopen` 一个**从来不存在**的 R# ⇒ 拒收 exit 2（不许造幽灵欠账）',
    ghost.code === 2 && /从来没有过/.test(out(ghost)),
    `exit=${ghost.code}；${out(ghost).split('\n')[0]}`);
  c.check('⑥ 负控续：拒收之后，总账里**没有**凭空多出 R99 这一项',
    !(j4.items ?? []).some((x) => x.req === 'R99'),
    `items=${(j4.items ?? []).map((x) => x.req).join(',')}`);
  const cross = run(['ledger', 'add', '--req', 'R1', '--in', 'OTHERLEDGER']);
  c.check('⑥ 负控：**R# 不跨账** —— 往别的账本里写裸 R# ⇒ exit 2',
    cross.code === 2 && /不跨账/.test(out(cross)),
    `exit=${cross.code}；${out(cross).split('\n')[0]}`);
  const crossOk = run(['ledger', 'add', '--req', 'OTHERLEDGER#R7', '--in', 'OTHERLEDGER', '--title', '别的账的事']);
  c.check('⑥ 正控：带上账本标识（OTHERLEDGER#R7）⇒ 收下（该放的放）',
    crossOk.code === 0,
    `exit=${crossOk.code}；${out(crossOk).split('\n').slice(0, 2).join(' | ')}`);

  // ================================================== ⑦ claims / ask 也要有窗口口径
  const clMine = run(['claims', '--session', MINE]);
  c.check('⑦ `claims` 默认只扫本窗口，并**必印"这次取数来自 N 个窗口"**',
    clMine.code === 0 && /这次取数来自 1 个窗口/.test(out(clMine)) && /未认领 3 \/ 共 3/.test(out(clMine)),
    `exit=${clMine.code}；${out(clMine).split('\n').filter((l) => /窗口口径|未认领 /.test(l)).join(' | ')}`);
  c.check('⑦ ★scoped `claims` **不许**设那条全局水位线（拿一个窗口设全局水位线是假证据）',
    !fs.existsSync(path.join(sb.wdir, 'CLAIMS.watermark.json')),
    `水位线文件=${fs.existsSync(path.join(sb.wdir, 'CLAIMS.watermark.json'))}`);
  const clAll = run(['claims', '--all-windows']);
  c.check('⑦ `claims --all-windows` 扫全集（5 条 / 2 个窗口）—— 与 scoped 的数字**真的不同**',
    clAll.code === 0 && /这次取数来自 2 个窗口/.test(out(clAll)) && /未认领 5 \/ 共 5/.test(out(clAll)),
    `exit=${clAll.code}；${out(clAll).split('\n').filter((l) => /窗口口径|未认领 /.test(l)).join(' | ')}`);
  c.check('⑦ 正控：`--all-windows` 时才把全局水位线设起来',
    fs.existsSync(path.join(sb.wdir, 'CLAIMS.watermark.json')),
    `水位线文件=${fs.existsSync(path.join(sb.wdir, 'CLAIMS.watermark.json'))}`);
  c.check('⑦ 负控：认不出本窗口（裸 uuid）时 `claims` **拒收 exit 2**',
    run(['claims'], SUBAGENT).code === 2,
    `exit=${run(['claims'], SUBAGENT).code}`);
  fs.rmSync(AGGFILE, { force: true });
  const aMine = run(['ask', '一个谁都没问过的问题', '--session', MINE]);
  c.check('⑦ ★`ask` 的取数也收窄，且**不写汇总本**（原来无参 syncVoices 会顺手写汇总本）',
    /这次取数来自 1 个窗口/.test(out(aMine)) && !fs.existsSync(AGGFILE),
    `汇总本被重建=${fs.existsSync(AGGFILE)}；${out(aMine).split('\n').filter((l) => /窗口口径/.test(l)).join(' | ')}`);
  c.check('⑦ 负控：`ask` 的**问题文本不许被 flag 的值污染**（会话 id 不能被当成问题去查）',
    (() => {
      const q = path.join(sb.wdir, 'QUESTIONS.jsonl');
      if (!fs.existsSync(q)) return false;
      const last = readUtf8(q).split(/\r?\n/).filter(Boolean).pop();
      const rec = JSON.parse(last);
      return rec.question === '一个谁都没问过的问题' && !String(rec.question).includes(MINE);
    })(),
    '最后一条 QUESTIONS.jsonl 的 question 必须正是那句问题');
  run(['voices', '--all-windows']);                     // 把汇总本重建起来（收窄不写它，所以这里显式重建）
  const aAll = run(['ask', '另一个谁都没问过的问题', '--all-windows']);
  c.check('⑦ `ask --all-windows` 扫全集（2 个窗口）—— 显式的路必须真的通',
    aAll.code === 0 && /这次取数来自 2 个窗口/.test(out(aAll)),
    `exit=${aAll.code}；${out(aAll).split('\n').filter((l) => /窗口口径/.test(l)).join(' | ')}`);

  // ================================================== ⑧ quotes 的引文核对**保持全集**（这一条是"回退"，不是"再收窄"）
  writeUtf8(path.join(sb.dir, 'fixtureOther.md'), `# 归属核查夹具\n\n## P1\n- 用户原话：「（用户原话已隐去 —— 公开版不留逐字）」\n`);
  const qLong = run(['quotes', 'fixtureOther.md']);
  c.check('⑧ ★正控：一条**逐字为真、来自别的窗口**的用户原话 ⇒ 逐字对上 exit 0',
    qLong.code === 0 && /逐字对上/.test(out(qLong)),
    `exit=${qLong.code}；${out(qLong).split('\n').filter((l) => /逐字对上|查无实据|结论/.test(l)).join(' | ')}（改前：exit=1 查无实据）`);
  c.check('⑧ 口径必须**如实写成"全集"**（不许写成"只扫本窗口"，也不许报 0 个窗口）',
    /\*\*全集\*\*/.test(out(qLong)) && /来自 \*\*2 个窗口\*\*/.test(out(qLong)) && !/只扫本窗口/.test(out(qLong)),
    out(qLong).split('\n').find((l) => /窗口口径/.test(l)) ?? '');
  const qNope = run(['quotes', 'fixtureOther.md', '--session', 'session-nope']);
  c.check('⑧ 负控：不存在的窗口 id **不再把语料口径谎报成 0 个窗口**（传了旗标也明说"不按窗口收窄"）',
    qNope.code === 0 && /不按窗口收窄/.test(out(qNope)) && /来自 \*\*2 个窗口\*\*/.test(out(qNope)),
    `exit=${qNope.code}；${out(qNope).split('\n').filter((l) => /窗口口径|不按窗口收窄/.test(l)).join(' | ')}（改前：0 个窗口 / 0 字 + ✅逐字对上）`);
  writeUtf8(path.join(sb.dir, 'fixtureFake.md'), `# 归属核查夹具\n\n## P2\n- 用户原话：「（用户原话已隐去 —— 公开版不留逐字）」\n`);
  const qFake = run(['quotes', 'fixtureFake.md']);
  c.check('⑧ 负控：编的引文照样被判**查无实据 exit 1**（回退全集**没有**把检查放松）',
    qFake.code === 1 && /查无实据/.test(out(qFake)),
    `exit=${qFake.code}；${out(qFake).split('\n').filter((l) => /查无实据|结论/.test(l)).join(' | ')}`);
  /**
   * ★ P-M5 审查第 36 条：**这一条原来是恒真项**。
   *   原判据 `!/查无实据/.test(out(run(['check'])))` —— 而「查无实据」这四个字只在
   *   `quotes` / `renderMap` 里打印，`check` 的区间里 **0 处**（实测 grep 命中 0）⇒
   *   它**永远为真**，证明不了任何东西（恒真判据 = 假通过，正是本用例要防的东西）。
   *
   * 换成 `check` **真会打**的那一句（warden.mjs L1223 逐字）：
   *   `你写的「原话」在**这次扫到的**语料里逐字找不到`
   * 配一条**跨窗口**的 SPEC 原话（O2 是别的窗口说的）去验：check 的语料仍是全集 ⇒ 不许报它；
   * 再加一条**编的**原话（FAKE）当负控：check **必须**报它 —— 证明这条判据不是恒真。
   */
  const SPEC_BEFORE = readUtf8(path.join(sb.wdir, 'SPEC.md'));
  writeUtf8(path.join(sb.wdir, 'SPEC.md'), SPEC_BEFORE + `
## R2 · 跨窗口引文（别的窗口说的）
- 原话: ${O2}
- 出处: session:${OTHER}#2
- 必须: check 的引文语料必须仍是全集
- 锁定: 2026-09-24

## R3 · 负控：编的原话
- 原话: ${FAKE}
- 出处: session:${MINE}#1
- 必须: 负控（这条必须被判"逐字找不到"）
- 锁定: 2026-09-24
`);
  const ckCorpus = run(['check']);
  const ckCorpusOut = out(ckCorpus);
  const NOT_FOUND = '你写的「原话」在**这次扫到的**语料里逐字找不到';
  c.check('⑧ ★与 `check` 同口径：`check` 的引文语料仍是**全集**（不许被这一轮改动收窄）'
    + ' —— 判据换成 check 真会打的那句 + 一条负控（原来那条 `!/查无实据/` 是恒真项）',
  !ckCorpusOut.includes(`[R2] ${NOT_FOUND}`) && ckCorpusOut.includes(`[R3] ${NOT_FOUND}`),
  `[R2]（跨窗口真话）被判逐字找不到=${ckCorpusOut.includes(`[R2] ${NOT_FOUND}`)}（必须 false）；`
    + `[R3]（编的）被判逐字找不到=${ckCorpusOut.includes(`[R3] ${NOT_FOUND}`)}（必须 true —— 否则判据还是恒真）`);
  writeUtf8(path.join(sb.wdir, 'SPEC.md'), SPEC_BEFORE);

  // ================================================== ⑨ 硬伤 A / B / D（P-M5 审查点名，2026-09-24）
  /**
   * **硬伤 A**（设计级）：scoped 成为默认后**汇总本被孤立** ⇒ `check` 的原话认领闸**静默失效**
   *   （审查的判定性实验 [3][4][5]：只跑 scoped 时它看不见新原话，还把 2 条历史当成全部报出来）。
   *   判定性实验：水位线立好 → 用户又说一句 → **只跑 scoped `voices`** → `check`
   *   **必须**看见那条新原话并硬失败。
   * **硬伤 B**：`check` 提醒里给的那条命令**永远消不掉那条提醒** ⇒ 违反 ㊳「可修复的才配当提醒」。
   *   判据：**照提醒给的命令原样跑一次**，提醒必须消失。
   * **硬伤 D**：`ask --verdict` 落 `question:""` —— 空串不是修复，是"静默的空输入 + exit 0"。
   */
  const NEWQ = '★L42 新原话：scoped voices 之后 check 必须看得见这一条';
  /**
   * ⚠ **水位线在这里重新立一次**，理由要写清楚（不然这条用例自己会飘）：
   *   ⑦ 那条水位线是从"**重建之前**的旧时间戳"算出来的（夹具在 ⑤ 用 `addSession` 重新造了一份
   *   MINE 日志 ⇒ 同一句原话换了新的 `at`），而 ⑦ 之后又 `voices --all-windows` 重建了汇总本
   *   ⇒ 那 3 条老原话的 `at` 变得比水位线还新，于是"水位线之后"会数出 4 条。
   *   那是**夹具自己造的偏差**，不是被测行为。所以这里显式重立一次水位线（= 当前最新一条原话），
   *   让"之后有 **1** 条"这个数**确定**，这条用例才真的在验硬伤 A 而不是在验夹具的时钟。
   */
  fs.rmSync(path.join(sb.wdir, 'CLAIMS.watermark.json'), { force: true });
  const wmSet = run(['claims', '--all-windows']);
  appendUserFrame(sb, NEWQ, { seq: 810 });
  const vNew = run(['voices']);
  const ckNew = run(['check']);
  const ckNewOut = out(ckNew);
  c.check('⑨ ★硬伤A：水位线立好之后**只跑 scoped `voices`**，`check` 的认领闸**必须看得见**那条新原话（硬失败要响）',
    wmSet.code === 0 && vNew.code === 0 && ckNew.code !== 0
      && /\[原话认领\] 水位线（.*）之后有 1 条用户原话\*\*没有任何认领\*\*/.test(ckNewOut)
      && ckNewOut.includes('★L42 新原话'),
    `水位线重立 exit=${wmSet.code}；voices exit=${vNew.code}；check exit=${ckNew.code}；`
      + `出现"之后有 1 条"=${/\[原话认领\] 水位线（.*）之后有 1 条用户原话\*\*没有任何认领\*\*/.test(ckNewOut)}；`
      + `看得见新原话=${ckNewOut.includes('★L42 新原话')}；`
      + `CLAIMS=[${ckNewOut.split('\n').filter((l) => /原话认领|水位线/.test(l)).join(' || ').slice(0, 200)}]`);
  c.check('⑨ 硬伤A 的正控面：那条新原话**确实**落进了汇总本（`.warden/VOICE.jsonl`），不是只在窗口那本',
    readUtf8(AGGFILE).includes('★L42 新原话') && readUtf8(WINFILE).includes('★L42 新原话'),
    `汇总本含=${readUtf8(AGGFILE).includes('★L42 新原话')} 本窗口含=${readUtf8(WINFILE).includes('★L42 新原话')}`);

  // 硬伤 B：把汇总本删掉 → check 出提醒 → **照它给的命令原样跑一次** → 提醒必须消失
  fs.rmSync(AGGFILE, { force: true });
  const bMiss = run(['check']);
  const bLine = out(bMiss).split('\n').find((l) => /还没有 \.warden\/VOICE\.jsonl/.test(l)) ?? '';
  const bCmd = /node warden\.mjs voices[^\n]*/.exec(bLine);
  const bRun = bCmd ? run(bCmd[0].replace(/^node warden\.mjs\s*/, '').trim().split(/\s+/)) : { code: -1 };
  const bAgain = run(['check']);
  c.check('⑨ ★硬伤B：`check` 提醒给的那条命令**原样跑一次**，提醒必须消失（㊳「可修复的才配当提醒」）',
    bLine !== '' && bRun.code === 0 && fs.existsSync(AGGFILE)
      && !/还没有 \.warden\/VOICE\.jsonl/.test(out(bAgain)),
    `提醒原文=「${bLine.trim()}」→ 命令=${bCmd ? bCmd[0] : '（没给）'} exit=${bRun.code} 汇总本 exists=${fs.existsSync(AGGFILE)}；`
      + `再跑 check 提醒还在=${/还没有 \.warden\/VOICE\.jsonl/.test(out(bAgain))}`);

  // 硬伤 D：ask --verdict 不许落 {"question":""}
  const sbD = makeSandbox('L42_window_scope_askverdict');
  seedSession(sbD, { sessionId: MINE, users: [Q1] });
  const qf = path.join(sbD.wdir, 'QUESTIONS.jsonl');
  const runD = (args) => runWarden(sbD.dir, args, { sessionId: MINE });
  const dNoQ = runD(['ask', '--verdict', 'decide', '--reason', '我决定这么做']);
  c.check('⑨ ★硬伤D 负控：`ask --verdict` **对不上任何问题**时拒收 exit 2，且 QUESTIONS.jsonl **一个字节都没写**'
    + '（原来落 {"resolved":"decide",…,"question":""} —— 判决无法与任何问题对上）',
    dNoQ.code === 2 && !fs.existsSync(qf),
    `exit=${dNoQ.code} QUESTIONS.jsonl exists=${fs.existsSync(qf)}；${out(dNoQ).split('\n')[0]}`);
  runD(['ask', '要不要给导出按钮加一个圆角']);
  const dPend = runD(['ask', '--verdict', 'decide', '--reason', '文档里已有答案，我自己定了']);
  const dRec = JSON.parse(readUtf8(qf).trim().split(/\r?\n/).filter(Boolean).pop());
  c.check('⑨ 硬伤D 正控：有"还没判决的问题"时，判决**取那条问题**并打印出处 —— question 不再是空串',
    dPend.code === 0 && dRec.question === '要不要给导出按钮加一个圆角'
      && /这个问题来自/.test(out(dPend)) && String(dRec.question).trim() !== '',
    `exit=${dPend.code} question=「${dRec.question}」 from=「${dRec.questionFrom}」`);
  const dQ = runD(['ask', '另一个具体问题', '--verdict', 'ask', '--reason', '这是总目标层的取舍，必须用户拍板']);
  const dRec2 = JSON.parse(readUtf8(qf).trim().split(/\r?\n/).filter(Boolean).pop());
  const dNoReason = runD(['ask', '有问题的判决', '--verdict', 'decide']);
  c.check('⑨ 硬伤D 正控：命令行给了问题就用它；**缺 --reason 也拒收 exit 2**（同一个"静默空输入 + exit 0"的病）',
    dQ.code === 0 && dRec2.question === '另一个具体问题' && dNoReason.code === 2,
    `给了问题 exit=${dQ.code} question=「${dRec2.question}」；缺 --reason exit=${dNoReason.code}`);
  fs.rmSync(sbD.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });

  // ------------------------------------------------------------------ 收尾
  fs.rmSync(sb.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '按窗口取数全部机检：默认只扫本窗口 / --all-windows 扫全集且条数确实不同 / 子代理会话与系统注入都不算用户原话 / scoped --rebuild 拒收且不清账、累计报盘上真实条数 / 空壳能自我修复 / done 粘住、R# 不跨账、reopen 不存在的 R# 拒收 / claims 与 ask 都有窗口口径且不写汇总本 / quotes 保持全集。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
