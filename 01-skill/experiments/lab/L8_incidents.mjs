#!/usr/bin/env node
/**
 * L8 · 事故收集器（每次翻车都进这里）
 *
 * 铁律：**每发生一次真实翻车，就必须变成一条永久回归用例。**
 * 修了 bug 但不留回归，等于下次还会犯 —— 这个 skill 本身就是为这件事存在的。
 *
 * 收集器文件：`<工程根>\.warden\INCIDENTS.jsonl`（活跃目录，实验台**只读**它）
 * 每条形如：
 *   {"id":"I1","at":"2026-09-16","现象":"…","真实损失":"…","当时没抓到":"…","现在靠什么抓":"…","实验":"L3"}
 *
 * ⚠ **不能机检的事故也必须能登记进来** —— 否则最该被记住的那一类（"AI 自己骗自己"）
 *   会因为"写不出 exit code 断言"而**永远进不了事故表**。所以：
 *     `实验` 要么指向一个**真实存在**的 `L*.mjs`，
 *     要么写 `"无"` 且**必须**同时有非空的 `为什么不可机检`（≥20 字，说清为什么写不成断言）。
 *   两件都不是 → FAIL。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REAL_INCIDENTS, readJsonl, makeCtx, assert, WARDEN } from './common.mjs';

const LAB_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORE_FIELDS = ['id', 'at', '现象', '真实损失', '当时没抓到', '现在靠什么抓'];
const REQUIRED = {
  I1: '两个项目读到对方守则', I2: 'shape2.gd 伪造引文', I3: '验收清单自相矛盾',
  I4: 'MAP.md:148 把贴回的 AI 清单当用户原话', I5: '脑子 G 9 条里 4 条不成立', I6: '脑子 H 5 条里 1 条不成立',
};
const MIN_WHY = 20;

/**
 * 一条事故记录合格吗？
 * 返回 `{ ok, kind, errs }`：kind = 'experiment' | 'unmechanizable'
 */
export function validateIncident(rec, labFiles) {
  const errs = [];
  const exp = String(rec?.['实验'] ?? '').trim();
  if (exp && exp !== '无') {
    const hit = labFiles.filter((f) => f.startsWith(`${exp}_`));
    if (!hit.length) errs.push(`「实验」写了 ${exp}，但 lab 里没有 ${exp}_*.mjs`);
    return { ok: errs.length === 0, kind: 'experiment', errs };
  }
  // 实验 = 空 或 "无" → 必须写清为什么不可机检
  const why = String(rec?.['为什么不可机检'] ?? '').trim();
  if (why.length < MIN_WHY) {
    errs.push(`「实验」是空的/无，但「为什么不可机检」只有 ${why.length} 字（要 ≥${MIN_WHY} 字，说清为什么写不成断言）`);
  }
  return { ok: errs.length === 0, kind: 'unmechanizable', errs };
}

export default async function run() {
  const c = makeCtx('L8', '事故收集器：每次翻车都进这里');
  /**
   * ⚠ 2026-09-17 补（**改夹具、不放宽判据**）：本项目的回归套件**合法地分两处** ——
   *   · **skill 的 lab**（`<skill>/experiments/lab`，L1~L20）：随 skill 走，不需要工程布局；
   *   · **工程仓库的 lab**（`<repo>/experiments/lab`，L21~L34）：要 `plugin/` 目录、要 repo 份的拷贝，
   *     放在 skill 里跑不了（L21 找 `plugin/preset-default-guard.mjs`、L25 比两份拷贝）。
   *   L8 原来只看 skill 那一处 ⇒ 指向 L29/L34 的事故被**误判成"实验不存在"**。
   *   现在两处都收（工程那处的路径从 `WARDEN` 常量推出来，不写死）。
   */
  const labDirs = [LAB_DIR];
  try {
    const repoLab = path.join(path.dirname(WARDEN), 'experiments', 'lab');
    if (fs.existsSync(repoLab) && repoLab !== LAB_DIR) labDirs.push(repoLab);
  } catch (e) { /* 推不出来就只看 skill 那处 */ }
  const labFiles = [...new Set(labDirs.flatMap((d) => {
    try { return fs.readdirSync(d).filter((f) => /^L\d+_.*\.mjs$/.test(f)) } catch (e) { return [] }
  }))];

  const exists = fs.existsSync(REAL_INCIDENTS);
  c.check('① 收集器文件存在且每行都是合法 JSON',
    exists && readJsonl(REAL_INCIDENTS).every((r) => !r.__badLine),
    exists ? REAL_INCIDENTS : `缺文件 ${REAL_INCIDENTS}`);
  if (!exists) {
    // ⚠ 公开版不发 .warden ⇒ 这条在公开用户那里**结构上跑不了**。如实 SKIP，不许假装通过、也不许留着红。
    c.skip('整条用例', '私有账本不在（' + REAL_INCIDENTS + '）—— 公开版不发 .warden');
    return { id: c.id, name: c.name, status: 'SKIP', pass: true, reason: '私有账本不在，如实跳过', checks: c.checks, skipped: c.skipped };
  }

  const rows = readJsonl(REAL_INCIDENTS);
  c.check('② 六起已知事故 I1~I6 一条不少',
    Object.keys(REQUIRED).every((id) => rows.some((r) => r.id === id)),
    `共 ${rows.length} 条；缺：${Object.keys(REQUIRED).filter((id) => !rows.some((r) => r.id === id)).join(',') || '无'}`);

  const missing = rows.filter((r) => CORE_FIELDS.some((f) => !String(r[f] ?? '').trim()));
  c.check('③ 每条的核心字段（id/at/现象/真实损失/当时没抓到/现在靠什么抓）都非空',
    missing.length === 0,
    missing.length ? `缺字段：${missing.map((r) => r.id).join(',')}` : `${rows.length} 条全齐`);

  const lame = rows.filter((r) => String(r['现在靠什么抓']).trim().length < 12
    || /^(待补|暂无|无|TBD|-)+$/i.test(String(r['现在靠什么抓']).trim()));
  c.check('④ 每条都写明了「现在靠什么抓」（不是占位词）',
    lame.length === 0, lame.length ? `占位/过短：${lame.map((r) => r.id).join(',')}` : '每条都有抓手');

  // ⑤ 核心：实验 指向真实实验，**或** "无" + 为什么不可机检（≥20 字）
  const verdicts = rows.map((r) => ({ r, v: validateIncident(r, labFiles) }));
  const bad = verdicts.filter((x) => !x.v.ok);
  c.check('⑤ 每条事故：`实验` 要么指向真实存在的 L*.mjs，要么是"无"且写明「为什么不可机检」(≥20 字)',
    bad.length === 0,
    bad.length ? bad.map((x) => `${x.r.id}：${x.v.errs.join('；')}`).join(' ｜ ')
      : rows.map((r) => {
        const v = validateIncident(r, labFiles);
        return v.kind === 'experiment' ? `${r.id}→${r['实验']}` : `${r.id}→无(不可机检)`;
      }).join(' '));

  const nExp = verdicts.filter((x) => x.v.kind === 'experiment').length;
  const nUn = verdicts.filter((x) => x.v.kind === 'unmechanizable').length;
  c.check('⑥ 【实测事实】两类事故各有多少条（可机检 / 不可机检都已登记）', true,
    `可机检 ${nExp} 条（指向真实实验）· 不可机检 ${nUn} 条（写了为什么）· 合计 ${rows.length} 条`);

  // ⑦ 负控：校验器自己必须抓得住"既不是实验、也没写理由"的记录
  const negCases = [
    { rec: { id: 'X1', 实验: '', 为什么不可机检: '' }, expect: false, why: '实验为空且没有「为什么不可机检」' },
    { rec: { id: 'X2', 实验: '无', 为什么不可机检: '太难了' }, expect: false, why: '理由只有 3 字（<20 字）' },
    { rec: { id: 'X3', 实验: 'L999' }, expect: false, why: '指向一个不存在的实验 L999' },
    { rec: { id: 'X4', 实验: '无', 为什么不可机检: '这件事的判断标准是"模型有没有先有结论再编理由"，属于过程性判断，任何单条断言都只能截取一个片段，写不成 exit code。' }, expect: true, why: '合法的"不可机检"记录' },
    { rec: { id: 'X5', 实验: 'L6' }, expect: true, why: '指向真实存在的实验' },
  ];
  const negBad = negCases.filter((x) => validateIncident(x.rec, labFiles).ok !== x.expect);
  c.check('⑦ 负控 · 校验器抓得住"既不是实验、也没写理由"的记录（4 类样本：空/理由过短/实验不存在/两种合法）',
    negBad.length === 0,
    negBad.length ? negBad.map((x) => `${x.rec.id}(${x.why}) 期望 ${x.expect}`).join('；')
      : negCases.map((x) => `${x.rec.id}→${validateIncident(x.rec, labFiles).ok ? '收' : '拒'}`).join(' '));

  const referenced = new Set(rows.map((r) => String(r['实验'] ?? '').trim()));
  const orphan = labFiles.filter((f) => !referenced.has(f.split('_')[0]));
  c.check('⑧ 【实测事实】还没有事故条目的实验（来源在设计文档 §0 的动机表里）', true,
    orphan.length ? `未进收集器：${orphan.join(', ')}` : '实验室里每个实验都有事故条目');

  // ⑨ id 唯一性：收集器是 append-only 且**多个 agent 同时在写**，
  //    事故 id 又是规则证据的锚点（checkRuleEvidence 按子串匹配）——
  //    重复 id 会让"这条规则指的是哪起事故"变得不可判定。
  const idCount = new Map();
  for (const r of rows) { const k = String(r.id ?? '').trim(); idCount.set(k, (idCount.get(k) ?? 0) + 1); }
  const dups = [...idCount.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
  c.check('⑨ 【实测事实】事故 id 有没有重复（append-only 收集器被多个 agent 并发写）', true,
    dups.length
      ? `★ 重复 id：${dups.join('、')} —— 收集器没有"id 唯一"这道闸，事故 id 又是规则证据的锚点，`
        + '重复会让"这条规则指的是哪起事故"不可判定（建议：登记时校验 id 唯一，或改成带作者/时间的 id）'
      : `${rows.length} 条 id 互不重复`);

  const ok = c.checks.every((x) => x.ok);
  return {
    id: c.id,
    name: c.name,
    pass: ok,
    reason: ok
      ? `${rows.length} 条事故全部合格（${nExp} 条指向真实实验、${nUn} 条如实标明"不可机检"并写了理由），校验器负控全抓到。`
      : '有检查未通过（见下）。',
    checks: c.checks,
    skipped: c.skipped,
  };
}
