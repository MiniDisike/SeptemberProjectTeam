#!/usr/bin/env node
/**
 * L22 · 「改已确认完成的东西」的**两角色规划闸**不能被空壳绕过
 *
 * 回归来源：
 *   · 用户 2026-09-16 逐字：「（用户原话已隐去 —— 公开版不留逐字）」
 *   · 「审查」2026-09-17 实测报的缺陷：`--plan "资料员：方向员："`（只念两个角色名）被收下。
 *   · 主代理随后复核出更严重的一条：`资料员： 查了…`（**冒号后打一个空格**，最自然的写法）
 *     被判成"没规划"、整条 record 被拒收 —— 因为判据是 `\S{6,}`，要求冒号后**紧跟**非空白。
 *
 * 判据（黑盒，跑真 CLI，用临时沙箱，不碰真账本）：
 *   负控 ① 只念角色名（`资料员：方向员：`）→ 拒收
 *   负控 ② 冒号后只有空白 → 拒收
 *   负控 ③ 只写一个角色的规划 → 拒收
 *   正控 ④ 两个角色各写 ≥6 个非空白字符（**冒号后带空格的自然写法**）→ 收下
 *   正控 ⑤ 用发现台账 `find add` 交规划（另一条合法路径）→ 收下
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWarden, makeCtx, writeUtf8 } from './common.mjs';

const SPEC = `# 需求锁定表（append-only）

## R1 · 先记一轮 done，闸才有东西可拦
- 原话: 这是一条用来复现规划闸的测试需求原话，长度够
- 出处: session-lab#1
- 为什么: 没有 done 这一轮，reopenGate 根本不会开
- 必须: 先 done 再改
- 不要:
- 锁定: 2026-09-17
`;

const PARAMS = `watches:
  - id: demo
    label: 演示档位
    kind: rust_const
    file: src/demo.rs
    name: DEMO_CONST
`;

export default async function run() {
  const c = makeCtx('L22', '两角色规划闸：空壳不许过，自然写法不许误伤');

  const dir = path.join(os.tmpdir(), 'L22_plan_gate');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  writeUtf8(path.join(dir, 'src', 'demo.rs'), 'pub const DEMO_CONST: f32 = 1.30;\n');

  const run = (args) => runWarden(dir, args, { sessions: 'lab', sessionId: 'session-lab-L22' });

  const init = run(['init']);
  /**
   * ⚠ **本用例依赖真子进程**（要跑真 CLI、真沙箱）。
   *   在 DSH 的受限沙箱里 `spawnSync` 带管道会 EPERM（本仓已知环境边界，见 common.mjs:150），
   *   这时 `runWarden` 返回 `{code:-1, error:true}`。
   *   **不许把它写成 FAIL**（那是假失败、会误导下一轮"已修"的证据），也**不许写成 PASS**；
   *   如实报 SKIP 并说明原因。无沙箱限制的环境里它必须真跑（判据下面 10 条）。
   */
  if (init.code === -1 && init.error) {
    c.skip('整个 L22 用例（需要真子进程）', '本沙箱禁止子进程用管道捕获 stdio ⇒ spawnSync EPERM，' +
      `warden init 拿不到输出：${String(init.stderr || '').slice(0, 160)}。` +
      '请在没有该限制的环境里跑：cd experiments/lab && node run-all.mjs --only L22');
    return {
      id: c.id, name: c.name, status: 'SKIP', pass: false,
      reason: '环境阻塞：本沙箱跑不了子进程（EPERM），不是逻辑失败。',
      checks: c.checks, skipped: c.skipped,
    };
  }
  c.check('前置 · init 成功', init.code === 0, `code=${init.code}`);
  writeUtf8(path.join(dir, '.warden', 'SPEC.md'), SPEC);
  writeUtf8(path.join(dir, '.warden', 'params.yml'), PARAMS);
  writeUtf8(path.join(dir, '.warden', 'config.json'), JSON.stringify({ projectRoot: dir, quoteWorkspaces: [dir] }, null, 2));

  const done = run(['record', '--req', 'R1', '--status', 'done', '--delivered', '先做一轮', '--evidence', '夹具', '--why', '让闸有东西可拦']);
  c.check('前置 · 记一轮 done', done.code === 0, `code=${done.code}`);

  // 备份闸在前：没备份时任何 record 都会被拦（这条也顺带验了）
  const noSnap = run(['record', '--req', 'R1', '--status', 'in_progress', '--why', '没备份', '--plan', '资料员： 查了代码；方向员： 影响面清楚了']);
  c.check('前置 · 没备份时先拦（备份闸在规划闸之前）', noSnap.code === 2, `code=${noSnap.code}`);

  const snap = run(['snapshot', '--label', '改 R1 之前']);
  c.check('前置 · snapshot 成功', snap.code === 0, `code=${snap.code}`);

  // ---------- 负控 ① 只念角色名
  const n1 = run(['record', '--req', 'R1', '--status', 'in_progress', '--why', '空壳', '--plan', '资料员：方向员：']);
  c.check('负控① 只念角色名 → 拒收', n1.code === 2, `code=${n1.code}｜${(n1.stdout || '').split('\n')[0]}`);

  // ---------- 负控 ② 冒号后只有空白
  const n2 = run(['record', '--req', 'R1', '--status', 'in_progress', '--why', '空壳2', '--plan', '资料员：  方向员：  ']);
  c.check('负控② 冒号后只有空白 → 拒收', n2.code === 2, `code=${n2.code}`);

  // ---------- 负控 ③ 只有一个角色
  const n3 = run(['record', '--req', 'R1', '--status', 'in_progress', '--why', '缺一个', '--plan', '资料员： 查了 warden.mjs 的 reopenGate，结论是最小长度 6 够用']);
  c.check('负控③ 只写一个角色的规划 → 拒收', n3.code === 2, `code=${n3.code}｜${(n3.stdout || '').split('\n')[0]}`);

  // ---------- 正控 ④ 自然写法（冒号后带空格）——**这就是原来被误伤的那条**
  const p1 = run(['record', '--req', 'R1', '--status', 'in_progress', '--why', '正控',
    '--plan', '资料员： 查了 warden.mjs 的 reopenGate，结论是最小长度 6 够用；方向员： 影响面是本账 22 条需求，优先级建议先做渲染端']);
  c.check('正控④ 冒号后带空格的自然写法 → 收下（原来会被误伤）', p1.code === 0, `code=${p1.code}｜${(p1.stdout || '').split('\n').slice(-2).join(' / ')}`);

  // ---------- 正控 ⑤ 用发现台账交规划（另一条合法路径）
  const dir2 = path.join(os.tmpdir(), 'L22_plan_gate_b');
  fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.mkdirSync(path.join(dir2, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir2, '.git'), { recursive: true });
  writeUtf8(path.join(dir2, 'src', 'demo.rs'), 'pub const DEMO_CONST: f32 = 1.30;\n');
  const run2 = (args) => runWarden(dir2, args, { sessions: 'lab', sessionId: 'session-lab-L22b' });
  run2(['init']);
  writeUtf8(path.join(dir2, '.warden', 'SPEC.md'), SPEC);
  writeUtf8(path.join(dir2, '.warden', 'params.yml'), PARAMS);
  writeUtf8(path.join(dir2, '.warden', 'config.json'), JSON.stringify({ projectRoot: dir2, quoteWorkspaces: [dir2] }, null, 2));
  run2(['record', '--req', 'R1', '--status', 'done', '--delivered', '先做一轮', '--evidence', '夹具', '--why', '让闸有东西可拦']);
  run2(['snapshot', '--label', '改 R1 之前']);
  const f1 = run2(['find', 'add', '--by', '资料员', '--text', '查了 reopenGate 的最小长度判据，6 个非空白字符够用', '--source', 'warden.mjs reopenGate', '--ref', 'R1']);
  const f2 = run2(['find', 'add', '--by', '方向员', '--text', '影响面是本账 22 条需求，优先级建议先做渲染端', '--why', '指回用户原话 R15', '--ref', 'R1']);
  c.check('前置 · 两条发现入台账', f1.code === 0 && f2.code === 0, `f1=${f1.code} f2=${f2.code}`);
  const p2 = run2(['record', '--req', 'R1', '--status', 'in_progress', '--why', '靠台账交规划']);
  c.check('正控⑤ 用发现台账交规划 → 收下', p2.code === 0, `code=${p2.code}｜${(p2.stdout || '').split('\n').slice(-2).join(' / ')}`);

  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch (e) { /* 清不掉就算了 */ }
  try { fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch (e) { /* 清不掉就算了 */ }

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '空壳规划（只念角色名 / 冒号后空白 / 只写一个角色）一律拒收；冒号后带空格的自然写法与「发现台账」这条路都能正常过闸 —— 既不糊弄也不误伤。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
