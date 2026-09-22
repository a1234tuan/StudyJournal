# 项目文档索引

更新日期：2026-09-22。首次接手请先阅读根目录 README.md、AGENTS.md 和 CHANGELOG.md。日期化冻结/审计文件保存当时结论，不能直接当作当前所有能力的验收证明。

## 知识库：v1 已实现，待最终人工验收

- [最终分阶段开发方案](knowledge-library-v1-final-implementation-plan-2026-09-22.md)：推荐取舍、P0–P7任务、逐阶段测试/退出标准及最终统一人工验收；D11–D12补齐默认库发现、引用删除/恢复、候选分批、空包副本与身份备份范围及21项专项用例；知识库 v1 已按方案实现并完成自动化回归；实施证据见实现记录，APK/EXE 已生成但未安装，生产规则和真实账号验收仍待授权。
- [总体完整版 R3](knowledge-library-v1-design-r3-complete-2026-09-22.md)：完整功能、数据可靠性与视觉交互；执行安排以最终开发方案为准。
- [范围记录](studyjournal-scope-unfreeze-2026-09-22-knowledge-library.md)、[使用流程](knowledge-library-user-flow-2026-09-22.md)：保留日志真源及既有学习事实边界。
- [数据设计独立裁定](knowledge-library-v1-review-adjudication-2026-09-22.md)、[视觉独立审查](knowledge-library-visual-review-2026-09-22.md)：历史评审证据，R1/R2 不再作为现行执行规格。
- [SJ-AUD-01 修复记录](sj-aud-01-lifecycle-write-fix-2026-09-22.md)：代码/自动化验证已完成，人工复验按最新安排并入最终验收，不能描述为用户已经验收。

## 当前接入与验收

- [云同步白盒复核修复与验收](audit/cloud-sync-whitebox-remediation-2026-09-21.md)：计划回收事务、删除守卫、过期保存提示、查询计数断言及原报告勘误；含保留拒写的异常验证链和未部署边界。

- [学习助教同步写入修复](cloud-sync-coach-write-boundaries-2026-09-21.md)：v0.2.5 后的角色绑定、启动选任务、队列幂等、反馈自动执行/旧回调和复查任务关联修复；区分首轮手机安装与后续未部署源码，以及真实账号验证边界。
- [云同步收敛专项修复](cloud-sync-convergence-fixes-2026-09-21.md)：软删除保留、事务 mutation、未知/部分提交核对、隐藏修订保护、助教旧回调、编辑草稿与语音恢复生命周期；含隔离回归和未部署边界。
- [语音服务配置](voice-recall-provider-configuration.md)：设备本机凭据、ASR/LLM/TTS 选择、平台限制和排障入口。
- [语音实现基线](realtime-voice-recall-implementation.md)：运行态、两段 TTS 预取、缓存重播、同步与隐私边界。
- [TTS Android 真机验收](voice-recall-tts-device-validation-2026-09-21.md)：Qwen Audio 3.1/3.0、豆包 2.0 的真实播放证据及仍未验证项。
- [语音发布检查表](voice-recall-release-checklist.md)：区分自动化、真实服务、真机和账单门槛。
- [豆包兼容性](doubao-voice-provider-compatibility.md)、[语音隐私](voice-recall-privacy.md)：协议族与设备本地数据边界。

## 产品与维护范围

- [产品方案](新的方案.md)：正式学习事实与 AI 建议的边界。
- [维护冻结](studyjournal-final-freeze-2026-09-15.md)：品牌、标识、数据路径及后续仓库分离规则。
- [今日计划范围](studyjournal-scope-unfreeze-2026-09-16.md)、[AI 反馈范围修订](studyjournal-scope-unfreeze-2026-09-17.md)：schema 24 与尚未实现的 L2 边界。
- [语音自然对话冻结](voice-call-natural-conversation-freeze-2026-09-14.md)、[ASR 可靠性范围](studyjournal-scope-unfreeze-2026-09-21-aliyun-nls-asr.md)：提示词和本轮维护约束。
- docs/archive/ 中的旧提案仅作历史参考，不覆盖活动基线。

## 构建与交接

[v0.2.5 Release](https://github.com/a1234tuan/StudyJournal/releases/tag/v0.2.5) 提供 Android APK、Windows x64 EXE 和 SHA256SUMS.txt；用户使用流程与教程插图见 [项目首页](../README.md)。发布编号不等于安装包内部版本号。

[2026-09-21 维护构建交接](release-handoff-2026-09-21.md) 记录本次验证数量、APK/EXE 校验值、手机覆盖安装和未验收边界。

验证命令见根目录 CONTRIBUTING.md。普通验证排除 live Provider 测试；已有密钥不等于授权额外消费。Android 使用 npm run android:build:release（自动构建并同步 Web），Windows 使用 npm run desktop:build；安装包和签名配置均不进入源码仓库。

现有构建版本分别为 Android 0.2.3（versionCode 14）和 Windows 0.1.6，沿用各自历史版本号；以构建时间、源码提交和 SHA-256 识别本次产物，不因为版本号不同推断代码新旧。Android 只使用同签名覆盖安装，不卸载或清空数据。Windows 安装包是否代码签名需单独核对，生成 EXE 不等同于 Authenticode 签名通过。
