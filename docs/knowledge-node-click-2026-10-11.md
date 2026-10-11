# 导图节点单击详情与空格改名

日期：2026-10-11。

- 节点主体（名称或非控件空白区域）单击：调用现有 onDetails，一次导航更新完成选中、打开详情并关闭日志预览；无日志节点也显示节点说明和添加日志入口。
- 日志计数/图标按钮：仍调用 onOpenRecord，直接打开日志正文，不经过节点说明。折叠按钮保持独立。
- 只有 pointer-up 判定为未移动的单击才开详情；拖动、触屏长按移动、双指平移缩放仍走原手势路径。键盘方向移动仍调用 onSelect，不额外强制展开面板。
- 双击、Space/F2 改名与 Tab/Enter 新增继续复用原编辑路径。Space 仅在可编辑且选中非根节点、焦点位于节点名称或画布时触发；输入框、组合输入、修饰键、重复按键及日志按钮不被误拦截。
- 桌面使用既有右侧详情栏；Android窄屏沿用既有自适应面板，不照搬桌面固定右栏。不改变数据、云同步、撤销或复习调度。

## 集中验证

一次定向浏览器批次：17通过、1平台跳过（桌面不适用触屏长按场景），未重跑。覆盖无日志/有关联日志节点、预览与详情切换、添加日志入口、缩放保持、双击与样式编辑、Space/Tab/Enter/方向键、Ctrl+Z、空节点Backspace、鼠标分支移动/排序/无效目标/取消及触屏长按/滑动。npx tsc -b、git diff --check通过。

命令：npx playwright test e2e/knowledge-library-map-refinement.spec.ts -g "node body opens|map log count|map keyboard creates|space renames|drags deep|touch long press|map supports Ctrl|map arrow keys|node styles follow rename" --workers=1 --output=output/knowledge-node-click-2026-10-11/browser

没有全量测试、生产打包、APK/EXE安装或真实账号操作；未提交推送。包含上一轮尚未提交的空格改名补丁。窄屏浏览器触屏模拟不等同于Android实机验收；安装版需更新构建后生效。
