# 日志资料库筛选与固定阅读布局 · 2026-10-12

## 授权与范围

用户批准先前分析方案，要求分阶段实现、阶段验证后自行继续，改动先收敛再集中验证，避免全量回归和反复打包。

本轮完成源码实现和隔离自动化验收；用户视觉验收待进行。未修改数据库 schema、日志内容格式、普通/知识库同步协议或云规则；未操作真实账号、用户数据库、付费提供商或已安装应用。未构建生产包/安装包，未部署、提交或推送。原有 desktop 托盘相关工作保持原样。

## 最终行为

- 桌面日志页固定为顶部筛选、左侧紧凑列表和右侧只读预览。首次打开且阅读区宽度足够时，自动选择第一条；列表按日志日期及更新时间倒序，继续使用每批 20 条的分页。
- 筛选改变后保留仍匹配的预览，否则桌面选择新结果第一条。零结果、专题不可用以及主动关闭预览时保留右侧容器。扩大范围后，保留的选中项如果落在后续分页，按 20 条一批补足并保存分页状态，避免只有预览而找不到列表选中项。
- 全部/标签/专题为互斥范围；标签和专题单选。学科独立取交集，初始为“全部”。切换范围不清空学科；点全部只清除标签/专题条件。
- 桌面移除日期入口；旧日期导航状态在日志根页面恢复时归一化为资料库。手机保留日期浏览及单栏列表 → 预览 → 返回，不默认进入第一条预览。
- 标签/专题按钮常驻，点击后打开可搜索、限高滚动的浮层，不推挤阅读区域。支持 Escape、外部点击、键盘 Tab 和焦点恢复。桌面按钮显示所选条件；手机使用稳定的“标签”“专题”文字，当前选择显示在结果摘要，避免 320px 大字体下入口文字被截断。
- 保存筛选、主动关闭预览和自动预览标记到现有本地导航历史。完整日志返回、搜索返回、浏览器前进后退及两侧滚动恢复均保持。筛选只影响浏览，不修改学习事实。

## 数据与查询边界

### 标签

从全部未删除日志的 tags 汇总，不按学科分组。复用现有去空格/大小写去重规则，保留显示文字；通过 zh-CN-u-co-pinyin 比较器作中文拼音排序，英文按字母、数字按自然顺序比较。混合脚本遵循该比较器顺序（例如测试中的“错题、积分、重点、Apple”），不提供拼音转写、首字母分组或拼音搜索。原标签编辑建议及学科相关颜色不改。

### 知识专题

- 只读取当前账号/访客的普通库；排除 detached、恢复会话及被保护的恢复副本。
- 在同一个只读数据库事务中读取库范围、迁移状态与各库状态；每个库读取一次，然后汇总专题 → 日志 ID 集合。重复节点引用不重复展示日志。
- local-copying 期间不展示半成品目标库，保留尚在复制阶段的源库；完成本地复制后排除保留源，使用目标库。旧源专题选择不可用时明确提示重新选择，不静默扩大到全部。
- 复用 isKnowledgeVisible，考虑专题、节点及引用祖先链的归档/删除。筛选日志还会排除已删除的普通日志。
- 专题以 owner + libraryId + workspaceId 定位，标题更改不丢选择，同名专题在浮层显示库名。
- liveQuery 订阅保证专题变化及时刷新。账号变化清空旧结果，并忽略旧代际异步回调；读取错误、加载中、有效空结果和不可用专题分别提示。失败可重试，不伪装成空库或全部日志。

## 主要实现位置

- src/lib/journalFilters.ts：范围类型、历史规范化、标签列表及筛选纯函数。
- src/features/knowledgeLibrary/journalTopics.ts、useJournalTopics.ts：只读专题集合与账号安全订阅。
- src/components/JournalFilterBar.tsx、src/styles/journal-filters.css：筛选浮层、稳定阅读容器和响应式布局。
- src/pages/JournalPage.tsx、src/App.tsx：预览协调、筛选状态接线、桌面旧日期状态兼容。
- src/lib/tabNavigation.ts、webNavigationHistory.ts：导航记忆及显式预览关闭。
- src/components/JournalRecordPreview.tsx、RichTextEditor.tsx：仅日志预览启用延后编辑器初始化，避免自动展示含 React 节点的正文时触发 StrictMode flushSync 警告；正文尺寸变化后恢复预览滚动。其他编辑器调用默认行为不变。

## 实际验证

### 定向单元/组件测试

分阶段合计 **9 个文件、196 个唯一用例通过**，不是一次全量测试：

- journalFilters：3；journalTopics：4。
- tabNavigation：32；webNavigationHistory：17。
- JournalPage：13；JournalFilterBar：5；JournalRecordPreview：2。
- useJournalTopics：2；RichTextEditor：118。

覆盖交叉学科标签规范化、专题去重/改名/归档/迁移范围/身份切换、异步旧结果隔离/重试、双栏空态、关闭预览不自动重开、扩大范围后的分页、浮层焦点/关闭与原有编辑器功能。

阶段一首次运行仅混合中英文排序断言不符合平台比较器；明确混排顺序后该文件复测通过。界面阶段修正移动日期详情保留分支遗漏的 Search 图标引用；TypeScript 首轮发现一个测试中误用的 exact 参数，修正后通过。未为这些问题反复运行全量测试。

### 浏览器测试

Chrome 隔离上下文，desktop / android-narrow 两个项目，累计 **22 个唯一用例通过、2 个平台不适用跳过**：

- journal-filters.spec.ts：9 通过 / 1 跳过。
- content-first-workspace.spec.ts：9 通过 / 1 跳过。
- journal-performance.spec.ts：2 通过。
- workspace-layout-stability.spec.ts 中 journal tabs 用例：2 通过。

覆盖三种范围与学科交集、只读事实不变、专题实时更名/归档/身份切换、完整日志和搜索返回、浏览器历史、92 条分页与滚动、大量标签、超长名称、320/390/1024/1440 等宽度及暗色大字体。

首次浏览器批次 18 通过、2 失败、2 跳过：一项暴露自动预览富文本节点的 StrictMode 生命周期警告（已定位到 Tiptap ReactNodeView 初始化，未隐藏日志），另一项是手机标签文本造成的测试选择器歧义。定点修正后，受影响及新增布局验证批次 15 通过 / 1 跳过。截图审查进一步把手机入口压缩为不截断的两字标签，最终浮层/长名称场景 2/2 通过，含文字完整可见的几何断言。

最终 TypeScript 检查通过；git diff --check 通过。未跑全量测试、Firebase Emulator、生产构建或安装包构建。

### 证据与复测入口

- output/journal-filters-2026-10-12/browser/：首轮截图及失败 trace。
- output/journal-filters-2026-10-12/final-browser/：定点修正后的浏览器证据。
- output/journal-filters-2026-10-12/visual-final/：最终浮层及窄屏大字体截图。
- output/journal-filters-2026-10-12/desktop-final.png、desktop-tags-final.png：最终桌面实际页面截图（隔离测试数据，不是用户资料）。

可按需使用 npx vitest run 后跟上述对应测试路径；浏览器入口为 npx playwright test e2e/journal-filters.spec.ts --workers=2。已有开发服务时设置 PLAYWRIGHT_REUSE_SERVER=1。不要因为这一局部功能默认跑全量或重新打安装包。

## 待用户验收

确认桌面默认双栏、按钮位置/大小、标签/专题浮层、条件显示和切换预览的体验。实际 Android 设备触摸/键盘及安装版 Electron 接受度仍属于物理设备/发布验收；本轮浏览器窄屏测试不替代这些验收。
