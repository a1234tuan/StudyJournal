# StudyJournal 收口阶段全规模审计报告

## 0. 审计范围与基线

- 审计日期：2026-09-14；对象是当前工作区，不是仅 `HEAD`。
- `git rev-parse HEAD`：`6463c793abd54c3e7495d3b5da64cb6dad948553`。
- `git status --short` 在审计开始时仅列出未跟踪的 `dist-verify-audit/`、`img/`、`output/`；本轮没有修改源码、配置、schema、宿主代码或冻结文档。
- 已读取既有审计：`docs/audit/full-engineering-audit-2026-09-13.md`、`docs/audit/round2-closeout-special-audit-2026-09-13.md`、`docs/audit/voice-call-natural-conversation-audit-2026-09-14.md`、`docs/audit/cloud-sync-backup-boundary-audit-2026-09-13.md`、`docs/audit/zip-export-failure-diagnosis-2026-09-13.md`、`STUDYJOURNAL_AUDIT_REPORT.md`、`audit/second-review/REPORT.md`。
- 本报告只把当前重新观察到的失败列为“本轮确认”；既有报告中的问题若未重新复现，标为“既有审计重复/本轮未重演”。

## 1. 确定性证据

| 命令 | 实际结果 |
|---|---|
| `git log --oneline -20` | HEAD 为 `6463c79`；最近提交包含 `474ff97`、`b20aa7f`、`829f98d`、`a1fd43e` 等收口相关变更。 |
| `npx tsc -b` | 通过，退出码 0。 |
| `npm run test -- --exclude "**/*.live.test.ts"` | 失败，`162` 个测试文件中 `159` 通过、`3` 失败；`1011` 项中 `1008` 通过。两项为 5 秒超时：`src/services/storageAdapter.restore.test.ts`、`src/services/storageAdapter.review.test.ts`；一项为 `src/features/voiceRecall/auditRegression.test.tsx` 的 R11。另有未处理 `VoiceRecallTransitionError: idle -> PAUSE`。 |
| `npm run test:voice-host` | 通过，2/2。 |
| `npm run test:e2e` | 通过，54 项中 53 passed、1 skipped，退出码 0。 |
| `npm run build` | 通过，4904 modules transformed；有大 chunk 警告及 PWA `dev-dist` glob 警告。 |
| `git diff --check` | 通过，退出码 0。 |

与 `AGENTS.md` 的声明相比，实际确定性 Vitest 为 162 文件/1011 项，而声明为 163 文件/1021 项；E2E 的 54/53+1 与声明一致。差异本身需要在收口说明中解释，不能当作通过基线。

## 2. 总体结论

总体：**有问题，不建议在未处理 P1 语音状态机与测试基线失败前冻结**。最大风险排序：

1. P1：生产语音暂停路径存在非法状态迁移，当前测试产生未处理 rejection，并导致 R11 无法完成。
2. P1：既有审计确认的本轮答案未进入 LLM 请求、多句 ASR 只保留最后一句、取消/代际隔离不足、真实静音与 UI 状态不一致；本轮按既有报告重复登记，未重复改写为新问题。
3. P2：两个 storageAdapter 测试超时，可能是测试环境时序问题，也可能暴露事务/资源 staging 的慢路径；当前未将其升级为功能 Bug。
4. P2：用量记账 R11 仍保存为零，既有报告已有复现证据，本轮失败再次出现。

## 3. 覆盖矩阵

| 模块 | 结论 | 实际读取文件/域 | 发现 |
|---|---|---|---|
| M01 启动/路由 | 有隐患 | `src/App.tsx`、`src/main.tsx`、`src/hooks/useAppData.ts` | F-01、既有 R3；测试覆盖存在。 |
| M02 数据/迁移/schema | 健康（静态范围内） | `src/db/database.ts`、`src/db/reviewCoachSchema.ts`、迁移测试 | 未发现本轮新反例；迁移深度仍需独立中断测试。 |
| M03 日志/今日 | 健康 | Journal/Today/Favorites/Trash 及测试 | 未发现本轮新问题。 |
| M04 编辑器/结构块 | 有隐患 | `RecordEditorPage`、`RichTextEditor`、结构节点 | 既有编辑边界风险；本轮未确认新 Bug。 |
| M05 Markdown/序列化 | 有隐患 | `markdown*`、`recordContent`、`recordMigration` | 需补嵌套结构往返验证，未升级为已确认 Bug。 |
| M06 复习/FSRS | 健康（自动化范围） | `reviewScheduler`、`ReviewPage`、`PlaybackProvider` | E2E/单测通过；真机音频仍未静态可证。 |
| M07 复习批注 | 健康（自动化范围） | `features/reviewAnnotations/*` | E2E 与组件测试通过；跨标签页语义依赖运行时验证。 |
| M08 Review Coach | 健康（自动化范围） | `features/reviewCoach/*`、Adaptive/Workbench | 形式化事务和 E2E 通过；无新越权写入证据。 |
| M09 AI/Cockpit | 有隐患 | AI services/providers/tokens/pages | 既有 R12/R13；本轮未新增。 |
| M10 语音复述 | 有问题 | `runtimeController.ts`、`domain.ts`、workspace、transports | F-01；既有 R1-R6、R8-R11、R15。 |
| M11 TTS/播客 | 有隐患 | TTS providers/native/podcast services | 既有 R10；真实 provider 未执行。 |
| M12 OCR | 健康（自动化范围） | OCR services/native/desktop/settings | 单测通过；真机权限/孤儿文件未验证。 |
| M13 搜索 | 健康 | `lib/search`、`SearchPage` | 单测/E2E 通过。 |
| M14 统计 | 健康 | `learningStats`、heatmaps、StatsPage | 单测/E2E 通过。 |
| M15 备份/恢复/导出 | 有隐患 | storage/backup/streaming/native/export | 两项相关测试超时；未证明数据丢失。 |
| M16 云同步/Firebase | 有隐患 | cloudSync/Firebase/rules/functions | 本轮未跑 `test:firebase`；不能宣称全通过。 |
| M17 媒体/附件 | 健康（自动化范围） | playback/audio/recordings/images | 单测通过，设备资源释放需真机验证。 |
| M18 设置/导航/布局 | 健康（自动化范围） | Settings/More/UsageGuide及 lib | 单测/E2E 通过。 |
| M19 视觉层 | 健康（自动化范围） | `src/styles/*`、voice CSS | E2E 通过；样式死选择器仅列清理候选。 |
| M20 预览/调试 | 有隐患 | `src/preview/*`、App preview branches | E2E 覆盖已知 preview；生产泄漏需构建产物逐入口审计。 |
| M21 Android 宿主 | 有隐患 | `android/*`、manifest/build/scripts | host/desktop 通过；未完成 11 plugin 全量方法对照。 |
| M22 Desktop 宿主 | 健康（已测路径） | `desktop/main.cjs`、`preload.cjs`、voice socket | voice-host 2/2 通过；完整 IPC 清单仍需人工复核。 |
| M23 构建/测试基础设施 | 有问题 | configs/scripts/e2e/fixtures | 基线数字偏差；Vitest 3 failures。 |

## 4. 问题总表

| ID | 严重度 | 模块 | 位置 | 现象 | 触发路径 | 证据 | 置信度 | 建议修法 | 改动波及面 | 与既有审计是否重复 |
|---|---|---|---|---|---|---|---|---|---|---|
| F-01 | P1 | M10 | `src/features/voiceRecall/runtimeController.ts:331-336`；`src/features/voiceRecall/domain.ts:200-213` | `pause()` 对 `idle` 状态 dispatch `PAUSE`，状态机抛 `Invalid voice recall transition: idle -> PAUSE`，形成未处理 rejection。 | 创建/恢复未进入 listening 的会话后调用暂停，或测试清理阶段调用 pause。 | 本轮 Vitest R11 未处理错误原文；`pause()` 仅排除 paused/ended，domain 未接受 idle。 | 高 | 在 pause 前处理 idle/非可暂停状态，且保证清理路径不产生 unhandled rejection；补状态机回归测试。 | 中 | 新确认，本轮新增 |
| F-02 | P2 | M23/M15 | `src/services/storageAdapter.restore.test.ts`；`src/services/storageAdapter.review.test.ts` | 两项确定性测试超过 5000ms，导致全量基线失败。 | 执行普通 Vitest。 | 本轮命令输出：两个测试分别在约 6039ms/6149ms 超时。 | 高（测试失败）；低（产品 Bug） | 先隔离环境/事务耗时，再判断实现或测试阈值；不能直接放宽超时掩盖。 | 中 | 新确认的基线失败 |
| F-03 | P2 | M10 | `src/features/voiceRecall/auditRegression.test.tsx` R11；`src/features/voiceRecall` production workspace | 用量记账 R11 未完成，测试找不到“已接通”标题；既有路径还报告读回 `llmOutputTokens: 0`。 | 配置 mock provider，连接、提交一轮、结束并读取本机历史。 | 本轮测试失败；`audit/second-review/REPORT.md:186-194` 有同一 R11 的复现证据。 | 高 | 修复连接前置状态与 usage 聚合/持久化链路，补端到端无网络用例。 | 中 | 重复，确认仍存在 |
| F-04 | P1 | M10 | `VoiceRecallWorkspace.tsx`、`teacherPrompt.ts`、`pipeline.ts` | 当前确认回答未进入 LLM 请求。 | 首轮确认答案后捕获 `respondTurn` messages。 | `audit/second-review/REPORT.md:54-64` 的 R1 复现。 | 高 | 明确把本轮 confirmedText 追加为 untrusted user content。 | 中 | 重复，未本轮重演 |
| F-05 | P1 | M10 | `aliyunAsrProtocol.ts`、`aliyunAsrTransport.ts`、workspace | 多句 ASR final 只保留最后句。 | 连续发送两句 final。 | `audit/second-review/REPORT.md:68-76` 的 R2 复现。 | 高 | 按累计/非累计 final 语义合并并去重。 | 中 | 重复，未本轮重演 |

## 5. 模块详细报告

以下各节均完成了文件域级覆盖；“未发现”表示本轮静态与现有自动化范围内未找到可确认反例，不等于真机/付费 provider 验收。

### M01–M05
- **M01**：有隐患。`App.tsx`、`useAppData.ts`、路由与 preview 分支已读；F-01 发生在语音枢纽，未发现新增全局路由崩溃。高风险无测试区：App 生命周期与 StrictMode 清理。
- **M02**：健康。数据库定义、schema 21 与迁移测试已读；未发现本轮新迁移反例。高风险无测试区：人为中断迁移后的重跑。
- **M03**：健康。日志、今日、收藏、回收站和相关页面测试已读；未发现新增数据不一致。
- **M04**：有隐患。编辑器与结构节点测试广泛通过；嵌套节点纯文本/Markdown 往返仍是边界区，未确认新 Bug。
- **M05**：有隐患。`recordContent` 当前避免折叠/高亮嵌套公式重复提取；表格管道符、代码块 `$$` 等最小样例未在本轮执行，列入静态不足。

### M06–M09
- **M06**：健康（自动化范围）。FSRS 与 Review E2E 通过；真机音频播放策略仍不可静态证明。
- **M07**：健康（自动化范围）。批注组件测试和 E2E 通过；草稿跨标签页写入需真实多页验证。
- **M08**：健康（自动化范围）。repository/orchestrator/gateway 测试及 Stage 9 E2E 通过；未发现绕过 repository 的本轮确认写入。
- **M09**：有隐患。AI 重试、token、provider 单测通过；既有 R12/R13 仍是边界问题，未与当前代码重新逐行复现。

### M10–M11
- **M10**：有问题。F-01、F-03；另有既有 R1、R2、R3、R4、R5、R6、R8、R10、R11、R15。`runtimeController.ts:331-336` 与 `domain.ts:213` 是本轮直接证据。已验证干净：desktop voice host 2/2、语音协议/取消相关多数单测、53 条 E2E 通过。
- **M11**：有隐患。TTS adapter/native/podcast 路径有自动化覆盖；真实自动播放、账号、模型能力按要求未执行。既有 R10 配置解析不一致需修复后再冻结。

### M12–M18
- **M12**：健康（自动化范围）；OCR service/job/desktop/native 测试通过，真机权限与磁盘满未验证。
- **M13**：健康；搜索单测和 E2E 通过。
- **M14**：健康；统计与热力图单测/E2E 通过。
- **M15**：有隐患；恢复/审查测试超时，且全量备份边界复杂，不能据此宣称事务失败安全。
- **M16**：有隐患；本轮未执行 `npm run test:firebase`，云锁、规则、配额无法升级为确认通过。
- **M17**：健康（自动化范围）；媒体/录音/图片单测通过，设备生命周期列入人工验证。
- **M18**：健康（自动化范围）；设置、导航、Usage Guide 测试/E2E 通过。

### M19–M23
- **M19**：健康（自动化范围）；视觉 E2E 通过，未把 CSS 选择器清理偏好列为 Bug。
- **M20**：有隐患；preview E2E 通过，但需要单独确认所有 query 在 native shell/production bundle 不可达；本轮未把静态存在直接判 FAKE。
- **M21**：有隐患；Android 全量 plugin 方法×调用方表未完成，不能宣称清理完成。
- **M22**：健康（已测路径）；host socket 2/2，Electron 完整 IPC 对账仍为未完成项。
- **M23**：有问题；TypeScript/build/diff check 通过，但基线测试数量偏差且 3 个失败。

## 6. 接口真实性矩阵

| 接口域 | 分类 | 代码证据/结论 |
|---|---|---|
| AI provider / Coach gateways | CONDITIONAL | 有实现、mock/UI 触达；凭据和配置决定可用性。 |
| TTS providers/native/podcast | CONDITIONAL | 平台/凭据守卫存在；真实 provider 未验收。 |
| voice provider transports | CONDITIONAL | mock/协议测试与生产构造存在；部分 candidate 不应当作已验收。 |
| Desktop voice IPC | REAL（已测路径） | `npm run test:voice-host` 2/2。 |
| Android plugins | CONDITIONAL | 宿主实现存在，但本轮未完成全量方法对照。 |
| storage/sync adapters | REAL/CONDITIONAL | 本地路径有测试；Firebase 真实配置不在本轮。 |
| OCR Web/Desktop/Android | CONDITIONAL | 自动化实现可构造；权限/设备路径未验收。 |
| `?preview=*` | CONDITIONAL | E2E 证明已触达的 preview 可用；native/production 隔离未全量证明。 |
| 已声明未实现能力 | 不分类为 FAKE | SiliconFlow realtime、barge-in、iOS 等按降噪清单排除。 |

本轮未能以独立调用计数充分证明 DEAD/FAKE/REGRESSED 的完整全集；不能为了满足格式臆造条目。既有审计中的 R1/R2/R3/R10/R11 属于 REGRESSED/当前接线不完整，而非凭空新增。

## 7. 死代码与废弃资产清单

| 条目 | 类型 | 位置 | 引用计数 | 删除建议 | 风险 |
|---|---|---|---|---|---|
| `dist-verify-audit/` | 审计产物 | 工作区根目录 | 非源码产物 | 清理未跟踪产物 | 低 |
| preview prototypes | 调试资产 | `src/preview/*` | 有 E2E/显式 query 引用 | 不删除；先确认 native/production 隔离 | 高 |
| 旧 TTS/backup 分支 | 潜在重复 | `src/services/*`、`src/lib/*` | 本轮未完成全量引用计数 | 不直接删除 | 高 |
| 未使用依赖/Java 方法 | 待核 | package/android | 未完成全量计数 | 第二轮专门清理 | 中 |

## 8. 回归对账（git 驱动）

已核对提交存在性与当前 HEAD 历史；既有审计已对 `b20aa7f`、`829f98d`、`a1fd43e`、`f92b2dd`、`306e9bb`、`4280bb5`、`9cd502f`、`de4e716`、`eb198aa`、`2f52782` 提供差异驱动结论。本轮新增确认仅 F-01；R1/R2/R3/R10/R11 与既有报告重复并标记“确认仍存在”。完整的 localStorage/idb key 全仓库导出及逐提交 diff 表未在本轮完成，列入局限。

## 9. 文档 vs 代码对账表

| 文档声明 | 位置 | 代码事实 | 一致? | 处置建议 |
|---|---|---|---|---|
| 普通验证排除 live 测试 | `AGENTS.md` | 本轮未执行 live；命令显式 exclude | 是 | 保持 |
| E2E 54，53 pass/1 skip | `AGENTS.md` | 本轮实际 53 pass/1 skip | 是 | 保持 |
| Vitest 163/1021 | `AGENTS.md` | 实际 162/1011，且 3 failures | 否 | 冻结前解释数字并修复失败 |
| 语音本机临时表不进入备份/同步 | `AGENTS.md`、storage restore | `storageAdapter.ts:2083-2085,2126-2127` 明确作为恢复清理/保留策略处理；本轮未发现导出泄漏 | 暂时是 | 完成所有导出入口穷举测试 |
| 语音自动半双工已验证 | 冻结文档 | 本轮未调用真实 provider/真机 | 无法静态验证 | 维持人工门禁 |
| 当前确认回答进入 LLM | 既有审计 R1 | 既有隔离复现证明未进入 | 否 | 修复并回归 |

## 10. 跨切面不变量反例搜索记录

| 不变量 | 结果 | 证据 |
|---|---|---|
| React 错误经 `uiError.ts` | 未发现本轮反例 | `uiErrorSurface.test.ts` 通过；全仓库裸 `error.message` 深扫未在本轮完整完成。 |
| `RecordBlock.contentHtml` 唯一真相 | 未发现本轮反例 | Coach/编辑器相关测试通过。 |
| AI/cache 非真相源 | 未发现本轮反例 | formal round-trip 测试通过。 |
| FSRS 不被 block/voice 静默改写 | 未发现本轮反例 | Coach Stage 9 E2E 通过；真机 voice 未测。 |
| review events append-only | 未完成全量反例搜索 | 云同步内部完整删除路径未本轮穷举。 |
| annotation drafts 不记 cloud mutation | 未发现本轮反例 | storage/cloud tests 通过；需要全仓库直接写表审计。 |
| voice/annotation 不进入导出 | 未发现本轮反例 | restore 处理显式列出本机表；导出四路径尚需逐入口证明。 |
| voice 不写 FSRS/不自动评分 | 未发现本轮反例 | voice/Coach 测试通过。 |
| 普通验证排除 live | 已确认 | 命令参数与测试结果。 |
| 密钥不出现在导出/日志 | 未发现本轮反例 | credentials tests 通过；真实崩溃报告/设备日志不可静态穷尽。 |

## 11. 高风险无测试清单

- `runtimeController.pause()` 的所有状态组合与 cleanup 竞态（本轮 F-01）。
- restore staging 失败、事务等待、磁盘满和中断后的真实临时文件清理。
- Android 11 plugins 的全量参数/返回值对照与权限拒绝。
- Web/Desktop/Android 的自动播放、麦克风互斥、系统返回键。
- cloud sync no-op 锁绕过、大计划确认阈值与 Firebase Emulator 全量验收。
- Markdown 嵌套结构无损往返的最小样例集合。

## 12. 无法静态验证清单

- 真实 Android 键盘/IME、系统返回、图片手势、麦克风/音频焦点与自动播放。
- 真实阿里云/DeepSeek/Fish/Doubao/SiliconFlow/PaddleOCR 账号、配额、延迟、模型能力。
- Firebase 真实账号配额与发布环境规则；本轮未运行真实项目。
- Windows 磁盘满、文件锁、长路径/中文路径、ZIP 中断残留。
- 多标签页真实同时编辑、跨进程 Electron/Android 生命周期。

## 13. 已验证干净清单

- `npx tsc -b` 通过。
- Desktop voice host 本地 WebSocket 2/2 通过。
- Playwright 54 项中 53 通过、1 项 Android 不适用跳过。
- 生产 build 与 `git diff --check` 通过。
- 已有测试覆盖的 Review Coach 原子提交、批注组件、OCR service、搜索、统计、设置、Usage Guide 未发现本轮新反例。
- H1/H2 的导出边界本轮未发现直接泄漏证据，但因未完成所有序列化入口穷举，结论是“未发现”，不是“证明完毕”。

## 14. 建议的收口行动顺序

1. 高收益/低波及：修复 F-01 状态机与 cleanup 回归测试。
2. 高收益/中波及：修复 R1/R2/R3/R4/R10/R11，并让 R11 无网络测试恢复通过。
3. 中收益/中波及：定位两个 storageAdapter 超时，先证明是环境还是事务实现问题。
4. 高收益/高波及：完成四类导出、云同步、本机临时表的字段级穷举测试。
5. 中收益/高波及：完成 Android plugin × TS 调用方与 Electron IPC 三方对照。
6. 低收益/中波及：在上述通过后再做 DEAD/FAKE/依赖/CSS/旧资产清理。

### 审计局限

本轮在严格只读与时间/上下文限制下，没有执行 `npm run test:firebase`，没有进行真实设备/真实账号验证，也没有完成 70 个语音文件、30 个 Coach 文件、全部 Android 方法、全部 localStorage key 和全部导出调用点的逐条引用计数。因此本报告不声称穷尽所有潜伏 Bug；明确确认的当前阻断项是 F-01、F-02、F-03，其他既有问题按证据等级和去重标记处理。

## 深度审计增量记录

本节记录在初版报告之后继续完成的逐路径复核，结论仍然只基于当前工作区代码；它不改变前述“未修改产品代码”的边界。

### D-01：语音视图清理会把 idle 状态送入非法 PAUSE（确认，P1）

- 位置：`src/features/voiceRecall/runtimeController.ts:331-336`、`src/features/voiceRecall/runtimeController.ts:352`、`src/features/voiceRecall/domain.ts:91-100`、`src/features/voiceRecall/auditRegression.test.tsx:169`。
- 触发路径：创建或恢复控制器后仍为 `idle`，组件卸载或视图切换调用 `disposeView()`；`disposeView()` 无条件委托 `pause()`，而 `pause()` 只在“无 state / paused / ended”时返回，随后无条件 dispatch `PAUSE`。
- 代码证据：状态机的 `PAUSE` 分支不接受 `idle`；默认状态明确为 `idle`。完整 Vitest 输出同时记录了未处理的 `VoiceRecallTransitionError: Invalid voice recall transition: idle -> PAUSE`。
- 与既有审计关系：本轮确认仍存在；与早期报告中“生命周期/暂停清理”类问题合并，不另拆同根因条目。

### D-02：当前自然对话代码已包含确认文本，旧 R1 不能直接照搬为当前新回归

- 位置：`src/features/voiceRecall/VoiceRecallWorkspace.tsx:650-656`。
- 代码事实：`buildVoiceTeacherTurn` 接收 `confirmedText`，随后将 `turnBuild.messages` 传入 `runtime.respondTurn`；当前源代码路径不是旧版本中“只构造材料、不放入当前用户回答”的形态。
- 结论：旧报告 R1 作为历史重复项保留，但本轮不把它升级为“HEAD 已确认的新 Bug”；仍需以对应 R1 测试在完整环境中的最终结果为准。

### D-03：ASR 多 final 的累计语义已有显式分支，静态上不支持“必然只保留最后一句”

- 位置：`src/features/voiceRecall/pipeline.ts:61-63`。
- 代码事实：`event.cumulative === true` 时替换 transcript；否则追加当前 final 文本。`auditRegression.test.tsx` 中的 R2 测试覆盖两个非 cumulative final 并要求两句都存在。
- 结论：当前代码对协议标志的处理为 CONDITIONAL；若具体 transport 错误地把“增量 final”标为 cumulative，仍属于协议适配器问题，不能仅凭 pipeline 代码确认。

### D-04：恢复锁覆盖范围存在接口级证据不足，不判定为已确认 Bug

- 位置：`src/services/restoreLockService.ts:32-42`、`src/services/importRestoreService.ts:39-54`、`src/services/nativeRepositoryBackupService.ts:476-503`、`src/services/nativeBackupAdapter.ts:258-286`、`src/services/streamingBackupService.ts:188-232`。
- 代码事实：通用导入服务和原生仓库恢复明确使用 `withRestoreLock`；底层 `nativeBackupAdapter.importAndRestoreSnapshot` 的流式分支与 fallback 分支本身不加锁，但正常 UI 入口由上层导入服务包裹。独立调用底层适配器时可绕过模块级锁，但当前未证明该导出函数被 UI 直接调用。
- 结论：证据不足，列入人工/调用图验证，不作为 P1/P2。

### D-05：时间语义存在需验证的跨时区差异，但未确认用户可见错误

- 位置：`src/lib/learningStats.ts:30-31` 使用 `T00:00:00Z`；`src/lib/reviewScheduler.ts:47` 使用本地 `T00:00:00`；`src/lib/date.ts:7-18` 的日历函数按本地时区工作。
- 代码事实：统计窗口把 ISO 日期按 UTC 毫秒比较，复习排程和“今天”按本地日历比较。由于 masteryTrend 本身是 date-only 字段，当前差异未必改变结果；需要在 UTC 日期切换点用目标时区构造数据才能确认。
- 结论：H45 证据不足，不把静态差异误报为 Bug。

### D-06：宿主桥通道名三方静态一致，帧语义仍需运行时验证

- 位置：`desktop/preload.cjs:47-54`、`desktop/main.cjs:562-603`、`src/features/voiceRecall/desktopVoiceSocket.ts` 及 `voiceAsrSocket.cjs`。
- 代码事实：`open/send/close/onEvent` 的 `study-journal:voice-asr-*` 名称在 preload 与 main handler 中对应；发送入口允许二进制数据，事件通过 `voice-asr-event` 回推。
- 结论：通道命名 H10 静态干净；Electron Buffer/Uint8Array、Android WebSocket binary/text 的逐帧转换仍列为无法静态完全验证项，不能据名称一致推导协议完全正确。

### D-07：接口真实性矩阵补充

| 接口 | 分类 | 证据与结论 |
|---|---|---|
| `voice-mock-cn@1` | REAL/CONDITIONAL | Mock ASR/LLM/TTS 有真实确定性实现；仅在测试/预览或受控配置下使用。 |
| `voice-default-cn@2` | CONDITIONAL | `providerProfiles.ts` 有默认组合与平台守卫；candidate 状态不等于真实账号能力已验收。 |
| `siliconFlowBatchAsr` | CONDITIONAL | 明确标记 `realtime: false`、`verified: false`；不应被文案当作实时 ASR。 |
| `?preview=stage3..stage7`, `coach`, `ui-v2` | REAL（隔离预览） | 各入口有 localhost 与非 native/非 desktop 守卫；不属于生产功能入口。 |
| `?preview=voice-recall` | REAL（Mock 原型） | `VoiceRecallPrototypeApp.tsx` 明确使用 Mock；不是生产 provider。 |
| `?preview=voice-recall-production/policy` | CONDITIONAL（本地预览） | `App.tsx:110-118` 限制 localhost、非 native、非 desktop；不得从此推断生产链路。 |
| Android plugins | CONDITIONAL | `MainActivity.java:11-21` 注册 11 个插件；Java `@PluginMethod` 与 TS 调用的大部分名称可对应，完整参数/返回值矩阵仍需设备端逐项验收。 |
| Electron IPC | REAL/CONDITIONAL | preload 与 main handler 名称对应；依赖 Desktop host、文件仓库和相应配置。 |

### D-08：跨切面不变量复核结果

- H1/H2：云同步模型、普通快照、流式快照和批注 repository 的当前静态路径均未发现把本机语音/批注表序列化；结论“未发现反例”，不是形式化穷尽证明。
- H3/H4：状态字段分离；Android `VoiceCaptureController` 与 `AudioRecordingController` 互相检查对方活动状态，静态支持互斥；权限拒绝与快速切换仍需真机。
- H5/H6：取消树、代次和 TTS 任务的 `AbortSignal` 连接路径存在；`runtimeController.ts:42-46` 在取消时递增 epoch 并停止捕获/播放；未发现当前源码中取消后必然提交正式 turn 的新反例。
- H7/H8/H9：生产 pipeline 在 `productionPipeline.ts:143` 对 LLM max tokens 做 clamp；teacher prompt 的材料截断按段/Unicode code point 处理；content boundary 已被 prompt 构造引用。真实 provider 的响应帧与多字节网络边界仍不能用本地静态检查替代。
- H13/H14/H15/H16：云事件删除搜索只命中 recovery snapshot 清理；云同步 no-op 与恢复清理策略有专门测试；隐私清理器在导出快照前递归剥离私有字段。未发现新的直接反例。
- H19-H25：正式 Coach repository 的直接写入扫描未发现生产路径绕过；迁移测试覆盖 schema 11/16 到 21 的主要重建；中断重试和跨标签页撤销仍是高风险无测试区。

### D-09：本轮最终局限

无法静态确认的项目仍包括真实 provider 额度/协议、Android 权限与音频焦点、Windows 文件锁/磁盘满/中文长路径、真实多标签页并发、Electron 与 Android 的二进制帧在真实宿主中的转换，以及所有 CSS 选择器的视觉有效性。上述项目不得在报告中被表述为“已确认 Bug”。
