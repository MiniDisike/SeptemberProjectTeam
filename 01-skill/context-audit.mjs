#!/usr/bin/env node
/**
 * context-audit.mjs —— 量一次「上下文里都是什么」。
 *
 * 为什么要有它：用户问输出里的自言自语是不是每次都要被塞进上下文。
 * 答案只能量出来，不能感觉：会话日志里每条消息都在，按来源和类型分开统计字符数，
 * 就能看出"我啰嗦"到底吃掉多少窗口。
 *
 * 口径：
 *   · 统计的是**字符数**（不是 token）。中文大约 1 字符 ≈ 0.6~1 token，
 *     所以下面是上界；报的时候按字符报，别假装是精确 token。
 *   · 分类：assistant 的正文（= 自言自语）／assistant 的工具调用参数／
 *     用户原话／插件注入（system-prompt、AGENTS.md）／子代理回执／工具结果。
 *   · 一次性写入文件和聊天窗口的区别：写进文件的**不进上下文**，只在我读它的那一步才进。
 *
 * 用法：node context-audit.mjs [--session <id>] [--last N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodeSession, listSessions } from './bill.mjs';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const want = opt('session');
const lastN = Number(opt('last') ?? 3) || 3;

const all = listSessions({ all: true }).sort((a, b) => b.mtimeMs - a.mtimeMs);
const picked = want ? all.filter((s) => s.sessionId === want) : all.slice(0, lastN);

const bytes = (x) => JSON.stringify(x ?? '').length;
const fmt = (n) => n.toLocaleString('en-US');

for (const s of picked) {
  let dec;
  try { dec = decodeSession(s.file); } catch { continue; }
  const acc = {
    assistantText: 0, assistantToolArgs: 0, userText: 0, pluginInject: 0,
    subagentNotice: 0, toolResult: 0, other: 0,
  };
  const pluginByName = new Map();
  let assistantMsgs = 0; let userMsgs = 0;
  for (const e of dec.events) {
    const d = e?.data ?? {};
    if (e?.type === 'assistant/message') {
      assistantMsgs += 1;
      for (const c of (d.message?.content ?? [])) {
        if (c?.type === 'text') acc.assistantText += bytes(c.text);
        else if (c?.type === 'reasoning') acc.assistantText += bytes(c.text); // 思维链也算上下文里的
        else if (c?.type === 'tool-call' || c?.type === 'tool_use' || c?.name) acc.assistantToolArgs += bytes(c);
        else acc.other += bytes(c);
      }
    } else if (e?.type === 'user/message' || e?.type === 'message') {
      const src = d.message?.source?.kind ?? '';
      if (src === 'user') { userMsgs += 1; acc.userText += bytes(d.message?.content); }
      else if (src === 'plugin') {
        acc.pluginInject += bytes(d.message?.content);
        const name = String(d.message?.source?.plugin ?? '（没名字）');
        pluginByName.set(name, (pluginByName.get(name) ?? 0) + bytes(d.message?.content));
      } else if (src === 'tool') acc.toolResult += bytes(d.message?.content);
      else acc.other += bytes(d.message?.content);
    } else if (e?.type === 'tool/result') acc.toolResult += bytes(d.result ?? d);
  }
  const total = Object.values(acc).reduce((a, b) => a + b, 0) || 1;
  console.log(`\n会话 ${s.sessionId}  （${new Date(s.mtimeMs).toLocaleString('zh-CN')}）`);
  console.log(`  消息数：assistant ${assistantMsgs} · 真用户 ${userMsgs} · 帧 ${dec.frames}`);
  const rows = Object.entries(acc).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of rows) {
    if (!v) continue;
    const label = {
      assistantText: '我的正文（自言自语+思维链）', assistantToolArgs: '我的工具调用参数',
      userText: '用户原话', pluginInject: '插件注入（系统提示/AGENTS.md）',
      toolResult: '工具结果', subagentNotice: '子代理回执', other: '其它',
    }[k] ?? k;
    console.log(`  ${String((v / total * 100).toFixed(1)).padStart(5)}%  ${fmt(v).padStart(11)} 字符  ${label}`);
  }
  if (pluginByName.size) {
    console.log('  插件注入明细：');
    for (const [n, v] of [...pluginByName.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${fmt(v).padStart(10)} 字符  ${n}`);
    }
  }
}
