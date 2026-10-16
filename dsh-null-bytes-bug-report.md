# Bug 报告：DSH 0.2.0-rc.2 工具调用参数被 null bytes（\x00）污染致 agent-loop 中断

## 环境

- **DSH 版本**：0.2.0-rc.2（桌面版 Electron 壳，44.0.0）
- **OS**：Windows 10/11（win-x64）
- **模型**：space-bunny-free（OpenCode Go 免费模型，无限量）
- **Provider**：opencodego3（openai-completions API，baseURL: https://opencode.ai/zen/go/v1）
- **会话**：长历史会话（turn 66），cwd: D:\<用户>\grok

## 症状

模型能正常思考（reasoning）和输出正文，但工具调用参数被 null bytes（\x00）污染，导致工具调用失败后 agent-loop 中断。AI 自己注意到 "Something is corrupting my tool arguments — null bytes are being injected"，尝试绕过未成功，会话断掉。

## 错误日志

```
执行了命令
读闸要求本实例先读交接。并行派角色 + 读交接。

已读取文件
失败
读取
Error: invalid arguments: "limit" must be a number
失败
读取
Error: The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received 'F:\<用户>\Documents\GitHub\<工程>\交接.md<NUL>'
失败
读取
Error: The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received 'F:\<用户>\Documents\GitHub\<工程>\F<NUL>F:\<用户>\Documents<NUL>GitHub\<工程>\交接.md'
思考
Something is corrupting my tool arguments — null bytes are being injected. Let me try a clean simpl
[断掉]
```

> 注：错误摘录里的 null byte 以 `<NUL>` 标注（原始日志为 `\x00` 转义）；路径分隔符已由 JSON 转义的 `\\` 还原为 `\`；用户名与工程名已打码。

三个工具调用参数都被污染：
1. `limit` 参数变成非数字
2. `path` 末尾被注入 `\x00`：`F:\...\交接.md\x00`
3. `path` 中间被注入多个 `\x00`：`F:\...\F\x00F:\...\x00GitHub\<工程>\交接.md`

## 排查结论

- **不是 API 额度问题**：space-bunny-free 是免费无限量模型，API 调用正常返回 200
- **不是 reasoningEffort 配置问题**：配置了 `reasoningEffort: medium`，模型 reasoning 正常
- **不是 contextWindow 配置问题**：配置的 800000 实际值 262144（可能是 API 返回值覆盖），但不是中断原因
- **不是 dsh-defend 插件**：dsh-defend 代码是 Aho-Corasick 模式匹配，无 null bytes 注入点；audit 日志当天无检测记录
- **parseArguments 函数无注入点**：`parseArguments(raw)` 只是 `JSON.parse(raw)`（agent-loop/lib/index.js:534），null bytes 在 `block.arguments` 里就已存在
- **null bytes 在 LLM 响应解析或会话历史恢复阶段引入**：来自 asar 内代码，无法从配置层修复

## 可能的触发条件

- **长会话历史**：中断会话 turn 66，正常会话 turn 22（同一模型同一 provider，正常会话压力更大却未断）
- **偶发性**：同一机器另一窗口用同一 provider 的同模型正常工作

## 期望

确认 null bytes 注入的源头（LLM 流式响应拼接 / 会话历史 zstd 解压 / 消息序列化），在 0.2.0-rc.3 或后续版本修复。