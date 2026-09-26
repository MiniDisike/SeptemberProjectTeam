#!/usr/bin/env node
/**
 * L25 · 两份拷贝同步（**纯函数**版）—— 本沙箱里**真能跑**，不需要子进程
 *
 * 回归来源：事故 **I51**（2026-09-17 实测，`.warden/INCIDENTS.jsonl` 里可核）：
 *   `task-warden` 的代码有**两份拷贝**，必须内容一致 ——
 *     · skill 份 `<HOME>\.dsh\skills\task-warden\`（**DSH 真正加载的那份**）
 *     · repo  份 `<WORKSPACE>\task-warden\`（工程仓库那份）
 *   那天**分叉**了：skill 份 311245 B / 19:18，repo 份 302091 B / **停在 16:11**（旧代码）。
 *   而实验台 `experiments/lab/common.mjs` 的 `WARDEN` 常量指向 **repo 份**
 *   ⇒ 那一轮 lab 跑出来的所有 PASS/FAIL 测的都是**旧代码**，结论不可信。
 *
 * 为什么这个用例不 spawn 子进程：本沙箱禁止用管道捕获子进程 stdio（EPERM），
 *   真去 spawn 会让用例变成**假失败**（失败原因与它要守的东西无关）。
 *   这里只需要"读文件算哈希"，所以直接用 `node:fs` + `crypto.createHash('sha256')`。
 *
 * 判据（全部机械，每条一个 `c.check`）：
 *   ① 两份 `warden.mjs` 都存在（缺哪份要报出来）；
 *   ② 两份 sha256 **相同**（不同就报两边大小 + 哈希前 16 位，一眼看出分叉）；
 *   ③ 两份行数相同（分叉时行数通常也不同，第二重保险）；
 *   ④ `common.mjs` 的 `WARDEN` 常量**确实指向 repo 份**（防"以后有人把 lab 指到别处、又测了旧代码"）；
 *   ⑤ 对 `selftest.mjs` 做同样的 ①②③；
 *   ⑥ `common.mjs` 的 `SELFTEST` 常量也指向 repo 份（同一条道理，顺手一起守）。
 *   ★ ①②③ 现在对 **PAIRS 里每一份**都跑（2026-09-24 起是 **10 份**）：
 *     `warden.mjs` / `selftest.mjs` / `patch-pipeline.mjs` / `L37_patch_pipeline.mjs` /
 *     `L38_majority_gate.mjs` / **`run-all.mjs`** / **`L39~L42` 那 4 个用例**。
 *     后几份是**用例 / 套件入口**也各有一份拷贝 ⇒ 它们分叉时，跑绿的那一份可能不是
 *     DSH 加载的那一份（I51 的形状）；`run-all.mjs` 分叉时更重 —— 连"哪 42 个在册"都会各说各话。
 *
 * ⚠ 两份真不同时，这个用例**就该 FAIL** —— 不许为了让用例变绿去改任何一份 `warden.mjs`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeCtx } from './common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 实验台在 <repo>\experiments\lab ⇒ 往上两层就是 repo 根
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SKILL_ROOT = path.join(DSH_HOME, 'skills', 'task-warden');

/** 两份拷贝必须一致的文件（同一份代码的两个落点） */
const PAIRS = [
  { file: 'warden.mjs', skill: path.join(SKILL_ROOT, 'warden.mjs'), repo: path.join(REPO_ROOT, 'warden.mjs') },
  { file: 'selftest.mjs', skill: path.join(SKILL_ROOT, 'selftest.mjs'), repo: path.join(REPO_ROOT, 'selftest.mjs') },
  // ★ 2026-09-24 扩（提问闸门查出，F1 的缺口）：`patch-pipeline.mjs`（R32 的机制）与它的用例
  //   `L37_patch_pipeline.mjs` **各有两份拷贝**，却**不在这个守卫里** ——
  //   形状就是 I51（lab 测了旧代码）：两份会分叉，而没有任何东西会报警。
  { file: 'patch-pipeline.mjs', skill: path.join(SKILL_ROOT, 'patch-pipeline.mjs'), repo: path.join(REPO_ROOT, 'patch-pipeline.mjs') },
  { file: 'L37_patch_pipeline.mjs', skill: path.join(SKILL_ROOT, 'experiments', 'lab', 'L37_patch_pipeline.mjs'), repo: path.join(REPO_ROOT, 'experiments', 'lab', 'L37_patch_pipeline.mjs') },
  // ★ 2026-09-24 再扩（「审查」在 P-M2b 复验里实测出这个缺口，P-M3 修）：
  //   `L38_majority_gate.mjs`（过半闸那条判据的用例）**同样有两份拷贝**，却不在守卫里 ——
  //   形状与上面 L37 那条一样：两份会分叉，而没有任何东西会报警。
  //   实测当时 PAIRS 只有 4 项（warden / selftest / patch-pipeline / L37），L38 不在其中。
  { file: 'L38_majority_gate.mjs', skill: path.join(SKILL_ROOT, 'experiments', 'lab', 'L38_majority_gate.mjs'), repo: path.join(REPO_ROOT, 'experiments', 'lab', 'L38_majority_gate.mjs') },
  // ★ 2026-09-24 再扩（P-M20 补，**这正是 P-M10 判 bad 的原因之一**）：
  //   `run-all.mjs`（**套件自己的入口**）明明有**两份拷贝**，却**不在守卫里** ——
  //   形状与上面几条一样：两份会分叉，而没有任何东西会报警。
  //   ⚠ 后果比别的更重：run-all 分叉时，"哪 42 个用例在册 / 空壳怎么算"这一层会**各说各话**。
  { file: 'run-all.mjs', skill: path.join(SKILL_ROOT, 'experiments', 'lab', 'run-all.mjs'), repo: path.join(REPO_ROOT, 'experiments', 'lab', 'run-all.mjs') },
  // ★ 2026-09-24 再扩（P-M20）：`L39~L42` 这 4 个用例**也各有一份拷贝**（repo 份 + 装机份），
  //   而它们刚被登记进 `run-all` 的 MODULES ⇒ 分叉时"跑绿的那一份"可能不是 DSH 加载的那一份（I51）。
  //   实测：装机 lab 里原先**根本没有**这 4 个文件（`run-all` 一登记就 `ERR_MODULE_NOT_FOUND`），
  //   是 P-M20 按"逐字节复制 repo 同名文件"补齐的 —— 补齐之后才谈得上"守"。
  { file: 'L39_autonomy_switch.mjs', skill: path.join(SKILL_ROOT, 'experiments', 'lab', 'L39_autonomy_switch.mjs'), repo: path.join(REPO_ROOT, 'experiments', 'lab', 'L39_autonomy_switch.mjs') },
  { file: 'L40_visible_speech.mjs', skill: path.join(SKILL_ROOT, 'experiments', 'lab', 'L40_visible_speech.mjs'), repo: path.join(REPO_ROOT, 'experiments', 'lab', 'L40_visible_speech.mjs') },
  { file: 'L41_pipe_round2.mjs', skill: path.join(SKILL_ROOT, 'experiments', 'lab', 'L41_pipe_round2.mjs'), repo: path.join(REPO_ROOT, 'experiments', 'lab', 'L41_pipe_round2.mjs') },
  { file: 'L42_window_scope.mjs', skill: path.join(SKILL_ROOT, 'experiments', 'lab', 'L42_window_scope.mjs'), repo: path.join(REPO_ROOT, 'experiments', 'lab', 'L42_window_scope.mjs') },
];

function statOf(p) {
  try {
    const st = fs.statSync(p);
    return { exists: true, bytes: st.size, mtime: st.mtime.toISOString().replace('T', ' ').slice(0, 19) };
  } catch {
    return { exists: false };
  }
}

/** 直接读文件算 sha256（**不 spawn**，绕开本沙箱的 stdio EPERM） */
function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 行数（把结尾换行算作"结束"而不是多出一行） */
function countLines(p) {
  const t = fs.readFileSync(p, 'utf8');
  const n = t.split(/\r?\n/).length;
  return t.endsWith('\n') ? n - 1 : n;
}

/** 从源码文本里抓 `export const NAME = '...'` 的字面量（原样，不做转义处理） */
function constLiteral(text, name) {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(['"\`])([\\s\\S]*?)\\1`);
  const m = re.exec(text);
  return m ? m[2] : null;
}

/** 路径规范化：`\\` 与 `/` 都当分隔符，去掉尾部分隔符，大小写不敏感（Windows） */
function normPath(v) {
  return String(v).replace(/\\\\/g, '\\').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export default async function run() {
  const c = makeCtx('L25', '两份拷贝同步：skill 份 ≡ repo 份，且 lab 指向 repo 份（纯函数）');

  // ---------- ①②③⑤ 两份 warden.mjs / selftest.mjs 必须逐字节一致
  for (const p of PAIRS) {
    const s = statOf(p.skill);
    const r = statOf(p.repo);
    const miss = [!s.exists ? `skill 份缺：${p.skill}` : null, !r.exists ? `repo 份缺：${p.repo}` : null].filter(Boolean);
    c.check(`① ${p.file} 两份拷贝都存在`,
      s.exists && r.exists,
      miss.length
        ? `缺 ${miss.length} 份 —— ${miss.join('；')}`
        : `skill=${s.bytes}B/${s.mtime}  repo=${r.bytes}B/${r.mtime}`);

    if (!s.exists || !r.exists) {
      c.check(`② ${p.file} 两份 sha256 相同`, false, '有一份不存在 ⇒ 判不了，按失败计（缺文件本身就是分叉）');
      c.check(`③ ${p.file} 两份行数相同`, false, '有一份不存在 ⇒ 判不了，按失败计');
      continue;
    }

    const hs = sha256(p.skill);
    const hr = sha256(p.repo);
    const sameHash = hs === hr;
    c.check(`② ${p.file} 两份 sha256 相同`,
      sameHash,
      sameHash
        ? `sha256=${hs.slice(0, 16)}…（两份一致）  ${s.bytes}B`
        : `★分叉★ skill ${s.bytes}B sha256=${hs.slice(0, 16)}… (${s.mtime})  ≠  repo ${r.bytes}B sha256=${hr.slice(0, 16)}… (${r.mtime})`);

    const ls = countLines(p.skill);
    const lr = countLines(p.repo);
    c.check(`③ ${p.file} 两份行数相同`,
      ls === lr,
      ls === lr ? `${ls} 行` : `★分叉★ skill ${ls} 行 ≠ repo ${lr} 行（差 ${Math.abs(ls - lr)} 行）`);
  }

  // ---------- ④⑥ common.mjs 的常量必须指向**DSH 真正加载的那份**（否则 lab 测的又是旧代码）
  //
  // ⚠ **2026-09-23 改约定**（本用例原来要求"指向 repo 份"，现在要求"指向 skill 份"）：
  //   起因：I51 —— repo 份曾经停在旧代码上，而 lab 指向 repo 份 ⇒ **那一轮所有 lab 结论都不可信**。
  //   新约定更硬：**lab 直接指向 skill 份**（`~/.dsh/skills/task-warden/`，DSH 实际加载的那份），
  //   于是"两份分叉"这件事**结构上不会再污染实验台**（分叉仍然要报 —— 见本用例的 ②③）。
  //   实现上也不再是字面量，而是 `path.join(SKILL_ROOT, 'warden.mjs')` ⇒ 正则抓不到，
  //   所以这里改成**直接 import common.mjs 比对解析值**（比解析源码字面量稳）。
  const commonPath = path.join(HERE, 'common.mjs');
  try {
    const common = await import('./common.mjs');
    for (const [constName, expectFile] of [['WARDEN', 'warden.mjs'], ['SELFTEST', 'selftest.mjs']]) {
      const got = normPath(String(common[constName] ?? ''));
      const wantSkill = normPath(path.join(SKILL_ROOT, expectFile));
      const mark = constName === 'WARDEN' ? '④' : '⑥';
      if (!got) {
        c.check(`${mark} common.mjs 的 ${constName} 有值`, false, `import 到的 ${constName} 是空的 ⇒ 判不了，按失败计`);
        continue;
      }
      const pointsToSkill = got === wantSkill;
      const pointsToRepo = got === normPath(path.join(REPO_ROOT, expectFile));
      c.check(`${mark} common.mjs 的 ${constName} 指向 DSH 真正加载的 skill 份`,
        pointsToSkill,
        pointsToSkill
          ? `${common[constName]}  ✓（= skill 份）`
          : `★指错★ ${common[constName]}${pointsToRepo ? '（指向 repo 份 —— 旧约定，分叉时会测到旧代码）' : '（既不是 skill 份也不是 repo 份）'}，应为 ${path.join(SKILL_ROOT, expectFile)}`);
    }
  } catch (e) {
    c.check('④ common.mjs 可 import', false, `import ${commonPath} 失败：${String(e.message).slice(0, 120)}`);
  }

  const ok = c.checks.every((x) => x.ok);
  const bad = c.checks.filter((x) => !x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? `两份拷贝（${PAIRS.map((p) => p.file).join(' / ')}）实读为逐字节一致（sha256 + 行数双重核对），且 common.mjs 的 WARDEN / SELFTEST 常量确实指向 DSH 真正加载的 skill 份 —— lab 测的就是那份代码。`
      : `有 ${bad.length} 项未通过：${bad.map((x) => x.name).join('；')}（两份真不同就该 FAIL，不许改 warden.mjs 去凑绿）`,
    checks: c.checks,
    skipped: c.skipped,
  };
}
