# 知识库样式 v2 生产规则部署记录

日期：2026-10-11；时区：Asia/Shanghai。

## 授权与范围

用户在获知需部署生产规则并统一升级客户端后明确回复“同意”。本轮只部署 study-journal-408-9f31 默认数据库的 Firestore 规则；不部署 Storage、Functions、Hosting、索引或安装包，不读写用户日志/知识内容，不修改账号或清空数据。

## 发布前核对

- 生产旧规则正文与仓库 HEAD 的 firestore.rules 一致，没有发现未纳入本次改动的远端变更。
- 原 ruleset：projects/study-journal-408-9f31/rulesets/6bff2f4d-60ec-415f-b04b-63dc27b0f747。
- 本次仅三处规则调整：提交允许 v1/v2 且与 head 同版；行版本与 commit 一致；head 允许升级但禁止降级。
- 备份生产 release、规则正文、候选与候选 SHA256 至 output/knowledge-rules-deployment-2026-10-11/。不保存凭据或用户内容。
- 发布前 npm run test:firebase 2 文件 / 8 项全部通过，含 v1→v2、旧版降级写入拒绝、原子完整提交和普通日志隔离。负向用例中的 permission-denied 是预期。
- 发布前二次检查远端 release 及本地候选未变；一次只读网络请求失败后重试成功，没有跳过核对。

## 部署与读回

命令：node node_modules/firebase-tools/lib/bin/firebase.js deploy --only firestore:rules --project study-journal-408-9f31 --non-interactive。

CLI 服务端编译及部署成功。

- 生效时间：2026-10-11T07:51:56.095512Z，即北京时间 2026-10-11 15:51:56。
- 新 ruleset：projects/study-journal-408-9f31/rulesets/696d8a0a-8791-49d3-903f-19c821ba64c1。
- 读回时间：2026-10-11T07:53:00.665Z，即北京时间 15:53:00。
- 实际 release 已引用新 ruleset；读回规则与本地已验证候选逐字一致。
- SHA256：b39969349fba75286dd8917ffe011ccd81aa464ea0f7c73ad8741545a825d124。
- 其他规则 release（Storage）的 ruleset 与更新时间均未变。

证据目录包含 before.json、before.firestore.rules、candidate.json、candidate.firestore.rules、emulator.log、deploy.log、after.json、after.firestore.rules。

## 当前状态与剩余验收

生产云规则已支持新版导图样式提交，原先“规则尚未部署”的阻塞已解除。仅部署规则不会主动升级用户知识库，也不会触发上传；无样式的 v1 库继续兼容，实际 v2 提交由支持样式的新客户端发起。

仍须电脑和手机都使用支持该格式的新版本。未生成或安装 APK/EXE，未代替用户上传真实内容，不能宣称已经观察到真实账号两端一致。后续验证电脑修改样式→同步→手机接收，以及手机修改→同步→电脑接收。

旧客户端不能继续访问已升级为 v2 的知识库，须升级而非清数据。规则部署不能替代客户端更新。

## 回退边界

旧规则已备份，但升级库产生 v2 提交之后，直接回退 v1 规则会阻断这些库后续同步，因此不应无条件回退。若需生产回退，应另行确认并先核对实际客户端/库版本；不得删除 head、registry、revision 或用户内容。本次没有做数据迁移或数据回退。
