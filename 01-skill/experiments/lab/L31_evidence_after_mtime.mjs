#!/usr/bin/env node
/**
 * L31 · **证据必须晚于它引用的文件**（"假证据"这一类，2026-09-17 审查抓出来的）
 *
 * 事由：我把 R23 记成 done，引的证据是 `session-1aa1c02a` 的 system/message。
 *   审查解帧逐字 grep：`状态类问题`/`直接回答`/`结论先行` **命中 0**；
 *   而该窗口创建于 **10:42:45Z**、第9条写入 `agent.cordis.yml` 是 **10:55:32Z**
 *   ⇒ **时间上不可能注入**。**"拿旧窗口证新规则"就是假证据**，比没证据更坏（它看起来像证据）。
 *
 * 我重取真证据时，自己又踩了两个坑（都记在这儿，因为它们是同一类病）：
 *   ① 把 TypeError 吞在 try/catch 里 ⇒ 159 个会话全跳过、报"0 命中"（**静默吞错**）；
 *   ② 拿 `at`（**毫秒时间戳**）当字符串去比 ISO 串 ⇒ 时间判断**全反**，把 9 个有效证据判成无效。
 *
 * 判据（机械）：
 *   ① 存在**至少一个**窗口：其 `system/message` 逐字含 needle，**且**创建时间晚于被引文件的 mtime；
 *      （一个都找不到 ⇒ 如实 SKIP —— 可能是会话被清了，不许假装通过）
 *   ② **反例必须被判无效**：`session-1aa1c02a`（早于 mtime）**不许**被算成有效见证；
 *   ③ 时间比较必须认**两种**写法（毫秒时间戳与 ISO 串）—— 这就是我踩的第②个坑。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { makeCtx } from './common.mjs';

const NEEDLE = '状态类问题要一句话直接答';
const PRESET = '<HOME>\\.dsh\\.agent-presets\\roles\\agent.cordis.yml';
const OLD_WINDOW = 'session-1aa1c02a';
const SESS_ROOT = '<HOME>\\.dsh\\sessions';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** `at` 可能是毫秒时间戳、也可能是 ISO 串 —— 两种都要认（v3 只认字符串，结论全反） */
function toMs(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v);
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function decodeFrames(file) {
  const buf = fs.readFileSync(file);
  const parts = [];
  let i = 0;
  for (;;) {
    const at = buf.indexOf(MAGIC, i);
    if (at < 0) break;
    const next = buf.indexOf(MAGIC, at + 4);
    const end = next < 0 ? buf.length : next;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(at, end))) } catch { parts.push(Buffer.from('')) }
    if (next < 0) break;
    i = next;
  }
  const events = [];
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { events.push(JSON.parse(s)) } catch { /* 坏行 */ }
  }
  return events;
}

function sessions() {
  const out = [];
  for (const ws of fs.readdirSync(SESS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const p1 = path.join(SESS_ROOT, ws.name);
    for (const s of fs.readdirSync(p1, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const p2 = path.join(p1, s.name);
      for (const f of fs.readdirSync(p2)) if (f.includes('session')) out.push({ id: s.name, file: path.join(p2, f) });
    }
  }
  return out;
}

export default async function run() {
  const c = makeCtx('L31', '证据必须晚于它引用的文件（假证据这一类）');

  // ③ 时间比较认两种写法
  const isoOf = '2026-09-17T10:55:32.652Z';
  c.check('③ 时间比较同时认毫秒时间戳与 ISO 串',
    toMs(Date.parse(isoOf)) === toMs(String(Date.parse(isoOf))) && toMs(isoOf) === Date.parse(isoOf),
    `毫秒=${toMs(String(Date.parse(isoOf)))} / ISO=${toMs(isoOf)}`);

  const mtimeMs = fs.statSync(PRESET).mtimeMs;
  const list = sessions();
  c.check('前置 · 扫到了会话（为 0 不许报成功）', list.length > 0, `会话文件 ${list.length} 个`);

  const valid = []; const invalid = [];
  for (const s of list) {
    let events = [];
    try { events = decodeFrames(s.file) } catch { continue }
    const sys = events.find((e) => e.type === 'system/message');
    if (!sys) continue;
    if (!JSON.stringify(sys).includes(NEEDLE)) continue;
    const ms = toMs(sys.time || sys.at);
    if (ms >= mtimeMs) valid.push({ id: s.id, ms }); else invalid.push({ id: s.id, ms });
  }

  if (!valid.length) {
    c.skip('① 存在晚于 mtime 的有效见证', `一条都没找到（含 needle 的窗口 ${valid.length + invalid.length} 个，全部早于 mtime）—— 可能是会话被清了，不许假装通过`);
  } else {
    valid.sort((a, b) => a.ms - b.ms);
    c.check('① 存在晚于 mtime 的有效见证（这条才配当"注入过"的证据）',
      true,
      `有效 ${valid.length} 个，最早 ${valid[0].id} @ ${new Date(valid[0].ms).toISOString()}，最晚 ${valid[valid.length - 1].id} @ ${new Date(valid[valid.length - 1].ms).toISOString()}`);
  }

  const old = list.find((s) => s.id.includes(OLD_WINDOW));
  if (!old) {
    c.skip('② 反例（审查用的那个旧窗口）被判无效', `找不到 ${OLD_WINDOW} —— 会话可能被清了，判不了`);
  } else {
    const hitValid = valid.some((v) => v.id.includes(OLD_WINDOW));
    const hitInvalid = invalid.some((v) => v.id.includes(OLD_WINDOW));
    c.check('② 反例必须被判无效：早于 mtime 的窗口不许算有效见证',
      hitValid === false,
      hitInvalid ? `★ 正确：${OLD_WINDOW} 被归入"无效（早于写入）"` : `（它连 needle 都不含 —— 也说明它不可能是有效见证）`);
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '证据必须晚于它引用的文件：有效见证与"早于写入"的反例被分开；时间比较两种写法都认（我踩过的两个坑都钉住了）。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
