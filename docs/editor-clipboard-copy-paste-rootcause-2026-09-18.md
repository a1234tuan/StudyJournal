# 编辑器复制/粘贴能力：根因定位与修复方案（2026-09-18）

> ## ⚠️ 本文为排查过程稿，不是实施依据
>
> **实施请以 `docs/editor-clipboard-repair-plan-2026-09-18.md`（修复方案终稿）为唯一依据。**
>
> 本文记录的是排查过程：其中的**修复方案章节已被终稿取代**，且若干处表述在后续核实中被更正
> （更正以"引述旧措辞 + 说明其错误"的形式写在原处，**直接全文检索旧措辞会命中这些引述并被误导**，
> 例如关于右键菜单适用范围、"粘贴是否读取 `text/html`"、以及右键菜单路线取舍的三处）。
> 保留本文仅为追溯排查路径与保留实测载荷记录。

> **最终状态（2026-09-19）**：本次用户反馈对应的外部粘贴根因已确认并修复。
> 浏览器输入框优先消费 `text/html`，而原公式自定义标签没有可见文本；现在复制 HTML 会保留
> `data-latex` 并补入 `$...$` / `$$\n...\n$$` 回退文本。相关单元/e2e 验收已通过；本文下方仍保留
> 早期排查和未实施的右键/拖拽方案，不应再解读为当前缺陷状态。

> **混合结构补充（2026-09-19）**：纯正文与折叠块原本可由 ProseMirror HTML 解析保留，
> 但同一选区加入公式后，编辑器的 Markdown/plain-text 分支会优先运行，导致折叠块降为普通段落。
> 现已在应用内识别本编辑器的 `data-pm-slice` + `record-*` 载荷并优先解析 HTML；Ctrl+X 共享该复制载荷。

## 0. 一句话结论

复制通道**本身是通的**，但它对「选区落点」极度敏感：只要选区/光标落在
`contentEditable=false` 的 NodeView（公式卡片、行内公式、结构块……）内部，
`handleDOMEvents.copy` 就会静默地什么都不写，**而且不清旧内容**——用户按 Ctrl+C
之后剪贴板里还是上一次的内容，于是表现成"复制无效"。叠加三个独立缺陷：
非公式叶子节点在文本序列化里被**整体丢弃**（结构块/图片/JSON 全没了）、
**右键菜单根本不存在**（Electron 不提供默认菜单，应用也没实现）、
**拖拽被显式禁用**。

---

## 1. 症状 → 根因对照

| # | 用户报告 | 根因 | 定性 |
|---|---|---|---|
| 1 | 选中公式按 Ctrl+C 复制不到 | **R1** 选区落进 `contentEditable=false` 的 NodeView → PM 选区为空、DOM 选区坍缩 → copy 处理器 `return false`，什么都不写 | 缺陷（静默失败） |
| 2 | 点公式卡片后 Ctrl+C 没反应 | **R1+R2** 点击公式卡片会进入"编辑态"（聚焦 `<textarea aria-label="块公式">`），根本不产生节点选中 | 缺陷 + 交互设计 |
| 3 | 文字"有时也复制不了" | **R1**（同机理）+ **R7** 在结构块单元格这类嵌套可编辑区里按 Ctrl+A 只选中该单元格 | 缺陷 |
| 4 | 右键没有任何菜单 | **R4** 应用零处 `contextmenu` 监听；`desktop/main.cjs` 也没有 `Menu`/`context-menu`；**Electron 桌面端**不提供 Chromium 浏览器那样的默认右键菜单（**浏览器对 `contentEditable` 有原生菜单 ⇒ 缺口仅限桌面端**，见 R4 更正） | 能力缺失（仅桌面端） |
| 5 | 不支持拖拽 | **R5** `editorProps.attributes.draggable = "false"` + `handleDOMEvents.dragstart` 无条件 `preventDefault()` | 能力缺失（显式禁用） |
| 6 | 复制出来的内容丢结构/表格/JSON | **R3** `serializeClipboardText` 只认识两种公式节点，其余叶子节点一律序列化成空串 | 缺陷（有损序列化） |
| 7 | 剪贴板里的公式粘到别处看不见 | **R6** `text/html` 用的是 `<record-inline-math>`/`<record-comparison-table>` 这类自定义标签，外部应用不认识 | 缺陷（跨应用互通） |

---

## 2. 实测方法与证据

### 2.1 方法

一次性探针（跑完即删，不入库）：

1. **单元探针** `src/components/zz-tmp-clipboard-probe.test.tsx`：在 jsdom 里构造
   「文字 + 行内公式 + 对比表 + 块公式」的文档，构造 DOM Range 与 PM 选区**故意不一致**，
   派发 `copy` 事件并 dump 落进 `clipboardData` 的三种类型。
2. **浏览器探针** `e2e/zz-tmp-clipboard-probe.spec.ts`（Playwright + 真实 Chrome，
   `permissions: ["clipboard-read","clipboard-write"]`，`--workers=1`）：
   从 `/?preview=stage3` 进编辑态，用真实系统剪贴板做 Ctrl+V 粘贴 Markdown，
   再对每种选区手势按 Ctrl+C，同时用三层仪器取证：
   - 在 `window` 上挂 `copy` 冒泡监听，读 `event.defaultPrevented` 与 `clipboardData.types`；
   - 劫持 `DataTransfer.prototype.clearData/setData` 记录**调用序列**（有没有写、写了几个字节）；
   - 复制前后往系统剪贴板写哨兵值，判断"是否真的写进去了"。

> 关键取证思路：**哨兵值 + setData 调用序列**能区分三种失败——
> 处理器没跑 / 处理器跑了但没内容 / 处理器跑了但被浏览器丢掉。

### 2.2 原始观测（节选）

**E1 — 整体复制是通的。** `Ctrl+A` → `Ctrl+C`：

```json
{ "clearData": {}, "setData text/html": 760, "setData text/markdown": 96, "setData text/plain": 96,
  "copy": { "defaultPrevented": true, "types": ["text/html","text/markdown","text/plain"] } }
```

`text/plain`/`text/markdown` 内容正确：

```
剪贴板探针

正文开头ABC，包含行内公式 $e^{i\pi}+1=0$ ，以及结尾XYZ。

$$
\int_0^1 x^2 dx = \frac{1}{3}
$$

最后一段收尾文字。
```

**E2 — 拖选跨过行内公式：两种结果并存（不确定但可复现的坏结果更致命）。**
起点偏移 6px 时正常（写入了 3 种类型）；起点偏移 3px 时：

```json
{ "copy": { "defaultPrevented": false, "types": [] } }
```

即 `clearData`/`setData` **一次都没调用**，剪贴板仍是上一次的内容。差别只在于
鼠标按下时落点在可编辑文本里还是在 `contentEditable=false` 的 `record-inline-math` 里。

**E3 — 点击块公式后 Ctrl+C = 什么都没复制（决定性证据）。**

```
点击公式卡片后 document.activeElement = { tag: "TEXTAREA", ariaLabel: "块公式" }   ← 进入编辑态
复制前把剪贴板写成哨兵值 "SENTINEL-BEFORE-COPY"
Ctrl+C 之后 navigator.clipboard.readText() === "SENTINEL-BEFORE-COPY"            ← 什么都没写
```

**E4 — 右键菜单不存在。**

```
contextmenu 事件：{ defaultPrevented: false }，页面内 [role=menu]/.context-menu 等元素数 = 0
代码检索：src/ 全域无 contextmenu 监听；desktop/main.cjs 无 Menu.buildFromTemplate / 'context-menu'
```

**E5 — 拖拽被显式禁用。** `.rich-editor` 元素上 `draggable="false"`；
`handleDOMEvents.dragstart` 第一行就是 `event.preventDefault()`。

**E6 — 结构块在文本通道被整体丢弃。** 同一份内容，`text/html` 里明明有：

```html
<record-comparison-table data-json="{&quot;title&quot;:&quot;&quot;,&quot;columns&quot;:[{...,&quot;label&quot;:&quot;名称&quot;},...]">
```

但 `text/plain` 与 `text/markdown` 里「名称 / 值 / 甲」**一个字都没有**——
复制这一份内容到 Markdown 文件里，表格就凭空消失了。

**E7 — 复制→粘回本应用：公式能往返，结构块不能。**
整篇复制后在文末粘贴，DOM 统计：段落 `3 → 6`、行内公式 `1 → 2`、公式卡片 `1 → 2`
（公式存活），但对比表没有回来（与 E6 同源）。

**E8 — 剪切（Ctrl+X）完全没接进这套逻辑。**
`node_modules/prosemirror-view/dist/index.js:3665`：

```js
handlers.copy = editHandlers.cut = (view, _event) => { ... }
```

只给 `handlers` 注册了 `copy`，**没有 `handlers.cut`**；应用侧也只实现了 `copy`。
所以 Ctrl+X 走的是浏览器原生剪切，剪贴板里的公式**不带 LaTeX**，与 Ctrl+C 行为不一致。

---

## 3. 根因逐条拆解

### R1（P0）`copy` 处理器把"取不到内容"当成"不用管"，导致静默失败

`src/components/RichTextEditor.tsx:1661-1681`：

```ts
copy: (view, event) => {
  const slice = sliceFromNativeSelection(view)
    ?? (view.state.selection.empty ? undefined : view.state.selection.content());
  const clipboardData = (event as ClipboardEvent).clipboardData;
  if (!slice) {
    return false;                       // ← 静默放弃
  }
  const { dom, text } = view.serializeForClipboard(slice);
  event.preventDefault();
  clipboardData.clearData();
  clipboardData.setData("text/html", dom.innerHTML);
  ...
}
```

两条取内容的路径：

- `sliceFromNativeSelection`（`:470-518`）要求 DOM 选区**非坍缩**且
  `view.posAtDOM` 两端都落在文档内；而点/拖到 `contentEditable=false` 的 NodeView 上时，
  Chromium 给出的选区是**坍缩在该节点内部**的（E3 实测 `collapsed: true`，
  容器 class = `record-inline-node formula-editor-card`），第一个判断直接返回 `undefined`。
- 回落到 `view.state.selection.empty` —— 此时 PM 的选区也是**空的**
  （点击没有产生 `NodeSelection`，而是被 NodeView 的 `onClick` 抢去切成了编辑态），
  于是 `slice === undefined`，`return false`。

**危害在于"静默"**：`return false` 之后浏览器原生复制执行于一个空/坍缩选区 →
剪贴板**保持旧值不变**。用户看到的是"我明明按了 Ctrl+C"，粘贴出来的却是上一次的内容——
比报错更难排查，也最容易让人得出"这个编辑器复制是坏的"的结论。

补充一个放大因素：`RecordEditorNodes.tsx:136` 的公式卡片
`onClick={() => { if (editable && !editing) setEditing(true) }}` ——
**单击 = 进入编辑**，用户"点一下公式想选中它"的直觉动作反而断掉了复制路径。

### R2（P0）块公式无法通过"点选"选中

同 R1 的交互面。PM 的原子节点本该在点击时进入 `NodeSelection`，但公式卡片在
NodeView 内部先接住了点击并切成 `<textarea aria-label="块公式">` 编辑态，
DOM 选区因此坍缩在 textarea 里，PM 侧选区为空。E3 已实测。

（对照：行内公式 `recordInlineMath` 没有这个 onClick 分岔，是 `span` 级别选中，
所以行内公式的"点选复制"比块公式好一些——这解释了用户"不确定是只针对公式还是文字"的困惑。）

### R3（P0）文本序列化把除公式外的所有叶子节点丢成空串

`RichTextEditor.tsx:455-465`：

```ts
const serializeClipboardText = (slice: Slice): string =>
  slice.content.textBetween(0, slice.content.size, "\n\n", (node) => {
    const latex = String(node.attrs.latex ?? "");
    if (node.type.name === "recordInlineMath") return `$${latex}$`;
    if (node.type.name === "recordFormula") return `$$\n${latex}\n$$`;
    return node.type.spec.leafText?.(node) ?? "";    // ← 其余全空
  });
```

- 传了 `leafText` 回调之后，PM 的 `textBetween` **只**用它，不再回落到 `spec.leafText`
  （`node_modules/prosemirror-model/dist/index.js:117-134`）。
- 而全仓库**没有任何节点定义 `leafText`**（`grep -rn leafText src` 只命中上面这一行）。
- 结论：`recordComparisonTable` / `recordStructureDiagram` / `recordStickyBoard` /
  `recordMermaidDiagram` / `recordAsset`（图片、附件）/ `recordReference` /
  `recordCollapseBlock` / `recordHighlightBlock` / `recordDecisionBlock`（作为块被选中时）
  → **在 `text/plain` 与 `text/markdown` 里全部变成空字符串**（E6 实测）。

这直接违背需求 (b)"节点、结构块能够直接复制出来；如果是 JSON 格式也要原样复制"。

### R4（P2）右键菜单是"零实现"

- `src/` 内不存在任何 `contextmenu` 监听（只有 PM 自己的
  `handlers.contextmenu = view => forceDOMFlush(view)`，只做 DOM flush，不弹菜单）。
- `desktop/main.cjs` 没有 `Menu.buildFromTemplate`、没有
  `webContents.on('context-menu')`、没有 `webContents.copy()/paste()` 这类 role 命令；
  窗口用 `autoHideMenuBar: true`。
- Electron 的渲染进程**不提供** Chromium 浏览器那样的默认右键菜单——这是 Electron 的已知差异，
  应用必须自己实现。→ 用户"右键点啥都没有、像个假编辑器"的体感是准确的。
- **更正（2026-09-18 交叉核验）**：本节初版写的"网页版同样没有"**是错的**，已删除。
  浏览器（Chromium 系 / Firefox）对 `contentEditable` 区域**提供原生右键菜单**（剪切/复制/粘贴/全选），
  所以右键缺口是 **Electron 桌面端独有的**，网页版没有这个问题。
  错因是**取证方法越界**：E4 探针只测了"`contextmenu` 事件未被 preventDefault"与
  "页面内 `[role=menu]` 元素数 = 0"，这两个指标只能证明"应用没自建菜单"，
  **原理上无法证明"浏览器没有原生菜单"**——原生菜单是窗口系统级 UI，不进 DOM。
  把"DOM 里没有"外推成"没有"，等于把不可观测当成了否定证据。
  本条因此**在本机不可实测**（无头浏览器与 Electron 都不渲染原生菜单），判定基于 Chromium 已知行为。
  详见 `docs/audit/editor-clipboard-cross-verification-final-2026-09-18.md` §2.2。

### R5（P2）拖拽被两处配置显式关掉

- `RichTextEditor.tsx:1657-1660`：`attributes: { draggable: "false" }`（实测挂在 `.rich-editor` 上）。
- `RichTextEditor.tsx:1682-1685`：`dragstart` 里 `event.preventDefault()` **无条件**执行。
- 另外 `recordFormula` / `recordAsset` / `recordInlineMath` 的 Node 都声明了
  `draggable: false`（`RecordEditorNodes.tsx:294/334/395`）。

### R6（P1）`text/html` 对外不可读

复制出的 HTML 用的是自定义标签：`<record-inline-math data-latex="...">`、
`<record-formula ...>`、`<record-comparison-table data-json="...">`，并在首个子元素上带
`data-pm-slice`。这套编码**只对本应用有意义**：粘到 Word / 浏览器 / 聊天工具里，
公式与结构块会渲染成**空白**（未知标签、无文本内容）。
好消息是它足够无损——`handlePaste` 的原生分支已经用
`parseClipboardSlice` → PM 的 `__parseFromClipboard` 来识别 `data-pm-slice`
（`RichTextEditor.tsx:553-560`）。

### R6b（P1）应用把 PM 递进来的 `text/html` slice **丢弃**了

> **本节已按 2026-09-18 交叉核验重写。** 初版标题"桌面端粘贴**从不读 `text/html`**"是错的
> （理由见下方"更正"），但**结论方向（应用内往返有损）仍然成立**，只是机理完全不同。

**真实机理**（`node_modules/prosemirror-view/dist/index.js`）：

```js
// :3728
editHandlers.paste = (view, _event) => { …
  if (data && doPaste(view, getText(data), data.getData("text/html"), plain, event))  // :3738  ← html 在此被取出
    event.preventDefault(); else capturePaste(view, event); };

// :3708
function doPaste(view, text, html, preferPlain, event) {
  let slice = parseFromClipboard(view, text, html, preferPlain, …);   // :3709  ← html 在此被 schema 解析成 slice
  if (view.someProp("handlePaste", f => f(view, event, slice || Slice.empty)))  // :3710  ← slice 在此递给应用
    return true; … }

// :2819 parseFromClipboard
let asText = !!text && (plainText || inCode || !html);  // :2824  html 非空且非 shift/非 code ⇒ 走 HTML 分支
… dom = readHTML(html); …                              // :2848-2849
slice = parser.parseSlice(dom, {…});                   // :2865-2875  DOMParser.fromSchema(state.schema)
view.someProp("transformPasted", f => { slice = f(slice, view, asText); });  // :2889  两条路径都过
```

而应用的 handler 签名是 **`handlePaste: (view, event) => {…}`**（`RichTextEditor.tsx:1756`）——
**第三个参数 `slice` 被直接忽略**。

⇒ **PM 在每一次粘贴都已经把 `text/html` 用 schema 无损解析好并交给应用了，是应用把它丢掉**，
改去重解析 `text/markdown` / `text/plain`（`:1776-1794`）。结构块丢失（E7 实测）是**应用主动丢弃**的结果。

**这条更正带来两处利好**（都在修复方案里用到）：
1. `data-pm-slice` 标记写在 `dom` 的 **firstChild** 上（`:2813` `firstChild.setAttribute("data-pm-slice", …)`），
   而复制端写进剪贴板的是 `dom.innerHTML`（`RichTextEditor.tsx:1676`）⇒ 标记**原样进入载荷**，
   粘贴端 `dom.querySelector("[data-pm-slice]")`（`:2853`）能取到 ⇒ 开放 slice 的
   `openStart/openEnd/context` 也能还原，不止整块。
2. `transformPasted`（应用配的 `renewDecisionBlockIdentities`，`RichTextEditor.tsx:1656`）在 `:2889`
   对**文本路径与 HTML 路径都生效** ⇒ 直接派发 PM 递来的 slice 时，决策块 ID 重发语义不丢。

（顺带：R6 已指出 html 编码足够无损——`recordFormula` / `recordInlineMath` 的 `renderHTML` 属性
与 `parseHTML` 回读键一一对应（`RecordEditorNodes.tsx:365-367/338-352`、`:421-423/399-408`），
`recordComparisonTable` / `recordStickyBoard` 的结构数据在 `data-json`（`RecordStructureNodes.tsx:918-920/900-911`、
`:947-949/934-941`）。⇒ **修复不需要新写解析器，只需接住 slice**，见 P1-2。）

> **更正说明**：初版说"桌面端粘贴从不读 `text/html`"，把落点定在 `:1836 return false` 的兜底路径上。
> 兜底路径确实会读（PM 的 paste handler 会接管），但那是**次要路径**；主路径上 html 早就被读了，只是被丢。
> 前半句"从不"是错的，后半句"能力已经写好、只是没接线"其实**说对了**——只是"没接线"的位置说错了。

### R7（P1）嵌套可编辑区里的 Ctrl+A 只选中当前单元格

结构块的单元格是可编辑宿主（实测 `activeElement` 是 `input`）。光标落在里面时按 Ctrl+A，
浏览器只在最近的编辑宿主内做全选；E1 早期版本实测到"Ctrl+A + Ctrl+C 只复制到一个 `值`"。
用户感知为"全选/复制时好时坏"。

### R8（P2，一致性）剪切与复制不同源

> **2026-09-18 更正**：本节初版结论是"PM 未注册 `cut` 监听、Ctrl+X 走浏览器原生剪切"，**这是错的**。
> 复核 `node_modules/prosemirror-view/src/input.ts:885`（dist `:3907-3908`）：
>
> ```js
> // Make sure all handlers get registered
> for (let prop in editHandlers) handlers[prop] = editHandlers[prop];
> ```
>
> `editHandlers` 与 `handlers` 是两个对象，但模块初始化时会**合并**，
> 于是 `handlers.cut` 就是那个与 `handlers.copy` 同源的函数（`handlers.copy = editHandlers.cut = …`）。
> **PM 确实注册了 `cut` 监听**，Ctrl+X 走的是 PM 内置实现，不是浏览器原生剪切。

实际差异（这才是真问题）：

| 通道 | 处理器 | 写入的载荷 | 选区来源 |
|---|---|---|---|
| Ctrl+C | 应用的 `handleDOMEvents.copy` | `text/html` + **`text/markdown`** + `text/plain` | `sliceFromNativeSelection`（有 DOM 选区兜底） |
| Ctrl+X | PM 内置共享处理器 | `text/html` + `text/plain`（**无 `text/markdown`**），随后 `deleteSelection()` | 只用 `state.selection.content()`，**没有 DOM 选区兜底** |

两点后果：
1. 剪切丢失 Markdown 通道，且**不走原子节点兜底**，所以在公式卡片上 Ctrl+X 与 Ctrl+C 表现不一致
   （PM 内置同样是 `if (sel.empty) return` 早退 → 空选区时什么都不写，浏览器接管默认剪切）。
2. `text/plain` 里**仍然带 LaTeX**（因为 PM 的 `serializeForClipboard` 会用应用配置的
   `clipboardTextSerializer`），所以初版"剪贴板里不带 LaTeX"的说法也不成立。

### R9（附带）`RecordDecisionBlockNode` 的"复制复习重点"其实是"就地复制一份"

`src/components/RecordDecisionBlockNode.tsx:110` 标题为"复制复习重点"，行为是
`tr.insert(pos + node.nodeSize, duplicate)`（E8 同类命名歧义）。与剪贴板无关，
但会加深"复制"语义的混乱，建议改名"再复制一份 / 生成副本"。

### R10（2026-09-18 交叉核验新增，均已实测/回源码确认）

- **`text/markdown` 是"假 Markdown"**：它是 `textBetween` 的产物，**只保留了字面文本**，
  标题的 `#`、加粗的 `**`、列表符号、引用、代码围栏**全部不存在**——所以它与 `text/plain` 逐字节相同
  （实测复现：`# 剪贴板探针` 复制出来是 `剪贴板探针`）。"保持原格式"因此在 markdown 通道上完全不成立。
- **`recordTabStop` 的 `renderText` 是死代码**：`RecordEditorNodes.tsx:506` 写了
  `renderText() { return "\t" }`，而 Tiptap 把它挂到的是 `spec.toText`
  （`@tiptap/core/dist/index.js:507-509`），`toText` **不参与** PM 的 `textBetween`。
  所以制表位复制出来也是空串——这是"Tiptap 的文本约定 ≠ PM 的剪贴板约定"的典型陷阱。
- **点击公式卡片在只读态不会抢选区**：`onClick` 带 `if (editable && !editing)` 守卫
  （`RecordEditorNodes.tsx:136-140`、`:203-207`）。单元实测 `readOnly=true` 时点卡片
  `textarea` 数量 0 → 0，即不进入编辑态。**R2 只适用于可编辑态**。
- **只读（复习页）复制路径本身是通的，但受同一缺陷支配**：实测
  `readOnly=true`（`contenteditable="false"`）下，只要有非坍缩 DOM 选区，
  copy 处理器照常产出三种载荷且 LaTeX 正确；而"点一下公式卡片再 Ctrl+C"
  仍然是零输出（实测 `preventDefault=false`、`text/plain=""`）。
  即**只读态并不比编辑态更好**，区别只在"谁把选区弄坍缩了"。
- **既有测试把缺陷写成了断言**：断言本身在 **`RichTextEditor.test.tsx:2360`**
  （所在的用例从 `:2320` 开始，用例标题是 "copies formulas when the browser DOM selection spans their node views"）：
  `expect(clipboard.get("text/markdown")).toBe(clipboard.get("text/plain"))`
  ——它**主动锁死了"markdown 等于 plain"**。修 P1 时必须先改这条断言，否则改不动。
  三条复制用例（起始行 `:2251` / `:2320` / `:2363`）都只断言 `text/plain`，**没有一条断言 `text/html`**。
  **注意区分"用例起始行"与"断言行"**：`:2320` 是用例起点，实际断言在 `:2360`——
  这是修 P1 的前置硬阻塞，行号写错会改到错误位置（2026-09-18 第三轮核验更正）。

---

## 4. 需求对照

| 用户期望 | 现状 | 差距 |
|---|---|---|
| (a) 公式/文字/表格都能选中并复制出来 | 文字 ✅；行内公式 ✅（拖选落点合适时）；块公式 ❌（点选进编辑态）；表格/结构块 ❌（文本通道丢，HTML 通道不可读） | R1 R2 R3 R6 |
| (b) 保持原格式，节点/结构块/JSON 原样复制 | `text/html` 里数据完整但**外部不可读**；`text/plain`/`text/markdown` 丢结构；应用内粘贴不读 HTML | R3 R6 R6b |
| (c，用户隐含) 右键菜单（剪切/复制/粘贴/全选） | 桌面端不存在（网页版有浏览器原生菜单） | R4 |
| (d，用户隐含) 拖拽 | 显式禁用 | R5 |

---

## 5. 修复方案

> 分级依据：P0 = "按了没反应/静默失败"，属于**缺陷**，可在 maintenance 范围内处理；
> P1 = 让复制产物真正可用；**P2 是能力新增（右键菜单、拖拽），按 `AGENTS.md` 的冻结规则
> 需要一次明确的 scope 解冻决定**（见 §6 决策项 D1）。

### P0-1 让 copy 永不静默失败（核心）

> **2026-09-18 第三轮核验更正**：本节初版第 ③ 条（"光标停在某处、什么都没选时，
> 复制'最近可复制单元'——相邻块或 `nearestDesc` 承载节点"）**已撤销**，理由见下。

改 `RichTextEditor.tsx:1661-1681` 的取内容逻辑：

1. 依次尝试：① `sliceFromNativeSelection`（DOM 选区兜底）；② `state.selection`（非空）。
   **不新增"猜测式兜底"**。
2. 光标落在 `contentEditable=false` 的 NodeView 内部时（E3 场景），**不在 copy 阶段猜**，
   而是回到交互层修（见 P0-3）：让"单击公式卡片"这件事本身产生真正的 `NodeSelection`。
3. 仍然拿不到内容时：**不做 `preventDefault`、也不先 `clearData()`**，
   让系统剪贴板保持原值；同时在编辑器上给**一次**性提示，把"静默失败"变成"可感知"。
   需要先扩 `UiErrorContext` union + 文案表（**这是编译期前置条件**，见下方注意）。

**为什么撤销初版的 ③（猜测式兜底）**：
- 它违反"空选区 Ctrl+C = 无操作"的通用约定。用户什么都没选却按下 Ctrl+C 时，
  把**猜出来的内容**写进系统剪贴板，会把症状从"没反应"变成"复制错了东西"——
  后者更难归责，也更可能**覆盖用户上一份还有用的剪贴板内容**。
- 它与 P0-3 **重叠**：一旦交互层让"单击公式卡片"产生真正的 `NodeSelection`，
  ③ 就失去了它唯一想覆盖的场景（"点了公式想复制它"）。剩下还在 ③ 名下的场景
  （光标停在某处、确实什么都没选）恰好就是**最不该猜**的那种。
- 因此正确处置拆成两半：**交互层根治（P0-3 单击 → `NodeSelection`）** + **失败显式化（本条 ③'）**。

**回归测试**：e2e 断言"点公式卡片 → Ctrl+C → 剪贴板含 `\int_0^1`"
（在 P0-3 落地后，该手势应产生真实选区而非依赖兜底）；
单元测试覆盖"选区为空 + 光标在原子节点内"时**失败可见**（`preventDefault === false`、
剪贴板保持哨兵值）的分支。

**注意**：按 `AGENTS.md` 的硬约束，用户可见的报错必须走 `src/lib/uiError.ts`；
而 `UiErrorContext` 是**闭集**（`uiError.ts:1-12`，共 10 项，**没有 `editor-clipboard`**），
`CONTEXT_MESSAGES` 是 `Record<UiErrorContext, string>`（`:18`）、`formatUiError` 的第二参也声明为
`UiErrorContext`（`:49`）⇒ **直接传新 key 是编译期类型错误，`tsc -b` 当场拦住**，不会静默渲染。
（**2026-09-18 第三轮核验更正**：本节初版写"会渲染成 `undefined（诊断编号 …）`"，
只描述了 `CONTEXT_MESSAGES[context]` 的运行时查表机制，**没有检查这条路径是否可达**。
全仓 51 处 `formatUiError(` 调用点全在 `.ts/.tsx`，`desktop/`、`.js/.cjs` 里零调用
⇒ 不存在绕开类型检查的静默路径。这正是我在 R6b 里用来判对方的那条标准——"成立但不可达"——
我自己在这里违反了它。闭集在这里是**安全性优势**，不是风险。）
所以必须先扩 union 成员 + 文案表，再使用——**这是编译期前置条件**。

### P0-2 把 `sliceFromNativeSelection` 的失败变成可诊断而不是坍塌

`:486-487` 的 `view.posAtDOM(...)` **没有 try/catch**，而 `posAtDOM` 在位置不在文档内时是
**抛 `RangeError`** 的（`prosemirror-view/dist/index.js:5774-5777`：
`let pos = this.docView.posFromDOM(node, offset, bias); if (pos == null) throw new RangeError("DOM position not inside the editor");`）。
当前它在 `sliceFromNativeSelection` 里，一旦抛出，异常会穿透 `handleDOMEvents`
（PM 的 `runCustomHandler`（`:3121-3126`）**不 catch**），导致整个 copy 处理器中断——
**这正好是"什么都没写"的另一种成因**，且行为随落点不同而抖动（与 E2 的两种结果吻合）。

改法：把 `posAtDOM` 包进 try/catch，异常时返回 `undefined` 让上层**走"失败显式化"路径**；
顺带把 `view.state.doc.slice(from, to)` 的既有 try/catch 保留。

**⚠️ 这条与 E2 的判别性测试（追加）**：E2 现象（落点 3px 与 6px 得到相同观测）有**两个**都能产生
同一现象的成因——(i) `posAtDOM` 抛 `RangeError`，(ii) `slice === undefined` 导致 `return false`。
二者在类型化 handler 里都表现为"什么都没发生"，**只看结果是无法区分的**。
判别只需要一条测试：在复制过程中监听 **`page.on("pageerror")`**，
有未捕获异常 ⇒ (i)，无异常但剪贴板为空 ⇒ (ii)。**必须把这条判别测试最先做**，
否则 P0-1 与 P0-2 谁是真凶无法定论（先改哪一处就是猜）。

### P0-3 公式卡片：单击选中，编辑改为显式动作

`RecordEditorNodes.tsx:136` 的 `onClick → setEditing(true)` 改成：

- **单击** = 选中节点（交给 PM，产生 `NodeSelection`，可被 P0-1 复制）；
- **双击** 或 卡片上的"编辑"按钮 / `Enter` = 进入 `<textarea>` 编辑态（`RecordFormulaNode`
  已有 `Enter` 快捷键的 NodeSelection 分支，`RecordEditorNodes.tsx:373-386`）。

行内公式（`:203`）保持现状即可，但建议统一为同一规则以免行为不一致。
⚠️ 这条会改变交互，属于"UX 取舍"，需要你确认（§6 决策项 D2）。

### P0-4 把 `cut` 接进同一条路径

新增 `handleDOMEvents.cut`，复用 P1-1 的序列化逻辑写剪贴板，然后
`view.dispatch(view.state.tr.deleteSelection())`；或退一步：
只做 `preventDefault()` + 走与 copy 相同的文本写入，再删除选区。
目标是"剪切 = 复制 + 删除"，剪贴板内容与 Ctrl+C 完全一致。

**这条同时修掉一个只读态的硬缺口（2026-09-18 第三轮核验补充）**：
`prosemirror-view/dist/index.js:3138-3141` 的事件分发是

```js
if (!runCustomHandler(view, event) && handlers[event.type] &&
    (view.editable || !(event.type in editHandlers))) handlers[event.type](view, event);
```

`cut ∈ editHandlers`（由 `:3907-3908` 的合并循环注册），`view.editable` 在只读态为 `false`
⇒ **只读态下 PM 的 `handlers.cut` 根本不被调用**。而应用**没有** `handleDOMEvents.cut`
（`handleDOMEvents` 的 **7** 个键是 `copy/dragstart/pointerdown/touchstart/keydown/beforeinput/input`，
全文 `grep '\bcut\b'` 零命中）⇒ **只读态 Ctrl+X 完全无动作**。
对照之下只读态 Ctrl+C **可用**——因为应用自带 `handleDOMEvents.copy`，
而 `runCustomHandler` 走的是 props，**不受 `editable` 门控影响**。
⇒ 补齐 `handleDOMEvents.cut` 是让两端行为一致的必经一步。

### P1-1 文本序列化改用仓库里**已有**的结构块转换器（不要重写）

仓库已经有成套实现，只是没接到复制路径上：

| 现成能力 | 位置 | 作用 |
|---|---|---|
| `parseLinearRecordContent` | `src/lib/recordContent.ts:283` | 把内容 HTML 线性化成 `LinearNode[]`，每项带 `text` 与 `markdown` |
| `recordToPlainText` / `recordToLinearMarkdown` | `recordContent.ts:403/406` | 整记录 → 纯文本 / Markdown |
| `structureBlockPlainTextFromElement` / `structureBlockMarkdownFromElement` | `src/lib/recordStructureBlocks.ts:201/215` | 结构图 / 对比表 / 便签板 → 文本、Markdown（**含表格语法**） |
| `collapseElementText` / `collapseElementMarkdown` / `highlightElementText` / `highlightElementMarkdown` | `recordContent.ts:227/241/263/277` | 折叠块、高亮块 |

**改法**：`serializeClipboardText` 不再用 `textBetween` 硬闯，改为
「把 slice 序列化成 DOM → 在 DOM 上跑同一套 element→(text, md) 转换」。
具体实现建议：

- 在 `recordStructureBlocks.ts` 旁新增一个"DOM 片段 → `{ plainText, markdown }`"的入口
  （复用 `/lib/recordContent.ts` 里已有的、非导出的 element 级函数，
  需要把它们提取到可复用位置或加导出，勿复制粘贴）；
- `serializeClipboardText` 接收 slice 后先 `DOMSerializer` 成 DOM 再走上述入口；
  或在 copy 处理器里直接改为
  `const { dom } = view.serializeForClipboard(slice); const text = clipboardTextFromDom(dom);`
- 补齐缺失的两类节点的文本表示：
  - `recordMermaidDiagram` → ` ```mermaid ` 围栏；
  - `recordAsset` → `![title](asset:id)` / `[附件: title]`（至少别丢，且带 id 以便回填）；
  - `recordReference` → 现有 `📎 标题` 格式（`recordContent.test.ts:119` 已有断言可参照）。

**验收标准**：复制含"对比表 + 结构图 + 便签板 + 图片 + 块公式"的段落，
`text/plain`/`text/markdown` 里能看到表格语法与全部块内容；粘回本应用后 DOM 统计一致。

**⚠️ 两条实现约束（2026-09-18 交叉核验补充）**：

1. **不要把 `leafText` 加到全局 schema spec 上**。那样做会改变所有 `doc.textBetween()` 调用点，
   而仓库里还有另外一处依赖它（**2026-09-18 第三轮核验：初版列的"两处"里有一处是错的，已更正**）：
   - ~~`RichTextEditor.tsx:822-823` 的 `rawMarkdownText`~~ —— **这一处免疫，不是受影响点**。
     它的第 4 个实参传的是**字符串**：
     ```ts
     const rawMarkdownText = (node: ProseMirrorNode): string =>
       node.textBetween(0, node.content.size, "\n", "\n");   // 第 3 参=块分隔符，第 4 参=leafText（字符串）
     ```
     而 PM 的叶子分支是
     `leafText ? (typeof leafText === "function" ? leafText(node) : leafText) : node.type.spec.leafText ? … : ""`
     （`prosemirror-model/dist/index.js:121-123`）——传**字符串**时它是真值，**每个叶子直接得到字面量
     `"\n"`，`spec.leafText` 根本不被查询** ⇒ 往全局 schema 加 `spec.leafText` 对它**零影响**。
   - `RichTextEditor.tsx:1569` 的 `insertedText` 比对 —— **这才是唯一真实受影响点**。
     它是 3 参调用（`textBetween(from, to, "\n")`，无 `leafText`），会回落到 `spec.leafText`；
     用途是 Android IME 漏发 paste 事件时的"是否已被替换成 Markdown"判据
     （`clipboardTextsMatchWithImeLineBreaks`）。

   → 正确做法是**把改动收在复制路径内**（`serializeClipboardText` 的分派 / 一个专门的 DOM→文本入口），
   这样 `:1569` 的行为逐字节不变。（**仅 `:1569` 一处就足以支撑这条约束**——
   第三轮核验中对方指出我并列的两处里有一处不成立，核实后确认：`rawMarkdownText` 的字符串
   `leafText` 确实让 `spec.leafText` 永远不被查。结论不变，依据收窄。）
2. **Markdown 通道的改造要同时满足往返**：仓库已经在用 `prosemirror-markdown` 的
   `defaultMarkdownParser`（`src/lib/markdownEditor.ts:2`），解析侧支持 GFM 表格 → `recordComparisonTable`。
   建议做成"`MarkdownSerializer` + 给 `record-*` 原子节点注册自定义 token"：
   标准节点/标记走真 Markdown，结构块委托上面那套已有函数。
   注意解析侧是**同步**要改的：`text/markdown` 载荷一旦变"真"，`handlePaste` 的
   `selectHistoryBoundedPasteSource([markdown, plainText])` 会优先吃 markdown，
   必须重测 `insertMarkdownPaste` 的往返，避免把正文里的 `**foo**` 误判成格式。

### P1-2 应用内粘贴：接住 `handlePaste` 的**第三个参数** `slice`（一次性做到"应用内无损"）

> **本节已按 2026-09-18 交叉核验重写。** 初版方案是"自己读 `clipboard.htmlText` 再调
> `parseClipboardSlice` 手工解析"。该方案**可行**（`parseClipboardSlice` 确实存在，
> `RichTextEditor.tsx:553-568`，内部包 `__parseFromClipboard`），但**绕了一圈**：
> PM 在调用我们的 handler **之前**就已经解析过同一份 html 了（见 R6b 的 `doPaste` 行号），
> 结果是同一份 HTML 被解析两次，且第二次要我们自己处理失败分支。**改为直接用现成的 slice。**

`handlePaste` 的签名接住第三参数：

```ts
handlePaste: (view, event, slice) => {           // ← 只需接住第三个参数
  const clipboard = snapshotClipboardData(event.clipboardData);
  const inAppRichPayload = slice && clipboard.files.length === 0 &&
    hasStudyJournalNode(slice.content);          // 判据：slice 里出现本仓库自定义节点类型
  if (inAppRichPayload) {
    event.preventDefault();
    view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView()
      .setMeta("paste", true).setMeta("uiEvent", "paste"));
    return true;
  }
  … // 其余分支（原生平台 / 代码块 / markdown / 图片）保持现状
};
```

- `hasStudyJournalNode`：遍历 slice，命中 `recordFormula` / `recordInlineMath` /
  `recordComparisonTable` / `recordStickyBoard` / `recordStructureDiagram` /
  `recordMermaidDiagram` / `recordAsset` / `recordReference` / `recordTabStop` /
  `recordCollapseBlock` / `recordDecisionBlock` 任一即成立。
- **纯文本/外部粘贴不受影响**：那些自定义节点类型不会出现在外部剪贴板里。
- **不需要新写解析、不需要新依赖、不需要改复制端**；`slice` 已经过
  `transformPasted`（`:2889`），决策块 ID 重发语义保留（详见 R6b 的利好 2）。
- 若嫌"看节点类型"不够显式，备选判据是复制端在 `dom.innerHTML` 里注入
  `data-studyjournal-clipboard="1"` 标记、粘贴端检查该标记。**属实现选择，不是正确性问题。**
- 保底方案（若 `slice` 因某种原因不可用）：退回初版的 `parseClipboardSlice` 手工路径。

好处：把"应用内复制→粘贴"升级为**结构无损**，且清晰地把三条通道分了工——
`text/html` 负责**应用内**往返，`text/markdown` 负责**对外**（这一条才是 P1-1 的职责），
`text/plain` 兜底。

### P1-3 `text/html` 给公式补一份通用表示

在 `serializeForClipboard` 的 DOM 上做后处理：给每个 `record-inline-math` /
`record-formula` 追加一份通用标记（KaTeX 静态 HTML 或 MathML 或
`<span class="math-latex" data-latex="...">$latex$</span>`），
使粘贴到 Word/浏览器/聊天工具至少**可见**（当前是空白）。
注意保持 `data-pm-slice` 与自定义标签不变，避免破坏应用内 HTML 反解析。

### P2-1 右键菜单（需解冻决定）

> **已按 2026-09-18 交叉核验收敛。** 初版把 A/B 并列称"建议 A（跨端一致）"。但 R4 已更正：
> **右键缺口是 Electron 桌面端独有的**，浏览器对 `contentEditable` 有原生菜单。
> 因此 **B 是唯一必要的那条**；A 降为"可选的跨端一致性改进"，不再是并列选项。

- **B（必要）**：`desktop/main.cjs` 用 `webContents.on('context-menu')` +
  `Menu.buildFromTemplate`，role 直接用 `copy/cut/paste/selectAll`。
  实现最省事，覆盖的正是唯一有缺口的平台。注意 `main.cjs` 目前**没有 import `Menu`**
  （只 import 了 `{app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell}`），需要补。
- **A（可选）**：`handleDOMEvents.contextmenu` 里自绘 React 浮层，定位用
  `view.posAtCoords({ left, top })`。菜单项：剪切 / 复制 / 粘贴 / 粘贴为纯文本 / 全选 /
  （可选）复制为 Markdown、复制为 JSON。
  它只在"要让网页版/Android 也有**同一套**菜单（含'复制为 Markdown'这类扩展项）"时才值得做。
  实现要点：PM 没有命令式的 copy/paste 命令，最稳的是用 `document.execCommand('copy'|'cut')`
  让浏览器派发**真实事件**，从而复用现有处理器；`execCommand('paste')` 在 Electron 受限，
  需实测，若不可用则退回 `readClipboardTextFallback()` + 复用 `insertMarkdownPaste`。

### P2-2 拖拽（需解冻决定）

- `attributes.draggable` 去掉或改 `"true"`；
- `dragstart` 的 `preventDefault()` 改为**条件**：仅当拖出编辑器区域时才阻止；
- 评估 `recordFormula` / `recordAsset` 的 `draggable: false` 是否放开
  （放开后拖拽会走 `serializeForClipboard` + `renewDecisionBlockIdentities`，
  注意 `RichTextEditor.tsx:786` 会**重生成决策块 id**，拖动/粘贴往返的 id 稳定性要确认）。

### P2-3 全选语义统一

`keydown` 里识别 `Ctrl/Cmd+A`：当焦点在编辑器内但当前编辑宿主是嵌套单元格时，
统一执行 `editor.commands.selectAll()`。**注意**：这会改掉"表格单元格内全选单元格文本"
的原生行为，需要在评审时明确取舍（§6 决策项 D3）。

---

## 6. 待你决策

| 编号 | 问题 | 选项 | 影响 |
|---|---|---|---|
| **D1** | 本仓库处于 feature-freeze，**右键菜单与拖拽属于能力新增**，按 `AGENTS.md` 需要一次明确的 scope 解冻决定 | ①只为 P0/P1（缺陷+修好复制语义）落地，不动右键/拖拽；②按 `docs/studyjournal-scope-unfreeze-2026-09-17.md` 的形式补一份解冻文档，一次做完 P0~P2；③只做右键菜单（用户体感最差的那一项） | 决定本次改动范围与是否需要新文档 |
| **D2** | 公式卡片交互：单击选中 vs 单击进编辑 | ①单击=选中、双击/按钮=编辑（更接近通用编辑器）；②保持单击=编辑，仅在右键菜单里提供"复制公式" | 交互习惯改变，可能触发既有 e2e 用例改写 |
| **D3** | Ctrl+A 在结构块单元格内的语义 | ①统一为"全选整篇"；②保留"选中单元格内容"，只在右键菜单里给"全选" | 影响既有用户肌肉记忆 |
| **D4** | `text/plain` 的定位 | ①人类可读优先（结构块渲染成 Markdown 文本）；②机器可读优先（可直接回填的 JSON/自定义围栏） | 决定 P1-1 的输出形态；也决定"复制为 JSON"是否是独立菜单项 |

---

## 7. 风险与不变量

- **不得改变既有语义**：`renewDecisionBlockIdentities`（粘贴时重生成决策块 id）、
  `markdownPasteWork` 的历史/undo 策略（`applyPasteHistoryMode`、超大粘贴不入历史）、
  以及"桌面代码块内粘贴保持纯文本"（`RichTextEditor.tsx:1769`）都必须保持不变。
- **云同步与数据格式不动**：本次改动全部在"编辑器 ↔ 剪贴板"边界，不触碰 schema、
  存储适配器、云同步载荷（因此不会引发 `updatedAt` 抖动问题）。
- **回归面**：`e2e/daily-plan.spec.ts`（16 例）、`ui-v2-stage3-editor.spec.ts`（编辑器工具栏几何）、
  以及 `RichTextEditor.test.tsx` 的 60+ 粘贴用例；P2-3 与 D2 一旦落地会改动交互，
  需同步更新对应用例。
- **落地后必须更新 `AGENTS.md`**（本仓库的事实权威），并在 `docs/` 详述；
  本次已按收尾记录完成同步，最终事实见 `AGENTS.md` 与本文件顶部的最终状态说明。

## 8. 附：本次探针的清理与后续

- 一次性探针 `e2e/zz-tmp-clipboard-probe.spec.ts`、`src/components/zz-tmp-clipboard-probe.test.tsx`
  及 `test-results-probe-clipboard*-20260918/` 在取证后删除，不入库。
- 建议在 P0 落地时**同时**补两条常驻回归：
  1. e2e：`context.grantPermissions(['clipboard-read','clipboard-write'])` +
     `navigator.clipboard.read()` 断言复制产物（含 `text/plain` 里的 `$...$`）；
  2. 单元：`copy` 事件 + 伪 `clipboardData`（现有 `RichTextEditor.test.tsx:485` 已有同款写法），
     断言"选区为空但光标在原子节点内"时仍能产出内容。
