# 编辑器剪贴板 · 交叉核验最终报告（我方版本）

**被核验对象**：另一 AI agent 针对我方《外部 AI 审计交叉核验》（`docs/audit/editor-clipboard-external-audit-verification-2026-09-18.md`）提出的反驳稿
**核验方式**：逐条回源码。凡涉及"库内部机制是否生效"的断言，一律回到真正发生**注册/调用**的那一行；库代码引用 `node_modules/prosemirror-view/dist/index.js` 与 `@tiptap/core/dist/index.js` 的行号
**核验时间**：2026-09-18
**配套文档**：`docs/editor-clipboard-copy-paste-rootcause-2026-09-18.md`（已按本报告 §7 更正）

> **后续（2026-09-18 同日，第三轮）**：对方又给出一份**针对本报告的再审查**。
> 我逐条回源码复核后裁定：其 C2/C3/C4 **完全成立，是我的错**（同一类——把"机制描述成立"当成
> "该路径可达"）；C5 部分成立；C1 与"文档 :206/:449 仍是旧的"属**过期快照**；
> **但它对"本报告 §5 清单漏了右键菜单"的指控完全成立**；其 §四 对 P0-1③ 的异议我**接受并已撤销该方案**。
> 结论与更正见 `editor-clipboard-third-round-adjudication-2026-09-18.md`（**该文件为本议题的最新版本**）。

---

## 0. 判定规则（先立规矩，避免"结论对就算全对"）

1. **结论与机制分开裁定**。一个断言可以"结论成立、机制说错"，这种情况必须指出机制错在哪。
2. **机制类断言只认注册/调用点**，不认赋值语句、不认注释、不认"看起来应该"。
3. **本机可实测的必须实测**；**原理上不可观测的必须显式标注为不可测**，不能外推成结论。

---

## 1. 一句话结论

对方三条"纠错"里：**两条我认**（R4 网页版右键菜单、R6b"从不读 text/html"），**一条我早已在本方报告 §3 自行认领**（Ctrl+X 的 handler 注册）；
但它对 R6b 给出的**机理也不准**——真正的机理比它说的更强、也更好修：**ProseMirror 在调用应用 handler 之前就已经把 `text/html` 解析成 slice 并作为第三个参数递进来了，是应用自己把这个无损 slice 丢掉了**。
它的"你漏掉的四条"**3/4 不成立**（就在我方核验报告里，且证据更深）。它的合并方案方向可采纳，但 **P1-2 的实现方式必须改写**（§5、§6）。

**净新增一条双方都没说准的**：`handlePaste` 的第三个参数 —— 它是本问题最省事、最可靠的正解。见 §5。

---

## 2. 对方三条"纠错"的逐条裁定

| # | 对方的纠错 | 裁定 | 说明 |
|---|---|---|---|
| E-1 | 我方说"PM 没注册 `cut`" | **结论对，但对"本报告"不构成纠错** | 见 §2.1 |
| E-2 | 我方说"网页版也没有右键菜单" | **成立，我错** | 见 §2.2，须改文档 |
| E-3 | 我方说"桌面端粘贴从不读 `text/html`" | **成立，我错；但它的机理也不准** | 见 §2.3，须重写该节 |

### 2.1 E-1 Ctrl+X 注册 —— 结论对，但时序上不是新纠错

**它是对的**：`prosemirror-view/dist/index.js:3665`

```js
handlers.copy = editHandlers.cut = (view, _event) => {
  let sel = view.state.selection, cut = event.type == "cut";
  if (sel.empty) return;
  let data = brokenClipboardAPI ? null : event.clipboardData;
  let slice = sel.content(), { dom, text } = serializeForClipboard(view, slice);
  if (data) { event.preventDefault(); data.clearData();
    data.setData("text/html", dom.innerHTML); data.setData("text/plain", text); }
  else captureCopy(view, dom);
  if (cut) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"));
};
```

配合 `:3907-3908` 的合并循环 `for (let prop in editHandlers) handlers[prop] = editHandlers[prop];`，`handlers.cut` 确实被注册。

**但这不构成对我的核验报告的纠错**：我方核验报告 §3 表格首行就是"我方初版断言：PM 只注册 `handlers.copy`…… → **它成立，我错**"，§6 还把它写成我自己的失败模式（"只读赋值点，没读注册/合并点"）。**对方把一条我已认领的错误再列一次**，事实层面无异议，但作为"纠错"没有增量。

**顺带把这条补精确**（比双方现有表述都完整）：
- Ctrl+X **不走**应用的 `handleDOMEvents.copy`。全文 `grep '\bcut\b' RichTextEditor.tsx` → **零命中**；`handleDOMEvents` 的 **7** 个键是 `copy / dragstart / pointerdown / touchstart / keydown / beforeinput / input`，**没有 `cut`**。（2026-09-18 更正：此处原写"6 个键"并漏列 `input`，`RichTextEditor.tsx:1734` 确认 `input` 也在该对象内。）
- 所以 Ctrl+X 走 PM 的共享 handler，特征是：用**应用的** `clipboardTextSerializer`（`serializeForClipboard` 于 `:2814` 取 `clipboardTextSerializer` 属性 → 即 `RichTextEditor.tsx:1655` 配置的 `serializeClipboardText`）⇒ **`text/plain` 里带 LaTeX**；**只写 `text/html` + `text/plain`，不写 `text/markdown`**；只取 `state.selection.content()`，**没有 DOM 选区兜底**（`if (sel.empty) return;` ⇒ 原子节点点击那类坍缩选区场景下根本不 preventDefault）。
- ⇒ 用户观感"Ctrl+X 和 Ctrl+C 行为不一致"成立，但差异是**缺 markdown 通道 + 缺 DOM 选区兜底**，不是"没有 handler"。

### 2.2 E-2 R4 网页版右键菜单 —— 成立，我错（须改文档）

**我的原话**（`docs/editor-clipboard-copy-paste-rootcause-2026-09-18.md:206`）：

> "Electron 的渲染进程不提供 Chromium 浏览器那样的默认右键菜单……应用必须自己实现。**网页版同样没有。**"

**后半句是错的。** 浏览器（Chromium 系、Firefox）对 `contentEditable` 区域**提供原生右键菜单**，内含剪切/复制/粘贴/全选。所以右键缺口是 **Electron 桌面端独有**的问题，网页版用户没有这个缺口。

**我的取证为什么没抓到**——这一点值得单列，因为它是**方法论错误**而非疏忽：

我的 E4 探针（rootcause:90-94）测的是
`contextmenu 事件：{ defaultPrevented: false }`、`页面内 [role=menu]/.context-menu 等元素数 = 0`。
这两个指标**只能证明"应用没有自建菜单"，原理上无法证明"浏览器没有原生菜单"**——原生菜单是**窗口系统级 UI**，不进入 DOM，也不受 `preventDefault` 影响。我却把"DOM 里没有菜单"外推成"没有菜单"，把**不可观测**当成了**否定证据**。

**诚实标注**：本条在本机**不可实测**（Playwright 无头模式与 Electron 都不渲染原生菜单）。该判定基于 Chromium 的已知行为，属"高置信但未实测"，我不把它包装成实测结论。

**这条的产品含义（会让方案收敛，见 §6）**：P2-1 我原列了 A（网页版 DOM 自建菜单）与 B（桌面端 `webContents.on('context-menu')`）两条路线并称"可二选一"。既然缺口是**桌面端独有**，那么 **B 是唯一必要的那条**；A 变成"可选的一致性改进"，不再是并列选项。

### 2.3 E-3 R6b"从不读 `text/html`" —— 成立，我错；但它的机理也不准

**我的原话**（rootcause:225 标题、:237 正文）：

> "R6b（P1）桌面端粘贴**从不读 `text/html`**" / "**结构块必然丢失**（E7 实测）"

**"从不"是错的。** 但对方把落点定在 `RichTextEditor.tsx:1836 return false` 的兜底路径上，**这也是次要路径**。真正的机理如下（全部为 dist 行号）：

```js
// prosemirror-view/dist/index.js:3728
editHandlers.paste = (view, _event) => { …
  if (data && doPaste(view, getText(data), data.getData("text/html"), plain, event))   // :3738  ← html 在此被取出
    event.preventDefault(); else capturePaste(view, event); };

// :3708
function doPaste(view, text, html, preferPlain, event) {
  let slice = parseFromClipboard(view, text, html, preferPlain, view.state.selection.$from);  // :3709 ← html 在此被解析
  if (view.someProp("handlePaste", f => f(view, event, slice || Slice.empty)))               // :3710 ← slice 在此递给应用
    return true; … }

// :2819 parseFromClipboard
let asText = !!text && (plainText || inCode || !html);   // :2824  html 非空且非 shift/非 code ⇒ asText=false
… else { view.someProp("transformPastedHTML", …); dom = readHTML(html); }                   // :2848-2849
slice = parser.parseSlice(dom, {…});                                                        // :2865-2875 用 state.schema 解析
view.someProp("transformPasted", f => { slice = f(slice, view, asText); });                  // :2889 两条路径都过
```

而应用的 handler 签名是 **`handlePaste: (view, event) => {…}`**（`RichTextEditor.tsx:1756`）——**第三个参数 `slice` 被直接忽略**。

**所以准确的根因是**：

> PM 在**每一次粘贴**（不止兜底路径）都已经把 `text/html` 用 schema 解析成 slice，并作为第三个参数交给应用；应用把这个**已经无损的 slice 丢掉**，改去重解析 `text/markdown`/`text/plain`。结构块丢失是**应用主动丢弃**的结果，不是"没人读 html"。

**这还带来两个此前双方都没注意到的细节**（都对我们有利）：
1. `data-pm-slice` 标记被写在 **`dom` 的 firstChild** 上（`:2813` `firstChild.setAttribute("data-pm-slice", …)`），而复制端写进剪贴板的是 `dom.innerHTML`（`:1676`）⇒ **该标记原样进入载荷**，粘贴端 `dom.querySelector("[data-pm-slice]")`（`:2853`）能取到 ⇒ **开放 slice 的 `openStart/openEnd/context` 也能还原**，不只是整块。
2. `transformPasted`（应用配置的 `renewDecisionBlockIdentities`，`RichTextEditor.tsx:1656`）在 `:2889` 对**文本路径与 HTML 路径都生效** ⇒ 若改为直接派发 PM 递来的 slice，**决策块 ID 重发语义不会丢**。

**结论**：E-3 我认（"从不"是错的），但要连带更正对方的机理——**它纠对了结论，落错了位置**。而真正的机理把修复从"手工读 html 再自己解析"降级为"用现成的 slice"（§5）。

---

## 3. 对方"我方漏掉的四条" —— 3/4 不成立

| # | 它说我没提的 | 我方核验报告出处 | 裁定 |
|---|---|---|---|
| 1 | `preventDefault()` 先于 `clipboardData` 判空 | **§2.11 专列一节** + §4 N-1 | **不成立**，且我方多了两层：①实测判据（哨兵值法）②"成立但不可达"的结论（Chromium/Electron 下 `clipboardData` 恒非空），把它从"桌面端复现路径"降级为健壮性问题 |
| 2 | `text/markdown` 是假的 | **§2.7**，并明确写"它比我说得更准、更狠，已采纳进我方文档（R10）" | **部分成立（仅限"初版 vs 首轮"的时序）**：我**初版**确实漏了，是它首轮审计提出的。在它现在反驳的那份**核验报告**里，这条已是我采纳并致谢的内容 |
| 3 | schema 里没有真 table 节点 | **§2.6** | **不成立** |
| 4 | 只读（复习页）分支需单独验证 | **§4 N-6**，且我做了它没做的实测 | **不成立，且我方更强** |

关于第 4 条尤其要说清楚：它当时把只读分支列为**"待验证"**；我在核验报告 N-6 里补了实测，结论是——
`readOnly=true`（`contenteditable="false"`，`RichTextEditor.tsx:1600 editable: !readOnly`）时，**只要有非坍缩 DOM 选区**，copy 处理器照常产出三通道且 LaTeX 正确；但"点一下公式卡片再复制"仍是**零输出**；且**只读态下点击公式卡片不会进入编辑态**（`RecordEditorNodes.tsx:136-140` 的 `onClick` 有 `if (editable && …)` 守卫）⇒ **R4 只适用于可编辑态**。
只读分支实测代码路径确实存在：`ReviewPage.tsx:1052` 传 `readOnly`、`RecordEditorPage.tsx:1162` 传 `readOnly={interactionLocked}`。

**"你漏了四条"这个概括的问题**：它把"对方**初版**漏了、但我**首轮**指出并已被采纳"和"至今没人提"混为一谈。跨文档核验时**必须先声明被反驳的是哪一份**，否则读者会误判我方报告的覆盖度。

---

## 4. 对方方法论批评的裁定

**它若指的是 R4 的推断**——**成立，我认**，且我已把根因定位到"用 DOM 探针去证明一个原理上不可观测的事实"（§2.2），并写进 §7 的文档更正清单。

**它若指的是"测试基线数字未复核"**——**不成立**。我方核验报告末尾就有"**未复核项（如实标注）**：它引用的 `1436 passed / 3 skipped`……该数字未经我复核。"**这是标注，不是疏漏**；把如实标注当作不严谨，是把"承认不确定"当成了"结论不可靠"。

**我反过来要指出对方本轮的两处不严谨**：
1. **纠错落点不准**（E-3）：把"从不读 html"的机理归到 `:1836` 兜底路径，而真位置在 `doPaste` 的第三参数（§2.3）。这类"结论对、机制错"的偏差，正是我方核验报告 §6 归纳的第一类失败模式的镜像——**它自己也犯了**。
2. **"你漏了"的判断基准未澄清**（§3）：反驳的是"我方核验报告"，但比对的是"我方初版根因文档"。两份文档的覆盖度差异很大。

---

## 5. 本轮净新增：`handlePaste` 的第三个参数（双方都没说准）

**事实**：PM 通过 `view.someProp("handlePaste", f => f(view, event, slice || Slice.empty))`（`:3710`）把**由 `text/html` 解析出的 slice** 递进来；应用的 `handlePaste` 声明为 `(view, event)`（`RichTextEditor.tsx:1756`），**第三个参数被丢弃**。

**该 slice 是否真的无损**——逐节点核对 schema 的 parse/render 对称性：

| 节点 | `renderHTML` 输出 | `parseHTML` 认的回读键 | 往返 |
|---|---|---|---|
| `recordFormula` | `record-formula` + `data-formula-id` / `data-title` / `data-latex`（`RecordEditorNodes.tsx:365-367` / `:338-352`） | `[{tag:"record-formula"}]` + 同名 `parseHTML` | ✅ 无损 |
| `recordInlineMath` | `record-inline-math` + `data-formula-id` / `data-latex`（`:421-423` / `:399-408`） | `[{tag:"record-inline-math"}]` | ✅ 无损 |
| `recordComparisonTable` | `record-comparison-table` + `data-json` / `data-format`（`RecordStructureNodes.tsx:918-920` / `:900-911`） | `[{tag:"record-comparison-table"}]` | ✅ 无损（结构数据在 `data-json`） |
| `recordStickyBoard` | `record-sticky-board` + `data-json`（`:947-949` / `:934-941`） | `[{tag:"record-sticky-board"}]` | ✅ 无损 |
| 其余原子/结构块 | 同构（`data-*` 属性 ↔ `parseHTML`） | 同上 | ✅ |

**⇒ 应用内"复制→粘贴"做到**结构无损**所需的一切，已经躺在 `handlePaste` 的第三个参数里了。**

**改法（P1-2 重写，比原方案更省事）**：

```ts
handlePaste: (view, event, slice) => {          // ← 只需接住第三个参数
  const clipboard = snapshotClipboardData(event.clipboardData);
  const inAppRichPayload = slice && !clipboard.files.length &&
    hasStudyJournalNode(slice.content);         // 判据：slice 里出现本仓库自定义节点类型
  if (inAppRichPayload) {
    event.preventDefault();
    view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView()
      .setMeta("paste", true).setMeta("uiEvent", "paste"));
    return true;
  }
  … // 其余分支保持现状
};
```

- `hasStudyJournalNode`：遍历 slice，命中 `recordFormula / recordInlineMath / recordComparisonTable / recordStickyBoard / recordStructureDiagram / recordMermaidDiagram / recordAsset / recordReference / recordTabStop / recordCollapseBlock / recordDecisionBlock` 任一即视为"应用内富载荷"。**纯文本粘贴不受影响**（那些节点不会出现在外部剪贴板里）。
- 不需要新写 HTML 解析、不需要新依赖、不需要改复制端。
- 备选判据（若嫌"看节点类型"不够显式）：复制端在 `dom.innerHTML` 里注入一个 `data-studyjournal-clipboard="1"` 标记，粘贴端检测该标记。属实现选择，**不是正确性问题**。

**外部通道与内部通道就此分离**，语义更干净：
- `text/html` → **应用内**无损往返（PM 已经帮我们解析好了）；
- `text/markdown` → **对外**给人/给别的 AI（这一条才需要 P1-1 的真 Markdown 序列化）；
- `text/plain` → 兜底。

---

## 6. 合并后的最终修复方案（我方版）

| 优先级 | 编号 | 动作 | 相对上一版的改动 |
|---|---|---|---|
| P0 | **P0-1** | `clipboardData` 判空**先于** `preventDefault()`；复制失败要有可见反馈（扩 `UiErrorContext` union + 文案表，**它给的那段调用照抄会渲染成 `undefined（诊断编号 …）`**，因为 `src/lib/uiError.ts:1-12` 是 10 成员闭集、无 `editor-clipboard`）；`sliceFromNativeSelection` 里 `posAtDOM`（`:486-487`）**移进 try**（`posAtDOM` 在越界时抛 `RangeError`，`runCustomHandler`（dist:3121）**不吞异常**，异常会让整个 copy 处理在 `preventDefault()` 之前中断） | 不变 |
| P0 | **P0-2** | 复制失败不再静默：失败时**剪贴板保持旧值**是用户最易误判的一条（哨兵值法可复现） | 不变 |
| P1 | **P1-1** | 用已在用的 `prosemirror-markdown`（`src/lib/markdownEditor.ts:2`，**不要新装包**）产出**真 Markdown**；结构块序列化**复用既有函数**（`recordStructureBlocks.ts:156-227`、`recordContent.ts:283+`），不要重写 | 不变 |
| P1 | **P1-2** | **改写为"接住 `handlePaste` 第三参数 slice"**（§5），而不是"手工读 `text/html` 再自己解析" | **方案实质变化，成本大幅下降** |
| P1 | **P1-3** | `text/html` 给公式补通用表示（供外部应用渲染），**不引入真 table 节点**；用 `transformPastedHTML` 把外部 `<table>` 转成 `recordComparisonTable` | 不变 |
| P2 | **P2-1** | 右键菜单：**收敛为桌面端路线 B**（`desktop/main.cjs` 用 `webContents.on('context-menu')` + `Menu.buildFromTemplate`；`main.cjs` 目前只 import 了 `{app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell}`，**`Menu` 未引入**）；网页版 DOM 自建菜单降为**可选**项 | **收敛**（依据 §2.2） |
| P2 | **P2-2** | 拖拽：只做**外部文件拖入**，不做块拖拽排序（根 `draggable:"false"` `:1659` + `dragstart` 无条件 `preventDefault` `:1682-1685` + 9 处 `spec.draggable:false`） | 不变 |

**落地时的硬阻塞项（顺序不能乱）**：
1. **先改 `src/components/RichTextEditor.test.tsx:2320`** 的 `expect(clipboard.get("text/markdown")).toBe(clipboard.get("text/plain"))` —— 这条断言把"假 Markdown"锁死了，不改它，P1-1 改不动。
2. **`leafText` 只加在复制路径内**（`RichTextEditor.tsx:455-465`），**不要往全局 schema spec 加**——仓库里还有两处 `textBetween`（`:822-823` 的 `rawMarkdownText`、`:1569` 的 Android IME 判据），全局改会同时移动这两条路径的基准。
3. 新增回归用例必须断言**三通道**（`text/html` / `text/markdown` / 自定义 JSON），且**在只读态各跑一遍**；e2e 要用**真实系统剪贴板 + 哨兵值**，覆盖"点公式卡片后 Ctrl+C"与"拖选跨过行内公式"（需 `permissions: ["clipboard-read","clipboard-write"]`）。

**待用户决策（D1-D4，仍开放）**：D1 是否补一份 scope 解冻文档（右键/拖拽属能力新增，按 `AGENTS.md` 需解冻）；D2 公式卡片单击语义（选中 vs 进编辑，**与对方的 P1-7 合并为一项**）；D3 `Ctrl+A` 语义（块内 vs 全篇）；D4 `text/plain` 给人读还是给机器读。

---

## 7. 我方文档需落地的更正（本报告已执行）

| 位置 | 原文 | 更正为 |
|---|---|---|
| `rootcause:206` | "网页版同样没有。" | 删除该句，改为"**这是 Electron 桌面端独有的缺口**；浏览器对 `contentEditable` 提供原生右键菜单，网页版无此问题"。并注明原判基于 DOM 探针，属不可观测事实的错误外推 |
| `rootcause` R6b 整节 | "桌面端粘贴**从不读 `text/html`**" | 重写为"PM 在调用应用 handler **之前**已解析 `text/html` 并把 slice 作为**第三个参数**递入（`doPaste` :3709-3710）；应用 `handlePaste` 的 `(view, event)` 签名把它丢弃，结构丢失是**主动丢弃**的结果" |
| `rootcause` P1-2 | "桌面端粘贴优先使用 `text/html`" | 改写为"接住 `handlePaste` 第三参数 slice 并优先派发"，附 §5 的判据与代码骨架 |
| `rootcause` P2-1 | A/B 二选一并列 | 收敛为 B 必要、A 可选 |

**本报告未复核项（如实标注）**：
- 浏览器的原生右键菜单行为**本机不可实测**（无头浏览器与 Electron 均不渲染原生菜单），§2.2 判定基于 Chromium 已知行为。
- 对方引用的测试基线数字（`1436 passed / 3 skipped`）**我未跑全量套件复核**。
- §5 的 `hasStudyJournalNode` 判据是**设计建议**，尚未写代码、未跑用例验证；落地时须先补"应用内往返无损"的回归用例再改实现。

---

_本报告的全部库行号来自 `node_modules/prosemirror-view/dist/index.js` 与 `@tiptap/core/dist/index.js`，源码行号来自当期工作树；如需复核，逐行可查。_
