# Third-party notices / 第三方声明

## 1. DSH 出厂 agent preset（MIT）

`02-preset-roles/agent.cordis.yml` 有相当一部分（文件头注释、plan-mode 段等）**逐字沿用**自
DeepSeek Harness 随包发布的 **standard** agent preset：

    @deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml

该文件以 **MIT License** 发布，版权声明为：

    Copyright (c) 2026 DeepSeek

MIT 许可证要求**保留版权声明与许可声明**。它们随 DSH 安装包一起分发（见该包根目录的 `LICENSE`）；
本仓库再分发其中部分内容，故在此声明其来源与许可。

**请在使用前自行核对 DSH 安装包内那份 `LICENSE` 的原文** —— 本声明只是如实标注来源，
不构成法律意见。

## 2. 其余内容

本仓库其余文件（`01-skill/`、`03-host-plugin/`、`04-config/`、`README.md`、`INSTALL.md`）
为本项目原创，按根目录 `LICENSE`（MIT）发布。

## 3. 无其它第三方依赖

所有 `.mjs` 只 import Node 内置模块（`node:fs` / `node:path` / `node:os` / `node:zlib` /
`node:crypto` / `node:child_process` / `node:url`）与同目录文件；**没有第三方 npm 依赖**。
