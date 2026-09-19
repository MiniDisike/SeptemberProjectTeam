#!/usr/bin/env node
/**
 * bill.mjs —— 账单：把 DSH 会话日志里**真实的** token / 墙钟时间 / 模型算出来。
 *
 * 为什么要有它：用户要的是"哪个数据花了多少轮、多少时间与 token 做出来，相当于一个账单"。
 * 如果让 AI 自己报成本，那又是一次自我申报 —— 会糊弄。这里的数字来自 **harness 自己的会话日志**
 * （`~/.dsh/sessions/<工作区>/<会话id>/session.v3.jsonl.zstd`），AI 改不了、编不出。
 *
 * DSH 的会话日志是**逐帧追加的多帧 zstd**：Node 的 zstdDecompressSync 只解第一帧，
 * 所以这里按魔数 `28 B5 2F FD` 切帧、逐帧解压（实测 321 帧 / 0 跳过）。
 *
 * 事件形状（实测）：
 *   assistant/message → { type, seq, time, data:{ turn, step, message:{...}, usage:{ inputTokens,
 *                         outputTokens, totalTokens, cacheReadTokens, reasoningTokens } } }
 *   turn/start, turn/end → { time, data:{ turn, reason } }
 *   tool/call → { time, data:{ turn, step, callId, name, arguments } }
 *   且 totalTokens = inputTokens + outputTokens + cacheReadTokens
 *
 * 用法：
 *   node bill.mjs                          # 当前工作区所有会话
 *   node bill.mjs --session <id>           # 指定会话
 *   node bill.mjs --turn 7                 # 只看某一轮
 *   node bill.mjs --json                   # 机器可读
 *   node bill.mjs --pricing pricing.json   # 加一份价格表就出钱（可选）
 *   node bill.mjs --all                    # 所有工作区
 *
 * 退出码：0 = 成功；2 = 用法/环境错（**不是**"有问题"）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// 工作区 → 会话目录名的编码（实测三个样本都对得上）
//   <WORKSPACE>        → --D-user-grok--
//   <HOME>\Documents\game → --F-user-Documents-game--
export function encodeWorkspace(p) {
  const norm = path.resolve(p);
  return '--' + norm.replace(/^([A-Za-z]):[\\/]/, '$1-').replace(/[\\/]/g, '-') + '--';
}

export function sessionsRoot() {
  if (process.env.DSH_SESSIONS_DIR) return process.env.DSH_SESSIONS_DIR;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'sessions');
}

/** 当前会话 id —— DSH 直接把它放在环境变量里（实测 <session-id>-…），不用猜。 */
export function currentSessionId() {
  return process.env.DSH_SESSION_ID || null;
}

/** 解多帧 zstd → 事件数组 */
export function decodeSession(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const events = [];
  let skipped = 0;
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let out;
    try { out = zlib.zstdDecompressSync(buf.subarray(starts[k], end)); }
    catch { skipped += 1; continue; }
    for (const line of out.toString('utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try { events.push(JSON.parse(s)); } catch { /* 半截行，跳过 */ }
    }
  }
  return { events, frames: starts.length, skipped };
}

/** 列会话文件（dirName 可指定编码后的工作区目录名，字符串或数组；绕开 cwd 与工作区不一致） */
export function listSessions({ workspace, all, dirName } = {}) {
  const root = sessionsRoot();
  const out = [];
  if (!fs.existsSync(root)) return out;
  let dirs;
  if (Array.isArray(dirName)) dirs = dirName.map((d) => path.join(root, d));
  else if (dirName) dirs = [path.join(root, dirName)];
  else if (all) dirs = fs.readdirSync(root).map((d) => path.join(root, d));
  else dirs = [path.join(root, encodeWorkspace(workspace || process.cwd()))];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const sid of fs.readdirSync(d)) {
      const sd = path.join(d, sid);
      let entries = [];
      try { entries = fs.readdirSync(sd); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith('.zstd')) continue;
        const full = path.join(sd, f);
        out.push({ file: full, sessionId: sid, workspaceDir: path.basename(d), mtimeMs: fs.statSync(full).mtimeMs });
      }
    }
  }
  // 同一个会话可能同时出现在多个目录参数里，去重
  const seen = new Set();
  return out.filter((s) => (seen.has(s.file) ? false : (seen.add(s.file), true))).sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * 当前会话所在的工作区目录名（编码后）。
 * 为什么需要：**工程根和会话工作区经常不是同一个目录** ——
 * 例如工程在 `C:\...\<别的工程>`（那里有 .git），而会话工作区是父目录 `C:\...\<别的工程>`。
 * 不自动认出来的话，"用户原话逐字核对"会因为找不到日志而误报。
 */
export function workspaceDirOfSession(sessionId) {
  if (!sessionId) return null;
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) {
    try {
      if (fs.statSync(path.join(root, d, sessionId)).isDirectory()) return d;
    } catch { /* 不在这个工作区 */ }
  }
  return null;
}

const empty = () => ({ input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0 });

function addUsage(acc, u) {
  acc.input += u.inputTokens ?? 0;
  acc.output += u.outputTokens ?? 0;
  acc.cacheRead += u.cacheReadTokens ?? 0;
  acc.reasoning += u.reasoningTokens ?? 0;
  acc.total += u.totalTokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0));
}

/** 按轮聚合一个会话 */
export function summarize(events) {
  const turns = new Map();
  const get = (n) => {
    if (!turns.has(n)) {
      turns.set(n, {
        turn: n, startMs: null, endMs: null, steps: new Set(), models: new Set(),
        providers: new Set(), messages: 0, toolCalls: [], usage: empty(), endReason: null,
      });
    }
    return turns.get(n);
  };
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === 'turn/start' && typeof d.turn === 'number') {
      const t = get(d.turn); t.startMs = t.startMs ?? e.time;
    } else if (e.type === 'turn/end' && typeof d.turn === 'number') {
      const t = get(d.turn); t.endMs = e.time; t.endReason = d.reason?.kind ?? null;
    } else if (e.type === 'assistant/message' && typeof d.turn === 'number') {
      const t = get(d.turn);
      t.messages += 1;
      if (typeof d.step === 'number') t.steps.add(d.step);
      if (d.usage) addUsage(t.usage, d.usage);
      const src = d.message?.source;
      if (src?.model) t.models.add(`${src.provider ?? '?'}/${src.model}`);
    } else if (e.type === 'tool/call' && typeof d.turn === 'number') {
      const t = get(d.turn);
      if (typeof d.step === 'number') t.steps.add(d.step);
      let args = {};
      try { args = JSON.parse(d.arguments ?? '{}'); } catch { /* 非 JSON 参数 */ }
      t.toolCalls.push({ name: d.name, step: d.step, file: args.file_path ?? args.path ?? null, cmd: (args.command ?? args.description ?? '').slice(0, 120) });
    }
  }
  const list = [...turns.values()].sort((a, b) => a.turn - b.turn).map((t) => ({
    ...t,
    steps: t.steps.size,
    models: [...t.models],
    providers: [...t.providers],
    wallMs: t.startMs != null && t.endMs != null ? t.endMs - t.startMs : null,
    toolCallCount: t.toolCalls.length,
  }));
  const total = empty();
  for (const t of list) {
    total.input += t.usage.input; total.output += t.usage.output;
    total.cacheRead += t.usage.cacheRead; total.reasoning += t.usage.reasoning;
    total.total += t.usage.total;
  }
  const files = new Set();
  for (const t of list) for (const c of t.toolCalls) if (c.file) files.add(c.file);
  return {
    turns: list,
    total,
    filesTouched: [...files],
    firstMs: list.find((t) => t.startMs != null)?.startMs ?? null,
    lastMs: [...list].reverse().find((t) => t.endMs != null)?.endMs ?? null,
  };
}

export function fmtInt(n) { return n.toLocaleString('en-US'); }

export function fmtDur(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export const DEFAULT_PRICING = {
  // 每 100 万 token 的美元价。**这是估算**，你的实际价目请用 --pricing 覆盖。
  currency: 'USD',
  inputPerM: 0.28,     // 缓存未命中输入
  cacheReadPerM: 0.028, // 缓存命中输入（通常约 1/10）
  outputPerM: 0.42,
};

export function costOf(usage, p = DEFAULT_PRICING) {
  return (usage.input / 1e6) * p.inputPerM + (usage.cacheRead / 1e6) * p.cacheReadPerM + (usage.output / 1e6) * p.outputPerM;
}

// ------------------------------------------------------------------ CLI
function main(argv) {
  const opt = { json: false, all: false, session: null, turn: null, workspace: process.cwd(), pricing: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opt.json = true;
    else if (a === '--all') opt.all = true;
    else if (a === '--quiet') opt.quiet = true;
    else if (a === '--session') opt.session = argv[++i];
    else if (a === '--turn') opt.turn = Number(argv[++i]);
    else if (a === '--workspace') opt.workspace = argv[++i];
    else if (a === '--pricing') opt.pricing = argv[++i];
    else if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
  }
  let pricing = DEFAULT_PRICING;
  let pricingGiven = false;
  if (opt.pricing) {
    try { pricing = { ...DEFAULT_PRICING, ...JSON.parse(fs.readFileSync(opt.pricing, 'utf8')) }; pricingGiven = true; }
    catch (exc) { console.log(`[用法] 读不了价格表 ${opt.pricing}：${exc.message}`); return 2; }
  }

  let sessions = listSessions({ workspace: opt.workspace, all: opt.all });
  if (opt.session) sessions = sessions.filter((s) => s.sessionId.startsWith(opt.session));
  if (!sessions.length) {
    console.log(`[空] 没找到会话日志。\n  找的位置：${sessionsRoot()}\n  工作区目录名：${encodeWorkspace(opt.workspace)}\n  换工作区用 --workspace <路径>，或 --all 看全部。`);
    return 0;
  }

  const reports = [];
  for (const s of sessions) {
    const { events, frames, skipped } = decodeSession(s.file);
    const sum = summarize(events);
    reports.push({ ...s, frames, skipped, ...sum });
  }

  if (opt.json) {
    console.log(JSON.stringify({ pricing, sessions: reports }, null, 2));
    return 0;
  }

  const grand = empty();
  for (const r of reports) {
    grand.input += r.total.input; grand.output += r.total.output;
    grand.cacheRead += r.total.cacheRead; grand.reasoning += r.total.reasoning;
    grand.total += r.total.total;
  }

  if (opt.session) {
    const r = reports[reports.length - 1];
    console.log(`会话 ${r.sessionId}  (${r.frames} 帧, 跳过 ${r.skipped})`);
    console.log(`工作区 ${r.workspaceDir}`);
    console.log('');
    console.log('轮次  墙钟     步  工具  输入       输出      缓存读        合计         模型');
    console.log('----  -------  --  ----  ---------  --------  ------------  ------------  ----');
    for (const t of r.turns) {
      if (opt.turn != null && t.turn !== opt.turn) continue;
      console.log(
        String(t.turn).padStart(4) + '  ' +
        fmtDur(t.wallMs).padEnd(7) + '  ' +
        String(t.steps).padStart(2) + '  ' +
        String(t.toolCallCount).padStart(4) + '  ' +
        fmtInt(t.usage.input).padStart(9) + '  ' +
        fmtInt(t.usage.output).padStart(8) + '  ' +
        fmtInt(t.usage.cacheRead).padStart(12) + '  ' +
        fmtInt(t.usage.total).padStart(12) + '  ' +
        (t.models.join(',') || '—'),
      );
    }
    console.log('');
    console.log(`合计  轮次 ${r.turns.length}  墙钟 ${fmtDur(r.lastMs != null && r.firstMs != null ? r.lastMs - r.firstMs : null)}`);
    console.log(`      输入 ${fmtInt(r.total.input)}  输出 ${fmtInt(r.total.output)}  缓存读 ${fmtInt(r.total.cacheRead)}  合计 ${fmtInt(r.total.total)}`);
    console.log(`      推理 ${fmtInt(r.total.reasoning)}  token`);
    if (r.filesTouched.length) console.log(`      碰过的文件 ${r.filesTouched.length} 个`);
  } else {
    console.log(`会话数 ${reports.length}  （工作区目录 ${reports[0].workspaceDir}）`);
    console.log('');
    console.log('会话           轮  墙钟      输入        输出       缓存读          合计           模型');
    console.log('-------------  --  --------  ----------  ---------  -------------  -------------  ----');
    for (const r of reports) {
      const models = [...new Set(r.turns.flatMap((t) => t.models))].join(',');
      console.log(
        r.sessionId.slice(0, 13).padEnd(13) + '  ' +
        String(r.turns.length).padStart(2) + '  ' +
        fmtDur(r.lastMs != null && r.firstMs != null ? r.lastMs - r.firstMs : null).padEnd(8) + '  ' +
        fmtInt(r.total.input).padStart(10) + '  ' +
        fmtInt(r.total.output).padStart(9) + '  ' +
        fmtInt(r.total.cacheRead).padStart(13) + '  ' +
        fmtInt(r.total.total).padStart(13) + '  ' +
        models.slice(0, 40),
      );
    }
  }
  console.log('');
  const cost = costOf(grand, pricing);
  console.log(`总计（${opt.session ? '本会话' : reports.length + ' 个会话'}）：input ${fmtInt(grand.input)} + output ${fmtInt(grand.output)} + cacheRead ${fmtInt(grand.cacheRead)} = ${fmtInt(grand.total)} token`);
  console.log(`费用估算 ${pricing.currency} ${cost.toFixed(2)}（价格表：${pricingGiven ? '来自 ' + opt.pricing : '内置默认，**估算**，用 --pricing 覆盖'}）`);
  console.log('提示：cacheRead 通常是大头，也是最容易被忽略的那部分花销。');
  return 0;
}

const HELP = `bill.mjs —— 从 DSH 会话日志算真实 token / 墙钟 / 模型账单

用法：
  node bill.mjs [--workspace <路径>] [--all] [--session <id前缀>] [--turn <n>]
                [--json] [--pricing <价格表.json>]

价格表格式（每 100 万 token 的单价）：
  { "currency": "CNY", "inputPerM": 2, "cacheReadPerM": 0.2, "outputPerM": 3 }
`;

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('bill.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
