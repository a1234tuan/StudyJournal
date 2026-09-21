# 2026-09-21 维护构建交接

## 收口范围

- 提交本轮 ASR 终止帧/部分结果恢复、重试代数和诊断修复，保留 NLS 独立凭据槽及内置 ASR 稳定默认参数。
- 提交百炼 Qwen Audio 3.1/3.0 的协议、音色、HTTPS 音频下载修复，以及受控 Android TTS 验收记录。Fish Audio 默认选择、两段预取、内存重播与挂断清理保留。
- 提交已有的 Android 学科弧形菜单可读性与命中区域调整，不改变选定学科后才创建日志的语义。
- 同步 README、CHANGELOG、AGENTS、语音配置/实现/兼容性/发布检查表及文档索引。本机项目记忆另行同步，不包含凭据，也不进入远程源码。

## 自动化验证

- 普通 Vitest 显式排除 live Provider 文件：209 文件，1,528 测试通过。
- Playwright 全套单 worker：90 通过、2 跳过，覆盖桌面和 Android 窄屏；未将跳过项算作通过。
- Firebase Emulator：4 通过；ASR 宿主 Node 测试：2 通过；Desktop 原生上下文菜单：3 通过。
- TypeScript/Vite、Electron 主进程/preload/ASR 宿主语法检查、Android release 构建和 testDebugUnitTest 通过。
- EXE 内 app.asar 的 desktop/main.cjs 与当前源文件一致，dist/index.html 与本次 Web 构建一致；测试文件与签名配置不在包内。

## 安装包

保持已有品牌、包名、签名、数据路径和各平台版本号；安装包不写入 Git。最初构建交接时仅保留本机产物，随后根据用户追加授权，通过 v0.2.5 GitHub Release 分发同一组已校验安装包。

- Android：dev-dist/release/学习日志.apk；版本 0.2.3，versionCode 14；29,525,710 字节。SHA-256：798EAF64B9F6F6B1489B8A2DF3471EAA849FF3B0F060C5D6A7D4C06C5C3C390C。
- Windows：release/desktop/学习日志 Setup 0.1.6.exe；版本 0.1.6；117,322,311 字节。SHA-256：7AE5B06D7257BB7735D0D7FED12F53C442E8F6F9A0814C3B0EA97A78EC8C0BFF。
- APK 签名校验通过（v2）；同签名 adb install -r 覆盖安装成功，不卸载、不清空数据。手机显示 0.2.3，2026-09-21 15:31:09（Asia/Shanghai）更新，DEBUGGABLE 未开启。
- Windows Authenticode 状态为 NotSigned；electron-builder 输出 signing 步骤不代表已具备可信证书。未安装 Windows 客户端，不对现有桌面数据目录做迁移或清理。

APK 与本轮 TTS 验收包校验值相同：后续仅文档收口，Gradle 复用已验证的相同代码产物；这不是遗漏 Web 构建或 Capacitor 同步。

## 公开分发说明

- 发布入口：[StudyJournal v0.2.5](https://github.com/a1234tuan/StudyJournal/releases/tag/v0.2.5)。仓库发布编号不改变上述平台内部版本。
- 附件使用 ASCII 文件名：StudyJournal-android-0.2.3-build-20260921.apk、StudyJournal-windows-x64-0.1.6-build-20260921.exe，以及 SHA256SUMS.txt；重命名不改变二进制内容或 SHA-256。
- 本次发布后续仅修改 README、更新日志与交接文档，不改变安装包对应的应用源码；应用修复提交为 feaccec，完整构建交接提交为 7109046。
- README 对照 APP 内使用教程重新组织；不将新增文档描述当作功能实现或新一轮真机验收。

## 验收限制

三款 TTS 的真机成功限于授权的短句、键盘确认输入和真实 LLM -> TTS -> Android 播放。麦克风 ASR、蓝牙/来电/弱网、长会话、计费与免费额度、Windows 安装升级交互仍按各自门槛处理。详见 [TTS 真机记录](voice-recall-tts-device-validation-2026-09-21.md) 和 [语音发布检查表](voice-recall-release-checklist.md)。
