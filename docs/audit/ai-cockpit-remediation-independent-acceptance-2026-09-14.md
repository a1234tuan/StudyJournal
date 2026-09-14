# AI 驾驶舱整改独立验收审计

> 审计日期：2026-09-14（Asia/Shanghai）  
> 审计范围：当前工作区 `D:\StudyJournal-Source` 的 A-2/A-3、B 批、C 批及其回归边界  
> 依据：`AGENTS.md`、`docs/ai-cockpit-remediation-plan-2026-09-14.md`、实现代码、测试与构建产物  
> 约束：只读审计；未修改产品代码；未提交；未调用真实 Provider、API Key、Firebase 线上服务或 live 测试。

## 结论

**有条件允许进入收口。**

本地确定性验收显示整改方案已正确落地：核心 Review Coach 定向测试 23 文件 / 145 测试通过；确定性全量 Vitest 175 文件 / 1108 测试通过；`npx tsc -b`、生产 build、host 协议测试、Firebase Emulator 均通过。E2E 首轮为 52 通过、1 跳过、1 失败；失败用例单独重跑通过，暂判为测试不稳定性而非产品逻辑失败，仍建议在收口前复跑全套并保留记录。

本结论不是发布签署：按 `AGENTS.md`，真实 Provider 受控验收、真实账户 Firebase quota、物理 Android 键盘/IME、真实设备音频等仍是独立 release gate，本次明确未执行。

## 逐项审计

### 1. A-2/A-3 与 D-1(b)

- **通过，高置信度。** `src/features/reviewCoach/replay.ts:404-418` 同时计算自评字段、客观作答字段和延迟验证客观字段；`src/features/reviewCoach/ReviewCoachWorkbench.tsx:327-339` 页面只显示“用户自评保持率”，没有把客观正确率渲染成用户掌握率。
- **通过，高置信度。** `src/features/reviewCoach/replay.ts:35-39` 的客观正确率分母排除 `unreliable`；测试覆盖 `unreliable` 不进入分母以及 retention 与 verification objective rate 不混用。
- **通过，高置信度。** `src/features/reviewCoach/replay.ts:319-323` 将排序后的 turn-level `promptVersion` 集合纳入分组 key，同时纳入实际题型和提示等级；`src/features/reviewCoach/replay.strategyKey.test.ts` 覆盖新旧 prompt regime 不合并、输入顺序无关和跳题处理。
- **注意事项，P2，置信度高，非阻断。** A-3 使分组更细，工作台仍按字典序取前 3 组，可能出现样本较少或空组先展示；整改记录已声明该后果，但它会降低统计可读性。

### 2. B/C 批

- **B-1/B-2 通过，高置信度。** 投影状态使用显式优先级；`planSession` 只接收客观证据、按 `objectiveEvidenceStatus` 和主块难度范围过滤、限制数量并进入 fingerprint。未发现将 retention 或自评字段回流为客观策略依据的证据。
- **B-3 通过，高置信度。** `ReviewCoachWorkbench.tsx:288-323` 只对衰退块展示“需要重新规划”，要求用户输入说明后调用回流；没有系统代写正式反馈。对应 `replay.replan.test.ts` 与工作台测试通过。
- **C-1/C-2 通过，高置信度。** 结构化调用经 `systemPrompt` 使用 JSON-only 角色提示词；题型和 answer mode 从 parser 自身枚举生成，避免提示词枚举漂移。`src/services/aiClientService.ts:70-70,233-235,580-582` 保留默认会话 prompt，但 Review Coach 调用显式覆盖它。
- **C-3 通过，高置信度。** `src/features/reviewCoach/orchestrator.ts:851-863` 对 `unreliable` 写入 `unreliable:` 原因前缀且不写策略决策；跳题写入明确的 `skipped` 事件。既有 `verificationPolicy.ts` 将 unreliable 作为 partial 处理仅影响调度，属于方案和基线已登记的已知不一致，不属于本轮遗漏。
- **C-4 通过，高置信度。** `questionIntegrity.ts` 在本地检查题干/hints 是否泄露判据；`aiSchemas.ts` 增加 `answer-leakage` 严重问题；连续命中走有限重出并最终可读失败。测试覆盖正常、边界、重试和失败路径。
- **C-5 通过，高置信度。** `orchestrator.ts:175-223` 在关闭跨块支持时分别限制 supporting block、feedback、interpretation 和 evidence 到主块；打开支持时才允许批次输入集合。对应测试覆盖拒绝与允许路径。

### 3. 页面、UI 与可操作流程

- **通过，高置信度。** Review 页面通过 `Review -> Learning Coach` 入口挂载工作台；页面测试和 E2E 覆盖进入、返回、任务切换、分析恢复、立即作答、延迟验证、窄屏布局。
- **通过，高置信度。** 工作台对分析确认/取消、暂停批次继续、任务切换确认、延期确认、衰退重新规划均使用 `busyAction` 防重复点击，并通过 `formatActionableError` 展示用户可操作错误。
- **通过，高置信度。** `ReviewCoachWorkbench.test.tsx` 覆盖空候选、确认、分析成功/失败、重新规划等可见状态；`ReviewPage`、`AdaptiveReviewPage` 和 Stage 9 E2E 覆盖返回与恢复。
- **通过但有警告，P3，置信度高。** 全量 Vitest 和定向 Vitest 出现 React `act(...)` 未包裹更新警告，涉及 `ReviewAnnotationSurface` 和 `AdaptiveReviewPage` 测试。测试仍通过，未观察到用户可见错误；建议后续清理以避免异步回归被警告淹没。

### 4. 状态流转与异步竞态

- **通过，高置信度。** `src/features/reviewCoach/stateMachines.ts:34-114` 为解释、队列、批次、任务、题目和延迟验证定义合法迁移；非法迁移抛出 `ReviewCoachTransitionError`。
- **通过，高置信度。** `orchestrator.test.ts` 覆盖 provider/格式失败重试、超时后成功、失败结果落库；`stage6Orchestrator.test.ts` 覆盖跳过、unreliable、无效题、完成前置条件和答案泄漏重试；repository 使用 idempotency key 防重复写入。
- **未发现 P0/P1 阻断，高置信度。** 取消、失败、完成、放弃、延期、重复点击和恢复路径均有状态机或 UI busy guard 约束；未发现终态重新进入运行态的实现证据。

### 5. 用户文案与敏感信息

- **通过，高置信度。** 工作台文案明确使用“用户自评保持率”，没有把客观正确率说成用户掌握率；角色提示词明确禁止宣告用户已掌握。
- **通过，高置信度。** React 错误表面使用 `formatActionableError` / `formatUiError`；未发现本轮新增页面直接渲染原始 `error.message` 的路径。Provider、model、promptVersion 只作为诊断/上下文显示，未发现 API key 进入 UI、提示词持久化或导出边界。
- **通过，高置信度。** `aiClientService` 的 `systemPrompt` 只用于内存中的请求消息构造；本轮未执行任何真实 Provider 调用。

### 6. 旧数据、投影、同步、备份、转移与 FSRS

- **通过，高置信度。** `REVIEW_COACH_REPLAY_VERSION` 已升级为 `review-coach-replay-v3`，会触发一次可重建投影；新增 replay tests 覆盖顺序稳定、旧事实重放和重新规划。
- **通过，高置信度。** `formalRoundTrip.test.ts`、cloud sync model tests、record-transfer decision-block test、backup/restore tests、FSRS review tests 均通过；Stage 9 E2E 明确验证延迟验证不改记录 FSRS。
- **通过，高置信度。** Firebase Emulator 4/4 通过，覆盖用户 namespace、增量发布、真正 no-op replay、中断恢复和 clock skew；本次未触碰线上 Firebase。
- **未发现同步契约扩展，高置信度。** 本轮新增效果字段属于本地可重建 projection/内部回流，不改变 schema 或云同步实体；仍须遵守基线中的跨设备与真实 quota release gates。

## 验证命令与结果

| 命令 | 结果 |
|---|---|
| `npx vitest run src/features/reviewCoach --exclude "**/*.live.test.ts"` | 23 文件 / 145 测试通过 |
| `npx tsc -b` | 通过，0 错误 |
| `git diff --check` | 通过；仅报告现有工作区 LF/CRLF 警告 |
| `npm run test -- --exclude "**/*.live.test.ts"` | 175 文件 / 1108 测试通过 |
| `npm run test:voice-host` | 2/2 通过 |
| `npm run test:firebase` | 4/4 通过；仅 Emulator，无线上服务 |
| `npm run test:e2e` | 首轮 52 通过、1 跳过、1 失败；失败用例单独重跑 1/1 通过 |
| `npx playwright test e2e/ui-v2-stage4-review.spec.ts:9 --project=desktop` | 1/1 通过 |
| `npm run build` | 通过；仅既有大 chunk 与动态/静态 import 警告 |

## 问题清单

### A-01：桌面视觉层级 E2E 首轮不稳定

- **文件:行号：** `e2e/ui-v2-stage4-review.spec.ts:35-56`
- **触发路径：** 执行完整 `npm run test:e2e` 的桌面 Stage 4 首测。
- **证据：** 首轮断言 `titleSize > excerptSize` 收到 `NaN > NaN`；随后单独执行同一测试 `npx playwright test e2e/ui-v2-stage4-review.spec.ts:9 --project=desktop` 通过。
- **严重度：** P3（验收稳定性问题，不是已证实的产品缺陷）。
- **置信度：** 高。
- **阻断收口：** 否；但应在收口前复跑全套 E2E，若再次出现需修复测试取数或等待条件。

### A-02：测试存在 `act(...)` 警告

- **文件:行号：** `src/features/reviewCoach/AdaptiveReviewPage.test.tsx`；`src/pages/ReviewPage.test.tsx` 触发 `ReviewAnnotationSurface` 更新。
- **触发路径：** 执行确定性 Vitest。
- **证据：** 测试过程输出 React “An update ... was not wrapped in act(...)”；所有相关测试仍通过。
- **严重度：** P3。
- **置信度：** 高。
- **阻断收口：** 否；建议后续补齐异步断言，避免真实 UI 回归被警告隐藏。

### A-03：真实 Provider / 物理设备门槛未执行

- **文件:行号：** `docs/ai-cockpit-remediation-plan-2026-09-14.md` §9.7；`AGENTS.md` 的 Verification 与 Current Baseline。
- **触发路径：** 本次按用户要求排除 live、真实 API key、线上 Firebase 和物理设备。
- **证据：** `src/features/reviewCoach/aiAcceptance.live.test.ts` 未执行；本地通过不能证明真实模型遵守 JSON schema、不会误杀答案泄漏检查或判题质量满足受控验收。
- **严重度：** P1（发布门槛，非本地实现缺陷）。
- **置信度：** 高。
- **阻断收口：** 阻断“发布签署”，不阻断本地整改收口；必须由明确授权的后续验收关闭。

## 收口建议

1. 保持本报告结论为“有条件允许进入收口”，不要写成 release signed-off。
2. 复跑完整 E2E；若 A-01 再现，修复该断言的 computed-style 取值/等待条件后再验收。
3. 单独安排受控真实 Provider 验收，记录 schema 成功率、重试、`unreliable` 占比、答案泄漏误杀与 token 用量；不得把真实 key 写入仓库、日志或报告。
4. 后续清理 A-02 的 `act(...)` 警告，并复核 A-3 细分分组后工作台前 3 组的产品可读性。
