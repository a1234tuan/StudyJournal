# *编*辑器剪贴板 · 第三轮核验裁定（我方版本）

**被核验对象**：对方针对我方《交叉核验最终报告》（`docs/audit/editor-clipboard-cross-verification-final-2026-09-18.md`）给出的**再审查报告**——含 §一 自我修正表、§二 我方 5 处新错误（C1-C5）、§三"我的最终清单里最严重的问题：右键菜单消失了"、§四 对 P0-1③ 的方案异议、§五/§六 它的合并事实表与落地顺序  
**核验方式**：逐条回源码。所有"它说我错"的条目都**先假设它对**，去源码找反证；找不到反证才认  
**核验时间**：2026-09-18  
**证据等级约定**（**采纳对方的标注法**，这是本轮它做的最有价值的方法贡献）：  
`[实]` = 有真实运行观测；`[码]` = 回源码可判定；`[?]` = 机理成立但归因未经判别性证据区分

---

## 0. 一句话结论

**它这一轮的 5 条（C1-C5）我全部回源码复核，成立 4 条半、1 条半属"过期快照"**：

- **C2、C3、C4 完全成立，是我的错**——而且是**同一类**：**把"机制描述成立"当成了"该路径可达/受影响"**。  
  我自己在上一轮正是用这条标准（"成立但不可达"）去判对方的。**同一条标准必须双向适用。**
- **C5 部分成立**：单元探针的来源我确实无证据（应为"未证实"）；但"会话初始快照里有它"这个反证也不成立。
- **C1 与"文档 :206 / :449 仍是旧的"属过期快照**——那两处我上一轮已改（`永远排不上用场` 已删、  
  `:206` 已加更正块、`P2-1` 已收敛为"仅桌面端路线 B"）。**但它对"我方清单漏了右键菜单"的指控完全成立**，  
  我方核验报告 §5 的 S-1…S-9 确实没有一条接住右键。
- **§四 对 P0-1③ 的异议我接受**，并认为理由比它给的更强：③ 与 P0-3 重叠，而 P0-3 落地后 ③ 无合法场景。
- **它 §五 引入的 `[实]/[码]/[?]` 证据分级**是本轮最有价值的方法贡献，我已采纳为本仓库审计文档的约定。

---


## 1. 它这一轮的自我修正（§一）：全部核实通过

| 它的原表述                                       | 它的修正                                                                                            | 我的核实                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| "HTML 空元素是公式复制不出来的直接原因"                     | 混装症状：空选区静默失败 = "复制不出来"；HTML 空元素 = "粘到别处看不见"                                                     | ✅ 与我方 §2.5 一致                                                  |
| `dist:3381` 使 PM 拖拽分支"永不进入"                 | `:3380-3388` 只设 `mightDrag`（`:3389-3398` 才给节点临时补 `draggable` / Gecko 补 `contentEditable=false`） | ✅ 读源确认。**且它这版比我上一轮的表述更准**——我上一轮写的是"它影响的是点击选中/拖拽起点判定"，把两件事捆在了一起 |
| `prosemirror-model:1251-1253`               | 真位置在 `Fragment.textBetween`（`:117-134`）                                                         | ✅ 与我方 §2.8 一致                                                  |
| "八个" `draggable:false`                      | 9 处                                                                                             | ✅ 与我方 §2.3 一致                                                  |
| R4 早退路径"端点不在 view.dom 正文流里"                 | 真早退点是 `:472` 的 `selection.isCollapsed`                                                          | ✅ 与我方 §2.13 一致                                                 |
| `clipboardData === null` "可能是桌面端复现路径"       | 降级为健壮性改进                                                                                        | ✅ 与我方 §2.11 一致                                                 |
| 直接 `formatUiError(..., "editor-clipboard")` | 需先扩 union + 文案表                                                                                 | ✅ 与 S-1 一致（**理由见 §3 C2——它当时也没说对理由**）                           |
| 结构块序列化"补 leafText"                          | 复用既有函数                                                                                          | ✅ 与 S-4 一致                                                     |

它对我方 N-1/N-2/N-3/N-6/N-7 的确认也与我方一致，且它对 **N-7**（`navigator.clipboard.read()`  
不暴露 `text/markdown`）的评价——"我上一轮跑的是 jsdom 自建 Map，正是它说的'能看见'的那一侧，  
所以两方证据不冲突、也不互相证伪"——是**诚实且正确**的收敛判断。

**它 §一 的修正质量很高**：8 条全部成立，且其中 1 条（`dist:3381`）**比我的对应表述更准**。

---

## 2. 逐条比对：它这一轮的自我修正 vs 我方上一轮

| 争议点             | 它本轮                                                                                                                | 我方（上一轮已完成）                                                                                        | 差异                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 拖拽主因            | `dragstart` 无条件 `preventDefault()+return true` **单独即足以阻断全部拖拽**；根 `draggable="false"` 对**文本选区拖出**的作用**未实测**，标 `[?]` | 我写"真正让拖拽不可能发生的是根上的 `draggable="false"` **与** `dragstart` 里的无条件 `preventDefault()`"——**把两者并列为决定性** | **它更准**。我回源确认：`dispatchEvent`（`:3138-3141`）先跑 `runCustomHandler`（即 `handleDOMEvents` props），返回 `true` 则内置 `handlers[event.type]` **永不执行** ⇒ 应用的 `dragstart` 一定抢先。**但根 `draggable="false"` 是否独立阻断"文本选区拖出"，取决于浏览器是否还会派发 `dragstart`——这一层双方都没实测**，标 `[?]` 是对的 |
| `formatUiError` | 需先扩 union（未给理由）                                                                                                    | 需先扩 union，理由写成"会渲染成 `undefined`"                                                                  | **它没说理由，我说错了理由**——见 §3 C2                                                                                                                                                                                                                                  |
| `leafText` 爆炸半径 | —                                                                                                                  | 我说"两处（`:823`、`:1569`）"                                                                            | **我错**——见 §3 C3                                                                                                                                                                                                                                            |

---

## 3. 它指出的 5 处我方错误：逐条核实


### C1 —— 我"又用了一次绝对化措辞、且对 R6b 一字未回应"：**过期快照，已被取代**

**它说**：它 §2.5 写"从不读 `text/html`"；文档 `:225` 标题仍是"从不读"、`:235` 仍是"永远排不上用场"；  
而我"这一轮对 R8 写了正式更正块，对 R6b 一个字都没回应"。

**核实结果：这是我方**上一&#x8F6E;**（它取证之前）已完成的更正，它读到的是旧快照。**

- `grep "永远排不上用场"` → **零命中**（已删除）。
- `grep "网页版同样没有"` → **只剩 `:207` 那条更正块里的引述**（"本节初版写的…**是错的**，已删除"）。
- 我方最终报告 §2.3 标题即"**成立，我错；但它的机理也不准**"，正文给了完整调用链。

**更重要的是：它给的"准确说法"仍然不准。** 它写"准确说法是**被 `:1776` 抢先短路**"、"`:1836 return false`  
仍交回 PM 读 HTML"。这两句描述的是**外层可观测行为**，但**仍然预设"PM 只在兜底时才读 HTML"**。  
真正的机理（我方上一轮已给出）是：

```
editHandlers.paste(:3728) → doPaste(view, text, data.getData("text/html"), …)(:3738)
  → parseFromClipboard(:3709)      ← HTML 在此已被 schema 解析成无损 slice
  → someProp("handlePaste", f => f(view, event, slice || Slice.empty))(:3710)  ← slice 递进来
```

而应用签名 `(view, event)`（`RichTextEditor.tsx:1756`）**把 slice 丢掉**。  
⇒ 准确说法不是"被 `:1776` 抢先短路"，而是"**应用丢弃了一个 PM 已经解析好的无损 slice**"。  
它这条纠错的**方向对（我确实写过"从不"），但它连自己要取代的那句话也没说对**。

**它唯一立得住的部分**：提醒"若把不准确的措辞写进 `AGENTS.md` 会把后续排障带偏"——**这个提醒是对的**，  
我的措辞在上一轮已按"丢弃 slice"重写，`AGENTS.md` 尚未写入（等代码落地才写），所以没有被带偏。

### C2 —— N-5 的失败模式判断错：**成立，我错**

**它说**：`formatUiError(error: unknown, context: UiErrorContext)`（`:49`）+ `CONTEXT_MESSAGES:
Record<UiErrorContext, string>`（`:18`）⇒ 传未登记 key 是**编译期类型错误**，`tsc -b` 当场拦住，  
**不会**"渲染成 `undefined（诊断编号 …）`"；只有跨 JS 边界或 `as` 断言才静默。

**核实结果：完全成立。**

```
src/lib/uiError.ts:49   export const formatUiError = (error: unknown, context: UiErrorContext): string =>
src/lib/uiError.ts:18   const CONTEXT_MESSAGES: Record<UiErrorContext, string> = {
```

- 调用点盘点：`grep -rn "formatUiError(" src --include=*.ts --include=*.tsx` → **51 处**；  
  `--include=*.js --include=*.cjs` → **0**；`desktop/` → **0**。  
  ⇒ **不存在绕开类型检查的调用路径**，闭集在这里是**安全性优势**，不是风险。
- 我的错法值得单记：我描述的是 `CONTEXT_MESSAGES[context]` 的**运行期查表机制**（这部分描述没错），  
  但**没有检查这条路径是否可达**。  
  **这正是我在 §2.11 用来判对方的标准**——我当时判它"成立但不可达"并把优先级下调。  
  ⇒ **同一条标准必须双向适用**：这次轮到我自己被同一条标准判掉。
- 行动项（S-1：先扩 union + 文案表）**不变，依据更正**：性质从"运行期风险"改为**编译期前置条件**。

### C3 —— N-4 的爆炸半径一半是错的：**成立，我错**

**它说**：`:822-823` 的 `rawMarkdownText` 第 4 参传的是**字符串**，所以 `spec.leafText` 不被查 ⇒ 免疫；  
真正受影响的只有 `:1569`。

**核实结果：成立。**

```ts
// src/components/RichTextEditor.tsx:822-823
const rawMarkdownText = (node: ProseMirrorNode): string =>
  node.textBetween(0, node.content.size, "\n", "\n");   // 第3参=块分隔符；第4参=leafText（字符串）
```

```js
// prosemirror-model/dist/index.js:121-123
: leafText ? (typeof leafText === "function" ? leafText(node) : leafText)
    : node.type.spec.leafText ? node.type.spec.leafText(node)
        : "";
```

字符串 `"\n"` 是真值 ⇒ 每个叶子直接得到字面量 ⇒ `spec.leafText` **永不被查询** ⇒ `:823` 免疫。  
`:1569` 是 3 参调用（`textBetween(changedRange.from, changedRange.to, "\n")`，无 `leafText`）  
⇒ 会回落 `spec.leafText` ⇒ **唯一真实受影响点**。

**它的结论（S-2：改动收在复制路径内）不变，且仅凭 `:1569` 一处即已足够成立**——  
所以这是"依据收窄、结论不变"，我认。

### C4 —— S-3 的行号指错，照抄会改错位置：**成立，我错**

**核实结果：成立，且行号确认无误。**

```
2360:    expect(clipboard.get("text/markdown")).toBe(clipboard.get("text/plain"));
2363:  it("keeps formulas crossed by a mixed DOM selection when endpoint mapping skips their atoms", …
2320:  it("copies formulas when the browser DOM selection spans their node views", …    ← 用例起始行
```

断言在 **`:2360`**，`:2320` 是用例起点。**S-3 是"修 P1 的前置硬阻塞"，行号错代价最高**——  
一条批评我引用不精确的报告，在自己最关键的动作项上偏了 40 行。这条批评成立，已就地更正。

### C5 —— §6.3 是未经证据的归因 + 销毁共享证据：**部分成立**

**它说两件事**：

**(a) 我方 §6.3 断言"遗留探针其实是本会话我方刚创建"没有依据**——它给出的反证是  
"会话初始的 git 快照里就有 `?? src/components/zz-tmp-clipboard-probe.test.tsx`（没有 e2e 那个）"。  
**核实结果：双向都不可证，我的断言超出证据。**  
`ls src/components | grep zz-tmp` → 无；`ls e2e | grep zz-tmp` → 无；  
`git log --oneline --all -- '*zz-tmp*'` → **空**（从未提交）。⇒ 现在无从判定创建时点。  
**但它的反证也不成立**：所谓"会话初始快照"的时点在**会话中段**（它开始审查时），  
一份中段快照天然包含中段生成的文件，**区分不了先后**。  
⇒ 正确写法是"**来源未证实**"，而不是任一方的事实断言。  
配套事实：`zz-tmp-` 前缀是我自己的探针命名约定（记在工作区记忆里），但**约定不是时间线证据**。

**(b) 我删除了两个未跟踪探针，导致双方的载荷证据不可复现**——**操作属实**  
（两个文件确已不在，且无 git 历史）。但要分三层说清：

1. **载荷快照已记录在案**，不是"证据全毁"：`docs/editor-clipboard-copy-paste-rootcause-2026-09-18.md`  
   的实测段里有插桩计数（`setData text/html: 760 / text/markdown: 96 / text/plain: 96`）  
   与真实载荷原文（`<record-inline-math data-formula-id="…" data-latex="e^{i\pi}+1=0">`）。
2. **重建一次等价探针即可复现**——"不可复现"说过头了，准确说法是"**需要重建**"，  
   而这正是它自己 O-1 的动作项。
3. **它点出的张力我接受**：我批评对方对"工作树里的临时文件"的解释，**而真正删除探针的是我**。  
   这一条计入我自己的失败模式（见 §6）。

---

## 4. 它对我方最终清单的指控：**成立，我认**

**它说**：我方 S-1…S-9 覆盖 copy/cut/leafText/测试断言/真 markdown/table 取舍/拖拽/决策项/回归用例，  
**没有一条对应右键菜单**。

**核实结果：对"我方核验报告 §5"完全成立。** 逐行核对 S-1…S-9，确实**没有任何一条接住右键**。  
P2 能力项在修订清单里整条缺失——而右键正是用户最不满的三个症状之一。  
（后续状态：我方最终报告 §6 已补 P2-1 并收敛到桌面端路线 B；本轮再补为 **S-10**。  
但它对**该文档**的指控是对的，**不因后续补上而免除**。）

**它附带的两条依据属过期快照**：":206 的'网页版同样没有'未更正"（已更正，现只剩更正块里的引述）、  
":449 仍'建议 A'"（已收敛为"B 是唯一必要的那条"，见 `:516-517`）。  
⇒ **结论对、依据旧**，仍按结论接受。

**它给出的路线 B 理由我完全同意**：右键缺失是 Electron 特有（`src/` 零 `contextmenu` 监听、  
无任何 preventDefault，而 Chrome/Edge 在 `contenteditable` 选区上给原生菜单）；  
既然只有桌面缺，"跨端一致"这个 A 路线的前提就不存在 ⇒  
`Menu.buildFromTemplate` + `webContents.on('context-menu')` → `popup`，  
role 用 `copy/cut/paste/selectAll/pasteAndMatchStyle`，约 20 行，不碰 `execCommand` 兼容性赌注。

---

## 5. 对 P0-1③ 的异议：**我接受，并认为理由比它给的更强**

**它反对**：P0-1③"拿不到选区时复制'最近可复制单元'/光标相邻整块"——在用户什么都没选时把**猜出来的内容**  
写进系统剪贴板，破坏"空选区 Ctrl+C = 无操作"的通用约定，且会覆盖用户上一份有用的复制内容；  
症状从"没反应"变成"复制错了东西"，更难归责。

**先确认它不是空打**：我回查，**该方案确实是我提的**——  
`docs/editor-clipboard-copy-paste-rootcause-2026-09-18.md` P0-1 第 ③ 条原文含  
"`$from.parentOffset === 0` 且 `$from.nodeBefore` 存在，则取该相邻块"与  
"用 `view.docView.nearestDesc(target, true)` 找到承载节点再用 `NodeSelection.create(...)`"。  
所以这不是误读，我确实写过。

**核实结果：我接受，并追加两条更强的理由**：

1. **它与 P0-3 重叠**。它想覆盖的场景是"点了公式想复制它"。而 P0-3（单击 → `NodeSelection`，  
   去掉 `RecordEditorNodes.tsx:136-140` / `:203-207` 抢跑的 `onClick`）落地后，**那个手势本身就产生真实选区**，  
   ③ 不再需要。
2. **③ 剩下的场景恰好是最不该猜的**：光标停在某处、确实什么都没选。  
   `$from.parentOffset === 0 && nodeBefore` 意味着"光标在段落开头且有前一个兄弟块"  
   ——此时 Ctrl+C 拿到的是**上一个块**，这是纯粹的行为惊喜。
3. **在 copy 阶段做这个判断本身就是错的层次**：handler 无法知道"用户刚才是点击了节点还是敲了光标"，  
   这个信息只在 pointer/click 阶段存在。⇒ 应在**交互层**解决，而不是在 copy 阶段反推。

⇒ **撤销 ③**，改为它提的两半：**交互层根治（P0-3）+ 失败显式化（不 `preventDefault`、不 `clearData`、一次性提示）**。  
已就地改掉根因文档 P0-1。

---

## 6. 我这一轮暴露的失败模式（必须记下）

**同一个错误犯了两次，而且第二次是拿我自己的判据判我自己。**

| 轮次       | 我的断言                                     | 错法                                   |
| -------- | ---------------------------------------- | ------------------------------------ |
| 上一轮（我判它） | 它的"`clipboardData === null` 是桌面端复现路径"    | 判为"**成立但不可达**"，下调优先级 ✅ 判对了           |
| 本轮（它判我）  | 我的 N-5"未登记 key 会渲染成 `undefined（诊断编号 …）`" | **只描述了运行期机制，没检查可达性**——它完全不可达（编译期拦住）❌ |

**教训：机制描述成立 ≠ 该路径可达 ≠ 该路径有实际影响。三者必须分开核。**  
一条断言要通过三关：①机制在源码里成立 ②从类型化/受控调用点可达 ③可达时后果真实有害。  
我在 N-4 上还犯了同族的另一个变体：**列了"受影响的两处"却没逐处核对参数形态**  
（`:823` 传的是字符串 `leafText`，一行就能看出它免疫）。

**另外两条**：

- **引用了"用例起始行"当"断言行"**（`:2320` vs `:2360`）：在标注前置硬阻塞这种高代价动作项时，  
  行号必须精确到断言行。
- **把推测写成事实**（§6.3 探针来源）：无法证明的时点问题，应写"未证实"。  
  **以及：我批评别人对临时文件的解释，而实际删除探针的是我。**

---


## 7. 合并后的最终事实表（双方合并 · 采用 `[实]/[码]/[?]` 分级）

| ID  | 事实                                                                                                                                                                                                                                                                | 等级          | 证据                                                                                      | 分级                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------- | --------------------- |
| F1  | 无 `Menu` import、无 `context-menu` 监听、preload 无通道 ⇒ **仅 Electron** 无原生右键菜单（浏览器对 `contentEditable` **有**）                                                                                                                                                            | `[码]`       | `desktop/main.cjs:1,994,1039`；`src/` 零 `contextmenu` 命中                                 | P2（需解冻）               |
| F2  | 空/坍缩选区 → copy 静默 `return false` → **剪贴板保持旧值**                                                                                                                                                                                                                     | `[实]`       | 哨兵值未变；`:1663-1668` + PM `:3668-3669`                                                    | **P0 首因**             |
| F3  | 单击公式卡片即进编辑态（`activeElement = textarea[aria-label="块公式"]`），不产生 `NodeSelection`                                                                                                                                                                                     | `[实]`       | `RecordEditorNodes.tsx:136-140,203-207`                                                 | P0                    |
| F4  | 非公式 atom 在 `text/plain`/`text/markdown` 里落空串（`leafText` 回调只认两种公式节点，全仓无 `spec.leafText`）                                                                                                                                                                           | `[实]`       | `RichTextEditor.tsx:455-465`；grep 仅命中 `:464`                                            | P0                    |
| F5  | `recordTabStop.renderText()` 被 Tiptap 挂成 `spec.toText`，**不参与** `textBetween`                                                                                                                                                                                      | `[码]`       | `@tiptap/core:507-509`；`prosemirror-model:121-123`                                      | P0（易误判为已修）            |
| F6  | `text/markdown` 与 `text/plain` 逐字节相同（`# 标题` → `标题`）                                                                                                                                                                                                               | `[实]`       | `:455-465`；探针载荷一致                                                                       | P1                    |
| F7  | `text/html` 里公式/结构块是零内容自定义标签 ⇒ 外部应用渲染空白（**内部往返无损**）                                                                                                                                                                                                               | `[实]`       | `renderHTML :365-367,421-423`；PM 用 `DOMSerializer.fromSchema`                           | P1                    |
| F8  | schema 无 table 节点；外部 `<table>` 粘贴塌成孤立段落                                                                                                                                                                                                                           | `[实]`       | 依赖清单；jsdom 探针得 `<p>…</p>` 序列                                                            | 决策项                   |
| F9  | 应用内复制→粘贴结构块丢失：**PM 已在 `:3709` 解析好 HTML slice 并在 `:3710` 递入，应用 `(view, event)` 签名丢弃它**，改去重解析 markdown/plain                                                                                                                                                        | `[码]`       | PM `:3708-3710,2819-2848,2889`；`RichTextEditor.tsx:1756,1776-1794`                      | **P1（修法极省）**          |
| F10 | Ctrl+X 走 PM 内置 cut（`handlers.copy = editHandlers.cut`，`:3665`）；差异是无 `text/markdown`、无 DOM 选区兜底；且 `cut ∈ editHandlers` + `dispatchEvent` 门控 `:3139-3141` ⇒ **只读态 Ctrl+X 完全无动作**（而 Ctrl+C 仍可用，因为应用自带 `handleDOMEvents.copy`，`runCustomHandler` 先行且不受 `editable` 门控） | `[码]`       | `:3665,3907-3908,3138-3141`；应用 `handleDOMEvents` 6 键**无 `cut`**、全文 `grep '\bcut\b'` 零命中 | P0                    |
| F11 | **`dragstart` 无条件 `preventDefault()+return true` 单独即足以阻断全部拖拽**（props 先于内置 handler）；9 处 `spec.draggable:false` 只影响节点整体拖拽；**根 `draggable="false"` 对"文本选区拖出"的独立作用未实测**                                                                                               | `[码]`/`[?]` | `:3138-3141`；`:1659,1682-1685`；PM `:3380-3398`                                          | P2                    |
| F12 | E2（3px vs 6px 落点）有**两个同现象成因**：(i) `posAtDOM` 抛 `RangeError`（`:5774-5777`，调用点 `:486-487` 在 try 外）、(ii) `slice === undefined` → `return false`。**判别需 `page.on("pageerror")`**                                                                                       | `[码]`+`[?]` | `runCustomHandler`（`:3121-3126`）不 catch                                                 | P0（**含一条判别性测试，须最先做**） |
| F13 | 只读态（`ReviewPage.tsx:1052`）：非坍缩 DOM 选区下 copy 正常产出三通道；点公式后仍零输出；**只读态点公式不进编辑**（`if (editable && …)` 守卫）⇒ F3 仅限可编辑态                                                                                                                                                   | `[实]`       | 我方 N-6 实测 + 应用 `editable: !readOnly`（`:1600`）                                           | 验收必测                  |
| F14 | 测试把缺陷锁成契约：**`RichTextEditor.test.tsx:2360`** 断言 `markdown === plain`；全文无一处剪贴板 `text/html` 载荷断言                                                                                                                                                                    | `[码]`       | grep 复核                                                                                 | P1 前置硬阻塞              |
| F15 | 全局加 `spec.leafText` 的**唯一**真实爆炸点是 `:1569`；`:823` 因传字符串 `leafText` 而免疫                                                                                                                                                                                             | `[码]`       | `:822-823`；`prosemirror-model:121-123`；`:1569`                                          | 约束                    |
| F16 | `UiErrorContext` 闭集无 `editor-clipboard`；补它是**编译期前置条件**（`formatUiError` 第二参即该类型，51 处调用点全在 `.ts/.tsx`）                                                                                                                                                              | `[码]`       | `uiError.ts:1-12,18,49`                                                                 | P0 附带                 |
| F17 | 环境阻塞：`electron@43.2.0` 已声明但 `node_modules/electron/dist` 不存在 ⇒ 桌面行为无法真机验证                                                                                                                                                                                         | `[码]`       | —                                                                                       | 前置                    |
| F18 | 取证方法：`navigator.clipboard.read()` 只暴露 `plain`/`html`，**不暴露 `markdown`** ⇒ 判"有没有写 markdown"必须读事件里的 `clipboardData.types`                                                                                                                                           | `[实]`       | 我方 N-7                                                                                  | 测试约束                  |
| F19 | "复制复习重点"是**就地插副本**（`tr.insert` + 重生成 `decisionBlockId`），与剪贴板无关                                                                                                                                                                                                    | `[码]`       | `RecordDecisionBlockNode.tsx:77-89,110`                                                 | 命名建议                  |
| F20 | **剪贴板载荷快照存于文档**（插桩计数 + 真实 HTML 原文），探针文件虽已删除但可重建                                                                                                                                                                                                                   | `[实]`       | `rootcause-2026-09-18.md` 实测段                                                           | 证据可重建                 |

---


## 8. 落地顺序（合并版 · 含顺序依赖）

**第 0 步（前置，先做判别性证据）**

- **O-1** 先做 F12 的**判别性测试**：复制过程监听 `page.on("pageerror")` → 一次定论 (i) 还是 (ii)。  
  **不做这步，P0-1 与 P0-2 谁是真凶无法定论**（先改哪一处都是猜）。
- **O-2** 把一次性探针以**正式回归测试**形态重建（原文件已删、未跟踪、无 git 历史），  
  断言覆盖**三通道**（`text/html`/`text/markdown`/自定义 JSON）+ **只读态各一遍**（F14/F18）。
- **O-3** 决定是否安装 Electron 二进制（F17）——否则桌面侧（F1/F10/F11）只能静态判定。

**P0 缺陷（维护范围，无契约变更）**

- **A1** copy 补失败显式化：拿不到内容时**不 `preventDefault`**、**不 `clearData`**，  
  剪贴板保持原值 + 一次性提示（**先扩 `UiErrorContext` union 与文案表，编译期前置**，F16）。  
  **不含"猜测式兜底"**（③ 已撤销，见 §5）。
- **A2** `posAtDOM`（`:486-487`）包 try/catch（F12）。
- **A3** `text/plain`/`text/markdown` 的 atom 文本：在 `serializeClipboardText` 内**按节点名分派**到既有  
  `structureBlockPlainTextFromElement`/`structureBlockMarkdownFromElement`（`recordStructureBlocks.ts:201/215`）
  - 补 `recordMermaidDiagram`/`recordAsset`/`recordReference`/`recordTabStop`。  
    **不往全局 schema 加 `leafText`**（F15：唯一受影响点是 `:1569`）。
- **A4** 新增 `handleDOMEvents.cut`，与 copy 同源 + `deleteSelection()`，  
  **顺带解决只读态 Ctrl+X 无动作**（F10）。

**P1 让产物真正可用（需解冻）**

- **B1** 先改 `test.tsx:2360` 的 `markdown === plain` 断言（F14），否则 P1 改不动。
- **B2** 真 Markdown serializer：用已在依赖且已在用的 `prosemirror-markdown`  
  （`package.json:79`、`src/lib/markdownEditor.ts:2`），不新装包。  
  **⚠️ 双方都低估的连带风险**：粘贴端 `:1776` 优先吃 markdown，载荷变强后必须**重测往返**，  
  否则正文里字面的 `**foo**`/`#` 会被误解析成格式。
- **B3** `text/html` 给公式补 KaTeX HTML 或 MathML（保留 `data-latex` 与自定义标签，不破坏内部反解析）。
- **B4** **粘贴端接住 PM 递来的第三参数 `slice`**（F9）——比"自己读 `htmlText` 再手工 `parseClipboardSlice`"  
  更省事、不重复解析；备选判据：命中 `data-pm-slice`/`<record-*` 标记。
- **B5** 新增 `application/x-studyjournal+json` 无损载荷（满足"JSON 原样复制"）。
- **B6** 单击公式 = `NodeSelection`，双击/Enter/按钮 = 编辑（F3；只影响可编辑态，F13）。

**P2 能力新增（需解冻）**

- **C1【上一轮清单里缺失，本轮补上】** 右键菜单走**路线 B**（Electron 主进程 `Menu` +  
  `context-menu` + `popup`，role `copy/cut/paste/selectAll/pasteAndMatchStyle`）。  
  放弃 A 的理由：F1 修正后"跨端一致"这个前提不存在。
- **C2** 拖拽只做"外部文件拖入 → `insertPastedAssets`"，渲染层自接 `dragover`/`drop`  
  （否则被 `will-navigate`（`main.cjs:1039`）吃掉）；不做块拖拽排序。
- **C3** `Ctrl+A` 语义列为**决策项**，不默认改：结构块单元格是真 `<input>`/`<textarea>` 宿主，  
  抢走 Ctrl+A 会让用户无法清空单格文本。

**待用户决策**：D1 是否补 scope 解冻文档；D2 公式单击语义（与 B6 同一项）；  
D3 `Ctrl+A` 语义（= C3）；D4 `text/plain` 给人读还是给机器读。

---

## 9. 本轮文档动作

| 文件                                                                      | 动作                                                                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `docs/audit/editor-clipboard-third-round-adjudication-2026-09-18.md`    | **新建**（本文件）                                                                                                       |
| `docs/editor-clipboard-copy-paste-rootcause-2026-09-18.md`              | P0-1 第③条**撤销**并入 P0-3 说明（§5）；N-5 理由更正（编译期前置条件）；`leafText` 爆炸半径收窄到 `:1569`；测试行号 `:2320` → `:2360`；P0-2 补 F12 判别性测试 |
| `docs/audit/editor-clipboard-external-audit-verification-2026-09-18.md` | 追加"第三轮 5 处我方错误"表；N-3/N-4/N-5 就地更正；S-3 行号更正；补 **S-10（右键）** 与 **O-1（判别性测试）**；§6.3 改为"来源未证实"                         |

**未复核项（如实标注）**：

- 它"会话初始 git 快照里就有单元探针"这一陈述**我无法核实**（无该快照）；我据此判为"双向不可证"。
- 根 `draggable="false"` 对"文本选区拖出"的独立作用（F11 的 `[?]`）**双方均未实测**；  
  Electron 二进制缺失（F17），桌面侧断言目前只能静态判定。
- 它引用的基线数字（`1436 passed / 3 skipped`）我**未跑全量套件**复核。

---

*本报告全部库行号来自 `node_modules/prosemirror-view/dist/index.js`、`prosemirror-model/dist/index.js`、  
`@tiptap/core/dist/index.js`；源码行号来自当期工作树；核实命令与输出见正文。*
