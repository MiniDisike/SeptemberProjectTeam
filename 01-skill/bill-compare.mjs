#!/usr/bin/env node
/**
 * bill-compare.mjs —— 「用了监督员」vs「平时」的账单对比。
 *
 * 为什么要有它：用户问用了插件后消耗的 token 跟平时比是多少。
 * AI 自己报成本 = 又一次自我申报，会糊弄；所以这里只读 **harness 自己记的 usage**。
 *
 * 口径（数字要能比较，口径必须先钉住）：
 *   · 数据源：会话日志里 `assistant/message` 事件带的 usage（input/output/cacheRead/reasoning）。
 *   · 分组不用时间猜，用**账本证据**：`.warden/ROUNDS.jsonl` 的 `session` 字段 = 真用过监督员的会话。
 *     其余按"今天 / 今天之前"再分两份，作为平时的参照。
 *   · 归一化：会话长短差太多，只比总量没意义 —— 主指标用 **每模型步 token**（一个 assistant 消息=一步）。
 *   · 分开看 input（全额价）/ cacheRead（缓存价）/ output（最贵），并给缓存占比。
 *   · 插件自身：按 `source.plugin` 分组数消息条数与字符数（`plugin` 是插件名，
 *     AGENTS.md 那种 agent-instructions 注入也会以 plugin 来源出现，必须分开看，否则会算到插件头上）。
 *
 * 用法：node bill-compare.mjs [--json] [--warden-dir <WORKSPACE>\.warden]
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodeSession, listSessions } from './bill.mjs';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(`--${n}`);
const WDIR = String(opt('warden-dir') ?? path.join(process.cwd(), '.warden'));

// —— 谁用过监督员：账本自己记着（比按时间猜可靠）
const wardenSessions = new Set();
try {
  for (const line of fs.readFileSync(path.join(WDIR, 'ROUNDS.jsonl'), 'utf8').split(/\r?\n/)) {
    const s = line.trim(); if (!s || s.startsWith('#')) continue;
    try { const r = JSON.parse(s); if (r.session) wardenSessions.add(String(r.session)); } catch { /* 坏行跳过 */ }
  }
} catch { /* 没有账本就当没人用过 */ }

const TODAY_START = Date.parse('2026-09-16T00:00:00+08:00');

const rows = [];
for (const s of listSessions({ all: true })) {
  let dec;
  try { dec = decodeSession(s.file); } catch { continue; }
  let firstMs = null; let lastMs = null; let steps = 0; let toolCalls = 0;
  const turns = new Set();
  const acc = { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 };
  const byPlugin = new Map();
  for (const e of dec.events) {
    const t = typeof e?.time === 'number' ? e.time : Date.parse(String(e?.time ?? ''));
    if (Number.isFinite(t)) { if (firstMs === null || t < firstMs) firstMs = t; if (lastMs === null || t > lastMs) lastMs = t; }
    const d = e?.data ?? {};
    if (e?.type === 'tool/call') toolCalls += 1;
    if (e?.type === 'assistant/message' && typeof d.turn === 'number') turns.add(d.turn);
    const msg = d.message;
    if (msg && msg.source?.kind === 'plugin') {
      const name = String(msg.source.plugin ?? '（没写名字）');
      const c = byPlugin.get(name) ?? { n: 0, chars: 0 };
      c.n += 1; c.chars += JSON.stringify(msg.content ?? '').length;
      byPlugin.set(name, c);
    }
    const use = d.usage;
    if (use && e?.type === 'assistant/message') {
      steps += 1;
      acc.input += use.inputTokens ?? 0;
      acc.output += use.outputTokens ?? 0;
      acc.cacheRead += use.cacheReadTokens ?? 0;
      acc.reasoning += use.reasoningTokens ?? 0;
      acc.total += use.totalTokens ?? ((use.inputTokens ?? 0) + (use.outputTokens ?? 0) + (use.cacheReadTokens ?? 0));
    }
  }
  if (!acc.total) continue;
  const isWarden = wardenSessions.has(s.sessionId);
  const isToday = firstMs !== null && firstMs >= TODAY_START;
  rows.push({
    sessionId: s.sessionId, ws: s.workspaceDir, firstMs, lastMs,
    group: isWarden ? 'warden' : (isToday ? 'todayOther' : 'before'),
    turns: turns.size, steps, toolCalls, ...acc, byPlugin: Object.fromEntries(byPlugin),
  });
}

const bucket = (list) => {
  const sum = (k) => list.reduce((a, b) => a + (b[k] ?? 0), 0);
  const steps = sum('steps'); const tcs = sum('toolCalls');
  const plugins = new Map();
  for (const r of list) {
    for (const [k, v] of Object.entries(r.byPlugin ?? {})) {
      const c = plugins.get(k) ?? { n: 0, chars: 0 };
      c.n += v.n; c.chars += v.chars;
      plugins.set(k, c);
    }
  }
  return {
    sessions: list.length, steps, toolCalls: tcs,
    input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), total: sum('total'),
    stepsPerSession: list.length ? steps / list.length : 0,
    toolsPerStep: steps ? tcs / steps : 0,
    tokPerStep: steps ? sum('total') / steps : 0,
    freshPerStep: steps ? sum('input') / steps : 0,
    outPerStep: steps ? sum('output') / steps : 0,
    cacheShare: sum('total') ? sum('cacheRead') / sum('total') : 0,
    plugins: [...plugins.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.chars - a.chars),
  };
};

const g = {
  warden: bucket(rows.filter((r) => r.group === 'warden')),
  todayOther: bucket(rows.filter((r) => r.group === 'todayOther')),
  before: bucket(rows.filter((r) => r.group === 'before')),
};

if (has('json')) { console.log(JSON.stringify({ wardenSessions: [...wardenSessions], groups: g, rows }, null, 1)); process.exit(0); }

const n = (v, d = 0) => Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const show = (label, b) => {
  if (!b.sessions) { console.log(`\n【${label}】没有会话`); return; }
  console.log(`\n【${label}】会话 ${b.sessions} 个 · 模型步 ${n(b.steps)} · 工具调用 ${n(b.toolCalls)}`);
  console.log(`  总量       ${n(b.total)} token（input ${n(b.input)} / cacheRead ${n(b.cacheRead)} / output ${n(b.output)}）`);
  console.log(`  每步 ★     ${n(b.tokPerStep)} token（input ${n(b.freshPerStep)} / output ${n(b.outPerStep)}）`);
  console.log(`  每会话步数 ${n(b.stepsPerSession, 1)} · 每步工具 ${n(b.toolsPerStep, 2)} · 缓存占比 ${pct(b.cacheShare)}`);
  for (const p of b.plugins.slice(0, 4)) console.log(`  插件注入   ${p.name} → ${n(p.n)} 条 / ${n(p.chars)} 字符`);
};

console.log('='.repeat(76));
console.log(`账单对比 · 分组靠账本证据（ROUNDS.jsonl 的 session 字段）· 共 ${rows.length} 个有 usage 的会话`);
console.log(`用监督员的会话 id：${[...wardenSessions].join(', ') || '（无）'}`);
console.log('='.repeat(76));
show('用了监督员（有记账的会话）', g.warden);
show('今天其他会话', g.todayOther);
show('今天之前（09-13 ~ 09-15）', g.before);

const base = g.before.steps ? g.before : g.todayOther;
if (base.steps && g.warden.steps) {
  console.log(`\n★ 主指标：每步 token —— 用监督员 ${n(g.warden.tokPerStep)} vs 平时 ${n(base.tokPerStep)} = ×${(g.warden.tokPerStep / base.tokPerStep).toFixed(2)}`);
  console.log(`  每步工具调用 ${n(g.warden.toolsPerStep, 2)} vs ${n(base.toolsPerStep, 2)} = ×${base.toolsPerStep ? (g.warden.toolsPerStep / base.toolsPerStep).toFixed(2) : '?'}`);
  console.log(`  每会话步数   ${n(g.warden.stepsPerSession, 1)} vs ${n(base.stepsPerSession, 1)}`);
}
console.log('\n明细（按开始时间，最近 14 个）：');
for (const r of rows.slice(-14)) {
  const d = r.firstMs ? new Date(r.firstMs).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '?';
  const tag = { warden: '监督', todayOther: '今天', before: '平时' }[r.group];
  console.log(`  ${d}  ${tag}  ${r.sessionId.slice(0, 20).padEnd(22)} 步${String(r.steps).padStart(4)} 轮${String(r.turns).padStart(3)} 工具${String(r.toolCalls).padStart(5)} 总${String(r.total).padStart(11)}`);
}
