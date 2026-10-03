#!/usr/bin/env node
/**
 * preset 行自检：**别把 DSH 自带 `standard` 里有的启用行弄丢。**
 *
 * ## 为什么要有这个文件（一次真实的翻车）
 *
 * 2026-10-03：GUI 里「九月项目团」显示**红色「加载失败」**，而且**建不了新会话**；
 * 但 `node install.mjs --verify-boot --selftest` **全绿、exit 0**，boot 日志**一个字错都没有**。
 *
 * 真凶：preset 里 `workflow-ptc` 那行被删了，而它是 `workflowEngine` 服务的**唯一提供者**。
 * 于是 `tool-workflow` 与 `tool-ralph` 两行 inject 的 `workflowEngine` 永远拿不到
 * → `auditRows()` 记进 **`pending`** → `diagnostic()` 返回 `[...failed, ...pending]`
 * → **pending 同样让 GUI 显示「加载失败」**。
 *
 * 之所以 boot 验不出来：`diagnostic()` 是**惰性**的，只有 GUI 列 preset 或建会话时才求值。
 *
 * ## 为什么不用"解析每个插件、算出谁提供了哪些服务"
 *
 * 写过一版，是错的：靠 `super(ctx, "svc")` 这种文本特征猜提供者。
 * 结果 `dsh-workflow-ptc` 的服务声明形式对不上 → `workflowEngine` 被误判成"宿主提供"
 * → **测试永远绿**，把要抓的 bug 放过去了。
 * 教训和 preflight 那次一样：**判据没被实测证伪过，就等于没有判据。**
 *
 * 现在改成一条不猜的规则：
 *
 * > DSH 自带的 `standard` preset 是**已知的好的**（它就在你 GUI 里显示着）。
 * > 它有的**启用行**，我们也得有 —— 因为正是这些行在互相提供服务。
 * > 丢掉任何一行，都可能抽掉别人的 provider。
 *
 * 基准由 DSH 自己维护，升级会自动跟着变；它变了，这个测试会红 —— 那正是它该红的时候。
 *
 * 退出码：0 = 没丢行；1 = 丢了（GUI 上大概就是「加载失败」）；2 = 读不到基准（DSH 变了结构）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OURS = path.join(HERE, 'agent.cordis.yml')
const MARKER = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'

/* ── app.asar：自带一个极小的读取器，不为读几个文件去装依赖 ─────────────────── */
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const prefix = Buffer.alloc(16)
    if (fs.readSync(fd, prefix, 0, 16, 0) < 16) throw new Error('asar 太短')
    const jsonLen = prefix.readUInt32LE(12)
    const json = Buffer.alloc(jsonLen)
    fs.readSync(fd, json, 0, jsonLen, 16)
    return { header: JSON.parse(json.toString('utf8')), dataStart: 16 + jsonLen }
  } finally { fs.closeSync(fd) }
}

function entryIn(header, entryPath) {
  let node = header
  for (const part of entryPath.split('/')) { node = node.files?.[part]; if (!node) return false }
  return true
}

function asarRead(asarPath, entryPath) {
  const { header, dataStart } = readAsarHeader(asarPath)
  let node = header
  for (const part of entryPath.split('/')) { node = node.files?.[part]; if (!node) return undefined }
  if (node.files) return undefined
  const fd = fs.openSync(asarPath, 'r')
  try {
    const buf = Buffer.alloc(Number(node.size))
    fs.readSync(fd, buf, 0, buf.length, dataStart + Number(node.offset))
    return buf.toString('utf8')
  } finally { fs.closeSync(fd) }
}

/**
 * 找 DSH 自己的 app.asar。
 *
 * ⚠ **必须按内容校验，不能拿"第一个找到的"**：`LOCALAPPDATA\Programs` 下不止一个
 *   Electron 应用（实测还有 `@opencode-aidesktop`），`readdirSync` 谁先返回全看目录顺序 ——
 *   取第一个会**静悄悄地读到别人的 asar**，再报"读不到基准"，看起来像 DSH 换了目录结构。
 */
function findAppAsar() {
  const roots = [
    ...(process.env.DSH_APP_ASAR ? [path.dirname(process.env.DSH_APP_ASAR)] : []),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs')] : []),
    ...(process.env.ProgramFiles ? [process.env.ProgramFiles] : []),
  ].filter(Boolean)
  const seen = new Set()
  for (const root of roots) {
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const dir of entries) {
      if (!dir.isDirectory()) continue
      const candidate = path.join(root, dir.name, 'resources', 'app.asar')
      if (seen.has(candidate) || !fs.existsSync(candidate)) continue
      seen.add(candidate)
      try { if (entryIn(readAsarHeader(candidate).header, MARKER)) return candidate } catch { /* 不是 asar，跳过 */ }
    }
  }
  return undefined
}

/* ── 行级 YAML 解析：只要 `- id` / `name` / `disabled`，且要记住嵌套 group ──── */
/**
 * 不引 YAML 库：`js-yaml` 只存在于 app.asar（打包产物，不是可依赖的公开依赖），
 * 而引错版本比不引更糟。这个 preset 的形状是固定的一层 `- id:` + `name:` 加
 * `cordis:group` 下的嵌套，**按块**切分比逐行扫更不容易错（`disabled` 必须归到所属行）。
 */
function parseRows(yamlText) {
  const rows = []
  let current = null
  for (const raw of yamlText.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const line = raw.trim()
    if (line.startsWith('- id:')) {
      current = { id: line.slice(5).trim().replace(/^['"]|['"]$/g, ''), name: '', disabled: false }
      rows.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('name:')) current.name = line.slice(5).trim().replace(/^['"]|['"]$/g, '')
    else if (line === 'disabled: true') current.disabled = true
  }
  return rows.filter((r) => r.name && r.name !== 'cordis:group')
}

/* ── 主流程 ───────────────────────────────────────────────────────────────── */
const asarPath = findAppAsar()
if (!asarPath) {
  console.error('✗ 找不到 DSH 的 app.asar（找它的判据是里面能命中 standard.patch.yml）。')
  console.error('  可以用 DSH_APP_ASAR 环境变量指到它。')
  process.exit(2)
}
const standardText = asarRead(asarPath, MARKER)
if (!standardText) {
  console.error(`✗ 读不到 DSH 自带的 standard 基准 preset：${MARKER}`)
  console.error('  DSH 改了目录结构 —— 这正是本测试该红的时候。请按新结构更新它。')
  process.exit(2)
}

// ⚠ `@deepseek-ai/dsh-agent-preset` 是**这个 preset 自己的声明行**，不是它的成员。
//   每个 preset 文件都以它开头，而 install.mjs 在拼 profile patch 时会自己生成那一行
//   （名字还可能不同：`preset-standard` vs `preset-roles`）。拿 id 去比会永远对不上 ⇒ 排除。
const PRESET_DECL = '@deepseek-ai/dsh-agent-preset'
const isMember = (r) => r.name !== PRESET_DECL

const standard = parseRows(standardText).filter(isMember)
const ours = parseRows(fs.readFileSync(OURS, 'utf8')).filter(isMember)
const ourIds = new Set(ours.map((r) => r.id))

// standard 启用、而我们没有的 ⇒ 很可能抽掉了别人的服务提供者
const missing = standard.filter((r) => !r.disabled && !ourIds.has(r.id))
// 我们有、而 standard 没有的（自己加的，正常；列出来是为了让 diff 可读）
const extra = ours.filter((r) => !standard.some((s) => s.id === r.id))

console.log('preset 行自检：有没有丢掉 standard 里的启用行')
console.log('─'.repeat(64))
console.log(`基准 standard  ${standardRowsCount(standard)} 行（启用 ${standard.filter((r) => !r.disabled).length}）`)
console.log(`本 preset      ${ours.length} 行`)
console.log('')

if (extra.length) {
  console.log('我们额外加的行（不是问题，只是让你看清 diff）：')
  for (const r of extra) console.log(`  + ${r.id}  ${r.name}${r.disabled ? '  (disabled)' : ''}`)
  console.log('')
}

if (missing.length === 0) {
  console.log('✓ 没丢行 —— GUI 不会因为"服务没人提供"而显示「加载失败」。')
  console.log('  对照：`workflow-ptc` 提供 `workflowEngine`；删掉它，tool-workflow 与')
  console.log('  tool-ralph 会永远 waiting，而 auditRows 把 **pending 也算失败**。')
  process.exit(0)
}

console.log(`✗ 丢了 standard 里 ${missing.length} 个启用行。GUI 上大概就是红色的「加载失败」，而且建不了会话：`)
for (const r of missing) console.log(`  · ${r.id}  ${r.name}`)
console.log('')
console.log('  这一行多半在被提供某个服务（`workflowEngine` 就是这么没的）。')
console.log('  要么把它加回来，要么**确认** preset 不需要它之后，整行 disabled: true')
console.log('  （`auditRows()` 会跳过 disabled 行）—— 别只是删掉，那会留一条永远 waiting 的行。')
process.exit(1)

function standardRowsCount(rows) { return rows.length }
