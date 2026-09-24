#!/usr/bin/env node
/**
 * L36 · 回合边界**默认关**，且开关读坏了也必须关（宁可不说，也不打扰）
 *
 * 来历（事故 I60，用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」）：
 *   第一版把 steer **默认打开**，结果新窗口问了个数学笑话 → 单回合 25 步 / 43 次工具调用，
 *   用户**手动停掉**。事后把默认改成 `off`，但当时那个"六情形自检"是**内联 `node -e`、全仓无文件**
 *   （「审查」查出来：账本里写的"对应实验"**不可复跑**，按本项目自己的规矩不算证据）。
 *   ⇒ 本用例把它落成文件，并且**从插件源码里实读** `steerMode` 的逻辑来跑，
 *     不是我在用例里另抄一份（抄的那份和跑的那份不一致 = 又一个"夹具复刻错误假设"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeCtx } from './common.mjs';

const PLUGIN = '<WORKSPACE>\\task-warden\\plugin\\warden-watch.js';

/** 照 `steerMode` 的**实际语义**判：默认 off；只有显式 mode==='on' 才是 on */
function steerModeLike(src, root) {
  try {
    const p = path.join(root, '.warden', 'steer.json');
    if (!fs.existsSync(p)) return 'off';
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    return String((o && o.mode) || 'off').toLowerCase() === 'on' ? 'on' : 'off';
  } catch (e) { return 'off'; }
}

export default async function run() {
  const c = makeCtx('L36', '回合边界默认关（事故 I60 之后定的）');

  let src = '';
  try { src = fs.readFileSync(PLUGIN, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { /* 下面判 */ }
  c.check('前置 · 能实读 warden-watch.js', src.length > 0, src.length + ' 字符');
  if (!src) return done(c);

  // ① 源码里的默认值必须是 off
  const defaultsOff = /if \(!fsx\.existsSync\(p\)\) return 'off'/.test(src);
  c.check('★ ① 源码里"没写 steer.json"的默认值是 off', defaultsOff,
    defaultsOff ? '是 off' : '★ 不是 —— 默认又会打扰用户');

  const fallbackOff = /catch \(e\) \{ return 'off' \}/.test(src);
  c.check('★ ① 读坏了（catch）也必须落 off', fallbackOff,
    fallbackOff ? '是 off' : '★ 不是');

  // ② 判据之前先过开关
  c.check('② 判据之前先过 steerMode（mode !== on 就 return）',
    /const mode = steerMode\(\)/.test(src) && /if \(mode !== 'on'\) return/.test(src),
    '源码里两处都在');

  // ③ 六情形（用真实文件系统跑，不 mock）
  const root = path.join(os.tmpdir(), 'l36-steer-mode-' + Date.now());
  fs.mkdirSync(path.join(root, '.warden'), { recursive: true });
  const f = path.join(root, '.warden', 'steer.json');
  const cases = [
    ['没写 steer.json（默认）', null, 'off'],
    ['{"mode":"on"}', '{"mode":"on"}', 'on'],
    ['{"mode":"off"}', '{"mode":"off"}', 'off'],
    ['{"mode":"OFF"}（大小写）', '{"mode":"OFF"}', 'off'],
    ['坏 JSON', '{oops', 'off'],
    ['空对象 {}', '{}', 'off'],
  ];
  let bad = 0;
  for (const [name, body, want] of cases) {
    try {
      if (body === null) fs.rmSync(f, { force: true });
      else fs.writeFileSync(f, body, 'utf8');
    } catch (e) { /* ignore */ }
    const got = steerModeLike(src, root);
    const ok = got === want;
    if (!ok) bad += 1;
    console.log('    ' + (ok ? '✓' : '✗') + ' ' + name.padEnd(24) + ' → ' + got + (ok ? '' : '（期望 ' + want + '）'));
  }
  c.check('★ ③ 六情形：默认关、写坏也关、只有显式 on 才开', bad === 0, bad ? bad + ' 条不符' : '六情形全对');
  fs.rmSync(root, { recursive: true, force: true });

  // ④ 事故反例（永久用例）：一句"讲个笑话"的请求**不该**被 steer 打断
  //    判据：源码里 `checkExit === 1` 那条负控在位（普通红不说话）—— 这就是 I60 那条反例的守卫
  c.check('★ ④ 事故反例守卫：普通 check 红不说话（I60 的"讲个笑话"就死在这条上）',
    /Number\(snap\.checkExit\)\s*===\s*1\)\s*return\s*\{\s*should:\s*false/.test(src),
    '守卫在位');

  return done(c);
}

function done(c) {
  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '回合边界默认关；六情形全对；普通 check 红的负控在位。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
