# 二次审计历史证据

本目录记录 2026-09-09 对 8fc0692 基线的审查，不代表修复后的当前状态。

- REPORT.md、probes.test.tsx、vitest.config.ts、validation.txt 保留原始发现与 11 个失败探针；不要修改旧断言来制造历史通过记录。
- 正式回归已迁入 src/features/voiceRecall/auditRegression.test.tsx，并扩展至 15 个用例。普通测试使用仓库根配置，不执行此处历史探针。
- implementation-*.txt 是本机执行日志，不进入 Git；当前结果与复现命令见 docs/second-audit-repair-acceptance.md。
- 安装包及冻结范围见 docs/release-freeze-2026-09-09.md。
