#!/usr/bin/env node
/**
 * L41 · patch-pipeline 第三轮（P-M6）的**全部修复**搬成**永久回归用例**
 *
 * 为什么有这个文件（**审查判 reject 的硬失败2**，原样输出）：
 *   `L37 关键词命中：chain=0 rechain=0 重算=0 pair=0 with-dir=0 self=0 prev=0 origAlso=0 撞车=0 基线过期=0`
 *   —— P-M6 那一轮改的 16 处**只活在 `%TEMP%` 的一次性脚本里**，违反本工程
 *      「**每一条"已修"都必须能重复跑**」。所以这里把它们逐条搬成用例：**真跑子进程**（不是模拟）、
 *      **正负控成对**（每条判据都要有一条"不满足就必须红"的对照）。
 *
 * ⚠ **不许硬编码作者机路径**：被测管线取自 `common.mjs` 推导出的 `SKILL_ROOT`
 *   （`$DSH_HOME/skills/task-warden/patch-pipeline.mjs`），可用 `WARDEN_PIPELINE` 覆盖
 *   —— 本轮的验收就是这么跑的：把 work 副本复制到 `%TEMP%` 再 `WARDEN_PIPELINE=<那份>` 跑本文件。
 *
 * 覆盖（对照交接单逐条点名）：
 *   · `--pair`：`|` 与 `:`、含盘符的右值、尾随空格、左值没匹配（含"你是不是想写 X"）、目标查重、
 *     第二份被删；左值匹配的 **Windows 大小写 / 8.3 短名**（新行为②）
 *   · `--with-dir`：工程根真能 import 兄弟（+ 负控：不加就 ERR_MODULE_NOT_FOUND）
 *   · 混根警告（+ 负控）· `rolledback` 不豁免（D6）· 四类拒绝原因（基线过期 / pair-missing / bypass / 半替换）
 *   · 事务预检（只读目标 ⇒ 零替换）· 逐条进度**可续做**（真 kill 打断 apply）· 孤儿行 · 改了个寂寞 exit 1
 *   · **rollback 两边一起回且不假绿**（硬失败3）· **K2c**（半替换 + rollback 之后 partial 必须清零）
 *   · `[撞车]` · 三处绿灯改红（D8 ①②③）+ 正控 · 链校验（含**老账本兼容** ⑰）· **替换后复核**（硬失败1）
 *
 * ★★ **第四轮（P-M6 第二次返工）新增的覆盖**（审查判 reject 的两条新洞 + 一条 widening，全部**零覆盖→有覆盖**）：
 *   · **G11⑦ 洞1（假绿）**：`apply --verify-cmd "node fail.mjs"`（exit 7）之后跑一条**更弱的复核**
 *     `postcheck --id X`（**不带 `--cmd`**）⇒ **不许** exit 0、**不许**打「复核通过」、
 *     `status` **不许**变绿（原来那条失败记录被盖掉、而失败的命令从未重跑）。
 *   · **G11⑧ 洞1b**：`apply` **不带 `--verify-cmd`** ⇒ 原来 exit 0 + status 0「已完成（整体检查没跑过）」
 *     ⇒ 现在 **exit 1** + `status` 红（`整体检查从没跑过、也没声明`）；
 *     正控：`--no-overall-check --why "<≥20 字>"` 显式豁免 ⇒ exit 0 + status 绿（理由进账本）；
 *     负控：`--why` 太短 ⇒ 拒。
 *   · **G14 洞2（假红）**：真 kill 半替换 → pair 设只读 → rollback 写盘失败 → 修好权限 → **apply 续做成功**
 *     ⇒ `status` 必须 **exit 0**（真交付不许被"rollback 中途失败"永久判死）；
 *     同形第二路：**rollback 预检失败**（老账本没 `origAlso`）+ 后来 apply 成功 ⇒ 同样必须绿。
 *   · **G15 洞3（⑰ 的 widening）**：把**整本账本**每行的 `self`/`prev` 删掉 + 追加一行**无 self 的假 verify ok**
 *     ⇒ 原来整本被认成 legacy ⇒ apply exit 0、**原件被替换**；现在**必须拒**（老格式行不许带上链后字段）；
 *     **§4②（链开始后追加无 self）照旧拒**；老账本正控（G12②）也还在。
 *   · **G13 洞4（normKey 误合并）**：大小写**敏感**目录里 `A.txt` 与 `a.txt` 是两个文件 ⇒
 *     `begin --files cs/A.txt,cs/a.txt` **不许**报"同一个文件写了两遍"；负控：大小写**不敏感**目录里照旧拒。
 *   · **G5⑩ D16**：角色名单从 `ROLE_REGISTRY` 派生 ⇒ **无票的 `AI测试用户`** 也能 `verify --by`（原来被静默排除）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { makeCtx, SKILL_ROOT } from './common.mjs';

/** ★ 不写死作者机路径：默认 = common.mjs 认定的那份安装（$DSH_HOME/skills/task-warden） */
const PIPELINE = process.env.WARDEN_PIPELINE || path.join(SKILL_ROOT, 'patch-pipeline.mjs');

const shaText = (s) => crypto.createHash('sha256').update(Buffer.from(String(s), 'utf8')).digest('hex').slice(0, 16);
const nowIso = () => new Date().toISOString();
const EV = '原样输出：跑过 diff / node --check，逐条核对（这条字符串要够 20 字）';

const SANDBOXES = [];
let SEQ = 0;
function mk(tag) {
  const root = path.join(os.tmpdir(), `l41-${tag}-${process.pid}-${SEQ++}`);
  fs.mkdirSync(path.join(root, '.warden'), { recursive: true });
  SANDBOXES.push(root);
  return root;
}
function run(root, args, opts = {}) {
  const r = spawnSync(process.execPath, [PIPELINE, ...args, '--root', root], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, ...opts,
  });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}
const ledgerPath = (root) => path.join(root, '.warden', 'PATCHES.jsonl');
function rows(root) {
  if (!fs.existsSync(ledgerPath(root))) return [];
  return fs.readFileSync(ledgerPath(root), 'utf8').split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
const stepsOf = (root) => rows(root).map((r) => r.step);
const workDirOf = (root, id) => path.join(root, '.warden', 'patches', id, 'work');
/** 副本文件名是 `sha256(相对路径).slice(0,8)__basename` ⇒ work/ 里取唯一那个（或按后缀找） */
function copyOf(root, id, suffix) {
  const list = fs.readdirSync(workDirOf(root, id)).filter((n) => fs.statSync(path.join(workDirOf(root, id), n)).isFile());
  if (suffix) { const hit = list.find((n) => n.endsWith('__' + suffix)); if (hit) return path.join(workDirOf(root, id), hit); }
  return path.join(workDirOf(root, id), list[0]);
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const write = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text, 'utf8');

/** 按**管线自己的链格式**往账本追加一行（造夹具用；与 `chainHash`/`append` 逐字同构） */
function appendRow(root, rec) {
  const all = rows(root);
  const prev = all.length ? (all[all.length - 1].self || '') : '';
  const withPrev = { ...rec, prev };
  withPrev.self = crypto.createHash('sha256').update(JSON.stringify(withPrev)).digest('hex').slice(0, 16);
  fs.appendFileSync(ledgerPath(root), JSON.stringify(withPrev) + '\n', 'utf8');
}
/** 改过夹具行之后**重算整本链**（与 `chainHash`/`append` 逐字同构：`self = sha256(去掉 self 的整行，含 prev)`) */
function rechain(root) {
  let prev = '';
  const out = rows(root).map((r) => {
    const { self, ...rest } = r;   // eslint-disable-line no-unused-vars
    const w = { ...rest, prev };
    w.self = crypto.createHash('sha256').update(JSON.stringify(w)).digest('hex').slice(0, 16);
    prev = w.self;
    return JSON.stringify(w);
  });
  fs.writeFileSync(ledgerPath(root), out.join('\n') + '\n', 'utf8');
}
/**
 * ★★ **第四轮**：这一版 `apply` **必须交代"整体检查"**（`--verify-cmd` 或显式豁免），
 *   否则 **exit 1**（洞1b 的执法点）。夹具里给它一条**真跑得起来的**检查命令 ——
 *   `node -e "process.exit(0)"` 是一个**真的子进程 + 真的 exit code**（不是假装）。
 */
const OK_CMD = 'node -e "process.exit(0)"';
const applyOk = (root, id, extra = []) => run(root, ['apply', '--id', id, '--verify-cmd', OK_CMD, ...extra]);
/**
 * 造一个**大小写敏感**的目录（`fsutil file setCaseSensitiveInfo`）——
 *   拿不到就返回 null（用例里**如实 skip**，不假装通过）。
 *   ⚠ 这条要管理员权限；本会话实测可用（exit 0）。
 */
function caseSensitiveDir(root, name) {
  const d = path.join(root, name);
  try {
    fs.mkdirSync(d, { recursive: true });
    const r = spawnSync('fsutil', ['file', 'setCaseSensitiveInfo', d, 'enable'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    fs.writeFileSync(path.join(d, 'A.txt'), 'UP', 'utf8');
    fs.writeFileSync(path.join(d, 'a.txt'), 'LOW', 'utf8');
    const ent = fs.readdirSync(d);
    // 验证"真的生效"：两个名字**能共存**且 `realpath` 给出**两串**
    if (ent.length !== 2) return null;
    const ra = fs.realpathSync.native(path.join(d, 'A.txt'));
    const rb = fs.realpathSync.native(path.join(d, 'a.txt'));
    return ra !== rb ? d : null;
  } catch (e) { return null; }
}
/** 把 `begin → 改副本 → verify ok` 三步走完（后面各个用例都从这里出发） */
function beginVerify(root, id, files, { pairs = [], change = (p, i) => 'CHANGED-' + i, extra = [] } = {}) {
  const argv = ['begin', '--id', id, '--files', files.join(',')];
  for (const pr of pairs) argv.push('--pair', pr);
  argv.push(...extra);
  const b = run(root, argv);
  if (b.code !== 0) return { begin: b, verify: null };
  const wd = workDirOf(root, id);
  const list = fs.readdirSync(wd).filter((n) => fs.statSync(path.join(wd, n)).isFile());
  list.forEach((n, i) => fs.writeFileSync(path.join(wd, n), String(change(n, i)), 'utf8'));
  const v = run(root, ['verify', '--id', id, '--by', '审查', '--verdict', 'ok', '--evidence', EV]);
  return { begin: b, verify: v };
}
/** 取一个路径的 8.3 短名（拿不到 ⇒ null，用例里如实 skip）
 *  ⚠ 实测：`cmd /c for %I in ("<带引号的路径>") do …` 在 `spawnSync`（无 shell）下会被 cmd 的引号解析弄坏，
 *    返回 `C:\"C:\…\"` 这种垃圾；**不加引号**反而正确（路径里有空格时判不了 ⇒ 如实 skip）。 */
function shortName(p) {
  if (process.platform !== 'win32') return null;
  if (/[\s"]/.test(p)) return null;
  const r = spawnSync('cmd', ['/c', `for %I in (${p}) do @echo %~sI`], { encoding: 'utf8' });
  const out = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  if (!out || /"/.test(out) || out.toLowerCase() === p.toLowerCase()) return null;
  return fs.existsSync(out) ? out : null;
}

/**
 * 真·中途打断一次 apply ⇒ 留下**真的半替换**（账本有进度、没有 applied）。
 * 为什么要 kill：D7 之后"写盘失败"已被**事务预检**在写之前全部挡住（只读/目录/缺失都在预检拒掉），
 * 唯一还能复现"替换到一半"的路径就是**进程被打断**（断电/kill）。实测 5/5 稳定：
 * 300 个文件时停在 1~2 个（一次 5 连跑全中）。所以宁可用**真打断**，也不用"手写账本"冒充。
 *
 * ⚠ 两个实测踩过的坑（都写在这里，免得下一个人重踩）：
 *   ① **同步忙等里 `child.exitCode` 不会更新**（'exit' 要事件循环派发）⇒ 轮询必须偶尔 `await` 让出；
 *      而进程**已经退出**时再 `child.once('exit')` 会**永远等不到** ⇒ 等之前先看 `exitCode`。
 *   ② kill 可能把**正在追加的最后一行**截断 ⇒ 账本尾部留半行 ⇒ 链看起来是断的（那不是被测行为）。
 *      ⇒ 夹具里把尾部半行截掉（真断电也会留这个形状），并**只截半行**，不修别的。
 */
function truncatePartialTail(root) {
  const lp = ledgerPath(root);
  if (!fs.existsSync(lp)) return false;
  const raw = fs.readFileSync(lp, 'utf8');
  const lines = raw.split(/\r?\n/);
  // 末尾通常是空串（以 \n 结束）；从后往前找第一个"非空却不完整"的行
  let cut = lines.length;
  while (cut > 0 && lines[cut - 1].trim() === '') cut--;
  if (cut > 0 && !lines[cut - 1].trim().endsWith('}')) {
    fs.writeFileSync(lp, lines.slice(0, cut - 1).join('\n') + (cut - 1 > 0 ? '\n' : ''), 'utf8');
    return true;
  }
  return false;
}
function onceExit(child) {
  return new Promise((res) => {
    if (child.exitCode !== null || child.signalCode !== null) return res();
    child.once('exit', res);
  });
}
async function interruptApply(root, id, { tries = 3, total = 120 } = {}) {
  const lp = ledgerPath(root);
  let last = { killed: false, rows: rows(root) };
  for (let k = 0; k < tries; k++) {
    const child = spawn(process.execPath, [PIPELINE, 'apply', '--id', id, '--root', root], { stdio: 'ignore' });
    const t0 = Date.now();
    let killed = false;
    let spins = 0;
    while (Date.now() - t0 < 20000) {
      let txt = '';
      try { txt = fs.readFileSync(lp, 'utf8'); } catch (e) { /* 账本还没建 */ }
      if (txt.includes('"step":"replaced"')) { child.kill(); killed = true; break; }
      if (child.exitCode !== null || child.signalCode !== null) break;
      // 每 20 次同步轮询让出一次事件循环（否则 'exit' 永远不会派发）
      spins++;
      // eslint-disable-next-line no-await-in-loop
      if (spins % 20 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    // eslint-disable-next-line no-await-in-loop
    await onceExit(child);
    truncatePartialTail(root);
    last = { killed, rows: rows(root) };
    const n = last.rows.filter((r) => r.step === 'replaced').length;
    const applied = last.rows.some((r) => r.step === 'applied');
    if (applied) return last;                       // 打断晚了 ⇒ 这轮已到终态，重试无意义
    if (killed && n > 0 && n < total) return last;  // 真正的半替换
  }
  return last;
}

export default async function run_() {
  const c = makeCtx('L41', 'patch-pipeline 第三轮全部修复的永久回归用例（P-M6）');
  c.check('前置 · 被测管线在（A6：输入为 0 不许报成功）', fs.existsSync(PIPELINE), PIPELINE);

  // ─────────────────────────────────────────── G1 `--pair` 解析（`|` / `:` / 盘符 / 空格）
  {
    const root = mk('pair-parse');
    write(root, 'a.txt', 'A'); write(root, 'b.txt', 'B');
    const r1 = run(root, ['begin', '--id', 'PP1', '--files', 'a.txt', '--pair', 'a.txt|b.txt']);
    c.check('G1① `--pair "左|右"` 能解析', r1.code === 0, 'exit=' + r1.code + ' ' + r1.out.split('\n')[0]);
    const also1 = (rows(root).find((x) => x.step === 'copied') || {}).files?.[0]?.also;
    c.check('G1① 账本里 `also` = 右值', also1 === 'b.txt', 'also=' + JSON.stringify(also1));

    write(root, 'c.txt', 'C'); write(root, 'd.txt', 'D');
    const absD = path.join(root, 'd.txt');
    const r2 = run(root, ['begin', '--id', 'PP2', '--files', 'c.txt', '--pair', `c.txt:${absD}`]);
    const also2 = (rows(root).find((x) => x.step === 'copied' && x.id === 'PP2') || {}).files?.[0]?.also;
    c.check('G1② `--pair "左:右"` 含**盘符**的右值不被切坏（D1/D2 的真 bug）',
      r2.code === 0 && also2 === absD, 'exit=' + r2.code + ' also=' + JSON.stringify(also2));

    write(root, 'e.txt', 'E'); write(root, 'f.txt', 'F');
    const r3 = run(root, ['begin', '--id', 'PP3', '--files', 'e.txt', '--pair', '  e.txt | f.txt  ']);
    c.check('G1③ `--pair` 两侧的**空白**被 trim', r3.code === 0, 'exit=' + r3.code);
    const r4 = run(root, ['begin', '--id', 'PP4', '--files', 'a.txt', '--pair', 'a.txt']);
    c.check('G1④ 负控：`--pair` 没有分隔符 ⇒ 拒（exit 2）', r4.code === 2, 'exit=' + r4.code + ' ' + r4.out.split('\n')[0]);
  }

  // ─────────────────────────────────────────── G2 左值匹配（新行为②：大小写 / 8.3 / 没匹配 / 查重）
  {
    const root = mk('pair-left');
    write(root, 'a.txt', 'A'); write(root, 'y.txt', 'Y');
    let uid = 0;
    const nextId = () => 'PL' + (++uid);
    const forms = [
      ['同字符串', 'a.txt'],
      ['点+反斜杠', '.\\a.txt'],
      ['点+正斜杠', './a.txt'],
      ['相对 vs 绝对', path.join(root, 'a.txt')],
      ['正斜杠写绝对路径', path.join(root, 'a.txt').replace(/\\/g, '/')],
      ['尾随空格', '  a.txt  '],
    ];
    for (const [label, lv] of forms) {
      const r = run(root, ['begin', '--id', nextId(), '--files', 'a.txt', '--pair', `${lv}|y.txt`]);
      c.check(`G2 · 左值写法「${label}」能匹配上`, r.code === 0, 'exit=' + r.code + ' lv=' + JSON.stringify(lv));
    }
    for (const lv of ['A.TXT', 'a.TXT']) {
      const r = run(root, ['begin', '--id', nextId(), '--files', 'a.txt', '--pair', `${lv}|y.txt`]);
      c.check(`G2 ★ 左值「${lv}」（**大小写不同 = 同一个文件**）必须匹配（原来是 exit 2）`,
        r.code === 0, 'exit=' + r.code + ' ' + r.out.split('\n')[0]);
    }
    const sn = shortName(path.join(root, 'a.txt'));
    if (!sn) c.skip('G2 · 8.3 短名左值', '这个卷没给 a.txt 生成 8.3 短名（`%~sI` 与长名相同）⇒ 判不了，不假装通过');
    else {
      const r = run(root, ['begin', '--id', nextId(), '--files', 'a.txt', '--pair', `${sn}|y.txt`]);
      c.check(`G2 ★ 左值用 **8.3 短名**（${sn}）必须匹配（原来是 exit 2）`, r.code === 0, 'exit=' + r.code + ' ' + r.out.split('\n')[0]);
    }
    const rNo = run(root, ['begin', '--id', 'NOPE', '--files', 'a.txt', '--pair', 'zzz.txt|y.txt']);
    c.check('G2⑤ 负控：左值**没匹配**任何 --files 项 ⇒ 拒（exit 2）', rNo.code === 2, 'exit=' + rNo.code);
    c.check('G2⑤ 而且要给出「你是不是想写 X」的提示（不许只丢一句"没匹配"）',
      /你是不是想写|--files 里现在只有/.test(rNo.out), rNo.out.split('\n').slice(-2).join(' / '));

    // 目标查重：两个不同输入写到同一个文件
    write(root, 'p.txt', 'P'); write(root, 'q.txt', 'Q'); write(root, 'z.txt', 'Z');
    const rDup = run(root, ['begin', '--id', 'DUP1', '--files', 'p.txt,q.txt', '--pair', 'p.txt|z.txt', '--pair', 'q.txt|z.txt']);
    c.check('G2⑥ 目标查重：两个输入 → 同一个右值 ⇒ 拒（D11）', rDup.code === 1 && /写到同一个文件/.test(rDup.out), 'exit=' + rDup.code);
    const rDup2 = run(root, ['begin', '--id', 'DUP2', '--files', 'p.txt,q.txt', '--pair', 'p.txt|z.txt', '--pair', 'q.txt|Z.TXT']);
    c.check('G2⑥ ★ 目标查重也认**大小写**（`z.txt` 与 `Z.TXT` 是同一个文件）', rDup2.code === 1 && /写到同一个文件/.test(rDup2.out), 'exit=' + rDup2.code);
    const rDup3 = run(root, ['begin', '--id', 'DUP3', '--files', 'p.txt,P.TXT']);
    c.check('G2⑦ 负控：`--files` 里同一个文件写两遍（大小写不同也算）⇒ 拒（D24 + 新行为②）',
      rDup3.code === 1 && /写了两遍/.test(rDup3.out), 'exit=' + rDup3.code);
  }

  // ─────────────────────────────────────────── G3 `--with-dir`：副本真能 import 兄弟
  {
    const root = mk('withdir');
    write(root, 'main.mjs', "import { v } from './sib.mjs'\nprocess.stdout.write('SIB=' + v)\nprocess.exit(v === 42 ? 0 : 3)\n");
    write(root, 'sib.mjs', 'export const v = 42\n');
    const rB = run(root, ['begin', '--id', 'WD1', '--files', 'main.mjs', '--with-dir']);
    c.check('G3① `--with-dir` 在**工程根**文件上能成功（D9 的原 bug：恒失败+exit 0）', rB.code === 0, 'exit=' + rB.code);
    const copy = copyOf(root, 'WD1', 'main.mjs');
    const rRun = spawnSync(process.execPath, [copy], { cwd: workDirOf(root, 'WD1'), encoding: 'utf8' });
    c.check('G3② 副本**真的能 import 兄弟**（`--with-dir` 的意义所在）',
      rRun.status === 0 && /SIB=42/.test(rRun.stdout || ''), 'exit=' + rRun.status + ' out=' + (rRun.stdout || '').trim());

    const rB2 = run(root, ['begin', '--id', 'WD2', '--files', 'main.mjs']);   // 负控：不镜像
    const copy2 = copyOf(root, 'WD2', 'main.mjs');
    const rRun2 = spawnSync(process.execPath, [copy2], { cwd: workDirOf(root, 'WD2'), encoding: 'utf8' });
    c.check('G3③ 负控：**不加 `--with-dir`** 的副本跑不起来（ERR_MODULE_NOT_FOUND —— 这就是 dispatch 的警告）',
      rRun2.status !== 0 && /ERR_MODULE_NOT_FOUND/.test((rRun2.stderr || '')), 'exit=' + rRun2.status);
  }

  // ─────────────────────────────────────────── G4 混根警告（D13）
  {
    const root = mk('mixed');
    const outside = mk('mixed-out');
    write(root, 'in.txt', 'IN'); write(outside, 'out.txt', 'OUT');
    const r1 = run(root, ['begin', '--id', 'MX1', '--files', 'in.txt,' + path.join(outside, 'out.txt')]);
    c.check('G4① 混根（有在 --root 外的）⇒ **大声警告**（D13：原来只看盘符，同盘不同树不报）',
      /不在同一棵树里/.test(r1.out), r1.out.split('\n').slice(0, 1).join(''));
    const r2 = run(root, ['begin', '--id', 'MX2', '--files', 'in.txt']);
    c.check('G4② 负控：同一棵树里 ⇒ **不许**报混根', !/不在同一棵树里/.test(r2.out), 'exit=' + r2.code);
  }

  // ─────────────────────────────────────────── G5 七个执法点（负控成对）
  {
    const root = mk('gates');
    write(root, 'a.txt', 'AAAA'); write(root, 'b.txt', 'BBBB');
    const rNoBegin = run(root, ['verify', '--id', 'X1', '--by', '审查', '--verdict', 'ok', '--evidence', EV]);
    c.check('G5① 没 begin 就 verify ⇒ 拒（exit 2）', rNoBegin.code === 2, 'exit=' + rNoBegin.code);

    run(root, ['begin', '--id', 'G1', '--files', 'a.txt']);
    const rApplyNoVerify = run(root, ['apply', '--id', 'G1']);
    c.check('G5② ★ 复制了**不检查**就 apply ⇒ 拒（用户点名的第一个漏）',
      rApplyNoVerify.code === 1 && /没有"角色检查通过"的记录/.test(rApplyNoVerify.out), 'exit=' + rApplyNoVerify.code);
    c.check('G5② 被拒的 apply 之后**原件没动**', read(root, 'a.txt') === 'AAAA', 'a.txt=' + read(root, 'a.txt'));

    const rBy = run(root, ['verify', '--id', 'G1', '--by', '主代理', '--verdict', 'ok', '--evidence', EV]);
    c.check('G5③ 非角色名 verify ⇒ 拒（形状检查）', rBy.code === 1, 'exit=' + rBy.code);
    const rEv = run(root, ['verify', '--id', 'G1', '--by', '审查', '--verdict', 'ok']);
    c.check('G5④ verdict=ok 但没有 `--evidence` ⇒ 拒', rEv.code === 1, 'exit=' + rEv.code);
    const rShort = run(root, ['verify', '--id', 'G1', '--by', '审查', '--verdict', 'ok', '--evidence', 'ok']);
    c.check('G5④b `--evidence` 太短 ⇒ 拒（"我看了没问题"不算检查）', rShort.code === 1, 'exit=' + rShort.code);

    // 检查之后副本又被改 ⇒ apply 拒
    const cp = copyOf(root, 'G1', 'a.txt');
    fs.writeFileSync(cp, 'CHANGED', 'utf8');
    run(root, ['verify', '--id', 'G1', '--by', '审查', '--verdict', 'ok', '--evidence', EV]);
    fs.appendFileSync(cp, '!!', 'utf8');
    const rCopyChanged = run(root, ['apply', '--id', 'G1']);
    c.check('G5⑤ ★ 检查之后副本又被改 ⇒ apply 拒（检查的必须是被替换的那一份）',
      rCopyChanged.code === 1 && /检查之后副本又被改过/.test(rCopyChanged.out), 'exit=' + rCopyChanged.code);

    // 绕过管线手工改原件 ⇒ 拒
    write(root, 'c.txt', 'C-ORIG');
    run(root, ['begin', '--id', 'G2', '--files', 'c.txt']);
    write(root, 'c.txt', 'HAND-EDITED');
    const rBypass = run(root, ['apply', '--id', 'G2']);
    c.check('G5⑥ ★ 绕过管线直接改原件 ⇒ apply 拒（第三种漏）',
      rBypass.code === 1 && /绕过管线/.test(rBypass.out), 'exit=' + rBypass.code);
    const rSt6 = run(root, ['status']);
    c.check('G5⑥ status 也必须把它列出来（exit 1）', rSt6.code === 1 && /绕过管线/.test(rSt6.out), 'status exit=' + rSt6.code);

    // rolledback 不豁免（D6）
    write(root, 'd.txt', 'D-ORIG');
    run(root, ['begin', '--id', 'G3', '--files', 'd.txt']);
    run(root, ['rollback', '--id', 'G3']);
    write(root, 'd.txt', 'HAND-AFTER-ROLLBACK');
    const rD6 = run(root, ['apply', '--id', 'G3']);
    c.check('G5⑦ ★ `rolledback` **不豁免**（D6）：回滚后手工改原件再 apply ⇒ 拒（原来静默覆盖）',
      rD6.code === 1 && /绕过管线/.test(rD6.out), 'exit=' + rD6.code);

    // 基线过期（缺陷1 的成因）
    write(root, 's.txt', 'S-ORIG');
    beginVerify(root, 'SA', ['s.txt'], { change: () => 'S-FROM-A' });
    beginVerify(root, 'SB', ['s.txt'], { change: () => 'S-FROM-B' });
    const rA = applyOk(root, 'SA');
    const rB = applyOk(root, 'SB');
    c.check('G5⑧ ★ 基线过期：另一个 patch 先 apply ⇒ 后来者拒，且**说清是基线过期**（不是"绕过管线"）',
      rA.code === 0 && rB.code === 1 && /基线过期/.test(rB.out) && !/原件已经被绕过管线改了/.test(rB.out),
      'A=' + rA.code + ' B=' + rB.code);

    /**
     * ★★ **G5⑩ D16（第四轮）**：角色名单**从 `ROLE_REGISTRY` 派生** ——
     *   原来这里是**第 9 份硬编码拷贝**（7 席），把**无票的 `AI测试用户`** 静默排除在外
     *   （而 `roleRegistryAudit()` **扫不到**这份拷贝 ⇒ 加/改角色时静默漂移）。
     *   正控：`--by AI测试用户` ⇒ 必须**收**（它在 `ROLE_REGISTRY` 里，只是**没有投票权**）；
     *   负控：`--by 主代理` ⇒ 照旧拒（G5③ 已覆盖，这里再配一条"名单真的是从注册表来的"）。
     */
    write(root, 'u.txt', 'U-ORIG');
    run(root, ['begin', '--id', 'R16', '--files', 'u.txt']);
    const rSeat = run(root, ['verify', '--id', 'R16', '--by', 'AI测试用户', '--verdict', 'ok', '--evidence', EV]);
    c.check('G5⑩ ★ D16：**无票的 `AI测试用户`** 也能 `verify --by`（名单从 `ROLE_REGISTRY` 派生，不再漏席）',
      rSeat.code === 0, 'exit=' + rSeat.code + ' ' + rSeat.out.split('\n')[0]);
    const rNotSeat = run(root, ['verify', '--id', 'R16', '--by', '产品使用者', '--verdict', 'ok', '--evidence', EV]);
    c.check('G5⑩ 负控：**职称**（`产品使用者`）不是名单里的 id ⇒ 照旧拒',
      rNotSeat.code === 1, 'exit=' + rNotSeat.code);

    // pair 第二份被删（D12）
    write(root, 'p1.txt', 'P1'); write(root, 'p2.txt', 'P2');
    beginVerify(root, 'PD', ['p1.txt'], { pairs: ['p1.txt|p2.txt'], change: () => 'P1-NEW' });
    fs.rmSync(path.join(root, 'p2.txt'));
    const rGone = run(root, ['apply', '--id', 'PD']);
    c.check('G5⑨ ★ `--pair` 第二份被删 ⇒ apply 拒（D12：原来静默重建它）',
      rGone.code === 1 && /第二份不见了/.test(rGone.out), 'exit=' + rGone.code);
  }

  // ─────────────────────────────────────────── G6 事务预检 + 孤儿行 + 改了个寂寞
  {
    const root = mk('tx');
    write(root, 'f1.txt', 'F1-ORIG'); write(root, 'f2.txt', 'F2-ORIG');
    beginVerify(root, 'T1', ['f1.txt', 'f2.txt'], { change: (n, i) => 'F' + (i + 1) + '-NEW' });
    fs.chmodSync(path.join(root, 'f2.txt'), 0o444);   // 第二个目标只读
    const rTx = run(root, ['apply', '--id', 'T1']);
    c.check('G6① ★ 事务预检：有一个目标不可写 ⇒ 拒，且**一个字节都没替换**（D7 的写盘层事务）',
      rTx.code === 1 && /一个字节都没替换/.test(rTx.out), 'exit=' + rTx.code);
    c.check('G6① 第一个目标**仍然是旧内容**（= 零替换，不是半替换）',
      read(root, 'f1.txt') === 'F1-ORIG', 'f1.txt=' + read(root, 'f1.txt'));
    c.check('G6① 账本里**没有任何替换进度**（没有 replacing/replaced 行）',
      !stepsOf(root).includes('replacing') && !stepsOf(root).includes('replaced'), JSON.stringify(stepsOf(root)));
    fs.chmodSync(path.join(root, 'f2.txt'), 0o666);

    // 孤儿行（伪造 verify ok 的形态）
    const root2 = mk('orphan');
    write(root2, 'a.txt', 'A');
    beginVerify(root2, 'O1', ['a.txt'], { change: () => 'A-NEW' });
    fs.appendFileSync(ledgerPath(root2), JSON.stringify({ at: nowIso(), step: 'verified', verdict: 'ok' }) + '\n');
    const rOrphanApply = run(root2, ['apply', '--id', 'O1']);
    /**
     * ⚠ 如实说明这条负控的**实际拦法**：手工追加的那一行**没有 self** ⇒ 现在**先**被哈希链拦下
     *   （`链开始之后的一条没有 self`），孤儿行闸是它的**第二道**。两条都是 exit 1，谁先冒出来不重要 ——
     *   但**不许**因为换了拦法就当成"没拦"。
     */
    c.check('G6② ★ 账本里有**没有 id 的孤儿行** ⇒ apply 拒（伪造 verify ok 的形态，D22）',
      rOrphanApply.code === 1 && /没有 id 的记录|哈希链断了/.test(rOrphanApply.out), 'exit=' + rOrphanApply.code + ' ' + rOrphanApply.out.split('\n')[0]);
    const rOrphanStatus = run(root2, ['status']);
    c.check('G6② status 同口径：报出孤儿行 + exit 1', rOrphanStatus.code === 1 && /没有 id 的记录/.test(rOrphanStatus.out), 'exit=' + rOrphanStatus.code);

    // 改了个寂寞（D18）
    const root3 = mk('noop');
    write(root3, 'a.txt', 'SAME');
    run(root3, ['begin', '--id', 'N1', '--files', 'a.txt']);   // 副本**一个字都不改**
    run(root3, ['verify', '--id', 'N1', '--by', '审查', '--verdict', 'ok', '--evidence', EV]);
    const rNoop = run(root3, ['apply', '--id', 'N1']);
    c.check('G6③ ★ 改了个寂寞（替换前后指纹相同）⇒ exit 1（用户 R32：等于没做）',
      rNoop.code === 1 && /改了个寂寞|所有文件替换前后指纹相同/.test(rNoop.out), 'exit=' + rNoop.code);
    c.check('G6③ ★ D18：这时**输出里不许出现 `✓`**（原来先打 ✓ 再 exit 1，包装脚本会误读）',
      !/✓/.test(rNoop.out), '输出里有 ✓ 的行：' + (rNoop.out.split('\n').filter((l) => /✓/.test(l)).join(' | ') || '(无)'));
    const rNoopSt = run(root3, ['status']);
    c.check('G6③ status 也把"改了个寂寞"列成卡住（exit 1）', rNoopSt.code === 1 && /改了个寂寞/.test(rNoopSt.out), 'exit=' + rNoopSt.code);
  }

  // ─────────────────────────────────────────── G7 三处绿灯改红（D8）+ 正控 + 撞车
  {
    const root = mk('d8');
    write(root, 'a.txt', 'A'); write(root, 'b.txt', 'B'); write(root, 'c.txt', 'C');
    // ① begin → rollback（从没检查过）
    run(root, ['begin', '--id', 'D1', '--files', 'a.txt']);
    const rRoll1 = run(root, ['rollback', '--id', 'D1']);
    const s1 = run(root, ['status']);
    c.check('G7① ★ D8①：`begin → rollback`（**从没检查过**）原来 exit 0 ⇒ 现在 status 必须红',
      rRoll1.code === 0 && s1.code === 1 && /洗白|什么都没交付/.test(s1.out), 'rollback=' + rRoll1.code + ' status=' + s1.code);
    // ② apply → verify bad
    beginVerify(root, 'D2', ['b.txt'], { change: () => 'B-NEW' });
    const rAp2 = applyOk(root, 'D2');
    run(root, ['verify', '--id', 'D2', '--by', '审查', '--verdict', 'bad', '--evidence', '返工：这一版不能要（这是原样输出）']);
    const s2 = run(root, ['status']);
    c.check('G7② ★ D8②：`apply → verify bad`（替换后角色翻案）原来报"已完成" ⇒ 现在必须红',
      rAp2.code === 0 && s2.code === 1 && /翻案/.test(s2.out), 'apply=' + rAp2.code + ' status=' + s2.code);
    // ③ apply → rollback（净零）
    beginVerify(root, 'D3', ['c.txt'], { change: () => 'C-NEW' });
    applyOk(root, 'D3');
    const rRoll3 = run(root, ['rollback', '--id', 'D3']);
    const s3 = run(root, ['status']);
    c.check('G7③ ★ D8③：`apply → rollback`（净效果等于没做）原来 exit 0 ⇒ 现在必须红',
      rRoll3.code === 0 && s3.code === 1 && /净效果等于没做/.test(s3.out), 'status=' + s3.code);

    // 正控：完整走完 ⇒ status 必须 0（不许把对的判红）
    const root2 = mk('d8-ok');
    write(root2, 'ok.txt', 'OK-ORIG');
    beginVerify(root2, 'D4', ['ok.txt'], { change: () => 'OK-NEW' });
    const rAp4 = applyOk(root2, 'D4');
    const s4 = run(root2, ['status']);
    c.check('G7④ 正控：begin → verify ok → apply（**带 --verify-cmd**）全走完 ⇒ status **exit 0**',
      rAp4.code === 0 && s4.code === 0, 'apply=' + rAp4.code + ' status=' + s4.code + ' ' + s4.out.split('\n').pop());
    c.check('G7④ 正控：这时 status 逐字写清"**指纹变了 + 整体检查 exit 0**"（两半都过才算完成）',
      /整体检查 exit 0/.test(s4.out), s4.out.split('\n').find((l) => /已完成/.test(l)) || '(没有"已完成"那行)');

    // 撞车（缺陷2）
    const root3 = mk('collide');
    write(root3, 'x.txt', 'X'); write(root3, 'y.txt', 'Y');
    run(root3, ['begin', '--id', 'C1', '--files', 'x.txt']);
    run(root3, ['begin', '--id', 'C2', '--files', 'y.txt', '--pair', 'y.txt|x.txt']);
    const s5 = run(root3, ['status']);
    c.check('G7⑤ ★ `[撞车]`：两个**未结** patch 点同一个文件 ⇒ status 列出撞车 + exit 1（缺陷2）',
      s5.code === 1 && /\[撞车\]/.test(s5.out), 'exit=' + s5.code);
    // 负控：已 applied 的那个不算撞车
    const root4 = mk('collide-ok');
    write(root4, 'x.txt', 'X');
    beginVerify(root4, 'C3', ['x.txt'], { change: () => 'X-NEW' });
    run(root4, ['apply', '--id', 'C3']);
    run(root4, ['begin', '--id', 'C4', '--files', 'x.txt']);
    const s6 = run(root4, ['status']);
    c.check('G7⑤ 负控：那是**正常先后关系**（前者已 applied）⇒ 不许报撞车',
      !/\[撞车\]/.test(s6.out), 'exit=' + s6.code);
  }

  // ─────────────────────────────────────────── G8 rollback（硬失败3 + D5 两边一起回）
  {
    // 正控：新账本（begin 存了 origAlso）⇒ 两边一起回、exit 0
    const root = mk('rollback-ok');
    write(root, 'x.txt', 'X-ORIG'); write(root, 'y.txt', 'Y-ORIG');
    beginVerify(root, 'R1', ['x.txt'], { pairs: ['x.txt|y.txt'], change: () => 'X-PATCHED' });
    const rAp = applyOk(root, 'R1');
    const before = { x: read(root, 'x.txt'), y: read(root, 'y.txt') };
    const rRb = run(root, ['rollback', '--id', 'R1']);
    c.check('G8① 正控：`--pair` 的 apply 两边一起写（两份都变了）',
      rAp.code === 0 && before.x === 'X-PATCHED' && before.y === 'X-PATCHED', JSON.stringify(before));
    c.check('G8② ★ D5：`rollback` 也**两边一起回**（原来只回左边 ⇒ 两份分叉而 status 还绿灯）',
      rRb.code === 0 && read(root, 'x.txt') === 'X-ORIG' && read(root, 'y.txt') === 'Y-ORIG',
      'x=' + read(root, 'x.txt') + ' y=' + read(root, 'y.txt'));
    c.check('G8② rollback 的输出逐条报"恢复正确"', /恢复正确/.test(rRb.out) && /\[第二份\]/.test(rRb.out), rRb.out.split('\n').slice(-2).join(' / '));

    /**
     * ★★ **硬失败3 的夹具**：老账本 = 那一轮 D5 **修之前**的 `begin` 写出来的账本 ——
     *   `copied` 行有 `also`（第二份）却**没有 `origAlso`**（没有第二份的只读原件）。
     *   ⚠ 这里**按那种账本的字段/链格式逐字复刻**（不依赖任何 patch 内部路径，也不依赖"安装份是不是旧版"），
     *     因为真账本只在"上一轮的产物"里存在，而回归用例必须能长期重复跑。
     */
    const root2 = mk('old-ledger');
    write(root2, 'x.txt', 'X-PATCHED'); write(root2, 'y.txt', 'X-PATCHED');
    const pdir = path.join(root2, '.warden', 'patches', 'OLD1');
    fs.mkdirSync(path.join(pdir, 'orig'), { recursive: true });
    fs.mkdirSync(path.join(pdir, 'work'), { recursive: true });
    const cname = 'deadbeef__x.txt';
    fs.writeFileSync(path.join(pdir, 'orig', cname), 'X-ORIG', 'utf8');
    fs.writeFileSync(path.join(pdir, 'work', cname), 'X-PATCHED', 'utf8');
    appendRow(root2, {
      at: nowIso(), id: 'OLD1', step: 'copied',
      files: [{
        path: 'x.txt', shaBefore: shaText('X-ORIG'), name: cname,
        orig: '.warden/patches/OLD1/orig/' + cname, copy: '.warden/patches/OLD1/work/' + cname,
        also: 'y.txt', alsoShaBefore: shaText('Y-ORIG'),
        // ★ 没有 origAlso 这个字段 —— 老账本就是这个形状（评测的那份账本实测如此）
      }],
    });
    appendRow(root2, { at: nowIso(), id: 'OLD1', step: 'verified', by: '审查', verdict: 'ok', evidence: EV, copyShas: [{ path: 'x.txt', copySha: shaText('X-PATCHED') }] });
    appendRow(root2, {
      at: nowIso(), id: 'OLD1', step: 'applied', by: '审查',
      replaced: [
        { path: 'x.txt', shaBefore: shaText('X-ORIG'), shaAfter: shaText('X-PATCHED'), changed: true },
        { path: 'y.txt', shaBefore: shaText('Y-ORIG'), shaAfter: shaText('X-PATCHED'), changed: true, isPair: true },
      ],
    });
    c.check('G8③ 夹具：这份老账本的链是**完整**的（能读、不是"链断"那条路）',
      run(root2, ['dispatch', '--id', 'OLD1']).code === 0, 'dispatch 应当能跑');

    const rOld = run(root2, ['rollback', '--id', 'OLD1']);
    c.check('G8④ ★★ 硬失败3：老账本没有 `origAlso` ⇒ rollback 拒（exit 1）',
      rOld.code === 1 && /没有只读原件可回滚/.test(rOld.out), 'exit=' + rOld.code);
    c.check('G8④ ★★ **一个字节都没回**（原来先写左边再检查 ⇒ x 回了、y 没回 = 分叉树）',
      read(root2, 'x.txt') === 'X-PATCHED' && read(root2, 'y.txt') === 'X-PATCHED',
      'x=' + read(root2, 'x.txt') + ' y=' + read(root2, 'y.txt'));
    c.check('G8④ ★★ 拒绝的原因**落进账本**（rollback-failed）—— 原来零进度',
      stepsOf(root2).includes('rollback-failed'), JSON.stringify(stepsOf(root2)));
    const sOld = run(root2, ['status']);
    c.check('G8⑤ ★★ `status` 对已分叉的树**不许报绿灯**（原来是"已完成 / 没有卡住的 / exit 0"）',
      sOld.code === 1 && !/没有卡住的/.test(sOld.out) && /rollback/.test(sOld.out),
      'exit=' + sOld.code + ' ' + sOld.out.split('\n').slice(-2).join(' / '));
  }

  // ─────────────────────────────────────────── G9 K2c：半替换 + rollback 之后 partial 必须清零
  {
    const root = mk('k2c');
    const N = 120;
    const names = [];
    for (let i = 0; i < N; i++) { const n = 'f' + String(i).padStart(3, '0') + '.txt'; write(root, n, 'ORIG' + i); names.push(n); }
    run(root, ['begin', '--id', 'K1', '--files', names.join(',')]);
    const wd = workDirOf(root, 'K1');
    for (const n of fs.readdirSync(wd)) fs.writeFileSync(path.join(wd, n), 'PATCHED', 'utf8');
    run(root, ['verify', '--id', 'K1', '--by', '审查', '--verdict', 'ok', '--evidence', EV]);
    const it = await interruptApply(root, 'K1', { total: N });
    const nRepl = it.rows.filter((r) => r.step === 'replaced').length;
    const applied = it.rows.some((r) => r.step === 'applied');
    c.check('G9① 夹具：真打断一次 apply ⇒ **0 < 已替换 < 总数** 且没有 applied（真的"半替换"）',
      nRepl > 0 && nRepl < N && !applied, `replaced=${nRepl}/${N} applied=${applied}`);
    const sHalf = run(root, ['status']);
    c.check('G9② 半替换 ⇒ status 报「替换只做了一半」+ exit 1',
      sHalf.code === 1 && /只做了一半/.test(sHalf.out), 'exit=' + sHalf.code);

    const rRb = run(root, ['rollback', '--id', 'K1']);
    const allBack = names.every((n, i) => read(root, n) === 'ORIG' + i);
    c.check('G9③ 半替换之后 rollback ⇒ exit 0 且**每个文件都回到基线**（树一致）',
      rRb.code === 0 && allBack, 'exit=' + rRb.code);
    const sAfter = run(root, ['status']);
    c.check('G9④ ★★ K2c：rollback 之后 `status` **不许**再说「替换只做了一半…重跑 apply 可续做」',
      !/只做了一半/.test(sAfter.out), 'status 里还有："' + (sAfter.out.split('\n').find((l) => /只做了一半/.test(l)) || '(无)') + '"');
    c.check('G9④ ★★ 而要如实说"已经 rollback 过了 / 这轮没交付"（exit 1 是因为净效果等于没做，不是因为"没回滚"）',
      sAfter.code === 1 && /已 rollback|已回滚/.test(sAfter.out), 'exit=' + sAfter.code + ' ' + sAfter.out.split('\n').slice(-2).join(' / '));
  }

  // ─────────────────────────────────────────── G10 逐条进度可续做（真打断之后重跑 apply）
  {
    const root = mk('resume');
    const N = 120;
    const names = [];
    for (let i = 0; i < N; i++) { const n = 'g' + String(i).padStart(3, '0') + '.txt'; write(root, n, 'ORIG'); names.push(n); }
    run(root, ['begin', '--id', 'RS1', '--files', names.join(',')]);
    const wd = workDirOf(root, 'RS1');
    for (const n of fs.readdirSync(wd)) fs.writeFileSync(path.join(wd, n), 'RESUMED', 'utf8');
    run(root, ['verify', '--id', 'RS1', '--by', '审查', '--verdict', 'ok', '--evidence', EV]);
    const it = await interruptApply(root, 'RS1', { total: N });
    c.check('G10① 夹具：打断之后账本里**有逐条进度**（replacing/replaced 至少一条）',
      it.rows.some((r) => r.step === 'replacing' || r.step === 'replaced'), JSON.stringify(it.rows.map((r) => r.step).slice(-4)));
    const rRetry = applyOk(root, 'RS1');
    c.check('G10② ★ D7「可续做」真的成立：打断之后**直接重跑 apply ⇒ exit 0**（不许误诊成"绕过管线"而永久卡死）',
      rRetry.code === 0 && !/绕过管线/.test(rRetry.out), 'exit=' + rRetry.code + ' ' + rRetry.out.split('\n')[0]);
    c.check('G10② 所有文件都真的被替换了', names.every((n) => read(root, n) === 'RESUMED'),
      '未替换的：' + names.filter((n) => read(root, n) !== 'RESUMED').slice(0, 3).join(','));
    const sR = run(root, ['status']);
    c.check('G10③ 续做完成后 status exit 0（没有卡住的）', sR.code === 0, 'exit=' + sR.code + ' ' + sR.out.split('\n').pop());
  }

  // ─────────────────────────────────────────── G11 替换后复核（R32 必须⑥ / 硬失败1 / 洞1 / 洞1b）
  {
    const root = mk('recheck');
    write(root, 'a.txt', 'A-ORIG');
    write(root, 'ok.mjs', 'process.exit(0)\n');
    write(root, 'fail.mjs', 'process.exit(7)\n');
    beginVerify(root, 'P1', ['a.txt'], { change: () => 'A-NEW' });
    const rAp = applyOk(root, 'P1');
    const pc1 = rows(root).find((r) => r.step === 'postchecked');
    c.check('G11① ★ 硬失败1：`apply` 之后**真的有一条复核**（不是一句 "下一步"）—— 账本里记 `postchecked`',
      rAp.code === 0 && !!pc1 && pc1.kind === 'fingerprint' && pc1.ok === true,
      'postchecked=' + JSON.stringify(pc1 ? { kind: pc1.kind, ok: pc1.ok } : null));
    c.check('G11① apply 的输出里明确报出「替换后复核」和**整体检查的 exit code**（不是一句"下一步"）',
      /替换后复核/.test(rAp.out) && /整体检查 .*exit=0/.test(rAp.out), rAp.out.split('\n').slice(-2).join(' / '));
    const pcOk = run(root, ['postcheck', '--id', 'P1']);
    c.check('G11② 正控：`postcheck --id`（只核指纹）在**整体检查已经过了**时 ⇒ exit 0',
      pcOk.code === 0 && /指纹变了/.test(pcOk.out), 'exit=' + pcOk.code);

    // 负控：还没 apply 就 postcheck（**单独一个沙箱** —— 否则这条"没验证的 patch"会把后面正控的 status 拖红）
    const rootB = mk('recheck-early');
    write(rootB, 'b.txt', 'B-ORIG');
    run(rootB, ['begin', '--id', 'P2', '--files', 'b.txt']);
    const pcEarly = run(rootB, ['postcheck', '--id', 'P2']);
    c.check('G11③ 负控：**还没替换**就 postcheck ⇒ 拒（不许拿复核冒充角色检查）',
      pcEarly.code === 1 && /还没替换/.test(pcEarly.out), 'exit=' + pcEarly.code);

    // 整体检查：非 0 ⇒ apply 不算成功 + status 红
    write(root, 'c.txt', 'C-ORIG');
    beginVerify(root, 'P3', ['c.txt'], { change: () => 'C-NEW' });
    const rApFail = run(root, ['apply', '--id', 'P3', '--verify-cmd', 'node fail.mjs']);
    const sFail = run(root, ['status']);
    c.check('G11④ ★ `apply --verify-cmd "<整体检查>"` **真的起子进程跑**：exit 7 ⇒ apply exit 1',
      rApFail.code === 1 && /exit=7/.test(rApFail.out), 'exit=' + rApFail.code);
    c.check('G11④ 整体检查没过 ⇒ `status` **报红**（R32 必须⑥ 的后半段可机检）',
      sFail.code === 1 && /复核没做完\/没过/.test(sFail.out), 'status exit=' + sFail.code);
    c.check('G11④ 复核结果进了账本（kind=verify-cmd / code=7）',
      rows(root).some((r) => r.step === 'postchecked' && r.kind === 'verify-cmd' && r.code === 7), JSON.stringify(stepsOf(root)));

    // 事后补跑：先 fail（红）再 ok（绿）—— 单独沙箱，保证 status 只看这一个 patch
    const rootC = mk('recheck-retry');
    write(rootC, 'c.txt', 'C-ORIG');
    write(rootC, 'ok.mjs', 'process.exit(0)\n');
    write(rootC, 'fail.mjs', 'process.exit(7)\n');
    beginVerify(rootC, 'Q1', ['c.txt'], { change: () => 'C-NEW' });
    run(rootC, ['apply', '--id', 'Q1', '--verify-cmd', 'node fail.mjs']);
    const pcFail = run(rootC, ['postcheck', '--id', 'Q1', '--cmd', 'node fail.mjs']);
    const sAfterFail = run(rootC, ['status']);
    c.check('G11⑤ `postcheck --cmd "<命令>"` 非 0 ⇒ exit 1 + status 红',
      pcFail.code === 1 && sAfterFail.code === 1, 'postcheck=' + pcFail.code + ' status=' + sAfterFail.code);
    const pcGood = run(rootC, ['postcheck', '--id', 'Q1', '--cmd', 'node ok.mjs']);
    const sAfterGood = run(rootC, ['status']);
    c.check('G11⑤ 正控：补跑一次**通过**的复核（exit 0）⇒ status 恢复绿灯',
      pcGood.code === 0 && sAfterGood.code === 0, 'postcheck=' + pcGood.code + ' status=' + sAfterGood.code);

    // 正控：apply 时直接带一条通过的整体检查
    const rootD = mk('recheck-cmd-ok');
    write(rootD, 'd.txt', 'D-ORIG');
    write(rootD, 'ok.mjs', 'process.exit(0)\n');
    beginVerify(rootD, 'P4', ['d.txt'], { change: () => 'D-NEW' });
    const rApOk = run(rootD, ['apply', '--id', 'P4', '--verify-cmd', 'node ok.mjs']);
    const sOk = run(rootD, ['status']);
    c.check('G11⑥ 正控：`--verify-cmd` 通过（exit 0）⇒ apply exit 0 且 status 绿灯',
      rApOk.code === 0 && sOk.code === 0, 'apply=' + rApOk.code + ' status=' + sOk.code);

    /**
     * ★★ **G11⑦ 洞1（第四轮 · 审查实测的假绿，与硬失败1 同一个形状）** —— **原样复刻审查给的五步**：
     *   ① `apply --verify-cmd "node fail.mjs"` ⇒ exit 1；`status` ⇒ exit 1「复核没通过」
     *   ③ `postcheck --id L1`（**不带 `--cmd`**）⇒ 原来 **exit 0**「✓ …通过（R32 必须⑥）」
     *   ④ `status` ⇒ 原来 **exit 0**「已完成（…整体检查没跑过…）」← ★★ 假绿
     *   根因：`stateOf.st.postcheck` **只认最后一条** `postchecked` ⇒ **一条更弱的复核盖掉了失败记录**，
     *        而那条失败的命令**从未重跑**。
     *   ⇒ 现在两半**各自只认自己那一类**：指纹看最后一条 `fingerprint`，**整体检查看最后一条 `verify-cmd`**。
     */
    const rootE = mk('hole1-weak-recheck');
    write(rootE, 'a.txt', 'A-ORIG');
    write(rootE, 'fail.mjs', 'process.exit(7)\n');
    beginVerify(rootE, 'H1', ['a.txt'], { change: () => 'A-NEW' });
    const h1Apply = run(rootE, ['apply', '--id', 'H1', '--verify-cmd', 'node fail.mjs']);
    const h1StatusFail = run(rootE, ['status']);
    c.check('G11⑦ ① `apply --verify-cmd "node fail.mjs"` ⇒ exit 1；`status` ⇒ exit 1（失败已进账本）',
      h1Apply.code === 1 && h1StatusFail.code === 1 && /exit=7/.test(h1StatusFail.out),
      'apply=' + h1Apply.code + ' status=' + h1StatusFail.code);
    const h1Weak = run(rootE, ['postcheck', '--id', 'H1']);   // ★ 不带 --cmd（更弱的复核）
    c.check('G11⑦ ③ ★★ **洞1**：一条**不带 `--cmd` 的复核** ⇒ **不许 exit 0**、**不许**说"复核通过"',
      h1Weak.code === 1 && !/复核 通过/.test(h1Weak.out) && /整体检查/.test(h1Weak.out),
      'exit=' + h1Weak.code + ' ' + h1Weak.out.split('\n')[0]);
    const h1StatusAfter = run(rootE, ['status']);
    c.check('G11⑦ ④ ★★ **洞1**：那条更弱的复核之后 `status` **仍然 exit 1**（不许变绿、不许说"已完成"）',
      h1StatusAfter.code === 1 && !/没有卡住的/.test(h1StatusAfter.out) && /exit=7|整体检查/.test(h1StatusAfter.out),
      'status exit=' + h1StatusAfter.code + ' ' + h1StatusAfter.out.split('\n').slice(-2).join(' / '));
    c.check('G11⑦ ⑤ 账本里**两条复核都在**（fingerprint + verify-cmd），失败那条**没被删也没被盖**',
      rows(rootE).filter((r) => r.step === 'postchecked').length >= 3
      && rows(rootE).some((r) => r.kind === 'verify-cmd' && r.code === 7),
      JSON.stringify(rows(rootE).filter((r) => r.step === 'postchecked').map((r) => ({ kind: r.kind, ok: r.ok, code: r.code }))));

    /**
     * ★★ **G11⑧ 洞1b（第四轮 · 审查实测）**：`apply` **不带 `--verify-cmd`** 时原来
     *   `apply` exit 0 + `status` exit 0「已完成（…整体检查没跑过…）」—— **那就是"⑥ 后半段
     *   可以一次都不跑就绿灯"**（R32 必须⑥ 逐字要"指纹变了 **+** 整体检查 exit 0"）。
     *   ⇒ 现在 `apply` **必须二选一**：`--verify-cmd`（真跑）或 `--no-overall-check --why "<≥20 字>"`（显式豁免）；
     *     两个都没给 ⇒ **exit 1** + `status` 红。**没有任何"默认不跑"的路。**
     */
    const rootF = mk('hole1b-bare-apply');
    write(rootF, 'a.txt', 'A-ORIG');
    beginVerify(rootF, 'H2', ['a.txt'], { change: () => 'A-NEW' });
    const h2Bare = run(rootF, ['apply', '--id', 'H2']);
    c.check('G11⑧ ★★ **洞1b**：`apply` 不带 `--verify-cmd`（也没豁免）⇒ **exit 1**（原来 exit 0）',
      h2Bare.code === 1 && /整体检查：没跑，也没声明/.test(h2Bare.out), 'exit=' + h2Bare.code + ' ' + h2Bare.out.split('\n')[0]);
    const h2Status = run(rootF, ['status']);
    c.check('G11⑧ ★★ **洞1b**：`status` **不许**说"已完成"（原来报「已完成（…整体检查没跑过…）」exit 0）',
      h2Status.code === 1 && /整体检查从没跑过、也没声明/.test(h2Status.out) && !/没有卡住的/.test(h2Status.out),
      'status exit=' + h2Status.code + ' ' + h2Status.out.split('\n').slice(-2).join(' / '));
    c.check('G11⑧ 账本里**没有**"整体检查已完成"的记录（只有指纹复核）',
      !rows(rootF).some((r) => r.step === 'postchecked' && (r.kind === 'verify-cmd' || r.kind === 'waived')),
      JSON.stringify(rows(rootF).filter((r) => r.step === 'postchecked').map((r) => r.kind)));
    // 正控：显式豁免（理由 ≥20 字，进账本）⇒ 收
    const h2Waive = run(rootF, ['postcheck', '--id', 'H2', '--no-overall-check', '--why', '这个 patch 只改了一段说明文字，仓库里没有任何能跑的检查命令']);
    const h2StatusWaive = run(rootF, ['status']);
    c.check('G11⑧ 正控：`--no-overall-check --why "<≥20 字>"`（**显式豁免**）⇒ exit 0 且 status 绿灯，理由进账本',
      h2Waive.code === 0 && h2StatusWaive.code === 0
      && rows(rootF).some((r) => r.kind === 'waived' && String(r.why).length >= 20)
      && /显式豁免/.test(h2StatusWaive.out),
      'waive=' + h2Waive.code + ' status=' + h2StatusWaive.code);
    // 负控：理由太短 ⇒ 拒
    const rootG = mk('hole1b-short-why');
    write(rootG, 'a.txt', 'A-ORIG');
    beginVerify(rootG, 'H3', ['a.txt'], { change: () => 'A-NEW' });
    const h3Short = run(rootG, ['apply', '--id', 'H3', '--no-overall-check', '--why', '没有']);
    c.check('G11⑧ 负控：豁免理由**太短** ⇒ 拒（exit 1，"跳过"不是一句话的事）',
      h3Short.code === 1 && /≥20 字/.test(h3Short.out), 'exit=' + h3Short.code);
  }

  // ─────────────────────────────────────────── G12 链校验 + 老账本兼容（新行为⑰）
  {
    // 伪造：链开始之后手工追加一行没有 self 的 verify ok（资料员实测过的绕过路径）
    const root = mk('chain');
    write(root, 'a.txt', 'A-ORIG');
    beginVerify(root, 'CH1', ['a.txt'], { change: () => 'A-NEW' });
    fs.appendFileSync(ledgerPath(root), JSON.stringify({ at: nowIso(), id: 'CH1', step: 'verified', by: '审查', verdict: 'ok', evidence: EV }) + '\n');
    const rFake = run(root, ['apply', '--id', 'CH1']);
    c.check('G12① ★ 链校验：手工往账本追加一行假 `verify ok`（没有 self）⇒ apply 拒（**这条不许放宽**）',
      rFake.code === 1 && /哈希链断了/.test(rFake.out), 'exit=' + rFake.code);
    const sChain = run(root, ['status']);
    c.check('G12① status 也报"链断了"', sChain.code === 1 && /哈希链断了/.test(sChain.out), 'exit=' + sChain.code);

    // 老账本（整本都是"链之前"的格式）：不许整本锁死
    const root2 = mk('legacy');
    write(root2, 'a.txt', 'A');
    const name = 'cafebabe__a.txt';
    fs.mkdirSync(path.join(root2, '.warden', 'patches', 'OLD', 'orig'), { recursive: true });
    fs.mkdirSync(path.join(root2, '.warden', 'patches', 'OLD', 'work'), { recursive: true });
    fs.writeFileSync(path.join(root2, '.warden', 'patches', 'OLD', 'orig', name), 'A', 'utf8');
    fs.writeFileSync(path.join(root2, '.warden', 'patches', 'OLD', 'work', name), 'A', 'utf8');
    /**
     * ★ 老格式：**没有 prev/self**（这就是"链之前"的账本行）。
     * ⚠ **第四轮修正**：这里原来还写了 `origAlso: null` —— 那是**链之后**才有的字段
     *   （见 `chainEraMarkers`）⇒ 洞3 的判据会（**正确地**）把它判成"被删过 self 的新格式行"。
     *   夹具要造的是**真的老账本**，所以**不能带**上链之后才有的字段 —— 这条修正本身也是洞3 的一部分。
     */
    fs.writeFileSync(ledgerPath(root2), JSON.stringify({
      at: nowIso(), id: 'OLD', step: 'copied',
      files: [{ path: 'a.txt', shaBefore: shaText('A'), name, orig: '.warden/patches/OLD/orig/' + name, copy: '.warden/patches/OLD/work/' + name, also: null, alsoShaBefore: null }],
    }) + '\n', 'utf8');
    const rLegacyDispatch = run(root2, ['dispatch', '--id', 'OLD']);
    c.check('G12② ★ 新行为⑰：老格式账本 ⇒ `dispatch` 不再被"链断了"锁死（改成**兼容 + 警告**）',
      rLegacyDispatch.code === 0 && /老格式|都没有 self/.test(rLegacyDispatch.out), 'exit=' + rLegacyDispatch.code);
    const rLegacyBegin = run(root2, ['begin', '--id', 'NEW', '--files', 'a.txt']);
    c.check('G12② ★★ 新行为⑰ 的关键一条：老账本下**`begin` 能开新活**（原来 exit 1 ⇒ 连新 patch 都开不了）',
      rLegacyBegin.code === 0, 'exit=' + rLegacyBegin.code + ' ' + rLegacyBegin.out.split('\n')[0]);
    const sLegacy = run(root2, ['status']);
    c.check('G12② status 明确说明"老格式前缀不计入卡住"（不是假装没这回事）',
      /老格式/.test(sLegacy.out) && /不计入卡住/.test(sLegacy.out), sLegacy.out.split('\n').find((l) => /老格式/.test(l)) || '');
    // ★ 负控：兼容**只**覆盖"链之前的前缀" —— 链开始之后再追加无 self 的行，照旧拒
    const rLegacyFake = (() => {
      fs.appendFileSync(ledgerPath(root2), JSON.stringify({ at: nowIso(), id: 'NEW', step: 'verified', by: '审查', verdict: 'ok', evidence: EV }) + '\n');
      return run(root2, ['apply', '--id', 'NEW']);
    })();
    c.check('G12③ ★ 负控：**链一旦开始**，后面再追加无 self 的行 ⇒ 照旧拒（兼容不是放宽）',
      rLegacyFake.code === 1 && /哈希链断了|没有 self/.test(rLegacyFake.out), 'exit=' + rLegacyFake.code);

    /**
     * ★★ **G12④ 洞3（第四轮 · 审查实测的 widening）** —— 兼容面被利用成一条捷径：
     *   把**整本账本**每行的 `self`/`prev` 删掉（**不需要知道 `chainHash`，只要删字段**）
     *   ⇒ 整本被认成 `legacy` ⇒ 再追加一行**没有 `self` 的假 `verify ok`** ⇒ `apply` **exit 0、原件被替换**。
     *   对照（修前）：链引入时的写法（无条件 `r.self !== chainHash(r)`）会把"整本无 self"判成断链 ⇒ 拒绝。
     *   ⇒ **伪造代价从"重算整条链"降到"删一个字段"** —— 这条必须堵死。
     *   修法：**"没有 self"不再是通行证** —— 老格式行**不许带**"只有链之后的版本才会写"的东西
     *   （步骤 `replacing/replaced/postchecked/restoring/rollback-failed`；字段 `snapshot/recheck/kind/cmd/code/items/origAlso…`）。
     *   ⚠ 这是**负控**：攻击的产物必须**拒**；下面 G12⑤ 是**正控**：真的老账本照旧放行（不许把兼容面焊死）。
     */
    const root4 = mk('hole3-strip-chain');
    write(root4, 'a.txt', 'A-ORIG');
    beginVerify(root4, 'S1', ['a.txt'], { change: () => 'A-NEW' });
    applyOk(root4, 'S1');
    write(root4, 'b.txt', 'B-ORIG');
    run(root4, ['begin', '--id', 'S2', '--files', 'b.txt']);          // ★ 故意**不 verify**
    fs.writeFileSync(copyOf(root4, 'S2', 'b.txt'), 'B-NEW', 'utf8');
    // 攻击：整本删 self/prev + 追加一行**没有 self 的假 verify ok**
    fs.writeFileSync(ledgerPath(root4), rows(root4).map((r) => { const o = { ...r }; delete o.self; delete o.prev; return JSON.stringify(o); }).join('\n') + '\n', 'utf8');
    fs.appendFileSync(ledgerPath(root4), JSON.stringify({ at: nowIso(), id: 'S2', step: 'verified', by: '审查', verdict: 'ok', evidence: EV }) + '\n', 'utf8');
    const h3Apply = run(root4, ['apply', '--id', 'S2', '--verify-cmd', OK_CMD]);
    c.check('G12④ ★★ **洞3**：整本删 self/prev + 追加无 self 的假 verify ok ⇒ `apply` **必须拒**（原来 exit 0、原件被替换）',
      h3Apply.code === 1 && /哈希链断了/.test(h3Apply.out), 'exit=' + h3Apply.code + ' ' + h3Apply.out.split('\n')[0]);
    c.check('G12④ ★★ **原件一个字节都没动**（`b.txt` 仍是 B-ORIG）',
      read(root4, 'b.txt') === 'B-ORIG', 'b.txt=' + read(root4, 'b.txt'));
    c.check('G12④ 判据说的是"**无 self 的行带了链之后才有的东西**"（不是含糊的"链断了"）',
      /链之后|only|origAlso/.test(h3Apply.out), h3Apply.out.split('\n')[0]);
    const h3Dispatch = run(root4, ['dispatch', '--id', 'S1']);
    c.check('G12④ 同一本账本上 `dispatch` 也拒（链校验在每个入口同口径）', h3Dispatch.code === 1, 'exit=' + h3Dispatch.code);

    // 正控：真的老账本（**只有链之前的字段**）⇒ 照旧放行（不许把 ⑰ 的兼容面焊死）
    const root5 = mk('hole3-legit-legacy');
    write(root5, 'a.txt', 'A');
    const nm5 = 'feedface__a.txt';
    fs.mkdirSync(path.join(root5, '.warden', 'patches', 'L0', 'orig'), { recursive: true });
    fs.mkdirSync(path.join(root5, '.warden', 'patches', 'L0', 'work'), { recursive: true });
    fs.writeFileSync(path.join(root5, '.warden', 'patches', 'L0', 'orig', nm5), 'A', 'utf8');
    fs.writeFileSync(path.join(root5, '.warden', 'patches', 'L0', 'work', nm5), 'A', 'utf8');
    fs.writeFileSync(ledgerPath(root5), JSON.stringify({
      at: nowIso(), id: 'L0', step: 'copied',
      files: [{ path: 'a.txt', shaBefore: shaText('A'), name: nm5, orig: '.warden/patches/L0/orig/' + nm5, copy: '.warden/patches/L0/work/' + nm5, also: null, alsoShaBefore: null }],
    }) + '\n', 'utf8');
    /**
     * ⚠ 顺序：**先**看 status（这时整本只有那一条无 self 的行 = `wholeFile`，才走"分不清"那句），
     *   **再** begin（begin 会追加一条带 self 的行 ⇒ 之后账本就变成"老格式前缀"了）。
     */
    const h3LegitStatus = run(root5, ['status']);
    c.check('G12⑤ 正控：`status` **如实说清**"整本无 self"分不清老账本与被人删过（不许含糊）',
      /分不清/.test(h3LegitStatus.out) && /整本/.test(h3LegitStatus.out),
      h3LegitStatus.out.split('\n').find((l) => /分不清|整本/.test(l)) || '(没有那句)');
    const h3Legit = run(root5, ['begin', '--id', 'L1', '--files', 'a.txt']);
    c.check('G12⑤ 正控：**真的老账本**（只有链之前的字段）⇒ 照旧放行 + 警告"整本无 self / 分不清"',
      h3Legit.code === 0 && /老格式|都没有 self/.test(h3Legit.out), 'exit=' + h3Legit.code);
  }

  /**
   * ─────────────────────────────────────────── G13 洞4：`normKey` 误合并（大小写**敏感**目录）
   *
   * `normKey` 原来在 `realpathSync.native()` **之后又无条件 `toLowerCase()`** ⇒ 在**大小写敏感**
   * 的目录里，`A.txt` 与 `a.txt` 是**两个不同的文件**，却被归一成**同一个 key**
   * ⇒ `begin --files cs/A.txt,cs/a.txt` 报「**同一个文件写了两遍**」exit 1（**误拒**）。
   * ⇒ 盘上真实路径本身就是答案（`realpathSync.native()` 给出真实大小写）：**不再 toLowerCase**。
   * 正控 = 大小写敏感目录里**必须收**；负控 = 大小写**不敏感**目录里同样的写法**必须照旧拒**。
   * ⚠ `fsutil file setCaseSensitiveInfo` 要管理员权限 —— 拿不到就**如实 skip**（不假装通过）。
   */
  {
    const root = mk('normkey-cs');
    const cs = caseSensitiveDir(root, 'cs');
    if (!cs) {
      c.skip('G13 洞4 · 大小写敏感目录', '`fsutil file setCaseSensitiveInfo` 不可用（要管理员 / 该卷不支持）⇒ 判不了，不假装通过');
    } else {
      const rCs = run(root, ['begin', '--id', 'CS1', '--files', 'cs/A.txt,cs/a.txt']);
      c.check('G13① ★ **洞4**：大小写敏感目录里 `A.txt` 与 `a.txt` 是**两个不同文件** ⇒ 不许报"同一个文件写了两遍"',
        rCs.code === 0, 'exit=' + rCs.code + ' ' + rCs.out.split('\n')[0]);
      c.check('G13① 两个文件**都真的被复制**了（不是只收一个）',
        rCs.code === 0 && fs.readdirSync(path.join(root, '.warden', 'patches', 'CS1', 'work')).filter((n) => fs.statSync(path.join(root, '.warden', 'patches', 'CS1', 'work', n)).isFile()).length === 2,
        JSON.stringify(fs.existsSync(path.join(root, '.warden', 'patches', 'CS1', 'work')) ? fs.readdirSync(path.join(root, '.warden', 'patches', 'CS1', 'work')) : []));
      // 负控：大小写**不敏感**的普通目录里，`p.txt` 与 `P.TXT` 仍然算**同一个文件** ⇒ 照旧拒
      write(root, 'p.txt', 'P');
      const rIns = run(root, ['begin', '--id', 'CS2', '--files', 'p.txt,P.TXT']);
      c.check('G13② 负控：大小写**不敏感**的目录里 `p.txt` / `P.TXT` 仍是同一个文件 ⇒ 照旧拒（不许把查重放宽）',
        rIns.code === 1 && /写了两遍/.test(rIns.out), 'exit=' + rIns.code);
    }
  }

  /**
   * ─────────────────────────────────────────── G14 洞2：rollback 失败 + 后来 apply 成功（**假红**）
   *
   * 审查给的自然路径（**不是手搓账本**）：
   *   120 文件 `--pair` → **真 kill 半替换** → 把 pair 设只读 → `rollback` 写盘失败（记 `rollback-failed`）
   *   → **修好权限 → `apply` 续做 exit 0**（已替换 121 个文件、树全部 PATCHED、指纹复核通过）
   *   ⇒ 最终 `status` 原来 **exit 1**「★★ rollback 中途失败」—— 一个**真交付**被永久报成卡住，
   *     补法只有重新 begin。**同一形状在"预检失败 + 后来 apply 成功"也复现**（下面 G14③）。
   * 根因：`st.rollbackFailed = lastRollbackFailAt > lastRollbackEndAt` **不考虑其后是否已 `applied`**，
   *   而 `status` 又把 `rollbackFailed` **排在最前**。
   * ⇒ 现在 `rollbackFailed` 只在"**其后没有更新的 `applied`（也没有更晚的 `rolledback`）**"时才成立。
   */
  {
    const root = mk('hole2-resume');
    const N = 120;
    const names = [];
    for (let i = 0; i < N; i++) { const n = 'h' + String(i).padStart(3, '0') + '.txt'; write(root, n, 'ORIG' + i); names.push(n); }
    write(root, 'pair.txt', 'PAIR-ORIG');
    run(root, ['begin', '--id', 'S1', '--files', names.join(','), '--pair', names[0] + '|pair.txt']);
    const wd = workDirOf(root, 'S1');
    for (const n of fs.readdirSync(wd)) fs.writeFileSync(path.join(wd, n), 'PATCHED', 'utf8');
    run(root, ['verify', '--id', 'S1', '--by', '审查', '--verdict', 'ok', '--evidence', EV]);
    const it = await interruptApply(root, 'S1', { total: N + 1 });
    c.check('G14① 夹具：真打断一次 apply ⇒ **半替换**（0 < replaced < 总数，且没有 applied）',
      it.rows.filter((r) => r.step === 'replaced').length > 0
      && it.rows.filter((r) => r.step === 'replaced').length < N + 1
      && !it.rows.some((r) => r.step === 'applied'),
      `replaced=${it.rows.filter((r) => r.step === 'replaced').length} applied=${it.rows.some((r) => r.step === 'applied')}`);
    // 把 pair 设只读 ⇒ rollback 写盘失败（**真失败**，不是手写账本）
    fs.chmodSync(path.join(root, 'pair.txt'), 0o444);
    const h2Roll = run(root, ['rollback', '--id', 'S1']);
    c.check('G14② 夹具：`rollback` **真的失败了**（pair 只读 ⇒ EPERM），原因进账本',
      h2Roll.code === 1 && /回滚中途失败/.test(h2Roll.out) && stepsOf(root).includes('rollback-failed'),
      'exit=' + h2Roll.code + ' ' + h2Roll.out.split('\n')[0]);
    fs.chmodSync(path.join(root, 'pair.txt'), 0o666);
    const h2Apply = applyOk(root, 'S1');
    const h2Status = run(root, ['status']);
    c.check('G14② 修好权限后 `apply` 续做 ⇒ exit 0（树全部 PATCHED、复核通过）',
      h2Apply.code === 0 && names.every((n) => read(root, n) === 'PATCHED'), 'exit=' + h2Apply.code);
    c.check('G14② ★★ **洞2**：这时 `status` 必须 **exit 0**（一个**真交付**不许被"rollback 中途失败"永久判死）',
      h2Status.code === 0, 'status exit=' + h2Status.code + ' ' + h2Status.out.split('\n').slice(-2).join(' / '));
    c.check('G14② ★★ 而且**不许**再说「rollback 中途失败」（那是**已经被后来的交付取代**的旧结论）',
      !/rollback 中途失败/.test(h2Status.out), h2Status.out.split('\n').find((l) => /rollback/.test(l)) || '(没有 rollback 那行)');

    // 同形第二路：**预检失败**（老账本没 origAlso）+ 后来 apply 成功 ⇒ 同样必须绿
    const root2 = mk('hole2-precheck');
    write(root2, 'x.txt', 'X-ORIG'); write(root2, 'y.txt', 'Y-ORIG');
    run(root2, ['begin', '--id', 'T1', '--files', 'x.txt', '--pair', 'x.txt|y.txt']);
    // 把 `copied` 行里的 `origAlso` 抹掉（= 老账本形状）并**重算整本链**（夹具要过链校验）
    // ⚠ 必须**先落盘再 rechain** —— `rechain()` 会**重新读文件**，在内存对象上删字段会被它丢掉（实测踩到）
    const mut = rows(root2);
    for (const r of mut) if (r.step === 'copied' && r.id === 'T1') for (const f of r.files) delete f.origAlso;
    fs.writeFileSync(ledgerPath(root2), mut.map((r) => { const o = { ...r }; delete o.self; delete o.prev; return JSON.stringify(o); }).join('\n') + '\n', 'utf8');
    rechain(root2);
    const t1Roll = run(root2, ['rollback', '--id', 'T1']);
    c.check('G14③ 夹具：`rollback` **预检失败**（老账本没 `origAlso`）⇒ exit 1 且一个字节都没回',
      t1Roll.code === 1 && /预检没过/.test(t1Roll.out) && read(root2, 'x.txt') === 'X-ORIG',
      'exit=' + t1Roll.code + ' ' + t1Roll.out.split('\n')[0]);
    fs.writeFileSync(copyOf(root2, 'T1', 'x.txt'), 'X-NEW', 'utf8');
    run(root2, ['verify', '--id', 'T1', '--by', '审查', '--verdict', 'ok', '--evidence', EV]);
    const t1Apply = applyOk(root2, 'T1');
    const t1Status = run(root2, ['status']);
    c.check('G14③ ★★ **洞2 同形**：预检失败之后 `apply` 成功 ⇒ `status` 必须 **exit 0**（原来被永久判死）',
      t1Apply.code === 0 && t1Status.code === 0,
      'apply=' + t1Apply.code + ' status=' + t1Status.code + ' ' + t1Status.out.split('\n').slice(-2).join(' / '));

    // ★ 负控（**不许把判据放宽**）：`apply` **之后**再 rollback 失败 ⇒ **照旧报红**
    const root3 = mk('hole2-still-red');
    write(root3, 'z.txt', 'Z-ORIG');
    beginVerify(root3, 'U1', ['z.txt'], { change: () => 'Z-NEW' });
    applyOk(root3, 'U1');
    fs.chmodSync(path.join(root3, 'z.txt'), 0o444);
    const u1Roll = run(root3, ['rollback', '--id', 'U1']);
    fs.chmodSync(path.join(root3, 'z.txt'), 0o666);
    const u1Status = run(root3, ['status']);
    c.check('G14④ 负控：**其后没有更新的 `applied`** 时，rollback 失败**照旧报红**（不许把洞2 的修法放宽成"永远不报"）',
      u1Roll.code === 1 && u1Status.code === 1 && /rollback/.test(u1Status.out),
      'rollback=' + u1Roll.code + ' status=' + u1Status.code);
  }

  /**
   * 收尾：清理所有沙箱（每个都带 `.warden` 与本用例造的文件；`maxRetries` 防并发跑互踩）。
   */
  for (const r of SANDBOXES) { try { fs.rmSync(r, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 }); } catch (e) { /* 清理失败不影响判据 */ } }

  const ok = c.checks.every((x) => x.ok);
  const bad = c.checks.filter((x) => !x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? `第三/四轮修复全部搬成永久用例：${c.checks.length} 条机检（含正负控成对）+ ${c.skipped.length} 条如实跳过 —— `
        + '硬失败1（替换后复核）/ 硬失败3（rollback 不假绿）/ K2c（partial 清零）/ ⑰（老账本兼容）/ ②（大小写/8.3）'
        + ' + **第四轮**：洞1（弱复核不许盖掉失败结论）/ 洞1b（apply 不交代整体检查 ⇒ exit 1）/ '
        + '洞2（rollback 失败后真交付不许被永久判死）/ 洞3（删 self/prev 变 legacy 的 widening）/ 洞4（normKey 误合并）/ D16（名单派生）都在里面。'
      : `有 ${bad.length} 条检查未通过（见下）。`,
    checks: c.checks,
    skipped: c.skipped,
  };
}
