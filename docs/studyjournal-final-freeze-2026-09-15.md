# StudyJournal 最终冻结说明（2026-09-15）

## 1. 冻结结论

StudyJournal 自 2026-09-15 起进入**功能冻结与维护阶段**。本仓库作为现有产品、现有用户数据和历史发布的维护基线，不再承接 Exocortex 的产品改名或新功能演进。

本次冻结表示：远端最新代码已合入，已完成的功能、修复和数据边界已有代码与文档依据，确定性自动化验收可从干净检出复现。它**不等于完整生产发布签字**；§5 所列真实设备、付费服务和真实账号门禁仍保持开放。

## 2. 基线与身份

- 规范分支：`main`
- 收口前拉取的远端基线：`bf1ca3e3d0abc238845015dad68b8c7f6c14927b`（`fix(sync): dedupe same-name tags during snapshot restore`）
- 收口版本：包含本文及配套状态文档的提交
- 远端仓库：`https://github.com/a1234tuan/StudyJournal.git`
- 数据库：schema 21
- Web/npm 包名：`408-study-journal`
- Windows/Electron：版本 `0.1.6`，`appId=com.noteproject.study408.desktop`，产品名“学习日志”
- Android/Capacitor：`appId` / `namespace` / `applicationId=com.noteproject.study408`，应用名“学习日志”，`versionName=0.2.3`，`versionCode=14`

这些标识在 StudyJournal 仓库中必须保持稳定。后续维护不得借“品牌升级”之名改变应用身份、签名关系或默认数据位置。

## 3. 本次收口包含的能力与修复

- AI 驾驶舱 Stage 0-9、产品 UI 迁移、复习批注与跨页面评分撤回已完成自动化收口。
- AI 学习助教学习效果修复 P0-P4 已落地：客观证据投影、效果回流、重规划入口、结构化 AI 角色提示词、题目答案泄露检查和跨块引用门控均有确定性测试。
- 语音复述已具备独立可选的 `ASR -> LLM -> TTS` 生产链路、手动输入与自动半双工模式；阿里云 ASR、配置的 LLM 与 Fish Audio TTS 的自动多轮链路已有受控 Android 真机记录。
- 语音资料按所选模型上下文窗口进行 token 预算；正文转纯文本避免嵌套公式重复，并在截断时按节点边界处理和披露。
- 备份导出会移除未打包资源的引用，永久删除会同时检查日志、模板与知识播客引用。
- 快照恢复会在写入前按确定性规则合并同名标签，避免多设备离线创建同名标签后触发唯一索引冲突并中止恢复。
- 存储初始化会合并 React StrictMode 触发的并发调用，避免默认标签竞态写入触发未处理的唯一索引错误；初始化完成或失败后仍允许重新运行。
- 语音复述打开键盘输入时会保持字幕开启，使确认后的用户文本和完整回复持续可见；主动收起输入时再同步关闭字幕。
- 本地日期、Provider 默认值和迁移、原生壳预览隔离、草稿保存错误展示、依赖与死样式清理均有回归覆盖。

详细工程事实与不可变边界以根目录 `AGENTS.md` 为准，产品边界以 `docs/新的方案.md` 为准。

## 4. 收口验收

本次收口在 2026-09-15 按项目规定执行以下命令；付费 live 测试明确排除：

```powershell
npm run test -- --exclude "**/*.live.test.ts"
npm run test:voice-host
npm run test:e2e
npm run test:firebase
npm run build
git diff --check
```

最终代码状态的实测结果：

- Vitest：`176` 个文件、`1117` 项确定性测试全部通过，付费 live 文件显式排除。
- Desktop 语音宿主协议：`2/2` 通过。
- Playwright：Desktop 与 Android-narrow 共收集 `54` 项，`53` 项通过，`1` 项因仅适用于桌面而按预期跳过。
- Firebase Emulator：`4/4` 通过。
- TypeScript 与 Vite 生产构建成功；`git diff --check` 通过。

验收日志仍包含既有的部分 React 测试 `act(...)` 提示、PWA 开发构建空 glob 提示、Capacitor Share 静态/动态导入提示和大 chunk 提示；它们没有造成测试或构建失败，但应作为后续维护的测试卫生与性能债务保留观察。历史阶段验收不能替代本轮输出。

## 5. 未关闭的发布门禁与已知限制

以下事项没有因为“最终冻结”而被视为完成：

- Review Coach 两次调用的付费 DeepSeek Provider 验收尚未执行；live 测试继续默认跳过，必须另行批准凭据、调用次数与费用额度。
- 真实 Firebase 账号的 reads/writes、Storage、配额与账单指标仍需受控验收。
- Android 中文输入法、系统返回、图片手势、前后台切换、覆盖升级，以及语音手动输入、暂停/继续/结束、本机日志保留和按钮中断仍有逐设备人工门禁。
- 豆包语音 Profile 尚未用已开通对应服务的真实账号完成验证；不得从配置项推断模型、音色、配额、成本或可用性。
- 备份恢复遇到“内容引用了 ZIP 中缺失的资源”时仍会严格拒绝，而不是按界面承诺降级为缺失资源占位。
- `zipToSnapshot` 仍忽略 `payload.podcasts`；知识播客记录与音频本来也不属于云同步或可移植备份。
- 语音上下文新预算和知识导出 Markdown 格式的真实设备验证仍开放。
- AI 判题仍没有用户纠错通道；效果证据以轮次计数时，一项任务的三轮可以满足可用门槛，`unreliable` 轮次也可能满足计数门槛。
- 开放题通常不经过独立 AI 题质复核；知识关系不参与任务选择，系统也没有完整的目标、学习容量或迁移表现模型。
- `verificationPolicy.ts` 为调度仍把 `unreliable` 与 `partial` 同档处理，但学习效果、策略、难度和掌握判定不使用 `unreliable` 驱动变化。

## 6. 数据、同步与隐私边界

- `RecordBlock.contentHtml` 是决策块内容唯一可编辑真源；Review Coach 投影必须由正式事实重建，不能反向改写记录级 FSRS。
- `reviewAnnotationDrafts`、语音临时会话/轮次/本机历史、设备本地凭据和 Provider 配置均不进入 Firebase 或可移植备份；具体边界见 `AGENTS.md`。
- 知识播客行与音频不进入云同步或可移植备份。恢复仍对不可信输入执行严格完整性校验。
- Firebase Web 配置是随客户端发布的公开标识，不是服务端密钥；LLM、ASR、TTS、OCR 与签名凭据不得提交到源码、日志、测试、截图、备份或同步数据。

## 7. Exocortex 分离规则

Exocortex 必须从本冻结基线在**新的本地目录和新的远端仓库**中开始，不得在 StudyJournal 仓库原地改名。

初始化 Exocortex 前必须显式确定并一次性记录：

- 新的仓库所有者、仓库名和可见性；
- Web/npm 包名、Android application ID / namespace、Electron app ID、显示名和协议名；
- 新 Android 签名密钥与密钥保管方式，以及 Windows 是否启用新的代码签名身份；
- StudyJournal 数据是否迁移，以及迁移采用用户导入、一次性迁移器还是完全隔离。

更换 Android application ID、Electron app ID 或产品数据目录后，操作系统会把 Exocortex 视为独立应用，原 StudyJournal 数据不会自动出现。任何迁移都必须设计版本化、可回滚的显式导入流程；不得让新应用直接抢占或静默改写旧应用的数据目录。签名私钥、口令、服务账号与真实 Provider 凭据不得进入 Git。

## 8. 复现与维护

推荐使用 Node.js 24 和 `npm ci`。普通维护至少运行与改动范围相称的测试；涉及 Review Coach、备份/恢复、同步、原生宿主或语音行为时，遵守 `AGENTS.md` 的跨边界检查与完整验证要求。

历史方案、审计和阶段冻结文档继续保留用于追溯，但如果它们的过程状态与本文件或 `AGENTS.md` 冲突，以源码、本文件和 `AGENTS.md` 的当前基线为准。
