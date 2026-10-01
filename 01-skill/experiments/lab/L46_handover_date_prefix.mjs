#!/usr/bin/env node
/**
 * L46 · 交接名日期口径 —— 「挑最新一份交接」**不许退化成 mtime 排序**（钉 P-M34）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 要钉住的那条口径（逐字，来自 `handover-gate.js` 自己的注释）
 * ════════════════════════════════════════════════════════════════════════════
 *   `compareLatestHandover` 上面写着：
 *     「交接文件的**语义**是"哪一天的交接"，不是"这个文件什么时候被拷过来的"。」
 *   ⇒ 名字里**明明写着日期**却取不到日期键，就是**把口径偷偷退回 mtime**。
 *
 * 现场（2026-10-01 之前就已经存在的退化，**不是** P-M34 引入的）：
 *   `dateOfHandoverName` 旧正则只认两种形状 ——
 *     `交接-YYYY-M-D.md` 与 `交接-第N轮-YYYY-MM-DD.md`。
 *   新命名约定起出来的名字
 *     `交接-110ef306-第3轮-2026-10-01-coder-交接窗口标号.md`
 *   一律 `date=''` ⇒ `resolveHandover`（:527-535）的 `dated` 池空 ⇒ **退化成 mtime**。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 判据分六组，**每组都带负控**（A6：只报正例的台账一律不信）
 * ════════════════════════════════════════════════════════════════════════════
 *   A 旧形状仍认（"只放宽、不收紧"）—— 5 条
 *   B 新形状认 —— 3 条
 *   C 负控：非法月日 / 垃圾名 / 前缀超长或含大写 / 结尾不是 .md / 双日期 / 短码位数不对 —— 15 条
 *   D **选举口径正控（本用例的核心）** —— mtime 与日期**故意相反**，证明挑的是**日期较晚**那份
 *   E 归档行为不变 —— 7 条
 *   F A/B 决定性对照：同一份夹具在**改动前**那份插件上必须**挑错**（证明 D 组不是恒真）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 铁律
 * ════════════════════════════════════════════════════════════════════════════
 *   · 被测件只走插件自己标着"给自检用"的出口 `_internals.dateOfHandoverName` /
 *     `isArchivedHandoverName` / `listHandovers` / `resolveHandover`，**不 import `warden.mjs`**。
 *   · **夹具全在 `%TEMP%`（`os.tmpdir()`）**，一个字节都不写进真工程。
 *   · ⚠ **本用例不 import `common.mjs`**，所以它**不读 `DSH_HOME`、不碰真安装**
 *     （`common.mjs` 的 `SKILL_ROOT` 会落到真 `.dsh`；绕开它就不存在这个问题）。
 *   · 被测件是哪一份**现读现算**并把 sha256 钉在输出里；`HANDOVER_GATE_JS` 可显式指定
 *     （R32 直线里测 work 副本时就靠它），基线件用 `HANDOVER_GATE_BASELINE_JS`。
 *   · A6：**A6 组找不到基线、或基线与被测件逐字相同** ⇒ F 组**如实 SKIP**，不是 PASS。
 *
 * 用法：
 *   node L46_handover_date_prefix.mjs                       # 测仓库那份 plugin/handover-gate.js
 *   set HANDOVER_GATE_JS=<work 副本>                          # 测 R32 的 work 副本
 *   set HANDOVER_GATE_BASELINE_JS=<orig 原件>                 # 同时做 A/B 对照
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 被测件定位（现读现算 + 钉 sha256；一个都不存在 ⇒ 按失败计，不许报"没发现问题"）
 * ══════════════════════════════════════════════════════════════════════════ */

const SUBJECT = path.resolve(
  process.env.HANDOVER_GATE_JS || path.join(REPO_ROOT, 'plugin', 'handover-gate.js')
);
const BASELINE = process.env.HANDOVER_GATE_BASELINE_JS
  ? path.resolve(process.env.HANDOVER_GATE_BASELINE_JS)
  : null;

function meta(p) {
  try {
    const st = fs.statSync(p);
    return {
      exists: true, bytes: st.size, mtime: st.mtime.toISOString(),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
    };
  } catch (e) { return { exists: false }; }
}

function load(p) {
  const m = meta(p);
  if (!m.exists) return { mod: null, meta: m, err: `文件不存在：${p}` };
  try { return { mod: require(p), meta: m, err: null }; }
  catch (e) { return { mod: null, meta: m, err: 'require 失败：' + String((e && e.message) || e) }; }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 用例表
 * ══════════════════════════════════════════════════════════════════════════ */

/** A 组：旧形状仍认（"只放宽、不收紧"） */
const OLD_SHAPES = [
  { n: '交接-2026-09-24.md', d: '20260924', why: '最原始的形状' },
  { n: '交接-第57轮-2026-09-26.md', d: '20260926', why: '轮号段（S10 那一版放宽的）' },
  { n: '交接-2026-9-24.md', d: '20260924', why: '月/日不补零仍认（S10）' },
  { n: '交接-第6轮-2026-10-01-主代理-defend守卫与精度.md', d: '20261001', why: '今天真实起的名（轮号段 + 结尾主题）' },
  { n: '交接.md', d: '', why: '首选名走短路，本函数**不该**把它认成日期型' },
];

/** B 组：新命名约定（`交接-<会话短8位>-第<N>轮-<YYYY-MM-DD>-<角色>-<主题>.md`） */
const NEW_SHAPES = [
  { n: '交接-110ef306-第3轮-2026-10-01-coder-交接窗口标号.md', d: '20261001', why: '任务书给的那一例' },
  { n: '交接-110ef306-第4轮-2026-10-01-coder-日期口径.md', d: '20261001', why: '本单自己的留痕文件名' },
  { n: '交接-110ef306-2026-10-01-coder-x.md', d: '20261001', why: '短码后**省掉**轮号段仍认（只放宽不收紧）' },
];

/** C 组：负控 —— 这些**必须**取不到日期键 */
const NEGATIVES = [
  { n: '交接-2026-13-01.md', why: '月 13' },
  { n: '交接-2026-00-05.md', why: '月 0' },
  { n: '交接-2026-10-32.md', why: '日 32' },
  { n: '交接-2026-10-00.md', why: '日 0' },
  { n: '交接-110ef306-第1轮-2026-13-01-coder-x.md', why: '**新形状**下非法月照样被拒（校验没被绕过）' },
  { n: '交接-110ef306-第1轮-2026-10-32-coder-x.md', why: '**新形状**下非法日照样被拒' },
  { n: '交接-随便什么.md', why: '垃圾名（任务书点名）' },
  { n: '交接-.md', why: '垃圾名（任务书点名）' },
  { n: '交接-XXXXXXXXXXXX-2026-10-01.md', why: '前缀 12 位 + 大写（任务书点名）' },
  { n: '交接-ABCDEFGH-2026-10-01.md', why: '前缀恰好 8 位但**含大写**' },
  { n: '交接-110ef30-2026-10-01.md', why: '短码只有 7 位' },
  { n: '交接-110ef3061-2026-10-01.md', why: '短码 9 位' },
  { n: '交接-随便什么-2026-10-01.md', why: '前缀不是 8 位小写字母数字' },
  { n: '交接-110ef306-第1轮-2026-10-01-主代理-主题.txt', why: '结尾不是 .md（任务书点名）' },
  { n: '交接-2026-10-01-2026-12-31-双日期.md', why: '两个日期：不许被含糊地取第一个' },
];

/** E 组：归档词表与排除行为 */
const ARCHIVE_CASES = [
  { n: '交接-归档-第24轮起全文-2026-09-26.md', want: true, why: '本工程真有的那份 355 KB 归档' },
  { n: '交接-110ef306-第3轮-2026-10-01-coder-归档全文.md', want: true, why: '**新形状** + 归档词 ⇒ 仍然排除' },
  { n: '交接-全文-2026-01-01.md', want: true, why: '只有「全文」' },
  { n: '交接.md', want: false, why: '首选名 = 总账，永远不排除' },
  { n: '交接-110ef306-第3轮-2026-10-01-coder-正常.md', want: false, why: '正常新形状不该被误排除' },
  { n: '交接-归档.md', want: true, why: '命中「归档」，没有日期也不影响' },
];

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 夹具工具（**只在 %TEMP%**，真工程一个字节都不写）
 * ══════════════════════════════════════════════════════════════════════════ */

const TMP_ROOT = path.join(os.tmpdir(), 'warden-lab-l46');

/** 造一个"工程根"：给定 `[{name, mtime}]`，**故意不放** `交接.md`（它会走首选名短路）。 */
function makeRoot(tag, files) {
  const dir = path.join(TMP_ROOT, tag);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 不存在就算了 */ }
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const p = path.join(dir, f.name);
    fs.writeFileSync(p, `# 夹具：${f.name}\n`, 'utf8');
    if (f.mtime) fs.utimesSync(p, f.mtime, f.mtime);
  }
  return dir;
}

/** 把某个时刻写成 fs.utimes 认的 Date；`y` 早 = mtime 小 */
const T_OLD = new Date('2020-01-01T00:00:00Z');
const T_MID = new Date('2026-06-01T00:00:00Z');
const T_NEW = new Date('2030-01-01T00:00:00Z');

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 主流程
 * ══════════════════════════════════════════════════════════════════════════ */

export default async function run() {
  const checks = [];
  const skipped = [];
  const check = (item, ok, detail = '') => { checks.push({ name: item, ok: !!ok, detail: String(detail).slice(0, 600) }); return !!ok; };
  const skip = (item, why) => { skipped.push({ name: item, why: String(why).slice(0, 400) }); };

  const id = 'L46';
  const name = '交接名日期口径：新命名约定不许把「挑最新一份」退化成 mtime';

  // ── 0) 定位
  const S = load(SUBJECT);
  check('【定位】被测的 handover-gate.js 存在且 require 成功（A6：输入为 0 不许报成功）',
    !!S.mod,
    S.mod
      ? `${SUBJECT}\n  ${S.meta.bytes} 字节  sha256=${S.meta.sha256.slice(0, 16)}…  mtime=${S.meta.mtime}`
      : `${SUBJECT}\n  ${S.err}`);

  if (!S.mod) {
    return { id, name, status: 'FAIL', pass: false,
      reason: '被测件不存在或 require 失败 ⇒ 一条判据都跑不了（按失败计，不许报"没发现问题"）',
      checks, skipped };
  }

  const I = S.mod._internals;
  const dateOf = I.dateOfHandoverName;
  const isArch = I.isArchivedHandoverName;
  const listHandovers = I.listHandovers;
  const resolveHandover = I.resolveHandover;

  check('【出口】插件导出了本用例要用的四个出口',
    !!(dateOf && isArch && listHandovers && resolveHandover),
    `dateOfHandoverName=${typeof dateOf} isArchivedHandoverName=${typeof isArch} listHandovers=${typeof listHandovers} resolveHandover=${typeof resolveHandover}`);

  // ── A) 旧形状仍认
  for (const t of OLD_SHAPES) {
    const got = dateOf(t.n);
    check(`A 旧形状仍认：${t.n} → ${t.d === '' ? "''（取不到日期键）" : t.d}  · ${t.why}`,
      got === t.d, `实得 ${JSON.stringify(got)}`);
  }

  // ── B) 新形状认
  for (const t of NEW_SHAPES) {
    const got = dateOf(t.n);
    check(`B 新形状认：${t.n} → ${t.d}  · ${t.why}`, got === t.d, `实得 ${JSON.stringify(got)}`);
  }

  // ── C) 负控
  for (const t of NEGATIVES) {
    const got = dateOf(t.n);
    check(`C 负控：${t.n} 必须取不到日期键（${t.why}）`, got === '', `实得 ${JSON.stringify(got)}`);
  }

  // ── D) 选举口径（本用例的核心）
  /**
   * D 组统一口径：**故意让 mtime 与日期相反**，然后断言挑中的是**日期较晚**那份。
   * 每一组都另附一条「旧形状对照组」—— 它在**改动前后都该绿**，用来证明
   * "夹具本身是好的、红的不是夹具坏"（D 组若是恒真的，这一条会跟着一起假绿 ⇒ 只能靠 F 组拆穿）。
   */
  const ELECTIONS = [
    {
      tag: 'd1-mtime-inverted',
      title: 'D1 新形状 + 旧形状，mtime 故意相反（核心）',
      expect: '交接-110ef306-第3轮-2026-10-01-coder-新.md',
      files: [
        { name: '交接-110ef306-第3轮-2026-10-01-coder-新.md', mtime: T_OLD },   // 日期较晚，mtime 较旧
        { name: '交接-2026-09-24.md', mtime: T_NEW },                            // 日期较早，mtime 较晚
      ],
    },
    {
      tag: 'd2-same-mtime',
      title: 'D2 两份都是新形状、mtime **完全相同**',
      expect: '交接-110ef306-第3轮-2026-10-01-coder-a.md',
      files: [
        { name: '交接-110ef306-第3轮-2026-10-01-coder-a.md', mtime: T_MID },
        { name: '交接-110ef306-第5轮-2026-09-20-coder-b.md', mtime: T_MID },
      ],
    },
    {
      tag: 'd3-both-new-mtime-inverted',
      title: 'D3 两份都是新形状，mtime 故意相反',
      expect: '交接-aaaaaa11-第1轮-2026-10-01-coder-a.md',
      files: [
        { name: '交接-aaaaaa11-第1轮-2026-10-01-coder-a.md', mtime: T_OLD },
        { name: '交接-bbbbbb22-第1轮-2026-09-01-coder-b.md', mtime: T_NEW },
      ],
    },
    {
      tag: 'd4-old-shapes-control',
      title: 'D4 **对照组**：全是旧形状、mtime 故意相反（改动前后都该绿）',
      expect: '交接-2026-10-01.md',
      control: true,
      files: [
        { name: '交接-2026-10-01.md', mtime: T_OLD },
        { name: '交接-2026-09-24.md', mtime: T_NEW },
      ],
    },
  ];

  const electionRows = [];
  for (const e of ELECTIONS) {
    const dir = makeRoot(e.tag, e.files);
    const r = resolveHandover(dir, null);
    const ok = !!(r && r.ok && r.picked === e.expect);
    electionRows.push({ tag: e.tag, expect: e.expect, picked: (r && r.picked) || String(r && r.why), ok });
    check(`${e.title} ⇒ 必须挑中「${e.expect}」${e.control ? '（对照组：它证明夹具没坏）' : ''}`,
      ok,
      `夹具（mtime 故意相反）：\n` +
      e.files.map((f) => `    ${f.name}  mtime=${f.mtime.toISOString()}`).join('\n') +
      `\n  实得 picked=${JSON.stringify(r && r.picked)}  how=${JSON.stringify(r && r.how)}`);

    // 附带钉住「取到的日期键确实是我们要的那一个」
    if (ok) {
      const cands = listHandovers(dir, null);
      const hit = cands.find((x) => x.name === e.expect);
      check(`  └ D-list：${e.expect} 的 date 键 = ${dateOf(e.expect)}（选举池里不许是 ''）`,
        !!hit && hit.date === dateOf(e.expect) && hit.date !== '',
        `listHandovers 里这条 = ${JSON.stringify(hit)}`);
    }
  }

  // ── E) 归档行为不变
  for (const t of ARCHIVE_CASES) {
    const got = isArch(t.n);
    check(`E 归档判定不变：${t.n} ⇒ ${t.want}（${t.why}）`, got === t.want, `实得 ${got}`);
  }

  {
    // E-1：只有归档件时，闸**不许**挑中它（必须是 none）
    const dir = makeRoot('e1-archive-only', [
      { name: '交接-110ef306-第3轮-2026-10-01-coder-归档全文.md', mtime: T_NEW },
      { name: '交接-归档-第24轮起全文-2026-09-26.md', mtime: T_OLD },
    ]);
    const r = resolveHandover(dir, null);
    check('E 归档件**不许**被新正则救回选举池（只有归档件 ⇒ 必须报"这个工程没有交接"）',
      !!(r && r.ok === false && r.why === 'none'),
      `实得 = ${JSON.stringify(r)}`);
    const names = listHandovers(dir, null).map((x) => x.name);
    check('E 归档件连 `listHandovers` 的选举池都不进', names.length === 0, `实得候选 = ${JSON.stringify(names)}`);
  }

  {
    // E-2：一份正常新形状 + 一份**日期更晚的**归档件 ⇒ 仍必须挑正常那份
    const dir = makeRoot('e2-archive-later', [
      { name: '交接-110ef306-第3轮-2026-10-01-coder-正常.md', mtime: T_OLD },
      { name: '交接-aaaaaa11-第1轮-2026-12-31-coder-归档全文.md', mtime: T_NEW },
    ]);
    const r = resolveHandover(dir, null);
    check('E 归档件**日期更晚**也不许赢（正常那份仍必须被挑中）',
      !!(r && r.ok && r.picked === '交接-110ef306-第3轮-2026-10-01-coder-正常.md'),
      `归档件 20261231 / 正常件 20261001\n  实得 picked=${JSON.stringify(r && r.picked)}`);
  }

  {
    /**
     * E-3：新正则**只**放宽「取日期键」那一层 —— `isHandoverName`（:304-308）的宽严一个字没动。
     *
     * ⚠ 这里的期望值是**实测钉下来的，不是推的**：
     *   `isHandoverName` 要求 `s.length > HANDOVER_PREFIX.length + HANDOVER_SUFFIX.length`
     *   （即 `> 3 + 3 = 6`），而 `交接-.md` 长度**恰好是 6** ⇒ 判 false。
     *   ⚠ 我第一版把这条写成 `true`、跑出来是红的 —— 去核对发现**是这条期望写错了**，
     *   不是插件坏了：改动前的原件上它同样判 `false`（F 组另有一条 A/B 相等断言钉住这一点）。
     *   ⇒ 记在这里，免得下一个来的人以为"改之前这条是 true"。
     */
    const names = [
      '交接-2026-09-24.md', '交接-随便什么.md', '交接-.md',
      '交接-110ef306-第3轮-2026-10-01-coder-主题.md', '交接-110ef306-第1轮-2026-10-01-主代理-主题.txt',
    ];
    const want = [true, true, false, true, false];   // 交接-.md 长度恰好 6，`>6` 不成立 ⇒ false
    const got = names.map((n) => I.isHandoverName(n));
    check('E `isHandoverName` 行为未被本改动波及（`交接-.md` 长度恰 6 ⇒ 仍判 false；结尾不是 .md 仍不算交接文件）',
      JSON.stringify(got) === JSON.stringify(want),
      `${names.map((n, i) => `      ${String(got[i]).padEnd(5)} ← ${n}`).join('\n')}`);
  }

  // ── F) A/B 决定性对照：同一份夹具在**改动前**那份插件上必须挑错
  let base = null;
  if (BASELINE && meta(BASELINE).exists) base = load(BASELINE);
  const baseUsable = !!(base && base.mod && base.meta.sha256 !== S.meta.sha256);

  if (!BASELINE) {
    skip('F A/B 对照（改动前那份插件上必须挑错）', '没给 HANDOVER_GATE_BASELINE_JS ⇒ 判不了，如实跳过（不是通过）');
  } else if (!baseUsable) {
    skip('F A/B 对照（改动前那份插件上必须挑错）',
      `基线 ${BASELINE} 与被测件逐字相同（sha 都是 ${(base ? base.meta.sha256 : '').slice(0, 16)}…）` +
      ` ⇒ 没有"改动前"可比，如实跳过（不是通过）。要让 F 组真跑，请把**原件**放到 HANDOVER_GATE_BASELINE_JS`);
  } else {
    const bDate = base.mod._internals.dateOfHandoverName;
    const bResolve = base.mod._internals.resolveHandover;
    const bIsArch = base.mod._internals.isArchivedHandoverName;
    const bMeta = base.meta;

    // F-1：新形状用例在基线上必须**取不到**日期键（这正是"退化"的入口）
    const bNew = NEW_SHAPES.map((t) => ({ n: t.n, got: bDate(t.n) }));
    const allEmpty = bNew.every((x) => x.got === '');
    check('F-1 基线（改动前）上**新形状一律取不到日期键** —— 这就是退化到 mtime 的入口',
      allEmpty,
      `基线：${BASELINE}\n  sha256=${bMeta.sha256.slice(0, 16)}…  ${bMeta.bytes} 字节\n` +
      bNew.map((x) => `    ${x.n} → ${JSON.stringify(x.got)}`).join('\n'));

    // F-2：同一份 D1 夹具，基线必须挑**错**（mtime 较晚那份）
    const dir = makeRoot('f2-baseline-election', ELECTIONS[0].files);
    const br = bResolve(dir, null);
    const sr = resolveHandover(dir, null);
    check('F-2 同一份夹具：基线挑的是 mtime 较晚那份（= 退化），被测件挑的是日期较晚那份',
      !!(br && br.ok && br.picked === '交接-2026-09-24.md' && sr && sr.ok && sr.picked === ELECTIONS[0].expect),
      `夹具：\n` + ELECTIONS[0].files.map((f) => `    ${f.name}  mtime=${f.mtime.toISOString()}`).join('\n') +
      `\n  基线 picked = ${JSON.stringify(br && br.picked)}   （mtime 较晚、日期较早 ⇒ 退化）` +
      `\n  被测 picked = ${JSON.stringify(sr && sr.picked)}   （日期较晚、mtime 较旧 ⇒ 修好了）`);

    // F-3：对照组 D4 在两边**都**该绿（证明改动没伤旧路径）
    const d4 = ELECTIONS.find((e) => e.tag === 'd4-old-shapes-control');
    const d4dir = makeRoot('f3-control', d4.files);
    const b4 = bResolve(d4dir, null);
    const s4 = resolveHandover(d4dir, null);
    check('F-3 对照组 D4（纯旧形状）在基线与被测件上**都**挑中日期较晚那份（没伤旧路径）',
      !!(b4 && b4.ok && b4.picked === d4.expect && s4 && s4.ok && s4.picked === d4.expect),
      `基线 picked=${JSON.stringify(b4 && b4.picked)}   被测 picked=${JSON.stringify(s4 && s4.picked)}   应=${d4.expect}`);

    // F-4：负控在基线上**也**必须全空 —— 负控不是"新正则才有"，是本来的契约
    const bNeg = NEGATIVES.map((t) => ({ n: t.n, got: bDate(t.n) }));
    const negAllEmpty = bNeg.every((x) => x.got === '');
    check('F-4 负控清单在**基线**上也必须全空（证明这些负控不是新正则"顺手造"的）',
      negAllEmpty,
      bNeg.filter((x) => x.got !== '').map((x) => `    ${x.n} → ${JSON.stringify(x.got)}`).join('\n') || '    （基线上全空）');

    // F-5：`isHandoverName` 与 `isArchivedHandoverName` 在两边必须**逐条完全相同**
    //      —— 这一条让 E 组那些"实测钉下来的期望值"没法被"改成让改动通过"。
    const probeNames = [...OLD_SHAPES, ...NEW_SHAPES, ...NEGATIVES, ...ARCHIVE_CASES].map((t) => t.n);
    const diffs = [];
    for (const n of probeNames) {
      const bh = base.mod._internals.isHandoverName(n);
      const sh = I.isHandoverName(n);
      const ba = bIsArch(n);
      const sa = isArch(n);
      if (bh !== sh) diffs.push(`isHandoverName      基线=${bh} 被测=${sh}  ${n}`);
      if (ba !== sa) diffs.push(`isArchivedHandoverName 基线=${ba} 被测=${sa}  ${n}`);
    }
    check('F-5 `isHandoverName` / `isArchivedHandoverName` 在基线与被测件上**逐条完全相同**（本改动只许动日期键那一层）',
      diffs.length === 0,
      diffs.length ? diffs.join('\n') : `      ${probeNames.length} 个名字，两边逐条相同`);
  }

  /* ── 输出 ── */
  const line = '='.repeat(96);
  console.log(line);
  console.log('L46 · 交接名日期口径 —— 挑「最新一份交接」不许退化成 mtime');
  console.log(line);
  console.log(`被测件 : ${SUBJECT}`);
  console.log(`         ${S.meta.bytes} 字节  sha256=${S.meta.sha256}  mtime=${S.meta.mtime}`);
  console.log(`基线件 : ${BASELINE || '(未指定 ⇒ F 组如实 SKIP)'}`);
  if (base) console.log(`         ${base.meta.bytes} 字节  sha256=${base.meta.sha256}  mtime=${base.meta.mtime}`);
  console.log(`夹具根 : ${TMP_ROOT}（%TEMP%，真工程一个字节都没写）`);
  console.log(line);
  console.log('日期键：');
  console.log('  A 旧形状仍认');
  for (const t of OLD_SHAPES) console.log(`      ${t.d.padEnd(9)} ← ${t.n}`);
  console.log('  B 新形状认');
  for (const t of NEW_SHAPES) console.log(`      ${t.d.padEnd(9)} ← ${t.n}`);
  console.log("  C 负控（必须都是 ''）");
  for (const t of NEGATIVES) console.log(`      ${String(dateOf(t.n)).padEnd(9)} ← ${t.n}   （${t.why}）`);
  console.log(line);
  console.log('选举（mtime 故意与日期相反）：');
  for (const r of electionRows) console.log(`  ${r.ok ? '[绿]' : '[红]'} ${r.tag}  期望=${r.expect}  实得=${r.picked}`);
  console.log(line);
  const bad = checks.filter((x) => !x.ok);
  for (const x of bad) console.log(`[红] ${x.name}\n     ${x.detail}`);
  for (const s of skipped) console.log(`[SKIP] ${s.name}\n      ${s.why}`);
  console.log(line);
  console.log(`L46：${checks.length} 条判据，${checks.length - bad.length} 过 / ${bad.length} 红 / ${skipped.length} 如实跳过`);
  console.log(line);

  const ok = bad.length === 0;
  return {
    id, name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? `新命名约定的日期键取到了（${NEW_SHAPES.length} 条正控），旧形状一条没伤（${OLD_SHAPES.length} 条），` +
        `负控 ${NEGATIVES.length} 条全被拒；选举在 mtime 与日期相反时挑的是**日期较晚**那份；归档判定零变化。`
      : `共 ${bad.length} 条红：${bad.map((x) => x.name.slice(0, 60)).join(' / ')}`,
    checks,
    skipped,
  };
}

/* 允许 `node L46_....mjs` 直接跑（套件之外的单独跑法） */
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('L46_handover_date_prefix.mjs')) {
  const r = await run();
  process.exit(r.pass ? 0 : 1);
}
