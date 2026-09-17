# 今日计划链路 UI/UX 审查报告

**审查日期：** 2026-09-16
**审查对象：** 「今天」页今日计划入口，以及从入口到计划页、计划条目、日志编辑器的完整做计划链路
**审查类型：** 源码级界面与交互审查（只读，不含修改）
**审查触发：** 实机测试反馈——入口"非常贴紧『今天想记下什么？』的右侧"，且样式不是按钮/卡片
**审查结论：** 有条件通过。入口的位置与样式确实不符合既有按钮/卡片体系，需要修改；链路其余部分基本沿用既有约定，另有 3 项一致性问题建议一并处理。

**实施状态（2026-09-17 追加）：** P1-01 与 P1-02 已按 **方案 B** 实施并验证通过。实施中发现本报告初稿对页头几何的一处误判，已在 §四之 P1-01 更正——**「距离目标 / 云同步 / 收藏」并不在标题那一行，而是被 `align-items: flex-end` 压在副标题那一行**，所以标题行右侧本就没有任何组件，方案 B 的目标是让标题行自己跨满页头宽度。**P2-01 / P2-02 / P2-03 / P3-01 也已于同日实施完毕**，各自的实施结果与实测见 §四对应小节；其中 P2-02 还更正了本报告初稿的另一处误判（三个视图切换控件的"浮层样式"并不一致）。

## 一、审查范围

- 入口：`src/pages/TodayPage.tsx` 页头「今日计划」按钮；
- 容器：`src/components/ui.tsx` 的 `PageHeader` 与 `src/styles/layout.css` 的页头布局；
- 计划页：`src/pages/DailyPlanPage.tsx` 的页头、视图切换、返回控件、新建表单、计划条目、状态色、学科分布条、历史与汇总；
- 日志侧：`src/pages/RecordEditorPage.tsx` 的「来自计划」标签；
- 参照系：全应用的按钮/入口卡片/进度条/删除控件/视图切换的既有约定。

## 二、总体结论

实机反馈的两点全部成立，且根因可定位到具体代码行。链路其余部分（视图切换浮层样式、返回控件、状态色语义、来源标签、空状态、响应式断点）基本与全应用约定一致，未发现功能性缺陷。

需要说明一个前提校正：`docs/daily-plan-final-plan-2026-09-16.md` 第 916 行写「`:83` 已有按钮，只需传 prop」、第 29 行写「入口复用 `TodayPage` 既有按钮」。经 `git show 3543164:src/pages/TodayPage.tsx` 核对，**该前提不成立**——写入计划文档时的 `TodayPage` 没有这个按钮，`PageHeader` 也没有 `titleActions` 这个 prop。两者都是本次实现（提交 `1d1db95`）新增的。因此入口的落位从来不是一个被评审过的设计决定，而是"需要找地方放"的实现产物。这也解释了为什么它会既贴标题、又是内联链接样式。

## 三、问题分级说明

- **P1：** 用户已明确感知、且与全应用既有体系直接冲突的问题，应在本轮修复。
- **P2：** 影响一致性与可发现性的问题，建议一并处理。
- **P3：** 细节一致性问题，可延后，但不应长期遗留。

## 四、审查发现

### P1-01 入口位置：贴在标题右侧，标题行右侧完全没有可到达的空间（已实施）

**状态：** 已按方案 B 修复（2026-09-17）。

**位置：** `src/pages/TodayPage.tsx:82-86`、`src/components/ui.tsx:50-58`、`src/styles/layout.css:82-118`

**现状（含 2026-09-17 的几何更正）：**

- `titleActions` 被渲染进 `.page-header-title-row`，且紧跟在 `<h1>` 之后，两者间距只有 `gap: 12px`（layout.css:111）；
- `.page-header` 是 `display: flex; align-items: flex-end; justify-content: space-between; gap: 18px`（layout.css:82-93），因此它的**左列（eyebrow + 标题行 + 副标题）是一个整体**，而动作组（目标 pill、云同步、收藏）因为 `align-items: flex-end` 会被**压到左列的底部**；
- **初稿误判（已更正）：** 初稿以为"页头最右侧由 `.page-header-actions` 占据，它和标题在同一行"。实机与探针测量都证明不是：动作组对齐的是左列的**底边**，也就是**副标题那一行**（桌面 1440×1000 实测：标题行 y=57、入口 y=58、副标题 y=109、动作组 y=96）。所以「今天想记下什么？」这一行的右侧**本来就是空的**，用户看到的空档一直到页头右边缘。
- 真正的障碍是：左列没有 `flex: 1`、宽度按内容收缩，于是 `.page-header-title-row` 的宽度被锁在标题自身，槽位**没有剩余空间可推**——这就是单加 `margin-left: auto` 无效、入口只能紧贴标题的原因。

**加剧因素（与"实机"观察一致）：** 在 `≤920px` 断点，`.page-header` 变成 `flex-direction: column; align-items: flex-start`（layout.css:383-388）。此时左列不再撑满宽度（fit-content，实测约 230px），「今日计划」依旧挂在 h1 右侧，而动作组落到下一行——两个视觉群互不相关。

**影响：** 入口读起来像标题的附属说明，而不是一个可以点进去的功能入口。用户描述为"非常贴紧标题右侧"，与代码行为完全吻合。

**实施结果（方案 B）：** 把今天页的页头改排成两列网格，让标题行跨满两列，入口即可贴到页头右边缘，而动作组仍留在副标题那一行：

```css
.today-page > .page-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 0 18px;                 /* 行间距 0：三行文字本来就是紧贴的 */
}
.today-page > .page-header > .page-header-lead { display: contents; }
.today-page > .page-header .eyebrow { grid-area: 1 / 1; }
.today-page > .page-header .page-header-title-row { grid-area: 2 / 1 / 3 / 3; }  /* 跨满两列 */
.today-page > .page-header .page-header-subtitle { grid-area: 3 / 1; }
.today-page > .page-header .page-header-actions { grid-area: 3 / 2; }
.today-page > .page-header .page-header-title-actions {
  margin-left: auto;      /* 推到标题行右端（标题行已跨满两列，因此有空间可推） */
  margin-right: 18px;     /* 用户要求"不要太靠边缘"；改成 0 即与下方动作组右对齐 */
}

@media (max-width: 920px) {
  .today-page > .page-header { grid-template-columns: minmax(0, 1fr); }
  .today-page > .page-header .page-header-title-row { grid-area: 2 / 1; }
  .today-page > .page-header .page-header-actions { grid-area: 4 / 1; justify-self: start; margin-top: 10px; }
}
```

要点与代价：

- **`PageHeader` 的共享契约没有被改**：只给左列加了 `page-header-lead` 这个类名（纯增量，不改布局），其余全部选择器都限定在 `.today-page` 内 → 另外 19 个使用方的布局不受影响。
- **`gap: 0 18px` 必须显式写**：否则会继承 `.page-header` 的 `gap: 18px`，在三行文字之间凭空插入 18px 行距。
- **`display: contents` 是必需的**：左列是一个整体 `<div>`，不把它"摊平"，标题行就无法参与外层网格、也就无法跨列。
- **窄屏要补两条**：`≤920px` 时列数变 1、标题行改回单列占位；动作组的 `margin-top: 10px` 是用来补回原先由 flex `gap: 10px` 提供的那段间距（`gap` 已被改成 0）。
- **页头会长高约 9px**（桌面实测 88 → 97；窄屏 134 → 134，无变化）：原先动作组 36px 的顶部会与标题行底部重叠，flex 布局允许重叠、网格行不允许，所以这段重叠变成了真实高度。窄屏本来就把动作组排在文字下方，因此没有新增高度。

**实测验证（临时 Playwright 探针，跑完即删，两个视口各测一次）：**

| 视口 | 页头 | 标题行 | 入口 | 动作组 |
| --- | --- | --- | --- | --- |
| 1440×1000 | `x=320, w=1040, right=1360, h=97` | `x=320, w=1040`（**跨满两列**），`y=57` | `x=1252, w=90, right=1342, y=57`（距右边缘 **18px**，与 `<h1>` 同行） | `right=1360, y=97`（仍在副标题行 `y=110`） |
| 390×844 | `x=16, w=358, right=374, h=134` | `x=16, w=358`（跨满整行），`y=45` | `x=266, w=90, right=356, y=45`（距右边缘 **18px**） | `x=16..254, y=122`（独占下一行、左对齐） |

两个视口下页头的计算 `display` 均为 `grid`、左列均为 `display: contents`，说明网格规则确实生效；桌面标题行可推区间宽 1040px，入口落在最右端 —— 也就是说"`margin-left: auto` 没有可推空间"这个旧问题已不复存在。

**其他两个方向（未采用，保留备查）：**

- **B-简（放弃）· 只让左列撑满，再给槽位 `margin-left: auto`。** 最初提出、后来被实测否掉的写法：

  ```css
  .today-page .page-header-lead { flex: 1 1 auto; min-width: 0; }
  .today-page .page-header-title-actions { margin-left: auto; }
  @media (max-width: 920px) {
    .today-page .page-header-lead { align-self: stretch; }
  }
  ```
  - 它能让入口离开标题，但落点只是**左列右端**，即距「距离目标」胶囊还差页头自身的 `gap: 18px`（layout.css:87）。由于动作组在副标题行、宽度约 238px，入口的右边缘会停在页头右边缘左侧约 256px 处 —— 视觉上"浮在中间偏右"，与任何东西都不对齐，因此没有采用。
  - **为什么单加 `margin-left: auto` 没用**：`.page-header-title-row` 的宽度被父级左列约束，而左列没有 `flex: 1`、宽度等于内容（标题 + 副标题），槽位在那一行里本来就没有剩余空间可推。必须先让左列撑满剩余宽度。
  - **窄屏结果**：`≤920px` 时 `.page-header` 转 `column` 且 `align-items: flex-start`，左列变为 fit-content，不再自动撑满 → 必须补 `align-self: stretch`，否则按钮会退回贴住标题。加了之后标题行占满整行，按钮落在该行最右端，仍与标题同行。
  - **需要在 `ui.tsx` 给左列加一个类名**（现为裸 `<div>`，layout.css 里没有任何 `.page-header > div` 选择器可用；`ui.tsx:50` 的 `<div>` 加 `className="page-header-lead"` 是纯增量、不改布局）。这比用 `:first-child` 稳。
- **A. 移入 `actions` 动作组。** 与目标 pill、CloudSyncButton、收藏同处右侧集群，语义上"今日计划"确实属于一天的元信息与入口。改动最小，**不需要任何 CSS**。它是"标题同一行的右侧集群"，但不是标题行的右端，也到不了绝对最右（最右是收藏图标）。若要求"贴最右边缘"，把按钮放在动作组最后一位即可，代价是文字按钮排在一个 pill、两个图标之后，视觉节奏略怪。
- **C. 迁出页头，进入内容区。** 在 `.today-compose-band` 里做成与「新建 xx 记录」并列的第二张入口卡片。最符合用户说的"入口卡片"，视觉上也最靠右，还能顺带承载完成度（如 `3 / 5 完成`，DailyPlanPage 已有同样的 `counter-pill`）。代价：`.today-compose-band` 现在是 `grid-template-columns: minmax(0, 1fr) 48px`（visual-v2.css:216-222），右侧 48px 是「学科/模板」折叠触发器并与之拼接边框（`border-right: 0` + 圆角只在左侧），要加第二张卡需要重排这个网格。另外**该网格目前没有任何窄屏重排规则**（全仓只有 `visual-v2.css:358` 调整了折叠面板自身的位置），390px 下再加一列会把主卡挤到约 200px，必须同时补一条窄屏规则（堆叠或缩短文案）。

### P1-02 入口样式：用的是"正文内联链接"，不是按钮或卡片（已实施）

**状态：** 已按用户指定改成 **`.primary-button`**（2026-09-17）。

**位置：** `src/pages/TodayPage.tsx:83` 原使用 `className="link-button"`；定义在 `src/styles/pages.css:2478`：

```css
.link-button { border: 0; background: transparent; color: var(--color-accent); cursor: pointer; padding: 0; }
```

**现状：**

- `.link-button` 全仓只被使用 3 次，另外两处都是**正文里的内联跳转**语义：`KnowledgePodcastPage.tsx:699`（点来源记录名跳进日志）、`DailyPlanPage.tsx:458`（"展开全部"）。把同一个类当作页头顶级功能入口使用，属于语义错位；
- 无边框、无底色、无内边距，任何主题下都只是一行彩色文字。

**实施结果：** 入口改用与今天页「开始复习」**同一个类**（`.primary-button`）。验收标准里的"色彩与风格一致"用共享类来保证，而不是复制声明——共享类意味着以后改按钮样式两者自动同步。实测两者计算样式逐项相同：

| 属性 | 值 |
| --- | --- |
| background-color | `rgb(164, 81, 53)`（reading 主题 `--color-primary`） |
| color | `rgb(255, 255, 255)` |
| font-size | `16px` |
| font-weight | `700` |
| font-family | `"Segoe UI Variable"` |
| border-radius / border-color | `6px` / `rgb(136, 65, 43)`（`--color-primary-strong`） |
| min-height / padding | `40px` / `0 12px` |

**与页头边缘的间距：** 用户要求"不要太靠边缘"，故在槽位上加 `margin-right: 18px`（实测入口右边缘距页头右边缘 18px）。选 18px 是因为它等于页头自身的 `gap`，与整体节奏一致；改成 `0` 即与下方的动作组右对齐。

**关于"页面出现两个实心主按钮"的取舍（已接受）：** 今天页现在有两个 `.primary-button`——页头「今日计划」与复习横幅里的「开始复习」（后者仅在有待复习项时出现）。这会削弱"实心主色 = 页面唯一主 CTA"的层级含义。用户明确要求样式完全一致，故照办；若日后觉得抢焦点，可把入口降为 `.secondary-button`（一行改动）。

**对照（用户要求对齐的两个参照物）：**

- `.primary-button`（`components.css:86-99`）：`border-color: var(--color-primary-strong); background: var(--color-primary); color: #fff`，圆角 `--radius-control`；
- `.today-compose-main`（`visual-v2.css:224-239`）：`1px solid var(--color-border)` + `--radius-control` + 背景 `color-mix(in srgb, var(--color-primary-soft) 72%, var(--color-bg))`，就是"新建 xx 记录"那张入口卡片。

**修复前**，入口与这两者都没有关系（这是本项被判为 P1 的直接依据）；修复后入口即为上表的 `.primary-button` 本身。

**建议（立项时的备选，最终未采用）：** 与 P1-01 的方案绑定——选 A 就用 `.secondary-button`（**文字**按钮：`min-height: 40px`、`1px` 边框、`--color-surface` 底色、`font-weight: 700`，见 `components.css:77-101` + `styles.css:536-553`），它是"安静的按钮"，与"链接"彻底区分；选 C 就直接复用 `.today-compose-main` 的 token 组合，让两张卡看起来是一家人。若希望入口是明确的行动号召，也可用 `.primary-button`，但要注意它会出现两个实心主色按钮（另一个是「开始复习」）而互相抢焦点，需谨慎。

**重要澄清（本文初稿用词不严谨，已更正）：** 初稿写"改成 `secondary-button`（与同组的 CloudSyncButton 同族）"是**错的**——`CloudSyncButton` 用的不是 `.secondary-button`，而是 `.icon-button`：`36 × 36`、`border: 1px solid var(--border)`、`border-radius: 8px`、`color: var(--muted)`（`styles.css:604-613`），内容只有一个 `<RefreshCw size={18} />`，**没有任何可见文字**（`CloudSyncButton.tsx:85-96`，靠 `title` / `aria-label="云同步"` 表意）。两者只是"都不显眼"，并不是同一套控件。

**由此得出的取舍（回答"会不会太小/不明显"）：如果字面照搬"与云同步按钮同族"，答案是会，而且比现在更差。** 理由三条：

1. 同一行里已经有 2 个 `36 × 36` 的灰色图标按钮（云同步、收藏），再加第三个同尺寸同色图标，用户只能靠图标形状区分；而「今日计划」是**整个功能的唯一入口**，用无标签图标承担唯一入口会把可发现性降到比现在更低；
2. `36px` 低于本应用按钮的最小标准高度 `40px`（`.secondary-button` / `.primary-button` 均为 `min-height: 40px`），也低于移动端触控目标基准；
3. 当前页头右侧的 `36px` 是"工具集合"的尺寸语言（pill + 图标），而入口应当属于"动作"的尺寸语言，两者不该混。

#### 附：入口控件尺寸对照

下表是立项时的现状与候选（"建议 A/C 采用"均为当时的备选，**最终都没采用**）；实际落地方案见 P1-02 的「实施结果」。

| 控件 | 类 | 实际尺寸 | 可见文字 | 适用语义 |
| --- | --- | --- | --- | --- |
| 修复前的「今日计划」 | `.link-button` | 行内，无固定高度 | 有（accent 色） | 正文内联跳转（**误用**） |
| 云同步 / 收藏 | `.icon-button` | 36 × 36 | 无 | 页头工具，靠图标识别 |
| 目标 pill | `.today-goal-pill` | 高 36 | 有 | 只读状态显示 |
| 文字按钮 | `.secondary-button` | 高 ≥ 40、`padding: 0 12px` | 有 | 次要动作（当时建议 A 采用，未采用） |
| 入口卡片 | `.today-compose-main` | 高 58、图标 20 + 粗体标题 | 有 | 主功能入口（当时建议 C 采用，未采用） |
| 主按钮 | `.primary-button` | 高 ≥ 40、实心主色、白字 | 有 | 页面唯一主 CTA（当时判为"不建议占用"，**最终按用户要求采用**，取舍见 P1-02） |

**采用方案 A 时的对齐问题：** 页头右侧同行的 pill 与图标按钮都是 `36px` 高，`40px` 的按钮会高出 `4px`。需要把同行控件统一到 `40px`（或给按钮单独约束 `height: 36px`），否则会出现基线不齐。

### P2-01 功能可发现性：入口唯一，导航层完全没有暴露

**位置：** `src/App.tsx:216-229`（`navItems` / `bottomNavItems` 只有 今天 / 日志 / 复习 / 录音 / 更多）

**现状：** 「今日计划」整个功能只有今天页页头这一个入口，侧边栏没有条目，「更多」页（`MorePage.tsx`）没有任何引用。

**影响：** 从导航层级看这是个"藏在今天页里的隐藏功能"，与其他能力的暴露程度不一致——复习有独立导航项，录音在侧边栏有独立入口，统计/备份/设置等在「更多」页有 `list-row` 条目。一个新建的功能不应该只靠页头一行小字被发现。

**建议：** 在「更多」页补一条 `list-row` 入口即可（成本极低、完全复用既有组件）；或者维持单入口，但把今天页的入口做成明显的卡片/按钮，让"唯一入口"本身足够显眼。

**实施结果（2026-09-17）：** 「更多 → 应用」列表的首位新增一条 `ListRow`（图标 `ListChecks`，标题「今日计划」，样式与其余四条完全同族）。关键取舍：

- **处理器复用今天页自己的 `openDailyPlan`，而不是新写一个跳转**——两个入口走同一条代码路径，共享同一目的地、同一滚动复位、同一返回行为，不存在"两个入口各自漂移"的可能。
- **它是跨 tab 入口而不是 `more` 子路由**（今日计划工作区住在今天 tab 里）。给「更多」加子路由会在两个 tab 里各渲染一份计划页，反而制造双份导航栈；跨 tab 跳转在本页已有先例——「分类管理」就是这么到达分类 tab 的。
- `MorePage.test.tsx` 新增一条用例覆盖该行的存在与接线（5 用例全过）。

**实测（真实浏览器，两个视口）：** 从「更多」点「今日计划」→ 计划页出现，侧边栏与底部导航的激活项都切到「今天」；点「返回今天」→ 回到今天页，计划页已卸载，全程只有 1 个 `.daily-plan-back`、0 个全局 `.web-navigation-back`（无竞争返回控件）。

### P2-02 视图切换控件的位置与同类控件不一致

**位置：** `DailyPlanPage.tsx:294-315`（放在 `titleActions`）对比：

- `ReviewPage.tsx:935` `.review-mode-tabs`（`role="tablist"`）→ 在页头下方的正文区；
- `JournalPage.tsx:186` `.journal-view-tabs`（`role="tablist"`）→ 同样在正文区。

**现状（含 2026-09-17 更正）：** 初稿写"三个视图切换控件的**浮层样式是一致的**（胶囊底 + 选中项白底 + `--shadow-soft`）"——**这是错的**。实测核对：`.journal-view-tabs` 与 `.review-mode-tabs`（`visual-v2.css:387` / `:421`，visual-v2 是最终生效层）都是**下划线 tab 条**（底部 2px 指示线），而计划页的是**分段胶囊组**。三个控件从来就没有过同一套皮肤，真正一致的问题只有**锚点位置**：两个在正文区，计划页的挂在标题行里。

**影响：** 同类控件在应用里位置漂移；窄屏页头堆叠时，这个切换器会被挤在标题旁边，更容易被误读成标题的一部分。

**建议：** 若要保留在页头，至少与 DailyPlanPage 的返回控件（`.daily-plan-back`）排在同一行——左边"返回 今天"、右边视图切换，形成稳定的子页面顶栏；或直接下沉到正文区与另两个控件对齐。

**实施结果（2026-09-17，采用第一种）：** 切换器移出 `titleActions`，与返回控件同排为 `.daily-plan-topbar`（flex，`space-between`：左「‹ 今天」、右「今日 | 历史」）。选这种而不是"单独下沉成一行"的理由：①"返回在左、局部控件在右"是本应用子页面顶栏的既有形态（`.record-editor-topbar` 就是这个结构）；②不用在窄屏的表单前再插一整行 chrome。`role="tablist"` / `role="tab"` / `aria-selected` 与 `onViewChange` 全部原样，胶囊皮肤也原样——**只统一锚点，不顺手换皮肤**。皮肤差异（胶囊 vs 下划线）是另一项独立决策，留待单独评估，本文不悄悄扩大改动范围。

**实测（两个视口）：** 切换器不再在 `.page-header` 内；与返回控件同行（基线差 2px 桌面 / 3px 窄屏）；右边缘与内容区右缘对齐（0px）。单元 22/22、`e2e/daily-plan.spec.ts` 16/16 均无改动即通过（定位全是 role 型，不依赖 DOM 位置）。

### P2-03 学科分布条的填充色用了"成功绿"，与全应用进度条约定相反

**位置：** `src/styles/visual-v2.css:1434-1443`：

```css
.daily-plan-page .daily-plan-subject-bar { height: 7px; border-radius: 99px; background: var(--color-surface-muted); }
.daily-plan-page .daily-plan-subject-bar > span { background: var(--color-success); }
```

**对照：**

- `.stats-trend-bar span`（`visual-v2.css:305`）→ `var(--color-primary)`，且几何完全一致（同样 `height: 7px`、`border-radius: 99px`、`--color-surface-muted` 轨道）；
- `.review-progress-track > span`（`pages.css:2732`）→ `var(--color-primary)`。

**全仓核查：** `var(--color-success)` 在样式里只有 8 处，其中 7 处都是"状态/评分"语义（`pages.css:598-599`、`902-903` 的徽章，`pages.css:3712` 的评分底纹，`visual-v2.css:1355` 的"已完成"文字）。**只有这一处把它当占比条的填充色用。**

**影响：** 同一应用里"占比/进度"出现了两套颜色语言；绿色在别处代表"成功/已完成"，用在这里会让"学科分布"看起来像"完成度"。而同一页面上 `.daily-plan-status-done` 的绿色（`visual-v2.css:1355`）才是真正该用 success 的地方——两者放在同一屏里，语义会打架。

**建议：** 改为 `var(--color-primary)`，保持与 stats/review 进度条一致；已完成状态继续用 success 不变。

**实施结果（2026-09-17）：** 该处 `--color-success` → `--color-primary`，并在规则内注释了为什么（占比条用主色，success 留给状态语义）。实测（历史视图）：填充计算色 `rgb(164, 81, 53)` = `--color-primary`（`#a45135`），两个视口一致；改后全仓 `--color-success` 的剩余用法核对过一遍，全部仍是"状态/徽章/评分"语义，没有第二处占比条误用。

### P3-01 计划条目的删除控件是自创的竖切条带

**位置：** `DailyPlanPage.tsx:140-148` + `visual-v2.css:1374-1390`

**现状：** 卡片内右侧一个 `width: 46px`、带 `border-left: 1px solid var(--color-border)` 的竖向分隔条，居中一个垃圾桶图标；`hover` 时变 `--color-danger`。

**对照：** 全仓只有这一处用"卡片内右侧竖向分隔条 + 图标"表达删除。`border-left` 作分隔在 visual-v2 里的另一处是编辑器工具栏的插入分组（`:761`）。记录卡片走的是"更多操作/动作行"把删除收起来的路线（窄屏 `≤920px` 下 `.collapsible-action` 会被折叠进 `.record-more-menu`）。

**影响：** 删除的可点区域紧贴整行内容区，误触成本偏高；视觉上竖线更像分页符而非删除入口。属于细节，不影响功能。

**建议：** 优先级最低。若要改，可考虑与记录卡片一致地收入"更多操作"，或至少把图标默认色从 `--color-muted` 调整得更弱、只在 hover/focus 时才显现为删除语义。

**实施结果（2026-09-17，采用第二种）：** 竖切条带改为**独立的收纳式图标按钮**。没有选"收入更多操作"菜单，理由：①计划行是"一整块打开 + 一个删除"的两按钮复合体，把删除折进菜单要付出 2 次点击 + 一整套菜单机制（开关状态、外点关闭、ARIA 菜单模式），而误删本身已有确认对话框把关；②现有单测与 e2e 都以 `删除计划 X` 这个 accessible name 定位按钮，收纳式改法会迫使测试重写而功能零增益。

具体改动（全在 `visual-v2.css`）：删掉 `border-left` 与整高条带；`36 × 36`、`--radius-control`（与本应用图标按钮同尺寸同圆角）、`align-self: center`、距卡右缘 6px；行 `gap` 4 → 6px，注释里写明这是两个点击目标之间的**故意留白**；主按钮改为四角全圆，悬停水洗的右缘落在干净的圆角上而不是行中间突然变方；补上 `:focus-visible` 与 hover 同色的键盘可见性。

**实测（两个视口）：** 36×36、`border-left: 0`、垂直居中偏差 ≤ 0.5px、与主按钮间隔 6px、距卡片右缘 7px；静止时 `rgb(113,107,100)`（muted），悬停时 `rgb(168,77,77)`（danger）+ 悬停底色。按钮的 `aria-label` / `title` 未动，`DailyPlanPage.test.tsx` 22/22、`e2e/daily-plan.spec.ts` 16/16 均无改动即通过。

## 五、确认一致、无需修改的部分

- **计划条目行的卡片语言**（`visual-v2.css:1280-1288`）：`1px solid var(--color-border)` + `--radius-card` + `--color-surface`，与记录卡片、`day-log-card`、`category-entry-card` 同族；
- **状态色语义**：`done → --color-success`、`pending → --color-muted`、`draft → --color-accent`，与全应用"成功/中性/待处理"的用法一致；
- **空状态**：实际是 `<div className="empty-state daily-plan-empty">`，复用了全应用统一的 `.empty-state`，只做局部叠加，写法正确；
- **汇总卡片**：复用 `.stats-state-grid`，与统计页同源；
- **返回控件**：`.daily-plan-back` 虽为自绘，但样式与全应用 `web-navigation-back` 的"低对比文本 + hover 底色"一致（且 `App.tsx:1903-1906` 已显式让全局返回行不与它重复）；
- **「来自计划」标签**（`visual-v2.css:1524-1542`）：`.record-plan-origin` 用 `--color-muted`、`font-size: .74rem`，明确定义为"上下文而非控件"，与记录页页头/标签片的既有做法一致；
- **响应式**：`≤640px` 下新建表单堆叠、条目行状态换行、学科分布三列收窄（`visual-v2.css:1490-1514`），逻辑与断点选择合理；
- **动效降级**：`prefers-reduced-motion` 下关闭条目入场动画（`visual-v2.css:1516-1520`）；
- **视觉主题**：全部样式使用 `--color-*` token，`reading` / `modern` 两套主题都能正确解析，没有硬编码色值。

## 六、修复建议汇总（按优先级）

| 编号 | 问题 | 建议方向 | 涉及文件 |
| --- | --- | --- | --- |
| P1-01 | 入口位置贴在标题右侧 | **已实施**：方案 B（用户选定方向）——留在标题行、推到行右端，作用域收在 `.today-page`，给 `ui.tsx` 左列加一个类名 + 网格声明；未采用的备选：A 进 `actions` 动作组（零 CSS）、C 迁入内容区做成卡片 | `TodayPage.tsx`、`ui.tsx`、`visual-v2.css` |
| P1-02 | 入口是内联链接样式 | **已实施**：改用共享 `.primary-button`（与「开始复习」同一个类），并加 `margin-right: 18px` 不贴边；立项时的 A（`secondary-button`）/ C 备选均未采用；**不要**做成 `.icon-button` | `TodayPage.tsx`、样式 |
| P2-01 | 导航层无可发现入口 | **已实施**：「更多 → 应用」首位补 `ListRow`，处理器复用今天页的 `openDailyPlan`（跨 tab 入口，先例：分类管理） | `MorePage.tsx`、`MorePage.test.tsx`、`App.tsx` |
| P2-02 | 视图切换位置与同类控件不一致 | **已实施**：与 `.daily-plan-back` 同排为 `.daily-plan-topbar`（左返回右切换）；皮肤差异（胶囊 vs 下划线）留作独立决策 | `DailyPlanPage.tsx`、`visual-v2.css` |
| P2-03 | 学科分布条误用成功绿 | **已实施**：改为 `var(--color-primary)`；全仓 `--color-success` 剩余用法复核均为状态语义 | `visual-v2.css` |
| P3-01 | 删除控件自创竖切条带 | **已实施**：改为收纳式 36×36 图标按钮（去掉 `border-left` 条带、补 `:focus-visible`）；"更多操作"菜单方案未采用，理由见该节 | `visual-v2.css` |

## 七、验收标准（修复后）

1. **（方案 B）** 入口位于"今天想记下什么？"同一行的右端；在 1440×1000 下其右边缘距页头右边缘 `18px`（留出空白、不贴边），动作组仍留在副标题那一行；在 390×844 下（页头已竖排）入口仍在标题行右端、距右边缘 `18px`，不出现贴住标题的情形；
2. 入口复用共享的 `.primary-button`，其 `background-color` / `color` / `font-size` / `font-weight` / `border-radius` / `min-height` / `padding` 与今天页「开始复习」**逐项相同**（实测已验证）；**不是**无文字的 `36 × 36` 图标按钮；
3. 视觉主题为 `reading` 与 `modern` 时，入口均不具备硬编码颜色，且对比度不低于既有按钮；
4. 方案 B 的样式改动**必须限定在 `.today-page` 作用域内**；需要回归确认 DailyPlanPage 的视图切换（同样使用 `titleActions`）以及其他 19 个使用 `PageHeader` 的文件布局未发生变化；
5. 学科分布条填充色与 `.stats-trend-bar` / `.review-progress-track` 一致；
6. 入口标题、`aria-label`、键盘可达性（`Tab` 可聚焦、可见 focus ring）保持现状不退化；
7. 若入口位置发生移动，`e2e/daily-plan.spec.ts` 中依赖入口的用例需同步更新并全部通过。

### 验收执行结果（2026-09-17）

| 项目 | 结果 |
| --- | --- |
| 入口与「开始复习」的计算样式比对 | **逐项相同**（背景 `rgb(164,81,53)`、文字 `rgb(255,255,255)`、`16px`、`700`、圆角 `6px`、`min-height 40px`、`padding 0 12px`） |
| 1440×1000 几何实测 | 入口右边缘距页头右边缘 **18px**（`1342` vs `1360`）；入口 `y=57` 与标题行 `y=57` 同行（`<h1>` 为 `y=58`）；动作组 `right=1360, y=97` 仍在副标题行 |
| 390×844 几何实测 | 入口右边缘距页头右边缘 **18px**（`356` vs `374`）；标题行跨满整行（`w=358`）；动作组独占下一行（`y=122`）且左对齐 |
| 页头高度代价 | 桌面 **+9px**（88 → 97）；窄屏 **0px**（134 → 134） |
| `tsc -b` | 通过 |
| `vite build` | 成功（16.51s） |
| `e2e/daily-plan.spec.ts` | **16/16 通过**（desktop + android-narrow 各 8 例） |
| `TodayPage.test.tsx` + `ui.test.tsx` | 8/8 通过 |
| `git diff --check` | exit 0；5 个改动文件逐个按字节核对，**无混合行尾** |
| 全量单测 | **201 文件 / 1438 例：1435 通过、3 跳过、0 失败**（`npm test`） |
| 顺带修掉的日期脆弱用例 | `StatsPage.test.tsx:40` 曾是唯一失败项且**与本次改动无关**——fixture 硬编码 `masteryTrend` 为 `2026-09-10/11`，而 `summarizeRecall`（`src/lib/learningStats.ts:30`）的 7 天窗口起点是 `date - 6 days`，`StatsPage.tsx:41` 又传真实 `todayISO()`，于是该用例在 2026-09-17 自行转红（09-10 那行滑出窗口，7 天卡从 8 变 4）。**产品行为正确，纯属 fixture 陈旧**；现改为 `addDaysISO(todayISO(), -2 / -1)` 生成，始终落在滚动窗口内 |

### 验收执行结果（P2 / P3 项，2026-09-17 第二批）

| 项目 | 结果 |
| --- | --- |
| P2-01 链路实测 | 从「更多」点「今日计划」→ 计划页出现，侧边栏 + 底部导航激活项都为「今天」；「返回今天」→ 今天页，计划页已卸载，`web-navigation-back` 计 0（无竞争返回控件）。`MorePage.test.tsx` **5/5**（含新增接线用例） |
| P2-02 几何实测 | 切换器不在 `.page-header` 内；与返回控件同行（基线差 2px 桌面 / 3px 窄屏）；右缘与内容区右缘对齐（0px，两视口）。`DailyPlanPage.test.tsx` **22/22**、`e2e/daily-plan.spec.ts` **16/16**，均无一处测试改动 |
| P2-03 颜色实测 | 历史视图学科条填充 `rgb(164,81,53)` = `--color-primary`（`#a45135`），两视口一致 |
| P3-01 几何实测 | 删除控件 36×36、`border-left: 0`、垂直居中偏差 ≤0.5px、距主按钮 6px、距卡缘 7px；静止 muted `rgb(113,107,100)`，悬停 danger `rgb(168,77,77)` |
| `tsc -b` | 通过 |
| `e2e/daily-plan.spec.ts` | **16/16 通过**（两 project × 8 例） |
| 全量单测 | **201 文件 / 1439 例：1436 通过、3 跳过、0 失败**（`npm test`，含新增的 MorePage 接线用例） |
| e2e 受影响面 | `stats-page` / `ui-v2-stage2` / `usage-guide` 与 `daily-plan` 混跑时，`stats-page.spec.ts` 间歇性 30s 超时（等待「更多」按钮，`preview=stage3` 冷启动 + 4 并发 worker）。**A/B 已证明与本次改动无关**：checkout 到改动前的 `5afe1e4` 以相同批次复跑，出现完全相同的失败；单独或两文件混跑则全过。属预存在的环境性抖动，未在本次范围内修 |

## 八、声明

本报告只依据当前源码、既有样式约定和实机反馈作出判断，未把设计意图当作已实现能力。报告正文最初为只读审查；P1-01、P1-02、P2-01、P2-02、P2-03 与 P3-01 已于 2026-09-17 按用户确认的方向全部实施，实施范围与验证结果见上文各节。
