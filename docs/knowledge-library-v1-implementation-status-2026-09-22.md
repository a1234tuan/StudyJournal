# 知识库 v1 实施记录

2026-09-22 用户明确授权按最终方案连续实施，阶段自行测试修复，仅最后邀请用户验收。

## 基线与保护

- 开工时为 schema 24；实现阶段完成 schema 25 增量迁移，原有 SJ-AUD-01 修改及设计文档保留，不重置工作区。
- 真实账号、用户数据库、安装目录和云规则不作为测试环境；不调用付费 Provider。
- 开工定向回归、非 live 全量、类型与生产构建串行运行；具体结果在完成后填写。

## 阶段状态

- P0：通过。协议身份、可变长度排序（含 10,000 次定种子插入）、预算、因果版本、删除/恢复/重复引用规则，以及 Firebase Emulator 正负例均通过。
- P1：通过。schema 25 十一张知识表、事务命令、草稿基线、代际 fence、SJ-AUD-01 回归和全量非 live 回归通过。
- P2：通过。ZIP、原生仓库、Android 流式、v7 外层容器、空知识恢复副本、校验失败前置拒绝、账号范围自动备份和显式另存会话通过。
- P3：通过（本地 harness + Emulator）。默认库发现、双端收敛、unknown/receipt、分批候选、陈旧意图阻塞及完整保留副本、账号隔离和普通/知识独立同步结果通过；生产规则尚未部署。
- P4：通过。首页入口、专题/节点/引用/备注/删除恢复、只读浏览、显式整理、导图缩放平移/把手拖拽、Ctrl/Cmd+F、日志返回栈和失败输入保留通过。
- P5：通过。冲突候选固定 group token、每批最多 4 个、分页、局部解决与未选候选保留；另存操作支持断点续做且结构候选不丢。
- P6：通过。自动备份 owner/destination fence、同事务范围快照、跨账号隔离、恢复入口选择当前身份仓库、OCR/正文检索缓存和性能相关 UI 回归通过。
- P7：自动化通过，外部验收待执行。tsc -b、生产构建、Android debug APK、Desktop NSIS、完整 Playwright 和 Emulator 已通过；未安装 APK/EXE，未连接真实 Firebase 账号，未部署生产规则，未运行付费 Provider 或破坏性真实数据测试。

## 证据

- 定向知识库/备份/同步/迁移：11 个文件、60 个测试通过；边界扩展后导入/自动备份/原生仓库/流式 v7 均覆盖。
- 非 live Vitest：225 个文件、1747 个测试通过，5 个 live 用例按约定跳过。
- Playwright：98 个通过、2 个既有跳过项；包含 desktop 与 android-narrow 的知识库核心工作流。
- Firebase Emulator：6/6 通过（知识库 2 文件 2 测试、既有普通云同步 4 测试）。
- 构建：npx tsc -b、npm run build、Android assembleDebug 和 Desktop electron-builder 通过；产物位于 android/app/build/outputs/apk/debug/app-debug.apk 与 release/desktop/学习日志 Setup 0.1.6.exe。
- 限制：未做 Android 真机安装/升级、Electron 已安装应用验收、生产 Firestore 规则部署、真实账号双设备压力和付费服务调用；这些属于最终人工/发布门槛，不在本轮自动测试中伪称通过。

未通过上游验收不对真实用户暴露新写入口；未运行项不记为通过。
