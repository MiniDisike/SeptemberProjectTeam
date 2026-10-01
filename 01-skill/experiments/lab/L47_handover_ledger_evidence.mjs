#!/usr/bin/env node
/**
 * L47 · 交接写闸的**证据不许被吃掉**（钉 P-M35 的三个缺陷：C / A / B）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 三个缺陷（逐条来自 `handover-gate.js` 的实测，不是读码推的）
 * ════════════════════════════════════════════════════════════════════════════
 *  **C · `WRITE_HINTS` 最后一个分支 `>\s*[^&\s]` 把"丢弃 stderr"判成改盘**
 *     `2>$null` / `2>NUL` 是**什么都不写**的丢弃目标，却被记成"这个 shell 改了文件"
 *     ⇒ 写闸的脏清单被**只读 shell** 灌满（实测 `dirty=14` 那笔账就是这么来的）。
 *     修法必须**精确**：只排除「整个 token 就是 `$null` / `NUL`」这一种，
 *     `2> somefile` / `*>` / `Out-File` / `Set-Content` … **仍然必须判写**。
 *
 *  **A · `onToolResult` 里 `state.pending.delete(rootKey)` 返回 false 时账本里一行都不落**
 *     `write-gate-cleared` 落不了、`handover-updated` 只进内存 ring 不落盘
 *     ⇒ 查账本**分不清**「这次调用压根没被记账侧看见」与「被看见了但没解锁」。
 *     修法：在 `if` **之前无条件**落一行 `handover-write-seen`（带 `pendingHit`）。
 *
 *  **B · `logRow` 的去重键里没有 `rootKey`**
 *     `turn-dirty` 行既没有 `path` 也没有 `target` ⇒ 同一 sid 同一回合的**多个工程根**
 *     共用一个键 ⇒ 3 秒内只落一行 ⇒ **被吃掉的那一条恰恰是唯一能证明路径取到了的证据**。
 *     修法：去重键加 `rootKey`。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 判据分六组，**每组都带负控**（A6：只报正例的台账一律不信）
 * ════════════════════════════════════════════════════════════════════════════
 *   C-1 正控：12 条真写动作**全部必须命中**（不许被"不认重定向"顺带收掉）
 *   C-2 负控：`2>$null` / `2>NUL` 的各种大小写与写法**全部必须不命中**（= 本单修的那一条）
 *   C-3 边界：`$nullx` / `nul.txt` / `NUL.out` **长得像丢弃但不是** ⇒ 必须仍然命中
 *   C-4 稳定：`2>&1` / `>&1` / `Get-Content` / `git status` … 本来就 false 的**仍然 false**
 *   C-5 **A/B 对照**：同一批探针跑在**改动前**那份插件上 ⇒ C-2 必须**全部命中**（证明这条有牙）
 *   A-1 欠账被兄弟会话消耗掉后再写交接 ⇒ 账本里**必须出现** `handover-write-seen`
 *       且 `pendingHit === false`；A-2 对照行（兄弟会话那次）`pendingHit === true`
 *       且旁边有 `write-gate-cleared`；A-3 **A/B 对照**：改动前那份插件上**零行**
 *   B-1 同一 sid、同一回合、**两个不同工程根** ⇒ 账本里**必须落两行** `turn-dirty`
 *       且两个 `rootKey` 不同、路径各自取到
 *   B-2 **取舍读数**：同一 sid、同一回合、**同一个根的多个文件** ⇒ 仍然只落**一行**
 *       （证明"加 rootKey"不是白赚：它分开的只有**不同工程根**）
 *   B-3 **A/B 对照**：改动前那份插件上 B-1 只落**一行**
 *   B-4 【如实记账·残余洞】去重键里**没有 `turn`** ⇒ 同 sid 同根**相邻两回合**仍被吃掉
 *       （本单**没修**的那一条，钉住现状：将来谁修好了，这条会红，逼着他有意识地改判据）
 *   D-1 写闸**仍然**拦得住 shell 写动作（钉住"不许为了让自检变绿而放宽既有判据"）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 铁律
 * ════════════════════════════════════════════════════════════════════════════
 *   · 被测件只走插件自己标着"给自检用"的出口（`_internals`），**不 import `warden.mjs`**。
 *   · **夹具全在 `%TEMP%`（`os.tmpdir()`）**，一个字节都不写进真工程。
 *   · **不 spawn 任何子进程**（只 `fs` + `require`）⇒ 不受"管道 stdio EPERM"影响。
 *   · 被测件现读现算并把 sha256 钉在输出里；`HANDOVER_GATE_JS` 可显式指定
 *     （R32 直线里测 work 副本、或测**故意删掉修复的变体**时就靠它），
 *     基线件用 `HANDOVER_GATE_BASELINE_JS`。
 *   · A6：找不到基线、或基线与被测件逐字相同 ⇒ 对照组**如实 SKIP**，不是 PASS。
 *
 * 用法：
 *   node L47_handover_ledger_evidence.mjs                                   # 测仓库那份 plugin/handover-gate.js
 *   set HANDOVER_GATE_JS=<work 副本>                                       # 测 R32 的 work 副本
 *   set HANDOVER_GATE_BASELINE_JS=<orig 原件>                              # 同时做 A/B 对照
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 运行期派生的工程根：从本文件往上找第一个装着 `patch-pipeline.mjs` 的那一层 */
function pickRepoRoot() {
  let d = HERE;
  for (let i = 0; i < 8; i++) {
    try { if (fs.existsSync(path.join(d, 'patch-pipeline.mjs'))) return d } catch (e) { /* 下一层 */ }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return path.resolve(HERE, '..', '..');
}
const REPO_ROOT = pickRepoRoot();

const id = 'L47';
const name = 'L47_handover_ledger_evidence';

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
 * 1. C 组探针表
 * ══════════════════════════════════════════════════════════════════════════ */

/** C-1 正控：**真的在写**的 shell 动作 ⇒ 一条都不许被收掉 */
const C_POS = [
  { cmd: 'node build.js > out.txt', why: '普通重定向（任务书点名）' },
  { cmd: 'node build.js >> out.txt', why: '追加重定向' },
  { cmd: 'node build.js *> all.txt', why: '全流重定向（任务书点名）' },
  { cmd: 'node build.js 2> err.txt', why: 'stderr **进文件** ⇒ 是写（任务书点名）' },
  { cmd: 'node build.js 2>&1 | Tee-Object run.log', why: '`Tee-Object` 仍必须判写（任务书点名）' },
  { cmd: 'Out-File out.txt', why: '任务书点名' },
  { cmd: 'Set-Content -Path x -Value hi', why: '任务书点名 + 自检 ⑰e 用的就是它' },
  { cmd: 'Add-Content -Path x -Value hi', why: '任务书点名' },
  { cmd: 'Tee-Object -FilePath x', why: '任务书点名' },
  { cmd: 'Remove-Item x', why: '任务书点名' },
  { cmd: 'Copy-Item a b', why: '任务书点名' },
  { cmd: 'Move-Item a b', why: '任务书点名' },
  { cmd: 'New-Item -Force -ItemType File x', why: '任务书点名（`New-Item -Force`）' },
  { cmd: 'Rename-Item a b', why: '任务书点名' },
];

/** C-2 负控：**丢弃 stderr、什么都不写** ⇒ 一条都不许命中（本单修的正是这一组） */
const C_NEG = [
  { cmd: 'node x.js 2>$null', why: '任务书点名的原句' },
  { cmd: 'node x.js 2>$NULL', why: '大写' },
  { cmd: 'node x.js 2>$Null', why: '混合大小写（正则是 `/i`）' },
  { cmd: 'node x.js 2> $null', why: '中间有空格' },
  { cmd: 'node x.js 2>   $null', why: '多个空格' },
  { cmd: 'node x.js 2>NUL', why: '任务书点名的原句' },
  { cmd: 'node x.js 2>nul', why: '小写' },
  { cmd: 'node x.js 2> NUL', why: '中间有空格' },
  { cmd: 'node x.js 2>Nul', why: '混合大小写' },
  { cmd: 'node x.js 2>$null | Out-Null', why: '丢弃 + 继续管道' },
  { cmd: 'node x.js *>$null', why: '全流丢弃（PowerShell 的 `*>`；⚠ 旧稿也命中它）' },
  { cmd: 'node x.js 2>$null; Get-Content x', why: '丢弃后接一条只读命令' },
  { cmd: 'node x.js 2>$null | Select-String -Path a', why: '丢弃后接只读命令（任务书负控形状）' },
  { cmd: '$js | & $node -e "0" -- 2>$null | Out-Null', why: '任务书给的**原样那一串**' },
];

/** C-3 边界：长得像丢弃目标、**但不是** ⇒ 必须仍然判写（不许收得太宽） */
const C_BOUNDARY = [
  { cmd: 'node x.js 2>$nullx', why: '目标叫 `$nullx`（不是 `$null`）⇒ 写' },
  { cmd: 'node x.js 2>$null.tmp', why: '目标叫 `$null.tmp` ⇒ 写' },
  { cmd: 'node x.js 2>nul.txt', why: '目标叫 `nul.txt`（不是 `NUL`）⇒ 写' },
  { cmd: 'node x.js 2> NUL.out', why: '目标叫 `NUL.out` ⇒ 写' },
  { cmd: 'node x.js 2>nulx', why: '目标叫 `nulx` ⇒ 写' },
];

/** C-4 稳定：本来就 false 的**必须仍然 false**（不许把闸收成一个什么都拦的假闸） */
const C_STABLE = [
  { cmd: 'node --check x.js 2>&1', why: '自检 SHELL_PROBES 里就有它，一直不命中' },
  { cmd: 'cmd >&1', why: '`>&1` 一直不命中（`&` 被排除）' },
  { cmd: 'Get-Content x', why: '任务书负控' },
  { cmd: 'Select-String -Path a', why: '任务书负控' },
  { cmd: '& $node -', why: '任务书负控' },
  { cmd: 'node selftest.mjs', why: '任务书负控' },
  { cmd: 'Get-FileHash f', why: '任务书负控' },
  { cmd: 'git status', why: '自检 SHELL_PROBES 里就有它' },
  { cmd: 'ls -la', why: '自检 SHELL_PROBES 里就有它' },
];

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 夹具工具（**只在 %TEMP%**，真工程一个字节都不写）
 * ══════════════════════════════════════════════════════════════════════════ */

const TMP_ROOT = path.join(os.tmpdir(), 'warden-lab-l47');

/** 造一个工程夹具：`.git` + `.warden` + `交接.md`（`findProjectRootVia` 认得出） */
function mkProject(tag) {
  const root = path.join(TMP_ROOT, tag);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* 不存在就算了 */ }
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.warden'), { recursive: true });
  fs.writeFileSync(path.join(root, '交接.md'), '# 交接\n', 'utf8');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const f of ['a.js', 'b.js', 'c.js']) fs.writeFileSync(path.join(root, 'src', f), 'x\n', 'utf8');
  return root;
}

/** 最小假 ctx（只用 `on` / `effect`；本用例不核 ctx 卫生，那是自检的事） */
function makeFakeCtx() {
  const listeners = new Map();
  return {
    listeners,
    ctx: {
      on(name, fn) {
        const arr = listeners.get(name) || [];
        arr.push(fn);
        listeners.set(name, arr);
        return () => { const a = listeners.get(name) || []; const i = a.indexOf(fn); if (i >= 0) { a.splice(i, 1); return true } return false }
      },
      effect(execute) { const d = execute(); return () => { try { d() } catch (e) { /* 摘不掉 */ } } },
    },
  };
}

function fakeAgent(sid, cwd, turn) {
  return { session: { header: { id: sid, cwd: cwd } }, steers: [], phase: { kind: 'running', turn: turn } };
}

const OK_RESULT = { isError: false, content: [{ type: 'text', text: 'ok' }] };
function execOf(toolName, args, agent) { return { name: toolName, arguments: args, agent: agent } }
function writeExec(file, agent) { return execOf('write', { file_path: file }, agent) }
function readExec(file, agent) { return execOf('read', { file_path: file }, agent) }
function shellExec(cmd, agent) { return execOf('pwsh', { command: cmd }, agent) }

/**
 * 起一个装载好的实例，`logPath` 指到 `%TEMP%` 下的账本。
 * ⚠ 必须**显式**调一次 `resolveLogPath`：`state.logPath` 在真实插件里是由
 *   `tools/pre-execute` 那条链懒解析的（`decideWrite` 里），而 A/B 两个场景
 *   只走 `tools/result` 那一侧 ⇒ 不显式解析的话 `logRow` 第一行就 `return`，
 *   账本会是空的（那样测出来的"零行"是**假的零行**，正是本用例要抓的病）。
 */
function boot(m, logPath, root) {
  const h = makeFakeCtx();
  const state = m.install(h.ctx, { logPath });
  m._internals.resolveLogPath(state, root || '', { logPath }, null);
  return { h, state };
}
function fireResult(h, exec, result) { for (const fn of (h.listeners.get('tools/result') || [])) fn(exec, result) }
function fireTurnStopping(h, payload) { for (const fn of (h.listeners.get('agent/turn-stopping') || [])) fn(payload) }
/** 复刻 waterfall（cordis 的 `next()` 链）—— 用来喂 pre-execute 拿 allow/deny */
function makeWaterfall(listeners) {
  return async function run(exec) {
    const cbs = (listeners || []).slice();
    const inner = () => Promise.resolve({ kind: 'allow' });
    const next = () => (cbs.shift() || inner)(exec, next);
    return next();
  };
}
function readLog(logPath) {
  let raw = '';
  try { raw = fs.readFileSync(logPath, 'utf8') } catch (e) { return [] }
  return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch (e) { return { ev: '(解析失败)', raw: l } } });
}
const rowsOf = (rows, ev) => rows.filter((r) => r.ev === ev);

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 判据容器
 * ══════════════════════════════════════════════════════════════════════════ */

async function run() {
  const checks = [];
  const skipped = [];
  const readings = [];
  const check = (n, title, ok, detail) => { checks.push({ name: `${n} ${title}`, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); return !!ok };
  const skip = (n, title, why) => { skipped.push({ name: `${n} ${title}`, why: String(why) }); };
  const read = (s) => { readings.push(String(s)); };

  const S = load(SUBJECT);
  if (!S.mod) {
    check(`${id}-0`, '被测件能 require 进来', false, `${SUBJECT}\n  ${S.err}`);
    return finish();
  }
  const M = S.mod;
  const I = M._internals;
  check(`${id}-0`, '被测件能 require 进来，且带 `_internals.WRITE_HINTS`', !!I && !!I.WRITE_HINTS,
    `${SUBJECT}\n  ${S.meta.bytes} 字节  sha256=${S.meta.sha256.slice(0, 16)}…`);

  const base = BASELINE ? load(BASELINE) : { mod: null, meta: meta(BASELINE || '') };
  const baselineUsable = !!(base.mod && base.mod._internals && base.mod._internals.WRITE_HINTS
    && base.meta.sha256 !== S.meta.sha256);
  const BI = baselineUsable ? base.mod._internals : null;

  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) { /* 不存在就算了 */ }
  fs.mkdirSync(TMP_ROOT, { recursive: true });

  /* ── C 组 ──────────────────────────────────────────────────────────── */
  read('C 组 · WRITE_HINTS（shell 写动作启发式）逐条读数：');
  const probe = (re, t) => { try { return re.test(t.cmd) } catch (e) { return 'ERR:' + String((e && e.message) || e) } };
  const posGot = C_POS.map((t) => ({ ...t, got: probe(I.WRITE_HINTS, t) }));
  check(`${id}-C1`, `正控：${C_POS.length} 条**真写动作**全部仍判"改盘"`,
    posGot.every((x) => x.got === true),
    posGot.map((x) => `  ${x.got === true ? '[命中]' : '[★没命中]'} ${x.cmd}   （${x.why}）`).join('\n'));

  const negGot = C_NEG.map((t) => ({ ...t, got: probe(I.WRITE_HINTS, t) }));
  check(`${id}-C2`, `负控：${C_NEG.length} 条**丢弃 stderr**（\`2>$null\` / \`2>NUL\` 各种写法）全部判**不是**改盘`,
    negGot.every((x) => x.got === false),
    negGot.map((x) => `  ${x.got === false ? '[不命中✓]' : '[★命中=误报]'} ${x.cmd}   （${x.why}）`).join('\n'));

  const bndGot = C_BOUNDARY.map((t) => ({ ...t, got: probe(I.WRITE_HINTS, t) }));
  check(`${id}-C3`, `边界：${C_BOUNDARY.length} 条**长得像丢弃目标但不是**的仍然判"改盘"（不许收得太宽）`,
    bndGot.every((x) => x.got === true),
    bndGot.map((x) => `  ${x.got === true ? '[命中]' : '[★没命中]'} ${x.cmd}   （${x.why}）`).join('\n'));

  const stabGot = C_STABLE.map((t) => ({ ...t, got: probe(I.WRITE_HINTS, t) }));
  read(`  C-1 正控（必须命中）        : ${posGot.filter((x) => x.got === true).length}/${posGot.length}`);
  read(`  C-2 负控（丢弃目标必须不命中）: ${negGot.filter((x) => x.got === false).length}/${negGot.length}`);
  read(`  C-3 边界（长得像但不是）     : ${bndGot.filter((x) => x.got === true).length}/${bndGot.length}`);
  read(`  C-4 稳定（本来就不命中）     : ${stabGot.filter((x) => x.got === false).length}/${stabGot.length}`);
  check(`${id}-C4`, `稳定：${C_STABLE.length} 条**本来就只读**的命令仍然**不**判改盘（\`2>&1\` / \`Get-Content\` / \`git status\` …）`,
    stabGot.every((x) => x.got === false),
    stabGot.map((x) => `  ${x.got === false ? '[不命中]' : '[★命中]'} ${x.cmd}   （${x.why}）`).join('\n'));

  if (!baselineUsable) {
    skip(`${id}-C5`, 'A/B 对照：改动前那份插件上 C-2 **全部命中**（证明 C-2 不是恒真的空判据）',
      BASELINE
        ? `基线 ${BASELINE} 与被测件 sha256 **相同**（都是 ${S.meta.sha256.slice(0, 16)}…）或读不出来 ⇒ 没有"改动前"可比，如实跳过（不是通过）。`
        : '没给 `HANDOVER_GATE_BASELINE_JS` ⇒ 没有"改动前"可比，如实跳过（不是通过）。');
  } else {
    const bNeg = C_NEG.map((t) => ({ ...t, got: probe(BI.WRITE_HINTS, t) }));
    const bPos = C_POS.map((t) => ({ ...t, got: probe(BI.WRITE_HINTS, t) }));
    const bBnd = C_BOUNDARY.map((t) => ({ ...t, got: probe(BI.WRITE_HINTS, t) }));
    read(`  C-5 A/B 对照（基线 = 改动前那份，sha256=${base.meta.sha256.slice(0, 16)}…）：`);
    read(`       基线上 C-2 命中 ${bNeg.filter((x) => x.got === true).length}/${bNeg.length} 条  ← 那就是本单修掉的误报`);
    read(`       基线上 C-1 命中 ${bPos.filter((x) => x.got === true).length}/${bPos.length} · C-3 命中 ${bBnd.filter((x) => x.got === true).length}/${bBnd.length}  ← 真写动作一条没伤`);
    check(`${id}-C5`, 'A/B 对照：**改动前**那份插件上 C-2 全部命中（= 那就是本单修掉的误报）+ C-1/C-3 在两边**逐条相同**',
      bNeg.every((x) => x.got === true)
      && bPos.every((x, k) => x.got === posGot[k].got)
      && bBnd.every((x, k) => x.got === bndGot[k].got),
      `基线：${BASELINE}\n  sha256=${base.meta.sha256.slice(0, 16)}…  ${base.meta.bytes} 字节\n` +
      `  C-2 在基线上命中 ${bNeg.filter((x) => x.got === true).length}/${bNeg.length} 条：\n` +
      bNeg.map((x) => `    ${x.got ? '[命中=旧稿的误报]' : '[不命中]'} ${x.cmd}`).join('\n') +
      `\n  C-1 正控：基线命中 ${bPos.filter((x) => x.got === true).length}/${bPos.length}，被测命中 ${posGot.filter((x) => x.got === true).length}/${posGot.length}` +
      `\n  C-3 边界：基线命中 ${bBnd.filter((x) => x.got === true).length}/${bBnd.length}，被测命中 ${bndGot.filter((x) => x.got === true).length}/${bndGot.length}`);

    /* ── A / B 组的 A/B 对照（用同一份基线插件） ─────────────────────── */
    const BM = base.mod;
    const aBase = scenarioA(BM, 'f-a-baseline');
    const bBase = scenarioB(BM, 'f-b-baseline');
    check(`${id}-A3`, 'A/B 对照：**改动前**那份插件上，同一场景账本里 `handover-write-seen` **零行**（证明 A-1 不是恒真）',
      aBase.seen.length === 0,
      `基线场景落盘行：\n${aBase.lines.length ? aBase.lines.join('\n') : '    （账本里一行都没有 ← 这就是缺陷 A）'}`);
    check(`${id}-B3`, 'A/B 对照：**改动前**那份插件上，同一 sid / 同一回合 / 两个工程根 ⇒ `turn-dirty` **只落一行**（证明 B-1 不是恒真）',
      bBase.twoRoots.length === 1,
      `基线 turn-dirty 行数 = ${bBase.twoRoots.length}（只数 sid=${bBase.sid} 那些行）\n` +
      bBase.twoRoots.map((r) => `    rootKey=${r.rootKey}  root=${r.root}  paths=${JSON.stringify(r.paths)}`).join('\n') +
      `\n  ⇒ 另一个工程根那一行**被去重键吃掉了**（键里没有 rootKey ⇒ 两根共用一个键）`);
  }

  /* ── A 组（正片） ──────────────────────────────────────────────────── */
  const A = scenarioA(M, 'a-real');
  read(`A 组 · 欠账被兄弟会话消耗掉（rootKey=${A.rootKey}）：`);
  read(`  账本里 handover-write-seen ${A.seen.length} 行 / write-gate-cleared ${A.cleared.length} 行`);
  read(`  最后一行：sid=${A.seen.length ? A.seen[A.seen.length - 1].sid : '-'}  pendingHit=${A.seen.length ? A.seen[A.seen.length - 1].pendingHit : '-'}`);
  check(`${id}-A1`, '欠账被**兄弟会话**消耗掉之后再写交接 ⇒ 账本里**必须出现** `handover-write-seen`，且它 `pendingHit === false`',
    A.seen.length >= 1 && A.seen[A.seen.length - 1].pendingHit === false,
    `场景：sid1 改文件（建立欠账）→ **sid2**（同工程根 ⇒ 同一个 rootKey）抢先写交接把欠账清掉 → sid1 自己再写一次交接\n` +
    `  root        = ${A.root}\n  rootKey     = ${A.rootKey}\n  账本相关行：\n${A.lines.join('\n')}\n` +
    `  sid1 的 handover-write-seen 共 ${A.seen.length} 行，最后一行 pendingHit=${A.seen.length ? A.seen[A.seen.length - 1].pendingHit : '(无)'}`);
  check(`${id}-A2`, '对照组：兄弟会话那次（**解锁成功**）也有一行 `handover-write-seen`，`pendingHit === true`，且旁边有 `write-gate-cleared`',
    A.siblingSeen.length >= 1 && A.siblingSeen[0].pendingHit === true && A.cleared.length >= 1,
    `  sid2 的 handover-write-seen：${A.siblingSeen.length} 行，pendingHit=${A.siblingSeen.length ? A.siblingSeen[0].pendingHit : '(无)'}\n` +
    `  write-gate-cleared：${A.cleared.length} 行`);

  /* ── B 组（正片） ──────────────────────────────────────────────────── */
  const B = scenarioB(M, 'b-real');
  read(`B 组 · 同 sid / 同回合 / 两个工程根（sid=${B.sid} turn=${B.turn}）：`);
  read(`  turn-dirty 落盘 ${B.twoRoots.length} 行（两个不同 rootKey ⇒ ${new Set(B.twoRoots.map((r) => r.rootKey)).size} 个）`);
  read(`  取舍：同 sid 同回合**同一个根**的 3 个文件 ⇒ ${B.sameRoot.length} 行（没有被"加 rootKey"带成 3 行）`);
  const rk = new Set(B.twoRoots.map((r) => r.rootKey));
  check(`${id}-B1`, '同一 sid、同一回合、**两个不同工程根** ⇒ 账本里**必须落两行** `turn-dirty`（两个 rootKey 不同、路径各自取到）',
    B.twoRoots.length === 2 && rk.size === 2
    && B.twoRoots.some((r) => JSON.stringify(r.paths || []).includes('a.js'))
    && B.twoRoots.some((r) => JSON.stringify(r.paths || []).includes('b.js')),
    `sid=${B.sid} turn=${B.turn}（只数这个 sid 的行）\n  turn-dirty 落盘 ${B.twoRoots.length} 行：\n` +
    B.twoRoots.map((r, i) => `    #${i + 1} rootKey=${r.rootKey}\n        root=${r.root}\n        paths=${JSON.stringify(r.paths)}`).join('\n') +
    `\n  ⚠ 取舍：同 sid 同回合**同一个根**的多个文件仍然只落一行 ⇒ 见 ${id}-B2`);
  check(`${id}-B2`, '取舍读数：同一 sid、同一回合、**同一个根**的 3 个脏文件 ⇒ 仍然只落**一行** `turn-dirty`（加 rootKey 不是白赚）',
    B.sameRoot.length === 1 && (B.sameRoot[0] ? B.sameRoot[0].paths || [] : []).length === 3,
    `  turn-dirty 落盘 ${B.sameRoot.length} 行` + (B.sameRoot[0] ? `，paths=${JSON.stringify(B.sameRoot[0].paths)}` : '') +
    `\n  ⇒ \`finalizeUpTo\` 对每个 (sid, turn, rootKey) 只发一行；分开的只有**不同工程根**`);

  if (!baselineUsable) {
    skip(`${id}-B4`, '【如实记账·残余洞】去重键里没有 `turn` ⇒ 同 sid 同根**相邻两回合**仍被吃掉',
      '没给可用的 `HANDOVER_GATE_BASELINE_JS`（B4 只在**基线**上量"旧稿也没修"这件事）⇒ 如实跳过。');
  } else {
    const bB4 = scenarioB4(base.mod, 'b4-baseline');
    check(`${id}-B4`, '【如实记账·残余洞】去重键里**没有 `turn`** ⇒ 改动前/改动后**都**只落一行（同 sid 同根相邻两回合仍被吃掉；本单没修这一条）',
      bB4.dirty.length === 1,
      `基线（改动前）落盘 ${bB4.dirty.length} 行 —— 即"有 turn 也照样被吃掉"这件事不是本单引入的；` +
      `要收窄它（键里加 ` + 'turn`' + `）是**另一单**，本单不碰。`);
  }

  /* ── D 组：既有判据没被放宽 ────────────────────────────────────────── */
  {
    const P = mkProject('d-real');
    const L = path.join(TMP_ROOT, 'd-real', '_log', 'gate.jsonl');
    fs.mkdirSync(path.dirname(L), { recursive: true });
    const b = boot(M, L);
    const sid = 'L47-deny-sid';
    const ag = fakeAgent(sid, P, 1);
    const ag2 = fakeAgent('L47-deny-sid-2', P, 1);
    fireResult(b.h, readExec(path.join(P, '交接.md'), ag), OK_RESULT);
    fireResult(b.h, writeExec(path.join(P, 'src', 'a.js'), ag), OK_RESULT);
    fireTurnStopping(b.h, { turn: 1, agent: ag });          // ⇒ 欠账建立
    const wf = makeWaterfall(b.h.listeners.get('tools/pre-execute'));
    const dSet = await wf(shellExec('Set-Content -Path "D:/x/y.txt" -Value hi', ag2));
    const dRedir = await wf(shellExec('node x.js 2> err.txt', ag2));
    const dDiscard = await wf(shellExec('node x.js 2>$null', ag2));
    check(`${id}-D1`, '写闸**仍然**拦得住 shell 写动作（`Set-Content` 与 `2> err.txt` 都 deny）—— 钉住"不许为了让自检变绿而放宽既有判据"',
      dSet.kind === 'deny' && dRedir.kind === 'deny',
      `  Set-Content ⇒ ${dSet.kind}\n  2> err.txt  ⇒ ${dRedir.kind}\n` +
      `  （对照）2>$null ⇒ ${dDiscard.kind} —— 有欠账时**整类 shell** 都 deny，与改盘无关`);
  }

  return finish();

  /* ══════════════════════════════════════════════════════════════════════
   * 场景函数
   * ══════════════════════════════════════════════════════════════════════ */

  /** A 组场景：欠账被兄弟会话消耗掉 + 自己再写交接 */
  function scenarioA(m, tag) {
    const P = mkProject(tag);
    const L = path.join(P, '_log', 'gate.jsonl');
    fs.mkdirSync(path.dirname(L), { recursive: true });
    const b = boot(m, L, P);
    const handover = path.join(P, '交接.md');
    const sid1 = 'L47-' + tag + '-sid1';
    const sid2 = 'L47-' + tag + '-sid2';
    const ag1 = fakeAgent(sid1, P, 1);
    const ag2 = fakeAgent(sid2, P, 1);

    // ① sid1 改文件（建立欠账）
    fireResult(b.h, writeExec(path.join(P, 'src', 'a.js'), ag1), OK_RESULT);
    fireTurnStopping(b.h, { turn: 1, agent: ag1 });
    const pendingAfter1 = Array.from(b.state.pending.keys());

    // ② **兄弟会话**（同工程根 ⇒ 同一个 rootKey）抢先写交接，把那笔欠账消耗掉
    fireResult(b.h, writeExec(handover, ag2), OK_RESULT);

    // ③ sid1 自己再写一次交接 ⇒ `state.pending.delete(rootKey)` 返回 **false**
    fireResult(b.h, writeExec(handover, ag1), OK_RESULT)

    const rows = readLog(L);
    const seen = rowsOf(rows, 'handover-write-seen');
    const siblingSeen = seen.filter((r) => r.sid === sid2);
    return {
      root: P,
      rootKey: pendingAfter1[0] || '(没建出欠账)',
      pendingAfter1,
      seen, siblingSeen,
      cleared: rowsOf(rows, 'write-gate-cleared'),
      lines: rows.filter((r) => ['handover-write-seen', 'write-gate-cleared', 'turn-dirty', 'deny'].includes(r.ev))
        .map((r) => `    ${r.ev.padEnd(22)} sid=${(r.sid || '').slice(-12)} pendingHit=${r.pendingHit} rootKey=${(r.rootKey || '-')} ${r.handover || r.path || r.target || ''}`),
    };
  }

  /** B 组场景：同一 sid / 同一回合 / 两个工程根 + 同根多文件对照 */
  function scenarioB(m, tag) {
    const P1 = mkProject(tag + '-1');
    const P2 = mkProject(tag + '-2');
    const L = path.join(TMP_ROOT, tag, '_log', 'gate.jsonl');
    fs.mkdirSync(path.dirname(L), { recursive: true });
    const b = boot(m, L, P1);
    const sid = 'L47-' + tag + '-sid';
    const TURN = 7;
    const ag = fakeAgent(sid, P1, TURN);

    // 两个**不同**工程根、**同一个** sid、**同一个**回合
    fireResult(b.h, writeExec(path.join(P1, 'src', 'a.js'), ag), OK_RESULT);
    fireResult(b.h, writeExec(path.join(P2, 'src', 'b.js'), ag), OK_RESULT);
    const rows1 = m._internals.finalizeUpTo(b.state, sid, TURN, null);
    m._internals.publishTurnRows(b.state, rows1, false, 'lab-L47-two-roots', null);

    // 对照：同 sid 同回合**同一个根**的 3 个文件
    const sid2 = 'L47-' + tag + '-sid-sameroot';
    const ag2 = fakeAgent(sid2, P1, TURN);
    for (const f of ['a.js', 'b.js', 'c.js']) fireResult(b.h, writeExec(path.join(P1, 'src', f), ag2), OK_RESULT);
    const rows2 = m._internals.finalizeUpTo(b.state, sid2, TURN, null);
    m._internals.publishTurnRows(b.state, rows2, false, 'lab-L47-same-root', null);

    const dirty = rowsOf(readLog(L), 'turn-dirty');
    /* ⚠ **必须按 sid 拆开**：两个场景共用同一个账本文件，
       不同 sid 的行本来就不会被去重键吃掉（键里有 sid）⇒ 混在一起数会把"对照组"算进"正片"。 */
    return {
      sid, turn: TURN, P1, P2,
      twoRoots: dirty.filter((r) => r.sid === sid),
      sameRoot: dirty.filter((r) => r.sid === sid2),
      all: dirty,
    };
  }

  /** B4 场景：同 sid / 同一个根 / **相邻两个回合**在 3 秒内收尾 */
  function scenarioB4(m, tag) {
    const P = mkProject(tag);
    const L = path.join(P, '_log', 'gate.jsonl');
    fs.mkdirSync(path.dirname(L), { recursive: true });
    const b = boot(m, L, P);
    const sid = 'L47-' + tag + '-sid';
    const agT1 = fakeAgent(sid, P, 1);
    const agT2 = fakeAgent(sid, P, 2);
    fireResult(b.h, writeExec(path.join(P, 'src', 'a.js'), agT1), OK_RESULT);
    m._internals.publishTurnRows(b.state, m._internals.finalizeUpTo(b.state, sid, 1, null), false, 'lab-L47-turn1', null);
    fireResult(b.h, writeExec(path.join(P, 'src', 'b.js'), agT2), OK_RESULT);
    m._internals.publishTurnRows(b.state, m._internals.finalizeUpTo(b.state, sid, 2, null), false, 'lab-L47-turn2', null);
    return { dirty: rowsOf(readLog(L), 'turn-dirty') };
  }

  function finish() {
    const line = '='.repeat(96);
    console.log(line);
    console.log('L47 · 交接写闸的证据不许被吃掉（WRITE_HINTS 的丢弃目标 / handover-write-seen / 去重键 rootKey）');
    console.log(line);
    console.log(`被测件 : ${SUBJECT}`);
    console.log(`         ${S.meta.bytes} 字节  sha256=${S.meta.sha256}  mtime=${S.meta.mtime}`);
    console.log(`基线件 : ${BASELINE || '(未指定 ⇒ A/B 对照组如实 SKIP)'}`);
    if (baselineUsable) console.log(`         ${base.meta.bytes} 字节  sha256=${base.meta.sha256}  mtime=${base.meta.mtime}`);
    console.log(`夹具根 : ${TMP_ROOT}（%TEMP%，真工程一个字节都没写；本用例**不 spawn 子进程**）`);
    console.log(line);
    for (const s of readings) console.log(s);
    console.log(line);
    const bad = checks.filter((x) => !x.ok);
    for (const x of bad) console.log(`[红] ${x.name}\n     ${x.detail}`);
    for (const s of skipped) console.log(`[SKIP] ${s.name}\n      ${s.why}`);
    console.log(line);
    console.log(`L47：${checks.length} 条判据，${checks.length - bad.length} 过 / ${bad.length} 红 / ${skipped.length} 如实跳过`);
    console.log(line);

    const ok = bad.length === 0;
    return {
      id, name,
      status: ok ? 'PASS' : 'FAIL',
      pass: ok,
      reason: ok
        ? `丢弃目标（\`2>$null\` / \`2>NUL\` 共 ${C_NEG.length} 条）全部不再被判改盘，而 ${C_POS.length} 条真写动作 + ${C_BOUNDARY.length} 条边界一条没伤；` +
          `欠账被兄弟会话消耗后仍落 \`handover-write-seen\`（\`pendingHit=false\`）；同 sid 同回合两个工程根落两行 \`turn-dirty\`。`
        : `共 ${bad.length} 条红：${bad.map((x) => x.name.slice(0, 60)).join(' / ')}`,
      checks,
      skipped,
    };
  }
}

/* 允许 `node L47_....mjs` 直接跑（套件之外的单独跑法） */
if (process.argv[1] && process.argv[1].endsWith('L47_handover_ledger_evidence.mjs')) {
  const r = await run();
  process.exit(r.pass ? 0 : 1);
}

export default run;