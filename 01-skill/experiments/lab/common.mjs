#!/usr/bin/env node
/**
 * common.mjs —— 实验台共用工具：造沙箱 / 跑 warden / 断言
 *
 * 铁律（整个实验台都靠这几条）：
 *  1. **warden.mjs 是黑盒**：只 `spawn` 它、读它的退出码和 stdout，不 import 内部函数、不改它。
 *     （import 会绕过"用户看到的就是这个退出码"这件事，而且会让并发改 warden 的人互相踩。）
 *  2. **所有沙箱都在 `<LAB_ROOT>\_lab\<name>`**，各自带 `.git` + `.warden`，
 *     绝不碰 `<WORKSPACE>\.warden`、`<别的工程>\.warden`、任何真实源码。
 *  3. 每个沙箱自带一份**假的会话日志**（多帧 zstd），"用户原话"从那里核对 ——
 *     这样实验不依赖真实会话，可重复。
 *
 * 会话日志编码规则（照抄 bill.mjs 的 encodeWorkspace，注释里写死以免漂移）：
 *   <WORKSPACE>\a\b  →  --D-a-b--
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * ⚠ 公开版：这四个常量全部**运行时推导**（原来写死作者本机的 <WORKSPACE>\...）。
 *   本文件在 <skill>/experiments/lab/ ⇒ skill 根 = 上两级。
 *   ⚠ 「脑子B」的审计点名过：**修法本身也必须可公开** —— 只改 LAB_ROOT 不够，
 *     否则 L8 会去读作者私有账本、在公开用户那里必然"INCIDENTS.jsonl 不存在"。
 *
 * ★★ **2026-09-23 修一个名不副实的坑**（I51 的隐患还在）：
 *   下面这个常量**名字叫 SKILL_ROOT，算出来的却是"lab 住的那棵树"** ——
 *   · 在**公开安装**里，lab 住在 `<skill>/experiments/lab` ⇒ 上两级 = skill 根 ✓ 正确；
 *   · 在**作者仓库工作副本**里，lab 住在 `<repo>/experiments/lab` ⇒ 上两级 = **仓库根** ✗，
 *     于是 lab 测的是 **repo 份**（而 DSH 加载的是 skill 份）—— 正是 I51：**分叉时 lab 测旧代码**。
 *   ⇒ 现在显式解析：**优先用 DSH 真正加载的那份**（`$DSH_HOME/skills/task-warden/`），
 *     只有它不存在时才退回"lab 住的那棵树"（公开安装 / 干净机器就走这条）。
 *     `export const SKILL_ROOT` 也一并导出，方便用例断言"到底测的是哪一份"。
 */
function resolveSkillRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const localTree = path.resolve(here, '..', '..')
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const installed = path.join(home, 'skills', 'task-warden')
    if (fs.existsSync(path.join(installed, 'warden.mjs'))) return installed
  } catch (e) { /* 拿不到 DSH_HOME 就退回本地那棵树 */ }
  return localTree
}
export const SKILL_ROOT = resolveSkillRoot()
export const LOCAL_TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const LAB_ROOT = process.env.WARDEN_LAB_ROOT || path.join(os.tmpdir(), 'warden-lab')
export const WARDEN = path.join(SKILL_ROOT, 'warden.mjs')
export const SELFTEST = path.join(SKILL_ROOT, 'selftest.mjs')
export const REAL_WORKSPACE = process.env.DSH_REAL_WORKSPACE || path.dirname(SKILL_ROOT)
export const REAL_WARDEN_DIR = path.join(REAL_WORKSPACE, '.warden')


export const LAB_SESSIONS = path.join(LAB_ROOT, '_sessions');
export const REAL_INCIDENTS = path.join(REAL_WARDEN_DIR, 'INCIDENTS.jsonl');
export const REAL_VOICE = path.join(REAL_WARDEN_DIR, 'VOICE.jsonl');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// ------------------------------------------------------------------ 基础 IO
/** 写 UTF-8 **无 BOM**（PowerShell 的 `>` 会写 UTF-16，所以实验台一律用 Node 写文件） */
export function writeUtf8(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(text), 'utf8');
}

export function readUtf8(p) {
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
}

export function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return readUtf8(p).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
    .map((l, i) => { try { return JSON.parse(l); } catch { return { __badLine: i + 1, __raw: l }; } });
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`);
  return true;
}

/** 单个实验的检查台账：checks = 该成立的检查；skipped = 如实标注做不到的部分 */
export function makeCtx(id, name) {
  return {
    id,
    name,
    checks: [],
    skipped: [],
    check(item, ok, detail = '') {
      this.checks.push({ name: item, ok: !!ok, detail: String(detail).slice(0, 600) });
      return !!ok;
    },
    /** 记一条**如实标注的跳过**（不是通过） */
    skip(item, why) {
      this.skipped.push({ name: item, why: String(why).slice(0, 400) });
    },
  };
}

// ------------------------------------------------------------------ warden 元信息
export function wardenMeta() {
  const p = WARDEN;
  if (!fs.existsSync(p)) return { exists: false };
  const st = fs.statSync(p);
  return {
    exists: true,
    bytes: st.size,
    mtime: st.mtime.toISOString(),
    sha256: sha256File(p).slice(0, 16),
  };
}

// ------------------------------------------------------------------ 跑 warden
/**
 * 跑 warden.mjs。
 * @param {string} cwd      工作目录（沙箱根 / 或"容器目录"做隔离实验）
 * @param {string[]} args   子命令
 * @param {object} opts
 *   sessions: 'lab'（默认，实验室假日志）| 'real'（真实 ~/.dsh/sessions）| 绝对路径
 *   sessionId: 覆盖 DSH_SESSION_ID
 *   timeout: 毫秒
 */
export function runWarden(cwd, args, { sessions = 'lab', sessionId, timeout = 240000 } = {}) {
  const env = { ...process.env };
  if (sessions === 'real') delete env.DSH_SESSIONS_DIR;
  else env.DSH_SESSIONS_DIR = sessions === 'lab' ? LAB_SESSIONS : sessions;
  if (sessionId) env.DSH_SESSION_ID = sessionId;

  /**
   * ★★ **夹具自动补 `--avoided`**（2026-09-17 补；脑子B 的审计实测出 lab 10 个 FAIL，根因就是这个）。
   *
   * 病根：warden.mjs 新增了「`done` 时必须逐条交代「不要」（`--avoided`），缺一条拒收」这条硬规则，
   *   而 **lab 里 19 处 `record` 全都没带 `--avoided`**，17 个夹具的 SPEC 却都写了 `- 不要:`。
   *   ⇒ record 被拒 → ROUNDS 空 → 正控 `check exit 0` 变成 exit 1（L1/L2/L4/L13 等）。
   *
   * 为什么在**这里**补而不是改 19 个调用点：这是**夹具要跟上契约**，不是被测行为变了。
   *   "行为端正的台账"在新契约下本来就该带 `--avoided` —— 集中补 = 把夹具一次性升到新契约。
   *   ⚠ 想测"没交代会怎样"的用例，显式传 `--no-auto-avoided` 关掉（L34 用的是自己的临时账本，不受影响）。
   */
  let argv = args;
  const autoAvoided = !args.includes('--no-auto-avoided');
  const isDone = args[0] === 'record' && args.includes('--status') && args[args.indexOf('--status') + 1] === 'done';
  if (autoAvoided && isDone && !args.includes('--avoided')) {
    argv = args.filter((a) => a !== '--no-auto-avoided');
    try {
      const specPath = path.join(cwd, '.warden', 'SPEC.md');
      if (fs.existsSync(specPath)) {
        const req = argv[argv.indexOf('--req') + 1];
        const text = fs.readFileSync(specPath, 'utf8');
        // 最小解析：找 `## <req> ` 块里的 `- 不要:`，按 warden 的 splitList 同口径拆
        const lines = text.split(/\r?\n/);
        let cur = null; const items = [];
        for (const line of lines) {
          const m = /^##\s+(R\d+)\b/.exec(line);
          if (m) { cur = m[1]; continue }
          if (cur !== req) continue;
          if (/^-\s*不要\s*[:：]/.test(line)) {
            for (const p of line.replace(/^-\s*不要\s*[:：]\s*/, '').split(/[；;、,，|]/)) {
              const t = p.trim(); if (t) items.push(t);
            }
          }
        }
        if (items.length) argv = argv.concat(['--avoided', items.map((it) => it + '=夹具自动补：本次交付没有用它（详见用例断言）').join('|')]);
      }
    } catch (e) { /* 补不上就按原样跑，让它如实红 */ }
  }

  const r = spawnSync(process.execPath, [WARDEN, ...argv], {
    cwd, env, encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024,
  });
  if (r.error) return { code: -1, stdout: r.stdout ?? '', stderr: String(r.error.message), error: true };
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 跑任意 node 脚本（selftest 用） */
export function runNode(cwd, script, args = [], { timeout = 240000, env: extraEnv } = {}) {
  const env = { ...process.env, ...(extraEnv ?? {}) };
  const r = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { code: -1, stdout: r.stdout ?? '', stderr: String(r.error.message), error: true };
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ------------------------------------------------------------------ 沙箱
export function encodeWorkspace(p) {
  const norm = path.resolve(p);
  return '--' + norm.replace(/^([A-Za-z]):[\\/]/, '$1-').replace(/[\\/]/g, '-') + '--';
}

function ensureGit(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  // git 不在 PATH 上也照样能用：findProjectRoot 只看 `.git` 存不存在
  const g = path.join(dir, '.git');
  if (!fs.existsSync(g)) fs.mkdirSync(g, { recursive: true });
}

/**
 * 造一个带 `.git` 的沙箱工程 + `.warden` 骨架（跑真实的 `warden init` 来建骨架）。
 * 注意：**必须**有 `.git`，否则 findProjectRoot 会往上串到别的工程（真实事故）。
 */
export function makeSandbox(name, { paramsYml, initArgs = [] } = {}) {
  const dir = path.join(LAB_ROOT, name);
  // ★ 必须带 maxRetries：实测**同一套实验跑了 4 次得到 4 个结果**（8/4、9/2、10/2、9/3），
  //   因为多个 agent 同时跑 run-all → 互踩同一批 _lab 沙箱 → Windows 抛
  //   `EBUSY: resource busy or locked, rmdir …`。
  //   **一个结果随"谁在旁边跑"变化的测试台，不满足"能机械判定通过/失败"。**
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.mkdirSync(dir, { recursive: true });
  ensureGit(dir);

  const mk = runWarden(dir, ['init', ...initArgs], {});
  if (mk.code !== 0) {
    throw new Error(`沙箱 ${name} 的 warden init 失败（exit ${mk.code}）：\n${mk.stdout}\n${mk.stderr}`);
  }

  const wdir = path.join(dir, '.warden');
  const sb = {
    name,
    dir,
    wdir,
    sessionId: `session-lab-${name}`,
    // 事件时间取"10 分钟前"：文件 mtime 会晚于它，L10 才能用 mtime 判"同步之后又有新消息"
    t0: Date.now() - 10 * 60 * 1000,
  };

  // 声明归属 + "用户原话去哪找"。显式写死，避免依赖 DSH_SESSION_ID 的自动识别。
  writeUtf8(path.join(wdir, 'config.json'), JSON.stringify({
    projectRoot: dir,
    createdAt: new Date().toISOString(),
    quoteWorkspaces: [dir],
  }, null, 2));

  /**
   * ⚠ 2026-09-17 补（**改夹具、不放宽判据**）：
   *   新加了 R14 的强制面 —— 「报了 done 就必须有一次收尾对账」（`check` 会硬失败）。
   *   而沙箱里大量用例会写 `status: done` 的轮次 ⇒ 它们会因为新判据变红（实测 6 条）。
   *   按本项目的规矩：**不许为了让改动通过而放宽检查，也不许留着红** ——
   *   所以在这里把沙箱补成"已经对过账"（lastRound 给一个大数，覆盖后面所有夹具轮次）。
   *   专门测那条判据的用例（L33）自己造**临时账本**，不受这里影响。
   */
  writeUtf8(path.join(wdir, 'RECON.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), kind: 'needs', session: sb.sessionId, planned: [], quotes: 0, lastRound: 999999 }) + '\n'
    + JSON.stringify({ at: new Date().toISOString(), kind: 'results', session: sb.sessionId, planned: [], quotes: 0, gaps: 0, lastRound: 999999 }) + '\n');

  // 默认没有档位要盯；需要盯的沙箱自己覆盖
  writeUtf8(path.join(wdir, 'params.yml'), paramsYml ?? 'watches: []\n');
  writeUtf8(path.join(wdir, 'SPEC.md'), '# 需求锁定表（append-only）\n');
  writeUtf8(path.join(wdir, 'DEVIATIONS.md'), '# 偏差申报单\n');
  writeUtf8(path.join(wdir, 'ROUNDS.jsonl'), '# 每轮一行 JSON\n');
  return sb;
}

/** 把 SPEC.md 里所有 `- 原话: …` 抽出来（用来造会话日志语料） */
export function specQuotes(specText) {
  const out = [];
  for (const line of String(specText).split(/\r?\n/)) {
    const m = /^[-*]\s*(?:原话|quote)\s*[:：]\s*(.+)$/.exec(line.trim());
    if (m) out.push(m[1].trim());
  }
  return out;
}

/**
 * 沙箱的"用户原话"从哪来：写一份**假会话日志**（多帧 zstd）到实验室会话根。
 * 只放 `data.source.kind === 'user'` 的真用户消息 —— 注入消息不算（这是 warden 的地基规则）。
 */
export function seedSession(sb, { users = [], assistants = [], wroteDisk = true, sessionId, assistantFirst = false } = {}) {
  const sid = sessionId ?? sb.sessionId;
  const dirName = encodeWorkspace(sb.dir);
  const sdir = path.join(LAB_SESSIONS, dirName, sid);
  fs.rmSync(path.join(LAB_SESSIONS, dirName), { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.mkdirSync(sdir, { recursive: true });
  const t0 = sb.t0;

  // assistantFirst：AI 先写出这段文字，用户随后**贴回来**（用来复现"引述自 AI"）
  const uf = users.map((text, i) => userEvent(text, t0 + (assistantFirst ? 120_000 : 0) + i * 1000, i + 1));
  const af = assistants.map((text, i) => assistantEvent(text, t0 + (assistantFirst ? 0 : 120_000) + i * 1000));
  const wf = wroteDisk ? [writeToolEvent(t0 + 300_000)] : [];
  const frames = assistantFirst ? [af, uf.concat(wf)].filter((f) => f.length) : [uf.concat(wf), af].filter((f) => f.length);

  const file = path.join(sdir, 'session.v3.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat(frames.map(frame)));
  Object.assign(sb, { sessionId: sid, sessionFile: file, sessionDir: sdir, sessionDirName: dirName });
  return { file, sid, dirName };
}

/** 往已有会话日志**追加一帧**新的用户消息（模拟"同步之后用户又说了话"） */
export function appendUserFrame(sb, text, { seq = 900, at } = {}) {
  const time = at ?? Date.now();
  fs.appendFileSync(sb.sessionFile, frame([userEvent(text, time, seq)]));
  return { file: sb.sessionFile, time, mtimeMs: fs.statSync(sb.sessionFile).mtimeMs };
}

/** 把会话日志的 mtime 改老 —— 让"同步时点"早于日志落盘时点，避免检测器把基线误判成陈旧 */
export function backdateSession(sb, ms) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(sb.sessionFile, t, t);
  return fs.statSync(sb.sessionFile).mtimeMs;
}

export function userEvent(text, time, seq = 1) {
  return {
    type: 'user/message', seq, time,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `u${seq}` },
  };
}

export function assistantEvent(text, time, seq = 90) {
  return {
    type: 'assistant/message', seq, time,
    data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, totalTokens: 1200 },
    },
  };
}

export function writeToolEvent(time, seq = 50) {
  return { type: 'tool/call', seq, time, data: { name: 'write', arguments: '{}' } };
}

function frame(events) {
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  return zlib.zstdCompressSync(Buffer.from(body, 'utf8'));
}

/** 解多帧 zstd（单帧解压器会漏掉后面的帧 —— 真实踩过） */
export function decodeFrames(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i !== -1) { starts.push(i); i = buf.indexOf(ZSTD_MAGIC, i + 4); }
  const events = [];
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let out;
    try { out = zlib.zstdDecompressSync(buf.subarray(starts[k], end)); } catch { continue; }
    for (const line of out.toString('utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try { events.push(JSON.parse(s)); } catch { /* 半截行 */ }
    }
  }
  return { events, frames: starts.length };
}

/** 原始会话日志里有几条**真用户**消息 */
export function countUserMessages(file) {
  const { events } = decodeFrames(file);
  return events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user').length;
}

// ------------------------------------------------------------------ 便捷组合
/** 造沙箱 + 写 SPEC + 用 SPEC 里的「原话」灌会话日志 */
export function provision(name, specText, opts) {
  const sb = makeSandbox(name, opts);
  writeUtf8(path.join(sb.wdir, 'SPEC.md'), specText);
  seedSession(sb, { users: specQuotes(specText) });
  return sb;
}

/** 清空台账（每个子检查从干净状态开始，避免上一条的轮次影响下一条） */
export function resetLedger(sb) {
  writeUtf8(path.join(sb.wdir, 'ROUNDS.jsonl'), '# 每轮一行 JSON\n');
  writeUtf8(path.join(sb.wdir, 'DEVIATIONS.md'), '# 偏差申报单\n');
}

/** 从 warden 输出里挑出"我们关心的那几行"，给汇总表当证据 */
export function grab(text, patterns, limit = 4) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (patterns.some((p) => (p instanceof RegExp ? p.test(line) : line.includes(p)))) out.push(line.trim());
    if (out.length >= limit) break;
  }
  return out;
}

export function realSessionsRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'sessions');
}
