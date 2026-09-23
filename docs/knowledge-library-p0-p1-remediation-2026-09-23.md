# 知识库 P0 / P1 分阶段修复与验收记录

日期：2026-09-23。基线：main / c9f4b68；本次修复尚未提交。

依据 `knowledge-library-three-reports-recheck-and-p0-p1-plan-2026-09-23.md` 的复核结论实施，仅处理确认的 2 项 P0、6 项 P1；不将原审查报告中的指令视作用户授权，不扩展到 P2。用户已授权逐阶段测试后继续，以及最终全量构建和 UI 截图。

## 1. 已实施的阶段

### 第一阶段：F01 / P0，原生备份目的地隔离

- Desktop 的 ensure、list、beginWrite、readText、readChunk、delete 全链路传递 repositoryName；不再退回共同固定根目录。分片追加与完成使用创建会话时固定的目标。
- 绑定记录使用随机 generation；兼容旧绑定的 updatedAt。重绑后旧会话拒绝追加/提交，不覆盖旧 manifest。名称、路径包含关系及符号链接/目录联接校验位于 desktop/backupRepositoryPaths.cjs。
- Android 不再仅凭 manifest/snapshots 识别仓库根：只有名称匹配才接受已有根；其他已有仓库要求重新选择父目录，不能当成另一目的地复用。写会话捕获并验证绑定代际及树 URI。
- 测试包含真实临时文件系统中 A/B/guest 各六份快照、manifest、读分片、删除隔离与重绑拒绝；IPC 集成执行 main.cjs 中真实处理代码，但不启动 Electron 窗口、不读取用户目录。

### 第二阶段：F02 / P0，保护恢复副本

- blocked command 或持久化同步故障仍引用的副本受保护。删除库、永久清理、正式内容写入及草稿写入由仓库事务再次检查，不依赖 UI 禁用。
- UI 展示只读保全说明，禁止删除，允许另存可编辑副本；保护副本不因用户查看而被释放。
- 已损坏旧数据中恢复副本缺失时，隐藏无效打开入口，展示风险，只允许用户逐条明确放弃，事务检查原命令哈希和副本仍缺失。没有自动抹除旧意图。

### 第三阶段：F03、F07 / P1，复制与草稿退出

- F03：已清理父节点的未解决移动候选，复制时保存确定性的 missing-* 目标身份，不伪造实体或丢弃候选。UI 提示保留当前位置后显式移动。
- F07：拒绝打开已有草稿即取消本次编辑，不再创建无法保存的新会话；不新增并行草稿模型。保存失败后可明确放弃本次输入并退出，既有草稿保留；删除已存草稿校验身份和基线。
- 回归检查旧正式内容没有被覆盖、草稿仍存在、失败后有可达退出路径。

### 第四阶段：F05、F08 / P1，导航上下文

- F05：日志来源栈绑定 owner，只在导航成功后 push/pop；无关 tab/独立知识库入口/账号变化清空，最多保留 16 层。浏览器 popstate 清空额外来源栈，避免历史返回被重复消费。
- F08：滚动位置绑定 library/workspace；切目标归零，过期组件回调拒绝，DOM 和虚拟列表状态一起重置，不再在卸载时回写旧专题位置。
- 浏览器检查长专题滚动后进入短专题的真实 scrollTop，以及离开知识库后独立重入不会返回旧日志。

### 第五阶段：F06 / P1，导入进度去掉整包重写

- schema 25 → 26，新增仅设备本地的 knowledgeImportSessions、knowledgeImportSteps 两表。元数据与冻结命令分离；单步执行、待同步命令、进度推进及对应步骤删除在同一事务。
- 旧活动会话只迁移剩余命令；完成会话只留小型幂等凭据；从 knowledgeSyncState 移除旧 commands 数组。非法旧进度令整个版本升级回滚。
- 同一冻结步骤并发执行只允许一次，另一请求安全报 stale；再次继续会话不会产生重复实体。来源库删除后仍可用冻结步骤恢复，云同步设置增加独立的继续入口，不再要求来源存在于选择器。
- 100/500/1000 条冻结命令的回归断言：单步后进度和同步行均小于 512 个 JSON 字符；只消费对应步骤，末尾步骤原样保留。此项验证存储结构，不宣称大型库复制的端到端耗时或磁盘性能达标。
- 这两表不进入云事实或便携知识包；完成凭据仍保留，但不再含整份命令。原状态投影/构造命令过程仍有既有计算成本，本次不扩展性能重构。

### 第六阶段：F04 / P1，坏云历史的安全恢复

- 捕获完整性失败的可信 cursor、失败 sequence、类别、包指纹和重复次数，持久化安全故障状态。事务失败不跳过坏提交，不推进游标，不清除原待同步队列。
- 界面提供重新校验、保全并打开只读本机副本及备份导出说明。保全幂等，包含正式状态及草稿；原队列仍留在源库。
- 隔离 MemoryCloud 用例验证：坏包阻断 → 故障持久化 → 幂等保全 → 副本受保护 → 修复测试云包 → 从原游标恢复。
- 不提供客户端篡改历史/强制跳过入口，不替换账号默认云库。生产云历史修复需要另行授权和可信管理端；本次没有部署修复工具、规则或修改生产数据。

## 2. 验证结果

最终全量非 live Vitest：232 文件 / 1815 测试全部通过（有界 2 worker，215.57 秒）；此前全量运行同样全部通过。最终 TypeScript 与生产 Vite/PWA 构建通过。

- 分阶段执行过桥接/备份、保护副本、复制/草稿、迁移/同步/导航定向回归；收敛定向运行 18 文件 / 104 测试通过，TypeScript 通过。随后新增三组大批次边界用例纳入全量套件。
- Desktop 真实临时文件系统/IPC 回归 3/3 通过。
- 浏览器四组知识库 E2E：45 项通过、1 项按设备条件跳过；新增恢复入口夹具修正后单独重跑 2/2 通过。合计 47 个场景通过、1 个跳过（桌面不执行仅触屏长按用例）。
- 两次全组运行的新截图夹具分别因浏览器无法解析裸模块名、预构建 ReactDOM 导出方式错误失败；修正的是测试夹具，不是产品逻辑。其余 45 项两次均通过。恢复入口额外截图是组件级隔离挂载，不冒充真实登录云设置的端到端验收。
- UI 检查覆盖 1440×1000 桌面、390×844 窄屏，包含恢复保护、失败草稿退出、云历史保全、专题滚动复位和缺失来源的继续复制；已有几何/导图用例同时覆盖 reading/modern 的明暗主题。截图检查发现只读空副本仍显示可用创建入口，现已禁用并加浏览器断言。
- 截图保存于 output/knowledge-remediation-2026-09-23/screenshots（53 张，从 test-results/playwright 留存）及 output/knowledge-remediation-2026-09-23/resume-copy-browser（2 张）。已查看关键新增状态，未见文字或控件被遮挡；真实 scrollTop、按钮禁用与数据不变由断言验证。
- Firebase Emulator：2 文件 / 6 测试通过，使用 demo 项目；未连接生产项目或部署规则。
- Android 补充代际检查后的 Java 编译及根目录策略 JUnit：2/2 通过，Gradle BUILD SUCCESSFUL；未生成/安装新发布包。
- Desktop main/preload 的 Node 语法检查、git diff --check 通过。构建保留既有打包提示/Gradle 弃用提示，不将其称为测试失败。
- 详细机器日志保存到 output/knowledge-remediation-2026-09-23；这不是已提交的团队 CI 产物。

复现主要命令：

```powershell
npm run test -- --exclude '**/*.live.test.ts' --maxWorkers=2 --minWorkers=1
npm run build
npm run test:firebase
node --test desktop/backupRepositoryPaths.test.cjs desktop/backupRepository.integration.test.cjs
npx playwright test e2e/knowledge-library.spec.ts e2e/knowledge-library-workflows.spec.ts e2e/knowledge-library-management.spec.ts e2e/knowledge-library-map-refinement.spec.ts --workers=1
```

Android 命令在 android/ 下、JAVA_HOME 指向 JDK21：`./gradlew.bat :app:testDebugUnitTest --tests com.noteproject.study408.BackupRepositoryRootPolicyTest --console=plain`。恢复入口的最终通过日志为 resume-copy-browser.log，其他浏览器场景见 playwright.log；失败夹具原因与重跑范围已在上方明确。

## 3. 范围与验收边界

- 未更改学习事实、普通日志的设备级归属、云端知识协议、生产 Firestore/Storage 规则或应用标识。
- 浏览器 android-narrow 是 390×844 的 Chromium 模拟，不等于 Android SAF 真机或安装验收；Desktop IPC 文件系统测试不等于完整 Electron 安装包验收。
- 不安装/覆盖 APK、EXE，不提交代码，不调用付费 AI Provider，不在真实用户数据上进行破坏性测试。
- schema26 是真实版本升级；不要把旧 schema25 构建直接覆盖当前已升级数据库来尝试降级。真机升级前需保留独立备份；本次未替用户安装升级。
- 先前审计 output/knowledge-review-recheck-2026-09-23 中的探针用于证明旧缺陷，断言旧错误现状；不应当作为修复后必须通过的产品回归。正确契约已转入 src/ 下的正式回归。
- UI 截图/自动化通过只能说明所测场景未发现回归，不构成所有设备、并发和存储故障的绝对无 bug 保证。用户验收与原生真机/安装验收仍待完成。

## 4. 建议用户验收路径

1. 知识库正常新建、编辑、引用日志、返回，长短专题切换后列表首屏正确。
2. 保存失败时明确退出，重开仍能看到已有草稿；选择不恢复旧稿不会被困在编辑态。
3. 恢复副本显示只读说明、不能删除；可另存编辑，旧待确认操作只能明确处理。
4. 中断复制恢复后只产生一份内容，来源删除也仍有继续入口；旧 schema25 数据在隔离备份上验证升级。
5. 在独立测试目录/测试账号验证 Desktop 与 Android 的 A/B/guest 备份隔离、重绑中断。不要用真实唯一备份做破坏性验收。
