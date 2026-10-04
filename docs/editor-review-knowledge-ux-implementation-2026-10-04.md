# 编辑器、复习快捷键与导图实施记录

日期：2026-10-04。源码基线：main / 65820bc。用户已批准按诊断方案实施全部阶段。

状态：四项功能已实施；本轮相关自动化与隔离桌面包验证完成，等待用户体验验收。不是正式安装或生产发布记录。全量浏览器套件存在已在原始基线复现的 8 项旧断言失败，不能称作全套浏览器零失败。

## 1. 保存与恢复

- 草稿结果区分 saved / unchanged / blocked / failed，消除“未执行写入”被误报为“本机草稿保存失败”。未变化不自动等同于已落盘。
- 冲突页同时展示最新正式内容和本机内容；提供下载编辑副本、采用最新正式内容、明确确认后保存当前内容、继续编辑四个出口。
- 采用正式内容前，在 Dexie 事务中比较正式记录和草稿完整基线；任何一方再次变化都拒绝清理。确认覆盖仍沿用原有正式保存事务和 expectedRecord 检查，保留收藏/时间戳安全重基线以及重点块保护。
- 正式写入与刷新、备份 dirty 标记、加入复习、档案刷新等后续操作区分。正文已提交时保留成功预览；重试只续跑未完成步骤，不重复提交正文。跨层重试衔接、连续重试串行化、多个未完成任务不相互覆盖。
- 已正式提交的新记录即使刷新失败，也不再继续标为新建。正式事务已清理草稿时，UI 不再重复无条件清理。
- 精简诊断最多保留本次运行的 30 条：编号、上下文、白名单错误类型、时间；不存正文、资源字节、凭据或原始错误消息。
- 编辑副本为 JSON，含当前正文、核对基线和重点块操作意图；资源只有引用，明确不是完整附件备份。

根因边界：已复现并修复与截图现象相符的错误状态路径，但未访问用户真实问题记录。关机未保存可以解释存在草稿，不能据此证明持续保存失败的唯一原因。真实记录仍需先保留内容和完整备份后再验收。

主要文件：src/pages/RecordEditorPage.tsx、src/lib/committedWrite.ts、src/hooks/useAppData.ts、src/App.tsx、src/services/storageAdapter.ts、src/lib/uiError.ts。

## 2. 表格交互

- 比较表 NodeView 局部阻止 ProseMirror 将单元格 mousedown 当作整块选中；清除已有整块选中状态。
- 保留原生文字拖选与 copy/cut/paste/drop 路径；拖选结束不误进入单元格编辑。
- 编辑输入光标不自动全选；保留 Ctrl+Enter 提交单元格和失焦提交。
- 窄屏行/列操作防止按钮聚焦造成自动滚动、使 mouseup 错过按钮。键盘按钮激活路径保留。
- 没有全局禁用选择，没有改动其他结构块的剪贴板语义。

主要文件：src/components/RecordStructureNodes.tsx、src/styles.css、e2e/comparison-table.spec.ts。

## 3. 复习 E 快捷键

- 普通复习与安排复习使用相同 ReviewPage 编辑入口；e/E 打开当前记录，返回不主动评分、不推进卡片。
- 忽略 IME、长按重复、Ctrl/Alt/Meta、文本输入、弹窗、菜单、非活动页面/转场、批注工具、Coach、看板和评分/撤回忙碌状态。
- 保留 App 导航/批注保存守卫。菜单显示 E 提示但不改变“编辑”的可访问名称。
- 设备本地开关和 aria-keyshortcuts；没有新增云端设置字段。

主要文件：src/pages/ReviewPage.tsx、src/pages/ReviewPage.test.tsx、e2e/editor-review-ux.spec.ts。

## 4. 导图

- 移除单击 220ms 等待；选择与详情分离，显式详情按钮/日志数量打开阅读面板。
- 选择或打开详情不再强制拉回 85% 缩放。提供聚焦、回中心、查看全貌、缩放、改名入口。
- 相机与拖动更新按 requestAnimationFrame 合并；滚轮增量连续归一化；双指中点同时控制缩放和平移。
- 节点与连线共享约 180ms 布局插值，尊重 reduced-motion；布局保持选中节点锚点和稳定左右分支。
- 实际字体测量加缓存；字号、字体就绪、主题变化使缓存失效。普通标签 16px，数量入口预留足够宽度。
- 可见 ID 集合和穿屏连线判断避免重复扫描；选中/编辑节点不被裁掉。
- 修复动画期间节点 DOM 重建造成的连续新建焦点丢失；保留 Enter 同级、Tab 子级、F2/双击改名、方向键导航。
- 保留现有知识库位置命令、大纲共享结构、移动拒绝、侧栏/底部阅读面板，不引入自由白板或新同步协议。

主要文件：src/features/knowledgeLibrary/KnowledgeMap.tsx、useMapMotion.ts、mapViewport.ts、presentation.ts、knowledgeLibrary.css、KnowledgeLibraryPage.tsx。

## 5. 自动化与证据

证据目录：output/editor-review-ux-2026-10-04/evidence/。

- 修复前先验证新增保存回归失败，再实施修复。
- 最终有界单测：258 文件 / 2122 测试通过，排除真实供应商 live 测试。包括保存生命周期、草稿/收藏重基线、同步/备份/恢复、复习导航相关既有覆盖。
- TypeScript 与 review-coach-v2 生产构建通过；既有大 chunk 警告保留。
- Firebase Emulator：2 文件 / 7 测试通过。没有部署规则，没有连接真实用户内容做验收。
- 本轮七文件浏览器回归：87 通过 / 9 平台不适用跳过；仅排除下一节列明的 8 项既有按钮数量断言。
- git diff --check 通过；仓库换行提示不属于错误。
- 桌面、窄屏、明暗主题截图已查看；真实交互覆盖选择、改名、拖动、阅读返回、单元格编辑与剪贴板。

可复跑命令：

```text
npx vitest run --exclude "**/*.live.test.ts" --maxWorkers=2 --minWorkers=1
npm run build:review-coach-v2
npm run test:firebase
npx playwright test e2e/editor-review-ux.spec.ts e2e/comparison-table.spec.ts e2e/knowledge-library-map-refinement.spec.ts e2e/review-navigation-safety.spec.ts e2e/knowledge-library.spec.ts e2e/arranged-review.spec.ts e2e/editor-clipboard.spec.ts --grep-invert "canvas geometry and button density" --workers=1
```

### 既有失败明确披露

未过滤初次七文件运行有 12 项失败：4 项本轮相关问题（菜单可访问名称两平台、窄屏列操作、窄屏新节点焦点）均修复后通过。其余 8 项是 knowledge-library.spec.ts:154 的四主题 × 两平台按钮数量上限断言，桌面实际 7、期望不超过 6；窄屏实际 6、期望不超过 5。

从 HEAD 65820bc 用 git archive 提取独立原始源码到 output/editor-review-ux-2026-10-04/baseline，并复跑该 8 项：相同的 8 项全部失败。原始版本已有“安排复习”额外按钮；本轮未修改此标题栏/数量断言。没有放宽断言或把它们伪装为通过。证据：baseline-density.txt 与 initial-browser.txt。

### 规模测量

Windows 本机隔离 Chrome，源码开发构建，1440×1000，默认字号，人工六叉树；100/500/1000 节点各 30 次脚本选择和连续 wheel。记录 click 至两次 rAF 的保守时延及期间帧间隔，不是物理 Android 或全部真实图谱的 FPS 保证。

- 100 节点：选择到绘制 p95 26.8ms，帧间隔 p95 8.5ms，初始进入 286ms。
- 500 节点：选择到绘制 p95 40.2ms，帧间隔 p95 25.0ms，初始进入 353ms。
- 1000 节点并行单测环境：选择到绘制 p95 63.0ms，帧间隔 p95 50.0ms，初始进入 376ms；达到而非优于严格 50ms 门槛。
- 1000 节点空闲环境复测：选择到绘制 p95 52.8ms，帧间隔 p95 25.1ms，初始进入 388ms，实际保留 191 个可见/选中节点。指定桌面环境满足选择 <100ms、帧 p95 <50ms 的暂定目标。
- 原始 samples/frames 和环境说明存于 map-performance.json。没有把初始布局、极端单链、任意折叠比例、全部字号或真机触控性能宣称为全部通过。

## 6. 隔离 Electron 验收

交付可直接运行的未签名解压版：
D:/StudyJournal-Source/output/editor-review-ux-2026-10-04/acceptance-final/win-unpacked/学习日志-隔离验收.exe

- 实测 app.isPackaged=true，Electron 43.2.0。不是开发服务器窗口，也不是覆盖原安装的 NSIS 安装包。
- 仅打包暂存副本修改产品标识和数据根目录、禁用旧数据迁移；正式 desktop/main.cjs 未改。
- 实测 userData 为 output/editor-review-ux-2026-10-04/acceptance-final/acceptance-profile/Data。仅人工记录和人工知识库，没有读取用户安装版数据，没有登录云账号。
- 最终候选实际验证：预览/复习单击表格没有整块选中；textarea selectionStart=selectionEnd=0；单元格提交和正式保存；旧基线草稿核对并采用正式内容；E/e 进入编辑并返回同卡。
- Electron 真实鼠标拖选得到“选择局部文字”，系统 Ctrl+C 与独立有窗口 Chrome 的 Ctrl+V 内容完全一致。无窗口 Chrome 不连接系统剪贴板，未将其失败误算产品失败。
- 最后重建包再次验证 E/e、单元格提交不关闭编辑、正式保存、返回原卡、导图。pageerror 为空。
- 一次组合启动探针在单元格定位超时；逐步等待活动页面稳定后复测成功。转场中的快捷键按契约不受理；此现象和初次旧包占用导致的打包重试均保留，不隐藏过程性失败。
- 可查看 packaged-results.json、packaged-final-smoke.json、packaged-table.png、packaged-conflict.png、packaged-map-light.png、packaged-map-dark.png。

## 7. 用户验收顺序与边界

1. 只打开上面的“隔离验收”程序。日志“表格与E快捷编辑验收”：试单击、局部拖选复制、编辑最后一个单元格并保存。
2. 进入普通复习，对该人工卡片按 e/E；在输入框打 e 不应跳页，返回保持原卡。
3. 日志“草稿恢复验收”：点击保存进入两版本核对；先下载副本，再选择采用正式内容或勾选确认保存当前内容。此样本刻意保留人工旧基线草稿。
4. 知识库“导图人工验收”→“数据结构与算法”：试选择、详情、缩放、平移、聚焦、折叠、改名与拖动；重点判断镜头稳定和阅读舒适度，而不只是颜色。

未执行：真实问题记录修复、Android 物理设备/WebView 验收、正式安装/升级、签名发布、生产规则部署、付费供应商验证、git commit/push。原有 output 图片删除状态保留。数据库 schema 28、知识协议 1、普通同步协议 2 不变。

结论：本轮功能与相关回归已交付验收；真实记录、真实 Android 和主观导图品质由后续独立验收决定，不以自动化代替。
