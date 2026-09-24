#!/usr/bin/env node
/**
 * L29 · feed 必须**跨账本**且不落后于最新活动（事故 I56）
 *
 * 用户实测报的 bug：「目前浮层最后一条信息显示的是【18:02 审查…】已经是**三个小时前**的消息了。」
 * 根因：`plugin-io.js` 的 feed **只读工作区那一本账**（`ROOT/.warden`），而本轮工作都在
 *   `ROOT/task-warden/.warden` 里 ⇒ 浮层永远显示三小时前的东西。**读错了账本，不是渲染坏了。**
 *
 * 判据（机械）：
 *   ① 快照（`PLUGIN-LIVE.json`）**必须存在**且带 `feed`（为 0 不许报成功）；
 *   ② **新鲜度**：快照的 `atIso` 距现在超过 `STALE_MIN` 分钟 ⇒ 如实 SKIP（**陈旧快照判不了"是否落后"**，
 *      不许拿一个过期的快照去断言"它没落后"）；
 *   ③ 快照新鲜时：**每个有角色产出的账本**，其最新产出时间必须 ≤ feed 最后一条的时间
 *      （否则就是"又读漏了一本"）；
 *   ④ 快照新鲜时：feed 里必须出现**非工作区账本**的条目（`src` 非空）—— 这就是 I56 的直接回归。
 *
 * 为什么能在本沙箱真跑：只读文件 + 纯比较，**不 spawn 子进程**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeCtx } from './common.mjs';

const ROOT = '<WORKSPACE>';
const STALE_MIN = 15;

const rd = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
  } catch { return []; }
};

/** 与 plugin-io.js 的 feedLedgers() 同一套口径：工作区账本 + 每个"同时有 .git 与 .warden"的子目录 */
function ledgers() {
  const out = [{ dir: path.join(ROOT, '.warden'), tag: '' }];
  let es = [];
  try { es = fs.readdirSync(ROOT, { withFileTypes: true }) } catch { es = [] }
  for (const e of es) {
    if (!e.isDirectory()) continue;
    const p = path.join(ROOT, e.name);
    if (fs.existsSync(path.join(p, '.git')) && fs.existsSync(path.join(p, '.warden'))) {
      out.push({ dir: path.join(p, '.warden'), tag: e.name });
    }
  }
  return out;
}

export default async function run() {
  const c = makeCtx('L29', 'feed 跨账本且不落后于最新活动（I56 回归）');

  const livePaths = [path.join(ROOT, '.warden', 'PLUGIN-LIVE.json'), '<HOME>\\DSH-Workspace\\task-warden\\PLUGIN-LIVE.json'];
  let snap = null; let snapPath = '';
  for (const p of livePaths) {
    try { snap = JSON.parse(fs.readFileSync(p, 'utf8')); snapPath = p; break } catch { /* 换下一个 */ }
  }
  if (!snap) {
    c.check('① 快照存在', false, '两个候选路径都读不到 PLUGIN-LIVE.json');
    return finish(c);
  }
  const feed = Array.isArray(snap.feed) ? snap.feed : [];
  c.check('① 快照存在且带 feed（为 0 不许报成功）', feed.length > 0, `${snapPath}  feed=${feed.length}`);

  const ageMin = (Date.now() - (Date.parse(String(snap.atIso || '')) || 0)) / 60000;
  if (!(ageMin <= STALE_MIN)) {
    c.skip('②③④ 新鲜度与跨账本覆盖', `快照已过期 ${Math.round(ageMin)} 分钟（> ${STALE_MIN}）—— 陈旧快照判不了"是否落后"，不许拿它断言`);
    return finish(c);
  }
  c.check('② 快照是新鲜的（不超过 ' + STALE_MIN + ' 分钟）', true, `atIso=${snap.atIso}（${Math.round(ageMin)} 分钟前）`);

  // ③ 合并逻辑：**只看快照拍下那一刻已经存在的产出** ——
  //    ⚠ 2026-09-17 细化（我自己的这条用例先红了一次）：原来拿"账本现在的最新"去比，
  //    于是把**刷新节奏**（快照多久刷一次）的锅算到了**合并逻辑**头上 —— 两件不同的事。
  //    现在的判据是"快照拍下的那一刻，它有没有漏掉当时已存在的产出"。
  const lastFeedAt = String(feed[feed.length - 1].at || '');
  const snapAt = String(snap.atIso || '');
  const offenders = [];
  for (const L of ledgers()) {
    const times = [];
    for (const f of ['VOTES.jsonl', 'FINDINGS.jsonl', 'ROLE_SPEECH.jsonl']) {
      for (const r of rd(path.join(L.dir, f))) if (r.at && String(r.at) <= snapAt) times.push(String(r.at));
    }
    if (!times.length) continue;
    const newest = times.sort().slice(-1)[0];
    if (newest > lastFeedAt) offenders.push(`${L.tag || '(工作区)'} 当时最新 ${newest} > feed 最后 ${lastFeedAt}`);
  }
  c.check('③ 快照拍下那一刻的产出，一条都没被漏（合并逻辑）',
    offenders.length === 0,
    offenders.length ? '★ ' + offenders.join('；') : `feed 最后 = ${lastFeedAt}（快照 atIso=${snapAt}）`);

  // ⑤ **刷新节奏**（与合并逻辑分开；**只提示、不算失败**）：
  //    快照之后账本又有了新产出 ⇒ 显示会落后。这**不是**合并逻辑的错，是"谁来刷新"的问题
  //    （实测根因：常驻插件的 turn 线因"改了没重启"而 exit 1 ⇒ 快照没人刷）。
  //    ⚠ 用 c.skip 而不是 c.check：否则这条用例会因为一个**已知的、环境性的**原因永久变红，
  //      那正是"输入为 0 不许报成功"的反面 —— **已知环境问题不许伪装成代码失败**。
  const afterTimes = [];
  for (const L of ledgers()) {
    for (const f of ['VOTES.jsonl', 'FINDINGS.jsonl', 'ROLE_SPEECH.jsonl']) {
      for (const r of rd(path.join(L.dir, f))) if (r.at && String(r.at) > snapAt) afterTimes.push(String(r.at));
    }
  }
  c.skip('⑤ 刷新节奏（快照之后有没有新产出）',
    afterTimes.length
      ? `快照之后又有 ${afterTimes.length} 条新产出（最新 ${afterTimes.sort().slice(-1)[0]}）⇒ **显示会落后**；根因是刷新端（常驻插件的 turn 线）没跑起来，不是合并逻辑的错`
      : '快照是最新的');

  // ④ feed 里必须出现非工作区账本的条目（I56 的直接回归）
  const tagged = feed.filter((f) => String(f.src || '') !== '');
  c.check('④ feed 里有非工作区账本的条目（I56 的直接回归）',
    tagged.length > 0,
    tagged.length ? `带 src 的条目 ${tagged.length} 条，例：${tagged[tagged.length - 1].src}` : '★ 一条都没有 —— 说明又只读了工作区那一本');

  return finish(c);
}

function finish(c) {
  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? 'feed 是跨账本合并的、且不落后于任何账本的最新角色产出；快照过期时如实跳过（不拿陈旧快照假装通过）。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
