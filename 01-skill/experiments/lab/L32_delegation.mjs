#!/usr/bin/env node
/**
 * L32 · **主代理有没有自己扛全部编码**（R19 的机械落点）
 *
 * 用户逐字：「（用户原话已隐去 —— 公开版不留逐字）」
 *   「不要: 所有代码都由主代理一个人顺序写。」
 *
 * 为什么要这条：审查第二遍实测指出 —— R19 标了 done，但"L25 是真派单、**L26/L27/L28 又是主代理自己写的**"，
 *   而当时**没有任何机械判据**能看出这件事。⇒ 新增 `warden.mjs delegation [会话id]`：
 *   数会话里主代理自己 `write`/`edit` 了几个文件、派了几次 `subagent*`。
 *
 * 判据（机械）：
 *   ① 有写、**一次单都没派** ⇒ `soloWriter === true`（这正是用户说的"一个干活的累死"）；
 *   ② 正控：有写也有派单 ⇒ `soloWriter === false`（不许把"派过"当"没派"）；
 *   ③ 没写 ⇒ 不判（`soloWriter === false`）—— 只读会话不该被扣帽子；
 *   ④ 文件计数要按**路径去重并计数**（同一文件改 3 次是 1 个文件、3 次）；
 *   ⑤ 事件为空 ⇒ 全 0（**"0 条"不许当成"没自己写"**；CLI 侧对此是 exit 2 拒收，不是"通过"）。
 *
 * 全部是纯函数（`delegationStats(events)`），**不 spawn 子进程、不写任何文件**。
 */
import { makeCtx } from './common.mjs';

const WARDEN = 'file:///<HOME>/.dsh/skills/task-warden/warden.mjs';

const call = (name, args) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args || {}) } });

export default async function run() {
  const c = makeCtx('L32', '主代理有没有自己扛全部编码（R19）');

  const mod = await import(WARDEN);
  const { delegationStats } = mod;
  c.check('前置 · delegationStats 是导出的（判据不许只活在 CLI 打印里）',
    typeof delegationStats === 'function', typeof delegationStats);

  // ① 一个人顺序写
  const solo = delegationStats([
    call('write', { file_path: 'D:\\a\\one.mjs' }),
    call('edit', { file_path: 'D:\\a\\one.mjs' }),
    call('edit', { file_path: 'D:\\a\\two.mjs' }),
  ]);
  c.check('① 有写、一次单都没派 ⇒ soloWriter = true', solo.soloWriter === true,
    `writes=${solo.writes} dispatches=${solo.dispatches.length}`);

  // ② 正控：有写也有派单
  const withSub = delegationStats([
    call('write', { file_path: 'D:\\a\\one.mjs' }),
    call('subagent', { description: 'Write the test' }),
  ]);
  c.check('② 正控 · 有写也有派单 ⇒ soloWriter = false', withSub.soloWriter === false,
    `writes=${withSub.writes} dispatches=${withSub.dispatches.length}`);

  // ③ 没写 ⇒ 不判
  const reader = delegationStats([call('read', { file_path: 'D:\\a\\one.mjs' })]);
  c.check('③ 没写（只读会话）⇒ 不判', reader.soloWriter === false && reader.writes === 0,
    `writes=${reader.writes}`);

  // ④ 路径去重 + 计数
  const same = delegationStats([
    call('edit', { file_path: 'D:\\a\\one.mjs' }),
    call('edit', { file_path: 'D:\\a\\one.mjs' }),
    call('edit', { file_path: 'D:\\a\\one.mjs' }),
  ]);
  c.check('④ 同一文件改 3 次 = 1 个文件 / 3 次',
    same.writes === 3 && same.files.length === 1 && same.files[0].n === 3,
    JSON.stringify(same.files));

  // ⑤ 空事件
  const empty = delegationStats([]);
  c.check('⑤ 事件为空 ⇒ 全 0（"0 条"不许当成"没自己写"）',
    empty.writes === 0 && empty.files.length === 0 && empty.dispatches.length === 0 && empty.soloWriter === false,
    JSON.stringify({ writes: empty.writes, solo: empty.soloWriter }));

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? 'R19 的判据可机检了：有写却一次单都没派会被标出来；派过、只读、空事件三种都不误伤；文件按路径去重计数。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
