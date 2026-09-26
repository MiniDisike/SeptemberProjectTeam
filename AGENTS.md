# AGENTS.md —— 公开包的 agent 提示

> 这一份是**给在这个仓库里干活的 AI**（以及**人类**）看的。
> ⚠ **它只有一节，而且是「建议」** —— 看完 / 办完之后，**整个文件删掉即可**（它不会自己回来）。

<!-- ===== 以下是「搜索费用提示」一节，属**建议**，看完/换完可整段删除 ===== -->

# 搜索费用提示（建议 · 可删）

> **建议，不是要求**。你的机器你做主 —— 有人就是愿意用付费搜索。

## 给人类

DSH 的 `web_search` 有两个来源，**计费方式完全不同**：

| 来源 | 怎么执行 | 费用 |
|---|---|---|
| **官方**（内置 `dsh-web-search-deepseek`） | 每次搜索 = **一次完整的模型请求**（DeepSeek 没有专门的搜索端点） | **按 token 计** |
| **免费 provider**（自建 / 第三方） | 直接请求搜索引擎的 **MCP 端点**（匿名免 key） | **不扣 token / 余额** |

**官方包自己的文档逐字写着**：
> one search **costs a full model turn** in latency and tokens, because DeepSeek exposes no dedicated search endpoint.

⚠ **如果你常用搜索，或让 AI 自动去搜（例如派资料员 / 研究员），官方那条会很快消耗额度。**

建议换成免费 provider。⚠ 但**免费 ≠ 无代价**：
- 那是**第三方服务**，**有速率限制**、**可能变更或关闭**；
- **你的查询词会发给它**；
- ⚠ **它不一定允许你不问自取地再分发** —— 要用请自己看清对方的条款。

⚠ **再强调一次**：这只是建议。**你可以继续用付费的** —— 那是你的选择，别人无权替你定。

## 给 AI（这一段是给读到本文件的 agent 的）

**你应当主动提醒用户**，但要守三条：

1. **只在"搜索真的被用到"时提醒**，**不要每轮都说**。
   每轮都说是噪声，本项目实测过（事故 I60：每回合提醒导致**用户手动停掉了整个过程**）。
2. **提醒要短**，一句话说清：
   *本次搜索走的是官方付费（每次 = 一次完整模型请求）；可以换成免费 provider 或自带 API —— 换不换由你决定。*
3. ⚠ **不许用 `agent.steer()` 去做这个提醒**。
   `steer()` 会把一条 `role:"user"` 消息**塞进模型上下文**（实测 ≈ **244 token / 次**）
   ⇒ 那就变成"**提醒本身在烧 token**"，与这件事的初衷正相反
   （判据：`agent.steer()` → `send(input,"next-step",true)` → `session.append("user/message", …, {surfaceOp:"append"})`）。

   **真正不进上下文的通道**是 `session.append(<非 surface 事件类型>, …)`：
   平台的 `SURFACE_EVENT_TYPES` 白名单只有 **4 种**（`system/message` / `user/message` /
   `assistant/message` / `tool/result`），**不在这 4 种里的事件机械上进不了模型上下文**，
   但仍写进 session log、客户端可以读它渲染。

   ⚠ **注意（未验证）**：这条通道**"不进上下文"有机械判据，但"客户端真的会把它画出来"尚无实测证据** ——
   要用它，**先把这一点验证掉**，别默认它会显示。

## 换法（如果你决定换）

1. 找一个免费 provider 插件，或自己写一个 —— 接口很小：
   `registerSearchProvider({ id, search(request, signal) })`。
2. 在**你用的那个 profile** 的 `cordis.patch.yml` 里挂上它：
   `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。
   ⚠ **别写别人机器的绝对路径** —— 那换台机器就失效（用包内相对路径或 `file://`）。
3. ⚠ **不要**在配置里 pin 一个**还没注册**的 provider id ——
   那会把 `web_search` 打成 `WEB_PROVIDER_CONFIGURED_MISSING`。
   **不 pin** 时：插件没加载成功会**自动退回官方路线**，不会把搜索打坏。
4. 换完之后，**把本文件删掉**。

## 判据（怎么知道现在走的是哪个）

`web_search` 走谁，看这两处：
- `config.searchProvider` 或环境变量 `DSH_WEB_SEARCH_PROVIDER`（两者**等价**，**不是**优先级链）；
- 两者都没配时：**只有 1 个可用 provider ⇒ 用它**；**多于 1 个 ⇒ `WEB_PROVIDER_AMBIGUOUS`**。

⇒ **只装了官方 provider 的机器，搜索一定走 `deepseek-official`**（= 一整个模型 turn 的计费）。

---

> **这段结论的出处**（可自己复核，不必信本文件）：以上判据来自 DSH 装机包内的
> `dsh-web` / `dsh-session` / `dsh-agent-loop` / `dsh-tool-web` / `dsh-web-search-deepseek`
> 这几个包的实现与 README。**本文件是转述，不是权威** —— 有冲突时以装机包里的实现为准。
