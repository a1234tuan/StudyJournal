# SJ-AUD-01 生命周期陈旧整行写回：核实、修复与验收（2026-09-22）

**后续验收安排（2026-09-22）**：用户最新要求知识库按最终方案自行完成各阶段测试，仅在最后邀请人工验收。本修复先纳入 P0/P7 自动回归，人工复验并入最终清单；下文原先的先行人工验收安排保留作历史，不再是中间确认关卡。测试证据和未部署事实不变，未将用户验收标记为通过。参见 `docs/knowledge-library-v1-final-implementation-plan-2026-09-22.md`。

## 1. 结论与范围

缺陷真实存在，维持 P1：需要异步交错窗口，但可能覆盖刚提交的正文、标签、附件引用、计划关联或资源 Blob。此次先处理数据可靠性，不开展知识库实施。

已修复生产入口：deleteBlock、restoreBlock、toggleRecordFavorite、patchAsset，以及核对调用链时发现的同源入口 renameAssetTitle。

报告中需要修正的一点：renameAssetTitle 不调用 patchAsset，而是独立读取资源、日志、草稿和模板后再写回；旧实现同样存在陈旧整行覆盖，因此一并修复。不扩大到其他生命周期方法、同步协议、schema 或知识库新功能。

## 2. 复现证据

新增 src/services/storageAdapter.lifecycleConcurrency.test.ts，使用实际 StudyJournalDatabase、Dexie 和 fake-indexeddb；两个数据库连接指向同一个测试库，用可控 Promise 在进入写事务前暂停，让第二个写入先提交。

修复前的 13 个交错用例全部产生断言失败（不是超时）：正式 expectedRecord 保存先完成后删除覆盖、同时间戳的删除/恢复陈旧覆盖、物理删除后的复活、收藏覆盖内容与错误 no-op、标题/OCR patch 覆盖新资源、标题重命名覆盖资源及引用。OCR operational 旧路径没有显式事务，测试在其 assets.put 提交前安排相同窗口。

修复后扩充到 29 项：增加缺行和类型边界、重复操作、空删除时间戳、mutation 写入失败后的整事务回滚、重试、并发标题与运行态 OCR、id/Blob 注入防护、引用标题修复，以及真实 restoreCloudSyncSnapshot 与删除/恢复/OCR 的交错。

两个连接模拟的是同一设备数据库中的异步竞争，包括同步拉取写入与本机操作，不是两台物理设备直接共享 IndexedDB；不能把该测试称为真实账号双端验收。

## 3. 修复策略

### 删除与恢复

- 操作开始读取期望行，仅作为比较基线。
- 在覆盖相关表和 cloudSyncMutation 的同一个读写事务中重读当前行，与完整期望行比较，不只看 updatedAt。
- 行消失或任何字段变化，抛出现有 StaleRecordError（code: stale-record），不写回旧内容、不复活已经删除的实体。
- 删除还在同一事务内清理草稿和标记复习状态 removed；恢复不自动重新加入复习。
- 已删除行再次删除、活动行再次恢复为 no-op；显式恢复仍可以处理空字符串 deletedAt。
- 正式数据和 mutation epoch 一起提交或回滚。

### 收藏与资源 patch

- 将读取当前行、应用明确字段变更、no-op 判断、写入全部放在同一事务内。
- 收藏不会把事务前捕获的正文、标签、资源引用或计划关联写回。
- patchAsset 保留事务内最新 Blob，仍过滤运行时传入的 id/data；未在 patch 中声明的元数据保持最新。
- 资源/日志已不存在则不重建。
- OCR operational 状态仍不增加云 mutation；正式标题/accepted OCR text 的真实变化增加一次 mutation。

### 资源标题传播

- assets、blocks、recordDrafts、templates、cloudSyncMutation 放入同一个事务。
- 在事务内读取最新内容并仅生成标题引用更新，保留正文、草稿基线、模板标题和 OCR/Blob。
- 真实变化才写入和增加 epoch；仅引用标题不一致时仍修复引用，资源本身不需要改写。
- 任一写入失败，资源、引用和 mutation 整体回滚。

## 4. 验证记录

- 修复前红灯：13/13 交错用例断言失败，确认会覆盖或复活旧数据。
- 修复后专用回归：29/29 通过。
- 初始定向存储回归：6 文件 / 87 项通过（当时专用回归为 26 项，之后增加 3 项云恢复交错）。
- 首轮全量非 live：217 文件中 216 通过；1705 项中 1704 通过；cloudSyncService.integration.test.ts 的多批次 publish 核对用例在 5 秒阈值超时。当轮同时执行生产构建，不隐瞒该失败。
- 该集成文件单独重跑：22/22 通过，超时用例耗时约 1.2 秒。没有为此修改产品代码或测试 timeout。
- 首轮生产构建（tsc -b 与 Vite）：通过；仅既有 chunk 体积等警告。
- 最终全量非 live（maxWorkers=4、minWorkers=1）：217 文件 / 1708 项全部通过；包含最终 29 项新增回归。
- 最终 npx tsc -b：通过。生产代码自上述成功构建后没有再修改。
- Playwright（workers=2）：daily-plan、ui-v2-stage3-editor、ui-v2-stage5-surfaces、review-coach-stage9，desktop 与 Android-narrow 共 32/32 通过，包含删除/回收站恢复、草稿和学习计划关联。这里是浏览器 UI 回归，不是登录真实 Firebase 账号的双端同步验收。
- Firebase Emulator：demo-noteproject-stage9 隔离项目，Firestore/Storage 4/4 通过。
- git diff --check、相关文件 UTF-8 编码/尾随空白与文档指针检查：通过。

复现命令：

```powershell
npm run test -- src/services/storageAdapter.lifecycleConcurrency.test.ts
npm run test -- src/services/cloudSyncService.integration.test.ts
npm run test -- --exclude "**/*.live.test.ts" --maxWorkers=4 --minWorkers=1
npx tsc -b
npm run build
npm run test:e2e -- e2e/daily-plan.spec.ts e2e/ui-v2-stage3-editor.spec.ts e2e/ui-v2-stage5-surfaces.spec.ts e2e/review-coach-stage9.spec.ts --workers=2
npm run test:firebase
git diff --check
```

日志保存在运行机器临时目录，名称为 sj-aud-01-red.log、sj-aud-01-targeted.log、sj-aud-01-regression.log、sj-aud-01-full-vitest.log、sj-aud-01-full-vitest-rerun.log、sj-aud-01-sync-rerun.log、sj-aud-01-build.log、sj-aud-01-tsc.log、sj-aud-01-playwright.log、sj-aud-01-emulator.log；不是用户数据或凭据。

## 5. 用户验收与剩余边界

本次不改变云端冲突策略、schema、应用身份或原数据路径；未执行真实账号同步、付费 Provider 测试或 ADB 部署。自动化通过不等于手机/desktop 安装版已包含修复。

本修复处理明确的生命周期读写交错，不宣称穷尽所有存储方法的并发缺陷。patchAsset 会原子应用调用者明确提交的字段，但没有引入 OCR job generation/expected-asset 契约；陈旧业务回调若明确携带旧字段，属于另一层任务有效性问题，不能声称由本次原子 patch 一并解决。

知识库 v1 文档仅暂存冻结，尚未定稿：必须先由用户验收此 bug 修复，再由用户确认设计可冻结并明确同意实施，才能开展知识库代码、数据库或同步通道扩展。

建议用户验收：使用测试记录检查收藏后正文/标签不变；删除、回收站恢复后正文和计划关联保留；资源重命名后正文/图片/OCR 可用；重复操作不会制造额外同步变化。故意构造竞争的破坏性测试仅在隔离测试库进行，不在用户真实数据上试验。
