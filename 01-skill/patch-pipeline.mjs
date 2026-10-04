#!/usr/bin/env node
/**
 * patch-pipeline.mjs —— 「派 → 复制 → 改 → 角色检查 → 替换」这条**直线动作**的机制化（R32）
 *
 * **约束来源（用户逐字已隐去 —— 公开版不留逐字）**：
 *   R32 把几个**直线动作**固定成机制，**不许遗留**：「派子代理进行逐条的修改」、
 *   「复制修改」→「派角色检查」→「确认无误才替换」；
 *   点名的两条漏：**「复制改完不检查」**、**「检查了不替换现有的等于没做」**。
 *
 * ## 机制怎么"固定"（每一条都是 exit code，不是建议）
 *
 *   begin    --id <P> --files <a,b,c>        复制两份：orig/（**只读、永不改**）+ work/（工作副本）
 *   dispatch --id <P>                        打印「原件 → 工作副本」映射（给子代理，不许它自己猜）
 *   verify   --id <P> --by <角色> --verdict ok|bad --evidence "原样输出"   角色署名检查
 *   apply    --id <P> [--verify-cmd "<命令>"] 把 work/ 替换回原件（**没有 verify ok ⇒ 拒绝**）
 *   postcheck --id <P> [--cmd "<命令>"]       替换后复核（指纹变了 + 整体检查 exit 0）
 *   rollback --id <P>                        从 orig/ 恢复原件（可回滚面；`--pair` 两边一起回）
 *   status                                   列出每个 patch 走到哪步，**卡住的显式报出来**
 *
 * ## 退出码
 *   0 = 这一步做了（或 status 里没有卡住的）
 *   1 = **拒绝/卡住**（该做的没做、或顺序不对）—— 这是"不许遗留"的执法点
 *   2 = 用法错
 *
 * ## 2026-09-24 修的三处（「方向员」逐行审出来的真 bug）
 *   ① **副本名碰撞会静默损坏数据**：原来 `f.replace(/[\\/]/g,'__')` ⇒ `a/b.mjs` 与 `a__b.mjs`
 *      映射到**同一个副本名**（实测两者都 = `a__b.mjs`）⇒ 同一 patch 里两个输入互相覆盖，
 *      `apply` 会把同一份副本写回**两个不同原件**。现在改成 **`sha256(相对路径).slice(0,8)__basename`**，
 *      并在 `begin` **断言映射唯一**（撞了就拒）。
 *   ② **没有第二份原始内容 ⇒ R32 必须①「可回滚的副本」不成立**：原来只复制一次，那份随即被改，
 *      `apply` 再写回 ⇒ **`shaBefore` 对应的字节在盘上不再存在**（本仓 git 0 commit，没有兜底）。
 *      现在 `begin` 复制**两份**：`orig/`（只读）+ `work/`（工作副本），并加 `rollback`。
 *   ③ **没有"派"这一步**：子代理拿到"改 src/a.mjs"后必须自己反推副本名。现在加 `dispatch`，
 *      直接打印「原件 → 工作副本」映射。
 *
 * ## 2026-09-24 第二轮修（主代理实测 4 条 + 「审查」独立审计实测 12 条）
 *   D1/D2 `--pair` 用 `split(':')` 解析 ⇒ **含盘符的 Windows 路径静默切错**（左绝对路径的写法
 *        完全失效、右绝对路径被切成 `'C'`）⇒ 见 `splitPair()`；并加"左值没匹配上就拒"。
 *   D5    `--pair` 的**第二份从不回滚**（`begin` 却逐字承诺"rollback 也是"）⇒ 现在 `origAlso` +
 *         两边一起回 + 没回到基线就 exit 1。
 *   D6    `rolledback` 状态**豁免了**绕过检测 ⇒ 手工改完原件再 apply 会静默覆盖 ⇒ 豁免只剩 `applied`。
 *   D7    `apply` 中途失败 ⇒ 半替换 + 未捕获栈 + 把管线自己改的误诊成"外部绕过" + 永久卡死
 *         ⇒ 先全部校验可写、逐条记进度（`replacing`/`replaced`）、`pipelineLast` 区分"谁写的"。
 *   D8    状态机三处绿灯（`begin→rollback` / `apply→verify bad` / `apply→rollback` 净零）。
 *   D9/D10 `--with-dir` 在工程根上恒失效（dst 是 src 的子目录）且能镜像到 `work/` 之外。
 *   D11   两个左值 `--pair` 到同一右值 ⇒ 后者静默胜出（唯一性断言原来只覆盖 `files`）。
 *   D12   `--pair` 第二份被删后 apply 静默重建（`alsoShaBefore` 记了不用）。
 *   D13   混根警告只看盘符 ⇒ **同盘不同工程树不报警**（而它给的补救正是坏掉的 `--pair`）。
 *   D18   "改了个寂寞"先打 `✓` 再 exit 1（包装脚本按 `✓` 判会误读）。
 *   D22   `apply` 不查孤儿行（`status` 查）⇒ 现在两边同口径。
 *   D24   重复 `--files` 的报错说"副本名会碰撞"，没说"同一个文件写了两遍"。
 *   缺陷1 `apply`/`status` 把"**另一个 patch 先改了这个文件**（基线过期）"误报成"有人绕过管线"
 *         ⇒ 现在按账本里所有 patch 的 `files[].path`（含 `also`）分辨两种情形，分别给正确补法。
 *   缺陷2 `status` 不提"两个未结 patch 撞同一个文件" ⇒ 现在有 `[撞车]` 段并计入卡住（exit 1）。
 *
 * ## 2026-09-24 第三轮修（「审查」判 reject 的三条程序性硬失败 + 三条新行为；**每一条都有原样输出**）
 *   硬失败3 **`rollback` 假绿**：老账本没有 `origAlso` 时，原来**先 `copyFileSync(orig,src)` 再检查**
 *         ⇒ 左边回了、右边没回（树分叉），而 `append({step:'rolledback'})` 在**循环之外** ⇒ 账本
 *         **零进度**；`status` 读到 `applied` 就报"已完成" **exit 0**。⇒ 现在 `rollback` 与 `apply`
 *         同口径：**先全部校验 → 再逐条回 → 逐条记进度**；校验不过**一个字节都不回**，把原因写进
 *         账本（`rollback-failed`），`status` 据此**报红**。
 *   K2c    半替换后 `rollback` 成功、树已一致，`status` 却仍把 `partial` 排最前，报
 *         「替换只做了一半…**重跑 apply** 可续做，或 rollback」—— 叫你去做的正是你刚做完的事。
 *         ⇒ `partial` 判据加**先后关系**：`replaced` 之后有 `rolledback` ⇒ 清零，改报
 *         「半途失败后**已 rollback**（这轮没交付）」。
 *   ⑰      链校验加到 `begin` ⇒ **老账本（没有 prev/self 的年代）整本锁死**，连新活都开不了，无迁移路。
 *         ⇒ 账本**开头连续的老格式前缀**算 `legacy`（**只警告、不算断链**），新记录从它之后重新起链；
 *         **链一旦开始**，之后的"没 self / self 不符 / prev 接不上"**照旧一律拒绝**
 *         （这才是当初要拦的形状：手工追加一行假 `verify ok` —— 那行没有 self）。**兼容，不是放宽。**
 *   ②      `--pair` 左值匹配逐字节比 ⇒ Windows 上 `A.TXT`（大小写）、`C:\PROGRA~1`（8.3 短名）
 *         被判"左值没有匹配到任何 --files 项" exit 2。⇒ 统一走 `normKey()`（`realpathSync.native()`
 *         同时规范化大小写与短名；不存在则 resolve + Windows 下 toLowerCase），并给"你是不是想写 X"提示。
 *   硬失败1 **R32 必须⑥「替换后复核」没有机制**（全文件只有一句 `console.log('下一步：替换后复核…')`，
 *         没有复核也 exit 0）。⇒ `apply` 之后**真的**从盘上读回复核「**指纹变了**」并记进账本
 *         （`sha(盘上) !== sha(账本里的 shaAfter)` ⇒ exit 1）；「**整体检查 exit 0**」走
 *         `apply --verify-cmd "<命令>"` 或 `postcheck --id <P> --cmd "<命令>"`，
 *         exit code 记进账本，**非 0 ⇒ status 报红**。
 *   ⚠ 硬失败2（16 处改动 0 条永久回归用例）由**新用例 `experiments/lab/L41_pipe_round2.mjs`** 治 ——
 *     本文件里那 16 条改动全部搬成"真跑子进程 + 正负控成对"的永久用例。
 *
 * ## 2026-09-24 第四轮修（「审查」判 reject 的两条新洞 + 一条 widening；**每一条都有负控/正控**）
 *   洞1 **假绿（与硬失败1 同一个形状）**：`stateOf` 的 `st.postcheck` **只认最后一条** `postchecked`
 *         ⇒ `apply --verify-cmd "node fail.mjs"`（exit 7，已记进账本、`status` 已报红）之后
 *         跑一条**更弱的复核** `postcheck --id X`（**不带 `--cmd`**，只核指纹）
 *         ⇒ 那条失败记录被**盖掉**，而那条失败的命令**从未重跑** ⇒ `status` 报「已完成」**exit 0**。
 *         ⇒ 现在两半**各自只认自己那一类**：指纹看最后一条 `kind:'fingerprint'`，
 *         **整体检查看最后一条 `kind:'verify-cmd'`**；**`cmd` 为空的复核不参与整体检查的判决**。
 *   洞1b **`apply` 不带 `--verify-cmd`** ⇒ 原来 `apply` exit 0 + `status` exit 0「已完成
 *         （…整体检查没跑过…）」。**判据（不许含糊）**：那**就是**"⑥ 后半段一次都不跑就绿灯"——
 *         R32 必须⑥ 逐字是「指纹变了 **+** 整体检查 exit 0」，只做前半段却报「已完成」= 假绿。
 *         ⇒ 现在 `apply` **必须二选一**：
 *           · `--verify-cmd "<命令>"`（真的起子进程跑，exit 0 才算过）；或
 *           · `--no-overall-check --why "<≥20 字>"`（**显式声明**这个 patch 没有整体检查，
 *             声明**记进账本**，`status` 逐字报出豁免理由）；
 *           两个都没给 ⇒ `apply` **exit 1**，账本里没有"整体检查已完成"的记录，
 *           `status` 把它列成卡住（`整体检查：**没跑也没声明**`）。
 *         **什么时候可以不跑**：只有上面那条 `--no-overall-check --why`（≥20 字，进账本）；
 *         **没有任何"默认不跑"的路** —— 老账本（`applied` 行没有 `recheck` 字段）不追溯判红，
 *         那是**兼容**边界，不是"可以不跑"。
 *   洞2 **假红（正常补救路被永久判死）**：`st.rollbackFailed = lastRollbackFailAt > lastRollbackEndAt`
 *         **不考虑其后是否已 `applied`**，而 `status` 又把 `rollbackFailed` **排在最前**
 *         ⇒ 实测形状（120 文件 `--pair` → 真 kill 半替换 → pair 设只读 → rollback 写盘失败
 *         → 修好权限 → **`apply` 续做 exit 0**、树全部 PATCHED、指纹复核通过）
 *         **最终 `status` 仍 exit 1**「rollback 中途失败」—— 一个**真交付**被永久报成卡住，
 *         补法只有重新 begin。同一形状在"**预检失败 + 后来 apply 成功**"也复现（实测）。
 *         ⇒ 现在 `rollbackFailed` **只在"其后没有更新的 `applied`（也没有更晚的 `rolledback`）"
 *         时才成立**：`lastRollbackFailAt > max(lastRollbackEndAt, lastAppliedAt)`。
 *   洞3 **⑰ 的兼容面 widening**：把**整本账本**每行的 `self`/`prev` 删掉（**不需要知道 chainHash**）
 *         ⇒ 整本被认成 `legacy` ⇒ 再追加一行**没有 self 的假 verify ok** ⇒ `apply` exit 0、
 *         **原件被替换**（实测）。对照：链引入时的写法（无条件 `r.self !== chainHash(r)`）
 *         会把"整本无 self"判成断链 ⇒ 拒绝。**伪造代价从"重算整条链"降到"删一个字段"**。
 *         ⇒ 见 `chainEraMarkers()` / `chainEraOnDisk()`：**老格式前缀必须是本文件写得出来的老格式**
 *         （只有链之前的版本才写不出 `self`/`prev`，所以带上链后字段/上链后盘上痕迹的"无 self 行"
 *         **一定是被删过**）⇒ 判断链拒绝；整本无 self 且无任何证据 ⇒ 老账本（警告 + **如实说明
 *         本文件分不清"老账本"与"有人把 self/prev 删了"**）。**§4② 那条（链开始后追加一行无 self）
 *         照旧拒绝 —— 一条没松。**
 *   洞4 **`normKey` 误合并**：`realpathSync.native()` **之后又无条件 `toLowerCase()`** ⇒ 在
 *         **大小写敏感**的目录里 `A.txt` 与 `a.txt` 是两个不同文件，却被归一成同一个 key
 *         ⇒ `begin --files cs/A.txt,cs/a.txt` 报「同一个文件写了两遍」exit 1（**误拒**）。
 *         ⇒ 盘上真实路径本身就是答案，**不再 toLowerCase**；只有"文件不存在"才退回小写（那时盘上无真相）。
 *   D16   `verify` 里 `const ROLES = [...]` 是**第 9 份硬编码角色名单**（漏掉无票的 `AI测试用户`，
 *         且 `roleRegistryAudit()` 扫不到）⇒ 现在**从 `warden.mjs` 的 `ROLE_REGISTRY` 派生**
 *         （`ALL_ROLE_IDS`，唯一事实源）；读不到那份文件 ⇒ **拒绝**（不许退回硬编码名单）。
 *
 * ## 它**不**做什么
 *   · 不替你判断改动对不对（那是角色的事）—— 它只保证"顺序没漏、证据在、能回滚"
 *   · 不删原件（替换前原件一个字节都不动）
 *   · 不做 git 操作
 *
 * ## ⚠ 三条**代理判据**（不是硬保证，别当密码学闸用）
 *   · **哈希链**（`prev`/`self`）拦的是"**随手往账本追加一行 `verify ok`**"；
 *     能改账本的人**照抄 `chainHash()` 就能重算整条链**（审查 2026-09-24 **实测**：重算后 `apply` exit 0）。
 *     链断时 `begin`/`dispatch`/`verify`/`apply`/`postcheck` 拒绝；`rollback` 只警告（它是逃生口）。
 *     ★ 账本**开头连续的老格式前缀**（哈希链引入之前写的行，没有 `prev`/`self`）**不算断链**，只警告 ——
 *       那是**兼容**（老记录无从校验），不是放宽：**链一旦开始**，之后的追加/改行仍然一律拒绝。
 *       ★★ 第四轮补（洞3）：老格式前缀**必须真的是老格式** —— 只有链之前的版本才写不出 `self`/`prev`，
 *          所以一条"无 self"的行只要带**上链之后才有的字段/步骤**（或盘上留着 `work@verify-N` 这类
 *          上链之后的痕迹）⇒ **判断链**。**"删掉 self/prev 就变 legacy"这条路被堵死。**
 *   · `verify --by <角色>` **只查"名字在不在名单里"，零鉴权** —— 主代理自己敲一行也能过（实测）。
 *     ★★ 第四轮补（D16）：名单**从 `ROLE_REGISTRY` 派生**（不再硬编码），但**鉴权本身仍然没有** ——
 *       这是**设计改动**（要投票），不在本轮范围（见 `.warden/DEVIATIONS.md` D1）。
 *   · "原件被绕过管线改了"的**成因分辨**依赖账本自称（`readLedger`），账本本身可被重算。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'   // ★ 硬失败1：R32 必须⑥ 的"整体检查"要真的起子进程跑
import { fileURLToPath, pathToFileURL } from 'node:url'   // ★ 第四轮 D16：角色名单从 ROLE_REGISTRY 派生

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (n, d = '') => {
  const i = args.indexOf('--' + n)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d
}
/** 本文件所在的目录（角色名单的单一事实源 `warden.mjs` 就在它旁边） */
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
/**
 * ★★ **D16（第四轮）**：角色名单**唯一事实源**是 `warden.mjs` 的 `ROLE_REGISTRY`
 *   （`ALL_ROLE_IDS` 由它派生，含**无票的 `AI测试用户`**）。
 *   原来这里是**第 9 份硬编码拷贝**（7 席、漏掉无票的那一席，而且 `roleRegistryAudit()` 扫不到）
 *   ⇒ 加/改角色时**静默漂移**。
 *   ⇒ 现在**派生**：`warden.mjs` 结尾有 `if (invoked)` 主入口守卫（`invoked` 要求 argv[1] 以
 *     `warden.mjs` 结尾）⇒ **import 它不会执行 CLI**（实测 47ms、无副作用）。
 *   ⚠ 读不到 ⇒ 返回 null ⇒ 调用方**拒绝**（exit 2），**不许退回硬编码名单** ——
 *     "名单散在多处"就是这个病。
 */
async function roleIdsFromRegistry() {
  try {
    const mod = await import(pathToFileURL(path.join(SELF_DIR, 'warden.mjs')).href)
    return Array.isArray(mod.ALL_ROLE_IDS) && mod.ALL_ROLE_IDS.length ? mod.ALL_ROLE_IDS : null
  } catch (e) {
    return null
  }
}
const ROOT = opt('root', process.cwd())
const WARDEN = path.join(ROOT, '.warden')
const PATCHES = path.join(WARDEN, 'patches')
const LEDGER = path.join(WARDEN, 'PATCHES.jsonl')

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16)
const now = () => new Date().toISOString()
/** ★ 修 bug①：副本名必须**唯一**（原来 `replace(/[\\/]/g,'__')` 会让 `a/b.mjs` 与 `a__b.mjs` 撞名） */
const copyName = (rel) => crypto.createHash('sha256').update(rel).digest('hex').slice(0, 8) + '__' + path.basename(rel)

/**
 * ★★ **缺陷3（2026-09-24 实测出来的真 bug）**：`--pair "左:右"` 原来写的是
 *   `const [l, r] = args[i + 1].split(':')` —— 在**含盘符的 Windows 路径**上会切错：
 *     "a.mjs:C:\\Users\\<USER>\\.dsh\\skills\\task-warden\\warden.mjs".split(':')
 *       → ['a.mjs','C','\\Users\\…']  ⇒  [l,r] = ['a.mjs','C']   ← 右半边只剩一个盘符
 *   而主代理自测时用的是**相对路径** `'a\\x.txt:b\\x.txt'` ⇒ 恰好没有第二个冒号 ⇒ "测过了"。
 *   ⇒ 现在两种写法都认，**新写法优先**：
 *     · `--pair "左|右"`  —— **推荐**：`|` 在 Windows 路径里不合法，永远不会歧义；
 *     · `--pair "左:右"`  —— 兼容旧写法：只在**第一个"不是盘符"的冒号**处切。
 *       盘符冒号判据：`X:` 的 X 是单个字母、紧跟 `\` 或 `/`、且 X 前面是串首或分隔符。
 *       例：`a.mjs:C:\x\a.mjs` 在第 5 个字符处切（右半边 `C:\x\a.mjs` 原样保留）；
 *           `C:\x\a.mjs:D:\y\a.mjs` 跳过第 1 个（盘符）冒号，在第 10 个字符处切。
 */
function splitPair(v) {
  const s = String(v)
  if (s.includes('|')) {
    const i = s.indexOf('|')
    return [s.slice(0, i).trim(), s.slice(i + 1).trim()]
  }
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ':') continue
    const driveColon = /[A-Za-z]/.test(s[i - 1] || '') && (s[i + 1] === '\\' || s[i + 1] === '/')
      && (i - 1 === 0 || /[\\/\s]/.test(s[i - 2] || ''))
    if (driveColon) continue
    return [s.slice(0, i).trim(), s.slice(i + 1).trim()]
  }
  return null
}

/** 镜像时要跳过的目录（与 `--with-dir` 的老口径一致） */
const MIRROR_SKIP = /(^|[\\/])(\.warden|node_modules|\.git)([\\/]|$)/

/**
 * ★★ **D9（审查实测）**：`--with-dir` 在**工程根文件**上恒失效 ——
 *   原来的写法是 `fs.cpSync(abs, dst, …)`，当 `rd === '.'` 时 `abs = ROOT` 而 `dst = work/`，
 *   也就是 **dst 是 src 的子目录** ⇒ 抛 `ERR_FS_CP_EINVAL: Cannot copy … to a subdirectory of self`，
 *   被 try/catch 吞成一行 `[警告]`、**exit 仍是 0**。
 *   而 docstring 举的原例（`warden.mjs` + `bill.mjs`）**正是工程根文件** ⇒ 这个功能从没跑通过。
 *   ⇒ 现在**逐条目**复制（不整棵 cpSync）：dst 在 src 里面时，跳过"包着 dst 的那一支"即可，
 *     而 `.warden` 本来就在跳过名单里 ⇒ 工程根这个旗舰场景真正能用。
 */
function mirrorDir(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true })
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, ent.name)
    const d = path.join(dstDir, ent.name)
    if (MIRROR_SKIP.test(s)) continue
    const back = path.relative(s, dstDir)
    // dstDir 在 s 里面（或就是 s）⇒ 跳过，否则又会踩"copy into a subdirectory of self"
    if (back === '' || (!back.startsWith('..') && !path.isAbsolute(back))) continue
    fs.cpSync(s, d, { recursive: true, filter: (x) => !MIRROR_SKIP.test(x) })
  }
}
/**
 * ★★ **D13（审查实测）**：混根警告的判据原来是"盘符根不同" ——
 *   `root(C:\a\x) === root(C:\b\y) === "C:\\"` ⇒ **同盘不同工程树时 roots.length = 1 ⇒ 不报警**。
 *   而它给的补救恰恰就是当时坏掉的 `--pair`。
 *   ⇒ 判据改成"**公共祖先只剩盘符根**"（同盘不同树、真跨盘都会命中）。
 */
function commonAncestor(list) {
  let cur = path.dirname(list[0])
  for (const p of list.slice(1)) {
    const d = path.dirname(p)
    for (;;) {
      const rel = path.relative(cur, d)
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) break
      const up = path.dirname(cur)
      if (up === cur) break
      cur = up
    }
  }
  return cur
}

/**
 * ★★ **新行为②（审查 2026-09-24 实测）**：`--pair` 的**左值匹配**原来只有
 *   `p[0] === f || path.resolve(ROOT, p[0]) === path.resolve(ROOT, f)` —— 两串**逐字节**比。
 *   在 Windows 上"**同一个文件的不同写法**"会被当成两个不同的东西。审查穷举出来的实测形状：
 *     · **过**：同字符串 / `.\a.txt` / `./a.txt` / 绝对 vs 相对 / 反斜杠 vs 正斜杠 / 尾随空格；
 *     · **不过**（⇒「左值没有匹配到任何 --files 项」**exit 2**）：`A.TXT`、`a.TXT`（大小写不同）、
 *       `C:\PROJEC~1`（**8.3 短名**）。
 *   ⇒ 现在统一走 `normKey()`：路径**存在**时用 `fs.realpathSync.native()` ——
 *     Windows 上它**同时**规范化大小写（返回盘上真实大小写）**并展开 8.3 短名**（实测
 *     `C:\PROJEC~1` → `C:\Project Archive`、`CASEtest.TXT` → `…\CaseTest.txt`）；
 *     不存在时退回 `path.resolve()` + Windows 下 `toLowerCase()`（大小写不敏感是 NTFS 的默认语义）。
 *   ⚠ 这是**平台语义**修正，不是放宽：左值仍然必须真的匹配上 `--files` 里的一项，否则照旧 exit 2
 *     （而且现在还会给"你是不是想写 X"的提示，不许只丢一句"没匹配"）。
 *   ★★ 第四轮补（洞4）：**存在时不再 `toLowerCase()`** —— 无条件小写会把大小写**敏感**目录里的
 *     `A.txt` / `a.txt`（两个不同文件）合并成同一个 key ⇒ 误报"同一个文件写了两遍"。详见 `normKey`。
 */
function normKey(p) {
  const abs = path.resolve(ROOT, String(p))
  try {
    /**
     * ★★ **洞4（审查 2026-09-24 实测的误判）**：原来这里 `realpathSync.native()` **之后又无条件
     *   `toLowerCase()`** ⇒ 在**大小写敏感**的目录里（`fsutil file setCaseSensitiveInfo <dir> enable`，
     *   WSL / 每目录开关），`A.txt` 与 `a.txt` 是**两个不同的文件**，却被归一成**同一个 key**
     *   ⇒ `begin --files cs/A.txt,cs/a.txt` 报「**同一个文件写了两遍**」exit 1
     *   —— **两个不同文件被误判成同一个**（方向是误拒，不是误覆盖，但确属误判）。
     *   ⇒ 盘上真实路径**本身就是答案**：
     *     · 大小写**不敏感**的卷上，`A.TXT` 与 `a.txt` 的 `realpathSync.native()` 返回**同一串**
     *       （真实大小写）⇒ 仍然是"同一个文件"，匹配/查重照旧生效；
     *     · 大小写**敏感**的目录里返回**两串** ⇒ 确实是两个文件。
     *     **再 `toLowerCase()` 只会把"两个"合成"一个"** —— 那正是误拒的来源。
     *   ⚠ 只有**文件不存在**时才退回 `path.resolve()` + Windows 下 `toLowerCase()`：
     *     那时盘上没有真相可读（Windows 的默认语义是大小写不敏感）。
     */
    return fs.realpathSync.native(abs)
  } catch (e) {
    return process.platform === 'win32' ? abs.toLowerCase() : abs
  }
}

/**
 * ★★ **缺陷1（2026-09-24 实测出来的误报）**：`stateOf` 原来只比「当前原件指纹 vs begin 时的 shaBefore」，
 *   一旦对不上就**一律**说「原件被**绕过管线**改了 —— 第三种漏」。
 *   实测：P-M3 与 P-M5 在**同一个** `warden.mjs` 上先后 `begin`（shaBefore 是同一基线），
 *   P-M3 先 `apply` ⇒ P-M5 的 `status` 报的却是「原件被绕过管线改了」。
 *   **拦住是对的，但原因说错了** —— 真实原因是「**另一个 patch（P-M3）先改了这个文件**」，也就是**基线过期**。
 *   ⇒ 判据：拿 `readLedger()` 里**所有** patch 的 `files[].path`（含 `--pair` 的第二份 `also`）
 *     按归一化绝对路径与当前这个对比，分辨两种情形：
 *       ① 有别的 patch 点了同一个文件（且它**真的 applied 且改动了它**）⇒「**基线过期**：<id> 先改了这个文件」；
 *       ② 账本里**没有**人碰过它 ⇒ 才是「**有人绕过管线手工改了**」。
 *   ⚠ 这只是**代理判据**：账本自己也可能被手工改（哈希链只拦"随手追加一行"）。
 */
function otherPatchesOn(rows, id, filePath) {
  const abs = path.resolve(ROOT, filePath)
  const all = new Map()   // pid -> {touched, applied, changedThis}
  for (const r of rows) {
    if (!r.id || r.id === id) continue
    let touches = false
    if (Array.isArray(r.files)) {
      for (const f of r.files) for (const p of [f.path, f.also].filter(Boolean)) if (path.resolve(ROOT, p) === abs) touches = true
    }
    if (Array.isArray(r.replaced)) {
      for (const x of r.replaced) if (x && x.path && path.resolve(ROOT, x.path) === abs) touches = true
    }
    if (!touches) continue
    const e = all.get(r.id) || { id: r.id, applied: false, changedThis: null }
    if (r.step === 'applied') {
      e.applied = true
      if (Array.isArray(r.replaced)) {
        const hit = r.replaced.find((x) => x && x.path && path.resolve(ROOT, x.path) === abs)
        // `replaced` 里有它 ⇒ 按 `changed` 如实记；没有它（只作 `also` 被写过）⇒ 视为"改了它"
        if (hit) e.changedThis = hit.changed !== false
        else if (e.changedThis === null) e.changedThis = true
      } else if (e.changedThis === null) e.changedThis = true
    }
    all.set(r.id, e)
  }
  return [...all.values()]
}
/** 把一个 bypass 条目分类：基线过期 / rollback 没带回第二份 / 第二份不见了 / 绕过管线手工改 */
function bypassKind(b, st) {
  const touchers = b.others || []
  const changers = touchers.filter((o) => o.applied && o.changedThis !== false)
  if (changers.length) return { kind: 'stale', changers, touchers }
  if (b.role === 'pair' && b.now === '(读不到)') return { kind: 'pair-missing', changers, touchers }   // ★ D12
  // ★ D5：rolledback 之后第二份没回来 —— 这是**管线自己的回滚做了一半**，不是外部绕过
  if (st && st.step === 'rolledback' && b.role === 'pair') return { kind: 'rollback-split', changers, touchers }
  return { kind: 'bypass', changers, touchers }
}

function readLedger() {
  if (!fs.existsSync(LEDGER)) return []
  return fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter((s) => s.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
}
/**
 * ★★ **2026-09-24 加哈希链（「资料员」实测出绕过路径①）**：
 *   它真的跑了：`begin` → 改 work/ → **手工往 `PATCHES.jsonl` 追加一行
 *   `{"step":"verified","verdict":"ok"}`** → `apply` **exit 0、原件被替换**。
 *   而且伪造行**没有 `copyShas`** ⇒ 副本指纹校验被 `if (verifiedSha && …)` **整条跳过** ⇒ **两道闸一起绕过**。
 *   ⇒ 现在每条记录都带 `prev`（上一条的 `self` 哈希）与 `self`（本条去掉 self 后的哈希）。
 *     任何**手工追加/删改**都会让链断掉 ⇒ `apply` 拒绝。
 *   ⚠ 它**不是密码学签名**（谁能改账本就能重算整条链）—— 它拦的是"**随手追加一行**"这种形态，
 *     不是有决心的伪造。要真防伪得让角色自己签名，那超出本机制范围，**如实标注为代理判据**。
 */
function chainHash(rec) {
  const { self, ...rest } = rec
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16)
}
function append(rec) {
  fs.mkdirSync(WARDEN, { recursive: true })
  const rows = readLedger()
  const prev = rows.length ? (rows[rows.length - 1].self || '') : ''
  const withPrev = { ...rec, prev }
  withPrev.self = chainHash(withPrev)
  fs.appendFileSync(LEDGER, JSON.stringify(withPrev) + '\n', 'utf8')
}
/**
 * 链是否完整（断在哪一条）。
 *
 * ★★ **新行为⑰（审查 2026-09-24 实测）**：链校验**加到 `begin`** 之后，**老账本整本锁死** ——
 *   造一份"链之前"的账本（`copied` 行**没有 `self`/`prev`**）：`status`→1、`dispatch`/`verify`/`apply`→1
 *   （"链断了"）、`rollback`→0（警告 + 执行），而 **`begin`→1 ⇒ 连新活都开不了**，
 *   且**没有任何迁移路径**。
 *   ⇒ 现在把"**还没有链的年代**"与"**链开始之后被改过**"分开：
 *     · 账本开头**连续一段**没有 `self` 的行 = **老格式前缀**（`legacy`）⇒ **不算断链**，只警告；
 *       新记录从这个前缀之后**重新起链**（`append` 对老尾行的 `prev` 取 `''` 正好接得上）；
 *     · **链一旦开始**（出现过带 `self` 的行），后面**任何**一条没有 `self`、`self` 对不上、`prev` 接不上
 *       ⇒ **仍然拒绝** —— 这保住了当初要拦的形状：`begin` 之后**手工往账本追加一行
 *       `{"step":"verified","verdict":"ok"}`**（那行**没有 `self`**，资料员 2026-09-24 实测过它让 apply exit 0）。
 *   ⚠ 这是**兼容**不是放宽：老前缀本来就无从校验（链是后加的）；**链开始之后**的追加/改行一条都没松。
 *
 * ★★ **洞3（第四轮修 · 审查实测出来的 widening）**：上面这条"老格式前缀"**被利用成一条捷径** ——
 *   实测：把**整本账本**每行的 `self`/`prev` 删掉（**不需要知道 `chainHash`，只要删字段**）
 *   ⇒ 整本被认成 `legacy` ⇒ 再追加一行**没有 `self` 的假 `verify ok`** ⇒ `apply` exit 0、
 *   **原件被替换**。对照：链引入时的写法（无条件 `r.self !== chainHash(r)`）会把"整本无 self"
 *   判成断链 ⇒ 拒绝。**⇒ 伪造代价从"重算整条链"降到"删一个字段"。**
 *   修法（审查给的三选一里的 ① + ② + ③）：
 *     ① **老格式前缀必须是本文件写得出来的老格式**：`self`/`prev` 是**链**引入的，所以
 *        "链之前的版本"写不出它们；反过来，**链之后才加进来的东西**（步骤 / 字段 / 盘上痕迹）
 *        就是**戳穿**"这条无 self 的行其实是被删过"的证据 —— 见 `chainEraMarkers()` / `chainEraOnDisk()`。
 *        一条**没有 `self`** 的行只要带其中任何一样 ⇒ **判"链断了"（拒绝）**。
 *     ② **"整本无 self" 与 "前缀无 self" 分开报**：整本无 self 且①全过 ⇒ 老账本（**警告** +
 *        如实说明"本文件**分不清**'老账本'与'有人把 self/prev 删了'"）；带证据 ⇒ 断链。
 *     ③ **如实降级**：哈希链本来就只是**代理判据**（能改账本的人能重算整条链）——
 *        经此一修，"删 self/prev 变 legacy"这条路**只剩"把整本改写成链之前的老格式"**这一种形状，
 *        不再是"删一个字段"。
 */
/**
 * **链之后才有的步骤** —— `orig`（链那一版）的 `append` 只写 `copied`/`verified`/`applied`/`rolledback`
 * （实测：`orig` 里 `append(` 只出现在这四处）⇒ 这五个步骤**不可能**出现在"链之前"的行里。
 */
const CHAIN_ERA_STEPS = new Set(['replacing', 'replaced', 'postchecked', 'restoring', 'rollback-failed'])
/**
 * **链之后才有的字段**：
 *   · `snapshot` —— 实测本仓真账本：P-M1 的 `verified` 行**有 self、没有 snapshot**，
 *     P-M2 起才有 `snapshot` ⇒ 它是**链之后**加的（所以"无 self 却有 snapshot"必是删过的）。
 *   · 其余（`recheck`/`kind`/`cmd`/`code`/`items`/`why`/`problems`/`files[].origAlso`/`copySha`）
 *     都是**本轮**（第四轮修的对象）加进来的 —— 老账本一定没有。
 */
const CHAIN_ERA_KEYS = ['snapshot', 'recheck', 'kind', 'cmd', 'code', 'items', 'why', 'problems', 'origAlso', 'copySha']
/** 一条"没有 self"的行带没带"只有链之后的版本才会写"的东西？（带 ⇒ 它是被删过 self 的新格式行） */
function chainEraMarkers(r) {
  const hit = []
  if (CHAIN_ERA_STEPS.has(r.step)) hit.push('step=' + r.step)
  for (const k of CHAIN_ERA_KEYS) if (Object.prototype.hasOwnProperty.call(r, k)) hit.push(k)
  if (Array.isArray(r.files)) for (const f of r.files) if (f && Object.prototype.hasOwnProperty.call(f, 'origAlso')) hit.push('files[].origAlso')
  return [...new Set(hit)]
}
/**
 * **盘上留下的"链之后"的痕迹**：`verify` 从 `orig`（链那一版）起就会快照 `work@verify-<n>/`。
 *   ⇒ 账本里某个 id 的工作目录下**存在** `work@verify-<n>/`，说明写它的版本**已经有链**
 *     ⇒ 这份账本"整本无 self"就**不可能是**老账本。
 *   ⚠ 读不到目录不算证据（`catch` 里什么都不做）—— 不许把"没看到"当成"证明"（A6）。
 */
function chainEraOnDisk(rows) {
  const hit = []
  for (const id of new Set(rows.map((r) => r.id).filter(Boolean))) {
    try {
      for (const n of fs.readdirSync(path.join(PATCHES, id))) if (/^work@verify-\d+$/.test(n)) hit.push(`${id}/${n}`)
    } catch (e) { /* 读不到 ⇒ 不算证据 */ }
  }
  return [...new Set(hit)].slice(0, 5)
}
function chainBroken() {
  const rows = readLedger()
  let start = 0
  while (start < rows.length && !rows[start].self) start++
  /**
   * ★ 洞3①：**"没有 self"本身不再是通行证** —— 老格式前缀里的每一条都必须真的是老格式。
   */
  for (let i = 0; i < start; i++) {
    const m = chainEraMarkers(rows[i])
    if (m.length) {
      return {
        broken: true, at: i + 1, legacy: 0,
        why: `第 ${i + 1} 条**没有 self**，却带着**只有哈希链之后的版本才会写**的东西（${m.join('、')}）`
          + ` ⇒ 它不可能是"链之前的老账本"，是有人把 self/prev 删了`,
      }
    }
  }
  if (start >= rows.length) {
    /**
     * ★ 洞3②：**整本都没有 self** —— 上面①已经拦掉"带链后字段"的那些；剩下的候选是：
     *   · 真的老账本（链之前的版本写的）；或
     *   · 有人把**整本**改写成链之前的老格式。
     *   再用**盘上痕迹**交叉核对一次（`work@verify-<n>/` 是链之后才有的）。
     */
    const onDisk = chainEraOnDisk(rows)
    if (onDisk.length) {
      return {
        broken: true, at: rows.length, legacy: 0,
        why: `整本账本都没有 self，但盘上留着**链之后才有的**快照目录（${onDisk.join('、')}）`
          + ` ⇒ 这不是"链之前的老账本"，是有人把 self/prev 删了`,
      }
    }
    return { broken: false, legacy: rows.length, wholeFile: true }
  }
  let prev = ''
  for (let i = start; i < rows.length; i++) {
    const r = rows[i]
    if (!r.self) return { broken: true, at: i + 1, why: '链开始之后的一条**没有 self**（手工追加的形态）', legacy: start }
    if (r.self !== chainHash(r)) return { broken: true, at: i + 1, why: 'self 与内容不符（被改过）', legacy: start }
    if ((r.prev || '') !== prev) return { broken: true, at: i + 1, why: 'prev 对不上上一条（被插入/删除过）', legacy: start }
    prev = r.self
  }
  return { broken: false, legacy: start }
}
/**
 * ★★ **D4（审查实测）**：链校验原来**只在 `apply` / `status` 生效** ——
 *   链断着 `begin` / `dispatch` / `verify` / `rollback` 全都 exit 0，而且**伪造者照抄那 4 行就能把整条链重算**
 *   （实测重算之后 `apply` exit 0、原件被替换）。
 *   ⇒ 现在的口径（**如实降级**，不再当密码学闸卖）：
 *     · `begin` / `dispatch` / `verify` / `apply`：链断 ⇒ **拒绝**（exit 1）；
 *     · `rollback`：链断只**大声警告**，**仍然允许** —— 它是"回到 begin 时字节"的**逃生口**，
 *       把逃生口也锁上就等于把坏账本变成不可恢复；
 *     · 它拦的是"**随手追加一行**"，**拦不住有决心的伪造**（能改账本的人能重算整条链）—— **代理判据**。
 */
function chainGuard(where) {
  const chk = chainBroken()
  if (!chk.broken) {
    /**
     * ★ 新行为⑰：**老格式前缀**（哈希链引入之前写的行）如实报出来，但**不拦** ——
     *   它是兼容，不是放行伪造：链开始之后的追加/改行仍然一条都跑不过（见 chainBroken）。
     * ★ 洞3②：**整本无 self** 是另一种形状，**必须分开说**，而且不许含糊 ——
     *   本文件**分不清**"链之前的老账本"与"有人把整本 self/prev 删了"（两者都无从校验）。
     */
    if (chk.wholeFile) {
      console.log(`[警告] 账本**整本 ${chk.legacy} 条都没有 self/prev**（哈希链引入之前的老格式）⇒ 无从校验，放行`)
      console.log('  ⚠ **本文件分不清**这两种形状：① 真的是链之前的老账本；② 有人把整本的 self/prev 删了')
      console.log('     ⇒ 判据只有一条（**代理判据，不是密码学闸**）：无 self 的行**不许带**链之后才有的东西')
      console.log('       （步骤 replacing/replaced/postchecked/restoring/rollback-failed；字段 snapshot/recheck/kind/cmd/code/items/origAlso…）')
      console.log('       —— 带了就判断链（洞3 的修法）。**把整本改写成链之前的老格式**这条路拦不住，如实说清')
      console.log('  ⇒ 想让它可校验：从这一条之后**重新起链**（`append` 对老尾行取 prev=\'\'，正好接得上）')
    } else if (chk.legacy) {
      console.log(`[警告] 账本里有 ${chk.legacy} 条**老格式记录**（哈希链引入之前写的，没有 prev/self）⇒ 从第 ${chk.legacy + 1} 条起才校验链`)
      console.log('  ⇒ 这是**兼容**：老记录本来就无从校验；**链一旦开始**，之后的追加/改行仍然一律拒绝')
    }
    return false
  }
  console.log(`[拒绝] 账本哈希链断了（第 ${chk.at} 条：${chk.why}）⇒ ${where} 不许继续`)
  console.log('  ⇒ 这正是"往账本追加一行伪造的 verify ok"那种绕过（资料员 2026-09-24 实测过 apply exit 0）')
  console.log('  ⇒ 洞3 的修法：**"没有 self"不再是通行证** —— 老格式前缀里的每一条都必须真的是老格式')
  console.log('  ⚠ 但这**只是代理判据**：谁能改账本就能重算整条链（实测重算后 apply 放行）—— 它不是密码学签名')
  console.log('  ⇒ 唯一还能用的命令是 `rollback`（逃生口：回到 begin 时的字节），它会带警告执行')
  return true
}
/** 把一个 patch 的所有记录折叠成当前状态（`rows` 可传，省得每个 id 都重读一遍账本） */
function stateOf(id, rows) {
  rows = rows || readLedger()
  const mine = rows.filter((r) => r.id === id)
  if (!mine.length) return null
  const st = { id, step: 'none', files: [], verify: null, applied: null, begin: null, bypassed: [] }
  /**
   * ★★ 硬失败3 / K2c：**"已经回滚过了吗"必须能判**（不许只看"有没有 replaced 行"）。
   *   ⇒ 记下三条关键记录的**下标**，用先后关系判"半替换"和"回滚是否已覆盖它"。
   */
  let lastReplacedAt = -1, lastReplacingAt = -1, lastRollbackEndAt = -1, lastRollbackFailAt = -1
  /** ★ 洞2：还要记 `applied` 的下标 —— "rollback 失败"之后**又真的交付了**就不该再报卡住 */
  let lastAppliedAt = -1
  for (let i = 0; i < mine.length; i++) {
    const r = mine[i]
    if (r.step === 'copied') { st.step = 'copied'; st.files = r.files; st.begin = r }
    if (r.step === 'verified') { st.verify = r; if (st.step !== 'applied' && st.step !== 'rolledback') st.step = 'verified' }
    // ★ 修 bug（记录 2026-09-24 实读出来的）：`applied` / `rolledback` 是**不可逆终态**，
    //   原来 `step` 被"最后一条记录"覆盖 ⇒ **apply 之后再 verify 会把 step 从 applied 变回 verified**
    //   ⇒ 下面那段"核对原件指纹"的条件成立 ⇒ 原件已被管线自己改过 ⇒ **bypassed 被误填** ⇒
    //   status 报「原件被绕过管线改了」+ exit 1 —— **一个已完成的 patch 被永久误报成卡住**。
    if (r.step === 'applied') { st.step = 'applied'; st.applied = r; lastAppliedAt = i }
    if (r.step === 'replacing') lastReplacingAt = i
    if (r.step === 'replaced') lastReplacedAt = i
    if (r.step === 'rolledback') { st.step = 'rolledback'; st.rolledback = r; lastRollbackEndAt = i }
    if (r.step === 'rollback-failed') { st.rollbackFail = r; lastRollbackFailAt = i }
    /**
     * ★ 硬失败1（R32 必须⑥）：`postchecked` 是"替换后复核"的结果 ——
     *   指纹复核（管线自己做的）与整体检查（`--verify-cmd` / `postcheck --cmd`）都记在这里。
     *
     * ★★ **洞1（第四轮修 · 审查实测的假绿）**：原来只留**最后一条**（`st.postcheck = r`）——
     *   于是 `apply --verify-cmd "node fail.mjs"`（exit 7、已记进账本）之后，
     *   一条**更弱的**复核 `postcheck --id X`（**不带 `--cmd`**，只核指纹）就把那条失败记录
     *   **盖掉**，而那条失败的命令**从未重跑** ⇒ `status` 报「已完成」**exit 0**。
     *   ⇒ 现在**两半各自只认自己那一类**：指纹看最后一条 `kind:'fingerprint'`，
     *     **整体检查看最后一条 `kind:'verify-cmd'`** —— `cmd` 为空的复核**不参与整体检查的判决**。
     *   `st.postcheck` 仍然留"最后一条"（只为展示"最后发生了什么"），**判决一律走下面两个字段**。
     */
    if (r.step === 'postchecked') {
      st.postcheck = r
      if (r.kind === 'verify-cmd') st.postcheckCmd = r
      else if (r.kind === 'waived') st.postcheckWaived = r
      else st.postcheckFp = r
    }
  }
  /**
   * ★ **绕过路径**（主代理 2026-09-24 自查出来的第三种漏）：
   *   实测：`begin` 之后**不用管线、直接手工覆盖原件** ⇒ 管线**不知道**，
   *   只报"复制了没检查"—— 原件已经被改了，而账本上还写着"原件没动"。
   *   ⇒ 每次 `stateOf` 都核对原件的真实指纹与 `begin` 时记的 `shaBefore`。
   *
   * ★★ **2026-09-24 D7/D6 补**：
   *   ① **D7**：`apply` 中途失败会留下**半替换**（管线自己改过一部分原件）——
   *      原来那段豁免只认 `applied`，于是"管线自己装的"被误诊成"外部绕过管线" ⇒ 修好后**永久卡死**。
   *      ⇒ 现在把账本里所有 `replacing/replaced/applied` 记过的路径收进 `pipelineWrote`，
   *        凡**本管线自己写过**的原件**不再算"外部改动"**，另立 `st.partial` 如实报"半替换"。
   *   ② **D6**：`rolledback` 原来是**豁免**之一 ⇒ 手工改完原件再 `apply` 会**静默覆盖**。
   *      而正常情况下 rollback 之后原件**应当等于** `shaBefore` ⇒ 豁免它没有理由。
   *      ⇒ 豁免只剩 `applied`（apply 之后原件本来就该变，那是终态）。
   *   ③ **D5/D12**：`--pair` 的**第二份**（`also`）原来**从不核对** ⇒
   *      rollback 只回左边后右边悄悄分叉、第二份被删了 apply 还会静默重建。
   *      ⇒ 现在第二份按 `alsoShaBefore` 一并核对，记进同一个 `bypassed` 数组（`role: 'pair'`）。
   */
  const pipelineWrote = new Set()
  const pipelineLast = new Map()
  for (const r of mine) {
    if (r.step === 'replaced' && r.path) {
      pipelineWrote.add(path.resolve(ROOT, r.path))
      if (r.shaAfter) pipelineLast.set(path.resolve(ROOT, r.path), r.shaAfter)
    }
    /**
     * ★ **D7 续做的关键兜底**：`replacing` 行（带 `copySha`）说明"本管线正要往这里写这一版"。
     *   若进程在 `copyFileSync` 之后、`replaced` 行之前被打断，盘上就是这一版 ——
     *   没有这条兜底，重跑 `apply` 会把它误诊成"绕过管线手工改"⇒ **永久卡死**。
     *   ⚠ 顺序保证：同一个 `path` 之后若还有 `replaced` 行，会**覆盖**这里的兜底值（`replaced` 更权威）。
     */
    if (r.step === 'replacing' && r.path && r.copySha) {
      pipelineWrote.add(path.resolve(ROOT, r.path))
      pipelineLast.set(path.resolve(ROOT, r.path), r.copySha)
    }
    if (r.step === 'rolledback' && Array.isArray(r.restored)) {
      for (const x of r.restored) {
        if (!x.path) continue
        pipelineWrote.add(path.resolve(ROOT, x.path))
        if (x.now) pipelineLast.set(path.resolve(ROOT, x.path), x.now)
      }
    }
    if (r.step === 'applied' && Array.isArray(r.replaced)) for (const x of r.replaced) pipelineWrote.add(path.resolve(ROOT, x.path))
  }
  st.pipelineWrote = [...pipelineWrote]
  /**
   * ★ D8①：`partial` 必须**只认"替换进行到一半"** —— 一开始写成"管线写过任何东西"，
   *   于是 `begin → rollback` 那条也被误报成"半替换"，把 D8① 的真实症状（洗白"复制了没检查"）盖住了。
   *   判据：有 `replaced` 记录（= 真的开始替换了）但**没有** `applied` 记录。
   * ★★ **K2c（审查 2026-09-24 实测）**：还要**排掉"已经 rollback 过了"** —— 原来只看
   *   "有 replaced、没有 applied" ⇒ **半替换之后 rollback 成功、树已经一致**，`status` 仍然判 partial
   *   并把 `partial` 那条**排在最前** ⇒ 报「替换只做了一半…**修好权限重跑 apply 可续做，或 rollback**」，
   *   而它叫你去做的**正是你刚做完的事**（自相矛盾的红）。
   *   ⇒ 判据加**先后关系**：`replaced` 之后**有** `rolledback` ⇒ 已经回滚过了 ⇒ `partial` 清零，
   *     改由 `halfRolledBack` 如实报"半途失败后已回滚（这轮没交付）"。
   * ★★ **硬失败3**：`rollback-failed`（预检没过／回滚中途失败）之后 `partial` **不许**被清掉 ——
   *   "回滚失败"意味着树**可能仍然是半替换**，清掉就成了新的假绿。判据只看 `rolledback`（成功终态）。
   * ★ 进度判据用 `replacing`/`replaced` **两者中更晚的那个**（`lastWriteAt`）：只写下 `replacing`
   *   就被打断（没来得及记 `replaced`）也是**实打实的进度**，不许漏判。
   */
  const lastWriteAt = Math.max(lastReplacingAt, lastReplacedAt)
  st.halfRolledBack = lastWriteAt >= 0 && lastRollbackEndAt > lastWriteAt
  /**
   * ★★ **洞2（第四轮修 · 审查实测的假红）**：原来 `st.rollbackFailed = lastRollbackFailAt > lastRollbackEndAt`
   *   —— **不考虑其后是否已经 `applied`**。实测的自然路径（不是手搓账本）：
   *     120 文件 `--pair` → 真 kill 半替换 → 把 pair 设只读 → `rollback` 写盘失败（记 `rollback-failed`）
   *     → **修好权限 → `apply` 续做 exit 0**（已替换 121 个文件、树全部 PATCHED、指纹复核通过）
   *     ⇒ 最终 `status` **exit 1**「★★ rollback 中途失败」—— 一个**真交付**被永久报成卡住，
   *       补法只有重新 begin。**同一形状在"预检失败 + 后来 apply 成功"也复现**（实测）。
   *   ⇒ 判据改成"**其后没有更新的 `applied`，也没有更晚的 `rolledback`**"：
   *     一次失败的 rollback 只说明"**到那时为止**树没回来"；**之后真的 `applied` 了**，
   *     那个失败已经被后来的交付**取代**（`applied` 里逐条记了 `shaAfter`，复核也会再核一遍）。
   *   ⚠ 没有更新的 `applied` 时**照旧报红**（`apply` 之后再 rollback 失败 ⇒ 树可能半回滚）。
   */
  st.rollbackFailed = (lastRollbackFailAt > lastRollbackEndAt && lastRollbackFailAt > lastAppliedAt) ? st.rollbackFail : null
  st.partial = !st.applied && lastWriteAt >= 0 && lastRollbackEndAt < lastWriteAt
  /**
   * ★★ **洞1 / 洞1b 的判决字段**（第四轮）：`recheck` 的**两半**各自算，**谁也不许覆盖谁**。
   *   · `recheckFpOk`  —— 最后一条 `kind:'fingerprint'` 的复核（管线自己从盘上读回核的）
   *   · `recheckCmdOk` —— 最后一条 `kind:'verify-cmd'`（**真的起了子进程**的整体检查）的 exit==0
   *   · `recheckWaived`—— 作者**显式声明**"这个 patch 没有整体检查"（`--no-overall-check --why`，≥20 字）
   *   ⇒ 三态：`ok` / `waived` / `fail` / `missing`（`missing` = 既没跑也没声明）。
   */
  st.recheckRequired = !!(st.applied && st.applied.recheck === 'required')
  st.recheckFpOk = !!(st.postcheckFp && st.postcheckFp.ok)
  st.recheckCmdOk = !!(st.postcheckCmd && st.postcheckCmd.ok)
  st.recheckWaived = !!st.postcheckWaived
  st.overallState = st.postcheckCmd ? (st.postcheckCmd.ok ? 'ok' : 'fail') : (st.postcheckWaived ? 'waived' : 'missing')
  const checkOne = (role, relPath, want) => {
    const abs = path.resolve(ROOT, relPath)
    try {
      const cur = sha(abs)
      if (cur === want) return
      /**
       * ★ D7 的关键一句：当前字节**正是本管线自己写下的那一版** ⇒ **不是**外部绕过。
       *   ⚠ 但 `rolledback` 状态**不豁免**（D6）：apply→rollback 之后原件本来就该等于基线，
       *     若还等于"管线写过的某一版"就说明 rollback 没把它带回来（D5 的分叉形状）。
       */
      if (st.step !== 'rolledback' && pipelineLast.get(abs) === cur) return
      st.bypassed.push({ path: relPath, role, was: want, now: cur, others: otherPatchesOn(rows, id, relPath) })
    } catch (e) {
      st.bypassed.push({ path: relPath, role, was: want, now: '(读不到)', others: otherPatchesOn(rows, id, relPath) })
    }
  }
  if (st.step !== 'applied' && st.files.length) {
    for (const f of st.files) {
      checkOne('file', f.path, f.shaBefore)
      if (f.also) checkOne('pair', f.also, f.alsoShaBefore)
    }
  }
  return st
}

// ─────────────────────────────────────────────────────────────── begin
if (cmd === 'begin') {
  const id = opt('id')
  const files = opt('files').split(',').map((s) => s.trim()).filter(Boolean)
  /**
   * ★ **2026-09-24 加 `--pair "左:右"`（实现工程师实测出来的洞）**：
   *   P-M3 的 `begin` **混了两个根** —— `--files` 里一个是 skill 绝对路径、三个是 `--root` 相对路径
   *   ⇒ `apply` 只按 `path.resolve(ROOT, f.path)` 逐个替换 ⇒ 装完**两份拷贝分叉**
   *     （skill/warden.mjs 变了、repo/warden.mjs 没变；repo 的 lab 变了、skill 的没变）
   *     ⇒ 而 `L25_copy_sync.mjs` 就是查这个同步的 ⇒ **apply 完 L25 必红**（I51 的形状）。
   *   ⇒ 现在可以点名"同一个文件的第二份"：`--pair "a.mjs|b.mjs"`（可重复；`:` 也认，见 `splitPair`）。
   *     `begin` 会把两份都复制进 orig/work；`apply` **两边一起写**；`rollback` **两边一起回滚**
   *     （★ D5：原来 rollback 只回左边 —— 现在右边界也存进 `orig/`，真的两边一起回）。
   */
  const pairs = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pair' && args[i + 1]) {
      const pr = splitPair(args[i + 1])
      if (!pr || !pr[0] || !pr[1]) {
        console.log(`[拒绝] --pair 没法解析成「左|右」：${args[i + 1]}`)
        console.log('  ⇒ 用 `--pair "左|右"`（含盘符的 Windows 路径**必须**用 | ，或让 : 只出现在盘符之后）')
        process.exit(2)
      }
      pairs.push(pr)
    }
  }
  if (!id || !files.length) {
    console.log('[用法] patch-pipeline.mjs begin --id P1 --files a.mjs,b.mjs [--root <工程根>]')
    console.log('        [--pair "左|右"]（可重复，**推荐**：`--pair "a.mjs|C:\\x\\a.mjs"`）')
    console.log('        [--pair "左:右"]（兼容旧写法；只在**不是盘符**的第一个冒号处切）')
    console.log('        [--with-dir]（把原件目录镜像进 work/，让副本能 import 兄弟文件）')
    process.exit(2)
  }
  if (stateOf(id)) { console.log(`[拒绝] ${id} 已经 begin 过了 —— 不许覆盖（要重来就换 id）`); process.exit(1) }
  if (chainGuard('begin')) process.exit(1)   // ★ D4：链断着不许再往账本上追加（否则等于替伪造者续链）
  /**
   * ★★ **D24（审查实测）**：`--files` 里同一个文件写两遍时，原来靠"副本名碰撞"兜底，
   *   报错文案却是"副本名会碰撞"，**没说"你把同一个文件写了两遍"**。
   *   ⇒ 先按归一化绝对路径点名这个用法错。
   * ★ 新行为②（同一类）：`path.resolve()` 逐字节比在 Windows 上分不清 `a.txt` / `A.TXT`
   *   （同一个文件）⇒ 现在走 `normKey()`（realpath + 大小写归一），否则"写了两遍"会漏掉。
   */
  const absFiles = files.map((f) => path.resolve(ROOT, f))
  /**
   * ⚠ **性能**：`normKey()` 会调 `realpathSync.native()`（一次系统调用）——
   *   所以**每个文件只算一次 key**，后面全都比 key（原来写成 O(n²) 的两两 `normKey` 比，
   *   120 个文件就多花 ~2.6 秒 —— 实测 begin 从 1.0s 涨到 3.6s；现在恢复 O(n)）。
   */
  const fileKeys = files.map(normKey)
  const fileKeySet = new Set(fileKeys)
  const pairLeftKeys = pairs.map((p) => normKey(p[0]))
  const pairFor = new Map()   // 文件 key → 它的 --pair（右半边）
  for (let i = 0; i < pairs.length; i++) if (!pairFor.has(pairLeftKeys[i])) pairFor.set(pairLeftKeys[i], pairs[i])
  /** 找重复：O(n)（Set），返回值是**后出现的那些原始写法** */
  const dupBy = (list) => {
    const seen = new Set(); const dups = []
    for (const x of list) { const k = normKey(x); if (seen.has(k)) dups.push(x); else seen.add(k) }
    return [...new Set(dups)]
  }
  const dupFile = dupBy(files)
  if (dupFile.length) {
    console.log(`[拒绝] --files 里**同一个文件写了两遍**：${dupFile.join(', ')}`)
    console.log('  ⇒ 一次 begin 里它会被复制两次、apply 时写两次（后者静默胜出）—— 只写一次就够')
    process.exit(1)
  }
  // 同根检查：混根时**大声警告**（不是拒绝 —— 有时确实要跨树改，但必须知道）
  // ★ D13：判据从"盘符根不同"改成三条任一成立：
  //   ① 跨盘；② **有的在 --root 里、有的在外面**（P-M3 的真形状：一个 skill 绝对路径 + 几个相对路径）；
  //   ③ 公共祖先只剩盘符根（全在外面、同盘不同树）。
  const roots = [...new Set(absFiles.map((f) => path.parse(f).root))]
  const common = absFiles.length > 1 ? commonAncestor(absFiles) : path.dirname(absFiles[0])
  const inside = (f) => { const rel = path.relative(ROOT, f); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) }
  const mixedInOut = absFiles.some(inside) && absFiles.some((f) => !inside(f))
  const onlyDriveShared = absFiles.length > 1 && common === path.parse(common).root
  if (roots.length > 1 || mixedInOut || onlyDriveShared) {
    console.log(`[警告] --files **不在同一棵树里**（${absFiles.length} 个文件：跨盘=${roots.length > 1}，有在 --root 外的=${mixedInOut}，公共祖先=${common}）`)
    console.log('  ⇒ **apply 不会自动同步另一份**：' + '如果每个文件有"第二份拷贝"，请用 --pair "左|右" 点名，否则装完两份会分叉（L25 会红）')
    console.log('')
  }
  // ★ 修 bug①：先断言副本名唯一（撞了就拒，不许静默互相覆盖）
  const names = files.map(copyName)
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  if (dup.length) {
    console.log(`[拒绝] 副本名会碰撞：${[...new Set(dup)].join(', ')} ⇒ 同一 patch 里两个输入会互相覆盖（修 bug①前的真 bug）`)
    process.exit(1)
  }
  /**
   * ★★ **D11（审查实测）**：两个左值 `--pair` 到**同一个右值** ⇒ 右值被写两次、后者静默胜出。
   *   原来的"唯一性断言"**只覆盖 `files`，不覆盖 `also`** —— 与它声称修好的 bug① 同一类，
   *   只是搬到了 pair 侧。⇒ 现在把所有**写入目标**（左 + 右）一起查重，撞了就拒。
   * ★ 新行为②：查重也走 `normKey()`（大小写/8.3 短名是同一个文件 ⇒ 同样撞车，不许漏）。
   */
  const targets = []
  for (let i = 0; i < files.length; i++) {
    targets.push(files[i])
    const pr = pairFor.get(fileKeys[i])
    if (pr) targets.push(pr[1])
  }
  const dupTarget = dupBy(targets)
  if (dupTarget.length) {
    console.log(`[拒绝] 有**两个不同的输入会写到同一个文件**：${dupTarget.join(', ')}`)
    console.log('  ⇒ 后者会静默覆盖前者（这就是"副本名唯一"断言漏掉的 pair 侧同类 bug）')
    process.exit(1)
  }
  // ★ D1：`--pair` 的左值必须**真的匹配**到某个 --files 项 —— 否则静默丢弃（P-M3 的真形状）
  //   ★ 新行为②：匹配走 `normKey()`（大小写/8.3/相对 vs 绝对/正反斜杠都算同一个文件）；
  //     匹配不上时**给出"你是不是想写 X"的提示**，不许只丢一句"没匹配"。
  const unmatched = pairs.filter((p, i) => !fileKeySet.has(pairLeftKeys[i]))
  if (unmatched.length) {
    console.log(`[拒绝] --pair 的左值**没有匹配到任何 --files 项**：${unmatched.map((p) => p[0]).join(', ')}`)
    console.log('  ⇒ 原来这里是**静默丢弃**（exit 0、零提示）—— 而"两份拷贝分叉"正是 L25 要抓的 I51 形状')
    console.log('  ⇒ 左值必须与 --files 里的某一项指向**同一个文件**（同字符串 / 同绝对路径 / 大小写不同 / 8.3 短名都认）')
    for (const p of unmatched) {
      const base = path.basename(p[0]).toLowerCase()
      const near = files.filter((f) => path.basename(f).toLowerCase() === base)
      if (near.length) console.log(`     ★ 你是不是想写 \`${near[0]}\`？—— 它在 --files 里`)
      else console.log(`     ★ --files 里现在只有：${files.join(', ')}`)
    }
    process.exit(2)
  }
  /**
   * ★ 顺手补的（**同一类"未捕获栈"缺陷**，D7 的兄弟）：`--files`/`--pair` 指向**目录/设备**时，
   *   `existsSync` 是 true，接着 `copyFileSync` 抛 **EISDIR/EPERM 的未捕获 node 栈**
   *   （不是 `[拒绝]` 文案）—— 实测 `begin --files C:\PROGRA~1` 会打一整段 `node:fs:3090` 栈。
   *   ⇒ 在**做任何镜像/复制之前**先按"普通文件"逐一预检（也顺带修掉 `--with-dir` 会对 `C:\` 做镜像）。
   */
  for (const f of files) {
    const abs = path.resolve(ROOT, f)
    if (!fs.existsSync(abs)) { console.log(`[拒绝] 原件不存在：${abs}`); process.exit(1) }
    if (!fs.statSync(abs).isFile()) {
      console.log(`[拒绝] --files 里的这一项**不是普通文件**（目录/设备？）：${abs}`)
      console.log('  ⇒ 本管线只替换普通文件；目录要改就点名目录**里面**的具体文件')
      process.exit(1)
    }
  }
  for (const p of pairs) {
    const abs = path.resolve(ROOT, p[1])
    if (!fs.existsSync(abs)) { console.log(`[拒绝] --pair 指向的第二份不存在：${abs}`); process.exit(1) }
    if (!fs.statSync(abs).isFile()) {
      console.log(`[拒绝] --pair 指向的第二份**不是普通文件**（目录/设备？）：${abs}`); process.exit(1)
    }
  }
  const dir = path.join(PATCHES, id)
  fs.mkdirSync(path.join(dir, 'orig'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true })
  /**
   * ★ **2026-09-24 加 `--with-dir`（实现工程师实测出来的缺口）**：
   *   work/ 里**只有被点名的那一个文件** ⇒ 它 `import './兄弟.mjs'` 时在 work/ 里找不到兄弟
   *   ⇒ **副本既不能 import 也不能当 CLI 跑**（`ERR_MODULE_NOT_FOUND`）。
   *   加了 `--with-dir` 就把**原目录整个镜像**进 `work/`（跳过 `.warden`/`node_modules`/`.git`），
   *   这样副本能原地跑 —— 但要注意它会顺带把兄弟文件也复制进来（**不是**替换目标）。
   *   ★ D9：工程根（`rd === '.'`）原来**恒失败**（dst 是 src 的子目录）⇒ 现在逐条目复制。
   *   ★ D10：`rd` 含 `..` 时原来会镜像到 `work/` **之外** ⇒ 现在只许落在 `work/` 里。
   */
  const withDir = args.includes('--with-dir')
  if (withDir) {
    const rels = [...new Set(absFiles.map((f) => path.dirname(f)))]
    for (const abs of rels) {
      let relRd = path.relative(ROOT, abs)
      if (relRd === '.') relRd = ''
      if (relRd.startsWith('..') || path.isAbsolute(relRd)) {
        relRd = path.join('__outside__', crypto.createHash('sha256').update(abs).digest('hex').slice(0, 8))
        console.log(`[警告] --with-dir：${abs} 在工程根之外 ⇒ 镜像到 work/${relRd}（**绝不许写到 work/ 之外**）`)
      }
      const dst = path.join(dir, 'work', relRd)
      const back = path.relative(path.resolve(dir, 'work'), path.resolve(dst))
      if (back.startsWith('..') || path.isAbsolute(back)) {
        console.log(`[拒绝] --with-dir 的镜像目标跑出 work/ 了：${dst}`); process.exit(2)
      }
      try {
        mirrorDir(abs, dst)
      } catch (e) {
        console.log(`[拒绝] --with-dir 镜像 ${abs} 失败：${String(e.message).slice(0, 120)}`)
        console.log('  ⇒ 原来这里只打一行 [警告] 然后 **exit 0** ⇒ 你以为有兄弟文件、其实副本还是孤立的')
        console.log('  ⇒ 要么把目录搞对，要么**去掉 --with-dir**（副本仍是孤立的，dispatch 会提醒你）')
        process.exit(1)
      }
    }
  }
  const rec = []
  for (const f of files) {
    const src = path.resolve(ROOT, f)
    const name = copyName(f)
    const orig = path.join(dir, 'orig', name)
    const work = path.join(dir, 'work', name)
    fs.copyFileSync(src, orig)   // ★ 修 bug②：只读的那一份
    fs.copyFileSync(src, work)   // 工作副本
    // ★ --pair：同一个文件的"第二份拷贝"（apply/rollback 时两边一起写）
    //   ★ 新行为②：左值匹配走 normKey()（大小写/8.3 短名/相对 vs 绝对都算同一个文件）
    const pr = pairFor.get(normKey(f))
    const also = pr ? pr[1] : null
    let origAlso = null
    if (also && !fs.existsSync(path.resolve(ROOT, also))) {
      console.log(`[拒绝] --pair 指向的第二份不存在：${path.resolve(ROOT, also)}`); process.exit(1)
    }
    if (also) {
      // ★ D5：第二份也要有**只读原件**，否则 rollback 无从恢复它（原来就是这样，右边永远回不来）
      origAlso = path.join(dir, 'orig', name + '.__pair')
      fs.copyFileSync(path.resolve(ROOT, also), origAlso)
    }
    rec.push({
      path: f, shaBefore: sha(src), name,
      orig: path.relative(ROOT, orig), copy: path.relative(ROOT, work),
      also, alsoShaBefore: also ? sha(path.resolve(ROOT, also)) : null,
      origAlso: origAlso ? path.relative(ROOT, origAlso) : null,
    })
  }
  append({ at: now(), id, step: 'copied', files: rec })
  const np = rec.filter((r) => r.also).length
  console.log(`✓ ${id} 已复制 ${rec.length} 个文件（**两份**：orig/ 只读 + work/ 工作副本）到 ${path.relative(ROOT, dir)}`)
  if (np) console.log(`  ★ 其中 ${np} 个点名了第二份拷贝（--pair）⇒ apply 会**两边一起写**，rollback 也**两边一起回**（D5 已修）`)
  console.log('  ⚠ 原件现在**一个字节都没动** —— 只有 apply 才会替换；orig/ 永远可回滚')
  console.log('  下一步：`dispatch --id ' + id + '` 拿到「原件 → 工作副本」映射，把它交给子代理')
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────── dispatch（★ 修 bug③：补"派"这一步）
if (cmd === 'dispatch') {
  const id = opt('id')
  if (!id) { console.log('[用法] patch-pipeline.mjs dispatch --id P1'); process.exit(2) }
  if (chainGuard('dispatch')) process.exit(1)   // ★ D4
  const st = stateOf(id)
  if (!st) { console.log(`[拒绝] ${id} 没有 begin`); process.exit(2) }
  console.log(`【${id} 派单映射】子代理**只许改 work/ 里的这一份**，不许碰原件、不许碰 orig/：`)
  for (const f of st.files) {
    console.log('  ' + f.path + '   →   ' + f.copy + '   （只读原件：' + f.orig + '）')
  }
  console.log('')
  console.log('  ⚠ **这份副本是"孤立"的** —— 它原来同目录的兄弟文件（`./xxx.mjs` 之类）不在 work/ 里。')
  console.log('     实测（2026-09-24 实现工程师踩到）：`warden.mjs` 第 28 行 `import … from \'./bill.mjs\'`')
  console.log('     ⇒ **在 work/ 里既不能 import、也不能当 CLI 跑**（ERR_MODULE_NOT_FOUND）。')
  console.log('     ⇒ 要跑就把 work/ 那份**连同它需要的兄弟文件**复制到一个临时目录再跑；')
  console.log('        或者 `begin` 时加 `--with-dir`（把原目录整个镜像进 work/，见用法）。')
  console.log('')
  console.log('  交回时必须给**原样输出**（跑过的检查 + 结果），然后由角色 `verify`。')
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────── verify
if (cmd === 'verify') {
  const id = opt('id'), by = opt('by'), verdict = opt('verdict'), evidence = opt('evidence')
  if (!id || !by || !verdict) { console.log('[用法] patch-pipeline.mjs verify --id P1 --by 审查 --verdict ok|bad --evidence "原样输出"'); process.exit(2) }
  if (chainGuard('verify')) process.exit(1)   // ★ D4
  const st = stateOf(id)
  if (!st) { console.log(`[拒绝] ${id} 没有 begin —— 先复制再检查（不许直接检查原件）`); process.exit(2) }
  if (verdict === 'ok' && !evidence) { console.log('[拒绝] verdict=ok 必须带 --evidence（原样输出）—— 拿"我看了没问题"当检查不算'); process.exit(1) }
  /**
   * ★★ **D3（审查实测）如实降级**：这里**只做"名字在不在名单里"的形状检查，没有任何鉴权** ——
   *   实测 `verify C1 --by 审查 --verdict ok --evidence "aaaa…(22 个 a)"` ⇒ exit 0 ⇒ `apply` exit 0。
   *   原来那句"**主代理自检不许冒充角色检查**"是**文案承诺了它做不到的事** ⇒ 删掉，改成如实的话。
   * ★★ **D16（第四轮修）**：名单**不再硬编码** —— 真名单只有 `warden.mjs` 的 `ROLE_REGISTRY`
   *   （8 席，含**无票的 `AI测试用户`**）。原来这里是**第 9 份硬编码拷贝**（7 席、静默排除无票那一席），
   *   而且 `roleRegistryAudit()` **扫不到**它 ⇒ 加/改角色时这里静默漂移。
   *   ⇒ 现在**从 `ROLE_REGISTRY` 派生**（`ALL_ROLE_IDS`）。**读不到 ⇒ 拒绝（exit 2）**，
   *     不许退回硬编码名单（那正是"名单散在多处"的老病）。
   *   ⚠ **鉴权本身仍然没有**（主代理自己敲一行也能过，实测）—— 那是**设计改动**，要走投票，
   *     不在本轮范围（`.warden/DEVIATIONS.md` D1）。
   */
  const ROLES = await roleIdsFromRegistry()
  if (!ROLES) {
    console.log('[拒绝] 读不到角色名单的**单一事实源**（`warden.mjs` 的 `ROLE_REGISTRY`）⇒ 不许猜名单')
    console.log(`  ⇒ 找的是：${path.join(SELF_DIR, 'warden.mjs')}`)
    console.log('  ⇒ 本文件必须与 `warden.mjs` 同目录；work/ 里的**孤立副本**要连同兄弟文件一起复制（见 dispatch）')
    process.exit(2)
  }
  if (!ROLES.includes(by)) {
    console.log(`[拒绝] --by 不在角色名单里（现在给的是「${by}」）—— 这只是**名单形状检查**，不是身份认证`)
    console.log('  ⚠ 本闸**拦不住冒充**：主代理自己敲 `--by 审查 --evidence "…20 字以上…"` 就能过（审查 2026-09-24 实测）')
    console.log('  ⇒ 独立性只能靠"派独立子代理、且产物里不许引用它自己的结论"，**这是代理判据，不是鉴权**')
    process.exit(1)
  }
  /**
   * ★★ 提问闸门指出的缺口：原来 `verify` **不记"检查的是哪一份"** ⇒
   *   **检查之后副本又被改了，`apply` 照样把没检查过的版本装上去** ——
   *   形状就是"**检查了，但检查的不是被替换的东西**"。
   *   ⇒ 现在记下 work/ 此刻的指纹，`apply` 必须核对它没变。
   */
  const copyShas = []
  for (const f of st.files) {
    try { copyShas.push({ path: f.path, copySha: sha(path.resolve(ROOT, f.copy)) }) }
    catch (e) { copyShas.push({ path: f.path, copySha: '(读不到)' }) }
  }
  if (verdict === 'ok' && copyShas.some((x) => x.copySha === '(读不到)')) {
    console.log('[拒绝] 副本读不到 ⇒ 不许判 ok（检查的必须是真实存在的那一份）'); process.exit(1)
  }
  if (verdict === 'ok' && String(evidence).trim().length < 20) {
    console.log(`[拒绝] --evidence 太短（${String(evidence).trim().length} 字）—— 原样输出至少要能看出你跑了什么、结果是什么`)
    process.exit(1)
  }
  /**
   * ★★ **2026-09-24 加"每次 verify 都留档被审的那一版"**（实现工程师如实报出的缺口）：
   *   它返工 P-M2 时**原地覆盖了 work/** ⇒ 事后**找不到"被审成 bad 的那一版"的字节**
   *   ⇒ 只能用"变异副本"复现"改前"，**没法用原字节重跑**。
   *   ⇒ 现在每次 `verify` 都把当前的 `work/` 快照到 `work@verify-<n>/`（n = 该 id 第几次 verify）。
   *     这样"被审的是哪一版"永远留档，`rollback`/复核都能指回具体字节。
   */
  const nVerify = readLedger().filter((r) => r.id === id && r.step === 'verified').length + 1
  const snapDir = path.join(PATCHES, id, `work@verify-${nVerify}`)
  try {
    fs.mkdirSync(snapDir, { recursive: true })
    for (const f of st.files) {
      const c = path.resolve(ROOT, f.copy)
      if (fs.existsSync(c)) fs.copyFileSync(c, path.join(snapDir, path.basename(c)))
    }
  } catch (e) { console.log(`[警告] verify 快照失败：${String(e.message).slice(0, 80)}`) }
  append({ at: now(), id, step: 'verified', by, verdict, evidence: String(evidence).slice(0, 2000), evidenceLen: String(evidence).length, copyShas, snapshot: path.relative(ROOT, snapDir) })
  if (verdict === 'ok') {
    console.log(`✓ ${id} 角色检查通过（${by}）`)
    console.log('  下一步：`apply --id ' + id + '` 把 work/ 替换回原件')
    console.log('  ⚠ **检查了不替换 = 等于没做**（用户原话）')
  } else {
    console.log(`✗ ${id} 角色检查未通过（${by}）—— **不许 apply**；改完再 verify 一次`)
  }
  console.log(`  （被审的那一版已留档：${path.relative(ROOT, snapDir)} —— 返工覆盖 work/ 也能事后复核）`)
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────── apply
if (cmd === 'apply') {
  const id = opt('id')
  if (!id) { console.log('[用法] patch-pipeline.mjs apply --id P1'); process.exit(2) }
  const st = stateOf(id)
  if (!st) { console.log(`[拒绝] ${id} 没有 begin`); process.exit(2) }
  if (st.step === 'applied') { console.log(`[拒绝] ${id} 已经 apply 过了`); process.exit(1) }
  // ★★ 链校验：手工往账本追加一行伪造的 verify ok ⇒ 链断 ⇒ 拒绝（资料员实测出的绕过路径①）
  if (chainGuard('apply')) process.exit(1)
  /**
   * ★★ **D22（审查实测）**：`status` 查"没有 id 的孤儿行"，而 **`apply` 不查** ⇒
   *   配上"重算整条链"（D4），假 verify ok 照样能过闸。⇒ 现在两边同口径。
   */
  const orphanRows = readLedger().filter((r) => !r.id)
  if (orphanRows.length) {
    console.log(`[拒绝] 账本里有 ${orphanRows.length} 条**没有 id 的记录** ⇒ 不许替换`)
    console.log('  ⇒ 这正是"手工往 PATCHES.jsonl 追加一行伪造的 verify ok"的形态')
    process.exit(1)
  }
  /**
   * ★★ **缺陷1 / D5 / D6 / D7**：原件（或它的第二份）与 begin 时的基线不符 ⇒ 拒绝。
   *   但**原因必须说清**，不许一律说"有人绕过管线"：
   *     ① 账本里**别的 patch** 真的 applied 且改动了它 ⇒ **基线过期**（先后关系）+ 正确的补法；
   *     ② rolledback 之后**第二份没回来** ⇒ 管线自己的回滚做了一半（D5）；
   *     ③ 谁都没碰过 ⇒ 才是"**绕过管线手工改**"（第三种漏）。
   *   ⚠ 本管线**自己装的半成品**不算外部改动（D7）—— 那走 `st.partial` 那条分支。
   */
  if (st.bypassed && st.bypassed.length) {
    const parts = st.bypassed.map((b) => ({ b, k: bypassKind(b, st) }))
    const stale = parts.filter((x) => x.k.kind === 'stale')
    const split = parts.filter((x) => x.k.kind === 'rollback-split')
    const gone = parts.filter((x) => x.k.kind === 'pair-missing')
    const manual = parts.filter((x) => x.k.kind === 'bypass')
    if (stale.length) {
      const names = [...new Set(stale.flatMap((x) => x.k.changers.map((c) => c.id)))]
      console.log(`[拒绝] ${id} **基线过期：${names.join(', ')} 先改了这个文件** ⇒ 不许替换`)
      for (const { b, k } of stale) {
        console.log(`   ${b.role === 'pair' ? '[第二份] ' : ''}${b.path}  ${b.was} → ${b.now}`)
        console.log(`   ★ 先改了它的是：${k.changers.map((c) => c.id + '(账本里已 applied)').join(', ')}`)
      }
      console.log('  ⇒ 这是**先后关系**，不是"有人绕过管线"：你和它点的是同一个文件的**同一份基线**。')
      console.log('  补法①（推荐）：重新 `begin` 一个 id（把**现在**的原件当基线），把改动 **rebase** 到新基线上，走完 verify 再 apply')
      console.log('  补法②：在新基线的 work/ 副本上重做改动 —— **不许**拿旧副本直接替换')
    }
    if (gone.length) {
      console.log(`[拒绝] ${id} **--pair 的第二份不见了** ⇒ 不许替换`)
      for (const { b } of gone) console.log(`   [第二份] ${b.path}  （begin 时 = ${b.was}，现在读不到）`)
      console.log('  ⇒ 原来 apply 会**静默把它重建**（`alsoShaBefore` 记了却从不使用）—— 现在拒绝')
      console.log('  补法：重新 begin 一个 id（把现在的两棵树当基线）')
    }
    if (split.length) {
      console.log(`[拒绝] ${id} **rollback 没把第二份带回来（两份分叉）** ⇒ 不许替换`)
      for (const { b } of split) console.log(`   [第二份] ${b.path}  ${b.was} → ${b.now}`)
      console.log('  ⇒ D5 的形状：原来 rollback **只回左边**（而 begin 逐字承诺"rollback 也是"）')
      console.log(`  补法：再跑一次 \`rollback --id ${id}\`（现在两边一起回），或重新 begin 一个 id`)
    }
    if (manual.length) {
      console.log(`[拒绝] ${id} **原件已经被绕过管线改过了**（或它的第二份被外部改过）⇒ 不许替换`)
      for (const { b } of manual) console.log(`   ${b.role === 'pair' ? '[第二份] ' : ''}${b.path}  ${b.was} → ${b.now}`)
      const touchers = [...new Set(manual.flatMap((x) => (x.b.others || []).filter((o) => !o.applied).map((o) => o.id)))]
      if (touchers.length) {
        console.log(`   ⚠ 账本里另有**未结**的 patch 也点了它：${touchers.join(', ')}（但**没有** applied）`)
        console.log('     ⇒ 你与它们是**撞车**关系（`status` 的 [撞车] 段会列出来）')
      }
      console.log('  ⇒ 这正是"复制改完不检查"之外的第三种漏：**不复制、直接在原件上改**')
      console.log(`  补法：重新 begin 一个 id（把现在的原件当基线），走完 verify 再 apply`)
    }
    process.exit(1)
  }
  if (!st.verify || st.verify.verdict !== 'ok') {
    console.log(`[拒绝] ${id} **没有"角色检查通过"的记录 ⇒ 不许替换**`)
    console.log('  ⇒ 这正是用户点名的第一个漏：**复制改完不检查**')
    console.log(`  补法：patch-pipeline.mjs verify --id ${id} --by <角色> --verdict ok --evidence "原样输出"`)
    process.exit(1)
  }
  // ★ 事务（方向员缺口⑤）：先全部校验，再逐个替换，**逐条记进度**
  const planned = []
  for (const f of st.files) {
    const src = path.resolve(ROOT, f.path)
    const copy = path.resolve(ROOT, f.copy)
    if (!fs.existsSync(copy)) { console.log(`[拒绝] 副本不见了：${copy}`); process.exit(1) }
    const nowCopySha = sha(copy)
    const verifiedSha = (st.verify.copyShas || []).find((x) => x.path === f.path)
    if (verifiedSha && verifiedSha.copySha !== nowCopySha) {
      console.log(`[拒绝] ${f.path} **检查之后副本又被改过** ⇒ 检查的不是被替换的那一份`)
      console.log(`   检查时副本指纹 = ${verifiedSha.copySha}`)
      console.log(`   现在副本指纹   = ${nowCopySha}`)
      console.log(`   ⇒ 补法：重新 verify（对现在这一份）再 apply`)
      process.exit(1)
    }
    /**
     * ★★ **D12（审查实测）**：`--pair` 的第二份在 begin 之后被删 ⇒ 原来 apply **静默重建**它
     *   （`alsoShaBefore` 记了却**从不使用**）。⇒ 现在缺了/变了就拒，并说清是哪一种。
     */
    if (f.also) {
      const alsoAbs = path.resolve(ROOT, f.also)
      const wroteByPipeline = (st.pipelineWrote || []).includes(alsoAbs)
      if (!fs.existsSync(alsoAbs)) {
        console.log(`[拒绝] --pair 的第二份**在 begin 之后不见了**：${alsoAbs}`)
        console.log('  ⇒ 原来 apply 会**静默把它重建**（`alsoShaBefore` 记了却从不使用）—— 现在拒绝')
        console.log('  补法：重新 begin 一个 id（把现在的两棵树当基线）')
        process.exit(1)
      }
      const nowAlso = sha(alsoAbs)
      if (!wroteByPipeline && f.alsoShaBefore && nowAlso !== f.alsoShaBefore) {
        const others = otherPatchesOn(readLedger(), id, f.also)
        const changers = others.filter((o) => o.applied && o.changedThis !== false)
        if (changers.length) {
          console.log(`[拒绝] ${f.also}（第二份）**基线过期：${changers.map((c) => c.id).join(', ')} 先改了它**`)
        } else {
          console.log(`[拒绝] ${f.also}（第二份）**在 begin 之后被改过** —— 不是本管线装的，也不是别的 patch`)
        }
        console.log(`   begin 时 = ${f.alsoShaBefore}`)
        console.log(`   现在     = ${nowAlso}`)
        console.log('  补法：重新 begin 一个 id 拿新基线，或 rollback 回到 begin 时的字节')
        process.exit(1)
      }
    }
    planned.push({ f, src, copy, copySha: nowCopySha })
  }
  /**
   * ★★ **D7（审查实测）**：原来"事务"只在校验层，**写盘层没有** ——
   *   把第二个目标置为只读 ⇒ `copyFileSync` 抛 **未捕获的 Node 栈**（EPERM，没有 `[拒绝]` 文案），
   *   第一个目标**已被替换**（半替换），账本里**零进度**，之后**永久卡死**
   *   （status 把管线自己改的误诊成"绕过管线"，重试 apply 又被那条误诊拒掉）。
   *   ⇒ 现在：① **先全部校验可写**（只读属性 / 权限）—— 有一个不可写就**一个字节都不动**；
   *     ② 逐个替换并**逐条记进度**（`replacing` / `replaced`），失败时能**续做**或明确回滚。
   */
  const unwritable = []
  for (const p of planned) {
    for (const t of [p.src, ...(p.f.also ? [path.resolve(ROOT, p.f.also)] : [])]) {
      try { fs.accessSync(t, fs.constants.W_OK) } catch (e) { unwritable.push(`${t}  （${e.code || String(e.message).slice(0, 60)}）`) }
    }
  }
  if (unwritable.length) {
    console.log(`[拒绝] ${id} **有目标现在不可写 ⇒ 这次一个字节都没替换**（事务：先全部校验再逐个替换）`)
    for (const u of unwritable) console.log('   ' + u)
    console.log('  ⇒ 修好可写权限再重跑 apply（账本里**没有任何替换进度**，等于这次没动过）')
    process.exit(1)
  }
  const replaced = []
  const failed = []
  for (const p of planned) {
    /**
     * ★ **逐条记进度的补强（让 D7 的"可续做"真的成立）**：原来 `replacing` 只记左边、
     *   且**不带副本指纹** ⇒ 若进程在 `copyFileSync` 之后、`append(replaced)` 之前被打断
     *   （被 kill / 断电 —— 实测 `kill` 打断一次 300 文件的 apply 会稳定留下 1~2 个这样的文件），
     *   那个文件**盘上已是新内容、账本里却没有对应的 `replaced` 行** ⇒ `pipelineLast` 认不出它
     *   ⇒ 下一次 `apply` 把它误诊成「**绕过管线手工改的**」⇒ **永久卡死**，续做反而被拒。
     *   ⇒ 现在 `replacing` 先记（左与第二份各记一条）并带上 `copySha`；`stateOf` 用 `copySha`
     *     兜底认"这正是本管线正要写下去的那一版" ⇒ 续做不再误诊。
     */
    const tgts = [{ path: p.f.path, shaBefore: p.f.shaBefore, dest: p.src, isPair: false }]
    if (p.f.also) tgts.push({ path: p.f.also, shaBefore: p.f.alsoShaBefore, dest: path.resolve(ROOT, p.f.also), isPair: true })
    let failedOn = p.f.path
    try {
      for (const t of tgts) {
        failedOn = t.path
        append({ at: now(), id, step: 'replacing', path: t.path, shaBefore: t.shaBefore, copy: p.f.copy, copySha: p.copySha, isPair: t.isPair })
        fs.copyFileSync(p.copy, t.dest)
        const after = sha(t.dest)
        const rec = { path: t.path, shaBefore: t.shaBefore, shaAfter: after, changed: t.shaBefore !== after, ...(t.isPair ? { isPair: true } : {}) }
        append({ at: now(), id, step: 'replaced', ...rec })
        replaced.push(rec)
      }
    } catch (e) {
      failed.push({ path: failedOn, err: e.code || String(e.message).slice(0, 100) })
      break
    }
  }
  if (failed.length) {
    console.log(`[拒绝] ${id} **替换中途失败** —— 已替换 ${replaced.length} 份，剩下的没动（**半替换**，账本已逐条记进度）`)
    for (const x of failed) console.log(`   ★ ${x.path} 写入失败：${x.err}`)
    console.log('  ⇒ 这次**不是**"绕过管线"：改它的就是本管线，账本里有 replacing/replaced 进度')
    console.log(`  补法①：修好写入权限后**重跑 apply --id ${id}**（已装的会按 copySha 再校验一次，可续做）`)
    console.log(`  补法②：patch-pipeline.mjs rollback --id ${id}  —— 从 orig/ 回到 begin 时的字节，再重来`)
    process.exit(1)
  }
  // ★ `recheck: 'required'` = 这一版管线**必须**有"替换后复核"，`status` 据此判红（老账本没有这个字段 ⇒ 见 status 的兼容分支）
  append({ at: now(), id, step: 'applied', by: st.verify.by, replaced, recheck: 'required' })
  /**
   * ★★ **硬失败1（审查 2026-09-24 实测）—— R32 必须⑥「替换后复核」没有机制**：
   *   SPEC 逐字：「**替换后复核**：替换完再验一次（**指纹变了 + 整体检查 exit 0**）」。
   *   原来 apply 里**只有一句 `console.log('下一步：替换后复核…')`**（全文件只出现这一次）：
   *     `$ apply --id M1` ⇒ `✓ M1 已替换 1 个文件…` `下一步：替换后复核…` ⇒ **exit 0**
   *   —— **没有复核也 exit 0**，"下一步"是给模型看的建议，**不是机制**。
   *   ⇒ 现在两半都落成机制（都可机检）：
   *     ① **指纹变了**：写盘循环结束后**重新从盘上读回**每个被替换的文件，核对
   *        **`sha(盘上) === 账本里的 shaAfter`**（= 写盘真的落下去了；逐条还带 `changed`）⇒
   *        记进账本 `postchecked(kind:'fingerprint')`；不符 ⇒ apply **exit 1**（这次替换不算成功），`status` 报红。
   *        ⚠ 判据**不是**"每一份都必须变" —— 一个 patch 里允许有点名了却没改的文件（那种情况 apply 是对的）；
   *        "**全都一个字都没改**"才叫改了个寂寞，由下面的 `allNoop` 管（R32：等于没做）。
   *     ② **整体检查 exit 0**：`apply --verify-cmd "<命令>"` 会**真的起子进程跑**（cwd = 工程根），
   *        exit code 记进账本；**非 0 ⇒ apply exit 1 + status 报红**。事后也能补跑：
   *        `postcheck --id <P> --cmd "<命令>"`（同一个记账口径）。
   *   ★★ **洞1b（第四轮修 · 审查实测的假绿）**：原来**不带 `--verify-cmd`** 时
   *     `apply` exit 0 + `status` exit 0「已完成（…整体检查没跑过…）」，账本只有
   *     `{kind:'fingerprint',ok:true,cmd:null}`，**只在文本里印一句 ⚠**。
   *     **判据（不许含糊）**：那**就是**"⑥ 后半段可以一次都不跑就绿灯" —— R32 必须⑥ 逐字是
   *     「指纹变了 **+** 整体检查 exit 0」，只做前半段却报「已完成」= 假绿（与硬失败1 同一个形状）。
   *     ⇒ 现在 `apply` **必须二选一**（两个都没给 ⇒ **exit 1**，`status` 列成卡住）：
   *       · `--verify-cmd "<命令>"` —— 真的跑；或
   *       · `--no-overall-check --why "<≥20 字>"` —— **显式声明**"这个 patch 没有整体检查"，
   *         声明**记进账本**（`postchecked(kind:'waived')`），`status` 逐字报出豁免理由。
   *     **什么时候可以不跑**：只有后者（≥20 字、进账本）；**没有任何"默认不跑"的路**。
   *     老账本（`applied` 行没有 `recheck` 字段）**不追溯判红** —— 那是**兼容**边界，不是"可以不跑"。
   *   ★ **D18 一并收紧**：这一版 apply 只要**不是两半都过**，就**不打印 `✓`**（原来 `!reOk` 那条
   *     会先打 `✓ 已替换…` 再 exit 1 ⇒ 包装脚本按 `✓` 判会误读）。
   */
  const recheck = []
  for (const r of replaced) {
    try {
      const cur = sha(path.resolve(ROOT, r.path))
      /**
       * ⚠ **判据要精确**：复核的是"**盘上的字节就是账本里记下的那一版**"（写盘真的落下去了）。
       *   原来这里写成 `cur !== r.shaBefore`（要求**每一份都必须变**）—— 那是错的：
       *   一个 patch 里**允许**有点名了却没改的文件（L37 的夹具就是 a.txt 改了、b.txt 没改），
       *   那种情况下 apply 是**对的**，不该被判红。**"全都一个字都没改"**才叫改了个寂寞（下面 allNoop 管）。
       */
      recheck.push({ path: r.path, ok: cur === r.shaAfter, now: cur, want: r.shaAfter, was: r.shaBefore, changed: !!r.changed })
    } catch (e) {
      recheck.push({ path: r.path, ok: false, now: '(读不到)', want: r.shaAfter, was: r.shaBefore, changed: !!r.changed })
    }
  }
  const reOk = recheck.length > 0 && recheck.every((x) => x.ok)
  append({ at: now(), id, step: 'postchecked', kind: 'fingerprint', ok: reOk, cmd: null, code: null, items: recheck })
  /**
   * ★★ **2026-09-24 修（「记录」实读出来的洞）**：全部 `changed=false` 时原来**照样 exit 0**、
   *   `status` 报"已完成" —— 而 R32 的约束（出处已隐去 —— 公开版不留逐字）要求：**检查完了却没替换掉现有的，等于没做**。
   *   "复制了、检查了、替换了，但**一个字都没改**"**同样是等于没做**，不许判成功。
   *   ★ **D18（审查实测）**：原来这里先打 `✓ … 已替换 N 个文件` **再** exit 1 ⇒ 包装脚本按 `✓` 判会误读。
   *      ⇒ 现在全都没变时**不打印 ✓**（连下面复核段的 `✓ 指纹变了` 也不打），改打 `[卡住]`。
   *   ⚠ 顺序说明：`postchecked` 行**先记进账本**（复核确实跑过），但**打印**放在这条 exit 之后 ——
   *     否则"改了个寂寞"的输出里又会出现 `✓`，D18 就回来了。
   */
  const noop = replaced.filter((r) => !r.changed)
  const allNoop = noop.length === replaced.length
  if (allNoop) {
    console.log(`[卡住] ${id} 替换了 ${replaced.length} 个文件，但**所有文件替换前后指纹相同**`)
    for (const r of replaced) console.log('   ' + (r.changed ? '变了' : '**没变**') + '  ' + r.path + '  ' + r.shaBefore + ' → ' + r.shaAfter)
    console.log('  ★ **所有文件替换前后指纹相同 ⇒ 这等于"改了个寂寞"、等于没做**（用户 R32 口径）')
    console.log('   ⇒ 请确认副本真的被改过；`status` 会把它列为卡住。')
    console.log('   （账本已记 applied，但状态判据会把"全都没变"当失败）')
    process.exit(1)
  }
  const verifyCmd = opt('verify-cmd')
  /**
   * ★ 洞1b：**显式豁免**。`--no-overall-check --why "<≥20 字>"` = 作者声明"这个 patch 没有整体检查"
   *   （纯文档/纯数据之类）。**理由必须 ≥20 字并写进账本** —— 不许悄悄跳过。
   */
  const noOverall = args.includes('--no-overall-check')
  const noOverallWhy = String(opt('why') || '').trim()
  let cmdCode = null
  if (verifyCmd) {
    const vr = spawnSync(verifyCmd, { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 600000 })
    cmdCode = vr.status === null ? -1 : vr.status
    append({
      at: now(), id, step: 'postchecked', kind: 'verify-cmd', ok: cmdCode === 0, cmd: verifyCmd, code: cmdCode,
      out: String((vr.stdout || '') + (vr.stderr || '')).slice(-800),
    })
  } else if (noOverall) {
    if (noOverallWhy.length < 20) {
      console.log(`[拒绝] \`--no-overall-check\` 必须带 \`--why "<≥20 字>"\`（现在 ${noOverallWhy.length} 字）—— 豁免理由要进账本`)
      console.log('  ⇒ 声明"没有整体检查"是一个**要留档的决定**，不是一句"跳过"')
      console.log('  ⇒ 账本已记 applied（替换是真的做了）；补一条合格的豁免或一条真检查：')
      console.log(`     node patch-pipeline.mjs postcheck --id ${id} --no-overall-check --why "<为什么这个 patch 没有整体检查>"`)
      console.log(`     node patch-pipeline.mjs postcheck --id ${id} --cmd "<你的整体检查命令>"`)
      process.exit(1)
    }
    append({ at: now(), id, step: 'postchecked', kind: 'waived', ok: true, cmd: null, code: null, why: noOverallWhy })
  }
  /**
   * ★ D18：**不是两半都过就不打 `✓`**。
   */
  const overallOk = verifyCmd ? cmdCode === 0 : (noOverall && noOverallWhy.length >= 20)
  const doneAll = reOk && overallOk
  console.log(`${doneAll ? '✓' : '[卡住]'} ${id} 已替换 ${replaced.length} 个文件（事务：先全部校验再逐个替换）`
    + (doneAll ? '' : '，但**替换后复核没做完/没过** —— 不许当成功'))
  for (const r of replaced) console.log('   ' + (r.changed ? '变了' : '**没变**') + '  ' + r.path + '  ' + r.shaBefore + ' → ' + r.shaAfter)
  console.log('  ★ 替换后复核（R32 必须⑥「指纹变了 + 整体检查 exit 0」）：')
  for (const x of recheck) {
    console.log('     ' + (x.ok ? (x.changed ? '✓ 指纹变了（字节与账本一致）' : '· 这一份**没变**（副本本来就与原件一致）') : '★ 盘上字节**与账本里的替换记录不符**')
      + '  ' + x.path + '  ' + x.was + ' → ' + x.now)
  }
  if (verifyCmd) console.log(`     ${cmdCode === 0 ? '✓' : '★'} 整体检查 \`${verifyCmd}\` exit=${cmdCode}`)
  else if (noOverall) console.log(`     ${overallOk ? '· 整体检查：**作者显式豁免**' : '★ 整体检查：豁免理由太短'}（${noOverallWhy.length} 字）：${noOverallWhy}`)
  if (!reOk) {
    console.log('  ★ **复核没通过：盘上的字节与账本里的替换记录不符 ⇒ 这次替换不算成功**（已记进账本，status 会报红）')
    console.log(`   ⇒ 可回滚：patch-pipeline.mjs rollback --id ${id}`)
    process.exit(1)
  }
  if (!verifyCmd && !noOverall) {
    /**
     * ★★ 洞1b 的执法点：**没跑也没声明 ⇒ exit 1**。
     */
    console.log('  ★ **整体检查：没跑，也没声明 ⇒ R32 必须⑥ 只做了一半**（SPEC 逐字要"指纹变了 **+** 整体检查 exit 0"）')
    console.log('     ⇒ 这一版 apply **不算完成**（exit 1，`status` 会把它列成卡住）。二选一补上：')
    console.log(`        ① 跑真检查：node patch-pipeline.mjs postcheck --id ${id} --cmd "<你的整体检查命令>"`)
    console.log(`        ② 显式豁免：node patch-pipeline.mjs postcheck --id ${id} --no-overall-check --why "<为什么这个 patch 没有整体检查（≥20 字）>"`)
    console.log('     ⚠ 为什么不做成"只提示"：那样 `status` 会在**整体检查一次都没跑**时报"已完成" —— 那是假绿（同硬失败1）')
    console.log(`  可回滚：patch-pipeline.mjs rollback --id ${id}`)
    process.exit(1)
  }
  if (!overallOk) {
    console.log(`  ★ **整体检查${verifyCmd ? '没过' : '的豁免理由不合格'} ⇒ 这次替换不算成功**（已记进账本，status 会报红）`)
    console.log(`   ⇒ 可回滚：patch-pipeline.mjs rollback --id ${id}`)
    process.exit(1)
  }
  console.log(`  可回滚：patch-pipeline.mjs rollback --id ${id}`)
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────── postcheck（★ 硬失败1：替换后复核，可单独补跑）
if (cmd === 'postcheck') {
  const id = opt('id')
  const cmdOpt = opt('cmd')
  const noOverall = args.includes('--no-overall-check')
  const noOverallWhy = String(opt('why') || '').trim()
  if (!id) { console.log('[用法] patch-pipeline.mjs postcheck --id P1 [--cmd "<整体检查命令>" | --no-overall-check --why "<≥20 字>"]'); process.exit(2) }
  if (chainGuard('postcheck')) process.exit(1)
  const st = stateOf(id)
  if (!st) { console.log(`[拒绝] ${id} 没有 begin`); process.exit(2) }
  if (!st.applied) {
    console.log(`[拒绝] ${id} **还没替换** —— 复核是对"已经替换过的树"的复核，不许拿它冒充"角色检查"`)
    console.log('  ⇒ 顺序固定：begin → dispatch → verify（角色）→ apply → **postcheck**（替换后复核）')
    process.exit(1)
  }
  /**
   * ★★ **洞1（第四轮修）的第二半**：`postcheck` **不带 `--cmd`** 时，原来会打
   *   `✓ 替换后复核 通过（R32 必须⑥）` 并 **exit 0** —— 而它**只核了指纹**，
   *   整体检查那一半**一次都没跑**。实测（审查）：
   *     `apply --verify-cmd "node fail.mjs"` ⇒ exit 1、`status` 报红
   *     → `postcheck --id L1`（**不带 `--cmd`**）⇒ **exit 0「✓ …通过（R32 必须⑥）」**
   *     → `status` ⇒ **exit 0「已完成（…整体检查没跑过…）」** ← ★★ 假绿
   *   ⇒ 现在**三态**（`--cmd` 跑真检查 / `--no-overall-check --why` 显式豁免 / 只核指纹）：
   *     · 只核指纹时**必须**看这一版 apply 的整体检查**是不是已经过了或被显式豁免**；
   *       没有 ⇒ **exit 1**，并逐字说"整体检查**从没跑过**"（不许报"复核通过"）。
   *     · `--cmd` 时：**指纹**与**整体检查**各自算，`ok` 记的是**两半的合取**。
   *     · `--no-overall-check --why`：理由 ≥20 字才收（进账本 `kind:'waived'`）。
   *   ⚠ 判决字段与 `status` 同源（`st.postcheckCmd` / `st.postcheckFp` / `st.postcheckWaived`）——
   *     **一条不带 `--cmd` 的复核永远盖不掉一条 `--cmd` 的结论**（这是洞1 的根因）。
   */
  if (noOverall && noOverallWhy.length < 20) {
    console.log(`[拒绝] \`--no-overall-check\` 必须带 \`--why "<≥20 字>"\`（现在 ${noOverallWhy.length} 字）`)
    console.log('  ⇒ 豁免理由要**进账本**（那是一个要留档的决定）')
    process.exit(1)
  }
  const items = []
  for (const r of (st.applied.replaced || [])) {
    try {
      const cur = sha(path.resolve(ROOT, r.path))
      items.push({ path: r.path, ok: cur === r.shaAfter, now: cur, want: r.shaAfter, was: r.shaBefore, changed: !!r.changed })
    } catch (e) { items.push({ path: r.path, ok: false, now: '(读不到)', want: r.shaAfter, was: r.shaBefore, changed: !!r.changed }) }
  }
  const fpOk = items.length > 0 && items.every((x) => x.ok)
  let code = null
  if (cmdOpt) {
    const vr = spawnSync(cmdOpt, { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 600000 })
    code = vr.status === null ? -1 : vr.status
  }
  /**
   * ★ 整体检查的**当前三态**（含**这一次之前**的记录）：
   *   `--cmd` ⇒ 这一条就是新的整体检查结论；豁免 ⇒ 已声明没有整体检查；
   *   只核指纹 ⇒ 沿用账本里已有的结论（`ok`/`waived` 都算"这一半已经交代过了"，`fail`/`missing` 不算）。
   */
  const overallBefore = st.overallState
  const overall = cmdOpt ? (code === 0 ? 'ok' : 'fail') : (noOverall ? 'waived' : overallBefore)
  const overallSettled = overall === 'ok' || overall === 'waived'
  const ok = fpOk && overallSettled
  append({
    at: now(), id, step: 'postchecked',
    kind: cmdOpt ? 'verify-cmd' : (noOverall ? 'waived' : 'fingerprint'),
    ok: cmdOpt ? ok : (noOverall ? true : fpOk),
    cmd: cmdOpt || null, code, items,
    ...(noOverall ? { why: noOverallWhy } : {}),
  })
  console.log(`${ok ? '✓' : '★'} ${id} 替换后复核 ${ok ? '通过（指纹 + 整体检查都交代了）' : '**没通过**'}（R32 必须⑥）`)
  for (const x of items) {
    console.log('   ' + (x.ok ? (x.changed ? '✓ 指纹变了（字节与账本一致）' : '· 这一份**没变**（副本本来就与原件一致）') : '★ 盘上字节与账本里的替换记录不符')
      + '  ' + x.path + '  ' + x.was + ' → ' + x.now)
  }
  if (cmdOpt) console.log(`   ${code === 0 ? '✓' : '★'} 整体检查 \`${cmdOpt}\` exit=${code}`)
  else if (noOverall) console.log(`   · 整体检查：**作者显式豁免**（${noOverallWhy.length} 字，已进账本）：${noOverallWhy}`)
  else console.log('   ⚠ 这次**只核了"指纹变了"** —— 整体检查那一半**没有跑**')
  if (!ok) {
    if (!fpOk) console.log('  ★ **指纹复核没通过**：盘上的字节与账本里的替换记录不符 ⇒ 复核不算过')
    if (!overallSettled) {
      console.log(`  ★ **整体检查：${overall === 'fail' ? '上一次跑的结果是 exit≠0（**没重跑就不会变**）' : '从没跑过，也没声明'}** ⇒ R32 必须⑥ 的后半段**没交代**`)
      console.log('     ⇒ 这一条**不许报"复核通过"**（原来就是这里被一条更弱的复核盖掉失败的记录）')
      console.log(`     补法①：node patch-pipeline.mjs postcheck --id ${id} --cmd "<你的整体检查命令>"`)
      console.log(`     补法②：node patch-pipeline.mjs postcheck --id ${id} --no-overall-check --why "<为什么这个 patch 没有整体检查（≥20 字）>"`)
    }
    console.log('  ⇒ 这条已记进账本 —— `status` 会把它列成卡住（不许当成功）')
    process.exit(1)
  }
  console.log('  ⇒ 记进账本：`status` 认这条复核（**指纹 + 整体检查**两半都过了才算过）')
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────── rollback（★ 修 bug②：可回滚面）
if (cmd === 'rollback') {
  const id = opt('id')
  if (!id) { console.log('[用法] patch-pipeline.mjs rollback --id P1'); process.exit(2) }
  /**
   * ★ D4：链断着**仍然允许 rollback**（只警告）—— 它是"回到 begin 时字节"的**唯一逃生口**，
   *   把逃生口也锁上就等于把坏账本变成不可恢复。
   */
  if (chainBroken().broken) {
    console.log('[警告] 账本哈希链是断的 —— 有人手工改过 PATCHES.jsonl')
    console.log('  ⚠ rollback **仍然执行**（逃生口：回到 begin 时的字节）；但这次回滚记录会**追加在断链之后**')
    console.log('  ⇒ 想恢复账本，请人工核对 PATCHES.jsonl 后重来（本工具不替你修账本）')
    console.log('')
  }
  const st = stateOf(id)
  if (!st) { console.log(`[拒绝] ${id} 没有 begin`); process.exit(2) }
  /**
   * ★★ **硬失败3（审查 2026-09-24 实测）—— `rollback` 假绿（最刺眼：与"已修好的同一类"）**：
   *   实测（老账本的 `begin` 没存 `origAlso`，用 ORIG 工具走完 begin/verify/apply）：
   *     `$ WORK rollback --id OLD1`
   *     `[拒绝] y.txt（第二份）**没有只读原件可回滚**（老账本的 begin 没存 origAlso）`  exit=1
   *     `★ 回滚后 x.txt="X-ORIG"  y.txt="X-PATCHED"`      ← **左边回了、右边没回（还是分叉）**
   *     `★ 账本步骤：["copied","verified","applied"]`        ← ★★ **零进度**
   *     `$ WORK status` ⇒ `OLD1 applied 审查 ok 已替换 已完成` / `没有卡住的。` **exit=0** ← ★★ 假绿
   *   根因两条：
   *     ① **边校验边写**：`copyFileSync(orig, src)`（左边已经落盘）**之后**才检查 `origAlso` ⇒ 拒绝时树已经分叉；
   *     ② `append({step:'rolledback'})` 在**循环之外** ⇒ 失败时账本**一个字节的进度都没有** ⇒ `status` 看不出问题。
   *   ⇒ 现在与 `apply` **同口径**（这是 user R32「几个直线动作要固定，不能遗留」的直接推论）：
   *     · **先全部校验，再逐条回** —— 校验不过 ⇒ **一个字节都不回**（不再产生半回滚的分叉树）；
   *     · **逐条记进度**（`restoring` / `restored`），失败也记（`rollback-failed`，含原因）；
   *     · **exit 1 的原因落进账本** ⇒ `status` 依据 `rollback-failed` **报红**，不许再绿灯。
   */
  const plan = []
  const problems = []
  for (const f of st.files) {
    const src = path.resolve(ROOT, f.path)
    const orig = path.resolve(ROOT, f.orig)
    if (!fs.existsSync(orig)) problems.push({ path: f.path, role: 'file', why: '只读原件不见了', detail: orig })
    plan.push({ f, src, orig, isPair: false })
    /**
     * ★★ **D5（审查实测）**：`--pair` 的**第二份**原来**根本不回滚** ——
     *   实测 `apply G1` 之后 x、y 都变了，`rollback G1` 只回 x，`y` 停在 PATCHED，而 `status` 报绿灯。
     *   而 `begin` 的输出逐字承诺"apply 会**两边一起写**，rollback 也是"。⇒ 现在两边一起回。
     *   ⚠ 老账本（D5 修之前 begin 的）**没有 `origAlso`** ⇒ 第二份**无从恢复** ——
     *     如实拒绝，但**这次拒绝发生在"预检"里**（上面那条"先全部校验"）：左边**不会**被单独回掉。
     */
    if (f.also) {
      const alsoAbs = path.resolve(ROOT, f.also)
      const origAlso = f.origAlso ? path.resolve(ROOT, f.origAlso) : null
      if (!origAlso || !fs.existsSync(origAlso)) {
        problems.push({
          path: f.also, role: 'pair', why: '老账本的 begin 没存 origAlso ⇒ 第二份没有只读原件可回滚',
          detail: `现在 ${fs.existsSync(alsoAbs) ? sha(alsoAbs) : '(不存在)'}，期望 ${f.alsoShaBefore}`,
        })
      }
      plan.push({ f, src: alsoAbs, orig: origAlso, isPair: true })
    }
  }
  if (problems.length) {
    append({
      at: now(), id, step: 'rollback-failed', why: 'precheck',
      problems: problems.map((p) => ({ path: p.path, role: p.role, why: p.why, detail: String(p.detail ?? '') })),
    })
    console.log(`[拒绝] ${id} **回滚前的预检没过 ⇒ 这次一个字节都没回**（事务：先全部校验再逐条回）`)
    for (const p of problems) {
      console.log(`   ${p.role === 'pair' ? '[第二份] ' : ''}${p.path}：${p.why}`)
      if (p.detail) console.log(`      ${p.detail}`)
    }
    console.log('  ⇒ 左边**没有**被单独回掉（原来就是这里产生"x 回了、y 没回"的分叉树）')
    console.log('  ⇒ 这次拒绝的**原因已经写进账本**（rollback-failed）—— `status` 会把它列成卡住，不许当成功')
    console.log('  ⇒ 人工处置：把第二份对回左边那份，或重新 begin 一个 id 拿新基线')
    process.exit(1)
  }
  const restored = []
  const failed = []
  for (const p of plan) {
    try {
      append({ at: now(), id, step: 'restoring', path: p.f.path, role: p.isPair ? 'pair' : 'file', from: p.f.orig })
      fs.copyFileSync(p.orig, p.src)
      const rec = {
        path: p.isPair ? p.f.also : p.f.path, role: p.isPair ? 'pair' : 'file',
        now: sha(p.src), want: p.isPair ? p.f.alsoShaBefore : p.f.shaBefore,
      }
      rec.ok = rec.now === rec.want
      append({ at: now(), id, step: 'restored', ...rec })
      restored.push(rec)
    } catch (e) {
      failed.push({ path: p.isPair ? p.f.also : p.f.path, role: p.isPair ? 'pair' : 'file', err: e.code || String(e.message).slice(0, 100) })
      break
    }
  }
  if (failed.length) {
    append({ at: now(), id, step: 'rollback-failed', why: 'write', restored, failed })
    console.log(`[拒绝] ${id} **回滚中途失败** —— 已恢复 ${restored.length} 份，剩下的没动（账本已逐条记进度）`)
    for (const x of failed) console.log(`   ★ ${x.role === 'pair' ? '[第二份] ' : ''}${x.path} 写回失败：${x.err}`)
    console.log('  ⇒ 原因已写进账本（rollback-failed）—— `status` 会把它列成卡住，不许当成功')
    process.exit(1)
  }
  append({ at: now(), id, step: 'rolledback', restored })
  const bad = restored.filter((r) => !r.ok)
  console.log(`✓ ${id} 已从 orig/ 恢复 ${restored.length} 份文件（两份拷贝两边一起回）`)
  for (const r of restored) console.log('   ' + (r.ok ? '恢复正确' : '★指纹不符') + '  ' + (r.role === 'pair' ? '[第二份] ' : '') + r.path + '  ' + r.now)
  if (bad.length) {
    console.log('  ★ **有文件没回到 begin 时的基线 ⇒ 两份可能仍然分叉，不许当成功**')
    console.log('   ⇒ 看 `status`（它会把它列成卡住）；必要时重新 begin 一个 id 拿新基线')
  }
  process.exit(bad.length ? 1 : 0)
}

// ─────────────────────────────────────────────────────────────── status
if (cmd === 'status') {
  // ★ 资料员实测：伪造那行**没有 id** ⇒ ids 里混进 undefined ⇒ 原来 padEnd 直接抛错。
  //   现在把"没有 id 的行"单独当成篡改信号，不混进 id 列表。
  const allRows = readLedger()
  const orphanRows = allRows.filter((r) => !r.id)
  const ids = [...new Set(allRows.filter((r) => r.id).map((r) => r.id))]
  // ★ 空账本不许报成功（A6：输入为 0 不许报"没问题"）
  if (!ids.length) {
    console.log(`[判不了] 这个账本里一条 patch 都没有（${LEDGER}）—— **不许当成功**（A6：输入为 0 不许报"没问题"）`)
    console.log('  ⇒ 先确认 --root 对不对（默认是 process.cwd()，它不一定是工程根）')
    process.exit(2)
  }
  const stuck = []
  const states = new Map()
  console.log('id      步骤        角色检查           替换      卡在哪')
  console.log('------  ----------  -----------------  --------  ------------------------------')
  for (const id of ids) {
    const st = stateOf(id, allRows)
    states.set(id, st)
    const v = st.verify ? (st.verify.by + ' ' + st.verify.verdict) : '—'
    const a = st.applied ? '已替换' : (st.rolledback ? '已回滚' : '—')
    // ★ 三处漏（资料员实测）：
    //   ① applied 但**全部 changed=false**（改了个寂寞）原来报"已完成" exit 0 ⇒ 现在算卡住
    //   ② ok→bad 之后没人回来 ⇒ 原来 exit 0 ⇒ 现在算卡住
    //   ③ verify ok 未替换，**用一条 rollback 洗成"已回滚" exit 0** ⇒ 现在也算卡住（回避了第二个漏）
    // ★★ 2026-09-24 **D8 补三处绿灯**（审查实测；后两处的注释原来自称已修，其实**没修**）：
    //   ① `begin → rollback`（从没检查过）⇒ 原来 exit 0，把"复制了没检查"**洗白**成"已回滚"；
    //   ② `apply → verify bad`（替换之后角色翻案）⇒ 原来报"已完成" exit 0；
    //   ③ `apply → rollback`（净零）⇒ 原来 exit 0，而净效果**等于没做**。
    const noopApplied = st.applied && Array.isArray(st.applied.replaced) && st.applied.replaced.length > 0 && st.applied.replaced.every((r) => !r.changed)
    /**
     * ★★ **硬失败1（R32 必须⑥「替换后复核」）**：`applied` 不是终点 ——
     *   这一版 `apply` 记了 `recheck:'required'`，**必须**有一条成功的 `postchecked` 才算完成。
     *   ⚠ 兼容：老账本的 `applied` 行没有这个字段（那时的管线没有复核机制）⇒ **不追溯判红**，
     *     只如实说"这一条是在复核机制之前装的、没有复核记录"。
     *
     * ★★ **洞1（第四轮修 · 审查实测的假绿）**：判决**不再看"最后一条复核"**（`st.postcheck`）——
     *   一条**不带 `--cmd`** 的 `postcheck` 曾经把 `apply --verify-cmd "node fail.mjs"`（exit 7）的
     *   失败结论**盖掉** ⇒ `status` 报"已完成"exit 0。现在**两半各自算**（`stateOf` 里算好）：
     *     · `st.recheckFpOk`  —— 最后一条 `kind:'fingerprint'`
     *     · `st.overallState` —— `ok` / `fail` / `waived` / `missing`（`missing` = 没跑也没声明）
     */
    const recheckRequired = st.recheckRequired
    const recheckOk = st.recheckFpOk && (st.overallState === 'ok' || st.overallState === 'waived')
    let why = ''
    /**
     * ★★ **硬失败3**：`rollback-failed` 必须**排在最前**并计成卡住 ——
     *   原来回滚失败时账本零进度 ⇒ 这条根本没地方冒出来 ⇒ `status` 报"已完成"+ exit 0（假绿）。
     */
    if (st.rollbackFailed) {
      const rf = st.rollbackFailed
      const det = Array.isArray(rf.problems) && rf.problems.length
        ? rf.problems.map((p) => (p.role === 'pair' ? '[第二份]' : '') + p.path + '：' + p.why).join('；')
        : (Array.isArray(rf.failed) ? rf.failed.map((x) => (x.role === 'pair' ? '[第二份]' : '') + x.path + '：' + x.err).join('；') : '（原因在账本里）')
      why = `★★ **rollback ${rf.why === 'precheck' ? '预检没过（一个字节都没回）' : '中途失败'}**：${det}`
        + (st.partial ? ' —— **树可能仍是半替换**' : '')
        + '；原因已写进账本（rollback-failed），补法见 rollback 的输出'
      stuck.push(id)
    } else if (st.partial) {
      // ★ D7：管线自己装了一半（账本里有 replacing/replaced 进度）—— 不是"外部绕过"
      why = '★ 替换**只做了一半**（半替换，账本已有进度）—— 修好权限**重跑 apply** 可续做，或 rollback'
      stuck.push(id)
    } else if (st.bypassed && st.bypassed.length) {
      // ★★ 缺陷1：**分辨两种情形**，不许一律说"绕过管线"
      const parts = st.bypassed.map((b) => ({ b, k: bypassKind(b, st) }))
      const staleIds = [...new Set(parts.filter((x) => x.k.kind === 'stale').flatMap((x) => x.k.changers.map((c) => c.id)))]
      const split = parts.filter((x) => x.k.kind === 'rollback-split')
      const gone = parts.filter((x) => x.k.kind === 'pair-missing')
      const manual = parts.filter((x) => x.k.kind === 'bypass')
      const who = st.bypassed.map((b) => (b.role === 'pair' ? '[第二份]' : '') + b.path).join(',')
      if (staleIds.length) why = `★★ **基线过期：${staleIds.join(',')} 先改了这个文件**（${who}）—— 不是"绕过管线"；补法：重新 begin 拿新基线再 rebase`
      else if (gone.length) why = `★★ **--pair 的第二份不见了**（${gone.map((x) => x.b.path).join(',')}）—— 原来 apply 会静默重建它`
      else if (split.length) why = `★★ **rollback 没把第二份带回来（分叉）**（${split.map((x) => x.b.path).join(',')}）—— D5 的形状`
      else why = `★★ 原件被**绕过管线**改了（${manual.map((x) => x.b.path).join(',')}）—— 第三种漏`
      stuck.push(id)
    } else if (st.step === 'copied') { why = '★ 复制了**没检查**（用户点名的第一个漏）'; stuck.push(id) }
    else if (st.applied && st.verify && st.verify.verdict === 'bad') { why = '★ 替换之后角色**翻案**（最新判决 = bad）—— 得回来处理（重验或 rollback）'; stuck.push(id) }
    else if (noopApplied) { why = '★ 替换了但**一个字都没改（改了个寂寞）= 等于没做**'; stuck.push(id) }
    // ★ 硬失败1 + 洞1：这一版 apply 记了 recheck:'required' ⇒ **指纹 + 整体检查两半都交代了**才算完成
    else if (recheckRequired && !recheckOk) {
      const fpTxt = st.recheckFpOk
        ? '指纹 ✓'
        : (st.postcheckFp ? '**指纹复核没通过**' : '**指纹复核没记录**')
      const cmdTxt = st.overallState === 'ok'
        ? '整体检查 exit 0'
        : (st.overallState === 'fail'
          ? `**整体检查没过**（${st.postcheckCmd.cmd} exit=${st.postcheckCmd.code}）`
          : (st.overallState === 'missing'
            ? '**整体检查从没跑过、也没声明**'
            : '整体检查状态不明'))
      why = `★★ 替换后**复核没做完/没过**（${fpTxt}；${cmdTxt}）—— R32 必须⑥ 没过`
        + (st.overallState === 'missing'
          ? `；补法：\`postcheck --id ${id} --cmd "<整体检查命令>"\` 或 \`postcheck --id ${id} --no-overall-check --why "<≥20 字>"\``
          : '')
      stuck.push(id)
    }
    else if (st.step === 'applied') {
      /**
       * ★ 洞1b：只有**两半都交代过**才叫"已完成"，而且**逐字写清整体检查是哪一种**：
       *   `exit 0`（真跑过）或 `作者显式豁免（理由）`。**没有"整体检查没跑过"还报"已完成"这一支了。**
       */
      if (!recheckRequired) why = '已完成（老账本：这一条是在复核机制之前装的，**没有复核记录**，不追溯判红）'
      else if (st.overallState === 'waived') why = `已完成（替换后复核：**指纹变了** ✓；整体检查：**作者显式豁免** —— ${String(st.postcheckWaived.why).slice(0, 60)}）`
      else if (st.overallState === 'ok') why = '已完成（替换后复核：**指纹变了 + 整体检查 exit 0** —— R32 必须⑥ 两半都过）'
      else why = '已完成（★ 不该到这：整体检查没交代 —— 这是本文件的判据 bug，请报出来）'
    }
    else if (st.step === 'rolledback' && st.applied) { why = '★ 替换后又 rollback ⇒ **净效果等于没做**（R32 口径）—— 要重来就换新 id'; stuck.push(id) }
    /**
     * ★★ **K2c**：半替换之后 **rollback 成功了** ⇒ `partial` 已清零，落到这一支 ——
     *   原来它落到下面"检查通过后用 rollback 回避了替换"那支（**已经不一致**），
     *   而更早的版本是 `partial` 排最前，报「重跑 apply 可续做，或 rollback」——
     *   **叫你去做的正是你刚做完的事**。现在如实说清"已回滚、这轮没交付"。
     */
    else if (st.step === 'rolledback' && st.halfRolledBack) { why = '★ 替换**半途失败后已 rollback**（树已回到 begin 时的基线，账本逐条进度都在）—— 这轮**没交付**（等于没做）；要重来就换新 id 重新 begin'; stuck.push(id) }
    else if (st.step === 'rolledback' && st.verify && st.verify.verdict === 'ok' && !st.applied) { why = '★ 检查通过后用 rollback 回避了替换 —— **仍是"等于没做"**'; stuck.push(id) }
    else if (st.step === 'rolledback') { why = '★ 复制了**没检查**就用 rollback 洗白 —— 这轮**什么都没交付**'; stuck.push(id) }
    else if (st.step === 'verified' && st.verify.verdict === 'ok' && !st.applied) { why = '★ 检查通过了**没替换 = 等于没做**（用户点名的第二个漏）'; stuck.push(id) }
    else if (st.step === 'verified' && st.verify.verdict === 'bad' && !st.applied) { why = '★ 检查未通过、也没人回来重验（bad 挂着不算没事）'; stuck.push(id) }
    console.log(id.padEnd(8) + st.step.padEnd(12) + v.padEnd(19) + a.padEnd(10) + why)
  }
  /**
   * ★★ **缺陷2（主代理实测）**：两个**未结**的 patch 点同一个文件时，`status` 原来只各报各的
   *   "复制了没检查"，**不提它们撞车** —— 而撞车正是缺陷1 那个误报（"基线过期"）的成因：
   *   谁先 apply，别人的基线就过期。
   *   判据：把**未结**（`applied` / `rolledback` 之外）的 patch 按归一化绝对路径分组，
   *   同一组里 ≥2 个不同 id ⇒ 撞车（`files[].path` 与 `--pair` 的 `also` 都算写入目标）。
   *   ⚠ **不许把已 applied 的算成撞车** —— 那是正常先后关系里的"前者"（它已经改完了，
   *     后来者只要重新 begin 就有新基线）。
   */
  const byPath = new Map()
  for (const id of ids) {
    const st = states.get(id)
    if (!st.files || !st.files.length) continue
    if (st.step === 'applied' || st.step === 'rolledback') continue
    for (const f of st.files) {
      for (const p of [f.path, f.also].filter(Boolean)) {
        const key = path.resolve(ROOT, p)
        if (!byPath.has(key)) byPath.set(key, new Map())
        const m = byPath.get(key)
        if (!m.has(id)) m.set(id, { id, step: st.step, label: p })
      }
    }
  }
  const collisions = [...byPath.entries()].filter(([, m]) => m.size >= 2)
  const chk = chainBroken()
  if (orphanRows.length) { console.log(''); console.log(`[卡住] 账本里有 ${orphanRows.length} 条**没有 id 的记录** —— 有人手工追加过（伪造 verify ok 的形态）`); stuck.push('(无 id 的记录)') }
  if (chk.broken) { console.log(''); console.log(`[卡住] 账本哈希链断了（第 ${chk.at} 条：${chk.why}）—— 有人手工改过账本`); stuck.push('(账本链断)') }
  /**
   * ★ 新行为⑰：老格式前缀**不算断链**（如实说明，但**不计入卡住**）——
   *   原来它整本报"链断了"，`begin`/`verify`/`apply` 全被拒、连新活都开不了，且没有迁移路径。
   * ★ 洞3②：**整本无 self** 与 **前缀无 self** 分开说，而且不许含糊 ——
   *   整本无 self 时本文件**分不清**"链之前的老账本"与"有人把整本 self/prev 删了"。
   */
  if (!chk.broken && chk.wholeFile) {
    console.log('')
    console.log(`[说明] 账本**整本 ${chk.legacy} 条都没有 prev/self**（哈希链引入之前的老格式）⇒ 无从校验，**不计入卡住**`)
    console.log('  ⚠ **本文件分不清**：① 真的是链之前的老账本；② 有人把整本的 self/prev 删了（洞3 的 widening）')
    console.log('     判据只有"无 self 的行不许带链之后才有的东西"（带了就判断链）—— **把整本改写成老格式拦不住**，如实说清')
    console.log('  ⇒ 新 patch 可以从这里继续开（`append` 对老尾行取 prev=\'\'，正好重新起链）')
  } else if (!chk.broken && chk.legacy) {
    console.log('')
    console.log(`[说明] 账本前 ${chk.legacy} 条是**老格式**（哈希链引入之前写的，没有 prev/self）⇒ 从第 ${chk.legacy + 1} 条起才校验链 —— **不计入卡住**`)
    console.log('  ⇒ 这是兼容：老记录无从校验；**链一旦开始**，之后的追加/改行仍然一律拒绝（新 patch 可以从这里继续开）')
  }
  if (collisions.length) {
    console.log('')
    console.log('[撞车] 有两个以上**未结**的 patch 点着同一个文件 —— 谁先 apply，别人的基线就过期（缺陷1 的成因）：')
    for (const [abs, m] of collisions) {
      const list = [...m.values()]
      console.log('   ' + abs)
      for (const e of list) console.log(`     · ${e.id}（${e.step}）  点名的是 ${e.label}`)
      console.log('     ⇒ 处置：只留一个（其余**重新 begin** 拿新基线），或改完一个 **apply 完**再动下一个')
    }
    for (const [, m] of collisions) stuck.push('撞车(' + [...m.keys()].join('+') + ')')
  }
  if (stuck.length) {
    console.log('')
    console.log(`[卡住] ${stuck.length} 个：${stuck.join(', ')} —— **不许当成功**（R32 必须⑤：卡住的要显式报出来）`)
    process.exit(1)
  }
  console.log('')
  console.log('没有卡住的。')
  process.exit(0)
}

console.log('patch-pipeline.mjs —— 「派 → 复制 → 改 → 角色检查 → 替换」的机制化（R32）')
console.log('')
console.log('  node patch-pipeline.mjs begin    --id P1 --files a.mjs,b.mjs [--root <工程根>]')
console.log('                                   [--pair "左|右"]（可重复；**推荐这个分隔符**）')
console.log('                                   [--pair "左:右"]（也认，只在"不是盘符"的第一个冒号处切）')
console.log('                                   [--with-dir]（把原件目录镜像进 work/，让副本能 import 兄弟）')
console.log('  node patch-pipeline.mjs dispatch --id P1                     ← 打印「原件 → 工作副本」映射')
console.log('  node patch-pipeline.mjs verify   --id P1 --by <角色> --verdict ok|bad --evidence "原样输出"')
console.log('  node patch-pipeline.mjs apply    --id P1 [--verify-cmd "<整体检查命令>"]')
console.log('                                   ★ 替换后复核（R32 必须⑥）：指纹变了 + 整体检查 exit 0；非 0 ⇒ status 报红')
console.log('                                   ★ 不带 --verify-cmd 时**必须显式声明**：--no-overall-check --why "<≥20 字>"')
console.log('                                     两个都没给 ⇒ apply **exit 1**（没跑也没声明 = ⑥ 只做了一半，不许当完成）')
console.log('  node patch-pipeline.mjs postcheck --id P1 [--cmd "<整体检查命令>"]   ← 替换后复核，可事后补跑')
console.log('                                   [--no-overall-check --why "<≥20 字>"]  ← 显式声明"这个 patch 没有整体检查"')
console.log('                                   ★ 不带 --cmd 只核指纹：整体检查**没跑也没声明**时 ⇒ exit 1（洞1 的假绿）')
console.log('  node patch-pipeline.mjs rollback --id P1                     ← 从只读 orig/ 恢复（--pair 两边一起回）')
console.log('  node patch-pipeline.mjs status')
console.log('')
console.log('它治的漏（用户逐字点名的 + 角色审出来的）：')
console.log('  · 复制改完不检查  ⇒ apply 会被**拒绝**（没有 verify ok）')
console.log('  · 检查了不替换    ⇒ status 会把它**显式列成卡住**，exit 1')
console.log('  · 绕过管线改原件  ⇒ 核对 shaBefore，apply 被拒 + status 报出来')
console.log('  · 检查后副本又改  ⇒ 核对 copySha，apply 被拒')
console.log('  · 副本名碰撞      ⇒ begin 断言映射唯一，撞了就拒')
console.log('  · 没有可回滚副本  ⇒ orig/ 只读那一份 + rollback 命令')
console.log('  · 替换后不复核    ⇒ apply **真的**从盘上读回复核"指纹变了"，整体检查走 --verify-cmd/postcheck；没过 status 报红')
console.log('    ★ 洞1（第四轮）：**一条更弱的复核不许盖掉一条失败的复核** —— 整体检查只看最后一条 `--cmd` 的结论')
console.log('    ★ 洞1b：apply 不带 --verify-cmd 又不显式豁免 ⇒ **exit 1**（"⑥ 后半段一次都不跑就绿灯"被堵死）')
console.log('  · rollback 半截/假绿 ⇒ 先全部校验再逐条回 + 逐条记进度，失败原因落账本，status 不许绿灯')
console.log('    ★ 洞2（第四轮）：但**其后真的 applied 了**就不许再报"rollback 失败"（真交付被永久判死 = 假红）')
console.log('  · 删掉账本的 self/prev 变 legacy ⇒ 洞3：**"没有 self"不再是通行证** —— 老格式行带上链后字段就判断链')
console.log('')
console.log('⚠ 三句**如实降级**（原来文案把它们说大了）：')
console.log('  · 哈希链**不是密码学签名** —— 能改账本的人可以重算整条链（实测重算后 apply 放行）。')
console.log('    它拦的是"随手追加一行"，是**代理判据**。链断时 begin/dispatch/verify/apply 拒绝，rollback 只警告（逃生口）。')
console.log('    ★ 老格式前缀（没有 prev/self 的年代）**不算断链**（只警告）：兼容，不是放宽 —— 链一旦开始，追加/改行照旧拒绝。')
console.log('       ★ 第四轮（洞3）：老格式前缀**必须真的是老格式** —— 带链后字段/盘上痕迹的"无 self 行"判**断链**。')
console.log('  · `--by <角色>` **没有任何鉴权** —— 只查"名字在不在名单里"。主代理自己敲一行也能过（实测）。')
console.log('    ★ 第四轮（D16）：名单**从 `warden.mjs` 的 `ROLE_REGISTRY` 派生**（不再硬编码；含无票的 `AI测试用户`）。')
console.log('  · 它**不判断改动对不对**（那是角色的事），只保证"顺序没漏、证据在、能回滚"。')
process.exit(2)
