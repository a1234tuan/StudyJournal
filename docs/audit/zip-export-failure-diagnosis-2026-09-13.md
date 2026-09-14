# ZIP 导出失败诊断（2026-09-13）

- 方法：对真实 Dexie 存储 + 真实导出链路做定向复现（临时测试已删除，不留在仓库）。
- 结论：**导出逻辑确实存在 bug。** 共 5 处可复现缺陷（A–E）＋ 1 处可观测性缺陷（F）＋ 1 处结构性弱点（桌面版全内存）。其中 A / B / C 会让导出**直接失败**，F 决定了失败时你看不到原因。

---

## 0. 导出链路（先明确失败可能发生在哪一步）

```
BackupPage「导出完整备份」
  └─ exportFullBackupFromStorage(storage)
       ├─ canUseNativeZipArchive() ?  ← 仅 Android 为 true
       │    └─ exportNativeStreamableBackupForShare → 原生流式写 zip
       └─ 否则（Windows 桌面版 / 网页版）
            ├─ storage.createSnapshot()            ← 第 1 个抛错点（完整性校验）
            ├─ snapshotToZip(snapshot)             ← 第 2 个抛错点（JSZip，全内存）
            └─ writeOrDownload → saveAs(...)       ← 第 3 个抛错点（落盘/分享）
```

抛错点 1 是纯数据校验，只要命中就**永久失败**，与网络、磁盘、平台都无关。

---

## 1. 已复现的缺陷

### 缺陷 A（严重）：记录引用了「播客生成的音频资源」时，导出必然失败

```
Error: 备份数据不完整：记录"日志"引用的资源 podcast-audio 缺失。
```

原因：`createSnapshot` 用 `backupAssets`（**排除了 `generatedBy === "knowledge-podcast"` 的资源**）去做完整性校验：

```ts
// src/services/storageAdapter.ts:1932
const backupAssets = snapshot.assets.filter((asset) => asset.generatedBy !== "knowledge-podcast");
assertSnapshotIntegrity(cleanedBlocks, cleanedTemplates, backupAssets);
```

而 `assertSnapshotIntegrity` 要求**记录正文里出现的每个 `record-asset` 都必须在资源列表里**。排除规则与校验规则互相矛盾：被有意排除的资源，仍然被当作必需资源去检查。

- 复现：资源表放一条 `generatedBy: "knowledge-podcast"` 的音频，记录正文引用它 → `createSnapshot()` 抛错。
- 触发条件：某条日志的正文里插入了播客音频。正常 UI 目前没有这个入口，但历史数据 / 手工导入的数据可能有。
- 使用 `createStreamableSnapshot()`（Android 原生导出）同样会失败，因为同样的过滤 + 同样的校验（`storageAdapter.ts:2007-2008`）。

### 缺陷 B（严重）：任何「正文引用了已不存在资源」的记录，都会让导出永久失败

```
Error: 备份数据不完整：记录"日志"引用的资源 gone 缺失。
```

同一个校验：`synced.assets`（从正文解析）对不上资源表，就直接抛错，**没有任何容错、没有 UI 修复入口**。

现有代码里确实存在一个会制造这种残缺引用的漏洞 —— **孤儿资源清理不扫描模板**：

```ts
// src/services/storageAdapter.ts:605 cleanupOrphanAssetsForRecord
const stillReferencedAssetIds = new Set<string>();
for (const block of blocks) { ... }      // 只扫其它记录
for (const otherDraft of drafts) { ... } // 只扫其它草稿
// ← 完全没有扫描 db.templates
```

`permanentlyDeleteBlock`（永久删除 / 清空回收站）会调用它。因此：
1. 模板里引用了某张图片（`<record-asset data-asset-id="...">`）；
2. 用户把引用同一张图片的日志永久删除；
3. 清理逻辑因「没扫模板」把图片判为孤儿并删除 → 模板留下悬空引用；
4. 从此**每次导出 zip 都失败**，报错指向模板。

同一校验也覆盖模板，因此模板侧的悬空引用同样致命：

```
Error: 备份数据不完整：模板"含图片的模板"引用的资源 gone 缺失。
```

### 缺陷 C（中等）：播客行缺少 `segments` 字段时，导出抛 TypeError

```
TypeError: Cannot read properties of undefined (reading 'map')
```

`normalizeSnapshotPodcasts` 直接 `podcast.segments.map(...)`，没有兜底（`storageAdapter.ts:138`）。`audioUnits` 用了 `?.`，`segments` 没有 —— 明显的不一致。当前 `createEmptyPodcast` 会写入 `segments: []`，所以只有异常数据（中断写入、旧版本行、手工构造的备份）才会命中，但后果是整次导出失败。

### 缺陷 D（中等，与导出同链路）：ZIP 里写了播客行，导入时却被完全忽略

- 导出：`payload.podcasts` 会写进 `data.json`（`storageAdapter.ts:1969 / 2044`）。
- 导入：`zipToSnapshot` 构造 payload 时**根本不读 `data.podcasts`**（`src/services/backup.ts:194-212`）。
- 后果：用户以为备份了知识播客，恢复后播客列表全空；同时备份包里白带了这些数据（还会带上用户自定义的播客 prompt）。

### 缺陷 E（中等）：导入时的「允许资源缺失」实际上做不到

UI 文案承诺可以容忍（`src/pages/BackupPage.tsx:75`）：

> 有 N 个资源文件未在备份包中找到，相关记录会保留资源缺失占位。

但 `restoreSnapshotData` 第一步就调用同一个 `assertSnapshotIntegrity`，一旦备份包缺资源文件就直接抛错，**整次恢复被中止**，那句提示永远不会出现。

```
Error: 备份数据不完整：记录"日志"引用的资源 gone 缺失。
```

### 缺陷 F（严重，可观测性）：诊断编号吞掉真实错误，且不留任何日志

`uiError.ts` 的 `normalizeUiError` 形参名就是 `_error` —— 传入的错误**被完全丢弃**：

```ts
// src/lib/uiError.ts:39
export const normalizeUiError = (_error: unknown, context: UiErrorContext): UiError => {
  ...
  return { message: CONTEXT_MESSAGES[context], diagnosticId: `${prefix}-${time}${sequence}` };
};
```

后果：`BackupPage.tsx:103` 的 `formatUiError(error, "generic")` 会把导出链路上的**任何**失败（完整性校验失败、缓存盘写满、FileProvider 权限、分享面板拒绝、OOM）统一渲染成同一句「操作没有完成，请稍后重试。（诊断编号 G-xxxxxxxx）」，并且：

- 真实错误既不出现在界面上，也**不写 console、不落盘、不上报**（全仓库只找到 `main.tsx` / `cloudSyncService.ts` / `stage3PreviewSeed.ts` 三处 `console.error`，导出链路一处都没有）；
- 因此诊断编号**没有任何可查询的记录**，它是给用户看的装饰，不是给排障用的凭据。

这直接回答了「为什么界面只说一句话」：不是错误不重要，是错误在渲染前就被扔掉了。修复只需在丢弃前补一行 `console.error`（Android 会进 logcat），界面文案不变，`uiErrorSurface.test.ts` 仍然为绿。

### 缺陷 A–C 的影响面不止手动导出

同一份 `createSnapshot()` / `createStreamableSnapshot()` 被四处复用：

| 调用点 | 通道 |
| --- | --- |
| `streamingBackupService.ts:120` | 手动「导出完整备份」→ 系统分享（Android） |
| `knowledgeExportService.ts:184` | 手动导出（桌面/网页，全内存 JSZip） |
| `autoBackupAdapter.ts:73` | 自动备份到文件夹 |
| `nativeAutoBackupStreamService.ts:113`、`nativeRepositoryBackupService.ts:384` | 文件夹 / 仓库自动备份 |

也就是说，一旦命中缺陷 A/B/C，**用户在所有通道上都备份不了**，而每次只看到同一句泛化提示。这是本轮最需要优先处理的地方。

---

## 2. 结构性弱点：桌面版手动导出是「全内存」的

- Android 有原生流式 ZIP（`canUseNativeZipArchive()` 仅 Android 为 true）。
- **Windows 桌面版 / 网页版没有流式路径**：`createSnapshot()` 先把所有资源连二进制一起读进内存，`snapshotToZip` 再把每个资源交给 JSZip 并一次性 `generateAsync({ type: "blob" })`。
- 峰值内存约为「资源总体积 × 2~3」。用户已有的录音、图片越多，越容易卡死、白屏或直接失败；而导出路径**没有任何体积预警或上限保护**（云同步有 `EXPENSIVE_WRITE_*` 阈值，导出没有）。
- 播客音频被排除，所以播客不会放大这个问题；但普通录音会。

这解释了「以前能导出、今天不行」的一类现象：不是代码变了，而是库变大了。

---

## 3. 明确排除的（不是 bug）

- **公式索引校验**（`备份数据不一致：记录"…"的公式索引需要重新同步。`）实际上永远不会触发：`assertSnapshotIntegrity` 之前已经用 `syncRecordRefsFromContent` 把索引从正文重新推导了一遍，两边必然一致。这条校验是死代码，不可能是失败原因。
- **`JSZip: Can't read the data of 'assets/…'`**：这是测试环境下 `fake-indexeddb` 无法往返 Blob 造成的假象，不是应用缺陷（已单独验证）。

---

## 4. 对本次失败的定位（2026-09-13，Android App）

已知信息：

- 平台：Android App（走原生流式路径 `exportNativeStreamableBackupForShare`，经 `NativeZipArchivePlugin` 写 `cacheDir/shared-exports`）。
- 界面提示：`操作没有完成，请稍后重试。（诊断编号 G-8ZEJU001）`。

从提示可以读出两件事：

1. **`G` = `generic` 上下文**，即失败发生在 `BackupPage` 的 `run()` 兜底 catch 里。因此失败一定来自导出链路本身，而不是页面渲染或导航。
2. 诊断编号可解码：格式是 `G-<base36(Date.now()) 末 5 位><序号 3 位>`。`8ZEJU` → `15088746`，落在 `2026-09-13 11:21:42 (GMT+8)`（同余类每 36⁵ ms ≈ 16.8 小时重复一次，另外两个候选是 09-12 18:34 与 09-14 04:09）。序号 `001` 表示这是该次 App 会话中渲染的**第一条** UI 错误 —— 与「打开 App 直接去备份页导出、立刻失败」一致。

**无法从提示继续定位到 A/B/C 中的哪一条**，因为缺陷 F 把真实错误丢掉了。可用的旁证是：本轮用一份「干净且内容较全」的数据集（图片 / 录音 / 播客 / 模板 / 草稿 / 复习记录）跑 `createStreamableSnapshot()` 与 `createSnapshot()`，两者都返回成功（见 §5 复现方法）。所以这不是「导出代码整体坏了」，而是**你的库里存在某个特定数据条件**，按可能性排序：

1. **缺陷 B（最可能）** —— 某条日志或某个模板的正文引用了已不存在的资源。根因是 `cleanupOrphanAssetsForRecord` 不扫 `db.templates`：只要曾「永久删除 / 清空回收站」掉一条引用了某张图片的日志，而某个模板引用了同一张图片，这张图片就会被误判为孤儿删除，模板留下悬空引用，此后**每次导出都必然失败**。这最符合「以前能导出、今天突然不行」的形态。
2. **缺陷 C** —— 某行知识播客缺 `segments`（中断写入或旧版本行），命中 `TypeError`。
3. **缺陷 A** —— 某条记录正文引用了 `generatedBy: "knowledge-podcast"` 的音频。
4. **Android 专有** —— `Deflater.NO_COMPRESSION` 下缓存盘空间不足（`IOException: write failed: ENOSPC`）。资源总体积越大越容易命中，与「以前能、今天不能」也吻合。

要拿到确定答案，只需在生产代码里补上缺陷 F 的那一行日志，然后重试一次导出 —— Android 用 `adb logcat` 即可看到真实异常。

---

## 5. 建议的修复方向（本轮未实施）

| 缺陷 | 方向 |
| --- | --- |
| F（建议先做） | `normalizeUiError` 在丢弃错误前补 `console.error(\`[uiError] ${context} ${diagnosticId}\`, error)`。界面文案与隐私约定不变，Android 侧落到 logcat，之后每次失败都能直接定位。 |
| A / B | 完整性校验应只校验「实际会被打包的资源」集合；对确实缺失的引用改为**降级处理 + 显式警告**（导出仍成功，报告 N 处引用失效），而不是直接抛错。 |
| B 的根因 | `cleanupOrphanAssetsForRecord` 补上对 `db.templates`（以及任何未来引用资源的实体）的扫描。 |
| C | `normalizeSnapshotPodcasts` 对 `segments`（及其它集合字段）统一兜底为 `[]`。 |
| D | 二选一：`zipToSnapshot` 恢复 `podcasts`，或导出时不写 `podcasts`（并同步修正文档）。 |
| E | 让 `restoreSnapshotData` 的完整性检查与 UI 承诺一致：缺资源时保留占位而不是中止恢复。 |
| 结构弱点 | 桌面版补一条流式导出路径（可复用已有的文件夹仓库写入通道），或在导出前给出体积预警。 |
| Android 专有 | 导出前检查 `cacheDir` 可用空间并给出可读提示；或对已压缩媒体之外的文本改用 `Deflater.DEFAULT_COMPRESSION`。 |

### 复现方法

对真实 Dexie 存储 + 真实导出链路做定向注入：用 `new StudyJournalDatabase(uniqueName)` 建独立库、`vi.doMock("../db/database", ...)` 让 `DexieStorageAdapter` 指向该库，再分别构造

- 干净且内容较全的数据集（图片 / 录音 / 播客 / 模板 / 草稿 / 复习记录）→ `createStreamableSnapshot()`、`createSnapshot()` 均成功；
- 命中 A / B / C 的数据条件 → 分别抛出上文给出的三段错误。

注意：`fake-indexeddb` 不能往返 `Blob`（取出后变成 `{}`），因此凡是要经过 JSZip 的断言在测试里都会先报 `JSZip: Can't read the data of 'assets/…'` —— 这是测试环境假象，不是应用缺陷。相关临时测试已删除，不留在仓库。
