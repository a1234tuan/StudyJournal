# docs/archive — 历史与已失效文档

本目录存放**不再作为当前基线**的文档。它们仍然可读、可用于追溯决策来由，但**不要再据以实现**。

## 归档判据（满足其一即可）

1. **已被取代**：文档自述或被后续文档明确声明被取代（早期设计稿、旧实施方案）。
2. **基线已过时**：它针对的分支、schema 版本或结论已与当前事实不符。
3. **一次性交付记录**：验收、审计、交接、冻结包记录等，结论已落到 `AGENTS.md` 或源码，本身不再被引用为当前基线。

## 本目录**不**收什么

产品的**当前有效基线**一律留在 `docs/`：

- `新的方案.md` — 产品边界（冻结条款在 §19）
- `studyjournal-final-freeze-2026-09-15.md` + `studyjournal-scope-unfreeze-2026-09-16.md` / `-2026-09-17.md` — 冻结与解冻的治理记录
- `voice-recall-freeze-2026-09-11.md`、`voice-call-natural-conversation-freeze-2026-09-14.md`、`voice-recall-privacy.md`、`voice-recall-provider-configuration.md`、`voice-recall-release-checklist.md`、`doubao-voice-provider-compatibility.md`、`realtime-voice-recall-implementation.md`
- `daily-plan-intent-2026-09-16.md`、`daily-plan-final-plan-2026-09-16.md`
- `second-audit-repair-acceptance.md`、`ai-cockpit-data-semantics-pre-stage-2026-09-14.md`
- `knowledge-base-evolution-blueprint.md`（规划草案，尚未决策）

`docs/audit/` 是审计证据的独立位置，按当时事实原样保留，**不随文档迁移改名**；`.workbuddy/memory/` 是 append-only 的工作日志，同样保持原样（其中出现旧路径属正常）。

## 清单（2026-09-17 归档，20 份）

| 类别 | 文件 |
| --- | --- |
| 今日计划早期稿（被 §13 声明取代） | `daily-plan-feature-design.md`、`daily-plan-feature-design-v2.md`、`daily-plan-detailed-design-2026-09-16.md`、`daily-plan-implementation-plan-v3.md` |
| 已完成的一次性交付 | `daily-plan-ui-ux-review-2026-09-16.md`、`ai-cockpit-remediation-plan-2026-09-14.md`、`ai-cockpit-remediation-acceptance-2026-09-14.md`、`ai-chat-history-date-audit-2026-09-14.md`、`handoff-f17-coach-role-system-prompt-2026-09-14.md`、`ui-motion-continuity-audit.md`、`voice-recall-ui-audit-2026-09-16.md` |
| 基线已过时 | `UI-UX审查与重构方案.md`（审查基线 `feature/review-effect-coach-v2` 已不在本仓库）、`release-freeze-2026-09-09.md`（被 09-15 最终冻结取代）、`review-annotation-and-rating-undo-plan.md`（自述停在 schema 21，现为 24） |
| 已暂停 | `exocortex-ai-cockpit-migration-and-enhancement-plan-2026-09-15.md` |
| 仓库根的历史报告 | `STUDYJOURNAL_AUDIT_REPORT.md`、`STUDYJOURNAL_FIX_PLAN.md`、`STUDYJOURNAL_FULL_AUDIT_PROMPT.md`、`STUDYJOURNAL_VOICE_CONTEXT_TRUNCATION_FIX_PLAN.md`、`STUDYJOURNAL_VOICE_RECALL_REPAIR_PLAN.md` |

## 约定

- **活文档引用归档件时，路径必须写全** `docs/archive/<name>.md`。归档当日已把活文档里的引用全部改过来（`AGENTS.md`、`CHANGELOG.md`、`docs/` 下各活文档）。
- 归档件之间的相对引用无需改动——它们同处本目录。
- 归档用 `git mv`，历史可追溯。

## 恢复某份文档

```bash
git mv docs/archive/<name>.md docs/<name>.md
```

恢复后**必须**把引用改回 `docs/<name>.md`（`git grep` 一下该文件名即可找全），否则会留下指向旧位置的链接。
