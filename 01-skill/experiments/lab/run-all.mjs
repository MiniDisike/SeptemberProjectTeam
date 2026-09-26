#!/usr/bin/env node
/**
 * run-all.mjs —— 跑完 task-warden 实验台的全部实验（L1~L10），出汇总表 + 总退出码。
 *
 *   总退出码：**全 PASS 或 SKIP 才 0，有 FAIL 就 1**（不许把失败写成通过）
 *             **`--only` 点名的实验一个都没找到 ⇒ 2**（A6：输入为 0 不许报成功）
 *
 * 用法：
 *   node run-all.mjs                # 全部
 *   node run-all.mjs --only L1,L4   # 只跑指定实验（点名了但**不在册**的会逐条报出来，不静默丢）
 *   node run-all.mjs --verbose      # 把每条检查的明细都打出来
 *
 * ⚠ **2026-09-24 实测病（「审查」在 P-M2b 复验里跑出来的，原样输出）**：
 *   `node run-all.mjs --only L99_不存在` ⇒
 *     `PASS 0 · FAIL 0 · SKIP 0 （共 0 个实验）` + `总退出码 0：0 个 PASS，0 个 SKIP` + **exit 0**
 *   —— 一个**根本不存在**的实验名被当成了"跑完了、没问题"。这就是 A6（没查到东西 ≠ 查了没问题）
 *   在实验台上的复发。⇒ 现在：**一个都没找到 ⇒ exit 2**；
 *   点名 N 个、找到 M 个（M>0）⇒ **照旧跑**，但缺的那些**必须逐条报出来**（不许静默丢掉）。
 *
 * ⚠ **2026-09-24 补（P-M20）**：`MODULES` 末尾**追加** L39/L40/L41/L42 ——
 *   实验台里 `L*.mjs` 共 **42** 个、本表原来只有 **38** 个，那 4 个**建了却跑不到**（"等于没有"）。
 *   **只追加**：上面 38 条**逐条同名同序一个字都没动**（见 MODULES 下面那段）。
 *   空壳用例（文件在册、却**没有 default 导出**）⇒ **如实 `SKIP`**，不占"通过"（见循环里那段）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wardenMeta } from './common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = [
  'L1_gear_vs_cube',
  'L2_half_done',
  'L3_isolation',
  'L4_frozen_baseline',
  'L5_attribution_laundering',
  'L6_false_accusation',
  'L7_compression',
  'L8_incidents',
  'L9_negation_flip',
  'L10_stale_voice',
  'L11_false_pass',
  'L12_conditional_consent',
  'L13_coverage_selfclaim',
  'L14_voice_claims',
  'L15_roster_seat',
  'L16_no_self_address',
  'L17_ancestor_init',
  'L18_fake_evidence',
  'L19_roles_health',
  'L20_role_speech',
  'L21_preset_default_guard',
  'L22_plan_gate',
  'L23_roles_criteria',
  'L24_duty_loop',
  'L25_copy_sync',
  'L26_corpus_text',
  'L27_finding_isomorphism',
  'L28_no_fake_decision',
  'L29_feed_freshness',
  'L30_negation_matcher',
  'L31_evidence_after_mtime',
  'L32_delegation',
  'L33_recon_enforced',
  'L34_mustnot_addressed',
  'L36_steer_mode',
  'L37_patch_pipeline',
  'L38_majority_gate',
  'L35_steer_criterion',
  /**
   * ★★ 2026-09-24 补（P-M20）：下面 4 个**文件早就建了、却不在册** ——
   *   「用例建了，但标准套件跑不到 = **等于没有**」。
   *   实测：`experiments/lab` 下 `L*.mjs` 共 **42** 个，本表原来只有 **38** 个；缺的正是这 4 个。
   *   ⇒ **只追加**，上面已有的 38 条顺序一个字都不动。
   *
   *   ⚠ **登记 ≠ 保证绿**：这 4 个里有 2 个是**空壳**、1 个的**被测补丁还没落地**。
   *     本文件的职责是"**看见**每一个用例"，所以照样在册，再由下面的
   *     「空壳如实 SKIP」与既有的「有 FAIL 就 1」把真实状态打出来 —— **不许假绿**。
   *     · L39_autonomy_switch / L40_visible_speech：**空壳**（132 B / 127 B，只有一行注释、
   *       **没有 default 导出**）。真正写满的 L39 在 **P-M7 的 work 副本**里，P-M7 至今没 apply。
   *       ⇒ 由下面的 shell 分支**如实 SKIP**（pass:false + 逐条写明原因），不是通过。
   *     · L41_pipe_round2：**真用例**（70 KB），守 **P-M6**（patch-pipeline 第三/四轮）。
   *       P-M6 **已 apply**（安装份 `patch-pipeline.mjs` 125875 B）⇒ 现在**能真跑**，预期 PASS。
   *     · L42_window_scope：**真用例**（28 KB），守 **R37 按窗口取数**（P-M5 那条）。
   *       ⚠ **R37 现在不在 warden 里**（当前安装份 403397 B，`resolveWindowScope` / `--all-windows`
   *       命中 **0** 处）—— **P-M19 正在从零重做 R37**。⇒ L42 现在**必然红**，而且**红得对**
   *       （它守的那条修复真的还不在代码里）。这是**已知的跨补丁依赖**，不是本用例写错了。
   */
  'L39_autonomy_switch',
  'L40_visible_speech',
  'L41_pipe_round2',
  'L42_window_scope',
];

const argv = process.argv.slice(2);
/** 一个点名 token 是否在册：认 `L38` 这种 id，也认 `L38_majority_gate` 这种全名（大小写不敏感） */
const moduleIdOf = (n) => n.split('_')[0];
const tokenInList = (tok) => MODULES.some((n) => moduleIdOf(n) === tok || n.toUpperCase() === tok);

/**
 * `--only` 点名的实验名**原样留着**（大写后匹配）—— 一个都不许静默丢掉：
 *   · `notFound` 里每一条都会被打出来（哪怕它只是 N 个名字里缺的那 1 个）；
 *   · **一个都没找到**（或 `--only` 后面压根没给名字）⇒ 总退出码 2（A6）。
 */
const onlyList = (() => {
  const i = argv.indexOf('--only');
  if (i < 0) return null;
  return String(argv[i + 1] ?? '').split(/[,，\s]+/).filter(Boolean).map((s) => s.toUpperCase());
})();
const only = onlyList === null ? null : new Set(onlyList);
const notFound = onlyList === null ? [] : onlyList.filter((tok) => !tokenInList(tok));
const foundCount = onlyList === null ? 0 : onlyList.length - notFound.length;
/** A6 闸的判定（**空输入与全找不到都算"输入为 0"**）；null = 不用拦 */
const a6 = (() => {
  if (onlyList === null) return null;
  if (!onlyList.length) return { msg: '`--only` 后面没有给实验名', names: [] };
  if (!foundCount) return { msg: `你点名的 ${onlyList.length} 个实验**一个都没找到**`, names: notFound };
  return null;
})();
const verbose = argv.includes('--verbose');

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (/[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

const meta = wardenMeta();
console.log('='.repeat(94));
console.log('task-warden 实验台 · run-all（把真实翻车模式变成可机械判定的回归用例）');
console.log(`warden.mjs  ${meta.exists ? `sha256=${meta.sha256}  ${meta.bytes} 字节  mtime=${meta.mtime}` : '★ 不存在！'}`);
console.log(`lab         ${HERE}`);
console.log('='.repeat(94));
console.log('');

// ---------- A6 闸 / 点名缺项提醒（**都在跑之前说清**，不藏在汇总里）
if (a6) {
  console.log(`★ ${a6.msg}：${a6.names.length ? a6.names.join('、') : '（一个名字都没给）'}`);
  console.log(`  在册实验 ${MODULES.length} 个：${MODULES.map(moduleIdOf).join('、')}`);
  console.log('  ⇒ 一个实验都不会跑，**不许报成功** —— 见最后那行「总退出码 2」（A6）。');
  console.log('');
} else if (notFound.length) {
  console.log(`⚠ 你点名了 ${onlyList.length} 个实验，其中 ${notFound.length} 个**不在册、不会跑**：${notFound.join('、')}`);
  console.log(`  （找到的 ${foundCount} 个照旧跑；在册实验 ${MODULES.length} 个：${MODULES.map(moduleIdOf).join('、')}）`);
  console.log('');
}

const results = [];
for (const name of MODULES) {
  const id = name.split('_')[0];
  if (only && !(only.has(id) || only.has(name.toUpperCase()))) continue;
  const t0 = Date.now();
  let r;
  try {
    const mod = await import(pathToFileURL(path.join(HERE, `${name}.mjs`)).href);
    if (typeof mod.default !== 'function') {
      /**
       * ★ 空壳用例：文件**在册**、却**没有 default 导出** ⇒ 它一条断言都没有。
       * 为什么既不是 PASS 也不是 FAIL：
       *   · 判 PASS = 假绿（"文件建了"被读成"跑过了"）—— 正是"等于没有"；
       *   · 判 FAIL 也不对：这不是"断言没通过"，而是"这个用例根本没写"，
       *     把它算成 FAIL 会让套件**长期红着**，真出现回归时反而分不出哪条红是新的。
       * ⇒ **如实 SKIP**：status=SKIP、pass=false、原因逐条打印（含路径与字节数）。
       *   ⚠ SKIP **不占"通过"**、也不许当证据（同 L18「空壳拒收」的口径）。
       */
      const file = path.join(HERE, `${name}.mjs`);
      const size = (() => { try { return fs.statSync(file).size; } catch { return -1; } })();
      r = {
        id, name, status: 'SKIP', pass: false,
        reason: '空壳用例（在册，但没有 default 导出）⇒ 如实 SKIP，不是通过',
        checks: [],
        skipped: [{
          name: `${name}.mjs 是空壳`,
          why: `${file} 共 ${size} 字节、**没有 default 导出** ⇒ 一条断言都没有，如实跳过。`
            + ' 要它真的进套件：把用例写满（L39 写满的那份在 .warden/patches/P-M7/work/ 里）。',
        }],
        shell: true,
      };
    } else {
      r = await mod.default({});
      r = r ?? { id, name, pass: false, reason: '实验没有返回结果', checks: [], skipped: [] };
    }
  } catch (exc) {
    r = {
      id, name, pass: false,
      reason: `实验抛异常：${exc.message}`,
      checks: [{ name: '实验本身跑完', ok: false, detail: String(exc.stack ?? exc.message).slice(0, 500) }],
      skipped: [],
      crash: true,
    };
  }
  const status = r.status ?? (r.pass ? 'PASS' : 'FAIL');
  const ms = Date.now() - t0;
  results.push({ ...r, status, ms });

  const mark = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP' }[status] ?? 'FAIL';
  console.log(`[${r.id}] ${r.name}  → ${mark}   (${(ms / 1000).toFixed(1)}s)`);
  if (verbose || status === 'FAIL') {
    for (const x of r.checks ?? []) {
      console.log(`    ${x.ok ? '✓' : '✗'} ${x.name}`);
      if (!x.ok || verbose) console.log(`        ${x.detail}`);
    }
  } else {
    const bad = (r.checks ?? []).filter((x) => !x.ok);
    for (const x of bad) console.log(`    ✗ ${x.name}\n        ${x.detail}`);
  }
  for (const s of r.skipped ?? []) console.log(`    · [跳过] ${s.name}\n        ${s.why}`);
  console.log('');
}

// ------------------------------------------------------------------ 汇总表
console.log('='.repeat(94));
console.log('汇总表');
console.log('='.repeat(94));
console.log(`${pad('ID', 5)}${pad('状态', 6)}${pad('检查', 8)}${pad('跳过', 6)}${pad('耗时', 8)}理由`);
console.log('-'.repeat(94));
for (const r of results) {
  const okN = (r.checks ?? []).filter((x) => x.ok).length;
  const all = (r.checks ?? []).length;
  console.log(`${pad(r.id, 5)}${pad(r.status, 6)}${pad(`${okN}/${all}`, 8)}${pad((r.skipped ?? []).length, 6)}${pad(`${(r.ms / 1000).toFixed(1)}s`, 8)}${r.reason}`);
}
console.log('-'.repeat(94));
const nPass = results.filter((r) => r.status === 'PASS').length;
const nFail = results.filter((r) => r.status === 'FAIL').length;
const nSkip = results.filter((r) => r.status === 'SKIP').length;
console.log(`PASS ${nPass} · FAIL ${nFail} · SKIP ${nSkip}  （共 ${results.length} 个实验）`);

const noted = results.filter((r) => (r.checks ?? []).some((x) => /^【/.test(x.name)));
if (noted.length) {
  console.log('');
  console.log('实验中发现并如实记账的缺口 / 实测事实：');
  for (const r of noted) {
    for (const x of (r.checks ?? []).filter((y) => /^【/.test(y.name))) {
      console.log(`  · [${r.id}] ${x.name}`);
      console.log(`      ${x.detail}`);
    }
  }
}

console.log('');
if (a6) {
  // A6：输入为 0 不许报成功 —— 这里**必须**是 2（不是 0、也不是 1）
  console.log(`★ 总退出码 2：**输入为 0 不许报成功**（A6 —— ${a6.msg}${a6.names.length ? `：${a6.names.join('、')}` : ''}）`);
} else if (nFail) {
  console.log(`★ 有 ${nFail} 个实验 FAIL —— 总退出码 1（失败就是失败，不许写成通过）`);
} else {
  console.log(`总退出码 0：${nPass} 个 PASS，${nSkip} 个 SKIP（跳过项已逐条写明原因）`);
}
if (!a6 && notFound.length) {
  console.log(`⚠ 点名的实验里有 ${notFound.length} 个不在册（**没跑**）：${notFound.join('、')}`);
}
console.log('='.repeat(94));
process.exitCode = a6 ? 2 : (nFail ? 1 : 0);
