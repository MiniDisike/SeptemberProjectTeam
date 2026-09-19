#!/usr/bin/env node
/**
 * run-all.mjs —— 跑完 task-warden 实验台的全部实验（L1~L10），出汇总表 + 总退出码。
 *
 *   总退出码：**全 PASS 或 SKIP 才 0，有 FAIL 就 1**（不许把失败写成通过）
 *
 * 用法：
 *   node run-all.mjs                # 全部
 *   node run-all.mjs --only L1,L4   # 只跑指定实验
 *   node run-all.mjs --verbose      # 把每条检查的明细都打出来
 */
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
];

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf('--only');
  if (i < 0) return null;
  return new Set(String(argv[i + 1] ?? '').split(/[,，\s]+/).filter(Boolean).map((s) => s.toUpperCase()));
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

const results = [];
for (const name of MODULES) {
  const id = name.split('_')[0];
  if (only && !only.has(id)) continue;
  const t0 = Date.now();
  let r;
  try {
    const mod = await import(pathToFileURL(path.join(HERE, `${name}.mjs`)).href);
    r = await mod.default({});
    r = r ?? { id, name, pass: false, reason: '实验没有返回结果', checks: [], skipped: [] };
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
console.log(nFail
  ? `★ 有 ${nFail} 个实验 FAIL —— 总退出码 1（失败就是失败，不许写成通过）`
  : `总退出码 0：${nPass} 个 PASS，${nSkip} 个 SKIP（跳过项已逐条写明原因）`);
console.log('='.repeat(94));
process.exitCode = nFail ? 1 : 0;
