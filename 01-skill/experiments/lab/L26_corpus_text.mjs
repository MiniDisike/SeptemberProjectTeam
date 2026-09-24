#!/usr/bin/env node
/**
 * L26 · 语料必须存**正文**，不许存 `JSON.stringify(事件)`（事故 I54）
 *
 * 缺陷（被**另一个窗口**独立发现，我复核成立）：
 *   `corpusEntries` 原来存的是 `JSON.stringify(e)` ⇒ 语料里的反斜杠是**转义过的 `\\`**，
 *   而用户原话里是单个 `\` ⇒ **凡「原话」里带 Windows 路径，`check` 的逐字核对必然不通过**。
 *   实测：`corpus.includes('<WORKSPACE>\…\九月项目团-需求对照表-2026-09-17.md完善九月项目团的制作')`
 *   曾经 = false，而语料里那一段其实是 `<WORKSPACE>\\…`。
 *   对本用户尤其致命 —— **他的消息经常就是一条文件路径**，于是那些原话永远无法被认定为"他说过"。
 *
 * ⚠ 同一类 bug 在 `assistantEntries` 里**早就修过**（那边的注释写着"不要 JSON.stringify(e)"），
 *   用户这一侧当时漏了 —— 同一类缺陷只修了一半。
 *
 * 为什么这个用例能在本沙箱里真跑：它只读**已有会话日志** + 纯函数比较，**不 spawn 子进程**。
 *
 * 判据：
 *   ① 语料里**没有一条**看起来是 JSON 串（`text` 不以 `{` 开头）—— 这就是"存正文"的直接判据；
 *   ② `corpusText` 必须等于各条正文拼起来（口径一致，不许有一处偷偷塞回 JSON）；
 *   ③ 语料仍然**只收真用户消息**（`raw` 解析出来的 `source.kind` 只能是 `user`）—— 防"修了 A 漏了 B"；
 *   ④ 若本次扫到的语料里有**带反斜杠**的用户消息，那一条必须能在 `corpusText` 里**逐字命中**
 *      （这正是 I54 的直接回归；扫不到就如实 SKIP，不许假装通过）。
 */
import { makeCtx } from './common.mjs';

const WARDEN = 'file:///<HOME>/.dsh/skills/task-warden/warden.mjs';
const ROOT = '<WORKSPACE>\\task-warden';

export default async function run() {
  const c = makeCtx('L26', '语料存正文：带 Windows 路径的原话必须能逐字命中');

  const mod = await import(WARDEN);
  const entries = mod.corpusEntries(ROOT, { force: true });
  c.check('前置 · 扫到了语料（为 0 不许报成功）', entries.length > 0, `语料条数 = ${entries.length}`);

  // ① 不许有一条是 JSON 串
  const looksJson = entries.filter((e) => String(e.text).trim().startsWith('{'));
  c.check('① 语料里没有一条看起来是 JSON 串（存的是正文）',
    looksJson.length === 0,
    looksJson.length ? `★ 有 ${looksJson.length} 条仍是 JSON：例 ${JSON.stringify(String(looksJson[0].text).slice(0, 120))}` : '全部是正文');

  // ② corpusText 与各条正文口径一致
  const joined = entries.map((e) => e.text).join('\n').replace(/\s+/g, '');
  c.check('② corpusText 等于各条正文拼起来（口径一致）',
    mod.corpusText(ROOT) === joined,
    `corpusText=${mod.corpusText(ROOT).length} 字符 / joined=${joined.length} 字符`);

  // ③ 仍然只收真用户消息
  const kinds = new Set();
  for (const e of entries) {
    try { kinds.add(String(JSON.parse(e.raw).data?.source?.kind)) } catch { kinds.add('(raw解析失败)') }
  }
  c.check('③ 语料仍只收真用户消息（source.kind 只有 user）',
    kinds.size === 1 && kinds.has('user'),
    JSON.stringify([...kinds]));

  // ④ 带反斜杠的那条必须逐字命中（I54 的直接回归）
  const withBackslash = entries.filter((e) => String(e.text).includes('\\'));
  if (!withBackslash.length) {
    c.skip('④ 带反斜杠的原话逐字命中', '本次扫到的语料里没有带反斜杠的用户消息 —— 查不到不等于没问题');
  } else {
    const corpus = mod.corpusText(ROOT);
    const bad = withBackslash.filter((e) => !corpus.includes(String(e.text).replace(/\s+/g, '')));
    c.check('④ 带反斜杠的原话能在语料里逐字命中（I54 的直接回归）',
      bad.length === 0,
      bad.length
        ? `★ 有 ${bad.length} 条命中不了（第一条：${JSON.stringify(String(bad[0].text).slice(0, 100))}）`
        : `带反斜杠的 ${withBackslash.length} 条全部逐字命中`);
  }

  // ⑤ 正控：编的原话仍必须查不到（不许为了修 I54 把匹配放宽到"什么都算命中"）
  c.check('⑤ 正控 · 编的原话仍查不到（不许把匹配放宽成假通过）',
    mod.findUserSaying(ROOT, '这句话用户从来没有说过所以必须查不到啊哈') === null,
    'findUserSaying(编的) === null');

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    status: ok ? 'PASS' : 'FAIL',
    pass: ok,
    reason: ok
      ? '语料存的是正文而不是 JSON.stringify(事件)：带 Windows 路径的原话能逐字命中（I54 的直接回归），且仍只收真用户消息、编的原话仍查不到。'
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
