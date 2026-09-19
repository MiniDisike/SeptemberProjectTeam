#!/usr/bin/env node
/**
 * L17 · 没有工程的地方跑 `init`，不许**静默**把骨架建到祖先的账本里
 *
 * 回归来源（2026-09-16 由「审查」实测坐实，记在 skill 账本的机制洞清单里）：
 *   在一个**既没有 `.git`、也没有 `.warden`** 的目录里跑 `init`
 *   → 它在**祖先的 `.warden`** 里建骨架、**本地什么都没建**、**exit 0、零提示**；
 *   随后裸跑 `warden.mjs` 会打出**隔壁项目的欠账表**（R14/R19/R27…）。
 *
 *   用户描述这个现象为两个项目读到了对方的守则—— 这就是那条路。
 *   ⚠ 关键不是"落到祖先"这件事本身（从子目录跑命令时那条退路是**有用的**），
 *     而是它**不报错、零提示**：你以为在给 A 建账，其实动的是 B 的账本，而且没有任何反馈。
 *
 * 判据（黑盒）：
 *   负控 无 `.git` / 无 `.warden` 的目录里 `init` → **exit 2**，**不许**在祖先账本里建东西
 *   正控 显式 `--allow-ancestor` → 放行（"我就是要给上层那个工程补东西"是合法需求）
 *   正控 有 `.git` 的目录里 `init` → 照旧 exit 0，骨架**建在本地**（这条是主路，不许被误伤）
 *   说明 其他命令走那条退路时要**出声**（不许静默读到别人的账本）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LAB_ROOT, WARDEN, writeUtf8, readUtf8, sha256File, makeCtx, grab } from './common.mjs';

const runIn = (cwd, args) => {
  const r = spawnSync(process.execPath, [WARDEN, ...args], {
    cwd, env: { ...process.env, DSH_SESSIONS_DIR: path.join(LAB_ROOT, '_sessions') },
    encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

/** 造一个"祖先装着 .warden、自己什么都没有"的目录（**故意不给 .git**） */
function makeNested(name) {
  const base = path.join(LAB_ROOT, name);
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  const parent = path.join(base, 'parent');
  const nowhere = path.join(parent, 'nowhere');
  fs.mkdirSync(nowhere, { recursive: true });
  // 祖先那一层装着一个**属于它自己**的 .warden（config 自报 projectRoot = parent）
  writeUtf8(path.join(parent, '.warden', 'config.json'), JSON.stringify({ projectRoot: parent, quoteWorkspaces: [parent] }, null, 2));
  writeUtf8(path.join(parent, '.warden', 'SPEC.md'), '# 需求锁定表（append-only）\n\n## R14 · 隔壁工程的需求\n- 原话: 隔壁工程的用户原话，用来验证"读到别人的账本"\n- 出处: session:x#1\n- 锁定: 2026-09-16\n');
  writeUtf8(path.join(parent, '.warden', 'ROUNDS.jsonl'), JSON.stringify({ round: 1, requirement: 'R14', status: 'done', delivered: '隔壁工程的账', evidence: 'x', why: '', at: '2026-09-16T00:00:00.000Z', values: {} }) + '\n');
  return { base, parent, nowhere };
}

export default async function run() {
  const c = makeCtx('L17', '没工程的地方 init：不许静默建到祖先账本里');
  const { base, parent, nowhere } = makeNested('L17_ancestor_init');

  const parentSpec = path.join(parent, '.warden', 'SPEC.md');
  const parentRounds = path.join(parent, '.warden', 'ROUNDS.jsonl');
  const before = { spec: sha256File(parentSpec), rounds: sha256File(parentRounds), nRounds: readUtf8(parentRounds).split(/\r?\n/).filter((l) => l.trim()).length };

  // ---------- 负控：无 .git / 无 .warden 的目录里 init → 必须拒收
  const initOut = runIn(nowhere, ['init']);
  const after = { spec: sha256File(parentSpec), rounds: sha256File(parentRounds), nRounds: readUtf8(parentRounds).split(/\r?\n/).filter((l) => l.trim()).length };
  const localWarden = fs.existsSync(path.join(nowhere, '.warden'));

  c.check('负控 · 无 .git / 无 .warden 的目录里 `init` → **exit 2**（原来 exit 0、零提示）',
    initOut.code === 2,
    `exit=${initOut.code}；${grab(initOut.out, [/拒绝操作/], 1).join('')}`);
  c.check('负控 · **祖先的账本一个字节都没动**（SPEC / ROUNDS 哈希与轮数全等）',
    before.spec === after.spec && before.rounds === after.rounds && before.nRounds === after.nRounds,
    `SPEC ${before.spec.slice(0, 8)}→${after.spec.slice(0, 8)}；ROUNDS ${before.rounds.slice(0, 8)}→${after.rounds.slice(0, 8)}；轮数 ${before.nRounds}→${after.nRounds}`);
  c.check('负控 · **本地也没建**（不许"两边都不对"）', !localWarden, `nowhere/.warden 存在=${localWarden}`);
  c.check('说明 · 打印里说清了"你要动的不是这个目录的账本"并给出三条出路',
    /你要动的不是这个目录的账本/.test(initOut.out) && /git init/.test(initOut.out) && /--allow-ancestor/.test(initOut.out),
    grab(initOut.out, [/三条出路|1\)|2\)|3\)/], 3).join(' | '));

  // ---------- 正控①：显式 --allow-ancestor → 放行（不许把合法需求也焊死）
  const allowOut = runIn(nowhere, ['init', '--allow-ancestor']);
  c.check('正控 · 显式 `--allow-ancestor` → 放行（"给上层那个工程补东西"是合法需求，不许焊死）',
    allowOut.code === 0,
    `exit=${allowOut.code}；${grab(allowOut.out, [/骨架在/], 1).join('')}`);

  // ---------- 正控②：有 .git 的目录 → 照旧 exit 0，骨架建在**本地**
  const withGit = path.join(base, 'realproj');
  fs.mkdirSync(path.join(withGit, '.git'), { recursive: true });
  const gitOut = runIn(withGit, ['init']);
  c.check('正控 · 有 `.git` 的目录里 `init` → exit 0，且骨架建在**本地**（主路不许被误伤）',
    gitOut.code === 0 && fs.existsSync(path.join(withGit, '.warden', 'SPEC.md')),
    `exit=${gitOut.code}；本地 .warden/SPEC.md 存在=${fs.existsSync(path.join(withGit, '.warden', 'SPEC.md'))}`);

  // ---------- 说明：其他命令**也**必须被拒收（原来它们会静默读到上层的账本）
  const checkOut = runIn(nowhere, ['check']);
  c.check('负控 · 其他命令（`check`）**同样拒收** —— "静默读到别人的账本"就是本次事故本身，不是只有 init 有害',
    checkOut.code === 2 && /你要动的不是这个目录的账本/.test(checkOut.out),
    `exit=${checkOut.code}；${grab(checkOut.out, [/拒绝操作/], 1).join('')}`);
  const checkAllowed = runIn(nowhere, ['check', '--allow-ancestor']);
  c.check('说明 · 显式 `--allow-ancestor` 时读命令能跑，并且**出声**说账本是从上层借来的',
    /账本是从\*\*上层\*\*借来的|账本是从.*上层.*借来的/.test(checkAllowed.out),
    `exit=${checkAllowed.code}；${grab(checkAllowed.out, [/借来的/], 1).join('') || '（没出声）'}`);

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '没工程的地方 init 被拒收、祖先账本一个字节没动、本地也没建；--allow-ancestor 与有 .git 的主路都照旧通。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
