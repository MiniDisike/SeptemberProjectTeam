#!/usr/bin/env node
/*
 * task-warden（九月项目团）安装器 / installer
 * =====================================================
 *
 * 一条命令装完，并**当场自检**：
 *
 *     node install.mjs                 # 装 + 自检
 *     node install.mjs --dry-run       # 只看要做什么，不落盘
 *     node install.mjs --check         # 不写任何东西，只报当前状态（退出码即结论）
 *     node install.mjs --verify-boot   # 额外用一个临时 profile 真启动一次，验 preset 挂得上
 *
 * 它解决的就是"换一台新电脑安装，错误太多"的那些坑 —— 每一个都在下面标了根因：
 *
 *  1. **UTF-8 BOM**   包根 package.json 带 BOM 时，DSH 的 peer-deps 校验
 *                     `JSON.parse` 失败 ⇒ 每一行插件都被标成
 *                     "disabling profile plugin row" ⇒ **静默不加载**（只打一行警告）。
 *                     扣掉 BOM：`normalizeRepo()`。
 *  2. **CRLF**        `.gitattributes` 只写 `* text=auto`，Windows 上
 *                     `core.autocrlf=true` 检出成 CRLF ⇒ MANIFEST 的 sha256 全对不上
 *                     （实测 101 个文件里 95 个不符）。归一化成 LF。
 *  3. **已退役机制**  INSTALL.md 老版本让你把 preset 放进 `~/.dsh/.agent-presets/roles/`、
 *                     改 `~/.dsh/settings.yaml`。当前 DSH **两个都不读了** ——
 *                     preset 现在是 profile patch 里一行 `@deepseek-ai/dsh-agent-preset` 的
 *                     `config.plugins`，默认值在 `agent-preset-registry` 行的 `config.default`。
 *  4. **缺 preset 声明** 只把 registry 的 `default` 设成 roles、却**没声明 roles 这个 preset**
 *                     ⇒ 新会话照样是标准模式（或直接失败）。
 *  5. **包名对不上**  preset 里任何一行引用了当前 DSH 里**已经不发布**的包，
 *                     `agent-preset-registry` 的 `auditRows()` 就算它 failed
 *                     ⇒ preset `broken` 非空 ⇒ **GUI 拒绝「新建会话」**。
 *                     `validatePresetRows()` 按**装机包的真实清单**逐行核对，
 *                     缺包自动补 `disabled: true`（源文件不动，只改生成物）。
 *  6. **`./x.mjs` 路径** `anchorInsertedPluginNames()` 只对 patch 的 `insert` 直属行
 *                     （以及 `cordis:group` 的 `config`）把相对/绝对路径转 `file://`，
 *                     **不管 `config.plugins` 里嵌套的 name** ⇒ `team-guard.mjs` 必须写死
 *                     `file:///` URL，否则 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
 *  7. **`selectedDefault`** registry 的 `defaultId` 是 `selectedDefault ?? default`。
 *                     只写 `default` 而 `selectedDefault` 还指着别的 id ⇒ **装了等于没装**。
 *  8. **两份分叉**     `~/.dsh/skills/task-warden/` 与仓库里的 `01-skill/` 必须逐字节一致，
 *                     否则实验台在测旧代码。这里由 `mirror()` 保证。
 *
 * 零依赖：只用 Node 内置模块（这个包本身没有 node_modules，也不该有）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_SRC = path.join(HERE, '01-skill');
const PRESET_SRC = path.join(HERE, '02-preset-roles');
const PLUGIN_SRC = path.join(HERE, '03-host-plugin');
const OUT_DIR = path.join(HERE, 'install-out');

/** 6 个常驻 Host 插件，顺序与包根 cordis.patch.yml 一致。 */
const PLUGIN_IDS = [
  'warden-watch',
  'context-dedup',
  'role-voices',
  'handover-gate',
  'branch-guard',
  'report-spill',
];

const BEGIN = '# >>> task-warden managed block (install.mjs) — 手改会被下次安装覆盖 <<<';
const END = '# <<< task-warden managed block <<<';

// ────────────────────────────────────────────────────────────── 小工具 ──

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('  ! ' + a.join(' '));
const fail = (...a) => { console.error('  ✗ ' + a.join(' ')); };
let problems = 0;
const note = (msg) => { problems++; fail(msg); };

function parseArgs(argv) {
  const opts = {
    dshHome: process.env.DSH_HOME || '',
    profile: '',
    packages: process.env.DSH_PACKAGES_DIR || '',
    preset: 'roles',
    dryRun: false,
    check: false,
    verifyBoot: false,
    normalize: true,
    keepSelected: false,
    noPreset: false,
    noPlugins: false,
    refreshManifest: false,
    repoOnly: false,
    selftest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined) { console.error(`缺参数：${a}`); process.exit(2); }
      return v;
    };
    if (a === '--dsh-home') opts.dshHome = need();
    else if (a === '--profile') opts.profile = need();
    else if (a === '--packages') opts.packages = need();
    else if (a === '--preset') opts.preset = need();
    else if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--verify-boot') opts.verifyBoot = true;
    else if (a === '--no-normalize') opts.normalize = false;
    else if (a === '--keep-selected') opts.keepSelected = true;
    else if (a === '--no-preset') opts.noPreset = true;
    else if (a === '--no-plugins') opts.noPlugins = true;
    else if (a === '--refresh-manifest') opts.refreshManifest = true;
    else if (a === '--repo-only') { opts.repoOnly = true; opts.refreshManifest = true; }
    else if (a === '--selftest') opts.selftest = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else { console.error(`不认识的参数：${a}`); process.exit(2); }
  }
  return opts;
}

function usage() {
  log(`用法 / usage
  node install.mjs [选项]

  --dsh-home <dir>   DSH 家目录（默认 $DSH_HOME，其次 ~/.dsh）
  --profile <name>   要写哪个 profile（默认自动探测；只有 desktop/web 之类）
  --packages <dir>   装机包清单目录（默认自动在"用户家目录\\AppData\\Local\\Programs"下找 app.asar）
  --preset <id>      preset id（默认 roles）
  -n, --dry-run      只打印计划，不落盘
  --check            只体检，不写任何文件；退出码即结论
  --verify-boot      额外用临时 profile 真启动一次，验 preset 真的挂得上（慢）
  --no-normalize     不改仓库里的 BOM/换行
  --keep-selected    不动 registry 的 selectedDefault
  --no-preset / --no-plugins   只装其中一半
  --selftest             装完再把 7 个自检全跑一遍（慢，要几分钟）
  --refresh-manifest           归一化之后重算 MANIFEST.json（改了包里的文件就跑这个）
  --repo-only           只做仓库自己的事（去 BOM / CRLF→LF / 重算 MANIFEST），
                       **一个字都不往机器上装** —— 维护者改完文件想重算清单时用
`);
}

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

function readText(p) {
  const buf = fs.readFileSync(p);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 永远写 LF、无 BOM：DSH 的 peer-deps 校验要用 JSON.parse 读包根 package.json。
  fs.writeFileSync(p, text.replace(/\r\n/g, '\n'), 'utf8');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function mirror(srcDir, dstDir, label) {
  if (!exists(srcDir)) { note(`${label}：源目录不存在 ${srcDir}`); return; }
  // 目标先删后拷：Copy-Item -Recurse / fs.cp 对已存在目标会嵌套出 experiments\experiments\。
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  fs.cpSync(srcDir, dstDir, { recursive: true });
  log(`  · ${label} → ${dstDir}`);
}

// ────────────────────────────────────────────────── 定位 DSH 与装机包 ──

function resolveDshHome(explicit) {
  const cands = [
    explicit,
    process.env.DSH_HOME,
    path.join(os.homedir(), '.dsh'),
  ].filter(Boolean);
  for (const c of cands) {
    if (exists(path.join(c, 'profiles'))) return path.resolve(c);
  }
  if (cands.length) return path.resolve(cands[0]);
  return null;
}

function resolveProfile(dshHome, explicit) {
  const dir = path.join(dshHome, 'profiles');
  if (!exists(dir)) return null;
  const names = fs.readdirSync(dir).filter((n) => exists(path.join(dir, n)));
  if (explicit) return exists(path.join(dir, explicit)) ? explicit : null;
  // 有 cordis.patch.yml 的优先（那才是要写用户层配置的 profile）。
  const withPatch = names.filter((n) => exists(path.join(dir, n, 'cordis.patch.yml')));
  if (withPatch.includes('desktop')) return 'desktop';
  if (withPatch.length) return withPatch[0];
  return names[0] ?? null;
}

/** 读 app.asar 的目录头：返回包名集合 + 全部条目路径（用来确认"这真的是 DSH 的 asar"）。 */
function asarProbe(asarPath) {
  try {
    const fd = fs.openSync(asarPath, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonLen = head.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    fs.closeSync(fd);
    const paths = new Set();
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const full = prefix ? `${prefix}/${name}` : name;
        if (entry.files) walk(entry, full);
        else paths.add(full);
      }
    };
    walk(header, '');
    const packages = new Set();
    for (const p of paths) {
      const m = /^dsh\/node_modules\/@deepseek-ai\/(dsh-[^/]+)\/package\.json$/.exec(p);
      if (m) packages.add(m[1]);
    }
    return { packages, paths };
  } catch { return null; }
}

/** 这才叫 DSH 的 app.asar（有 dsh CLI 入口 + 一堆 dsh-* 包）。 */
const DSH_CLI = 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
function isDshAsar(asarPath) {
  const probe = asarProbe(asarPath);
  return !!probe && probe.paths.has(DSH_CLI) && probe.packages.size > 50;
}

function locateAppAsar() {
  const bases = [...new Set([process.env.LOCALAPPDATA, path.join(os.homedir(), 'AppData', 'Local')].filter(Boolean))];
  const found = [];
  for (const base of bases) {
    const programs = path.join(base, 'Programs');
    if (!exists(programs)) continue;
    for (const name of fs.readdirSync(programs)) {
      const p = path.join(programs, name, 'resources', 'app.asar');
      if (exists(p)) found.push({ dir: name, p });
    }
  }
  // 同目录下可能还装着别的 Electron 应用（实测就踩到过 @opencode-aidesktop）：
  // 名字像 DSH 的排前面，其余按"真的含 dsh CLI"筛。
  found.sort((a, b) => (/(deepseek|^dsh)/i.test(b.dir) ? 1 : 0) - (/(deepseek|^dsh)/i.test(a.dir) ? 1 : 0));
  for (const f of found) if (isDshAsar(f.p)) return f.p;
  return null;
}

function packagesFromDir(dir) {
  try {
    return new Set(fs.readdirSync(dir).filter((n) => n.startsWith('dsh-')));
  } catch { return null; }
}

function resolvePackages(explicit) {
  const cands = [];
  if (explicit) cands.push(['--packages', explicit]);
  const asar = locateAppAsar();
  if (asar) cands.push(['asar', asar]);
  for (const base of [process.env.LOCALAPPDATA, path.join(os.homedir(), 'AppData', 'Local')].filter(Boolean)) {
    const programs = path.join(base, 'Programs');
    if (!exists(programs)) continue;
    for (const name of fs.readdirSync(programs)) {
      const un = path.join(programs, name, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai');
      if (exists(un)) cands.push(['dir', un]);
    }
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const homeDir = path.join(home, 'dsh', 'node_modules', '@deepseek-ai');
  if (exists(homeDir)) cands.push(['dir', homeDir]);

  for (const [kind, p] of cands) {
    if (kind === 'asar') {
      const probe = asarProbe(p);
      if (probe?.packages.size) return { set: probe.packages, source: p };
    } else {
      const set = packagesFromDir(p);
      if (set?.size) return { set, source: p };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────── preset 行扫描/校验 ──

/**
 * 行级扫描 `- id:` 行，抽出 id / name / disabled。
 * 够用即可：agent.cordis.yml 是我们自己排版良好的 indent-2 YAML，
 * 不值得为此引入一个 YAML 依赖（本包没有 node_modules，也不该有）。
 */
function scanRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s+id:\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const row = { id: m[2].replace(/^['"]|['"]$/g, ''), name: null, disabled: null, disabledExpr: false, line: i, indent };
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s*$/.test(l) || /^\s*#/.test(l)) continue;
      const cur = /^(\s*)/.exec(l)[1].length;
      if (cur <= indent && /^\s*-\s/.test(l)) break;   // 下一条同级行
      if (cur < indent) break;                          // 上级收尾
      const nm = new RegExp(`^\\s{${indent + 2}}name:\\s*(.+?)\\s*$`).exec(l);
      if (nm && !row.name) row.name = nm[1].replace(/^['"]|['"]$/g, '');
      const ds = new RegExp(`^\\s{${indent + 2}}disabled:\\s*(.+?)\\s*$`).exec(l);
      if (ds) {
        row.disabledExpr = ds[1].startsWith('!!js') || /[=<>!]/.test(ds[1]);
        row.disabled = ds[1].startsWith('!!js') ? 'expr' : ds[1];
        row.disabledLine = j;
      }
    }
    rows.push(row);
  }
  return rows;
}

/** `@deepseek-ai/dsh-tool-subagent-control/list-agents` → 包名部分 + 子路径部分。 */
function splitSpec(name) {
  const m = /^(@[^/]+\/[^/]+)(?:\/(.+))?$/.exec(name);
  if (!m) return null;
  return { pkg: m[1].replace(/^@[^/]+\//, ''), sub: m[2] ?? null };
}

function validatePresetRows(lines, pkgSet, label) {
  const rows = scanRows(lines);
  const injected = [];
  const unresolved = [];
  for (const row of rows) {
    if (!row.name) continue;
    if (/^['"]?(cordis:)/.test(row.name)) continue;          // cordis:group 等内建
    if (/^(file:|\.{1,2}[\\/]|([A-Za-z]:[\\/]))/.test(row.name)) continue; // 本地文件行，另行校验
    const spec = splitSpec(row.name);
    if (!spec) continue;
    if (row.disabled === 'true') continue;
    if (!pkgSet) { if (!row.disabledExpr) unresolved.push(row); continue; }
    if (pkgSet.has(spec.pkg)) continue;
    if (row.disabledExpr) {
      // `disabled: !!js ...` 是运行期求值，静态核对不了 —— 如实说"未核实"，不瞎改。
      unresolved.push(row);
      continue;
    }
    injected.push(row);
  }
  return { rows, injected, unresolved };
}

/** 在指定行的下面插入 `disabled: true`（若该行还没有 disabled 字段）。 */
function injectDisabled(lines, row) {
  const nameIdx = lines.findIndex((l, i) => i > row.line && i < (row.disabledLine ?? lines.length) &&
    new RegExp(`^\\s{${row.indent + 2}}name:`).test(l));
  const at = nameIdx >= 0 ? nameIdx + 1 : row.line + 1;
  lines.splice(at, 0, ' '.repeat(row.indent + 2) + 'disabled: true  # install.mjs：装机包里没有这个包');
  return lines;
}

// ───────────────────────────────────────────────────────── 生成 preset ──

/** 极简读 02-preset-roles/preset.yml 的 name / description（只认这两种形态）。 */
function readPresetMeta(file) {
  const lines = readText(file).split(/\r?\n/);
  let name = '九月项目团';
  let description = '';
  for (let i = 0; i < lines.length; i++) {
    const nm = /^name:\s*(.+?)\s*$/.exec(lines[i]);
    if (nm && name === '九月项目团') name = nm[1].replace(/^['"]|['"]$/g, '');
    const dm = /^description:\s*(.+?)\s*$/.exec(lines[i]);
    if (dm) {
      if (dm[1] === '>-' || dm[1] === '>' || dm[1] === '|') {
        const buf = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (!/^\s+\S/.test(lines[j])) break;
          buf.push(lines[j].trim());
        }
        description = buf.join(' ');
      } else description = dm[1].replace(/^['"]|['"]$/g, '');
    }
  }
  return { name, description };
}

function buildPresetPlugins(presetDir, pkgSet, report) {
  const src = path.join(presetDir, 'agent.cordis.yml');
  const raw = readText(src).split(/\r?\n/);
  const body = [];
  for (const line of raw) {
    // 这一段讲的是**已经退役**的 `.agent-presets/roles/` 安装位置，别再装进去。
    if (/^#\s*⚠ 本目录是/.test(line)) continue;
    if (/^#\s*工程工作副本在/.test(line)) continue;
    if (/^#\s*两边必须一致/.test(line)) continue;
    body.push(line.length ? ' '.repeat(10) + line : line);
  }

  const teamGuard = path.join(presetDir, 'team-guard.mjs');
  if (!exists(teamGuard)) {
    note(`team-guard.mjs 不在 ${presetDir} —— preset 会挂不上`);
    report.missingTeamGuard = true;
  }
  const tgUrl = pathToFileURL(teamGuard).href;
  const tgRe = /^(\s*)name:\s*['"]?\.\/team-guard\.mjs['"]?\s*$/;
  const idx = body.findIndex((l) => tgRe.test(l));
  if (idx < 0) {
    note('agent.cordis.yml 里找不到 `name: ./team-guard.mjs` 那一行');
  } else {
    const pad = tgRe.exec(body[idx])[1];
    body[idx] = `${pad}name: '${tgUrl}'`;
  }

  const { injected, unresolved } = validatePresetRows(body, pkgSet, 'preset');
  for (const row of injected) injectDisabled(body, row);
  report.autoDisabled = injected.map((r) => r.name);
  report.unresolved = unresolved.map((r) => r.id);
  return body.join('\n').replace(/\s+$/, '');
}

function yamlScalar(s) {
  if (/^[\w一-鿿][\w一-鿿 .·\-]*$/u.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

// ─────────────────────────────────────────────────── 合并进 profile patch ──

function isTopLevelArray(text) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    return t.startsWith('- ') || t === '-';
  }
  return true; // 空/全注释：由调用方按"新建文件"处理
}

function stripManagedBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return { text, removed: false };
  const stop = text.indexOf(END, start);
  if (stop < 0) return { text, removed: false };
  const before = text.slice(0, start).replace(/\n{3,}$/, '\n\n');
  const after = text.slice(stop + END.length).replace(/^\n/, '');
  return { text: (before + after).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', removed: true };
}

/** 这一小段 insert 行是不是本包留下的（含 id 命中，或 name 指进 task-warden 目录）。 */
function isTaskWardenRow(ids, block) {
  const id = ids[0];
  if (PLUGIN_IDS.includes(id)) return true;
  if (/^preset-/.test(id)) return true;
  return block.some((l) => /name:.*(task-warden|02-preset-roles|03-host-plugin|\.agent-presets[\\/]roles)/i.test(l));
}

/**
 * 删掉**上一轮手工**塞进 profile 的那些 insert 行。
 * 不做这件事的话，重装会在同一个 profile 里留下两套 id 相同的行
 * （老的 + 托管块里的），行为取决于加载器怎么处理重复 id —— 那是"看运气"，不是"装好了"。
 */
function removeTaskWardenRows(text, report) {
  // 先把**上一次**留下的那条说明注释全清掉，最后至多补一条回来。
  // ⚠ 必须在切分之前清：上一轮它落在被删掉的 `- insert:` 条目之外，
  //   留在 lines 里会让 `out.includes(noteLine)` 判不出来 ⇒ 每跑一次多一行。
  const NOTE = '# （旧的 task-warden insert 行已由 install.mjs 移除；新的在文件末尾的托管块里）';
  const lines = text.split(/\r?\n/).filter((l) => l !== NOTE);
  const out = [];
  let removedIds = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^-\s+insert:\s*$/.exec(lines[i]);
    if (!m) { out.push(lines[i]); i++; continue; }
    // 收集这个 `- insert:` 条目的全部行，直到下一个顶层 `- ` 或文件尾
    const entry = [lines[i]];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^-\s/.test(lines[j]) && !/^\s/.test(lines[j])) break;
      entry.push(lines[j]);
    }
    const kept = [];
    let k = 1;
    while (k < entry.length) {
      const rm = /^(\s*)-\s+id:\s*(.+?)\s*$/.exec(entry[k]);
      if (!rm) { k++; continue; }
      const ind = rm[1].length;
      const ids = [rm[2].replace(/^['"]|['"]$/g, '')];
      let e = k + 1;
      for (; e < entry.length; e++) {
        if (/^\s*$/.test(entry[e]) || /^\s*#/.test(entry[e])) continue;
        const cur = /^(\s*)/.exec(entry[e])[1].length;
        if (cur <= ind && /^\s*-\s/.test(entry[e])) break;
      }
      const block = entry.slice(k, e);
      if (isTaskWardenRow(ids, block)) removedIds.push(...ids);
      else kept.push(...block);
      k = e;
    }
    if (removedIds.length === 0 || kept.length) {
      out.push(entry[0], ...kept);
    }
    if (!kept.length && removedIds.length) out.push(NOTE);
    i = j;
  }
  report.legacyRows = removedIds;
  return out.join('\n');
}

/** 只改 agent-preset-registry 行里的 default / selectedDefault，不动别的 config。 */
function patchRegistryDefault(text, presetId, keepSelected, report) {
  const lines = text.split(/\r?\n/);
  let start = -1, indent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s+id:\s*['"]?agent-preset-registry['"]?\s*$/.exec(lines[i]);
    if (m) { start = i; indent = m[1].length; break; }
  }
  if (start < 0) {
    report.registryAdded = true;
    return { text, added: true };
  }
  // config 的键在 indent+4（`- id:` 在 indent，`config:` 在 indent+2，键在 indent+4）
  const keyRe = (k) => new RegExp(`^\\s{${indent + 4}}${k}:`);
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (/^-\s/.test(lines[j])) { end = j; break; }
  }
  const defIdxs = [];
  for (let j = start + 1; j < end; j++) {
    if (keyRe('default').test(lines[j])) defIdxs.push(j);
  }
  if (!defIdxs.length) {
    const cfgIdx = lines.findIndex((l, j) => j > start && j < end && new RegExp(`^\\s{${indent + 2}}config:\\s*$`).test(l));
    if (cfgIdx >= 0) {
      lines.splice(cfgIdx + 1, 0, ' '.repeat(indent + 4) + `default: ${presetId}`);
      report.defaultWritten = 'inserted';
    } else {
      lines.splice(end, 0, ' '.repeat(indent + 2) + 'config:', ' '.repeat(indent + 4) + `default: ${presetId}`);
      report.defaultWritten = 'inserted-with-config';
    }
  } else {
    lines[defIdxs[0]] = ' '.repeat(indent + 4) + `default: ${presetId}`;
    report.defaultWritten = 'replaced';
    // 之前版本误插过多余的 default:（会直接让 DSH 报 duplicated mapping key）
    if (defIdxs.length > 1) {
      for (const j of defIdxs.slice(1).reverse()) lines.splice(j, 1);
      report.duplicatesFixed = defIdxs.length - 1;
    }
  }
  // 上面的 splice 会挪动行号，selectedDefault 必须**重新**扫一遍
  const selIdxs = [];
  for (let j = start + 1; j < lines.length; j++) {
    if (/^-\s/.test(lines[j])) break;
    if (keyRe('selectedDefault').test(lines[j])) selIdxs.push(j);
  }
  const selIdx = selIdxs[0] ?? -1;
  if (!keepSelected && selIdx >= 0) {
    const cur = lines[selIdx].replace(/^.*selectedDefault:\s*/, '').trim();
    if (cur !== presetId) {
      lines[selIdx] = ' '.repeat(indent + 4) + `selectedDefault: ${presetId}`;
      report.selectedAligned = cur;
    }
    if (selIdxs.length > 1) {
      for (const j of selIdxs.slice(1).reverse()) lines.splice(j, 1);
    }
  } else if (keepSelected && selIdx >= 0) {
    report.selectedKept = lines[selIdx].replace(/^.*selectedDefault:\s*/, '').trim();
  } else if (!keepSelected) {
    report.selectedAbsent = true;
  }
  return { text: lines.join('\n'), added: false };
}

function buildManagedBlock({ pluginRows, presetBlock, registryNeeded, presetId }) {
  const parts = [BEGIN, '# 本块由 `node install.mjs` 生成。要改请改 02-preset-roles/ 或 03-host-plugin/ 再重装；', '# 手改这里会在下次安装时被整块覆盖。', ''];
  if (registryNeeded) {
    parts.push(
      '- id: agent-preset-registry',
      "  name: '@deepseek-ai/dsh-agent-preset-registry'",
      '  config:',
      `    default: ${presetId}`,
      ''
    );
  }
  parts.push('- insert:');
  for (const row of pluginRows) {
    parts.push(`    - id: ${row.id}`);
    parts.push(`      name: '${row.fileUrl}'`);
  }
  parts.push('');
  if (presetBlock) {
    parts.push('- insert:');
    parts.push(`    - id: preset-${presetId}`);
    parts.push("      name: '@deepseek-ai/dsh-agent-preset'");
    parts.push('      config:');
    parts.push(`        id: ${presetId}`);
    parts.push(`        name: ${presetBlock.name}`);
    parts.push(`        description: ${yamlScalar(presetBlock.description)}`);
    parts.push('        order: 2');
    parts.push('        plugins:');
    parts.push(presetBlock.plugins);
    parts.push('');
  }
  parts.push(END);
  return parts.join('\n') + '\n';
}

// ────────────────────────────────────────────────────────── 仓库归一化 ──

function normalizeRepo(enabled, report) {
  // ⚠ 2026-10-03：这里原来自己维护一份"哪些文件算包内容"的名单，
  //   结果 **LICENSE / THIRD-PARTY-NOTICES.md / .gitignore 全漏了** ——
  //   它们照样会被 MANIFEST 收录（shippedFiles() 里有），却永远保持 CRLF，
  //   于是在 Windows 上 `preflight` / MANIFEST 校验照红。
  //   ⇒ 单一事实来源：归一化的范围 == 发布清单的范围。
  const list = shippedFiles();

  const changed = [];
  for (const rel of list) {
    const abs = path.join(HERE, rel);
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) continue;                       // 二进制，不碰
    let text = buf.toString('utf8');
    const hadBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const norm = text.replace(/\r\n/g, '\n').replace(/^﻿/, '');
    if (norm === text && !hadBom) continue;
    changed.push((hadBom ? 'BOM ' : '') + 'CRLF '.trimEnd() + ' ' + rel);
    if (enabled) writeText(abs, norm);
  }
  report.normalized = changed;
  return changed;
}

function walkFiles(dir, cb) {
  if (!exists(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walkFiles(abs, cb); }
    else cb(abs);
  }
}

/**
 * 公开包里"该有哪些文件"的清单 —— 重算 MANIFEST 的依据。
 * 刻意**不**沿用旧 MANIFEST 的条目：旧清单里有 6 个文件（两个 .bak-before-*、
 * 一个 HANDOFF.md、context-dedup.status.json……）**在整个包里根本不存在**，
 * 于是"校验备份完整性"在每台机器上都报缺失。
 */
function shippedFiles() {
  const top = [
    '.gitattributes', '.gitignore', 'package.json', 'cordis.patch.yml',
    'install.mjs', 'README.md', 'INSTALL.md', 'AGENTS.md',
    'LICENSE', 'THIRD-PARTY-NOTICES.md',
  ];
  const out = [];
  for (const f of top) if (exists(path.join(HERE, f))) out.push(f);
  for (const dir of [SKILL_SRC, PRESET_SRC, PLUGIN_SRC, path.join(HERE, '04-config')]) {
    walkFiles(dir, (abs) => {
      const rel = path.relative(HERE, abs).split(path.sep).join('/');
      if (/\.bak-/.test(rel)) return;
      out.push(rel);
    });
  }
  return out.sort();
}

function refreshManifest(report) {
  const file = path.join(HERE, 'MANIFEST.json');
  const files = [];
  for (const rel of shippedFiles()) {
    const buf = fs.readFileSync(path.join(HERE, rel));
    files.push({ rel, size: buf.length, sha256: sha256(buf) });
  }
  const doc = {
    name: 'SeptemberProjectTeam / task-warden (public edition)',
    date: new Date().toISOString().slice(0, 10),
    note: 'Public edition. Machine-specific paths are derived at runtime by install.mjs; none are baked in. '
      + 'Hashes are computed over LF-normalized, BOM-stripped text — run `node install.mjs --refresh-manifest` after editing any shipped file.',
    files,
  };
  writeText(file, JSON.stringify(doc, null, 2) + '\n');
  report.manifestRefreshed = files.length;
  return files.length;
}

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

// ───────────────────────────────────────────────────────────────── 主流程 ──

async function main() {  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); return; }

  log('task-warden（九月项目团）安装器');
  log('='.repeat(52));

  const report = { normalized: [], autoDisabled: [], unresolved: [], legacyRows: [] };

  // 0. Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) note(`Node ${process.versions.node} 太旧（本包需要 ≥20 才有稳定的 fs.cp / import.meta.main）`);

  // 1. 归一化仓库（去 BOM / CRLF）
  if (!opts.check) {
    // dry-run 只数不改，别让人以为没落盘其实落盘了。
    const changed = normalizeRepo(opts.normalize && !opts.dryRun, report);
    if (changed.length) {
      log(`\n[1/6] 归一化 ${changed.length} 个文件（UTF-8 BOM / CRLF → LF）${opts.dryRun ? '〔dry-run：本次不改〕' : ''}`);
      for (const c of changed.slice(0, 12)) log(`      ${c}`);
      if (changed.length > 12) log(`      …还有 ${changed.length - 12} 个`);
    } else {
      log('\n[1/6] 仓库编码检查：无 BOM、无 CRLF');
    }
  } else {
    const changed = normalizeRepo(false, report);
    if (changed.length) note(`仓库里有 ${changed.length} 个文件带 BOM/CRLF（新电脑上会打 disabling profile plugin row）`);
  }

  // 1b. 重算 MANIFEST（必须在自检之前，否则自检会拿旧清单冤枉刚改过的文件）
  if (opts.refreshManifest && !opts.check && !opts.dryRun) {
    const n = refreshManifest(report);
    log(`\n[1b/6] MANIFEST.json 已重算：${n} 个文件（去掉了不存在的条目，sha256 按 LF 归一后的字节算）`);
  }

  // 1c. --repo-only：到此为止。
  // 维护者在**仓库**里改完文件、想重算清单时，不该顺带把自己的机器也装一遍 ——
  // 那既是副作用（本机 ~/.dsh、profile patch 都被动了），也是发布前的意外。
  if (opts.repoOnly) {
    log('\n' + '='.repeat(52));
    log('--repo-only：只归一化 + 重算 MANIFEST，**没有往机器上装任何东西**。');
    log('发布之前建议再跑一次：node preflight.mjs');
    return;
  }

  // 2. DSH 家目录 + profile
  const dshHome = resolveDshHome(opts.dshHome);
  if (!dshHome) {
    console.error('\n找不到 DSH 家目录。用 --dsh-home <dir> 指定（通常是**用户家目录下的 .dsh**）。');
    process.exit(1);
  }
  const profile = opts.profile || resolveProfile(dshHome, '');
  log(`\n[2/6] DSH 家目录 ${dshHome}`);
  log(`      profile      ${profile ?? '（没有 profiles/ 目录，先启动一次 DSH）'}`);
  if (!profile && !opts.check) { console.error('      ✗ 定不了 profile，退出。'); process.exit(1); }
  const patchFile = profile ? path.join(dshHome, 'profiles', profile, 'cordis.patch.yml') : null;

  // 3. 装机包清单
  const pkgs = resolvePackages(opts.packages);
  log(`\n[3/6] 装机包清单 ${pkgs ? path.dirname(pkgs.source) : '⚠ 没找到'}`);
  if (!pkgs) warn('拿不到 DSH 的包清单 ⇒ 无法核对 preset 里的包名，');
  if (!pkgs) warn('preset 挂不上时不会自动修（脚本会在最后把"未核实"逐条列出来）。');

  // 4. 落盘
  const pluginDir = path.join(HERE, 'plugin');
  const presetDir = path.join(HERE, 'preset-roles');
  const skillDir = path.join(dshHome, 'skills', 'task-warden');

  if (opts.check) {
    log(`\n[4/6] 体检`);
    doCheck({ dshHome, profile, patchFile, skillDir, pluginDir, presetDir, pkgs, report, opts });
  } else if (opts.dryRun) {
    log(`\n[4/6] --dry-run：以下步骤会被执行（本次不落盘）`);
    log(`      ① 归一化 ${report.normalized.length} 个文件的编码`);
    log(`      ② skill   ${SKILL_SRC} → ${skillDir}`);
    log(`      ③ plugins ${PLUGIN_SRC} → ${pluginDir}`);
    log(`      ④ preset  ${PRESET_SRC} → ${presetDir}`);
    log(`      ⑤ 改写   ${patchFile} 的 registry default + 托管块`);
    log(`      ⑥ 自检 + （可选）真启动验证`);
  } else {
    log(`\n[4/6] 安装`);
    mirror(SKILL_SRC, skillDir, 'skill');
    if (!opts.noPlugins) mirror(PLUGIN_SRC, pluginDir, '宿主插件');
    if (!opts.noPreset) mirror(PRESET_SRC, presetDir, 'preset 源文件');
  }

  // 5. 生成 + 合并
  let managedBlock = '';
  const presetMeta = readPresetMeta(path.join(PRESET_SRC, 'preset.yml'));
  // 真装时从**已落盘的副本**生成（team-guard 的 file:// URL 要指向那份）；
  // --check / --dry-run 不落盘，就从源目录生成，否则会对着上一版的陈旧副本下判断。
  const presetGenDir = (opts.check || opts.dryRun) ? PRESET_SRC : presetDir;
  const presetBlock = opts.noPreset ? null : {
    name: presetMeta.name,
    description: presetMeta.description || '九月项目团：需求监督层 + 8 席角色协议',
    plugins: buildPresetPlugins(presetGenDir, pkgs?.set ?? null, report),
  };
  const pluginRows = opts.noPlugins ? [] : PLUGIN_IDS.map((id) => ({
    id,
    fileUrl: pathToFileURL(path.join(pluginDir, `${id}.js`)).href,
  }));

  // 先把 profile 的"非托管部分"算出来（去旧托管块、去手工旧行、修 registry）。
  // 这一步必须在生成托管块**之前**：托管块里要不要自带 registry 行，
  // 取决于 profile 里本来有没有 —— 有就别再补第二行（keyed patch 行会整块替换 config，
  // 两行并存等于让加载顺序决定谁说了算）。
  let baseProfileText = '';
  let registryNeeded = true;
  let strippedRemoved = false;
  if (patchFile && exists(patchFile)) {
    const before0 = readText(patchFile);
    const stripped0 = stripManagedBlock(before0);
    strippedRemoved = stripped0.removed;
    baseProfileText = removeTaskWardenRows(stripped0.text, report);
    const patched0 = patchRegistryDefault(baseProfileText, opts.preset, opts.keepSelected, report);
    baseProfileText = patched0.text;
    registryNeeded = patched0.added;      // false = profile 里本来就有那行
  }

  managedBlock = buildManagedBlock({
    pluginRows, presetBlock, presetId: opts.preset, registryNeeded,
  });

  if (report.autoDisabled.length) {
    log(`\n      自动停用（装机包里没有这些包，不停用会导致 preset 整体 broken ⇒ 新建会话失败）：`);
    for (const n of report.autoDisabled) log(`        · ${n}`);
  }
  if (report.unresolved.length) {
    warn(`preset 里 ${report.unresolved.length} 行的包名未核实（disabled 是运行期表达式，静态判不了）：`);
    for (const id of report.unresolved) warn(`  · ${id}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const overlay = path.join(OUT_DIR, 'all.patch.yml');
  if (!opts.check && !opts.dryRun) writeText(overlay, managedBlock);

  // 验证用的那份 patch = **修好之后**的 profile 内容（先有鸡还是先有蛋）：
  // 验的正是"装完会长什么样"，而不是"现在这个还没修的文件长什么样"。
  const verifyPatch = patchFile
    ? path.join(OUT_DIR, 'verify.patch.yml')
    : overlay;
  if (patchFile && !opts.check && !opts.dryRun) {
    writeText(verifyPatch, baseProfileText.trimEnd() + '\n\n' + managedBlock);
  }

  // 先验后写：确认这份 patch 挂得上，再去改**正在用的** profile。
  if (opts.verifyBoot && !opts.check && !opts.dryRun) await verifyBoot(dshHome, verifyPatch, opts);
  if (problems && !opts.check && !opts.dryRun) {
    console.error('\n有东西没过验证 ⇒ 不去改 profile。修完再跑。');
    process.exit(1);
  }

  if (patchFile && !opts.check && !opts.dryRun) {
    const before = exists(patchFile) ? readText(patchFile) : '';
    if (before && !isTopLevelArray(before)) {
      console.error(`\n      ✗ ${patchFile} 的第一行不是顶层 YAML 数组 —— DSH 启动时会直接 throw。`);
      console.error('        我不替你改它（那可能夹着你的东西）。先把它修成数组，或用 --profile 指别的 profile。');
      process.exit(1);
    }
    const next = baseProfileText.trimEnd() + '\n\n' + managedBlock;
    const bak = `${patchFile}.bak-before-install-${stamp()}`;
    fs.writeFileSync(bak, before, 'utf8');
    writeText(patchFile, next);
    log(`\n[5/6] profile patch ${patchFile}`);
    log(`      备份        ${bak}`);
    log(`      托管块      ${strippedRemoved ? '已替换旧块' : '新写入'}`);
    if (report.legacyRows.length) {
      log(`      清旧行      移除 ${report.legacyRows.length} 条上一轮手工插入的行（${[...new Set(report.legacyRows)].join(', ')}）`);
    }
    if (report.defaultWritten === 'replaced') log(`      registry     default 改成 ${opts.preset}`);
    if (report.defaultWritten?.startsWith('inserted')) log(`      registry     补写 default: ${opts.preset}`);
    if (report.registryAdded) warn('profile 里没有 agent-preset-registry 行 ⇒ 已在托管块里补一行');
    if (report.selectedAligned) log(`      registry     selectedDefault ${report.selectedAligned} → ${opts.preset}（否则新会话不会用它）`);
    if (report.selectedAbsent) log(`      registry     没有 selectedDefault ⇒ default 生效`);
    if (report.selectedKept) log(`      registry     按 --keep-selected 保留 selectedDefault: ${report.selectedKept}`);
    if (report.duplicatesFixed) log(`      registry     顺手删掉 ${report.duplicatesFixed} 个重复的 default: 键（那是 DSH 启动会直接 throw 的东西）`);
  } else if (patchFile && (opts.check || opts.dryRun)) {
    const before = exists(patchFile) ? readText(patchFile) : '';
    const stripped = stripManagedBlock(before);
    const probe = { ...report };
    patchRegistryDefault(stripped.text, opts.preset, opts.keepSelected, probe);
    if (opts.check) {
      if (!stripped.removed) note('profile patch 里没有托管块 ⇒ 插件/preset 没挂上去');
      if (!/default:\s*roles/.test(before) && !/default:\s*'roles'/.test(before)) note('registry 的 default 不是 roles');
    }
  }

  // 6. 自检
  if (!opts.check && !opts.dryRun) {
    log(`\n[6/6] 自检`);
    doCheck({ dshHome, profile, patchFile, skillDir, pluginDir, presetDir, pkgs, report, opts });
  }
  if (opts.selftest && !opts.check && !opts.dryRun) await runSelftests({ skillDir, pluginDir, presetDir });

  if (opts.refreshManifest && opts.check) {
    note('--check 不写任何文件，所以没重算 MANIFEST；先单独跑一次 node install.mjs --refresh-manifest');
  }

  log('\n' + '='.repeat(52));
  if (problems) {
    fail(`发现 ${problems} 个问题（上面每条前面都有 ✗）。修完再重跑一次。`);
    process.exit(1);
  }
  if (opts.dryRun) { log('dry-run 结束：没有写任何文件。去掉 --dry-run 就会真的装。'); return; }
  if (opts.check) {
    log('体检结束：**没有写任何文件**。上面全绿 = 装是好的。');
    log('若要让"插件真的加载了"这件事有据可查，重启 DSH 之后跑：');
    log(`  node "${path.join(pluginDir, 'check-plugins-loaded.mjs')}"   # 退出码 0 = 6/6`);
    return;
  }
  log('装好了。还差两步：');
  log('  ① **重启 DSH**（插件代码被 Node 的 require 缓存住，不重启不生效）');
  log(`  ② 新开一个窗口 —— agent preset 只在**建会话时**挂载，老会话不会变。`);
  log(`     装好之后用这条确证插件真的加载了（退出码 0 = 6 个全在）：`);
  log(`       node "${path.join(pluginDir, 'check-plugins-loaded.mjs')}"`);
}

// ───────────────────────────────────────────────────────────── 自检 ──

function doCheck({ dshHome, profile, patchFile, skillDir, pluginDir, presetDir, pkgs, report, opts }) {
  // a. 编码
  if (opts.check) {
    const changed = normalizeRepo(false, report);
    if (changed.length) note(`仓库里有 ${changed.length} 个文件带 BOM/CRLF`);
  }
  // b. skill 两份一致
  if (exists(skillDir)) {
    let diff = 0, n = 0;
    walkFiles(SKILL_SRC, (abs) => {
      const rel = path.relative(SKILL_SRC, abs);
      n++;
      const dst = path.join(skillDir, rel);
      if (!exists(dst) || !fs.readFileSync(dst).equals(fs.readFileSync(abs))) diff++;
    });
    if (diff) note(`skill 装歪了：${diff}/${n} 个文件与仓库不一致（重跑 install.mjs 会覆盖）`);
    else log(`      ✓ skill ${n} 个文件与仓库逐字节一致`);
  } else if (!opts.dryRun) {
    note(`skill 没装到 ${skillDir}`);
  }
  // c. 插件文件在
  if (!opts.noPlugins) {
    const miss = PLUGIN_IDS.filter((id) => !exists(path.join(pluginDir, `${id}.js`)));
    // ⚠ 2026-10-03：全新克隆里 `plugin/` **本来就不存在**（它是安装产物，不是仓库内容）。
    //   原来一律报"缺 6 个"，在 `git clone` 完第一次跑 --check 的新用户看来像是包坏了 ——
    //   而那其实是**还没装**这个正常状态。区分这两种情况，报错的含义完全不同。
    if (miss.length && !exists(pluginDir)) {
      log(`      · 还没装过：${pluginDir} 不存在（全新克隆的正常状态）—— 直接跑 node install.mjs`);
    } else if (miss.length) {
      note(`宿主插件缺 ${miss.length} 个：${miss.join(', ')}`);
    } else {
      log(`      ✓ 6 个宿主插件在 ${pluginDir}`);
    }
  }
  // d. team-guard 在（preset 引用它）
  if (!opts.noPreset && !exists(path.join(presetDir, 'team-guard.mjs'))) {
    if (!exists(presetDir)) log(`      · 还没装过：${presetDir} 不存在（全新克隆的正常状态）—— 直接跑 node install.mjs`);
    else note(`team-guard.mjs 不在 ${presetDir} —— preset 会挂不上`);
  }
  // e. 包根 package.json 无 BOM
  const pkgJson = path.join(HERE, 'package.json');
  if (exists(pkgJson)) {
    const buf = fs.readFileSync(pkgJson);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      note('package.json 还带 UTF-8 BOM ⇒ DSH 会把每一行插件都标成 disabling profile plugin row');
    } else {
      try { JSON.parse(buf.toString('utf8')); log('      ✓ package.json 可被 JSON.parse（peer-deps 校验不会挂）'); }
      catch (e) { note(`package.json 不是合法 JSON：${e.message}`); }
    }
  }
  // f. preset 行 vs 装机包
  if (!opts.noPreset && pkgs) {
    const srcFile = path.join(PRESET_SRC, 'agent.cordis.yml');
    const { injected, unresolved } = validatePresetRows(readText(srcFile).split(/\r?\n/), pkgs.set, 'preset');
    const known = injected.filter((r) => r.disabled === 'true');
    const unknown = injected.filter((r) => r.disabled !== 'true');
    if (unknown.length) {
      for (const r of unknown) note(`preset 里有 ${unknown.length} 行引用了装机包里没有的包（install.mjs 会自动 disabled 掉）`);
    } else if (!unresolved.length) {
      log(`      ✓ preset 里启用的每一行，包都在装机包里（已核对 ${pkgs.set.size} 个包）`);
    }
  }
  // g. profile 托管块
  if (patchFile && exists(patchFile)) {
    const text = readText(patchFile);
    if (!text.includes(BEGIN)) note(`${patchFile} 里没有托管块`);
    else {
      const inBlock = text.slice(text.indexOf(BEGIN));
      const miss = PLUGIN_IDS.filter((id) => !new RegExp(`^\\s*- id: ${id}\\s*$`, 'm').test(inBlock));
      if (miss.length) note(`托管块里少了插件行：${miss.join(', ')}`);
      else if (!opts.noPreset && !inBlock.includes('@deepseek-ai/dsh-agent-preset')) note('托管块里没有 preset 声明行');
      else log('      ✓ profile 托管块齐全（插件行 + preset 声明）');
    }
    // 重复 id：重装前手工塞的老行没清干净，两套同名行会并存
    const outside = stripManagedBlock(text).text;
    const probe = { legacyRows: [] };
    const left = removeTaskWardenRows(outside, probe);
    const ids = [];
    for (const line of left.split(/\r?\n/)) {
      const m = /^\s*-\s+id:\s*(.+?)\s*$/.exec(line);
      if (m && (PLUGIN_IDS.includes(m[1]) || /^preset-/.test(m[1]))) ids.push(m[1]);
    }
    if (ids.length) {
      note(`托管块之外还残留 ${ids.length} 条 task-warden 行（${[...new Set(ids)].join(', ')}）—— 重跑 install.mjs 会清掉`);
    } else {
      log('      ✓ 托管块之外没有 task-warden 残影');
    }
    if (!isTopLevelArray(text)) note(`${patchFile} 不是顶层 YAML 数组 ⇒ DSH 启动直接 throw`);
    else log(`      ✓ ${path.basename(patchFile)} 是顶层 YAML 数组（不是就 boot 直接 throw）`);
  }
  // h. MANIFEST
  const manifest = path.join(HERE, 'MANIFEST.json');
  if (exists(manifest) && opts.check) {
    let m = null;
    try { m = JSON.parse(readText(manifest)); } catch { note('MANIFEST.json 不是合法 JSON'); }
    if (m?.files) {
      let bad = 0, missingF = 0;
      for (const f of m.files) {
        const abs = path.join(HERE, f.rel);
        if (!exists(abs)) { missingF++; continue; }
        if (sha256(fs.readFileSync(abs)) !== f.sha256) bad++;
      }
      if (missingF) note(`MANIFEST 里有 ${missingF} 个文件在包里根本不存在（发布缺件）`);
      if (bad) note(`MANIFEST 有 ${bad}/${m.files.length} 个 sha256 对不上`);
      if (!bad && !missingF) log(`      ✓ MANIFEST ${m.files.length}/${m.files.length} 一致`);
    }
  }
}

// ─────────────────────────────────────────────────── 真启动验证（可选）──

/**
 * 把包里 7 个自检都跑一遍，汇总成一张表。
 * 每个自检跑在自己的目录里（它们靠 `import.meta.url` 认目录），
 * 隔离跑 ⇒ 一个崩了不影响后面的，也别去改它们的 cwd。
 */
async function runSelftests({ skillDir, pluginDir, presetDir }) {
  const suite = [
    ['skill 主自检（正/负控）', path.join(skillDir, 'selftest.mjs'), []],
    ['brain 派单政策', path.join(skillDir, 'brain-policy.test.mjs'), []],
    ['执行前闸', path.join(pluginDir, 'gate.selftest.mjs'), []],
    ['preset 默认守卫', path.join(pluginDir, 'preset-default-guard.mjs'), ['--selftest']],
    ['加载确证脚本', path.join(pluginDir, 'check-plugins-loaded.selftest.mjs'), []],
    ['preset 形状', path.join(presetDir, 'preset-selftest.mjs'), []],
    ['角色协议加固', path.join(presetDir, 'team-guard.selftest.mjs'), []],
  ];
  log(`\n[7/7] 跑 ${suite.length} 个自检（会比较慢）`);
  const results = [];
  for (const [label, file, args] of suite) {
    if (!exists(file)) { results.push([label, '缺失', file]); continue; }
    const r = spawnSync(process.execPath, [file, ...args], {
      cwd: path.dirname(file), encoding: 'utf8', timeout: 900000,
      env: { ...process.env, ...(pluginDir ? { WARDEN_PLUGIN_DIR: pluginDir } : {}) },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    // 摘要行 = **倒着**找：先在"像结论"的行里找，再退而在任何行里找。
    // ⚠ 两个坑都得躲开：① 正向找会被用例名里夹带的 "exit 0"/"通过" 抢先命中；
    //   ② 某些自检退出时会多打一行运行日志（gate.selftest 的 `[warden-gate] …`），
    //   不带过滤地取末行就会把那句当成结论。
    const skip = /^[=\-─]{10,}$/;
    const noise = /^(⚠|注|\[符合\]|\[已拒收|✓|✗|·|\[warden-gate\]|\[role-voices\]|\[context-dedup\]|\[branch-guard\]|\[report-spill\])/;
    const lines = out.split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !skip.test(l) && !noise.test(l));
    const verdict = [...lines].reverse().find((l) => /通过|全绿|PASS/.test(l));
    results.push([label, r.status === 0 ? '通过' : `失败(${r.status})`, (verdict ?? lines[lines.length - 1] ?? '').slice(0, 90)]);
  }
  for (const [label, verdict, tail] of results) {
    if (verdict === '通过') log(`      ✓ ${label}  ${tail}`);
    else { log(`      ✗ ${label}  ${verdict}  ${tail}`); note(`自检没通过：${label}`); }
  }
}

async function verifyBoot(dshHome, verifyPatch, opts) {
  const appAsar = locateAppAsar();
  if (!appAsar) { note('--verify-boot 明确要验，但找不到 app.asar —— 这一步被跳过了，不算通过'); return; }
  const exe = findDshExe();
  if (!exe) { note(`--verify-boot 明确要验，但找不到 DSH 可执行文件（${appAsar} 同级没有 .exe）—— 跳过不算通过`); return; }
  const cli = path.join(appAsar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

  // 验证 profile 必须是**真组合**，不能是 `cordis.yml: []` 的空壳：
  // 空壳里没有 `shell` 服务、没有 `agent-preset-registry` 行，于是
  // `warden-watch` 与 `preset-roles` 都会停在 pending —— 那是**试验台的缺陷**，
  // 不是安装的缺陷，照着它下结论等于自己骗自己。
  // `--from-default-profile web` 用 DSH 自带的模板建一个一次性 profile
  // （可选的出厂 profile 只有 acp / headless / sdk / sdk-minimal / web；
  //   desktop 是 Electron 应用自己管的，CLI 不让直接 boot）。
  const prof = `tw-verify-${Date.now().toString(36)}`;
  const profDir = path.join(dshHome, 'profiles', prof);
  // ⚠ **不要预建这个目录**：`--from-default-profile` 见到目录已存在就直接 throw
  //   （"profile directory … already exists; choose an unused profile name"）。
  if (exists(profDir)) { note(`一次性验证 profile ${prof} 已被占用，换个名字重试`); return; }

  const env = { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' };
  const base = ['--expose-internals', cli, '--profile', prof, '--patch', verifyPatch];
  // `--from-default-profile` 只在**第一次**调用时带：它会把模板落盘，
  // 之后再带一次就会撞 "profile … already exists"。
  const initBase = [...base.slice(0, 4), '--from-default-profile', 'web', ...base.slice(4)];
  log(`\n[验] 一次性 profile ${prof}（出厂模板 web）+ ${path.basename(verifyPatch)}`);
  log('      ① --dump-config：只验组合树能成（注意它**不激活插件**，所以还要第 ② 步）');
  const dump = spawnSync(exe, [...initBase, '--dump-config'], { env, encoding: 'utf8', timeout: 180000 });
  const dumpOut = `${dump.stdout ?? ''}${dump.stderr ?? ''}`;
  writeText(path.join(OUT_DIR, 'dump-config.log'), dumpOut);
  const bad = dumpOut.split(/\r?\n/).filter((l) =>
    /disabling profile plugin row|agent preset .+:|failed to parse|must be a top-level YAML array|does not exist|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_ESM_URL_SCHEME|duplicated mapping key/.test(l));
  if (dump.status !== 0) {
    fail(`--dump-config 退出码 ${dump.status}（全文见 install-out/dump-config.log）：`);
    console.log(dumpOut.split('\n').slice(-20).map((l) => '      ' + l).join('\n'));
    problems++;
  } else {
    log('      ✓ --dump-config exit 0');
  }
  if (bad.length) { for (const b of [...new Set(bad)].slice(0, 8)) note(`组合树里出现可疑行：${b.trim()}`); }
  else log('      ✓ 组合树里没有 disabling / agent preset / 解析错误');

  // ② 真启动：挂上整个组合树，这才是"preset 真的挂上了"的证据
  if (!problems) await bootProbe({ exe, base, env, ledgerDir: path.join(os.tmpdir(), `tw-ledger-${Date.now().toString(36)}`) });
  fs.rmSync(profDir, { recursive: true, force: true });
}

/**
 * 真启动：一次性 profile + 待验证的 patch，最多 25 秒。
 * 两样证据：① 启动日志里没有 "disabling profile plugin row" / "agent preset …:"
 *          ② 插件自己在 apply() 第一行写的加载留痕，6 个键齐全。
 * ⚠ 留痕目录指到临时目录，**不污染**宿主自己的 plugin-ledger。
 */
async function bootProbe({ exe, base, env, ledgerDir }) {
  const ledger = ledgerDir;
  fs.mkdirSync(ledger, { recursive: true });
  log('      ② 真启动（最多 25 秒）…');

  const child = spawn(exe, [...base, '--no-open', '--port', '0'], {
    env: { ...env, WARDEN_PLUGIN_LEDGER: ledger },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d) => { out += d.toString(); });
  child.stderr?.on('data', (d) => { out += d.toString(); });

  const started = Date.now();
  let exited = null;
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (how) => { if (!settled) { settled = true; exited = how; resolve(); } };
    child.on('exit', (code, signal) => finish({ code, signal }));
    child.on('error', (e) => finish({ error: String(e) }));
    setTimeout(() => finish({ timeout: true }), 25000);
  });
  await done;
  // 起监听就别让它一直占着端口。注意只 kill **我们自己 spawn 的这个句柄**，
  // 绝不按命令行子串去 Stop-Process —— 那会连宿主 GUI 一起杀掉。
  try { child.kill(); } catch { /* 已经退了 */ }
  writeText(path.join(OUT_DIR, 'boot.log'), out);
  log(`      启动 ${((Date.now() - started) / 1000).toFixed(1)}s，退出 ${JSON.stringify(exited)}，日志 ${out.length} 字节 → install-out/boot.log`);

  const redFlags = out.split(/\r?\n/).filter((l) =>
    /disabling profile plugin row|agent preset .+:|peer dependencies cannot be validated|did not activate|ERR_UNSUPPORTED_ESM_URL_SCHEME|Cannot find module|failed to parse/.test(l));
  if (redFlags.length) {
    for (const l of [...new Set(redFlags)].slice(0, 8)) note(`启动日志报：${l.trim()}`);
  } else {
    log('      ✓ 启动日志里没有 disabling / agent preset / did-not-activate 报错');
  }
  if (!/http:\/\/127\.0\.0\.1:\d+/.test(out)) {
    warn('启动日志里没看到服务真的监听端口 —— 这一项未核实（组合树能成 ≠ 跑起来了）');
  }

  const ledgerFile = path.join(ledger, 'PLUGIN-LOADED.json');
  if (exists(ledgerFile)) {
    try {
      const keys = Object.keys(JSON.parse(readText(ledgerFile)).plugins ?? {});
      const miss = PLUGIN_IDS.filter((id) => !keys.includes(id));
      if (miss.length) note(`插件留痕缺 ${miss.length} 个：${miss.join(', ')}`);
      else log(`      ✓ 6 个插件都留了加载痕（${keys.length} 个键）`);
    } catch (e) { note(`留痕文件读不出来：${e.message}`); }
  } else {
    note(`没找到插件留痕 ${ledgerFile} —— 这一项**未核实**，不算通过（插件可能没被挂上）`);
  }
  fs.rmSync(ledger, { recursive: true, force: true });
}

function findDshExe() {
  const asar = locateAppAsar();
  if (!asar) return null;
  // app.asar → resources → 安装目录（exe 与 resources 同级）
  const dir = path.dirname(path.dirname(asar));
  if (!exists(dir)) return null;
  for (const n of fs.readdirSync(dir)) if (/\.exe$/i.test(n)) return path.join(dir, n);
  return null;
}

main();