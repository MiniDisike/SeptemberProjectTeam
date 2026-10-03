#!/usr/bin/env node
/**
 * 发布前体检 —— 公有化守门人。
 *
 * **它回答一个问题：这份东西能不能直接 `git clone` 到别人的电脑上用？**
 * 两个具体子问题：
 *   ① 可移植吗？（有没有写死本机路径、盘符、用户名）
 *   ② 干净吗？（有没有夹带凭据、个人身份、私有台账）
 *
 * ⚠ 为什么要有它：这两个问题**都很难靠人眼看出来**。
 *   历史上真实翻过的车：`<WORKSPACE>` 占位符（别人机器上静默不加载）、
 *   写死的本机家目录、`package.json` 带 BOM 导致整包插件静默失效、
 *   CRLF 让 MANIFEST 的 sha256 在 Windows 上整片变红。
 *   ⇒ 宁可让这个脚本吵，也不要让别人在自己电脑上替我们调试。
 *
 * 用法：
 *   node preflight.mjs            # 只查 git 追踪的文件（默认；漏网文件更危险）
 *   node preflight.mjs --all      # 连未追踪的一起查（查本机垃圾用）
 *
 * 零依赖，Node 内置模块。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF = 'preflight.mjs'
const argv = new Set(process.argv.slice(2))

/* ──────────────────────────────────────────────────────────────
 * 一、可移植性：写死的本机路径
 *
 * ⚠ 这里的字面量**故意用 charCode 拼** —— 否则本脚本自己就带着"本机路径"
 *   的样本：既会被自己的规则扫出来，也会污染别人对仓库的搜索结果。
 * ────────────────────────────────────────────────────────────── */
const BS = String.fromCharCode(92)          // \
const WIN_USER = `${String.fromCharCode(67)}:${BS}Users${BS}`
const WIN_USER_F = `${String.fromCharCode(67)}:/Users/`
const WIN_PROGS = `${String.fromCharCode(67)}:${BS}Program Files`

/**
 * ⚠ 把一段**普通字符串**变成正则源，必须先把反斜杠转义（`\` → `\\`）。
 *   不转的话 `C:\Users\` 里的 `\U` 会被正则当成"转义 U"（在非 unicode 模式下
 *   等价于字母 U），于是 `\Users` 变成 `Users`，整条规则**永远匹配不到任何东西** ——
 *   而且它**不报错**，只是静悄悄地一条都抓不到。
 *   这不是假设：本工具第一版就是这么写的，
 *   结果所有基于 `\` 的家目录规则全是摆设（`/` 写法的那条没事，因为没有反斜杠）。
 *   ⇒ 下面统一走 `re()`，不许再直接 `new RegExp(带反斜杠的字符串)`。
 */
function re(src, flags = 'g') { return new RegExp(src.replace(/\\/g, '\\\\'), flags) }

const PORTABILITY_RULES = [
  { id: '写死本机家目录', re: re(WIN_USER + '[A-Za-z0-9_.-]+'), why: '写死了某个人的用户名目录，别人机器上根本不存在' },
  { id: '写死本机家目录·斜杠', re: re(WIN_USER_F + '[A-Za-z0-9_.-]+'), why: '同上（正斜杠写法）' },
  { id: '写死程序目录', re: re(WIN_PROGS), why: '写死了本机安装目录' },
  // ⚠ 这一条是补上一个真实的漏网：只查 `C:\Users\...` 的话，
  //   `F:\…\Documents\GitHub\<别人的工程名>\...` 会整个溜过去 ——
  //   实测就抓到过一条（用户名被抹成 <USER> 了，可**盘符 + 目录结构 + 工程名**还在）。
  //   ⇒ 判据不是"出现了盘符"，而是**盘符后面跟着个人目录或被打码的用户名**。
  //     `D:\` / `D://x` 这类教学示例（讲反斜杠归一化要用）满仓库都是；
  //     拦它们只会逼人把整条规则关掉 —— 那等于没写。
  { id: '疑似本机真实路径', re: /\b[A-Za-z]:[\\/](?:Users[\\/]|<[A-Za-z_]+>[\\/]|(?:Documents|Desktop|Downloads|Pictures|Videos|Music)[\\/])/g, why: '盘符后面跟着个人目录或被打码的用户名 —— 这形状几乎都是某台真机的路径' },
  { id: 'UNC 网络共享', re: /\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._$-]+\\/g, why: '写死了网络共享路径（多半带某个域/主机名）' },
  { id: '写死 mac 家目录', re: /\/Users\/[A-Za-z0-9_.-]{2,}/g, why: '写死了某个 macOS 用户的家目录' },
  { id: '写死 linux 家目录', re: /\/home\/[A-Za-z0-9_.-]{2,}/g, why: '写死了某个 Linux 用户的家目录' },
  { id: '环境变量展开符', re: /%(APPDATA|USERPROFILE|LOCALAPPDATA|HOMEDRIVE|HOMEPATH)%/g, why: '展开结果因机器而异，等于写死' },
  { id: 'file-url 指向本机家目录', re: /file:\/\/\/[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+/g, why: '补丁里只该有相对路径，或由安装器在运行时推导' },
  // ⚠ 下面两条**只在会被执行的代码里**查，不查注释、也不查 .md ——
  //   注释/文档里写 `<WORKSPACE>`、`file:///C:/…` 是**有价值**的（它在记录"这里以前栽过什么"），
  //   而字符串字面量 / 配置值里的它们才会被 DSH 当成相对路径、导致**静默不加载**。
  //   ⇒ 按"这行会不会被解析"划线，而不是给模式开豁免：豁免一旦放开就成后门。
  { id: 'file-url 绝对路径', re: /file:\/\/\/[A-Za-z]:\//g, why: '补丁里只该有相对路径，或由安装器在运行时推导', codeOnly: true },
  { id: '工作区占位符', re: /<(WORKSPACE|WORKSPACE_PATH|REPO_ROOT|PROJECT_ROOT)>/g, why: 'DSH 解析不了占位符 ⇒ 当相对路径找 ⇒ **静默不加载**', codeOnly: true },
]

/** 会**被 DSH / Node 解析**的文件类型 —— 占位符规则只在这里生效。 */
const CODE_EXT = /\.(js|mjs|cjs|ts|mts|cts|ya?ml|json)$/i

/**
 * 允许出现的"合成路径"——它们是**测试夹具或文档反例**，不是真实机器。
 * ⚠ 逐条列出，不搞通配豁免：豁免一旦放开就变成藏污纳垢的后门。
 */
const PORTABILITY_ALLOW = [
  { re: re(WIN_USER + '<[a-z_-]+>'), why: '文档里的占位写法，不是真实路径' },
  { re: re(WIN_USER + 'user'), why: '注释里举的反例（用通用名 user）' },
  { re: /\/home\/u\//g, why: 'selftest 夹具里的假家目录' },
  { re: /\/home\/user\b/g, why: 'selftest 夹具里的假家目录（Unix 分支判据要用）' },
  // ⚠ 按**文件**限定的豁免 —— 只放这一个文件里的这一种写法。
  //   为什么它合法：`report-spill.selftest.mjs` 的负控用例故意把 `<WORKSPACE>`
  //   当成"一个根本不存在的路径"喂进去，测的就是"根目录不存在时不许崩"。
  //   把它换成真路径，这个用例就失去意义了。
  { files: /report-spill\.selftest\.mjs$/, re: /<WORKSPACE>/g, why: '负控夹具：故意用"不存在的路径"测不许崩；换成真路径反而废掉这个用例' },
]

/* ── 二、隐私：凭据 / 个人身份 ────────────────────────────── */
const SECRET_RULES = [
  { id: 'OpenAI 样式密钥', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { id: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { id: 'GitHub 细粒度令牌', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { id: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: '字面量密钥赋值', re: /\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"\s${}<>]{12,}['"]/gi },
  { id: 'URL 里带凭据', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/g },
  { id: 'PEM 块', re: /\bMII[A-Za-z0-9+/]{40,}={0,2}/g },
]

/** 邮箱：文档里可以留 `you@example.com` 这类样例，真实的一律拦。 */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const EMAIL_ALLOW = /^(example|test|localhost|you|your|user|name|noreply|no-reply)@/i

/* ── 三、不该进版本库的东西 ───────────────────────────────── */
const FORBIDDEN_FILES = [
  { re: /(^|\/)\.warden\//, why: '项目台账：会写进用户逐字原话与绝对路径' },
  { re: /^HANDOFF\.md$/i, why: '个人交接报告，含本机绝对路径' },
  { re: /_tmp_.*\.mjs$/, why: '一次性探针，含本机绝对路径' },
  { re: /-debug\.jsonl$/, why: '常驻插件写进 cwd 的调试日志' },
  { re: /team-guard-probe\.jsonl$/, why: '插件运行时产物' },
  { re: /\.bak-before-/, why: '改盘前的备份，含旧内容' },
  { re: /^\.merkle-snapshot\.json$/, why: '本机文件指纹缓存：只有哈希与修改时间，无代码引用，会过期' },
  { re: /(^|\/)node_modules\//, why: '依赖' },
  { re: /(^|\/)install-out\//, why: '安装器本机产物（含本机路径的 patch 层与日志）' },
  { re: /^\.env$/, why: '环境变量' },
  { re: /\.pem$|\.key$|\.p12$|\.pfx$/i, why: '密钥文件' },
  { re: /[\u4e00-\u9fa5]*\u4ea4\u63a5[\u4e00-\u9fa5]*\.md$/, why: '工程交接文件（含本机路径与过程留痕）' },
]

/* ────────────────────────────────────────────────────────── */

const exists = (p) => { try { fs.accessSync(p); return true } catch { return false } }
const hash = (b) => createHash('sha256').update(b).digest('hex')

function git(...args) {
  const r = spawnSync('git', ['-C', HERE, ...args], { encoding: 'utf8' })
  return (r.stdout ?? '').split(/\r?\n/).filter(Boolean)
}

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(abs, out)
    else out.push(abs)
  }
  return out
}

/** 二进制扫了也是噪声，直接跳过。 */
function isBinary(abs) {
  const fd = fs.openSync(abs, 'r')
  try {
    const b = Buffer.alloc(4096)
    const n = fs.readSync(fd, b, 0, 4096, 0)
    return b.subarray(0, n).includes(0)
  } finally { fs.closeSync(fd) }
}

/** 这一行是不是注释？（只认整行是注释；行尾注释算"会执行的代码"，宁可多报） */
function isCommentLine(line) {
  return /^\s*(\/\/|\/\*|\*|#|<!--)/.test(line)
}

const findings = []
const infos = []
const hit = (rule, file, line, text, why) => findings.push({ rule, file, line, text: String(text).slice(0, 140), why })
const info = (rule, file, line, text) => infos.push({ rule, file, line, text: String(text).slice(0, 140) })

const rels = argv.has('--all')
  ? walkFiles(HERE).map((p) => path.relative(HERE, p).split(path.sep).join('/'))
  : git('ls-files')
const files = [...new Set(rels)].filter((r) => r && r !== SELF && exists(path.join(HERE, r)))
if (!files.length) {
  console.error('✗ 一份文件都没列出来 —— 是在 git 仓库里跑的吗？（`--all` 可以绕过 git）')
  process.exit(2)
}

console.log('task-warden 发布前体检')
console.log('='.repeat(52))
console.log(`扫描 ${files.length} 个文件（${argv.has('--all') ? '本机全部' : 'git 追踪的'}；不含 ${SELF} 自己）\n`)

// 规则 1：不该进版本库的文件
for (const rel of files) {
  for (const f of FORBIDDEN_FILES) {
    if (f.re.test(rel)) hit(f.why, rel, 0, rel, '从版本库里去掉，并加进 .gitignore')
  }
}

// 逐文件扫描
let scanned = 0
for (const rel of files) {
  let buf
  try { buf = fs.readFileSync(path.join(HERE, rel)) } catch { continue }
  if (buf.includes(0)) continue                        // 二进制
  scanned++
  const text = buf.toString('utf8')
  const lines = text.split(/\r?\n/)

  // BOM / CRLF —— 正是把整包插件静默废掉的那两样，每次发布都值得查
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    hit('文件开头有 UTF-8 BOM', rel, 1, 'EF BB BF', 'DSH 的 JSON.parse 会挂 ⇒ 该文件相关的插件静默不加载')
  }
  if (/\r\n/.test(text)) {
    hit('含 CRLF', rel, 0, 'CRLF', 'MANIFEST 的 sha256 在 Windows 上会整片对不上')
  }

  const scan = (rules) => {
    for (const rule of rules) {
      const rx = new RegExp(rule.re.source, rule.re.flags)
      lines.forEach((line, i) => {
        // codeOnly 的规则：只在"会被解析的文件"里的"非注释行"上查。
        // 注释与 .md 文档**不会被 DSH 解析**，写在那儿是在留证据，不是缺陷。
        if (rule.codeOnly && (!CODE_EXT.test(rel) || isCommentLine(line))) return
        rx.lastIndex = 0
        let m
        while ((m = rx.exec(line)) !== null) {
          // 豁免是拿**整行**去判，不是拿命中片段。
  // ⚠ 为什么：规则命中的是最短片段（`C:\Users\`），而豁免项描述的是**整条路径的形状**
  //   （`C:\Users\<user>\…`、`/home/user/…`）。拿片段判，豁免永远匹配不上 ——
  //   实测就因此把两条占位写法误报成真机路径。
  const allowed = PORTABILITY_ALLOW.find((a) => (!a.files || a.files.test(rel))
            && new RegExp(a.re.source, a.re.flags).test(line))
          if (allowed) info(`${rule.id}（豁免：${allowed.why}）`, rel, i + 1, m[0])
          else hit(rule.id, rel, i + 1, m[0], rule.why)
          if (m.index === re.lastIndex) rx.lastIndex++   // 防零宽死循环
        }
      })
    }
  }
  scan(PORTABILITY_RULES)
  scan(SECRET_RULES)

  lines.forEach((line, i) => {
    for (const m of line.match(EMAIL_RE) ?? []) {
      if (!EMAIL_ALLOW.test(m)) hit('疑似真实邮箱', rel, i + 1, m, '公开仓库里不该出现个人邮箱')
    }
  })
}

// MANIFEST 完整性
const manifest = path.join(HERE, 'MANIFEST.json')
if (!exists(manifest)) {
  hit('没有 MANIFEST.json', 'MANIFEST.json', 0, '', '备份完整性校验会永远报缺件')
} else {
  let m = null
  try { m = JSON.parse(fs.readFileSync(manifest, 'utf8')) } catch (e) {
    hit('MANIFEST.json 不是合法 JSON', 'MANIFEST.json', 0, e.message, '')
  }
  if (m?.files) {
    let bad = 0, missing = 0
    for (const f of m.files) {
      const abs = path.join(HERE, f.rel)
      if (!exists(abs)) { missing++; continue }
      if (hash(fs.readFileSync(abs)) !== f.sha256) bad++
    }
    if (missing) hit(`MANIFEST 列了 ${missing} 个不存在的文件`, 'MANIFEST.json', 0, '', '发布缺件：重新 --refresh-manifest')
    if (bad) hit(`MANIFEST 有 ${bad}/${m.files.length} 个 sha256 对不上`, 'MANIFEST.json', 0, '', '改了文件忘了 node install.mjs --refresh-manifest')
    if (!bad && !missing) info(`MANIFEST ${m.files.length}/${m.files.length} 一致`, 'MANIFEST.json', 0, '')
  }
}

/* ── 输出 ── */
for (const f of infos.slice(0, 12)) console.log(`  · ${f.rule}  ${f.file}:${f.line}  ${f.text}`)
if (infos.length > 12) console.log(`  · ……另有 ${infos.length - 12} 条豁免项未列出`)

if (!findings.length) {
  console.log(`\n  ✓ 扫了 ${scanned} 个文本文件：没有本机路径、没有凭据、没有不该进库的东西。`)
  console.log('  ✓ MANIFEST 一致。')
  console.log('\n' + '='.repeat(52))
  console.log('可以发了。')
  console.log('（这一条只证明"可移植 + 干净"；装得上装不上要另跑 `node install.mjs --verify-boot`。）')
  process.exit(0)
}

console.log('')
for (const f of findings) {
  console.log(`  ✗ [${f.rule}] ${f.file}:${f.line}`)
  if (f.text) console.log(`      ${f.text}`)
  if (f.why) console.log(`      → ${f.why}`)
}
console.log('\n' + '='.repeat(52))
console.log(`**${findings.length} 处拦下。** 这些不改掉就发出去，别人装的时候会踩。`)
process.exit(1)