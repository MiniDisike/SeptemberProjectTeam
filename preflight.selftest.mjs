#!/usr/bin/env node
/**
 * preflight.selftest.mjs —— `preflight.mjs` 第四节的**自检**。
 *
 * ⚠ **为什么必须有它**：preflight 是全仓唯一没有自检的守门人，而它**自己已经翻过一次车**
 *   —— `交接.md` §9 记的那次"**写死程序目录**"误报（8.3 短名教学例子），
 *   是靠人记下来的，没留下任何用例。
 *   ⚠ 那次修法的教训同样适用：**换例子，不给 preflight 加豁免** ——
 *     所以本文件下面**不写任何真机器路径**，连讲那次事故都不写。
 *   教训（`交接.md` §4 原话）：「**没报错不等于规则生效了**」，
 *   「一个从未匹配过的规则和一条好规则在输出上长得一模一样」。
 *   ⇒ 本文件的意义不是"跑一遍绿"，而是**用已知有病的样本把规则证伪出红**。
 *
 * ── 怎么喂 ──────────────────────────────────────────────────────────────
 *   每个用例造一棵**临时目录**的假文件树（`%TEMP%\preflight-selftest\<用例名>\`），
 *   把 `preflight.mjs` **原样复制**进去，另配一份 `MANIFEST.json`（空清单，
 *   否则"没有 MANIFEST.json"本身就会算一处拦下、期望 0 的用例永远红），
 *   再用 `node preflight.mjs --all` 跑它 —— `--all` 走 `walkFiles(HERE)`，不依赖 git。
 *   ⇒ **不碰真工程、不碰 `.warden`、不碰 git**；跑完默认删掉（`--keep` 可留）。
 *
 * ── 断言口径 ────────────────────────────────────────────────────────────
 *   只看 exit code **不够** —— 期望 1 的用例可能是被别的规则拦下的。
 *   ⇒ 期望 1 的用例**同时**断言 stdout 里点名了新规则；期望 0 的用例
 *     **同时**断言 stdout 里**没有**新规则的名字。
 *   ⚠ **不许有"跳过"路径**：preflight 起不来（spawn 失败 / status 为 null）判**红**，不判跳过。
 *
 * ── 用例 ────────────────────────────────────────────────────────────────
 *   T1 洞3 形状：marker 单独一行，真引文在**续行两行**（跨两个字面量）—— 单行正则抓不到   → 1
 *   T2 洞1 形状：出处 marker 后**紧跟**真引文                                            → 1
 *   T3 干净写法：marker 后面跟的是**占位符**，不是原话                                     → 0
 *      （并断言 stdout 报出"占位符 N 处" ⇒ 证明豁免面真的被走过，不是死代码）
 *   T4 README 英文排版 + 代码字符串里的裸引号（几千处那种）—— 防"规则被写淹死"           → 0
 *   T5 lab 夹具形状：`- 原话:` 槽位（**不带 marker 词**）                                 → 0
 *   T6 占位符里夹带真话：`^…$` 锚定必须失败（短尾巴，长度上限还够得着）                    → 1
 *   T7 同上但尾巴很长（超过 40 码点的上限）—— 长度上限也必须失败                          → 1
 *   T8 占位符的其它合法写法（出处/原文/脱敏/括号变体）—— 豁免不能只认一种字面             → 0
 *
 * ── ⚠ 夹具里绝不许出现真实用户的话 ────────────────────────────────────────
 *   下面所有"原话"都是**一眼自造的假句**（"这是一句自造的假话"之类），
 *   没有一句来自任何真实会话。
 *
 * ⚠⚠ **本文件自己也会被 preflight 扫**（它一旦进版本库）⇒ 本文件里
 *   **不许出现**任何规则的触发词与中文引号的**字面量** —— 否则这张表会把自己判成红。
 *   下面 `QL/QR/HID/…` 那一组常量就是干这个的（全部 \uXXXX 转义），
 *   动机与 `preflight.mjs` 里那个 `String.fromCharCode(92)` 完全一样。
 *
 * 用法：
 *   node preflight.selftest.mjs           跑完全套，结束后删掉夹具
 *   node preflight.selftest.mjs --keep    跑完**保留**夹具（人工看输出用）
 *
 * 退出码：0 = 全过 ／ 1 = 有红（逐条打印哪条）／ 2 = 环境不合法
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PREFLIGHT = path.join(HERE, 'preflight.mjs')
const KEEP = process.argv.includes('--keep')
const RULE_NAME = '用户逐字原话疑似未隐去'
const LAB = path.join(os.tmpdir(), 'preflight-selftest')

/* ──────────────────────────────────────────────────────────────
 * 夹具字面量：全部 \uXXXX 转义（理由见文件头那段 ⚠⚠）
 * ────────────────────────────────────────────────────────────── */
const QL = '\u300c'                     // 「
const QR = '\u300d'                     // 」
const LDQ = '\u201c'                    // “
const RDQ = '\u201d'                    // ”
const LP = '\uff08'                     // （
const RP = '\uff09'                     // ）
const LBK = '\u3010'                    // 【
const RBK = '\u3011'                    // 】
const DASH = '\u2014\u2014'              // ——
const SEMI = '\uff1b'                   // ；
const COMMA = '\uff0c'                  // ，
const COLON = '\uff1a'                  // ：
const HID = '\u5df2\u9690\u53bb'         // 已隐去
const MAO = '\u5df2\u8131\u654f'         // 已脱敏
const PUB = '\u516c\u5f00\u7248'         // 公开版
const KEEPW = '\u4e0d\u7559\u9010\u5b57'  // 不留逐字
const LBL = '\u7528\u6237\u539f\u8bdd'    // 用户原话
const LBL2 = '\u7528\u6237\u9010\u5b57'   // 用户逐字
const SRC = '\u51fa\u5904'               // 出处
const VRB = '\u539f\u6587'               // 原文
const SLOT = '\u539f\u8bdd'              // 原话
const LOCK = '\u9501\u5b9a'             // 锁定
const U = '\u7528\u6237'                 // 用户

/** 标准的脱敏占位符：（用户原话已隐去 —— 公开版不留逐字） */
const PLACEHOLDER = LP + LBL + HID + ' ' + DASH + ' ' + PUB + KEEPW + RP

/** ⚠ 一眼自造的**假句**，不是任何真实会话里的话 */
const FAKE_A = '\u8fd9\u662f\u4e00\u53e5\u81ea\u9020\u7684\u5047\u8bdd'          // 这是一句自造的假话
const FAKE_B = '\u524d\u534a\u53e5'                                          // 前半句
const FAKE_C = '\u4e0e\u65e0\u5173\u7684\u5c3e\u53e5'                          // 与无关的尾句
/** 长尾巴：拼上它之后总长 >40 ⇒ 长度上限这一道也必须拦 */
const FAKE_LONG = FAKE_A
  + '\uff0c\u8fd9\u53ea\u662f\u4e00\u4e2a'   // ，这只是���个
  + '\u7528\u6765\u628a\u957f\u5ea6'         // 用来把长度
  + '\u9876\u5230\u4e0a\u9650\u7684\u5047\u8bdd' // 顶到上限的假话

/* ────────────────────────────────────────────────────────────── */

/** 判据用的 marker 行（洞3 的第 1 行） */
const MARKER_LINE = '> ' + '\u7ea6\u675f\u6765\u6e90'
  + LP + 'R42' + SEMI + LBL2 + SRC + HID + ' ' + DASH + ' ' + PUB + KEEPW + RP + COLON

const CASES = [
  {
    name: 'T1 洞3 形状：marker 一行、真引文在续行两行（跨两个字面量）',
    expect: 1,
    files: {
      'role-voices-fixture.js': [
        'export function readmeText(dirName) {',
        '  return [',
        "    '" + "'> " + '\u7ea6\u675f\u6765\u6e90' + LP + 'R42' + SEMI + LBL2 + SRC + HID + ' ' + DASH + ' ' + PUB + KEEPW + RP + COLON + "',",
        "    '> " + QL + FAKE_A + "',",
        "    '> " + FAKE_B + COMMA + FAKE_C + QR + "',",
        '    \'\',',
        '  ]',
        '}',
      ].join('\n') + '\n',
    },
  },
  {
    name: 'T2 洞1 形状：出处 marker 后紧跟真引文',
    expect: 1,
    files: {
      'notes.md': [
        '# \u8bf4\u660e',
        '',
        '- \u7ea6\u675f' + LP + SRC + HID + ' ' + DASH + ' ' + PUB + KEEPW + RP + COLON + QL + FAKE_A + QR,
        '',
        '\uff08\u4ee5\u4e0a\u662f\u6d4b\u8bd5\u5939\u5177\uff0c\u4e0d\u662f\u771f\u7684\u3002\uff09',
      ].join('\n') + '\n',
    },
  },
  {
    name: 'T3 干净写法：marker 后面跟的是占位符，不是原话',
    expect: 0,
    files: {
      'clean.md': [
        '# \u8bf4\u660e',
        '',
        U + LBL + COLON + QL + PLACEHOLDER + QR,
        '',
        '\u7ed3\u675f\u3002',
      ].join('\n') + '\n',
    },
  },
  {
    // ⚠ 这一条是**豁免面唯一真被走到的形状**：marker 在引号**外面**、引号里**整段**是占位符。
    //   R-窗口会命中它（marker 前 + 60 字内有引号），所以**必须**靠豁免放行 ——
    //   豁免要是写坏了，这一条会变红。
    //   ⚠ 实测：本仓现状**没有**这种写法 ⇒ 光跑真仓证不了豁免是活的，只能靠合成夹具。
    name: 'T3b 豁免面：marker 在引号外、引号内整段是占位符（必须被放过）',
    expect: 0,
    minPlaceholders: 1,
    files: {
      'exempt.md': [
        '# \u8bf4\u660e',
        '',
        '- \u7ea6\u675f' + LP + SRC + HID + RP + COLON + QL + PLACEHOLDER + QR,
      ].join('\n') + '\n',
    },
  },
  {
    name: 'T4 README 英文排版 + 代码字符串里的裸引号（几千处那种）',
    expect: 0,
    files: {
      'README.md': [bareQuoteDoc(), 'sample.js', 'design.md'].join('\n\n'),
      'sample.js': codeWithBareQuotes(),
      'design.md': designDocWithBareQuotes(),
    },
  },
  {
    name: 'T5 lab 夹具形状：- 原话: 槽位（不带 marker 词）',
    expect: 0,
    files: {
      'SPEC.md': [
        '# \u9700\u6c42\u9501\u5b9a\u8868',
        '',
        '## R1 \u00b7 \u4e00\u4e2a\u6d4b\u8bd5\u9700\u6c42',
        '- ' + SLOT + ': ' + QL + FAKE_A + QR,
        '- \u51fa\u5904: session:abc#1',
        '- ' + LOCK + ': 2026-09-16',
      ].join('\n') + '\n',
    },
  },
  {
    // ⚠ 任务书给的原句是 `「（用户原话已隐去 ……）顺便把真话也说了」`，
    //   但那个形状里 **marker 在引号里面、它后面再没有开引号** ⇒ R-窗口压根不命中它。
    //   要真正测到"豁免被写松"，必须让 marker **前置**（R-窗口才命中）、
    //   再让引号里是"占位符 + 真话"。这才是能证伪豁免的那个用例。
    name: 'T6 占位符里夹带真话（短尾巴：总长 ≤40，长度上限还够得着，靠 ^…$ 锚定拦）',
    expect: 1,
    files: {
      'smuggle.md': [
        '# \u8bf4\u660e',
        '',
        '- \u7ea6\u675f' + LP + SRC + HID + RP + COLON + QL + PLACEHOLDER + FAKE_A + QR,
      ].join('\n') + '\n',
    },
  },
  {
    name: 'T7 占位符里夹带真话（长尾巴：超过 40 码点的长度上限）',
    expect: 1,
    files: {
      'smuggle-long.md': [
        '# \u8bf4\u660e',
        '',
        '- \u7ea6\u675f' + LP + SRC + HID + RP + COLON + QL + PLACEHOLDER + FAKE_LONG + QR,
      ].join('\n') + '\n',
    },
  },
  {
    name: 'T8 占位符的其它合法写法（豁免不能只认一种字面）',
    expect: 0,
    minPlaceholders: 6,
    files: {
      'variants.md': [
        '# \u8bf4\u660e',
        '',
        // 每行都带一个**前置** marker ⇒ R-窗口一定会命中，放不放行全看豁免面。
        '- a: ' + LP + SRC + HID + RP + COLON + QL + LP + SRC + HID + RP + QR,
        '- b: ' + LP + SRC + HID + RP + COLON + QL + '[' + VRB + HID + ']' + QR,
        '- c: ' + LP + SRC + HID + RP + COLON + QL + LBL + MAO + QR,
        '- d: ' + LP + SRC + HID + RP + COLON + QL + LP + LBL + MAO + ' ' + DASH + ' ' + PUB + KEEPW + RP + QR,
        '- e: ' + LP + SRC + HID + RP + COLON + QL + LP + LBL2 + HID + COMMA + PUB + HID + VRB + RP + QR,
        '- f: ' + LP + SRC + HID + RP + COLON + QL + LBK + SLOT + HID + RBK + QR,
      ].join('\n') + '\n',
    },
  },
]

/* ── 夹具正文生成（全是英文排版 / 代码字符串 / 术语转述，一处 marker 都不给） ── */

/** README 那种英文排版：一堆成对的 ASCII 双引号与中文引号，量要大到能淹死一条裸引号规则 */
function bareQuoteDoc() {
  const out = ['# Sample', '']
  for (let i = 0; i < 60; i++) {
    out.push(`Paragraph ${i}: the "config" block sets "mode" to "strict", see "docs".`)
    out.push('')
    out.push(`> ${QL}term ${i}${QR} is defined in the "glossary" section.`)
    out.push('')
  }
  return out.join('\n')
}

/** 代码字符串里的裸引号：一行一个，JSON / 正则 / 模板串都来一点 */
function codeWithBareQuotes() {
  const out = ['export const RULES = [']
  for (let i = 0; i < 60; i++) {
    out.push(`  { id: 'rule-${i}', re: /"${i}"/g, note: "中文${QL}术语${i}${QR}只是名字" },`)
  }
  out.push(']')
  return out.join('\n') + '\n'
}

/** 设计文档的自述句：提到"已隐去"这种**术语**，但不是 marker + 引文的组合 */
function designDocWithBareQuotes() {
  const out = ['# Design', '']
  for (let i = 0; i < 40; i++) {
    out.push(`## ${i}. \u6bb5\u843d\u8bf4\u660e`)
    out.push('')
    out.push(`\u8fd9\u91cc\u53ea\u662f\u673a\u5236\u7684\u81ea\u8ff0\uff1a${QL}\u6982\u5ff5\u540d${i}${QR}\u548c "identifier" \u90fd\u662f\u672c\u6587\u6863\u81ea\u5df1\u7684\u547d\u540d\u3002`)
    out.push('')
    out.push(`- \u4f9d\u636e\uff1a"${QL}\u89c4\u5219\u540d${i}${QR}" \u4e0e "docs/index.md"`)
    out.push('')
  }
  return out.join('\n')
}

/* ────────────────────────────────────────────────────────────── */

let pass = 0
let fail = 0

console.log('preflight.mjs 第四节自检（R-窗口：用户逐字原话不得在公开版复现）')
console.log('='.repeat(64))

for (const [ci, c] of CASES.entries()) {
  const dir = path.join(LAB, 'c' + ci)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(PREFLIGHT, path.join(dir, 'preflight.mjs'))
  // 空清单：否则"没有 MANIFEST.json"自己就成了一处拦下，期望 0 的用例永远红。
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify({ files: [] }, null, 2) + '\n')
  for (const [name, body] of Object.entries(c.files)) {
    fs.writeFileSync(path.join(dir, name), body)
  }

  const r = spawnSync(process.execPath, ['preflight.mjs', '--all'], {
    cwd: dir, encoding: 'utf8',
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const code = r.status
  const named = out.includes(RULE_NAME)

  const problems = []
  if (r.error) problems.push(`spawn 失败：${r.error.message}`)
  if (code === null) problems.push('没有拿到 exit code（进程被杀？）')
  if (code !== c.expect) problems.push(`exit ${code}，期望 ${c.expect}`)
  if (c.expect === 1 && !named) problems.push('exit 红了但 stdout 没有点名新规则 ⇒ 红不是这条规则给的')
  if (c.expect === 0 && named) problems.push('stdout 点名了新规则 ⇒ 误伤')
  if (c.minPlaceholders) {
    const m = out.match(/(\u53e6\u6709 (\d+) [^\n]*)/)
    const got = m ? Number(m[2]) : 0
    if (got < c.minPlaceholders) {
      problems.push(`只认出 ${got} 处占位符（期望 ≥${c.minPlaceholders}）⇒ 豁免面可能是死代码`)
    }
  }

  const ok = problems.length === 0
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${c.name}  → exit ${code}（期望 ${c.expect}）`)
  if (c.minPlaceholders) {
    const m = out.match(/(\u53e6\u6709 \d+ \u5904[^\n]*)/)
    if (m) console.log(`      · ${m[1].trim()}`)
  }
  for (const p of problems) console.log(`      ✗ ${p}`)
  if (!ok) console.log(`      ---- preflight 输出 ----\n${out.split('\n').map((l) => '      | ' + l).join('\n')}`)

  if (!KEEP) fs.rmSync(dir, { recursive: true, force: true })
}

if (!KEEP) fs.rmSync(LAB, { recursive: true, force: true })

console.log('='.repeat(64))
console.log(`${pass} \u901a\u8fc7 / ${fail} \u7ea2\uff08\u5171 ${CASES.length} \u6761\uff09`)
process.exit(fail ? 1 : 0)