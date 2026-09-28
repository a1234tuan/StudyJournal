# 对照表自适应布局修复与验收（2026-09-28）

## 范围与根因

本次仅调整编辑器对照表的展示、单元格编辑尺寸及相关测试，不改变日志数据结构、云同步、备份、Markdown 导入导出或其他结构块的行为。

原实现将首列和右侧内容分成两个布局树，再测量外层高度同步 `minHeight`。首列内部单元格没有填满测量容器；首列的 `:last-child` 选择器还会移除每个首列单元格的底边。写回的最小高度又参与后续测量，造成内容缩短后行高不能正常回落。

## 实现

- `src/components/RecordStructureNodes.tsx`：改为一张原生 `table / thead / tbody / tr / th / td`，删除跨面板行高同步逻辑。每行由最高单元格决定高度，每列共享宽度。
- `src/styles.css`：浏览态采用自动表格布局。列宽由整列内容共同决定，同时设置可读性上限，长内容换行；超出可用宽度时仅表格内部横向滚动。首列在同一张表内 sticky，不再独立拆出。
- 普通列内容上限为 `min(26rem, 72cqi)`，首列为 `min(12rem, 32cqi)`，避免窄屏首列遮住其他内容；单列表格放宽限制。
- 进入单元格编辑时临时记录当前各列宽度，使用 `colgroup` 保持布局稳定。退出编辑即恢复按内容自动计算；尺寸不会写入日志数据。
- 文本框根据内容和宽度变化自动增高、缩回，不再固定两行或保留历史最大高度。保留失焦、Ctrl/Command+Enter 提交，以及 Escape 取消。
- 仍以原来的 `record-comparison-table` JSON 保存内容和行列 ID。Markdown 单元格仍不自动加载图片，本次没有扩大资源加载范围。

## 自动化验收

专项组件与样式回归：4 文件 / 135 测试通过（编辑器、延迟公式和相关样式）。

最终全量非 live 回归：245 文件 / 2023 测试通过。`npm run build` 通过，包含 TypeScript 项目构建和 Vite 生产构建；构建仍有动态/静态混合导入及大 chunk 提示，没有作为本次表格修复扩大处理。`git diff --check` 通过。

命令与日志：

- `npx vitest run --exclude '**/*.live.test.ts' --maxWorkers 2 --minWorkers 1` → `output/comparison-layout-2026-09-28/full-tests.log`
- `npx playwright test e2e/comparison-table.spec.ts --workers=1` → `output/comparison-layout-2026-09-28/browser-tests.log`
- `npm run build` → `output/comparison-layout-2026-09-28/build.log`

浏览器用例：`e2e/comparison-table.spec.ts`，7 个场景 × 桌面与 Pixel 7 窄屏模拟，共 14 项通过。测试使用真实应用页面、独立浏览器上下文及隔离 IndexedDB，不连接真实账户。

1. 长短内容混排：同行所有单元格上下边一致，同列宽度一致，行间无缝隙，非末行底边保留。
2. 横向滚动：单一滚动容器、首列固定，页面本身不横向溢出。
3. 编辑尺寸：进入编辑不改变列宽，输入长文后整行增高，删成短句后整行缩回；首列编辑取消后恢复原内容，保存后内容与列 ID 正确。
4. 超长首列、长表头、无空格长串、延迟公式：320 / 768 / 1440 宽度切换；深色与 1.5 倍编辑器字号下仍对齐。
5. 单列、空单元格、仅表头无数据行：增删行列、行上移、最后一行/列保护以及重新添加行。
6. 折叠块内 12 列 × 8 行：局部横向滚动、滚到末端仍保留首列和完整行几何关系。
7. 长表头编辑中改变视口、失焦提交与保存；图片 Markdown 仍遵循原有不自动加载策略。

几何断言容差为 1 CSS 像素。公式按可见区域延迟渲染，测试先滚动到公式列，再断言渲染完成；位置测量等待页面转场结束，避免把动画位移误判为 sticky 失效。

## 截图验收

截图存放于 `output/comparison-layout-2026-09-28/`，共 12 张：

- `desktop-comparison-light.png` / `narrow-comparison-light.png`：普通混排行高、连续边框。
- `desktop-comparison-dark.png` / `narrow-comparison-dark.png`：深色背景、文字与首列区分。
- `desktop-comparison-scrolled.png` / `narrow-comparison-scrolled.png`：右侧内容滚动后的首列固定。
- `desktop-comparison-editing.png` / `narrow-comparison-editing.png`：首列多行编辑，整行同步增高。
- `desktop-comparison-dark-scaled.png` / `narrow-comparison-dark-scaled.png`：极长内容与放大字号。
- `desktop-comparison-many-columns.png` / `narrow-comparison-many-columns.png`：折叠容器内多列表格。

已进行截图目视检查，并结合浏览器几何断言确认首列背景、底边和其他列属于同一行；长内容不会把整个页面撑宽。窄屏显示不完的列需要在表格内横向滚动，这是明确保留的行为，不是截断数据。

## 交付边界

- 本次未安装或打包 Android / Electron 应用，窄屏模拟不等同于 Android WebView 实机验收。
- 未连接生产账户、部署服务或更改用户数据库；保留工作区原有的提前计划和日志收藏等独立修改。
- 浏览器截图不是已安装桌面应用截图；需要安装包交付时仍需独立进行构建及宿主验收。
