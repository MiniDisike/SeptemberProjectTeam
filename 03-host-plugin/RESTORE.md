# 插件没了怎么装回来（30 秒）

``host.js`（**本包不含**，见下）` / ``client.js`（**本包不含**，见下）` 就是这个插件的**全部源码**（逐字备份自 `pluginId=warden-1` / `packageId=pkg-16`）。
DSH 动态包**本来就不落盘**（源码写死：`dsh-cordis-host-runner\README.md:12`
「Definitions live only in process memory, so a DSH restart clears them and nothing is written to disk.」），
所以蓝屏/重启后它一定会消失 —— 但**这两个文件在盘上，装回来只要三步**。

## 重新装回来（在「创造模式 / cordis preset」的会话里）

1. `cordis_define`：
   - `plugin.kind = "new"`，`idPrefix = "warden"`
   - `code.host` = ``host.js`（**本包不含**，见下）` 的**全文**（注意：那是**函数体**，结尾自带 `return {…}`）
   - `code.client` = ``client.js`（**本包不含**，见下）` 的**全文**
2. `cordis_run`：`mode = "run"`，用第 1 步返回的 `pluginId` + `packageId`
3. 如果返回 `awaiting-approval` → **在 Run 卡片上点允许**（Client 半边必须你本人批）

## 装完怎么知道真的活了（三条，缺一不可）

```powershell
# ① 镜像里出现 by=plugin 的新行（插件自己写的）
Get-Content <HOME>\DSH-Workspace\task-warden\PLUGIN-CALLS.jsonl -Tail 3
# ② 工程侧同步副本（我每轮收尾手工同步的那份）
Get-Content <WORKSPACE>\.warden\PLUGIN-CALLS.jsonl -Tail 3
# ③ 那一行提示该出现时才出现（安静时什么都不显示）
```

判据：`by":"plugin"` 且 `trigger":"boot"`，时间戳晚于你重启的时间 = 装回来了。

## 这些东西**不会**因为重启丢

- 需求/原话/认领/欠账账本：`<WORKSPACE>\.warden\`（SPEC / VOICE / CLAIMS / ROUNDS / FINDINGS / INCIDENTS）
- 插件真正干活的那段：`<WORKSPACE>\.warden\plugin-io.js`
- 守则脚本：`<HOME>\.dsh\skills\task-warden\`（warden.mjs / selftest.mjs / SKILL.md）
- 这个备份目录本身

## 还差的那一半（真正的"重启自动跑"）

上面这套是"**丢了我能装回来**"。要做到"**蓝屏之后不用任何人动手，它自己就在跑**"，
得把这两段代码从"动态包"改写成一条 **composition 行**（常驻插件）——
资料员的调查结论与三条路的代价见 `<WORKSPACE>\.warden\FINDINGS.jsonl`（`ref: R14` 那两条）。
