# P0/P1 修复实施计划 —— 云同步/备份/恢复加固收尾（2026-09-23）

**范围**：仅关闭终稿 v2（`docs/audit/cloud-sync-backup-restore-final-buglist-and-remediation-2026-09-23.md`）中的 B-01（P0）、B-02（P1）、B-03（P1，随附文档对账）。P2 项（B-04…B-15）不在本计划内，除注明"顺带"者。
**总纪律**：每个阶段以"验证闸门"收尾——闸门不过，**停在原地修复，禁止带入下一阶段**。全程不动 `src/db/`、不改 schema（保持 26）、不动同步协议版本与实体集、不触碰 Firebase rules、不部署任何安装包、不接触真实账号数据。
**并发防护**（吸取本日教训）：每阶段开跑前先 `git status --porcelain` 比对上一阶段留档 + 确认 `src/__probe__/` 不存在；本计划所有测试数字必须连命令、`--mode`、pool/worker 配置一起入档。

---

## Stage 0 —— 基线固化（不改动任何东西）

**动作**
1. 记录基线快照：`git rev-parse HEAD`、`git status --porcelain` 全清单、确认无 `src/__probe__` 残留。
2. 跑基线门禁（全部原始日志存入 `output/p0-p1-remediation-2026-09-23/baseline/`）：
   - `npx tsc -b`
   - 定向 12 个改动测试文件（预期 12 files / 147 tests 全绿）
   - 有界全量 `npx vitest run --exclude "**/*.live.test.ts"`（记录精确数字；已知噪声候选：aliyun 跨 realm ×3 环境敏感、`cloudSyncService.integration.test.ts` 并发超时——各做 1 次单跑记录其表现）
   - `npm run build`
   - `git diff --check`

**闸门 G0**：基线四件套（tsc / 定向 / 全量 / build）留档完成，且全量失败集被逐条定性为"既有噪声"（每条附单跑证据）。**本阶段任何"新出现"的失败都必须先解释掉才放行。**

---

## Stage 1 —— B-01（P0）产品代码修复

**改动**（`src/services/cloudSyncService.ts`，合计 ≤6 行含注释）
1. `:2726` → `const allRemote = await getAllRemote(user.uid, remote.state, true);`
2. 其后、`applyRemote` 之前 → `assertStrictRemoteDataset(allRemote);`
3. 把 `:2923-2925` 不变式注释移植到本分支（"This branch is a destructive replacement… every rejection happens before a local write, a ledger row or a cursor move"）。
4. 顺带（B-11，二选一，默认取①）：① 给 `restoreRemote`（`:2295`）同款 `strict=true + assertStrictRemoteDataset`；② 在 `:2291` 注释固化"`:2916` 守卫使其在 headRevision>0 时不可达"的形态前提。

**不改**：strict 解析器本体、`assertStrictRemoteDataset` 本体、incremental pull 的容错路径（其设计语义不变）。

**验证**
- `npx tsc -b` exit 0
- 定向跑与首同步分支相关的既有文件：`cloudSyncService.integration.test.ts`、`cloudSyncWhitebox.test.ts`、`cloudSyncModel.test.ts`
- **既有测试全绿是本阶段硬要求**——若既有用例此前隐式依赖"畸形文档被静默丢弃后继续同步"，说明测试本身在固化缺陷行为：按现状修改该用例使其匹配 fail-closed 语义，并把改动理由写入提交说明（不允许反过来放宽产品代码）。

**闸门 G1**：tsc + 上述三文件全绿；与 Stage 0 对应文件的用例数一致（除按上条注明的用例调整外无差异）。

---

## Stage 2 —— B-01 判别性回归网

**新增测试**（建议独立文件 `src/services/cloudSyncFirstEmptyDevice.test.ts`，走既有 in-memory transport，复用 integration 套件的桩设施）
1. **拒绝主用例**：`ledger=[]`、本机仅 bootstrap、云端 `headRevision>0`；向 `syncEntities` 注入①一条缺 `contentHash` 的文档、②一条与已有文档重复 id 的文档 ⇒ 断言同步以 `CloudSnapshotIntegrityError` 失败/返回，且逐字段断言：`blocks/assets/records` 行集不变、`cloudSyncLedger` 零新行、`cloudSyncState.remoteDatasetCompleteThroughRevision` 仍 `undefined`、`lastPulledRevision` 未推进。
2. **正对照用例**：同场景注入良构完整集合 ⇒ 同步成功、complete 标志推进至 `headRevision`、进度出现"已从云端恢复现有数据"。
3. **判别性证明**：临时回退 Stage 1 的 3 行（仅工作区，跑完即恢复），确认用例 1 在缺陷基线上失败，留存失败输出；恢复后全绿。

**闸门 G2**：用例 1/2 稳定通过 + 判别性失败证据留档；`tsc -b` 干净。

---

## Stage 3 —— B-02（P1）owner 断言前置 + B-05 缺测场景

**改动**（`src/services/autoBackupService.ts:142-146`，1 行移动）
- `assertKnowledgeOwner(taskOwner, taskGeneration);` 移到 `if (scope) await completeKnowledgeBackup(scope);` 之前（`ensureValidWriteResult` 之后）。
- 不采用函数级备选（不叠加两道防线；在测试注释中记录"四条件守卫结构上无法感知 owner 漂移"的原因，`scope.ts:32` 首条件两侧同为 A 恒等）。

**新增测试**（`src/features/knowledgeLibrary/autoBackup.test.ts`）
1. **P5-T4b 纯 owner 切换不重绑目的地**：A 授权 → capture → `changeKnowledgeOwner("account:B")`（不调 `authorizeKnowledgeBackup`）→ 断言 `completeKnowledgeBackup` 路径整体被拒，且 A、B 两侧 `capturedGenerations` 均不变。判别性：对未移动断言的基线必须失败（同 Stage 2 方法，留证据）。
2. **P5-T5 capture 后删库**：capture 后删除其中一个库 ⇒ `isKnowledgeBackupPending()` 为 true（补 `runtime.ts:49` 分支覆盖）。

**验证**：定向 `autoBackup.test.ts`、`autoBackupService.test.ts`、`AutoBackupPanel.test.tsx` 全绿；P5-T3 重试路径既有用例不受影响（它是守卫回归锚点）。

**闸门 G3**：两用例通过 + 用例 1 判别性失败证据留档；定向文件全绿；`tsc -b` 干净。

---

## Stage 4 —— 有界全量回归（"未引入其他 bug"的核心证明）

**动作**：在与 Stage 0 相同的工作区洁净度下（无探针、无临时产物），用**同一条命令**重跑：
- `npx vitest run --exclude "**/*.live.test.ts"` 全量
- `npx tsc -b`、`npm run build`、`git diff --check`

**通过判据（全部满足才算过）**
1. **失败集 ⊆ Stage 0 基线失败集**：任何新失败 = 引入回归，回 Stage 1–3 定位修复后**整个 Stage 4 重跑**。
2. 基线中的既有噪声逐条按同一口径复核（aliyun 若出现，按其基线表现对照；sync-integration 超时项用 `--pool=forks --poolOptions.forks.singleFork=true` 串行重跑必须通过）。
3. **通过用例数增量 = 新增用例数**（Stage 2 的 2 条 + Stage 3 的 2 条，±既有文件内断言级差异须逐条可解释）。
4. `tsc -b` / `build` exit 0；`git diff --check` 不新增空白项。

**闸门 G4 = 最终自动化验收**：产出对比表（Stage 0 vs Stage 4：文件数/用例数/失败集/跳过集），写入 `output/p0-p1-remediation-2026-09-23/gates/`。

---

## Stage 5 —— 文档与宣告对账（B-03，P1 的书面半边）

**仅在 G4 通过后执行**（数字必须是同 commit 可复算的）：
1. `AGENTS.md` 段 1：strict 宣告改为全称并点名四条破坏性入口（首同步 ✅ 本轮修复、cloud-wins ✅、快照恢复 ✅、legacy `restoreRemote` ✅ strict 或注释固化前提）；"4 条入口 4/4 有守卫"取代"now uses"式含混全称。
2. 同段与实施报告 `:96-97` 测试数字更正为 Stage 4 实测（定向 `12(+1 新)/…`；全量按 G4 对比表；口径命令与配置注明）；消除"14 个文件/13 文件"同行矛盾。
3. `AGENTS.md` 死代码披露按 B-07 扩至 `nativeAutoBackupStreamService.ts` 整文件 + Java `beginZipLatest`，标注"待用户删除或接线决策"（只披露，不动代码）。
4. B-04（Emulator 新语义）：本计划不改产品代码即可完成——为 `firebase-emulator/` 增加"子批失败不留可列恢复点 + strict 拒绝畸形集合"两用例（规则零改动），跑 `npm run test:firebase` 6→8；**或**经用户书面豁免留在 P2。二选一，不静默跳过。

**闸门 G5**：每条文档数字在同 commit 重跑成立（贴命令与输出）；`git diff --check` 干净。

---

## Stage 6 —— 用户验收（唯一允许打扰用户的阶段，放在最后）

向用户提交验收包，等待签认：
1. **证据包**：G0–G5 闸门记录、两段判别性失败证据（"不修就抓不住"的机器证明）、Stage 4 对比表。
2. **行为验收单**（用户侧，可选执行）：
   - Web：新设备/空库登录既有账号 ⇒ 首同步成功且 UI 显示"已从云端恢复现有数据"；
   - 双设备：A 端 owner 切换瞬间自动备份窗口 ⇒ B 侧与 A 侧 `capturedGenerations` 均无漂移（可用 DevTools 查 `knowledgeBackupScopes`）；
   - 死代码决策：对 B-07 给出"删除或接线"决定。
3. **明确申报未覆盖项**（不替用户宣布完成）：Desktop/Android/Web host 物理验收、真实账号两设备、老数据对 strict 的过拒性、部署与用户验收——发布仍需这些另行通过（两份审计的一致结论）。

**最终完成定义（对应"一定要明确没有引入其他 bug"）**
- B-01/B-02 的缺陷本体有修复代码 + 判别性回归在场（G2/G3 失败证据为凭）；
- B-03 的宣告与数字在同一 commit 可复算（G5 为凭）；
- 全量失败集不大于基线失败集（G4 对比表为凭）；
- 除计划内文件外 `git status` 无新增改动面，schema/协议/rules/部署零变化；
- 用户签认 Stage 6 验收包 ⇒ P0/P1 修复关闭；任何一项不满足 ⇒ 返回对应 Stage，不得宣布完成。
