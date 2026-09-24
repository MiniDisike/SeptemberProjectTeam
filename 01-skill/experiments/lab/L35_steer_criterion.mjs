#!/usr/bin/env node
/**
 * L35 · 回合边界的判据必须**按结构化事实**判，不许按中文子串判
 *
 * 来历（事故 I60，「审查」2026-09-23 复核出来的**还活着**的风险）：
 *   第一版 `steerDecision` 用 `/缺 \.warden\/SPEC\.md/` 去认"这个窗口还没有账本"，
 *   而**自动建骨架之后的常态**是：SPEC.md **存在**但零条 `## R#`，
 *   真实文案是 `[需求] SPEC.md 里一条需求都没有`（**不含那句子串**）
 *   ⇒ `no-ledger` 分支**永远不会响**；它当时不闯祸只因 `checkExit === 1 → 不说话` 兜住。
 *   审查原话：「**fail-closed 是运气，不是判据**」。
 *
 * ★ 夹具**全部取自真实产物**（`PLUGIN-LIVE.json` 实读 + 插件源码实读），
 *   不是我假设的形状 —— 这正是「审查」点名的教训：「自检夹具必须喂真实产物」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeCtx } from './common.mjs';

const PLUGIN = '<WORKSPACE>\\task-warden\\plugin\\warden-watch.js';
const IO = '<WORKSPACE>\\task-warden\\plugin\\plugin-io.js';

function finish(c) {
  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '回合边界的判据读结构化事实（reqCount）、负控与默认关都在位。'
      : '有检查未通过（见下）—— 其中"按中文子串判"是**真缺口**，不是用例写错。',
    checks: c.checks,
    skipped: c.skipped,
  };
}

export default async function run() {
  const c = makeCtx('L35', '回合边界判据要按结构化事实判（喂真实产物）');

  // ── 前置：源码必须读得到（读不到不许报成功）───────────────────────────────
  let src = '';
  try { src = fs.readFileSync(PLUGIN, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { /* 下面判 */ }
  c.check('前置 · 能实读 warden-watch.js（为 0 不许报成功）', src.length > 0, src.length + ' 字符');
  if (!src) return finish(c);

  // ── ① 判据必须读结构化事实（reqCount），不读中文文案 ────────────────────────
  const usesReqCount = /reqCount\)\s*===\s*0/.test(src);
  c.check('★ ① "没有账本"的判据读**结构化事实** reqCount', usesReqCount,
    usesReqCount ? '读 reqCount' : '★ 没读 —— 还在按文案判，文案一改判据就死（A1）');

  // ⚠ 判据里不许再有那条会失效的中文子串 —— **但必须只看代码、不看注释**
  //   （第一次跑时这条误报：它匹配到了我新写的注释里**引用**的旧子串。
  //    这是本仓栽过两次的同一类错：分不清「X」与「提到 X」。）
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');  // 行注释
  const usesChineseSubstring = /缺 \\\.warden\\\/SPEC\\\.md/.test(codeOnly);
  c.check('★ ① 判据里**不许**再有那条会失效的中文子串（只看代码，不看注释）', !usesChineseSubstring,
    usesChineseSubstring ? '★ 还在用「缺 .warden/SPEC.md」—— 这正是 A1' : '已移除（注释里的引用不算）');

  // ── ② plugin-io 必须把 reqCount 算进快照 ──────────────────────────────────
  let io = '';
  try { io = fs.readFileSync(IO, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { /* 下面判 */ }
  c.check('② plugin-io 把 reqCount 算进快照',
    /reqCount: reqCount/.test(io) && /reqCount\s*=\s*\(txt\.match/.test(io),
    io ? (/reqCount: reqCount/.test(io) ? '有' : '★ 没有') : '（读不到 plugin-io）');

  // ── ③ 真实快照：reqCount 真的在里面吗 ─────────────────────────────────────
  const livePaths = [
    '<HOME>\\DSH-Workspace\\.warden\\PLUGIN-LIVE.json',
    '<WORKSPACE>\\.warden\\PLUGIN-LIVE.json',
  ];
  const snaps = [];
  for (const p of livePaths) {
    try { snaps.push({ p, o: JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) }); } catch (e) { /* skip */ }
  }
  c.check('前置 · 至少读到一份真实快照（为 0 不许报成功）', snaps.length > 0,
    snaps.map((s) => path.basename(path.dirname(s.p))).join(', ') || '（一份都没有）');
  for (const s of snaps) {
    console.log('    [实读] ' + path.basename(path.dirname(s.p)) + '  reqCount=' + JSON.stringify(s.o.reqCount) + '  specExists=' + JSON.stringify(s.o.specExists) + '  checkExit=' + s.o.checkExit);
  }
  const withFact = snaps.filter((s) => s.o.reqCount !== undefined && s.o.reqCount !== null);
  if (snaps.length > 0 && withFact.length === 0) {
    // 诚实：磁盘上的快照是**旧插件**写的（进程还没重启）⇒ 判不了，不许假装通过、也不许假报失败
    c.skip('③ 真实快照里有 reqCount（判据读得到）',
      '磁盘上 ' + snaps.length + ' 份快照都是**旧插件**写的（没有 reqCount 字段）⇒ **需要重启 DSH 后跑一轮**才能判；现在判不了');
  } else {
    c.check('③ 真实快照里有 reqCount（判据读得到）', snaps.length > 0 && withFact.length === snaps.length,
      withFact.length + '/' + snaps.length + ' 份有');
  }

  // ── ④ 负控：**普通 check 红不许 steer**（I60 里这条被夹具写成了期望 true）────
  const hasRedGuard = /Number\(snap\.checkExit\)\s*===\s*1\)\s*return\s*\{\s*should:\s*false/.test(src);
  c.check('★ ④ 负控 · 普通 check 红必须 return should:false（I60 里这条被写成 true）',
    hasRedGuard, hasRedGuard ? '有守卫' : '★ 没有 —— 就是 I60 那条');

  // ── ⑤ 默认关：判据之前必须先过开关 ────────────────────────────────────────
  const hasMode = /const mode = steerMode\(\)/.test(src) && /if \(mode !== 'on'\) return/.test(src);
  c.check('⑤ 默认关：判据之前先过 steerMode（事故 I60 之后定的）', hasMode,
    hasMode ? '有' : '★ 没有 —— 默认又会打扰用户');

  return finish(c);
}
