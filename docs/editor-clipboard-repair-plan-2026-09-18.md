# 编辑器剪贴板修复方案（2026-09-18，收尾记录）

> **状态：部分实施并已验收（2026-09-19）。** 本阶段已落地复制链路中的 P0/P1 相关修复，
> 尤其是外部浏览器输入框依赖的 `text/html` 公式可见回退文本；右键菜单、拖拽和其他明确标为
> P2/待决的能力仍未实施。本文保留原方案和判别过程，后续若继续扩展，须先重新确认范围。

| 项 | 内容 |
|---|---|
| 文档状态 | **部分实施，复制链路已验收**。已实现公式节点的原生选区兜底、`data-latex` 保留，以及面向外部应用的 `text/html` 可见公式文本回退；排查过程稿见 §10.11。右键菜单、拖拽等 P2 仍延期。 |
| 适用版本 | 当期工作树（`package.json` 版本基线，未变更 schema） |
| 影响模块 | 富文本编辑器（复制 / 剪切 / 粘贴 / 右键 / 拖拽） |
| 数据影响 | **数据契约不变**（不涉及 schema 版本、存储结构、云同步载荷、备份格式）。但 P1-5 会新增一条内容来源：外部 `<table>` 首次可以生成 `recordComparisonTable` 数据（详见 §4 P1-5 与 §10.8） |
| 判定依据 | 全部结论均以当期工作树源码、直接可复核的行号为据；库行为以 `node_modules` 内实装版本的源码为据 |

**证据等级约定**（本文全篇使用）：

- `[观测]` —— 有直接运行观测（浏览器探针 / 单元测试输出）
- `[源码]` —— 回源码可判定，行号可直接复核
- `[待验证]` —— 机理成立，但引发该现象的原因尚未通过判别性测试区分

---

## 1. 问题描述

用户报告的三个可观察症状：

1. **快捷键复制失效**：选中内容后按 Ctrl+C 有时没有反应，选中公式时尤其明显；
2. **右键菜单缺失**：桌面端在编辑区内右键不弹出任何菜单；
3. **不支持拖拽**：内容无法拖出，也无法通过拖拽调整结构块顺序。

**期望效果**（需求原文）：

- (a) 文字、公式、表格等基础内容可以正常选中并复制到外部；
- (b) 复制时保持原有格式——节点与结构块能够被复制，JSON 数据也能原样复制。

---

## 2. 目标与非目标

**目标**：让"选中 → 复制 → 粘贴"这条链路在编辑器内、编辑器间、以及编辑器到外部应用三个方向上行为可预期，并且**失败可感知**。

**非目标**（本次不做）：

- 不引入真正的表格节点（改用粘贴侧转换，见 §4 P1-5）；
- 不改变公式的渲染方式与既有交互（公式节点的编辑入口保持不变，仅调整"单击"的选中语义，见 §4 P0-3）；
- 不改动既有日志、复习、评分、备份的任何语义；
- 不引入新的第三方依赖（所需能力均已存在于当前依赖中，见 §4 各条）。

### 2.1 只读态不变量（本方案全程遵守，不可违反）

**需求**：日志与复习界面默认只读，用户不能在其中修改正文。

**现状核对**：全仓库共 4 处 `RichTextEditor` 使用点，只读语义各不相同——

| 位置 | 只读语义 |
|---|---|
| `ReviewPage.tsx:1048-1057` | **恒为只读**（`readOnly` + `onChange={() => undefined}`）——日志 / 复习详情正文 |
| `RecordEditorPage.tsx:1264-1268` | **恒为只读**（预览视图，`readOnly` + 空 `onChange`） |
| `RecordEditorPage.tsx:1159-1162` | `readOnly={interactionLocked}`（`interactionLocked = restoreLocked \|\| draftLoading`，`:218`） |
| `TemplateLibraryPage.tsx:110-112` | 可编辑（模板编辑，带真实 `onChange`） |

**本方案对该需求的四条保证**：

1. **不新增"只读态也能改文档"的路径。** 方案中唯一会改动正文的新增动作是 P0-4 的
   "剪切 = 复制 + 删除"，它**自带强制只读守卫**（§4「P0-4 只读守卫（阻塞项）」）。
2. **其余改动都只读 / 只序列化 / 只改选区。** 选区变化在只读态**本来就是允许的**——
   只读态 Ctrl+C 之所以能用，正是靠"只读态可以有选区"这一前提，因此复制相关改动不构成对只读语义的破坏。
3. **粘贴侧（P1-2 / P1-3）在只读态不生效。** 应用的 `handlePaste`（`RichTextEditor.tsx:1756`）挂在
   `editorProps` 顶层，只经由框架内置 `editHandlers.paste`（`prosemirror-view/dist/index.js:3728`）调用，
   而该内置处理器受 `dispatchEvent` 的 `view.editable` 门控
   （`:3138-3142`；`paste` 属 `editHandlers`）⇒ **只读态不会进入 `handlePaste`**，粘贴类改动无法影响只读页。
4. **不改动日志、复习、评分、备份的任何语义**（§2 非目标已声明，此处重申为可验收项，
   验收口径见 §6、机器判据见 §7）。

**但同一道门控不覆盖自定义处理器**（`runCustomHandler` 不检查 `view.editable`，`:3121-3126`），
因此 §4「P0-4 只读守卫」同时列出了**一条既有的无守卫写入路径**，须在实施 P0-4 时一并加固。

---

## 3. 根因清单

| ID | 根因 | 证据等级 | 依据 |
|---|---|---|---|
| **RC-1** | 选区落进 `contentEditable=false` 的节点视图时，ProseMirror 选区为空、DOM 选区被浏览器坍缩；复制处理器在 `if (!slice) return false` 处静默返回，**不写剪贴板也不改动它**，于是剪贴板保留旧值——用户会误以为复制成功，粘出旧内容 | `[观测]` | `src/components/RichTextEditor.tsx:1661-1668`；`prosemirror-view/dist/index.js:3668-3669`（`if (sel.empty) return`）。探针观测：复制前写入哨兵值，复制后读回仍为哨兵值 |
| **RC-2** | 单击公式卡片会立即进入编辑态（焦点落入 `<textarea aria-label="块公式">`），**不产生节点选中**，因此"点了公式想复制它"这个手势永远拿不到选区 | `[观测]` | `src/components/RecordEditorNodes.tsx:136-140`、`:203-207`（`onClick` 内 `if (editable && !editing) setEditing(true)`） |
| **RC-3** | 文本通道的叶子节点序列化回调只识别两种公式节点，其余原子节点一律落到 `node.type.spec.leafText?.(node) ?? ""`，**而全仓库没有任何节点定义 `leafText`** ⇒ 结构块、图片、引用、制表位在 `text/plain` 与 `text/markdown` 里静默变成空串 | `[观测]` | `src/components/RichTextEditor.tsx:455-465`；`grep -rn leafText src` 只命中 `:464` 这一处消费点。探针观测：含对比表的选区在文本通道无任何表格内容 |
| **RC-4** | `recordTabStop.renderText()` 被 Tiptap 挂载为 `schema.toText`，而 ProseMirror 的 `textBetween` 只认 `isText` 与 `spec.leafText` ⇒ 制表位在文本通道同样是空串。这条极易被误判为"已修" | `[源码]` | `src/components/RecordEditorNodes.tsx:506`；`@tiptap/core/dist/index.js:507-509`；`prosemirror-model/dist/index.js:121-123` |
| **RC-5** | `text/markdown` 与 `text/plain` 被赋成同一个字符串，内容来自 `textBetween` ⇒ 加粗、标题、列表、引用等格式信息**全部不进 markdown 通道** | `[观测]` | `src/components/RichTextEditor.tsx:455-465`。探针观测：`# 标题` 复制后为 `标题` |
| **RC-6** | `text/html` 通道对公式与结构块使用自定义标签（`<record-inline-math>`、`<record-formula>`、`<record-comparison-table data-json=…>`），外部应用不识别、标签无文本内容 ⇒ 粘到 Word / 浏览器 / 聊天工具**渲染为空白**。但该通道对本应用是**完整无损**的（各节点的 `renderHTML` 属性与 `parseHTML` 回读键一一对应） | `[观测]` | `RecordEditorNodes.tsx:365-367 / 338-352`、`:421-423 / 399-408`；`RecordStructureNodes.tsx:918-920 / 900-911`、`:947-949 / 934-941` |
| **RC-7** | 应用内"复制 → 粘贴"会丢失结构块：粘贴处理器在 `markdown \|\| plainText` 存在时抢先短路并走 Markdown 解析，而该载荷本身就是有损的。**ProseMirror 在调用应用处理器之前就已经把 `text/html` 解析成了无损切片并作为第三个参数传入，应用的处理器签名 `(view, event)` 把它丢弃了** | `[源码]` | `prosemirror-view/dist/index.js:3728→3738`（取出 html）`→3709`（`parseFromClipboard` 用 schema 解析）`→3710`（切片作为第三参传入）；`src/components/RichTextEditor.tsx:1756`（签名）、`:1776-1794`（短路分支） |
| **RC-8** | 剪切与复制行为不一致：Ctrl+C 走编辑器自定义处理器（写 `text/html` + `text/markdown` + `text/plain`，且有 DOM 选区兜底），Ctrl+X 走 ProseMirror 内置共享处理器（只写 `text/html` + `text/plain`，只用状态选区、无兜底），随后删除选区。**并且只读态下 Ctrl+X 完全无动作**，而同一状态下 Ctrl+C 可用 | `[源码]` | `prosemirror-view/dist/index.js:3665`（`handlers.copy = editHandlers.cut`）、`:3907-3908`（合并注册）、`:3138-3141`（分发门控：`editable` 只门控 `handlers[event.type]`，不门控 props）。应用侧 `handleDOMEvents` 共 **7 个键（`copy` / `dragstart` / `pointerdown` / `touchstart` / `keydown` / `beforeinput` / `input`，`RichTextEditor.tsx:1661-1754`）且不含 `cut`**，全文检索无 `cut` 处理器 |
| **RC-9** | 位置换算 `view.posAtDOM(...)` 在目标位置不落在文档内时**抛 `RangeError`**，而这两处调用位于 try 之外；ProseMirror 的自定义事件处理器**不捕获异常** ⇒ 异常会让整个复制流程在 `preventDefault()` 之前中断，表现为"什么都没写" | `[源码]` | `src/components/RichTextEditor.tsx:486-487`；`prosemirror-view/dist/index.js:5774-5777`（抛错）、`:3121-3126`（`runCustomHandler` 无 try/catch） |
| **RC-10** | 复制处理器在判断 `clipboardData` 是否为空**之前**就执行了 `preventDefault()`，且随后 `return true` 会跳过框架自身的兜底 ⇒ 极端情况下"取消了默认行为，却什么都没写" | `[源码]` | `src/components/RichTextEditor.tsx:1669-1680`。注：在当前 Electron / Chromium 环境下该分支不可达，属健壮性缺陷 |
| **RC-11** | schema 中不存在表格节点，用户看到的"表格"是原子节点 `recordComparisonTable`（数据存于 `data-json`）⇒ 从外部粘贴的 `<table>` 会塌成一串独立段落 | `[观测]` | `package.json` 编辑器相关依赖清单中无表格扩展；`RecordStructureNodes.tsx:893-900` |
| **RC-12** | 桌面端无右键菜单：主进程未引入 `Menu`、未监听 `context-menu`，渲染层全域亦无 `contextmenu` 监听。**该缺口仅存在于桌面端**——浏览器对 `contentEditable` 区域提供原生右键菜单（剪切 / 复制 / 粘贴 / 全选），网页版用户不受影响 | `[源码]` | `desktop/main.cjs:1`（import 列表无 `Menu`）、`:994`、`:1024`、`:1039`；`desktop/preload.cjs` 无相关通道；`grep -rn contextmenu src` 零命中。浏览器侧为平台已知行为 |
| **RC-13** | 拖拽被显式阻断：`dragstart` 处理器无条件 `preventDefault()` 并 `return true`——该处理器作为 props 先于框架内置处理器执行，**单独即足以阻断全部拖拽**。另有 9 处 `spec.draggable: false` 与根节点 `draggable="false"`；其中根属性对"文本选区拖出"的**独立**作用尚无实测 | `[源码]` / `[待验证]` | `RichTextEditor.tsx:1659`、`:1682-1685`；`prosemirror-view/dist/index.js:3138-3141`（props 优先）、`:3380-3398` |
| **RC-14** | 现有测试把缺陷写成了契约：`RichTextEditor.test.tsx:2360` 断言 `text/markdown` 与 `text/plain` 相等；全文没有任何一处针对剪贴板 `text/html` 载荷的断言 ⇒ 缺陷被测试固化，修复前必须先改断言 | `[源码]` | `src/components/RichTextEditor.test.tsx:2360`（所在用例自 `:2320` 起） |
| **RC-15** | 三个**容器型**自定义块的属性不进文本通道：`recordHighlightBlock`（`content: "block+"`）的 `tone`、`recordCollapseBlock` 的 `title` / `summary`、`recordDecisionBlock` 的 `decisionBlockId` 等标识属性都只存在于属性中，而 `textBetween` 只拼接子节点的文本 ⇒ **正文不丢，但块自身的信息丢了**。需求 (b) 的"结构块能够被复制"因此只完成一半 | `[源码]` | `RecordHighlightBlockNode.tsx:218-233`（`content: "block+"`、`data-tone`）；`RecordStructureNodes.tsx:956-984`（`data-title` / `data-summary`）；`RecordDecisionBlockNode.tsx:125-158`（`content: "block+"` + 标识属性）；`prosemirror-model/dist/index.js:121-134`（`textBetween` 对非同叶节点只递归内容） |

---

## 4. 修复方案

### 第 0 阶段：先建立可复现证据（不改产品代码）

**RC-1 同时存在两个都能产生同一现象的原因**：(i) 位置换算抛出 `RangeError`（RC-9）；
(ii) 取到的内容为空提前返回（RC-1）。二者在处理器里表现完全一致，**只看结果无法区分**，因此必须先用一条判别性测试定论，否则后续"先修哪一处"只能是猜测。

| 编号 | 动作 | 说明 |
|---|---|---|
| **O-1** | 新增判别性测试：在复制过程中监听运行时未捕获异常（Playwright 为 `page.on("pageerror")`）。有未捕获异常 ⇒ 成因 (i)，转入 P0-2；无异常但剪贴板为空 ⇒ 成因 (ii)，转入 P0-1 | **必须最先完成**，它决定 P0 的归属 |
| **O-2** | 以正式回归测试的形式重建剪贴板探针（覆盖三／四通道 + 只读态各一遍，见 §7） | 一次性探针不作为交付物留存 |
| **O-3** | 确认桌面端可执行环境：当前 `node_modules/electron/dist` 不存在（依赖已声明但二进制未下载），桌面侧行为无法真机验证。需先决定是否安装 | 影响 RC-12 / RC-13 的验收方式 |

### P0 —— 缺陷修复（维护范围内，无契约变更）

| 编号 | 对应根因 | 动作 | 位置 |
|---|---|---|---|
| **P0-1** | RC-1、RC-10 | 复制取不到内容时：**不做 `preventDefault()`、不调用 `clearData()`**，让系统剪贴板保持原值。**不新增任何"猜测式兜底"**（不要替用户去复制相邻块或最近节点——那会把症状从"没反应"变成"复制错了东西"，并可能覆盖用户上一份仍有用处的剪贴板内容；该场景由 P0-3 在交互层根治） | `RichTextEditor.tsx:1661-1681` |
| **P0-1a** | RC-1 | **失败提示的触发范围必须收窄**，否则会把"消灭静默失败"变成"制造噪音"。只在下列情况提示：① 取到了**非空选区范围**（DOM 选区或状态选区），但**文本通道**（`text/markdown` 与 `text/plain`）为空（正是 RC-3 / RC-4 的场景）；② 位置换算抛出异常被吞（RC-9）。**正常的"空选区按 Ctrl+C"必须保持完全静默**——它在任何编辑器里都是合法的无操作，Android 上误触成本更高。**⚠️ 判据不得写成"三通道全空"**，理由见下方 | `RichTextEditor.tsx:1661-1681` |
| **P0-2** | RC-9 | 将 `view.posAtDOM(...)` 包进 try/catch，异常时返回空让上层走 P0-1 的失败可见路径；`view.state.doc.slice(from, to)` 的既有 try/catch 保留 | `RichTextEditor.tsx:486-487` |
| **P0-3** | RC-2 | 公式卡片交互调整：**单击 = 选中该节点**（产生 `NodeSelection`），**双击 / Enter / 卡片上的编辑按钮 = 进入编辑态**。这是"点了公式想复制它"这一诉求的正解——它让手势本身产生真实选区 | `RecordEditorNodes.tsx:136-140`、`:203-207` |
| **P0-4** | RC-8 | 新增 `handleDOMEvents.cut`：与复制同源（写同一份载荷），随后删除选区。目标是"剪切 = 复制 + 删除"，且**顺带修掉只读态下 Ctrl+X 完全无动作**。**⚠️ 必须带只读守卫——否则会做出"只读页删正文"，见下方「P0-4 只读守卫（阻塞项）」** | `RichTextEditor.tsx` 的 `handleDOMEvents` |

**P0-1 的前置条件（编译期硬约束）**：用户可见的报错必须走 `src/lib/uiError.ts`，而该文件的
`UiErrorContext` 是**闭集**（`uiError.ts:1-12`，共 10 项，不含剪贴板相关上下文），
且 `formatUiError` 的第二参数即声明为该类型（`:49`）、文案表为 `Record<UiErrorContext, string>`（`:18`）。
⇒ **必须先扩展该 union 与文案表，再使用**。这不是可选项：类型系统会直接拒绝未登记的上下文。

**P0-5（测试前置）** | RC-14 | 修改 `RichTextEditor.test.tsx:2360` 的断言（当前它把"markdown 等于 plain"锁成了契约）。**这是 P1-1 的前置硬阻塞**，不先改，后续改动无法落地。

#### P0-4 只读守卫（阻塞项，实施前必读）

**新增 `handleDOMEvents.cut` 会在只读编辑器里同样被调用，而框架不会拦住它的删除派发。**

逐层核实（`prosemirror-view/dist/index.js`）：

| 层 | 行为 | 位置 |
|---|---|---|
| 监听挂载 | `ensureListeners` **只为 `handleDOMEvents` 里登记过的类型**挂监听 ⇒ 一旦登记 `cut`，只读态也会有 `cut` 监听 | `:3114-3119` |
| 自定义处理器 | `runCustomHandler` **不检查 `view.editable`** ⇒ 登记后必被调用 | `:3121-3126` |
| 内置处理器门控 | `(view.editable \|\| !(event.type in editHandlers))` **只门控内置 `handlers`**，不作用于自定义处理器 | `:3140` |
| 派发 | 派发路径**没有 `editable` 判断**（`:5868-5870` 取 `dispatchTransaction`，否则 `updateState`；`updateState` `:5493` → `updateStateInner` `:5496` 均无 `editable` 检查；`dist` 中全部 `editable` 读取点均不在派发路径内） | `:5868-5870`、`:5493`、`:5496` |

⇒ 若把 P0-4 写成"写剪贴板 + `deleteSelection()`"，则只读态 Ctrl+X 会**真的改动文档** —— 而只读编辑器
正是复习页的正文视图（`ReviewPage.tsx:1048-1052` 传入只读）。

**硬性要求**：

1. **守卫依据必须是 `view.editable`（调用时的实际状态），而不是 React 侧的只读 prop**——
   该 prop 与视图状态通过副作用同步（`RichTextEditor.tsx:1881` `editor?.setEditable(!readOnly)`），
   两者可能瞬时不一致；
2. **只读态不得派发任何删除事务**。可选两种写法：① 只写剪贴板、不删除；
   ② 直接 `return false`，交回与复制同源的路径。**两者都满足"不改动文档"这一硬要求**，取其一即可；
3. 可编辑态保持"剪切 = 复制 + 删除"的原语义。

**可达性说明**：只读态下"是否存在非空选区可供删除"取决于文档选区是否被同步进编辑器状态，
本方案未就此下结论；但**守卫与可达性无关，必须加上**——框架不拦、代价是一行判断、风险是删掉用户正文。

#### 同一不变量的既有缺口：原生粘贴入口（实施 P0-4 时一并处理）

上面那道 `view.editable` 门控**只保护内置处理器**。现有 `handleDOMEvents` 里已经有一条**自己会写文档、
且同样没有守卫**的路径，它已在树上，不是本方案引入的：

| 路径 | 现状 |
|---|---|
| `handleDOMEvents.beforeinput`（`RichTextEditor.tsx:1705-1733`） | 仅 `isNativePlatform()` 生效；`inputType === "insertFromPaste"` 时 `preventDefault()` 后调用 `processNativePaste(view, …)`（`:1720`） |
| `processNativePaste`（`:1388-1460`） | **全文无 `view.editable` 判断**，且它**确实会派发写入**：直接派发在 `:1439`（`transaction.insertText`），另经 `replaceSelectionWithSlice`（`:943-955`，派发在 `:954`）写入。同族写入原语还有 `:886` / `:902` / `:940` 三处，由其它粘贴分支共用 |

⇒ **在 Android / iOS 原生端，只读编辑器存在一条未经守卫的粘贴写入路径。** 其实际可达性受浏览器的
`contenteditable="false"` 保护（不可编辑元素通常不会派发 `beforeinput`），因此在浏览器与桌面端表现为不可达；
**但这一层保护来自平台，不来自本仓库**。

**处理要求（与 P0-4 同批，成本同样是一行判断）**：

- 在 `processNativePaste` 入口（或 `beforeinput` 的原生粘贴分支）加同一判据 `view.editable`，
  非可编辑时直接返回、不派发任何事务；
- **`RichTextEditor.tsx` 全文当前没有任何一处读取 `view.editable`**（`grep '\.editable\b'` 零命中），
  因此这是一处净新增的保护，不会与既有判断冲突；
- 实施 P1-2 / P1-3 时**不得放宽**这条守卫：粘贴载荷变强（真 Markdown、结构无损切片）后，
  被误用的后果只会更严重。

**验收**：§6 的"只读页零改动"新增覆盖 Ctrl+V 一列；§7 的机器判据同样以"文档序列化前后完全一致"表述。

### P1 —— 让复制产物真正可用（需范围决定，见 §8）

| 编号 | 对应根因 | 动作 | 位置 |
|---|---|---|---|
| **P1-1** | RC-3、RC-4、RC-15 | 文本通道改为**按节点名分派**：结构类节点委托给仓库**已有**的转换函数（`recordStructureBlocks.ts:201` 的 `structureBlockPlainTextFromElement` / `:215` 的 `structureBlockMarkdownFromElement`，以及 `recordContent.ts:283` 的 `parseLinearRecordContent` 这条既有链路），并补齐 `recordMermaidDiagram` / `recordAsset` / `recordReference` / `recordTabStop` 的文本表示。**另须处理 RC-15 的三个容器型块**：`recordHighlightBlock`、`recordCollapseBlock`、`recordDecisionBlock` 自身只带属性、不带文本，需为其补标题 / 语气等可读表示（若选 D-4 的"给机器读"，则改为输出结构化记号）。**⚠️ 不要把 `leafText` 加到全局 schema 上**——仓库另有一处 `textBetween` 调用（`RichTextEditor.tsx:1569`，Android 输入法漏发粘贴事件时的"是否已被替换"判据）会回落到 `spec.leafText`，全局改动会移动它的判据基准。改动收在复制路径内 | `RichTextEditor.tsx:455-465` |
| **P1-2** | RC-5 | 产出**真正的 Markdown**：使用已在依赖中且已在使用的 `prosemirror-markdown`（`package.json:79`；`src/lib/markdownEditor.ts:2`），**不新增依赖**。标准标记走 Markdown 语法，结构块委托 P1-1 的既有函数。**⚠️ 连带风险**：粘贴端会优先解析 markdown 载荷，载荷变强后**必须重测往返**，否则正文里字面的 `**foo**`、`#` 会被误解析成格式 | `RichTextEditor.tsx:455-465` + 解析侧 |
| **P1-3** | RC-7 | 应用内粘贴**接住第三个参数**：`handlePaste` 的签名接上框架传入的切片（该参数本来就是顶层 `editorProps` 属性，收得到），当切片含本应用自定义节点类型且不涉及文件时，直接派发该切片，实现应用内**结构无损**往返。**不需要手写 HTML 解析、不需要新增依赖、不需要改动复制端。** 完整要求见下方「P1-3 实现契约」 | `RichTextEditor.tsx:1756` |
| **P1-4** | RC-6 | `text/html` 为公式补一份**通用表示**，收敛为**只输出 MathML**（**不要把"KaTeX 静态 HTML"作为等价选项**——它依赖 `katex/dist/katex.min.css` 的类名与字体（`DeferredMath.tsx:5`），离开本应用后该样式表不存在，贴进 Word / 微信仍然失真，可能比现在的空白更难解释）。**成本很低**：`katex.renderToString` 默认 `output: "htmlAndMathml"`，而 `DeferredMath.tsx:84` 调用时**没有覆盖** `output` ⇒ 那份含 `<annotation encoding="application/x-tex">` 的 MathML **现在就已在渲染产物里**，只是没进剪贴板（剪贴板走 `renderHTML`，不经过节点视图） | 复制端序列化后处理 |
| **P1-5** | RC-11 | 不引入真表格节点，改用粘贴侧转换：把外部 `<table>` 转成 `recordComparisonTable`（`transformPastedHTML` 当前不存在，需新增）。**⚠️ 这是一条新增的数据来源**：该节点此前只能由工具栏产生，内容是受控的；此后外部表格的单元格文本会首次进入该结构，而单元格文本可能含竖线、换行、HTML 实体，恰好打在既有序列化器的薄弱处——`comparisonTableToMarkdown`（`recordStructureBlocks.ts:172-182`）用竖线直接拼接表头与每一行（`row.join` 之后套竖线模板），**未对单元格内容做任何转义**，含竖线或换行的单元格会破坏列数；`comparisonTableToPlainText`（`:162-169`）同样未转义。而这些数据会流经知识导出与 AI 上下文链路。⇒ 实施时必须**先补转义**，并加一条往返断言（见 §7） | 粘贴端 + `recordStructureBlocks.ts` |
| **P1-6** | 需求 (b) | 新增自定义 JSON 载荷（如 `application/x-studyjournal+json`），承载节点与结构块原始数据，满足"JSON 原样复制"。**说明**：P1-3 落地后，应用内往返已由 `text/html` 通道覆盖无损；本条主要服务于"复制到应用之外 / 交给其他工具或 AI"的场景，可按实际需要取舍 | 复制端 + 粘贴端 |

#### P1-3 实现契约（必须完整照做）

**① 判据：只认"切片含本应用自定义节点类型"。**

遍历切片内容，对节点类型名做白名单判定（`recordFormula` / `recordInlineMath` / `recordComparisonTable` /
`recordStickyBoard` / `recordStructureDiagram` / `recordMermaidDiagram` / `recordAsset` / `recordReference` /
`recordTabStop` / `recordCollapseBlock` / `recordHighlightBlock` / `recordDecisionBlock`）。
按类型名遍历比匹配 HTML 字符串更稳（不受属性顺序、转义形式影响）。

**⚠️ 不得使用 `data-pm-slice` 作为判据。** 该标记**不是本应用独有**——任何 ProseMirror / Tiptap 应用
输出剪贴板时都会写它（它由框架的序列化器写在首个子元素上）。用它做判据会把"从别的 ProseMirror 应用
粘贴"也拉进直派通道，直接违反"不改变外部粘贴既有行为"这条不变量。

**② 派发契约（不照做会引入撤销语义回归）。**

框架在兜底路径上的自行派发**不带任何历史控制**
（`prosemirror-view/dist/index.js:3714-3718`：`view.dispatch(tr.scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"))`），
而本应用既有的 **7 处**粘贴派发点（`RichTextEditor.tsx:886 / 902 / 940 / 954 / 1439 / 1773 / 1789`）
**全部**经过 `applyPasteHistoryMode`。因此直派通道必须自己补齐：

| 项 | 要求 |
|---|---|
| **(a) 尺寸代理** | `pasteHistoryMode` 的入参与阈值的定义域是**文本源**（`src/lib/markdownPasteWork.ts:18` 的 `MAX_UNDOABLE_PASTE_BYTES = 512 * 1024`，按 UTF-8 字节长度；`:22` / `:24`）。切片路径没有现成的文本源，必须**显式指定代理量**：建议 `serializeClipboardText(slice)` 的字节长度（与既有路径同源、同一量纲）。**并须在实现处写明这是代理量**：真实载荷（HTML）通常更大，代理会低估，二者不是同一对象 |
| **(b) 过历史模式** | `view.dispatch(applyPasteHistoryMode(transaction, pasteHistoryMode(代理文本)))`（`RichTextEditor.tsx:271-276` 判定、`:295-304` 应用）。这样超限粘贴才会与 markdown 路径一致地被设为 `addToHistory: false` |
| **(c) 保留粘贴语义元数据** | `.setMeta("paste", true).setMeta("uiEvent", "paste")`。本仓库当前零依赖这两个键，省略暂不出错，但它们是框架用于标识粘贴的官方语义，保留才能让后续插件正确判定 |
| **(d) 滚动** | `.scrollIntoView()` |

**③ 否定性约束：不要再手动调用一次 `renewDecisionBlockIdentities`。**

框架在切片交给处理器**之前**就已经应用过 `transformPasted`
（`prosemirror-view/dist/index.js:2889`），而本应用的 `transformPasted` 正是
`renewDecisionBlockIdentities`（`RichTextEditor.tsx:1656`）。⇒ 切片到达 `handlePaste` 时决策块 id **已经重发过**，
直派时**不得再调用一次**，否则 id 会被重生两次。这一条必须写进实现说明：照抄既有约定很容易产生"补一次 renew"的动作。

**④ 与既有粘贴机制的协同**：直派前先取消未完成的流式粘贴会话——现成函数是
`cancelPendingPaste(view)`（`RichTextEditor.tsx:1272`，内部转 `cancelMarkdownPasteConversion` `:1106`）。
粘贴分支里已有多处同款调用（例如 `:1771`）。**照抄既有调用即可，不需要另行设计。**

**⑤ 判据为何不能写"三通道全空"（P0-1a 的实现约束）**：`text/html` 来自
`view.serializeForClipboard(slice)` 的 `dom.innerHTML`（`RichTextEditor.tsx:1669`、`:1673`），
**非空选区必然产出非空 DOM** —— 即使只是 `<record-tab data-width="4" aria-label="缩进"></record-tab>`
（`RecordEditorNodes.tsx:502-504`）或 `<record-comparison-table data-json=…>`。
这正是 RC-6 所说的"`text/html` 对本应用完整无损"。⇒ **"三通道全空"在该场景下永不成立**，
而恰是被 RC-3 / RC-4 伤害的那一类内容永远不会弹提示，等于把"消灭静默失败"又变回静默。
**判据必须只看文本通道**（`text/markdown` 与 `text/plain`；注意二者当前是同一个字符串，见 RC-5）。

### P2 —— 能力新增（需范围决定，见 §8）

| 编号 | 对应根因 | 动作 |
|---|---|---|
| **P2-1** | RC-12 | 桌面端右键菜单：主进程新增 `Menu.buildFromTemplate` 与 `webContents.on('context-menu')` → `popup`，菜单项用系统预设角色 `copy / cut / paste / selectAll / pasteAndMatchStyle`。需在主进程 import 中补上 `Menu`。**约 20 行，无需新增渲染层 IPC 通道。** 网页版与移动端无需处理（前者有浏览器原生菜单，后者有系统长按菜单）。**⚠️ 菜单项走的是系统角色 → 最终仍会落到编辑器自己的 `cut` / 粘贴处理器上 ⇒ 只读页上的"剪切"必须同样被 §4 的守卫拦住**，否则右键菜单会绕过键盘路径把正文删掉；菜单项本身也应依据焦点编辑器是否可编辑来置灰 |
| **P2-2** | RC-13 | 拖拽：**只做"外部文件拖入"**（接入既有的 `insertPastedAssets`），**不做结构块的拖拽排序**。需在渲染层自行接管 `dragover` / `drop`，否则事件会被主进程的 `will-navigate` 处理吃掉。同时把 `dragstart` 的无条件 `preventDefault()` 改为条件阻断（仅在拖出编辑器区域时阻断） |
| **P2-3** | 一致性 | `Ctrl+A` 语义统一：当焦点在编辑器内但落点是结构块单元格时，统一为编辑器全选。**注意**：单元格是真 `<input>` / `<textarea>` 宿主，改动会让用户无法用 `Ctrl+A` 一键清空单格文本 ⇒ 列为待决事项（§9），不默认实施 |

**关于"跨端右键菜单一致性"的说明**：另一种做法是在渲染层自绘菜单，好处是三个平台外观一致、并可加入"复制为 Markdown""复制为 JSON"这类扩展项。但它需要以 `document.execCommand` 让浏览器派发真实事件来复用现有处理器（编辑器没有命令式的复制/粘贴命令），且 `execCommand('paste')` 在 Electron 下受限制、需先实测。**由于右键菜单在浏览器端本来就由平台提供，桌面端是唯一缺口，因此该做法属可选增强，不是必需项。**

---

## 5. 实施顺序与依赖

```
O-1（判别性测试，定论 P0 归属）
  ├─→ P0-2（位置换算加 try/catch）
  └─→ P0-1 / P0-1a（失败可见化 + 提示范围收窄；依赖：uiError 上下文先扩表）
O-2（重建回归测试，三／四通道 + 只读态，见 §7）
O-3（环境前置：Electron 二进制）
P0-3（单击 = 选中）──→ P0-4（补 cut，与 copy 同源，**必带只读守卫**）+ 原生粘贴入口守卫（同批、同判据）
P0-5（先改 :2360 断言）──→ P1-1（含 RC-15 三个容器块）──→ P1-2（真 Markdown；改完必须重测往返）
P1-3（接住粘贴切片 + 实现契约 + 两条否定性约束）← 依赖 §3 RC-7，无前置
P1-4（MathML）／ P1-6（JSON 载荷，可选）
P1-5（外部表格转换）← **须先补 recordStructureBlocks 的单元格转义**，否则不得开工
P2-1 / P2-2（相互独立；P2-2 依赖主进程 will-navigate 的现状确认）
```

**硬性顺序约束**：

1. `O-1` 必须最先执行——它决定 P0-1 与 P0-2 谁是真因；
2. `P0-5` 必须先于 `P1-1` / `P1-2`——否则测试会拦下正确的修复；
3. `P1-1` 必须先于 `P1-2`——Markdown 序列化要复用文本序列化的分派结果；
4. `P1-5` 的**转义改造必须先于**其粘贴转换逻辑——否则新数据源会直接污染导出链路；
5. `P0-1a` 与 `P0-1` 同一处改动，但**提示范围收窄**是独立验收点（正常空选区必须静默）；
6. **只读不变量（§2.1）横切所有阶段**：任何一条改动在只读实例上落地前，都必须先确认它不会写文档；
   P1-2 / P1-3 使粘贴载荷变强，实施时必须回看 §4「原生粘贴入口」一节的守卫要求。

---

## 6. 验收标准

| 场景 | 期望 |
|---|---|
| 拖选一段含文字、行内公式、块公式、对比表、结构图、图片、折叠块、高亮块、决策块的内容，Ctrl+C 粘到外部编辑器 | 文字与公式**可见且正确**；结构块以可读文本或表格语法呈现；**三个容器型块的标题 / 语气也应可见**；应用内粘回后各节点数量与类型完全一致 |
| 单击公式卡片后按 Ctrl+C | 剪贴板含该公式的 LaTeX 源（`$x^2$` / `$$\ny=mx+b\n$$`） |
| 应用内复制 → 粘贴 | 结构块、公式节点、任务列表、折叠块**全部保留**，DOM 统计与复制前一致；**撤销行为与既有 markdown 粘贴路径一致**（超限粘贴不进撤销栈） |
| **空选区内按 Ctrl+C** | **完全静默的无操作**：不写剪贴板（保留原值）、**不弹任何提示**。空选区复制在任何编辑器里都是合法无操作 |
| 有选区但复制产物为空（如全部落在未支持的原子节点上） | 剪贴板保持原值，并给出**一次**可见提示——这才是"失败可感知"的目标场景 |
| 只读（复习 / 预览）页内选中文本复制 | 三通道载荷齐全且 LaTeX 正确（只读态复制本来就是既有能力，必须保持不变） |
| **只读（复习 / 预览）页内按 Ctrl+X** | **文档内容零改动**（正文节点数量、文本、结构前后完全一致）；不出现任何删除 / 替换。这是 P0-4 只读守卫的专属验收项 |
| **只读（复习 / 预览）页内按 Ctrl+V**（含 Android / iOS 原生端输入法粘贴路径） | **文档内容零改动**；可写入剪贴板之外不产生任何编辑事务。这是 §4「原生粘贴入口」守卫的专属验收项 |
| **只读页的"能否复制"不因本次改动而降低** | 改动前能复制的场景，改动后仍能复制；不得以"加了守卫"为由把只读态复制一起关掉 |
| 记录编辑器在**未锁定**状态（`interactionLocked === false`） | 剪切 / 粘贴 / 拖拽等既有编辑行为**完全不变**，交付前须逐项回归 |
| 桌面端在编辑区右键 | 弹出系统菜单，含剪切 / 复制 / 粘贴 / 全选 |
| `text/markdown` 通道 | 标题、加粗、列表、引用、代码块以真实 Markdown 语法呈现（不再是纯文本） |
| 粘贴含竖线与换行的外部 `<table>` | 转成对比表后，再导出为 Markdown / 纯文本**列数不破坏**、内容不串行 |

---

## 7. 回归测试要求

**单元测试**

- 断言通道：**若实施 P1-6 则四条**（`text/html`、`text/markdown`、自定义 JSON 载荷、`text/plain`），
  **否则三条**（`text/html`、`text/markdown`、`text/plain`）。P1-6 是可选项（D-6），验收口径须随之一致；
- 覆盖三种起始选区状态：**空选区** / **落点在原子节点内** / **正常文本拖选**；
- **只读态各跑一遍**（只读分支与可编辑分支的事件路径不同）；
- **只读态"零改动"的机器判据**：对只读编辑器依次触发 `copy` / `cut` / 原生粘贴（`beforeinput` +
  `inputType: "insertFromPaste"`），每次断言 `view.state.doc` 的序列化结果前后**完全一致**
  （这一条同时覆盖 P0-4 的 `cut` 守卫与 `processNativePaste` 的粘贴守卫）；
- **可编辑态不得被守卫误伤**：同样的 `cut` / 粘贴序列在 `readOnly={false}` 的实例上必须**照常生效**
  （守卫写反成"恒不派发"时，这一条会转红）；
- 覆盖"含结构块 + 公式 + 图片 + 引用 + 制表位"的混合选区，逐类断言其文本表示非空；
- **覆盖 RC-15 的三个容器型块**：混合选区含 `recordHighlightBlock` / `recordCollapseBlock` / `recordDecisionBlock`
  时，断言其标题 / 语气等可读信息在文本通道**是否可见**（当前预期为不可见，实施 P1-1 后应为可见）；
- **覆盖 P1-5 的转义往返**：构造单元格含竖线、换行、HTML 实体的外部表格 → 对比表 → Markdown / 纯文本，
  断言列数不破坏、内容不串行。

**端到端测试**

- 使用**真实系统剪贴板**并配合**哨兵值**手法（复制前写入哨兵，复制后读回判定），
  覆盖"点公式卡片后 Ctrl+C"与"拖选跨过行内公式"两个场景；
- 需要 `permissions: ["clipboard-read", "clipboard-write"]`；
- **判别性测试（O-1）必须纳入常规回归**，不能是一次性脚本；
- **P1-3 的撤销语义**需单独覆盖：构造超限大小的应用内复制载荷，断言其粘贴事务
  与 markdown 路径同样不进撤销栈；
- **P0-4 的只读守卫**需单独覆盖：在只读编辑器里构造选区后触发 `cut`，
  断言**文档序列化前后完全一致**（这是"零改动"的机器可判定形式）；
- **原生粘贴入口的守卫**需单独覆盖：在只读编辑器里派发 `beforeinput`（`insertFromPaste`），
  断言文档序列化前后完全一致；同一用例在 `readOnly={false}` 的实例上必须**产生实际写入**（判别性对照）；
- **只读态复制不得回归**：只读编辑器内选中文本触发 `copy`，断言载荷仍齐全（守卫类改动最易误伤这里）。

**取证注意**

- 浏览器 API `navigator.clipboard.read()` 只暴露 `text/plain` 与 `text/html`，**不暴露 `text/markdown`**。
  判断"是否写入了 markdown"必须读取事件对象上的 `clipboardData.types`，否则会得到假阴性。

---

## 8. 范围与治理

本仓库自 2026-09-15 起处于**功能冻结（维护态）**状态，除已登记的每日计划例外范围外，新增功能需要一次明确的范围（解冻）决定。

因此本方案按性质分档：

- **P0（缺陷修复）**：属于维护范围。修复的是既有功能的错误行为（静默失败、异常中断、交互与行为不一致），不新增用户可见能力、不改动数据契约，可直接实施。
- **P1（复制产物可用性）**：改变了剪贴板载荷的内容形态（`text/markdown` 由纯文本变为真 Markdown，新增 JSON 载荷），属**行为变更**，需要范围决定。
- **P2（右键菜单、拖拽）**：属**能力新增**，需要范围决定；建议以一份简短的范围说明文档登记后再实施。

**贯穿约束（不得违反）**：

- 保持本仓库的 StudyJournal 品牌、包名 / 应用标识、签名兼容性与数据路径稳定；
- 不改动 schema 版本、存储结构、云同步载荷、备份格式；
- 不新增第三方依赖（本方案所需能力均已存在于当前依赖中）；
- 实施完成后，须同步更新 `AGENTS.md`（仓库的代码/产品事实权威）与 `CHANGELOG.md`。

---

## 9. 待决事项

**当前状态：本文暂缓实施，下列选项均尚未选定。** 待决定后开工。

**读法：只有 D-1 是硬性必需项。** 其余各项方案都已给出默认值，标注为"不阻塞"；
若不另行表态，实施时按默认值执行。

| 编号 | 事项 | 选项 | 方案默认 | 是否阻塞开工 |
|---|---|---|---|---|
| **D-1** | **本次改动的范围**（同时决定是否需要一份范围说明文档） | ①只做 P0（缺陷修复，维护范围内）；②补范围说明文档，一次做完 P0 → P2；③先做 P0 + P1，暂不动 P2 | **无默认，必须决定** | **是（唯一硬性项）** |
| **D-2** | 公式卡片"单击"的语义 | ①**单击 = 选中该节点**、双击 / Enter / 卡片上的编辑按钮 = 进入编辑态；②保持"单击 = 编辑"，复制公式改由右键菜单提供 | ① | 否（但会改变既有交互习惯，建议确认） |
| **D-3** | `Ctrl+A` 在结构块单元格内的语义 | ①统一为编辑器全选；②保持"选中当前单元格文本"的原生行为 | ②（保持现状） | 否（仅 P2 生效） |
| **D-4** | `text/plain` 通道的定位 | ①给人读（结构块输出可读文本）；②给机器读（输出结构化记号，便于程序解析） | ① | 否（仅 P1-1 生效，且可后调） |
| **D-5** | 是否安装桌面端可执行环境（`node_modules/electron/dist` 当前缺失） | ①安装，桌面侧可真机验收；②不安装，桌面侧断言仅静态给出并在验收记录中标注 | ② | 否（影响 P2 验收与 RC-13 的 `[待验证]` 能否关闭） |
| **D-6** | 是否实施 P1-6（自定义 JSON 载荷） | ①实施；②不实施（应用内无损往返已由 P1-3 覆盖） | ② | 否（仅影响 §7 的通道数量） |
| **D-7** | 只读态（复习页）按 Ctrl+X 的行为 | ①只写剪贴板、不删除（与只读态 Ctrl+C 可用保持一致）；②不写剪贴板、直接交回（保持"只读页 Ctrl+X 无动作"） | ① | 否（两者的硬要求相同：**不得改动文档**） |

**关于 D-2 的依赖警告**：若选 ②，会让 P0-3 依赖 P2-1（右键菜单属能力新增、需范围决定），
造成依赖倒置、P0 无法独立交付，并与 §5 的顺序图冲突。**选 ② 必须在 D-1 里同时把 P2-1 前移**。

**关于 D-7**：无论选 ① 还是 ②，**只读态不得派发任何删除事务**这一条都是硬要求（见 §4「P0-4 只读守卫」）；
D-7 决定的只是"只读态 Ctrl+X 要不要顺手把内容放进剪贴板"。

**关于只读态的粘贴**：**不设决策项**。只读编辑器不得被写入是硬要求（§2.1 第 4 条），
没有"允许写入"这一选项；须做的只是把已有的原生粘贴入口补上守卫（§4「原生粘贴入口」）。
唯一的相关取舍是"只读态 Ctrl+V 要不要提示不可编辑"——**默认不提示**（静默无操作），
理由是它与只读态 Ctrl+C 可用并不矛盾，且弹提示会让只读浏览变得吵闹。

---

## 10. 风险与注意事项

1. **不要用全局 schema 改动去修文本序列化。** 全局添加 `spec.leafText` 会同时改变
   `RichTextEditor.tsx:1569` 处 Android 输入法粘贴判据的基准；改动必须收在复制路径内。
   （另有一处 `RichTextEditor.tsx:822-823` 的 `rawMarkdownText` 因其第 4 个实参为**字符串**，
   根本不查询 `spec.leafText`，**不受影响**——注意不要把它列为受影响点。）
2. **Markdown 载荷变强会引入往返风险。** 粘贴端优先解析 markdown，需以"含字面 `**`、`#`、`- ` 的正文"
   构造用例重测，避免正常文本被误识别为格式。
3. **只读态与可编辑态的事件路径不同**，不能用一侧的通过结果推断另一侧。
4. **桌面端与网页端的行为基线不同**：右键菜单、`will-navigate` 拦截、剪贴板访问权限都存在平台差异，
   验收时须分别声明在哪个端上通过。
5. **`electron` 二进制未安装**时，桌面侧断言只能静态给出，须在验收记录中如实标注。
6. **一次性排查脚本不作为交付物留存**；其观测到的载荷快照与计数需先写入文档再清理现场。
7. 本方案不改变公式的既有渲染与编辑入口；P0-3 只调整"单击"的选中语义，需同步回归公式相关的既有用例。
8. **`P1-5` 改变了数据来源的边界。** 对比表数据此前只由工具栏产生、内容受控；此后外部表格成为新的写入源，
   而既有导出函数（`recordStructureBlocks.ts:162-182`）未对单元格内容转义。**实施 P1-5 前必须先补转义并加往返断言**，
   否则损坏的数据会经知识导出与 AI 上下文链路扩散。该风险尚未实测，属实施时须优先验证的一项。
9. **P1-3 的两条否定性约束**（易被"顺手"违反）：① **判定通道时不得使用 `data-pm-slice`**
   （框架级标记，非本应用独有，会把其他 ProseMirror 应用的粘贴拉进直派通道）；
   ② **直派时不得再手动调用 `renewDecisionBlockIdentities`**（`transformPasted` 在切片送达处理器前已执行过，
   再调一次会让决策块 id 重生两次）。两条都必须写进实现说明。
10. **桌面端右键菜单只需处理桌面端。** 浏览器对 `contentEditable` 区域提供原生右键菜单，
    网页版与移动端（系统长按菜单）均无此缺口；不要把"跨端一致性"当作实施前提。
11. **文档基线**：`docs/editor-clipboard-copy-paste-rootcause-2026-09-18.md` 为排查过程稿，
    其中若干处表述已被本方案取代（旧措辞以引述形式保留在原处，**全文检索可能命中这些引述并被误导**）。
    应以本文为唯一实施依据；该过程稿开头已加注指向本文。
12. **（阻塞项）P0-4 必须带只读守卫。** 自定义 `cut` 处理器**在只读态也会被调用**，
    且框架不拦它的删除派发（核实过程见 §4「P0-4 只读守卫」）。若漏掉守卫，只读的复习页正文会被 Ctrl+X 删掉——
    这是本方案中**风险最高、代价最低**的一条：一行 `view.editable` 判断即可消除。
13. **P0-1a 的判据不要写成"三通道全空"，只看文本通道。** 非空选区必然产出非空 `text/html`
    （RC-6：该通道对本应用完整无损），写成三通道全空会让提示永不触发，等于把失败重新变回静默。
14. **只读要求是"结构性地满足"，不是"碰巧没被触发"。** 自定义处理器不受 `view.editable` 门控，
    所以只读安全必须由**每一处会写文档的处理器自己**保证。方案中新增的写入只有 P0-4 的 `cut`
    （已强制带守卫）；树上另有一条**既有的、无守卫的原生粘贴写入路径**
    （`handleDOMEvents.beforeinput` → `processNativePaste`，见 §4「原生粘贴入口」），
    目前靠 `contenteditable="false"` 这一**平台**保护兜着。⇒ 实施 P0-4 时同批加固，
    且 P1-2 / P1-3 不得放宽。**同时注意不要过度收紧**：只读态复制必须照旧可用（§6 已列为验收项），
    守卫写成"只读就什么都不做"会把 Ctrl+C 一起关掉——那是把一个缺陷换成另一个缺陷。
15. **`RichTextEditor.tsx` 全文没有任何一处读取 `view.editable`**（`grep '\.editable\b'` 零命中），
    因此加守卫是净新增判断，不存在与既有逻辑冲突或覆盖既有行为的问题。

---

## 10. 2026-09-19 收尾实现与验收

- 根因已由浏览器黑盒载荷确认：公式节点在 `text/html` 中原本是空的自定义标签（仅有
  `data-latex`），外部输入框优先读取 HTML 后会丢弃该未知标签；`text/plain` 虽然完整，
  但不能弥补 HTML 通道已被优先采用的情况。
- `src/components/RichTextEditor.tsx` 新增外部 HTML 序列化：保留应用内所需的
  `data-latex`，并把行内公式/块公式分别写成 `$...$` / `$$\n...\n$$` 的可见文本。
- 公式节点边界恢复、原生选区兜底和应用内结构化 HTML 往返保持不变；临时黑盒探针已删除。
- 对“正文 + 折叠块 + 公式”的混合选区，应用内粘贴现在优先解析带 `data-pm-slice` 的本应用 HTML，避免 Markdown/plain-text 通道把折叠块扁平化；可编辑 Ctrl+X 复用相同复制载荷后删除选区。
- 已通过 `RichTextEditor.test.tsx`（当前 118/118）、`e2e/editor-clipboard.spec.ts`（14/14）、
  `tsc -b`、生产构建和 `git diff --check`。

_本文档保留原方案作为历史和后续范围依据；实施状态以本节、源码和 `CHANGELOG.md` 为准。_
