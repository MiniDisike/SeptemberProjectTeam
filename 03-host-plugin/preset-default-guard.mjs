/**
 * 「九月项目团」**自动启用**守卫（用户 2026-09-17 要求的硬约束）
 *
 * 用户核心诉求（公开版已隐去原话）：
 *   做了插件却不启用等于白做，以后绝对不能改自动启用的这一项。
 *
 * 所以他给的不是"提醒一下"，是一条**不许被改动**的约束。这一项的实际开关是两处：
 *   ① 部署层：`dsh-web-app/cordis.patch.yml` 的 `agent-presets` 行 —— **出厂文件，绝不改**；
 *   ② 用户层：`$DSH_HOME/settings.yaml` 的 `agent-presets.default` —— **这才是被改掉的那一处**
 *      （实测：09-16 23:59 的备份 = roles，09-17 16:32 的备份 = standard）。
 * 用户文档是**盖在**部署默认之上的（`dsh-agent-presets/README.md`「Choosing the default preset」），
 * 所以只钉部署层没用 —— 必须有一个"发现被改就改回来"的闸。
 *
 * 本文件是**纯函数 + 显式 IO 分离**，决策可自检：
 *   node preset-default-guard.mjs --selftest
 * 由 `warden-watch.js` 在 boot 与每个轮次边界调用；动作会落进 `warden-watch-debug.jsonl`
 * （`ev: preset-default-ok` / `preset-default-healed` / `preset-default-error`），
 * 让"它到底有没有在看"变成可查的事实，而不是又一句承诺。
 *
 * ⚠ 只碰 `agent-presets:` 段里的 `default:` 一行 —— 用户要求不要删掉之前的 api，
 *   本闸**绝不允许**整文件重写。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 这一项必须长期等于这个值。改它 = 直接违背用户 2026-09-17 的硬约束。 */
export const REQUIRED_DEFAULT = 'roles'
// ⚠ 公开版：改成运行时推导（原来是写死 C:\Users\user\...）
export const DEFAULT_SETTINGS = path.join(os.homedir(), '.dsh', 'settings.yaml')

/**
 * 纯函数：给定 settings.yaml 全文，回答"要不要改、改成什么"。
 * 返回 { action: 'ok' | 'heal' | 'absent', next?, current?, why }
 *  - 找不到 `agent-presets:` 段 → 在文件末尾补一段（absent）
 *  - 段在但 default 不是 REQUIRED → 只改这一行（heal）
 *  - 已经是 REQUIRED → 什么都不动（ok）
 */
export function evaluateSettings(text, required = REQUIRED_DEFAULT) {
  const src = String(text ?? '')
  const lines = src.split('\n')
  /**
   * ⚠ 段头只在**行首、后面没有行内注释**时才算段头。
   *   原来用 `/^([ \t]*)agent-presets:[ \t]*\r?$/` 只认"整行就是段头"，
   *   于是 `# agent-presets:`（注释掉的）与 `agent-presets:  # 我的注释` 都识别不出来 ——
   *   实测（资料员 2026-09-17）踩到的后果：文件里其实**已经有**这个段（被注释或带注释），
   *   却走 `absent` 分支在末尾**又追加一整段** ⇒ 同一个 key 出现两次，行为取决于解析器。
   *   现在的判据：行首缩进 + `agent-presets:` + 后面只允许空/注释。
   */
  const top = /^([ \t]*)agent-presets:[ \t]*(?:#[^\r\n]*)?\r?$/
  let h = -1
  let indent = ''
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    // 注释行（行首可选缩进后是 #）绝不是段头 —— 否则"注释里提到过"就会导致重复段
    if (/^[ \t]*#/.test(raw)) continue
    const m = top.exec(raw)
    if (m) { h = i; indent = m[1]; break }
  }
  if (h < 0) {
    const sep = src.endsWith('\n') ? '' : '\n'
    return {
      action: 'absent',
      current: null,
      next: src + sep + 'agent-presets:\n  default: ' + required + '\n',
      why: 'settings.yaml 里没有 agent-presets 段 —— 补上，并把默认钉到 ' + required,
    }
  }
  // 段内：子键比段名**深一个单位**（YAML 常用 2 空格）。遇到"一样深或更浅"的行就说明这段结束了。
  // ⚠ 这里踩过一次：`(indent + ' ').replace(/[ \t]+$/, '') + ' '` 在 indent='' 时会被
  //   自己的正则**去成空串**（空串后接一个空格 → 一整串空格全匹配在行尾），结果算成 1 个空格。
  //   所以直接写死"两个空格"，不玩这种字符串小把戏。
  const childIndent = indent + '  '
  /**
   * ⚠ 值后面的**行内注释必须原样留着**（资料员实测的缺陷：原来整行重写成
   *   `default: roles`，`default: standard   # 我的手写注释` 里的注释被吃掉）。
   *   捕获组：1=缩进 2=值（不含注释）3=值后面的空白 4=注释（含 #）。
   */
  const defRe = /^([ \t]*)default:[ \t]*([^#\r\n]*?)([ \t]*)(#[^\r\n]*)?\r?$/
  let cur = null
  let di = -1
  let dm = null
  for (let i = h + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (/^[ \t]*#/.test(line)) continue // 段内的注释行不算子键
    const lead = (/^[ \t]*/.exec(line) || [''])[0]
    if (lead.length <= indent.length) break // 回到同级/更浅 ⇒ 本段结束
    const m = defRe.exec(line)
    if (m && m[1] === childIndent) {
      cur = String(m[2]).trim().replace(/^["']|["']$/g, '')
      di = i
      dm = m
      break
    }
  }
  if (di < 0) {
    // 段在，但没有 default 行 → 在段头之后插一行
    lines.splice(h + 1, 0, childIndent + 'default: ' + required)
    return { action: 'heal', current: null, next: lines.join('\n'), why: 'agent-presets 段里没有 default 行 —— 补成 ' + required }
  }
  if (cur === required) {
    return { action: 'ok', current: cur, why: '默认已经是 ' + required + '，不动' }
  }
  const eol = lines[di].endsWith('\r') ? '\r' : ''
  const tail = dm && dm[4] ? dm[3] + dm[4] : ''
  lines[di] = childIndent + 'default: ' + required + tail + eol
  return {
    action: 'heal',
    current: cur,
    next: lines.join('\n'),
    why: '发现默认被改成「' + cur + '」—— 按用户 2026-09-17 的硬约束改回 ' + required,
  }
}

/** 带 IO 的入口：读 → 判定 → 需要才写（写前留一份备份）。任何异常都不抛。 */
export function ensureDefault({ settingsPath = DEFAULT_SETTINGS, required = REQUIRED_DEFAULT, now = new Date() } = {}) {
  const out = { settingsPath, required, action: 'error', current: null, backup: null, err: null }
  try {
    const text = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : ''
    const d = evaluateSettings(text, required)
    out.action = d.action
    out.current = d.current ?? null
    if (d.action === 'ok') return out
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    const backup = settingsPath + '.bak-preset-guard-' + stamp
    try {
      fs.writeFileSync(backup, text, 'utf8')
      out.backup = backup
    } catch (e) { out.backup = null }
    /**
     * ★ **原子写**（资料员 2026-09-17 实测指出：原来是整文件 `writeFileSync`，非原子 ——
     *   写到一半崩溃会把 settings.yaml 截断，而里面有用户的模型/API 配置）。
     *   做法：先写同目录的临时文件 → `renameSync` 覆盖（同卷 rename 是原子的）。
     *   任一步失败都退回直接写，并把方式记进 out.writeMode，让外面知道这次是怎么写的。
     */
    const tmp = settingsPath + '.tmp-preset-guard-' + String(process.pid)
    try {
      fs.writeFileSync(tmp, d.next, 'utf8')
      fs.renameSync(tmp, settingsPath)
      out.writeMode = 'atomic-rename'
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch (_) { /* 清不掉就算了 */ }
      fs.writeFileSync(settingsPath, d.next, 'utf8')
      out.writeMode = 'direct-write(fallback: ' + String((e && e.code) || e) + ')'
    }
    return out
  } catch (e) {
    out.action = 'error'
    out.err = String((e && e.message) || e)
    return out
  }
}

/* ------------------------------------------------------------------ 自检 */
export function selftest() {
  const cases = []
  const T = (name, got, want) => cases.push({ name, got, want, ok: got === want })

  // ① 被改成 standard → 必须自愈，且只改那一行
  const a = 'ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\nagent-presets:\n  default: standard\n'
  const ra = evaluateSettings(a)
  T('① 被改成 standard → heal', ra.action, 'heal')
  T('① 自愈后 default=roles', /agent-presets:\n {2}default: roles\n/.test(ra.next), true)
  T('① 别的内容一个字不动', ra.next.includes('welcomeNoticeVersion: 2026-08-13.1'), true)

  // ② 已经是 roles → 什么都不做
  T('② 已是 roles → ok', evaluateSettings('agent-presets:\n  default: roles\n').action, 'ok')

  // ③ CRLF 也要认（Windows 上手改过的文件常是这样）
  const c = 'a: 1\r\nagent-presets:\r\n  default: standard\r\n'
  T('③ CRLF → heal', evaluateSettings(c).action, 'heal')
  T('③ CRLF 其余保留', evaluateSettings(c).next.includes('a: 1\r\n'), true)

  // ④ 没有 agent-presets 段 → 补一段，不动原文
  const d = 'llm:\n  apiKey: SECRET-KEEP-ME\n'
  const rd = evaluateSettings(d)
  T('④ 缺段 → absent', rd.action, 'absent')
  T('④ 补段后 default=roles', rd.next.trim().endsWith('agent-presets:\n  default: roles'), true)
  T('④ 原有 secret 不丢', rd.next.includes('SECRET-KEEP-ME'), true)

  // ⑤ 段里还有别的键 → 只动 default 那一行
  const e = 'agent-presets:\n  roots:\n    - path: ~/x\n  default: minimal\n'
  const re5 = evaluateSettings(e)
  T('⑤ 只动 default', re5.action, 'heal')
  T('⑤ roots 保留', re5.next.includes('- path: ~/x'), true)
  T('⑤ 结果里 default=roles', /default: roles/.test(re5.next), true)
  T('⑤ 结果里没有 minimal', /default: minimal/.test(re5.next), false)

  // ⑥ 空文件 → 补段
  T('⑥ 空文件 → absent', evaluateSettings('').action, 'absent')

  // ⑦ 值带引号也要认出来
  T('⑦ 带引号 → heal', evaluateSettings('agent-presets:\n  default: "standard"\n').action, 'heal')

  // ⑧ **用户 API 配置不许被动**（他逐字说过「不要删掉我之前的api」）
  const f = 'llm:\n  provider: opencodego2v41\n  apiKey: KEEP\nagent-presets:\n  default: standard\nother: 1\n'
  const rf = evaluateSettings(f)
  T('⑧ API key 原样保留', rf.next.includes('apiKey: KEEP'), true)
  T('⑧ other 段原样保留', rf.next.includes('other: 1'), true)
  T('⑧ 只有 default 变了', rf.next.replace('default: roles', 'default: standard') === f, true)

  // ⑨ 别的段里也有一个 default（缩进一样）——**不许误改它**，只改 agent-presets 自己的
  const g = 'llm:\n  default: keep-me\nagent-presets:\n  default: standard\n'
  const rg = evaluateSettings(g)
  T('⑨ 别段的 default 不被改', rg.next.includes('default: keep-me'), true)
  T('⑨ 本段 default 被改', /agent-presets:\n {2}default: roles/.test(rg.next), true)
  T('⑨ 判定为 heal', rg.action, 'heal')

  // ⑩ 段里没有 default 行 → 补一行，其余不动
  const h = 'agent-presets:\n  roots:\n    - path: ~/y\n'
  const rh = evaluateSettings(h)
  T('⑩ 缺 default 行 → heal', rh.action, 'heal')
  T('⑩ 插入后 default=roles', /agent-presets:\n {2}default: roles\n/.test(rh.next), true)
  T('⑩ roots 保留', rh.next.includes('- path: ~/y'), true)

  // ⑪ **行内注释必须留着**（资料员 2026-09-17 实测的缺陷：原来整行重写会吃掉注释）
  const i1 = 'agent-presets:\n  default: standard   # 这是我手写的注释\n'
  const ri1 = evaluateSettings(i1)
  T('⑪ 行内注释保留', ri1.next.includes('# 这是我手写的注释'), true)
  T('⑪ 值改成 roles', /default: roles\s+# 这是我手写的注释/.test(ri1.next), true)

  // ⑫ **注释里的 `# agent-presets:` 不算段头**（否则会在末尾追加重复段 ⇒ 同名 key 两份）
  const i2 = 'x: 1\n# agent-presets:\n#   default: roles\ny: 2\n'
  const ri2 = evaluateSettings(i2)
  T('⑫ 注释里的段头 → 仍判 absent', ri2.action, 'absent')
  T('⑫ 追加后原注释仍在', ri2.next.includes('# agent-presets:'), true)
  T('⑫ 段头只出现一次（真段头）', (ri2.next.match(/^agent-presets:/gm) || []).length, 1)

  // ⑬ 段头带行内注释 → 也认得出是段头（不许当成 absent 再追加一段）
  const i3 = 'agent-presets:   # 预设\n  default: standard\n'
  const ri3 = evaluateSettings(i3)
  T('⑬ 带注释的段头认得出', ri3.action, 'heal')
  T('⑬ 段头只出现一次', (ri3.next.match(/^agent-presets:/gm) || []).length, 1)

  // ⑭ 段内注释行不该被当成子键
  const i4 = 'agent-presets:\n  # 注释\n  default: standard\n'
  T('⑭ 段内注释不影响判定', evaluateSettings(i4).action, 'heal')

  const bad = cases.filter((x) => !x.ok)
  for (const x of cases) {
    console.log((x.ok ? '[通过] ' : '[不符] ') + x.name + (x.ok ? '' : '  got=' + JSON.stringify(x.got) + ' want=' + JSON.stringify(x.want)))
  }
  console.log('自检：' + (cases.length - bad.length) + '/' + cases.length + (bad.length ? ' —— 不通过（exit 1）' : ' —— 通过（exit 0）'))
  return bad.length ? 1 : 0
}

if (process.argv.includes('--selftest')) {
  process.exit(selftest())
}
if (process.argv[1] && process.argv[1].endsWith('preset-default-guard.mjs')) {
  console.log(JSON.stringify(ensureDefault(), null, 1))
}
