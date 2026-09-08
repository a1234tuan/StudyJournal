# StudyJournal / 学习日志

一个本地优先的学习日志、间隔复习与可选 AI 自测应用，支持 Web、Windows 和 Android。

[![CI](https://github.com/a1234tuan/StudyJournal/actions/workflows/ci.yml/badge.svg)](https://github.com/a1234tuan/StudyJournal/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/a1234tuan/StudyJournal)](https://github.com/a1234tuan/StudyJournal/releases/latest)

它不是单纯的闪卡软件，也不是通用协作文档。学习日志把“每天到底学了什么、哪里没懂、什么时候该回头看、如何用 AI 检查自己有没有真正掌握”放进同一条个人学习闭环里。

## 产品定位

学习日志面向长期自学、备考、课程复盘和个人知识沉淀场景：

- 用日志记录真实学习过程，而不是一开始就强迫拆成原子卡片。
- 用混合复习系统管理回看节奏，避免长笔记被高压闪卡化。
- 用 AI 基于自己的记录出题、追问、解释和挖盲点。
- 用 OCR、搜索、录音、附件和 Android 增量备份支撑长期资料积累。

## 核心亮点

- **学习记录为核心对象**：按学科和日期沉淀学习过程，支持收藏、回收站、统计和月份折叠浏览。
- **富编辑器**：支持文本、图片、录音、附件、公式、代码块、任务列表、高亮块、折叠块、结构图、对照表和便签板。
- **混合复习系统**：默认 `轻回看`，适合长日志、复盘和资料型笔记；可手动切换为 `记忆卡`，使用 FSRS 风格四按钮调度。
- **AI 学习助手**：围绕当前日志或记录进行问答、自测、讲解和盲点挖掘，支持 OpenAI-compatible API 供应商。
- **OCR + 搜索闭环**：图片 OCR 文本会进入全文搜索、AI 上下文、导出和备份。
- **录音资料库**：集中查看日志中引用过的录音，支持搜索、播放、倍速和循环。
- **Android 大资源备份**：支持自动备份文件夹仓库，资源独立保存，只同步新增或缺失资源，并保留最近 5 个快照。
- **本地优先**：无需登录即可记录和复习，核心数据保存在本机；Firebase 云同步使用可选的 Google 登录，AI、OCR 和备份均由用户自行配置。

## 当前状态

复习效果驱动的 AI 学习助教已经完成阶段 0-9 的实现和自动化验收，产品与数据边界见 [docs/新的方案.md](docs/新的方案.md)。schema 19 覆盖升级会在事务内保留日志、FSRS、资源、计时、旧评论和用户确认的旧测验/KnowledgePoint 正式事实；schema 20 新增设备本地的复习批注草稿表，schema 21 新增三张设备本地语音复述表。正式实体、墓碑和决策块正文冲突副本可备份和同步，批注草稿、语音会话/本机历史、Prompt、Provider 原始响应与 API 密钥不会进入这些边界。

产品级 UI/UX 重构也已完成自动化收口：默认使用“温润阅读”，可在设置中切换到“清爽现代”，两套视觉主题与浅色/深色模式相互独立且只保存在当前设备。新的首页、日志资料库、连续编辑器、复习与学习助教、搜索、设置、备份、录音、播客和 AI 页面共用同一信息架构。2026-09-08 的后续改进进一步收紧主页面顶部空间，并在只读复习卡片中加入本地批注工具和跨 Tab 评分撤回；正式保存、FSRS 评分与云同步协议保持不变，具体实现边界见 [docs/review-annotation-and-rating-undo-plan.md](docs/review-annotation-and-rating-undo-plan.md)。完整单元测试、Desktop/Android 窄屏 E2E、Firebase Emulator 和生产构建均已通过；Android 真机软键盘、中文 IME、系统返回和真实账号配额仍需发布前人工验收。

> 当前自动化基线：125 个 Vitest 文件、837 项测试，38 个 Desktop/Android-narrow Playwright 场景，以及 4 个 Firebase Emulator 场景。真实设备覆盖升级、中文 IME、系统返回、前后台/离线恢复、真实语音 Provider/音频行为和真实 Firebase 配额仍属于人工发布门槛。

实时语音主动回忆已完成阶段 0–6 自动化收口：除隔离交互原型、schema 21 本机检查点、Web/Android PCM 采集和 Provider 适配底座外，复习页已有生产工作区，可从只读日志或当前复习卡进入，保留本机摘要，并在明确确认后整理为正式日志；学习助教支持文本/语音切换，语音转写必须人工确认后才沿既有 Coach 答案链提交。云同步、备份、模板升级和不可信内容边界已有反向证明测试。`?preview=voice-recall` 使用明亮默认声场、连续字幕和固定四键控制验收 Mock 通话交互，`?preview=stage3` 用于验收复习卡入口与生产工作区，`?preview=coach` 用于验收 Coach 语音答案。真实 Provider 和真机检查仍是发布门槛，详见 [docs/realtime-voice-recall-implementation.md](docs/realtime-voice-recall-implementation.md)。

## 下载

请从 [GitHub Releases](https://github.com/a1234tuan/StudyJournal/releases/latest) 下载构建产物：

- Android：`StudyJournal-Android-v0.2.3.apk`，支持在签名一致且旧版 `versionCode` 较低时覆盖安装。
- Windows：`StudyJournal-Windows-Setup-v0.1.6.exe`，支持覆盖安装；当前未使用商业 Authenticode 证书，Windows 可能显示 SmartScreen 提示。
- `SHA256SUMS.txt`：用于校验下载文件完整性。

安装或覆盖升级前请先导出完整备份。卸载 Android 应用会删除应用私有目录中的本地数据；只有独立导出的备份或已成功上传的云端数据可用于恢复。

## 功能概览

| 模块 | 能力 |
| --- | --- |
| 今天 | 创建今日学习记录，查看今日安排和快速入口 |
| 日志 | 按日期回看记录，进入全文搜索 |
| 分类 | 按学科管理记录，学科内按月份折叠显示，适合 400+ 记录规模 |
| 编辑器 | 富文本、结构化块、图片、录音、附件、公式、OCR |
| 复习 | `轻回看 / 记忆卡` 混合调度、四按钮评分、跨 Tab 撤回，以及只读正文上的本地批注工具 |
| 语音复述 | 自由主题或资料范围主动回忆、当前日志/复习卡入口、本机摘要，以及 Coach 确认转写提交 |
| AI 问答 | 基于日志上下文进行问答、自测、解释和追问 |
| OCR | 图片文字识别，结果进入搜索、AI、导出和备份 |
| 录音 | 录音资源集中管理和回听 |
| 备份恢复 | 完整 ZIP 导出/导入，Android 增量文件夹仓库，旧仓库恢复 |
| 统计 | 学习记录、资源、复习和学科分布概览 |

## 与同类产品的差异

- **相比 Anki**：Anki 更适合高强度原子卡片记忆；学习日志更适合先保留完整学习过程，再把真正需要记忆的内容切换为记忆卡。
- **相比 RemNote**：RemNote 更强调笔记内闪卡和知识管理；学习日志更轻、更本地，更贴近日志、复盘和 Android 端个人使用。
- **相比 Obsidian / Logseq**：它们强在双链、图谱和开放插件生态；学习日志内置复习、AI、OCR、录音和备份，不要求用户自己搭插件系统。
- **相比 Notion**：Notion 强在团队文档、数据库和协作；学习日志专注个人自学闭环和本地数据掌控。
- **相比普通日记/备忘录**：学习日志不只记录，还能回看、搜索、OCR、AI 自测和间隔复习。

## 技术栈

- React 18
- TypeScript
- Vite
- Vitest + Testing Library
- Dexie / IndexedDB
- TipTap
- JSZip
- Capacitor Android
- Electron Windows Desktop
- Vite PWA
- ts-fsrs
- KaTeX / lowlight / highlight.js
- Lucide React
- Recharts

## 快速开始

推荐使用 Node.js 24（CI 固定版本）。

Windows 下可直接双击项目根目录的 `启动网页版.cmd`。它会固定打开 `http://127.0.0.1:5173`，自动复用或启动本项目的 Web 服务；请始终使用这个地址，避免与 `localhost` 或其他端口分裂为不同的浏览器本地数据库。

```powershell
npm ci
npm run dev
```

默认开发地址通常为：

```text
http://127.0.0.1:5173/
```

运行测试：

```powershell
npm run test
```

生产构建：

```powershell
npm run build
npm run preview
```

## Windows 桌面版

桌面版是独立的 Windows 安装应用。安装后从桌面或开始菜单打开，不需要启动 Vite、本地服务器或浏览器。

构建 Windows x64 安装包：

```powershell
npm ci
npm run desktop:build
```

安装包输出到 `release/desktop/`。开发期间可使用下列命令直接打开桌面窗口；它同样读取本地构建产物，不启动 Vite 服务：

```powershell
npm run desktop:dev
```

桌面版的 IndexedDB 与浏览器 Web/PWA、Android 应用相互独立。首次打开空桌面版时会提供迁移入口：先在原端导出完整备份或“日志互通”ZIP，再在桌面版的“更多 → 备份与恢复”中导入。不要通过清理浏览器站点数据或直接复制浏览器配置文件迁移数据。

桌面版的应用程序默认安装到 `D:\\StudyJournal\\App`；索引数据、资源、Chromium 缓存、日志、临时文件与崩溃报告都在 `D:\\StudyJournal\\Data\\`。安装向导仍可改为其他 D 盘目录。若从旧桌面版升级，程序会先将旧的 C 盘用户数据，以及早期版本写入 `D:\\StudyJournal\\` 根目录的数据复制到 `Data`，不会自动删除旧副本。

## Android 构建

构建 debug APK：

```powershell
npm run android:build:debug
```

构建 release APK：

```powershell
npm run android:build:release
```

release 构建需要在本机配置签名文件。请不要提交 keystore、`keystore.properties`、API Key、OCR Token 或任何私密配置。

## 可选服务配置

- Firebase：项目包含客户端配置和按认证用户 UID 隔离的 Firestore/Storage 规则。自行部署时应创建自己的 Firebase 项目、Android `google-services.json` 和 OAuth 配置，并先在 Emulator 中验证规则。
- AI：在应用内配置 OpenAI-compatible Provider。API Key 仅应保存在本机，严禁提交到仓库、Issue、日志或截图。
- OCR：由用户在本机配置服务凭据；项目不附带共享 Token。

公开的 Firebase Web 配置用于标识客户端项目，不等同于服务端密钥；实际访问边界由认证和安全规则控制。维护者仍应在 Firebase 控制台限制 API Key 的可用 API 和应用来源。

## 数据与隐私

学习日志是本地优先应用：

- Web/PWA 数据主要保存在浏览器 IndexedDB 和站点存储中。
- Android 数据主要保存在 App WebView 存储和本机文件/缓存中。
- AI API Key、OCR Token、完整 Prompt、Provider 原始响应和知识播客音频只保存在本机，不进入云同步或可移植备份。
- 未评分卡片的批注草稿只保存在当前设备，不进入正文、云同步、备份或导出；评分成功后删除，撤回评分不会恢复旧批注。
- 未完成的语音复述检查点和用户主动保存的本机通话摘要只保存在当前设备，不进入云同步或便携备份；完整恢复清除临时会话但保留恢复前已有本机历史，卸载、清除数据和换机仍会丢失。
- AI 请求会把必要上下文发送给用户配置的模型供应商。
- 清除浏览器站点数据、清除 Android 应用数据或卸载 App，可能删除本地库。

请定期导出完整备份，或在 Android 端配置自动备份文件夹仓库。

## 备份策略

项目提供两类备份：

- **完整 ZIP 导出/导入**：适合迁移、归档和小到中等规模数据恢复。
- **Android 增量文件夹仓库**：适合长期大资源量使用。仓库目录为 `study-journal-backup/`，资源保存在 `assets/`，快照保存在 `snapshots/`，`manifest.json` 指向最新快照。

Android 自动备份当前策略：

- 打开 App 后同步一次。
- 编辑、删除、OCR、复习评分等普通数据变动不会立即自动同步。
- 用户可以手动点击“立即同步”推送当前本地数据到仓库。
- 从旧仓库恢复需要使用“从自动备份文件夹恢复”，不会在绑定文件夹时自动拉取。

## 项目结构

```text
src/
  components/   通用组件、编辑器节点和 UI 组件
  db/           Dexie 数据库、默认设置和迁移
  hooks/        应用数据 Hook
  lib/          日期、搜索、Markdown、复习算法、内容解析等纯逻辑
  pages/        今天、日志、分类、复习、AI、设置等页面
  services/     存储、AI、OCR、备份、Android 原生桥接等服务
  styles/       主题、布局、页面和组件样式
android/        Capacitor Android 工程
scripts/        Android 打包辅助脚本
docs/           项目文档
```

## 常用命令

```powershell
# 安装依赖
npm ci

# 启动开发服务
npm run dev

# 运行测试
npm run test

# 浏览器全链路 E2E（系统 Chrome）
npm run test:e2e

# 隔离 Firebase Emulator 验收（需要 JDK 21）
npm run test:firebase

# 构建 Web/PWA
npm run build

# 构建 Windows 桌面安装包
npm run desktop:build

# 同步 Web 构建到 Android
npm run android:sync

# 打开 Android Studio
npm run android:open

# 构建 Android debug APK
npm run android:build:debug

# 构建 Android release APK
npm run android:build:release
```

## 开发注意

- `dist/`、`dev-dist/`、`android/app/build/`、`*.apk`、`*.aab`、`*.jks`、`*.keystore` 不应提交。
- 修改编辑器自定义节点时，需要同步检查搜索、AI 上下文、Markdown 导出、备份和恢复链路。
- 修改复习逻辑时，需要重点验证轻回看、记忆卡、同日重复评分、跨 Tab 撤回、批注清除生命周期、切换类型和复习队列稳定性。
- 修改备份逻辑时，需要区分“导出/导入 ZIP”和“Android 自动备份文件夹仓库”，避免互相牵连。
- 发布 APK 请使用 GitHub Releases，不要把安装包提交到 Git 历史。

## 当前限制

- Firebase 云同步需要 Google 登录，采用显式触发的逐实体增量协议，并对真实同实体并发修改提供冲突处置，不是实时协同编辑。
- 首次设备恢复、旧协议迁移或显式冲突恢复仍可能需要全量读取；普通无变化同步会跳过云端锁，超预算读写需要用户确认。
- 云端复习事件历史目前只增不减；在引入可验证 checkpoint 与事件 tombstone 前不能直接清理。
- Android 自动备份保留最近 5 个快照，但当前界面不提供选择历史快照回退。
- AI 看图、长上下文和输出质量取决于模型供应商与 API 兼容性。
- 实时语音复述的生产工作区与学习闭环已接入，但当前 ASR/教师回复仍明确使用确定性 Mock 或人工转写；真实 Provider、真实费用/配额、真机回声消除、蓝牙、音频焦点、来电、后台和弱网仍未验收。
- 单个超大资源文件仍可能受 Android WebView、IndexedDB、Blob 和设备内存限制。

## 参与贡献与安全

提交代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中提交 API Key、备份文件或真实学习数据。版本变化见 [CHANGELOG.md](CHANGELOG.md)。

本项目使用 [MIT License](LICENSE)。第三方依赖仍分别受其自身许可证约束。
