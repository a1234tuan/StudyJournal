# 外部 AI 审计交叉核验：编辑器复制/粘贴

**被核验对象**：另一 AI agent 于 2026-09-18 给出的编辑器剪贴板审计（"结论：这不是一个 bug，是四个互相独立的问题"）
**核验方式**：逐条回源码（`grep -rn` + 读实现 + 读库源码），并对它标注为"待验证"的条目补跑实测
**核验时间**：2026-09-18
**配套文档**：`docs/editor-clipboard-copy-paste-rootcause-2026-09-18.md`（我方的根因与修复方案，已按本轮结论更正）

---

## 1. 结论摘要

| # | 它的核心断言 | 裁定 |
|---|---|---|
| 1 | "快捷键被吞"可以排除（穷举 keymap / `handleDOMEvents.keydown` / window 级 keydown 无 Ctrl+C/V/X/A） | **成立** |
| 2 | R1 右键菜单是**纯缺失**（`Menu` 未 import、无 `context-menu`、preload 无通道、`src/` 零命中） | **成立**（行号全对） |
| 3 | 拖拽是被**显式关闭**的（根上 `draggable:"false"` + `dragstart` 无条件 `preventDefault` + 各节点 `draggable:false`） | **成立**（但"八个"实为 9 处） |
| 4 | `text/html` 对公式是**零内容空元素**（`renderHTML` 只输出属性；PM 用 `DOMSerializer.fromSchema`，不认 React NodeView） | **成立** |
| 5 | "这就是公式复制不出来的**直接原因**" | **部分成立**（过度归因：`text/plain` 里其实带着 LaTeX） |
| 6 | 表格被拍扁是因为 **schema 里没有 table 节点**；用户看到的"表格"是 `recordComparisonTable` 原子节点 | **成立** |
| 7 | `text/markdown` 是**假的**（`textBetween` 产物，加粗/标题/列表全丢，与 `text/plain` 一字不差） | **成立，且比我的报告更锐利** |
| 8 | 7 个原子节点的文本序列化**恒为空**；优先级 `leafText → spec.leafText → ""` | **成立**（引用行号不准，见 §2.8） |
| 9 | `recordTabStop` 的 `renderText()` 被 Tiptap 挂成 `spec.toText`，**不参与** `textBetween` | **成立**（净增值，我未查到） |
| 10 | 现有三个剪贴板测试**只断言 `text/plain`**，缺陷因此长期存活 | **成立，且实际更严重**（见 §2.10） |
| 11 | 静默失败分支：`preventDefault()` 无条件先执行、后判 `clipboardData` 为空；`return true` 绕过 PM 的 `captureCopy` | **成立但不可达**（Chromium/Electron 下 `clipboardData` 恒非空） |
| 12 | 剪切走 PM 默认实现，只写 `html`+`plain`、不写 markdown，与 Ctrl+C 不一致 | **成立**（我初版文档**判错了**这条，见 §3） |
| 13 | R4 点击公式卡片 `setEditing(true)` 抢跑了本应产生的 `NodeSelection` | **成立**（机理表述略偏，见 §2.13） |
| 14 | 只读分支（`ReviewPage.tsx:1048-1052`）需要单独验证，列为待验证项 | **成立且必要**；我已实测（§4 N-6） |
| 15 | 门禁/环境：electron 二进制缺失、`isDesktopPlatform()` 依赖 preload 注入 | **成立**（`electron@43.2.0` 声明、`node_modules/electron/dist` 不存在） |
| 16 | 治理：P0 属维护范围，P1/P2 需 unfreeze 决策 | **成立**（与我独立得出的一致） |
| 17 | 建议 `formatUiError(..., "editor-clipboard")` | **部分成立**（`UiErrorContext` 是闭集，该 key 不存在） |
| 18 | P0-2 建议把结构块序列化成 Markdown/层级文本 | **方向对，但重复造轮子**（仓库已有实现） |
| 19 | P1 用已有 `prosemirror-markdown` 写真 serializer + 新增自定义 JSON 载荷 | **成立且可行**（该包已在用） |
| 20 | "不引入真 table 节点" + 用 `transformPastedHTML` 把外部 `<table>` 转成 `recordComparisonTable` | **成立**（`transformPastedHTML` 确认不存在） |

**一句话总评**：**行号精度与证据链质量都很高（抽查 20+ 处行号，只有 2 处不准），技术结论基本可信**；
主要缺陷不在"事实错"，而在三类：**机制过度归因**（4 处）、**与仓库既有实现脱节**（1 处）、
**把并发现场当成历史遗留**（1 处）。它标为不确定的那一条（只读分支）是**正确的不确定**。
据此：**它的 P0/P1/P2 方向可以采纳，但落地前必须做 6 处修订（§5）。**

---

## 2. 逐条裁定与证据

### 2.1 "快捷键被吞"可排除 —— 成立

我独立复核：`grep -rn "ctrlKey|metaKey" src` 的全部命中为
`RecordEditorNodes.tsx:155/220`、`RecordMermaidNode.tsx:129`、`RecordStructureNodes.tsx:485/808`、
`RecordEditorPage.tsx:284`（`Ctrl+F`）、`RichTextEditor.tsx:1695`（桌面 `Ctrl+F`）、
`ReviewPage.tsx:775`（`Ctrl+Z`，且有 `isEditable` 守卫）、`ReviewAnnotationsSurface`（多选）。
**没有任何一处绑定或拦截 Ctrl+C/V/X/A**。✅ 与它一致。

### 2.2 R1 右键菜单纯缺失 —— 成立（行号全对）

```js
// desktop/main.cjs:1
const { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } = require("electron");
```
- `Menu` **仅**出现在 `autoHideMenuBar` 属性名里（`:994`、`:1024`），全文无 `buildFromTemplate`/`setApplicationMenu`/`menu.popup`。✅
- 主进程 `webContents.on(...)` **只有** `will-navigate`（`:1039`）——另两处 `.on(` 是窗口级 `minimize`(`:1005`)/`close`(`:1012`)。✅ 它"唯一"这个措辞是精确的。
- `desktop/preload.cjs:15-72` 暴露的 API 无菜单/剪贴板通道。✅
- `grep -rn "contextmenu" src --include=*.ts --include=*.tsx` → **零命中**。✅

### 2.3 拖拽被显式关闭 —— 成立，但"八个"实为 9 处

`draggable: false` 精确行号复核（**与它给的完全一致**）：
`RecordEditorNodes.tsx:294/334/395/451/496`、`RecordStructureNodes.tsx:868/897/931`、`RecordMermaidNode.tsx:156` = **9 处**（它写成"八个节点"，算术笔误）。

它把 9 处 `spec.draggable:false` 与 2 个根级配置并列，**结论对**；但下一句的机制归因有偏差：
> "因为全部 spec.draggable 为 false，ProseMirror 自己的拖拽分支（`prosemirror-view/dist/index.js:3381`）也永不进入"

`dist:3381` 是 `mousedown` 里算 `mightDrag` 的位置（条件是
`targetNode.type.spec.draggable && selectable !== false || selection instanceof NodeSelection && …`），
它影响的是**点击选中/拖拽起点判定**，不是"整个拖拽路径"。
真正让拖拽不可能发生的是**根上的 `draggable="false"` 与 `dragstart` 里的无条件 `preventDefault()`**。
→ **部分成立：结论对，主因列错**。

### 2.4 `text/html` 对公式是零内容空元素 —— 成立

`RecordEditorNodes.tsx:365-367`（块公式）与 `:421-423`（行内公式）的 `renderHTML` 只输出属性、无子节点；
PM 的序列化器是 `view.someProp("clipboardSerializer") || DOMSerializer.fromSchema(view.state.schema)`
（`prosemirror-view/src/clipboard.ts:19`），确实只认 `renderHTML`。
实测复制载荷：`<record-inline-math data-formula-id="…" data-latex="e^{i\pi}+1=0"></record-inline-math>`。
⇒ 粘进 Word/浏览器/聊天工具**渲染为空白**。✅

### 2.5 "这就是公式复制不出来的直接原因" —— 部分成立（过度归因）

同一份实测载荷里 `text/plain` 与 `text/markdown` **都带着** `$e^{i\pi}+1=0$`；
而应用自己的粘贴路径（`handlePaste`）在桌面/网页端只读 `text/markdown`/`text/plain`、**从不读 `text/html`**。
所以"公式复制不出来"的真因是**空选区静默失败**（R1 那条）与"跨应用不可读"，
不是"HTML 空元素"导致的"复制不出来"。它是**跨应用互通的缺陷**，不是本问题的直接原因。
→ **部分成立：缺陷成立，因果链过度归因。**

### 2.6 表格拍扁 = schema 无 table 节点 —— 成立

`package.json:50-70` 的编辑器相关依赖只有 `extension-code-block-lowlight` / `extension-placeholder` /
`extension-task-item` / `extension-task-list` / `starter-kit` / `@tiptap/react` / `@tiptap/pm`，
**无 `@tiptap/extension-table`**；`grep -n "prosemirror-tables" package.json` 零命中。
`RecordStructureNodes.tsx:893-900` 是 `RecordComparisonTableNode`（`atom: true`，数据在 `data-json`）。✅
（顺带：`prosemirror-markdown` 在 `package.json:79` ✅，且**确实在用**——`src/lib/markdownEditor.ts:2`。）

### 2.7 `text/markdown` 是假的 —— 成立（本轮最有价值的一条）

`serializeClipboardText`（`RichTextEditor.tsx:455-465`）把 `text/markdown` 与 `text/plain` 赋成同一个字符串，
内容是 `slice.content.textBetween(0, size, "\n\n", leafText)` 的产物。实测复现：Markdown 源里的 `# 剪贴板探针`
复制出来是 `剪贴板探针`（`#` 丢失），加粗/列表/引用同理。
→ **"保持原格式"在 markdown 通道上完全不成立。** 我的初版报告只说到"文本通道丢结构块"，
**这一条它比我说得更准、更狠**，已采纳进我方文档（R10）。

### 2.8 七个原子节点文本序列化恒为空 —— 成立，引用行号不准

- "全仓库没有任何节点定义 `leafText`"：复核 `grep -rn leafText src` → 只命中
  `RichTextEditor.tsx:464`（正是消费它的那行）。✅
- 但它的引用 `prosemirror-model/dist/index.js:1251-1253` 是 **`Node.textBetween` 的转发层**
  （`return this.content.textBetween(...)`），真正的叶子优先级逻辑在 **`Fragment.textBetween` 的 `117-134`**：
  ```js
  : !node.isLeaf ? ""
      : leafText ? (typeof leafText === "function" ? leafText(node) : leafText)
          : node.type.spec.leafText ? node.type.spec.leafText(node)
              : "";
  ```
  它列的**优先级顺序是对的**，行号指错了位置。→ **结论成立，引用不精确。**

### 2.9 `recordTabStop` 的 `renderText` 是死代码 —— 成立（净增值）

`RecordEditorNodes.tsx:506` 确有 `renderText() { return "\t" }`；
`@tiptap/core/dist/index.js:507-509` 把它挂成 `schema.toText = renderText`。
`toText` 不参与 PM 的 `textBetween`（PM 只认 `isText` / `spec.leafText`），
所以制表位在剪贴板里也是空串。**这是我漏掉的一条，采纳**（已进我方文档 R10）。

### 2.10 测试盲区 —— 成立，且实际更严重

三条复制用例在 `RichTextEditor.test.tsx:2251 / 2320 / 2363`（它写的 2255-2316/2318-2355/2357-… 是函数体范围，等价）。
复核断言通道：
- `:2283` 只读 `clipboard.get("text/plain")`；
- `:2320` 那条除了 `text/plain`，还有一句
  ```ts
  expect(clipboard.get("text/markdown")).toBe(clipboard.get("text/plain"));
  ```
  ——**它把"markdown 等于 plain"这个缺陷写成了断言**。

全文 `grep -n "text/html" RichTextEditor.test.tsx` 的 6 处命中**全是 `DOMParser.parseFromString(html, "text/html")`**，
没有一处是剪贴板载荷断言。✅ 所以它说"没断言 text/html"成立，
但真正更棘手的是**已有断言把错误行为锁死了**——修 P1 前必须先改这条。→ **成立 + 补充。**

### 2.11 静默失败分支（`clipboardData` 为 null） —— 成立但不可达

代码顺序复核（`RichTextEditor.tsx:1669-1680`）：`preventDefault()` 在 `if (clipboardData)` **之前**，
且随后 `return true` 会跳过 PM 的 `captureCopy` 兜底。逻辑上确实是"先取消默认行为、再可能什么都不写"。
但在 Chromium/Electron 上，真实 `copy` 事件的 `clipboardData` 恒非空
（PM 自己的 `brokenClipboardAPI` 分支只针对 IE/旧 Edge）。
它把这个称为"**可能是'桌面端才复现'的那一半**"属**推测**——我的实测里 `clipboardData` 从未为 null。
→ **成立但优先级应下调**：是健壮性改进，不是桌面端复现路径。

### 2.12 剪切（Ctrl+X） —— 成立，**我判错了这条**

它说"`handleCut` 完全没写，剪切走 PM 默认实现，只写 html+plain、不写 markdown"。

我初版文档的判断是"`handlers.copy = editHandlers.cut = …` 只给 `handlers` 注册了 copy，
PM 未注册 `cut` 监听，Ctrl+X 完全走浏览器原生剪切"——**这是错的**。复核
`node_modules/prosemirror-view/src/input.ts:885`（dist `:3907-3908`）：

```js
// Make sure all handlers get registered
for (let prop in editHandlers) handlers[prop] = editHandlers[prop];
```

`editHandlers`（`input.ts:16`）与 `handlers`（`input.ts:15`）是两个对象，但模块末尾**合并**，
于是 `handlers.cut === handlers.copy`，**PM 确实注册了 `cut` 监听**。
→ **它成立，我错**。（我的错因与教训见 §6。）
附带更正我的另一半：`text/plain` 里**仍然带 LaTeX**（PM 的 `serializeForClipboard` 用应用配置的
`clipboardTextSerializer`），所以"剪贴板里没有 LaTeX"也不成立；
真实差异是**没有 `text/markdown`**、**没有 DOM 选区兜底**（只用 `state.selection.content()`）。

### 2.13 R4 点击公式抢跑 NodeSelection —— 成立，机理表述略偏

`RecordEditorNodes.tsx:136-140` / `:203-207` 的 `onClick` 确实先 `setEditing(true)`；
实测点击后焦点是 `<textarea aria-label="块公式">`、复制零输出。✅
但它的机理链"`sliceFromNativeSelection` 因端点不在 `view.dom` 的正文流里而 return undefined"
**不准确**：真实早退点是该函数开头的 `selection.isCollapsed` 判断（实测 `collapsed: true`，
端点在 `.formula-editor-card` 内、确实属于 `view.dom`）。结论一致，路径描述有偏差。

---

## 3. 我方被它纠正的错误（必须记录）

| 我方初版断言 | 事实 | 处理 |
|---|---|---|
| "PM 只注册 `handlers.copy`，没有 `handlers.cut`，Ctrl+X 走浏览器原生剪切" | `input.ts:885` 的合并循环注册了 `handlers.cut` | 已在根因文档 §3 R8 加更正块 |
| "剪切时剪贴板里没有 LaTeX" | 有（`clipboardTextSerializer` 生效），缺的是 `text/markdown` 与选区兜底 | 同上 |
| 未点出 `text/markdown` 其实是"假 Markdown"（格式化信息全丢） | 成立，与 `text/plain` 逐字节相同 | 已进文档 R10 |
| 未发现 `recordTabStop` 的 `renderText → spec.toText` 陷阱 | 成立 | 已进文档 R10 |

**后续交叉核验追加（2026-09-18，见 `editor-clipboard-cross-verification-final-2026-09-18.md`）**：
本报告另有两处自身错误是在对方**第二轮反驳**时被指出、并经我复核确认的：

| 本报告原文 | 事实 | 处理 |
|---|---|---|
| §2.5："应用自己的粘贴路径（`handlePaste`）在桌面/网页端只读 `text/markdown`/`text/plain`、**从不读 `text/html`**" | 错。PM 的 `doPaste`（dist `:3708-3710`）在调用应用 handler **之前**已用 schema 解析 `text/html` 并把 slice 当**第三个参数**递入；应用 `handlePaste` 的 `(view, event)` 签名把它丢弃 | 文档 R6b 整节重写；P1-2 方案同步改写 |
| §2.2 未质疑我自己的 R4 表述"网页版同样没有右键菜单" | 错。浏览器对 `contentEditable` **有**原生右键菜单，缺口是 **Electron 桌面端独有** | 文档 R4 加更正块 |

（这两条本报告的既有结论里已经"方向正确"但表述过强，属于**我自己**的错误，不是对方的。）

**第三轮核验追加的 5 处我方错误**（见 `editor-clipboard-third-round-adjudication-2026-09-18.md`）：
对方再审查又逐条核实出 5 处，全部回源码复核后**成立**，已就地更正：

| 本报告原文 | 事实 | 处理 |
|---|---|---|
| N-4：`leafText` 爆炸半径"还有**两处**（`:822-823` 与 `:1569`）" | `:823` 的 `rawMarkdownText` 第 4 参传**字符串** `"\n"` ⇒ `spec.leafText` 永不被查，**免疫**；唯一受影响点是 `:1569` | N-4 就地更正 |
| N-5：未登记 key 会"渲染成 `undefined（诊断编号 …）`" | `formatUiError` 第二参声明为 `UiErrorContext`（`uiError.ts:49`）⇒ **编译期错误**；51 处调用点全在 `.ts/.tsx`，无静默路径。我犯了"把运行期机制当成可达路径"的错 | N-5 就地更正 |
| S-3：断言在 `RichTextEditor.test.tsx:2320` | 断言在 **`:2360`**；`:2320` 是用例起始行。S-3 是前置硬阻塞，行号错代价最高 | S-3 就地更正 |
| §5 清单 S-1…S-9 **没有右键菜单条目** | 属实。P2 能力项在清单里整条缺失（已在最终报告 §6 补为 P2-1，本轮再补为 S-10） | 就地补 S-10 |
| §6.3 断言"遗留探针其实是本会话我方刚创建" | 对 **e2e 探针**可成立；对**单元探针**无证据（该文件未提交、现不在工作树、`git log --all -- '*zz-tmp*'` 空），且对方"会话初始快照里有它"的反证亦不成立（快照时点在会话中段）。**应为"来源未证实"** | §6.3 就地更正 |

**其中一条是我自己犯了自己诊断过的错**：N-5 里我把"运行期机制成立"当成"该路径可达"——
这正是我在 §2.11 用来判对方的"成立但不可达"标准。**同一条标准必须双向适用。**

---

## 4. 它漏掉的问题（N-x）

- **N-1 静默失败 + 剪贴板残留旧值没有单独立项。** 它把这条塞在 R2/R4 里描述，
  但它是**独立机理**、也是用户最容易误判的一条：失败时剪贴板**保持旧值不变**，
  用户会认为"我复制成功了"，粘贴出旧内容。根因文档已把它作为 P0-1 的第一优先级
  （实测手法：复制前写哨兵值，复制后读回判定）。
- **N-2 "选区根本没建立"这一层缺失。** 实测失败场景的 DOM 选区状态是 `collapsed: true`：
  鼠标按下点落在 `contentEditable=false` 的 NodeView 上时，Chromium 会把选区**坍缩**。
  它把原因全归到"处理器看到 `sel.empty` 就 early return"，漏掉"选区压根没形成"这一环——
  因此也就没有指出**同一手势两次结果不同**的不确定性（我方实测 v3 成功一次、v2 与 RO_B 失败两次，
  差别只在按下点偏移 6px 还是 3px）。
- **N-3 `text/markdown === text/plain` 已被写成断言**（**`:2360`**；所在用例自 `:2320` 起），这是修复的硬阻塞。
- **N-4 加 `spec.leafText` 的爆炸半径。** 它建议"在 schema spec 上定义"，但没检查仓库里还有别的
  `textBetween` 调用点。
  **⚠️ 2026-09-18 第三轮核验更正：本条初版说"还有两处（`:822-823` 与 `:1569`）"，其中 `:823` 是错的。**
  `rawMarkdownText`（`RichTextEditor.tsx:822-823`）的第 4 个实参传的是**字符串** `"\n"`，
  而 PM 的叶子分支是 `leafText ? (typeof leafText === "function" ? leafText(node) : leafText)
  : node.type.spec.leafText ? … : ""`（`prosemirror-model/dist/index.js:121-123`）——
  字符串是真值 ⇒ 每个叶子直接得到字面量，**`spec.leafText` 永不被查询 ⇒ 该处免疫**。
  **唯一真实受影响点是 `:1569`**（3 参调用、无 `leafText`，会回落 `spec.leafText`）。
  结论（改动收在复制路径内）不变，且**仅凭 `:1569` 一处即已足够成立**。
- **N-5 `UiErrorContext` 是闭集。** `src/lib/uiError.ts:1-12` 共 10 个成员，**没有 `editor-clipboard`**；
  它给的调用片段照抄会出问题——**但正确的理由是"编译期类型错误"而不是运行期静默**。
  **⚠️ 2026-09-18 第三轮核验更正：本条初版预言的后果（"会渲染成 `undefined（诊断编号 …）`"）不成立。**
  `CONTEXT_MESSAGES` 是 `Record<UiErrorContext, string>`（`:18`）、`formatUiError` 的第二参也声明为
  `UiErrorContext`（`:49`）⇒ 传未登记 key 是**编译期错误，`tsc -b` 当场拦住**；
  全仓 51 处 `formatUiError(` 调用点全在 `.ts/.tsx`，`desktop/`、`.js/.cjs` 零调用
  ⇒ 没有绕开类型检查的静默路径。**我把"运行期机制成立"当成了"该路径可达"**——
  这正是我自己在 §2.11 用来判对方的那条标准（"成立但不可达"），我自己在这里违反了它。
  行动项（S-1 先扩 union）不变，依据更正。
- **N-6 只读（复习页）分支实测结论**（它标为待验证，我已补测）：`readOnly=true`
  （`contenteditable="false"`）时，只要有**非坍缩 DOM 选区**，copy 处理器照常产出
  `text/html`+`text/markdown`+`text/plain` 且 LaTeX 正确；但"点一下公式卡片再复制"仍是零输出
  （`preventDefault=false`、`text/plain=""`）。**只读态并不比编辑态更好**，
  区别只在"谁把选区弄坍缩了"。另外**只读态下点击公式卡片不会进入编辑态**
  （`onClick` 有 `if (editable && …)` 守卫，实测 textarea 数 0→0）
  ——**所以 R4 只适用于可编辑态**，它的 R4 标题没有限定这一点。
- **N-7 取证方法上的坑：`navigator.clipboard.read()` 只暴露 `text/plain` + `text/html`，不暴露 `text/markdown`。**
  用它判断"应用有没有写 markdown"会得到假阴性。必须读事件里的 `clipboardData.types`。
- **N-8 `RecordDecisionBlockNode` 的"复制复习重点"其实是就地复制一份**（`tr.insert(...)`，`:110`），
  与剪贴板无关但会加深"复制"语义混乱。

---

## 5. 可执行修订清单（落地时按此执行）

| 编号 | 动作 | 位置 |
|---|---|---|
| **S-1** | 采纳其 P0-1（`clipboardData` 判空顺序 + 失败可见反馈 + 补 `cut`），但先扩 `UiErrorContext` union 与文案表 | `RichTextEditor.tsx:1662-1681`；`src/lib/uiError.ts:1-12` |
| **S-2** | 采纳 `leafText` 方向，但**改在复制路径内**，不往全局 schema spec 加 | `RichTextEditor.tsx:455-465`；勿动 `:823` / `:1569` |
| **S-3** | 修 P1 之前**先改 `RichTextEditor.test.tsx:2360` 的 `markdown === plain` 断言**，否则改不动。**⚠️ 行号更正（2026-09-18 第三轮）**：初版写的 `:2320` 是**用例起始行**，实际断言在 `:2360` —— S-3 是前置硬阻塞，行号错会改到错误位置 | `RichTextEditor.test.tsx:2360`（用例自 `:2320` 起） |
| **S-4** | 采纳"真 Markdown 序列化 + 自定义 JSON 载荷 + `transformPastedHTML`"，但**结构块序列化复用既有函数**，不要新写 | `recordStructureBlocks.ts:156-227`、`recordContent.ts:283+` |
| **S-5** | 采纳"不引入真 table 节点"的取舍（成本论证见它原文，我认同） | — |
| **S-6** | 采纳"拖拽只做外部文件拖入，不做块拖拽排序" | `RichTextEditor.tsx:1659/1682-1685`、`will-navigate` `main.cjs:1039` |
| **S-7** | 把它的 P1-7（公式点击语义）与我方 D2 合并成**一个**待决策项，别开两份 | 决策项 D2 |
| **S-8** | 新增回归用例时，必须断言**三通道**（`text/html` / `text/markdown` / 自定义 JSON），并在**只读态**各跑一遍 | `RichTextEditor.test.tsx` |
| **S-9** | 补一条 e2e：真实系统剪贴板 + 哨兵值，覆盖"点公式卡片后 Ctrl+C"与"拖选跨过行内公式" | `e2e/`（需 `permissions: ["clipboard-read","clipboard-write"]`） |
| **S-10** | **补右键菜单条目（2026-09-18 第三轮核验追加——本清单初版 S-1…S-9 确实漏了它，对方指出属实）**：走**桌面端路线 B**（`desktop/main.cjs` 加 `Menu.buildFromTemplate` + `webContents.on('context-menu')` + `popup`，role 用 `copy/cut/paste/selectAll/pasteAndMatchStyle`；注意 `main.cjs` 当前**未 import `Menu`**）。理由：右键缺口**仅 Electron 桌面端**（见 §2.2 更正），既有的"跨端一致"理由已不成立 ⇒ 原 A 路线（DOM 自绘 + 赌 `document.execCommand` 兼容性）不再是并列选项 | `desktop/main.cjs` |
| **O-1** | **先做判别性测试再定 P0 归属（2026-09-18 第三轮追加）**：E2 现象（落点 3px/6px 观测相同）有两个同现象成因——(i) `posAtDOM` 抛 `RangeError`（`:486-487` 在 try 外）、(ii) `slice === undefined` → `return false`。判别只需在复制过程监听 **`page.on("pageerror")`**：有未捕获异常 ⇒ (i)，无异常但剪贴板空 ⇒ (ii) | `RichTextEditor.tsx:486-487` / `e2e/` |

---

## 6. 方法论：本轮暴露的失败模式

**它的失败模式（三类，都不是"事实错"）：**
1. **机制过度归因**（4 处）：把"HTML 空元素"当公式复制的**直接原因**；
   把拖拽不可能全归到 `spec.draggable:false`；把失败全归到 `sel.empty` early return（漏了"选区没建立"）；
   把 `clipboardData` 为空称为"可能是桌面端复现的那一半"。
   → 特征：**结论正确 + 因果链被压缩**。核验时要把"结论"和"机制"分开裁定。
2. **与仓库既有实现脱节**：建议重写 `comparisonTableToMarkdown` / `structureDiagramToMarkdown` 等
   **仓库里已存在且已被 AI 上下文链路使用**的函数。
   → 防御：任何"新增序列化/转换"的建议，先 `grep` 项目里有没有现成能力。
3. **把并发现场当历史遗留**：它取证用的"遗留探针"据判断是**同一会话内我方刚创建**的一次性探针；
   它据此把"删除 e2e 探针 / 升格单元探针"写成清理项。不影响技术结论，但说明
   **对"工作树里的临时文件"的解释要谨慎**。
   **⚠️ 2026-09-18 第三轮核验自我更正**：我对 **e2e 探针**的判断可以成立，但对**单元探针**
   （`src/components/zz-tmp-clipboard-probe.test.tsx`）**我没有证据**——该文件从未提交、
   现在已不在工作树，`git log --all -- '*zz-tmp*'` 空，**两个方向都无法证明**（对方"会话初始快照里就有它"
   的反证同样不成立：快照时点在会话中段，天然包含会话中段生成的文件，区分不了先后）。
   `zz-tmp-` 前缀是我自己的探针命名约定，但约定不等于时间线证据。
   **正确写法是"来源未证实"，而不是断言某一方**——这是把推测写成了事实。
   另需记下我自己在此处的张力：我批评对方对临时文件的解释，**而真正删除探针的是我**
   （未跟踪文件无 git 历史）。（载荷快照本身已记录在
   `docs/editor-clipboard-copy-paste-rootcause-2026-09-18.md` 的实测段与插桩计数里，
   重建一次等价探针即可复现，不是"证据全毁"。）

**我自己的失败模式（必须记下）：**
- **只读赋值点，没读注册/合并点。** 我把 `handlers.copy = editHandlers.cut = …` 读成"没注册 cut"，
  没去模块末尾找 `for (let prop in editHandlers) handlers[prop] = …` 的合并循环。
  → 教训：**凡涉及"库内部机制是否生效"的断言，必须找到真正发生注册的地方，不能停在赋值语句。**

---

## 7. 附：核对中被证实正确、**不要动**的清单

- `.rich-editor` 的 `user-select: text`（`src/styles/pages.css:2124-2132`）——不是复制失败的原因，别改。
- `desktop/main.cjs` 只在 `:1039` 一处监听 `webContents`；`preload.cjs` 无菜单/剪贴板通道（当前状态即事实）。
- `src/lib/platform.ts:9-10` 的 `isDesktopPlatform()` 依赖 preload 注入 —— 排查桌面差异前必须先确认该开关（它的运维提示有用）。
- `recordTabStop` 的 `draggable: false` / `RecordMermaidNode.tsx:156` 等 9 处属性位置（行号可直接引用）。
- `prosemirror-markdown` 已在依赖且在用（`src/lib/markdownEditor.ts:2`）——修 P1 时**用它，不要新装包**。

**未复核项（如实标注）**：它引用的测试基线数字"`1436 passed / 3 skipped`"我本轮只跑了定向探针，
**未跑全量套件**，该数字未经我复核。
