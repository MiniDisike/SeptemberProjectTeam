#!/usr/bin/env node
/**
 * L10 · 权威层陈旧实验（核查建立在过期语料上）
 *
 * 回归来源（真实事故）：ARCH 的 R13 原话在**原始会话日志**第 4287 行有，`VOICE.jsonl` 里**查无**
 * （VOICE 只同步到 seq 19）；重跑 `voices` 后 **133 → 143 条**。
 * 后果：所有"查无实据"都可能是**假指控** —— 把用户真说过的话报成"用户没说过"。
 *
 * 判据（设计文档）：同步过 VOICE 之后，**再往原始会话日志追加一条新用户消息但不重跑 voices**，
 * `check` 必须警告「VOICE 快照落后，归属核查不可信，先跑 voices 同步」。
 *
 * ⚠ 依赖：这个警告**由另一个子代理在 warden.mjs 里新增**。实验台**不许改 warden.mjs**。
 *   跑的时候如果那个警告还没实现 → 本实验如实报 **SKIP**（前提与危险实证照跑照报）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  provision, writeUtf8, runWarden, makeCtx, grab, readUtf8, appendUserFrame,
  backdateSession, countUserMessages, seedSession,
} from './common.mjs';

const QUOTE = '凡是标了归属的句子，都要能在原始会话日志里逐字找到；快照过期了就不许拿它下结论。';
const LATER = '再加一个海豚形状的画笔，这条是同步之后才说的。';
const KEYWORD = '海豚';

const spec = (sid) => `# 需求锁定表（append-only）

## R1 · 归属核查不许建立在过期语料上
- 原话: ${QUOTE}
- 出处: session:${sid}#1
- 为什么: 快照一旧，"查无实据"就变成假指控，等于把用户真说过的话说成没说过
- 必须: 核查前确认快照没落后于原始日志
- 不要: 拿过期快照下结论
- 锁定: 2026-09-16
`;

/** 识别"VOICE 快照落后"的警告（措辞可能与实现略有出入，所以放宽成一个模式） */
const STALE_RE = /(VOICE|窗口传递层|快照)[^\n]{0,40}(落后|陈旧|过期|未同步|不同步|没同步|需要同步|先跑\s*voices|重新跑\s*voices|重跑\s*voices)/;

function voiceCount(sb) {
  return readUtf8(path.join(sb.wdir, 'VOICE.jsonl')).split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#')).length;
}

export default async function run() {
  const c = makeCtx('L10', '权威层陈旧：核查建立在过期语料上');
  const sb = provision('L10_stale_voice', spec('session-lab-L10_stale_voice'));
  writeUtf8(path.join(sb.wdir, 'SPEC.md'), spec(sb.sessionId));
  // 三条消息的事件时间都放在 30 分钟前（> warden 的 10 分钟 grace）
  sb.t0 = Date.now() - 30 * 60 * 1000;
  // 两条用户消息（第二条是为了让"追加"有对比）
  seedSession(sb, { users: [QUOTE, '第二条：同步之后发生的事情也要算数。'] });
  runWarden(sb.dir, ['record', '--req', 'R1', '--status', 'done', '--delivered', '归属核查前置检查',
    '--evidence', '.warden/VOICE.jsonl', '--why', '先把窗口传递层落盘'], { sessionId: sb.sessionId });

  // a) **先把日志 mtime 改老**（代表"日志最后一次落盘是在 30 分钟前"），**再同步** ——
  //    这样同步水位线（VOICE.sync.json）记的就是那个旧时间，基线不会被误判成陈旧。
  backdateSession(sb, 30 * 60 * 1000);
  const v1 = runWarden(sb.dir, ['voices'], { sessionId: sb.sessionId });
  const n1 = voiceCount(sb);

  // c) 基线：还没追加新消息，check 不该警告
  const base = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });

  // d) 追加一条新用户消息（原始日志更新了），**不重跑 voices**
  appendUserFrame(sb, LATER);

  // e) 前提：原始日志比快照新
  const logCount = countUserMessages(sb.sessionFile);
  const n2 = voiceCount(sb);
  c.check('前提 · 追加后：原始会话日志 3 条真用户消息，而 VOICE.jsonl 只有 2 条（快照确实落后）',
    logCount === 3 && n2 === 2 && n1 === 2,
    `voices exit=${v1.code}；原始日志 ${logCount} 条 / VOICE ${n2} 条`);
  c.check('前提 · VOICE 最后一条的时间早于会话日志文件的 mtime（可用 stat 判陈旧，不必解压 zstd）',
    (() => {
      const at = Math.max(...readUtf8(path.join(sb.wdir, 'VOICE.jsonl')).split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith('#')).map((l) => Date.parse(JSON.parse(l).at ?? 0)));
      const mt = fs.statSync(sb.sessionFile).mtimeMs;
      return Number.isFinite(at) && mt > at;
    })(),
    `会话日志 mtime=${new Date(fs.statSync(sb.sessionFile).mtimeMs).toISOString()}`);

  // f) 危险实证：在旧快照上查关键词 = 0 命中（＝"用户没说过"）
  const staleSearch = runWarden(sb.dir, ['voices', KEYWORD], { sessionId: sb.sessionId });
  c.check(`危险实证 · 拿旧快照查「${KEYWORD}」→ 0 命中（这正是把用户真说过的话报成"没说过"的机制）`,
    /0 条/.test(staleSearch.stdout) || /（用户没说过这个/.test(staleSearch.stdout),
    grab(staleSearch.stdout, [/查「/, /没说过/], 2).join(' | '));

  // g) 主判据：check 必须警告快照落后
  const stale = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
  const warned = STALE_RE.test(stale.stdout) || /归属核查不可信/.test(stale.stdout);
  const warnLine = grab(stale.stdout, [STALE_RE, /归属核查不可信/, /voices/], 2).join(' | ');

  // h)i)j) 正控：重跑 voices → 3 条，且关键词查得到，check 不再警告
  const v2 = runWarden(sb.dir, ['voices'], { sessionId: sb.sessionId });
  const n3 = voiceCount(sb);
  const freshSearch = runWarden(sb.dir, ['voices', KEYWORD], { sessionId: sb.sessionId });
  const after = runWarden(sb.dir, ['check'], { sessionId: sb.sessionId });
  c.check('正控 · 重跑 voices 后：VOICE 补齐到 3 条，关键词能查到（快照不再落后）',
    n3 === 3 && freshSearch.stdout.includes(LATER.slice(0, 12)),
    `voices exit=${v2.code}；VOICE ${n3} 条；${grab(freshSearch.stdout, [/查「/], 1).join('')}`);

  if (warned) {
    c.check('主判据 · 快照落后时 check 警告「VOICE 快照落后 / 归属核查不可信」',
      true, `${warnLine}（实测 check exit=${stale.code}）`);
    c.check('负控 · 基线（还没追加新消息）时 check **不**警告（不误报）',
      !STALE_RE.test(base.stdout), `基线 check exit=${base.code}；${grab(base.stdout, [/VOICE/], 2).join(' | ') || '没有 VOICE 相关输出'}`);
    c.check('正控 · 重跑 voices 后警告消失',
      !STALE_RE.test(after.stdout), `check exit=${after.code}；${grab(after.stdout, [/VOICE/], 2).join(' | ') || '没有 VOICE 相关输出'}`);
  } else {
    c.skip('主判据 · 快照落后时 check 必须警告「VOICE 快照落后，归属核查不可信」',
      'warden.mjs 的 check 里**还没有**这个警告（由另一个子代理在改，实验台不许改 warden.mjs）。' +
      `实测：stale check exit=${stale.code}，输出里没有任何 VOICE/快照相关提醒（${warnLine || '无'}）。`);
    c.skip('负控/正控 · 警告的误报与消失验证', '同上：主判据未实现，警告的两条配套断言无从谈起。');
  }

  const status = warned ? 'PASS' : 'SKIP';
  return {
    id: c.id,
    name: c.name,
    status,
    pass: status !== 'FAIL' && c.checks.every((x) => x.ok),
    reason: warned
      ? '快照落后被 check 抓到了，且基线不误报、同步后警告消失。'
      : '**SKIP**：L10 的主判据（check 里的"VOICE 快照落后"警告）依赖另一个子代理在 warden.mjs 里新增，' +
        '实测尚未实现。前提（原始日志 3 条 vs 快照 2 条、mtime 晚于 VOICE 末条时间）与危险实证（旧快照 0 命中）已通过。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
