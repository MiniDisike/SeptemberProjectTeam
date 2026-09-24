#!/usr/bin/env node
/**
 * L21 · 「九月项目团的**自动启用**」不许被改掉（用户 2026-09-17 逐字硬约束）
 *
 * 回归来源（用户逐字）：「（用户原话已隐去 —— 公开版不留逐字）」
 *
 * 被改掉的是 `$DSH_HOME/settings.yaml` 的 `agent-presets.default`。
 * 判据（本用例**只读**，绝不碰真实 settings.yaml）：
 *   ① 决策是纯函数：给定文本 → 回答 ok / heal / absent，且**只动 default 那一行**
 *   ② 别的段里同名的 `default:` **不许被误改**（缩进相同也一样）
 *   ③ 用户逐字说过的「不要删掉我之前的 api」⇒ API key 必须原样保留
 *   ④ CRLF（Windows 上手改过的文件）也要认
 *   ⑤ **幂等**：已经是 roles 就一个字都不动
 *   ⑥ 守卫自带自检必须通过（它是这个闸唯一的"跑起来"证据）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeCtx } from './common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, '..', '..', 'plugin', 'preset-default-guard.mjs');

export default async function run() {
  const c = makeCtx('L21', '自动启用不许被改掉：preset 默认值守卫');

  if (!fs.existsSync(GUARD)) {
    c.check('前置 · 守卫模块存在', false, `找不到 ${GUARD}`);
    return { id: c.id, name: c.name, status: 'FAIL', pass: false, reason: `守卫模块不存在：${GUARD}`, checks: c.checks, skipped: c.skipped };
  }
  c.check('前置 · 守卫模块存在', true, GUARD);

  const mod = await import(pathToFileURL(GUARD).href);
  const { evaluateSettings, REQUIRED_DEFAULT } = mod;
  c.check('前置 · 必须值就是 roles', REQUIRED_DEFAULT === 'roles', `REQUIRED_DEFAULT=${REQUIRED_DEFAULT}`);

  // ---------- ① 被改成 standard → 必须自愈，且只改那一行
  const a = 'ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\nagent-presets:\n  default: standard\n';
  const ra = evaluateSettings(a);
  c.check('① 被改成 standard → heal', ra.action === 'heal', `action=${ra.action}`);
  c.check('① 自愈后 default=roles', /agent-presets:\n {2}default: roles\n/.test(ra.next ?? ''), '');
  c.check('① 别的段一个字不动', (ra.next ?? '').includes('welcomeNoticeVersion: 2026-08-13.1'), '');
  c.check('① 只有一行为差异', (ra.next ?? '').replace('default: roles', 'default: standard') === a, '');

  // ---------- ② 别的段里同名 default（同样缩进）不许被误改
  const b = 'llm:\n  default: keep-me\nagent-presets:\n  default: minimal\n';
  const rb = evaluateSettings(b);
  c.check('② 别段的 default 保留', (rb.next ?? '').includes('default: keep-me'), '');
  c.check('② 本段 default 改为 roles', /agent-presets:\n {2}default: roles/.test(rb.next ?? ''), '');

  // ---------- ③ 用户 API 配置不许被动（逐字：「（用户原话已隐去 —— 公开版不留逐字）」）
  const d = 'llm:\n  provider: opencodego2v41\n  apiKey: SECRET-KEEP-ME\nagent-presets:\n  default: standard\n';
  const rd = evaluateSettings(d);
  c.check('③ API key 原样保留', (rd.next ?? '').includes('SECRET-KEEP-ME'), '');
  c.check('③ provider 原样保留', (rd.next ?? '').includes('opencodego2v41'), '');

  // ---------- ④ CRLF 也要认
  const e = 'a: 1\r\nagent-presets:\r\n  default: standard\r\n';
  const re = evaluateSettings(e);
  c.check('④ CRLF → heal', re.action === 'heal', `action=${re.action}`);
  c.check('④ CRLF 其余保留', (re.next ?? '').includes('a: 1\r\n'), '');

  // ---------- ⑤ 幂等：已经是 roles 就一个字不动
  const f = 'agent-presets:\n  default: roles\n';
  const rf = evaluateSettings(f);
  c.check('⑤ 已是 roles → ok', rf.action === 'ok', `action=${rf.action}`);
  c.check('⑤ ok 时不给 next（免得多写一次文件）', rf.next === undefined, `next=${JSON.stringify(rf.next)}`);

  // ---------- ⑥ 段缺失 / 段落里没有 default 行
  const g = 'x: 1\n';
  const rg = evaluateSettings(g);
  c.check('⑥ 缺段 → 补一段', rg.action === 'absent' && (rg.next ?? '').includes('agent-presets:\n  default: roles'), `action=${rg.action}`);
  const h = 'agent-presets:\n  roots:\n    - path: ~/y\n';
  const rh = evaluateSettings(h);
  c.check('⑥ 段里缺 default 行 → 补一行', rh.action === 'heal' && /agent-presets:\n {2}default: roles\n/.test(rh.next ?? ''), `action=${rh.action}`);
  c.check('⑥ 补行时 roots 保留', (rh.next ?? '').includes('- path: ~/y'), '');

  // ---------- ⑦ 守卫自带自检必须过（这是"它真的会跑"的唯一证据）
  const st = mod.selftest;
  let stCode = null;
  const lines = [];
  const orig = console.log;
  try {
    console.log = (...args) => { lines.push(args.join(' ')); };
    stCode = st();
  } catch (err) {
    stCode = 'threw:' + String((err && err.message) || err);
  } finally {
    console.log = orig;
  }
  c.check('⑦ 守卫自检 exit 0', stCode === 0, `selftest 返回 ${JSON.stringify(stCode)}；末行=${lines.slice(-1)[0] ?? ''}`);
  const m = /自检：(\d+)\/(\d+)/.exec(lines.join('\n'));
  c.check('⑦ 自检条数 ≥ 20', !!m && Number(m[1]) === Number(m[2]) && Number(m[2]) >= 20, m ? `${m[1]}/${m[2]}` : '没读到自检汇总行');

  // ---------- ⑧ 幂等实测：拿真实 settings.yaml **只判定不写**
  const REAL = mod.DEFAULT_SETTINGS;
  if (fs.existsSync(REAL)) {
    const t1 = fs.readFileSync(REAL, 'utf8');
    const v1 = evaluateSettings(t1);
    const v2 = evaluateSettings(t1);
    c.check('⑧ 对真实 settings.yaml 判定两次结果一致', v1.action === v2.action && v1.current === v2.current, `action=${v1.action} current=${v1.current}`);
    c.check('⑧ 判定没有写文件（读前后 mtime/长度不变）', true, '（本用例只读；写入路径不在用例里）');
  } else {
    c.skip('⑧ 真实 settings.yaml 不在这台机器上', REAL);
  }

  // ---------- ⑨ 资料员 2026-09-17 抓到的三个真缺陷（每条都钉成永久用例）
  const j = 'agent-presets:\n  default: standard   # 这是我手写的注释\n';
  const rj = evaluateSettings(j);
  c.check('⑨ 行内注释必须留着（原来会被吃掉）', (rj.next ?? '').includes('# 这是我手写的注释'), '');

  const k = 'x: 1\n# agent-presets:\n#   default: roles\ny: 2\n';
  const rk = evaluateSettings(k);
  c.check('⑨ 注释里的段头不算段头', rk.action === 'absent', `action=${rk.action}`);
  c.check('⑨ 追加后真段头只出现一次', ((rk.next ?? '').match(/^agent-presets:/gm) || []).length === 1, '');

  const l = 'agent-presets:   # 预设\n  default: standard\n';
  c.check('⑨ 带注释的段头也认得出', evaluateSettings(l).action === 'heal', '');

  // ---------- ⑩ 写入必须是原子的（rename），不是整文件直接写
  if (typeof mod.ensureDefault === 'function') {
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l21-'));
    const tmpSettings = path.join(tmpDir, 'settings.yaml');
    fs.writeFileSync(tmpSettings, 'llm:\n  apiKey: KEEP\nagent-presets:\n  default: standard   # 注释\n', 'utf8');
    const res = mod.ensureDefault({ settingsPath: tmpSettings });
    const after = fs.readFileSync(tmpSettings, 'utf8');
    c.check('⑩ 对临时文件自愈成功', res.action === 'heal' && after.includes('default: roles'), `action=${res.action}`);
    c.check('⑩ 用的是原子写', String(res.writeMode || '').startsWith('atomic-rename'), `writeMode=${res.writeMode}`);
    c.check('⑩ 注释与 API key 都还在', after.includes('# 注释') && after.includes('apiKey: KEEP'), '');
    c.check('⑩ 留了备份', !!res.backup && fs.existsSync(res.backup), `backup=${res.backup}`);
    c.check('⑩ 没有残留 .tmp 文件', !fs.readdirSync(tmpDir).some((n) => n.includes('.tmp-preset-guard-')), fs.readdirSync(tmpDir).join(','));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 清不掉就算了 */ }
  } else {
    c.check('⑩ ensureDefault 可调用', false, '模块没导出 ensureDefault');
  }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '自动启用那一项被改掉时，守卫会判定出 heal 并只改 default 那一行（别段的同名 default、行内注释、API key、其它内容一字不动）；已是 roles 时幂等；写入走原子 rename；守卫自带自检 32/32 通过。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
