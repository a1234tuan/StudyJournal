# 知识库生产 Firestore 规则部署记录

日期：2026-09-25；时区：Asia/Shanghai。

## 授权与范围

用户明确授权“执行这项生产规则部署”。本次仅发布 study-journal-408-9f31 项目默认数据库的 Firestore 规则。不部署 Storage、Functions、Hosting 或索引，不读写用户的实际日志/知识内容，不执行安装或清数据。

## 根因与备份

部署前生产规则只匹配 users/{userId}/…，完全没有 knowledgeUsers/{userId}/…；最后更新于2026-08-05。客户端新路径因此无法获得允许，与已经登录及普通日志同步正常并不矛盾。

原 release：projects/study-journal-408-9f31/releases/cloud.firestore。

原 ruleset：projects/study-journal-408-9f31/rulesets/5355a73f-c68d-4c66-b64c-71456dd29433。

备份目录：output/knowledge-rules-deployment-2026-09-25/，包含 before.json、before.firestore.rules、candidate.firestore.rules 和 candidate.json。未保存用户内容或登录凭据。

## 门禁及发布

- 部署前重新运行 npm run test:firebase：隔离 demo 项目2文件、7测试全部通过。覆盖真实知识 transport 正向访问，以及匿名/其他 UID 拒绝、原子提交和普通日志规则回归。日志中的拒绝来自负向用例，不是部署失败。
- 普通日志原 owner 规则保持不变；知识规则按 request.auth.uid 限定所有者，未增加全库开放权限。
- 命令：node node_modules/firebase-tools/lib/bin/firebase.js deploy --only firestore:rules --project study-journal-408-9f31 --non-interactive。
- CLI 服务端编译通过，部署成功。发布 updateTime 为2026-09-25T08:15:20.629017Z，即北京时间16:15:20。
- 新 ruleset：projects/study-journal-408-9f31/rulesets/6bff2f4d-60ec-415f-b04b-63dc27b0f747。

## 回读核验

北京时间16:16:04回读生产 release 和规则正文，确认新版本已经由默认 Firestore release 引用，正文与本地候选逐字一致，knowledgeUsers 匹配及 owner 限制均存在，其他已有规则 release 的 ruleset 和更新时间均未变化。

规则 SHA256：2aeee21e860ec8c05a1ed7fbab1766717c09814d420f9b14837b69969eeee5c8。

证据：同一目录的 emulator.log、deploy.log 和 after.json。代码及 firestore.rules 本身无新增改动。

## 验收与回退边界

生产规则部署已完成；真实客户端的知识库首传和手机拉取仍需用户验收。请在现有新客户端再次点击同步，必要时关闭重开应用后重试；不要求重新选库或复制。当前没有代替用户上传真实内容，也不声称已经观察到真实数据双端一致。

若发生规则回归，可以在另行授权后把该 Firestore release 指向备份的原 ruleset，或重新发布备份正文；不得删除 registry/head 或用户内容。旧规则会再次阻断知识同步，因此只用于受控回退，不作为数据回退方案。
