# 2026-09-09 代码与安装包候选冻结

## 范围与状态

以 8fc0692 为修复基线，保留原菜单、路由和编辑器修复，完成二次审计 R1–R15 的代码及正式回归。具体处理见 second-audit-repair-acceptance.md。此次冻结不等于正式发布签字：voice-default-cn@2 保持 candidate，未创建 GitHub Release，也未自动安装到现有用户设备。

业务代码/测试提交为 d3f4875b91b974697a22fd0ff587219ee76f8b59；文档/审计证据随后独立提交到 origin/main。用提交记录和以下包哈希识别冻结结果，不通过版本号推断。沿用 Android 0.2.3（versionCode 14）和 Windows 0.1.6，没有擅自变更两平台版本体系。旧版同版本安装包不能据版本号区分，安装升级与数据保留须单独验收。

## 本机构建产物

- Android：dev-dist/release/学习日志.apk，14,502,223 字节。
- Android SHA256：1C10D2B7B822ADBBA5A6B6A9B8FF9A1025CFB5A9294EF8383E0E1D133165A104。
- Windows x64 NSIS：release/desktop/学习日志 Setup 0.1.6.exe，105,189,236 字节。
- Windows SHA256：1B8601E102B1874C3ED614625E6907C56A3E40DCE8D2FFE97A55D98F8EEA0C63。

Android 使用仓库现有、已忽略的 android/keystore.properties 配置构建，无需读取或复制 NoteProject 签名文件。apksigner verify 通过；证书 SHA256 为 29ad726b79fe32adff22b362afc602f35112dc94a0a8da440f28fe6a4f1fd74e。只确认当前 APK 签名有效，未与用户设备已装版本进行证书或升级兼容核验。

Windows Get-AuthenticodeSignature 返回 NotSigned。electron-builder 的 signing 日志不代表存在有效发布者签名；本包是未签名候选安装程序，可能遇到系统信任提示。未自动安装或执行更新卸载流程。

安装包、签名私钥、凭据及机器执行日志不提交 Git。Desktop ASAR 已核对包含主进程与新语音桥接文件、排除所有 .test.* 文件，且 dist 内容与本次生产构建逐文件相同；对暂存源码及包内 JS 的常见私钥/API Key 模式扫描未发现匹配，这不是完整安全审计或凭据轮换证明。

## 复现与自动化

环境：Windows、Node.js 24、JDK 21、已配置的 Android SDK。先按 README 安装依赖，并在本机准备 Android 签名配置与所需应用配置，禁止将秘密提交到仓库。

```powershell
npm run test -- --exclude "**/*.live.test.ts"
npm run test:voice-host
npm run test:e2e
npm run test:firebase
npm run android:build:release
npm run desktop:build
git diff --check
```

本轮自动化：确定性 Vitest 142 文件 / 920 项，Playwright Desktop 与 Android-narrow 44 项，Firebase Emulator 4 项，Node 本地宿主帧协议 2 项，Android MockWebServer 协议 1 项通过。Android Debug 单测/编译及 Release assembleRelease、生产 Web 和 Windows NSIS 构建通过。Vite 大 chunk、Gradle 未来版本弃用、electron-builder 缺 author 等警告仍存在，不描述为零警告。

冻结复跑曾发现恢复测试在 attachProductionSession 的持久化完成前点击继续，产生一次失败；改为等待该异步操作及 React 更新，保留恢复暂停、不自动开麦和用户手动开麦的核心断言。修正后再执行全量测试，不将第一次失败计为通过。

原始审计与 11 个历史失败探针保留在 audit/second-review；当前正式回归使用 src 下的测试。构建原始日志位于本机 dev-dist，先前实现阶段日志位于 audit/second-review/implementation-*.txt；日志不作为可移植交付文件。

## 未关闭的门禁

- 账户所有者吊销并轮换已暴露凭据；本轮没有使用它们或运行付费服务。
- 单独批准请求数及费用额度后执行短请求预检，再分别进行桌面与 Android 真机至少五轮完整操作。
- 真机权限、后台、系统返回、录音/播放、输入法、安装升级和数据保留验证。
- 供应商请求终止和账单、真实 Firebase 账号配额签字。
- Windows 发布者签名未配置；没有把本机包上传到 GitHub Releases。

以上事项不因代码推送或自动化通过而关闭。修复前真实 Provider 单次验证仅是历史证据，不替代本次冻结包的体验验收。
