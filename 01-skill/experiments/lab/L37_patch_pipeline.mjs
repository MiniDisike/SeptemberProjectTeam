#!/usr/bin/env node
/**
 * L37 · 「复制 → 改 → 角色检查 → 替换」这条直线**不许遗留任何一步**（R32）
 *
 * 用户逐字（2026-09-24）：「（用户原话已隐去 —— 公开版不留逐字）」
 *
 * 本用例**真的起子进程**跑 `patch-pipeline.mjs`（不是纯函数模拟）——
 * 因为这两个漏恰恰是"顺序/落盘"层面的，模拟不出来。
 * ⚠ 本会话实测：沙箱**不禁止**子进程管道捕获 stdio（`spawnSync` 带 `encoding` 可用）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeCtx, SKILL_ROOT } from './common.mjs';

/**
 * ★★ 2026-09-24 修（P-M10 起、P-M20 收）：原来这里**写死作者机路径**
 *   （`<某台机器>\.dsh\skills\task-warden\patch-pipeline.mjs`），
 *   而下面直接拿它做前置断言（`fs.existsSync(PIPELINE)`）且**没有任何回退**
 *   ⇒ 别人机器上（或 `DSH_HOME` 不同）这条用例**必 FAIL** —— 正是用户说的
 *     「换个电脑装了等于没装」的同一条命。
 *
 * 现在从 `common.mjs` 的 `SKILL_ROOT` 推导（**优先 `$DSH_HOME/skills/task-warden`**，
 * 也就是 DSH 真正加载的那份），并留 `WARDEN_PIPELINE` 覆盖：
 *   验收/改管线时：把 work 副本复制到别处 → `WARDEN_PIPELINE=<那份>` 跑本文件。
 *
 * ⚠ **本文件里不许再出现任何机器路径**（审查判据 7 卡的就是这个字面）——
 *   所以上面那句连"原来写死的那串"都**不照抄**，只说形状。
 */
const PIPELINE = process.env.WARDEN_PIPELINE || path.join(SKILL_ROOT, 'patch-pipeline.mjs');

/**
 * 整体检查命令（照 L41 的写法）：`apply` 现在**必须交代整体检查**，
 * `node -e "process.exit(0)"` 是一个**真的子进程 + 真的 exit code**（不是假装）。
 */
const OK_CMD = 'node -e "process.exit(0)"';

function run(root, args) {
  const r = spawnSync(process.execPath, [PIPELINE, ...args, '--root', root], { encoding: 'utf8' });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

export default async function run_() {
  const c = makeCtx('L37', '复制→改→角色检查→替换 不许遗留任何一步（R32）');

  c.check('前置 · patch-pipeline.mjs 在（为 0 不许报成功）', fs.existsSync(PIPELINE), PIPELINE);

  // 夹具
  const root = path.join(os.tmpdir(), 'l37-pipe-' + Date.now());
  fs.mkdirSync(path.join(root, '.warden'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'AAAA', 'utf8');
  fs.writeFileSync(path.join(root, 'b.txt'), 'BBBB', 'utf8');

  // ① 没 begin 就 verify ⇒ 拒
  const r1 = run(root, ['verify', '--id', 'P1', '--by', '审查', '--verdict', 'ok', '--evidence', 'x']);
  c.check('① 没 begin 就 verify ⇒ 拒（exit 2）', r1.code === 2, 'exit=' + r1.code + ' ' + r1.out.split('\n')[0]);

  // ② begin ⇒ 原件不许动
  const r2 = run(root, ['begin', '--id', 'P1', '--files', 'a.txt,b.txt']);
  const afterBegin = fs.readFileSync(path.join(root, 'a.txt'), 'utf8');
  c.check('② begin 成功且**原件一个字节没动**', r2.code === 0 && afterBegin === 'AAAA', 'exit=' + r2.code + ' a.txt=' + afterBegin);

  // ③ ★ 用户点名的第一个漏：复制了不检查，直接 apply ⇒ 拒
  const r3 = run(root, ['apply', '--id', 'P1']);
  c.check('★③ 复制了**不检查**直接 apply ⇒ 拒（第一个漏）',
    r3.code === 1 && /没有"角色检查通过"的记录/.test(r3.out),
    'exit=' + r3.code + ' ' + r3.out.split('\n')[0]);
  c.check('★③ 原件在"被拒的 apply"之后**仍未变**', fs.readFileSync(path.join(root, 'a.txt'), 'utf8') === 'AAAA', 'a.txt 未动');

  // ④ verify 不带角色名 ⇒ 拒（主代理自检不许冒充角色检查）
  const r4 = run(root, ['verify', '--id', 'P1', '--by', '主代理', '--verdict', 'ok', '--evidence', 'x']);
  c.check('④ verify 用非角色名 ⇒ 拒（不许自检冒充）', r4.code === 1, 'exit=' + r4.code + ' ' + r4.out.split('\n')[0]);

  // ⑤ verify ok 但没 evidence ⇒ 拒
  const r5 = run(root, ['verify', '--id', 'P1', '--by', '审查', '--verdict', 'ok']);
  c.check('⑤ verdict=ok 不带 --evidence ⇒ 拒', r5.code === 1, 'exit=' + r5.code + ' ' + r5.out.split('\n')[0]);

  // ⑥ 改副本 + 角色检查 ok
  const copyDir = path.join(root, '.warden', 'patches', 'P1');
  // ⚠ 2026-09-24 改：副本命名从 `replace(/[\\/]/g,'__')` 换成 `sha256(相对路径).slice(0,8)+'__'+basename`
  //   （方向员查出的命名碰撞 bug）⇒ 不能再按 'a.txt' 子串找，直接取 work/ 里唯一那个。
  const workDir = path.join(root, '.warden', 'patches', 'P1', 'work');
  const copyA = fs.readdirSync(workDir)[0];
  fs.writeFileSync(path.join(workDir, copyA), 'AAAA-CHANGED', 'utf8');
  const r6 = run(root, ['verify', '--id', 'P1', '--by', '审查', '--verdict', 'ok', '--evidence', 'diff: AAAA -> AAAA-CHANGED']);
  c.check('⑥ 角色检查通过（带原样输出）', r6.code === 0, 'exit=' + r6.code);

  // ⑦ ★ 用户点名的第二个漏：检查通过了却不 apply ⇒ status 必须报"卡住"
  const r7 = run(root, ['status']);
  c.check('★⑦ 检查通过但**没替换** ⇒ status 报卡住 + exit 1（第二个漏）',
    r7.code === 1 && /没替换 = 等于没做/.test(r7.out),
    'exit=' + r7.code);
  c.check('★⑦ 这时原件**仍未变**（检查≠替换）',
    fs.readFileSync(path.join(root, 'a.txt'), 'utf8') === 'AAAA', 'a.txt 仍是 AAAA');

  // ⑧ apply ⇒ 原件真的变了
  //   ⚠ 2026-09-24 修（P-M20）：新版管线（P-M6 已 apply）把"**没跑也没声明整体检查**"
  //     从 exit 0 改成 **exit 1** ⇒ 这一行原来裸 `apply` 会让 ⑧/⑨ 两条**红得没道理**。
  //     判据**不放宽**（照样断言 exit 0），只是**照 L41 的写法**把整体检查补上（真起子进程真跑）。
  const r8 = run(root, ['apply', '--id', 'P1', '--verify-cmd', OK_CMD]);
  const afterApply = fs.readFileSync(path.join(root, 'a.txt'), 'utf8');
  c.check('⑧ apply 之后**原件真的变了**', r8.code === 0 && afterApply === 'AAAA-CHANGED', 'a.txt=' + afterApply);
  c.check('⑧ apply 会报出**哪些文件没变**（改了个寂寞要能看见）', /没变/.test(r8.out), '报告里含"没变"标记');

  // ⑨ status 收尾：没有卡住的
  const r9 = run(root, ['status']);
  c.check('⑨ 全部走完 ⇒ status exit 0（没有卡住的）', r9.code === 0, 'exit=' + r9.code);

  // ⑩ 负控：重复 begin 同一 id ⇒ 拒（不许覆盖）
  const r10 = run(root, ['begin', '--id', 'P1', '--files', 'a.txt']);
  c.check('⑩ 重复 begin 同一 id ⇒ 拒（不许覆盖）', r10.code === 1, 'exit=' + r10.code);

  /**
   * ⑪ ★ **第三种漏：不复制、直接在原件上改**（主代理 2026-09-24 自查发现的绕过路径）
   *    实测过：`begin` 之后**不用管线、直接手工覆盖原件** ⇒ 原来的管线**不知道**，
   *    只报"复制了没检查"—— 原件已经被改了，账本上却还写着"原件没动"。
   *    补法：`stateOf` 每次核对原件真实指纹 vs `begin` 时记的 `shaBefore`。
   */
  fs.writeFileSync(path.join(root, 'c.txt'), 'ORIG-C', 'utf8');
  run(root, ['begin', '--id', 'P2', '--files', 'c.txt']);
  fs.writeFileSync(path.join(root, 'c.txt'), 'HAND-EDITED', 'utf8');   // 绕过管线直接改原件
  const r11 = run(root, ['apply', '--id', 'P2']);
  c.check('★⑪ 绕过管线直接改原件 ⇒ apply 必须拒（第三种漏）',
    r11.code === 1 && /绕过管线/.test(r11.out),
    'exit=' + r11.code + ' ' + r11.out.split('\n')[0]);
  const r12 = run(root, ['status']);
  c.check('★⑪ status 必须把"绕过管线"显式列出来',
    /绕过管线/.test(r12.out) && r12.code === 1,
    'status exit=' + r12.code);

  fs.rmSync(root, { recursive: true, force: true });

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '直线四步全部机检：复制有记录、改只在副本、角色署名检查、无检查不许替换；两个点名漏（不检查 / 不替换）都被拦住并报出来。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
