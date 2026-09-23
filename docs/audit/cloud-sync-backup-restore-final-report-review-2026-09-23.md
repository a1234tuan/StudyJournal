# 对《云同步/备份/恢复加固 —— 二次审计复查裁定、最终 Bug 清单与修复方案（终稿 v2）》的独立审核（2026-09-23）

**审核对象**：`docs/audit/cloud-sync-backup-restore-final-buglist-and-remediation-2026-09-23.md`（终稿 v2，18:48 落盘，25509 字节）。
**审核方式**：只读复核 + 判别性实跑。**本文件不改动被审文件一个字符**，不修改任何产品源码。
**审核结论速览**：**终稿 v2 的实质结论全部成立，可以采信**。其唯一未闭合项（aliyun 之争）经本审核**实测定谳**，结论与其"环境敏感"推断方向一致，并给出了它未能定位的**确切变量**。

---

## 0. 首要结论：aliyun 之争已由本审核完全定谳

终稿 v2 把该分歧记为"两种观测真实存在且互斥，均未定谳……分歧为机器/运行时环境敏感"。**该推断正确，但未找到变量**。本审核用二分法定位到**唯一决定性变量 = Node 运行时版本**。

### 0.1 证据（同一工作区、同一命令、唯一变量为 Node 版本）

环境前提：`src/__probe__/` 不存在（无探针污染），工作区干净。

| 命令 | Node v22.22.2 | Node v24.16.0 |
| :-- | :-- | :-- |
| `vitest run --mode test src/services/aliyunTtsProvider.test.ts` | **3 failed / 5 passed** | **8 passed / 0 failed** |
| 同上，连跑 3 次 | 3 次均 **3 failed**（稳定，非偶发） | — |
| 同上，**不带** `--mode` | **3 failed**（`--mode` 不是变量） | — |
| 有界全量 `--exclude "**/*.live.test.ts"` | **234 files / 1889 tests = 1885 passed / 4 failed** | **234 files / 1889 tests = 1888 passed / 1 failed** |

⇒ **Node v22 下 aliyun 3 条稳定失败；Node v24 下完全消失**。全量差异（4 failed vs 1 failed）**恰好等于这 3 条**，其余（1 条 sync-integration 并发超时）两版本一致。

### 0.2 底层机制（jsdom + vitest 桥接带上的 realm 差异）

在 `vitest + jsdom`（`vitest.config.ts:11` `environment: "jsdom"`）内实测同一段代码：

| 观测项 | Node v22.22.2 | Node v24.16.0 |
| :-- | :-- | :-- |
| `(await new Response(new Uint8Array([1,2,3])).blob()).size` | 3 | 3 |
| **`blob instanceof Blob`** | **false** ❌ | **true** ✅ |
| **`new Blob([blob]).size`** | **13** ❌ | **3** ✅ |

- **`blob.size` 两版本都是 3** ⇒ 终稿 v2 与实施报告所记"`response.blob().size = 3`"**完全准确**，此点无争议。
- 差异出在 **`Response.blob()` 返回值的 realm 归属**：Node v22 桥接下该 Blob 不被本 realm 的 `Blob` 构造器识别（`instanceof` 为 false），于是产品代码 `src/services/knowledgePodcastService.ts:686` 的 `new Blob([blob], { … })` 把它当普通对象**字符串化**为 `"[object Blob]"`。
- **13 的来历**：`new TextEncoder().encode("[object Blob]").length === 13`（实测）。
- 纯 Node 直跑（不经 vitest/jsdom）两版本均正常（`new Blob([blob]).size === 3`）⇒ 触发条件确为 **Node v22 × vitest/jsdom × 跨 realm Response 打桩** 三者叠加。

### 0.3 对双方的历史判定

| 主体 | 其主张 | 本审核裁定 |
| :-- | :-- | :-- |
| 终稿 v2 会话（Node v24 侧） | 干净复跑 8/8，且"照抄对方命令"仍 8/8 | **实测为真**（v24 下确实恒 8/8） |
| 并发会话（Node v22 侧） | "干净环境单跑 3 失败稳定复现" | **实测为真**（v22 下确实恒 3 失败） |
| 终稿 v2 的推论 | "'3 失败'不成立"（怀疑对方未清探针） | **结论错、动因对**：不是探针污染，是 Node 版本。**双方都诚实，都没有逻辑错误** |
| 终稿 v2 的定性 | "环境敏感（Node/jsdom realm 行为）" | **定性准确，本审核将其升级为已定谳** |

**⚠️ 需要更正的是终稿 v2 的一句措辞**：其 §1.5 记该会话"干净环境单跑 3 失败稳定复现"为"**不成立/互斥**"。按本审核证据，该观测**成立**（在 Node v22 下），不应标为"不成立"，而应标为"**在另一 Node 版本下成立**"。这属于措辞层面的更正，不影响 v2 的任何修复结论。

### 0.4 该缺陷的产品影响：**无**

`aliyunTtsProvider.test.ts` 未被本次云同步改动触碰（`git status` 可证），且缺陷**只存在于测试环境**：真实浏览器/Electron 中 `Response.blob()` 与本 realm `Blob` 同源，`new Blob([blob])` 正确复制字节。**终稿 v2 将其定性为"既有测试环境缺陷（B-15）"完全正确。**

---

## 1. 终稿 v2 逐项复核

### 1.1 核心裁定（P0/P1）—— 全部成立

| 项 | 终稿 v2 主张 | 本审核复核 |
| :-- | :-- | :-- |
| **B-01（P0）** `firstEmptyDevice` 容错解析做破坏性全量替换 + 虚假完整性宣告 | 七环触发链逐环确证；零用例 | **成立**。本轮重核 `:2726` 确为 `getAllRemote(user.uid, remote.state)`（缺第三参）；`:2916-2926` 对照入口确带 `strict` + `assertStrictRemoteDataset` + 说明注释 |
| **F-1 修复方向** | `getAllRemote(…, true)` + `assertStrictRemoteDataset`，且必须与对照入口同款双保险 | **成立**。补充确认 `assertStrictRemoteDataset`（`cloudSnapshotIntegrity.ts:264-284`）签名**确无 `expectedCount`**，故"不照搬 `assertStrictCloudSnapshot` 计数校验"的提醒是正确且必要的 |
| **B-02（P1）** owner 切换回执写旧 scope | `assertKnowledgeOwner` 位于回执之后 | **成立**。`autoBackupService.ts:145-146` 顺序确为"先 `completeKnowledgeBackup` 后 `assertKnowledgeOwner`" |
| **B-02 危害收敛** | 无用户可见后果（因 `autoBackup.ts:14` 置 `enabled=false`，`runtime.ts:44` 早退返回 false） | **成立**。`runtime.ts:44` 的 `if (!scope?.consented || !scope.autoBackupState?.enabled) return false;` 与 `autoBackup.ts:14` 的置 false 逻辑均核实为真 |
| **F-2 方案** | 断言前移（单行）；备选在 `autoBackup.ts:31` 事务内比对 `currentKnowledgeOwner()` | **成立**。`autoBackup.ts:2` 确已 import `currentKnowledgeOwner`，备选无需新增依赖；`scope.ts:32` 首条件在 owner 漂移时两侧同为 A（恒等），守卫结构性无法感知 —— 论证准确 |
| **B-03（P1）** `AGENTS.md` 全称宣告与数字口径 | 宣告过宽；数字未标口径 | **成立**。`AGENTS.md:5` 确写 "Destructive full replacement **now uses** strict snapshot validation" |

### 1.2 其余 16 项（B-04…B-15 与 M-5/M-6 裁定）—— 抽查全部为真

本审核抽查以下条目，**均与终稿 v2 一致**：

- **#11 空快照边界**：`:1949` 确为 `const expectedCount = snapshotEntities.length + events.length;` ⇒ "生产 writer 不可构造 0"成立。
- **#14 死代码链**：`nativeAutoBackup.ts:144` `writeNativeLatestBackup` 定义位置核实；`nativeAutoBackupStreamService.ts` 整文件无生产调用方（仅自身 test 引用）成立；引用 `nativeAutoBackup.ts` 的是活模块，勿混淆 —— 该提醒正确。
- **#8 死枚举**：`destination-visible` 全仓仅 `types.ts:372/376`（定义+注释）与 `AutoBackupPanel.tsx:67`（文案），**无生产产出点** ⇒ 成立。
- **#16 EOF 空行**：`git diff --check` 唯一空白项确为 `src/services/cloudSyncWhitebox.test.ts:1010: new blank line at EOF.`。
- **#3 生产归档恒 v7**：成立（与 `AGENTS.md` 记载一致）。

### 1.3 终稿 v2 吸收并发会话修正的部分 —— 核对准确

终稿 v2 §1.5 声明"逐条回源码验证后吸收"以下三项，本审核确认其**吸收正确、引述无误**：

1. **N-6**（N-1 危害收敛）⇒ 已核实（见 §1.1 B-02 行）。
2. **N-7**（死代码精确到整文件）⇒ 已核实。
3. **D-6**（`meta.size` 生产不可达）⇒ `exportPrivacy.ts` 的 `sanitizeStreamableSnapshotForExport` 只过滤 `generatedBy === "knowledge-podcast"` 并改 `counts.assets`，**不触碰 `meta.size`** ⇒ 成立。

### 1.4 终稿 v2 的方法论价值 —— 高于其结论本身

以下三点应作为**本项目门禁规范**保留（终稿 v2 已写入 S2/最终完成定义第 4 条，本审核**明确赞同并建议提级为常驻约定**）：

1. **门禁四要素留档**：命令 + `--mode` + pool/worker 配置 + 探针状态。**本轮争议正是缺第 4 项（探针状态）与第 5 项（Node 版本）所致。**
2. **每条失败必须单跑复核**，超时项加 `--pool=forks --poolOptions.forks.singleFork=true` 串行重跑，区分"环境噪声/真实回归"。
3. **不接受"我的环境没复现"作为否定依据**（当判别成本仅一次单跑时）。

---

## 2. 本审核提出的补充建议（3 条）

以下为终稿 v2 未覆盖、或可进一步收紧之处。**均不改变其任何结论与定级。**

### 建议 1（重要）：把 **Node 版本** 补入门禁第五要素，并在文档/CI 中固定

现状：`package.json` **无 `engines` 字段**、仓库**无 `.nvmrc`**（实测）。这导致：

- 同一 commit 在不同机器/会话上产出**不同的测试结论**（本轮实证：234/1889 下 4 failed vs 1 failed）；
- 任何"测试全绿"声明都**不可跨环境复算** —— 这正是两份二次审计报告与本轮三方数字互斥的**共同根因**。

**建议**：
1. 在 `package.json` 增 `"engines": { "node": ">=24" }`（或项目实际选定版本），并加 `.nvmrc`；
2. 门禁四要素升级为**五要素**：命令 + `--mode` + pool/worker + 探针状态 + **Node 版本**（含 `node -v` 输出）；
3. 若短期无法统一 Node 版本，则在 `AGENTS.md` 明确标注"aliyun 3 条失败在 Node < 24 下为已知环境噪声"，避免每轮重复排查。

> 说明：本建议**不涉及修改产品代码**，属工程卫生项，可与 F-3 一并执行。

### 建议 2：aliyun 测试稳定化的**具体**做法（终稿 v2 只给到"挂后续项"）

终稿 v2 在最终完成定义第 4 条提出"改用 `--mode` 一致的桩或显式 realm 检查"。本审核认为**前者无效**（已实测 `--mode` 不是变量），应改为：

- **首选**：在 `src/test/setup.ts` 中统一 `Response`/`Blob` realm，或在测试内改用**本 realm Blob** 作为 body：
  ```ts
  // 现状（跨 realm 敏感）：
  new Response(new Uint8Array([1, 2, 3]))
  // 建议（realm 安全，行为等价于真实浏览器）：
  new Response(new Blob([new Uint8Array([1, 2, 3])]))
  ```
- **或**：断言改为对**字节内容**（`await audio.arrayBuffer()` 长度）而非 `Blob.size`，从根上绕开 realm 问题。

两种改法都只动测试文件、不碰产品代码，且能让该用例在 Node v22/v24 下**结论一致**。

### 建议 3：`docs/audit/` 内多份报告的**数字口径**应统一标注

当前 `docs/audit/` 下至少三份报告各自记录了不同口径的全量数字（含/不含 live、含/不含探针、不同 Node）。建议在 `docs/audit/README.md`（若无则新建）写明**统一口径**：

> 有界全量口径 = `vitest run --mode test --exclude "**/*.live.test.ts"`，Node ≥ 24，工作区无探针。基准 = 234 files / 1889 tests。

否则后人在第四次审查时仍会踩同一个坑。

---

## 3. 审核结论

| 维度 | 结论 |
| :-- | :-- |
| **终稿 v2 的 P0/P1 定级与修复方案** | **全部成立，可直接开工** |
| **终稿 v2 的 16 项 P2 与 3 项裁定不变项** | **抽查全部为真** |
| **终稿 v2 吸收的并发会话修正（N-6/N-7/D-6）** | **吸收正确、引述无误** |
| **aliyun 之争** | **由本审核定谳：Node 版本差异（v22 失败 / v24 通过）**；产品无影响；终稿 v2 的"环境敏感"定性方向正确 |
| **需更正** | 终稿 v2 §1.5 将并发会话"3 失败稳定复现"标为"不成立"**属措辞过重**，应改为"在另一 Node 版本下成立"。**不影响任何结论** |
| **建议补充** | Node 版本入 `engines`/`.nvmrc` 并纳入门禁留档；aliyun 测试按建议 2 稳定化（改 body 为同 realm Blob） |

**终稿 v2 是可采信版本。** 其"以本会话证据链为基底、对并发修正逐条回源验证后吸收、对不可复现断言如实标注"的处理方式正确且诚实；本审核补上其未定位的环境变量后，该报告已无遗留未决争议（除 P2 项本身待修）。

---

## 附录：本审核的完整实跑记录

```
工作区前提：src/__probe__ 不存在；git status 无探针项；/tmp-sj-audit 未参与

A. 单文件 × Node 版本
   node v22.22.2 → 3 failed / 5 passed   （连跑 3 次均一致）
   node v24.16.0 → 8 passed / 0 failed
   不带 --mode（v22） → 3 failed          （排除 --mode 变量）

B. 有界全量 --exclude "**/*.live.test.ts"
   node v22.22.2 → 234 files / 1889 tests = 1885 passed / 4 failed
   node v24.16.0 → 234 files / 1889 tests = 1888 passed / 1 failed
   （两版本唯一共有失败：cloudSyncService.integration.test.ts 并发 5s 超时）

C. realm 探针（vitest + jsdom 内，跑完即删）
   v22: blob.size=3 | blob instanceof Blob=false | new Blob([blob]).size=13
   v24: blob.size=3 | blob instanceof Blob=true  | new Blob([blob]).size=3
   "[object Blob]" 的 UTF-8 字节数 = 13

D. 纯 Node 直跑（不经 vitest/jsdom）
   v22 与 v24 均：new Blob([blob]).size = 3     （确认触发条件含 vitest/jsdom）

E. 配置核查
   vitest.config.ts:8 mode="test"，:11 environment="jsdom"，:12 setupFiles
   package.json 无 engines；仓库无 .nvmrc

F. 源码抽查
   cloudSyncService.ts:2726 / :2916-2926 / :1949       全部与终稿 v2 记载一致
   autoBackupService.ts:145-146 / autoBackup.ts:2,14,31-37 / scope.ts:32 / runtime.ts:44   一致
   types.ts:372/376 + AutoBackupPanel.tsx:67（destination-visible 无产出点）   一致
   git diff --check 唯一空白项 = cloudSyncWhitebox.test.ts:1010   一致
```

**清理声明**：本次审核创建的探针目录 `src/__probe__/` 已删除，`git status` 无残留（`probe` 命中数 = 0）。除本文件外，未创建/修改任何文件。
