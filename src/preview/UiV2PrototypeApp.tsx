import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bold,
  BookOpenCheck,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Cloud,
  Filter,
  Headphones,
  Highlighter,
  Home,
  Italic,
  KeyRound,
  Layers3,
  List,
  MessageSquareText,
  Mic2,
  MoreHorizontal,
  NotebookPen,
  PanelRight,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Undo2,
  Wrench,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isDesktopPlatform, isNativePlatform } from "../lib/platform";
import "@fontsource-variable/jetbrains-mono";
import "./uiV2Prototype.css";

type View = "today" | "library" | "review" | "tools" | "editor" | "settings";
type ReviewSection = "session" | "coach" | "cards";
type CoachSection = "analysis" | "running" | "tasks" | "insights";
type ExerciseState = "list" | "answer" | "feedback" | "verification";
type SaveState = "draft" | "saving" | "saved" | "error";
type VisualTheme = "modern" | "reading";

const subjects = ["计算机网络", "数据结构", "操作系统", "计算机组成", "算法设计与复杂度分析", "计算机系统基础与性能工程"];

const records = [
  {
    id: "bfs",
    title: "BFS 中 visited 标记时机与重复入队问题",
    subject: "数据结构",
    date: "今天 09:42",
    excerpt: "首次发现相邻节点时应先标记 visited，再加入队列。若在出队时才标记，同一节点可能被多个父节点重复加入队列。",
    tags: ["图", "易错点"],
  },
  {
    id: "tcp",
    title: "TCP 拥塞窗口、接收窗口与发送窗口之间的限制关系",
    subject: "计算机网络",
    date: "昨天 22:18",
    excerpt: "发送方实际可用窗口取拥塞窗口与接收窗口的较小值，还要扣除已经发送但尚未确认的数据。",
    tags: ["TCP", "窗口"],
  },
  {
    id: "paging",
    title: "请求分页系统中缺页中断处理流程，以及页表项状态变化的完整顺序",
    subject: "操作系统",
    date: "9 月 5 日",
    excerpt: "硬件发现页不存在后触发缺页异常，操作系统检查地址合法性、选择页框、换出脏页并更新页表与 TLB。",
    tags: ["内存管理", "长标题示例"],
  },
  {
    id: "cache",
    title: "Cache 地址映射：组号、Tag 与块内地址",
    subject: "计算机组成",
    date: "9 月 4 日",
    excerpt: "组相联映射先由组索引定位集合，再并行比较集合中各路的 Tag。",
    tags: ["Cache"],
  },
];

const navItems = [
  { id: "today" as const, label: "今天", icon: Home },
  { id: "library" as const, label: "日志", icon: NotebookPen },
  { id: "review" as const, label: "复习", icon: RotateCcw },
  { id: "tools" as const, label: "工具", icon: Wrench },
];

const saveLabels: Record<SaveState, string> = {
  draft: "草稿已存于本机",
  saving: "正在保存正式内容...",
  saved: "已保存到本机 · 尚未同步",
  error: "保存失败 · 草稿仍在本机",
};

const canPreviewUiV2 = (): boolean => {
  if (typeof window === "undefined") return false;
  // The Android Capacitor WebView and the Electron shell both serve from a localhost host,
  // so the prototype shells must also be excluded on native/desktop platforms.
  if (isNativePlatform() || isDesktopPlatform()) return false;
  const host = window.location.hostname;
  return (host === "127.0.0.1" || host === "localhost")
    && new URLSearchParams(window.location.search).get("preview") === "ui-v2";
};

export const isUiV2PrototypeRequest = (): boolean => canPreviewUiV2();

interface ScreenHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

const ScreenHeader = ({ eyebrow, title, description, action }: ScreenHeaderProps) => (
  <header className="uv2-page-header">
    <div>
      {eyebrow && <p className="uv2-eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
    {action && <div className="uv2-header-action">{action}</div>}
  </header>
);

const TodayScreen = ({ onWrite, onChoose, onReview, onOpenRecord, onCoach }: {
  onWrite: () => void;
  onChoose: () => void;
  onReview: () => void;
  onOpenRecord: () => void;
  onCoach: () => void;
}) => (
  <div className="uv2-page uv2-today">
    <ScreenHeader
      eyebrow="9 月 7 日 · 星期一"
      title="今天想记下什么？"
      description="把刚刚理解的内容留在这里，稍后再整理也可以。"
    />

    <section className="uv2-compose-band" aria-label="新建学习日志">
      <button type="button" className="uv2-compose-main" onClick={onWrite}>
        <NotebookPen size={20} />
        <span><strong>开始记录</strong><small>计算机网络</small></span>
        <ArrowRight size={18} />
      </button>
      <button type="button" className="uv2-icon-button" onClick={onChoose} aria-label="选择其他学科或模板" title="选择其他学科或模板">
        <ChevronDown size={19} />
      </button>
    </section>

    <section className="uv2-today-grid">
      <div className="uv2-primary-column">
        <div className="uv2-section-heading">
          <div><p className="uv2-eyebrow">今日复习</p><h2>4 条日志等待回看</h2></div>
          <button type="button" className="uv2-primary-button" onClick={onReview}>开始复习 <ArrowRight size={17} /></button>
        </div>
        <div className="uv2-progress-line"><span style={{ width: "38%" }} /></div>
        <p className="uv2-muted">预计 12 分钟 · 已完成 3 / 7</p>

        <div className="uv2-section-heading uv2-recent-heading">
          <h2>最近日志</h2><button type="button" className="uv2-text-button">查看全部</button>
        </div>
        <button type="button" className="uv2-record-row" onClick={onOpenRecord}>
          <span className="uv2-date-block"><strong>07</strong><small>SEP</small></span>
          <span className="uv2-record-copy"><strong>{records[0].title}</strong><small>{records[0].subject} · 8 分钟前</small></span>
          <ChevronRight size={18} />
        </button>
        {records.slice(1, 3).map((record) => (
          <button type="button" className="uv2-record-row" key={record.id} onClick={onOpenRecord}>
            <span className="uv2-date-block"><strong>06</strong><small>SEP</small></span>
            <span className="uv2-record-copy"><strong>{record.title}</strong><small>{record.subject} · {record.date}</small></span>
            <ChevronRight size={18} />
          </button>
        ))}
      </div>

      <aside className="uv2-today-aside">
        <p className="uv2-eyebrow">学习节奏</p>
        <div className="uv2-week-bars" aria-label="最近七天学习记录数量">
          {[42, 68, 36, 82, 56, 92, 64].map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}
        </div>
        <div className="uv2-aside-stat"><strong>6 天</strong><span>本周有记录</span></div>
        <button type="button" className="uv2-context-action" onClick={onCoach}>
          <Sparkles size={17} /><span><strong>2 个卡点可以继续训练</strong><small>进入学习助教</small></span><ChevronRight size={17} />
        </button>
      </aside>
    </section>
  </div>
);

const LibraryScreen = ({ onOpenRecord }: { onOpenRecord: () => void }) => {
  const [query, setQuery] = useState("");
  const [subject, setSubject] = useState("全部");
  const visibleRecords = records.filter((record) => (
    (subject === "全部" || record.subject === subject)
    && `${record.title}${record.excerpt}${record.tags.join("")}`.toLocaleLowerCase("zh-CN").includes(query.toLocaleLowerCase("zh-CN"))
  ));

  return (
    <div className="uv2-page uv2-library">
      <ScreenHeader title="日志资料库" description="按时间浏览，也可以直接从学科和全文内容缩小范围。" />
      <div className="uv2-library-toolbar">
        <label className="uv2-search"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、正文、图片文字" /></label>
        <button type="button" className="uv2-secondary-button"><Filter size={17} />筛选</button>
      </div>
      <div className="uv2-subject-strip" role="tablist" aria-label="按学科筛选">
        {["全部", ...subjects].map((item) => <button type="button" role="tab" aria-selected={subject === item} className={subject === item ? "active" : ""} key={item} onClick={() => setSubject(item)}>{item}</button>)}
      </div>
      <div className="uv2-list-caption"><span>{visibleRecords.length} 条日志</span><button type="button">最近更新 <ChevronDown size={15} /></button></div>
      <section className="uv2-library-list">
        {visibleRecords.map((record) => (
          <article className="uv2-library-row" key={record.id}>
            <button type="button" className="uv2-library-main" onClick={onOpenRecord}>
              <span className="uv2-library-meta">{record.date} · {record.subject}</span>
              <strong>{record.title}</strong>
              <p>{record.excerpt}</p>
              <span className="uv2-tag-line">{record.tags.map((tag) => <small key={tag}>{tag}</small>)}</span>
            </button>
            <button type="button" className="uv2-icon-button" aria-label={`收藏 ${record.title}`} title="收藏"><Star size={17} /></button>
          </article>
        ))}
        {visibleRecords.length === 0 && <div className="uv2-empty"><Search size={24} /><h2>没有找到相关日志</h2><p>换一个关键词，或清除当前学科筛选。</p><button type="button" className="uv2-secondary-button" onClick={() => { setQuery(""); setSubject("全部"); }}>清除筛选</button></div>}
      </section>
    </div>
  );
};

const EditorScreen = ({ onBack, initialEditing }: { onBack: () => void; initialEditing: boolean }) => {
  const [editing, setEditing] = useState(initialEditing);
  const [saveState, setSaveState] = useState<SaveState>("draft");
  const [wide, setWide] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const save = () => {
    setSaveState("saving");
    window.setTimeout(() => setSaveState("saved"), 500);
  };

  return (
    <div className={`uv2-editor ${wide ? "is-wide" : ""}`}>
      <header className="uv2-editor-header">
        <button type="button" className="uv2-icon-button" onClick={onBack} aria-label="返回日志" title="返回日志"><ArrowLeft size={19} /></button>
        <div className={`uv2-save-state ${saveState === "error" ? "is-error" : ""}`}>
          {saveState === "error" ? <AlertCircle size={15} /> : <Check size={15} />}<span>{saveLabels[saveState]}</span>
        </div>
        <div className="uv2-editor-actions">
          {!editing && <button type="button" className="uv2-primary-button" onClick={() => setEditing(true)}>编辑</button>}
          {editing && <button type="button" className="uv2-primary-button" onClick={save} disabled={saveState === "saving"}><Save size={16} />保存</button>}
          <button type="button" className="uv2-icon-button" onClick={() => setMoreOpen((value) => !value)} aria-label="更多操作" title="更多操作"><MoreHorizontal size={19} /></button>
          {moreOpen && <div className="uv2-menu"><button type="button" onClick={() => { setWide((value) => !value); setMoreOpen(false); }}><PanelRight size={16} />{wide ? "标准宽度" : "宽内容模式"}</button><button type="button" onClick={() => { setSaveState("error"); setMoreOpen(false); }}><AlertCircle size={16} />查看保存失败状态</button></div>}
        </div>
      </header>

      <main className="uv2-document">
        <div className="uv2-document-meta"><button type="button">数据结构 <ChevronDown size={14} /></button><span>2026 年 9 月 7 日</span><button type="button">图</button><button type="button">易错点</button></div>
        {editing ? <input className="uv2-title-input" defaultValue="BFS 中 visited 标记时机与重复入队问题" aria-label="日志标题" /> : <h1>BFS 中 visited 标记时机与重复入队问题</h1>}
        {editing && <div className="uv2-formatbar" role="toolbar" aria-label="文本格式">
          <button type="button" aria-label="粗体" title="粗体"><Bold size={17} /></button><button type="button" aria-label="斜体" title="斜体"><Italic size={17} /></button><button type="button" aria-label="列表" title="列表"><List size={17} /></button><button type="button" aria-label="高亮" title="高亮"><Highlighter size={17} /></button><span /><button type="button">插入 <ChevronDown size={15} /></button>
        </div>}
        <article className={`uv2-editor-body ${editing ? "is-editing" : ""}`} contentEditable={editing} suppressContentEditableWarning>
          <h2>为什么要在入队时标记</h2>
          <p>在 BFS 中，一个节点可能同时与多个已经访问到的节点相邻。如果等到出队时才标记 visited，那么这些父节点都有机会把它再次加入队列。</p>
          <blockquote><strong>关键结论：</strong>首次发现未访问节点时，先标记 visited，再执行 enqueue。</blockquote>
          <p>这并不是代码顺序上的偏好，而是用于维持“每个节点最多入队一次”的不变量。时间复杂度因此能够稳定在 O(V + E)。</p>
          <h2>容易混淆的写法</h2>
          <pre data-testid="wide-code"><code>{`for (const next of graph[current]) {\n  if (!visited[next]) {\n    visited[next] = true;\n    queue.push(next);\n    predecessorByNode.set(next, { parent: current, discoveredAtStep: traversalStep });\n  }\n}`}</code></pre>
          <p>如果题目要求输出最短路径，还应在同一位置记录 predecessor，避免后续覆盖首次发现路径。</p>
        </article>
        {saveState === "error" && <div className="uv2-inline-error" role="alert"><AlertCircle size={18} /><span><strong>暂时无法保存正式内容</strong><small>草稿仍存于本机。请重试。（诊断编号 RS-K4M2Q001）</small></span><button type="button" onClick={save}>重试</button></div>}
      </main>
      {editing && <div className="uv2-mobile-formatbar"><button type="button" aria-label="粗体"><Bold size={18} /></button><button type="button" aria-label="斜体"><Italic size={18} /></button><button type="button" aria-label="列表"><List size={18} /></button><button type="button" aria-label="高亮"><Highlighter size={18} /></button><button type="button" aria-label="更多格式"><Plus size={19} /></button></div>}
    </div>
  );
};

const ReviewSession = ({ onCoach, onExit }: { onCoach: () => void; onExit: () => void }) => {
  const [showNote, setShowNote] = useState(false);
  const [rated, setRated] = useState(false);
  const [note, setNote] = useState("");

  if (rated) {
    return <div className="uv2-review-complete"><div className="uv2-checkmark"><Check size={30} /></div><p className="uv2-eyebrow">评分已保存</p><h1>这条日志将在 6 天后再次出现</h1><p>你记录的卡点已与本次评分一起保存。</p><button type="button" className="uv2-context-action" onClick={onCoach}><BrainCircuit size={18} /><span><strong>生成一组针对性练习</strong><small>围绕 visited 标记时机</small></span><ChevronRight size={17} /></button><button type="button" className="uv2-secondary-button" onClick={() => setRated(false)}><Undo2 size={16} />撤回本次评分</button></div>;
  }

  return <div className="uv2-review-session">
    <div className="uv2-review-top"><button type="button" className="uv2-icon-button" onClick={onExit} aria-label="退出复习" title="退出复习"><ArrowLeft size={19} /></button><div className="uv2-review-progress"><span>3 / 7</span><div><i style={{ width: "43%" }} /></div><small>数据结构</small></div></div>
    <article className="uv2-review-content">
      <p className="uv2-eyebrow">BFS 中 visited 标记时机</p>
      <h1>为什么必须在节点入队时标记 visited？</h1>
      <p>一个节点可能同时被多个已经访问到的父节点发现。请先尝试回忆标记时机与它维护的不变量。</p>
      <details><summary>显示原日志内容</summary><p>首次发现未访问节点时先标记，再入队，从而确保每个节点最多进入队列一次。</p></details>
      {!showNote ? <button type="button" className="uv2-note-trigger" onClick={() => setShowNote(true)}><MessageSquareText size={17} />记录卡点</button> : <div className="uv2-review-note"><label htmlFor="review-note">这次卡在哪里？</label><textarea id="review-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：我总把 visited 的标记时机记成出队时..." rows={3} /><label className="uv2-check"><input type="checkbox" defaultChecked />评分后加入待分析</label></div>}
    </article>
    <div className="uv2-rating-bar" aria-label="复习评分">
      {["忘记", "模糊", "记得", "简单"].map((label, index) => <button type="button" key={label} onClick={() => setRated(true)}><strong>{label}</strong><small>{["10 分钟", "2 天", "6 天", "13 天"][index]}</small></button>)}
    </div>
  </div>;
};

const CoachScreen = () => {
  const [section, setSection] = useState<CoachSection>("analysis");
  const [selected, setSelected] = useState([true, true, false]);
  const [completed, setCompleted] = useState(3);
  const [exercise, setExercise] = useState<ExerciseState>("list");
  const [answer, setAnswer] = useState("");

  if (exercise !== "list") {
    const verification = exercise === "verification";
    return <div className="uv2-coach-exercise">
      <button type="button" className="uv2-back-button" onClick={() => setExercise("list")}><ArrowLeft size={17} />训练与验证</button>
      <div className="uv2-exercise-progress"><span>{verification ? "间隔验证" : "针对性训练"}</span><strong>{verification ? "到期" : "1 / 3"}</strong></div>
      {exercise === "answer" && <section className="uv2-question"><p className="uv2-eyebrow">变化题 · 预计 2 分钟</p><h1>如果把 visited 标记移动到出队之后，一个菱形图中最先会出现什么异常？</h1><textarea autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} rows={6} placeholder="用自己的话写下推理过程" /><div className="uv2-question-actions"><button type="button" className="uv2-text-button">查看提示</button><button type="button" className="uv2-primary-button" disabled={!answer.trim()} onClick={() => setExercise("feedback")}>提交回答 <ArrowRight size={16} /></button></div></section>}
      {exercise === "feedback" && <section className="uv2-feedback"><div className="uv2-feedback-heading"><span><Check size={20} /></span><div><p className="uv2-eyebrow">回答反馈</p><h1>基本正确，因果关系还可以更完整</h1></div></div><p>你已经指出同一节点会重复入队。还需要补充：两个父节点会在该节点第一次出队前分别发现它，因此队列和前驱记录都可能出现重复。</p><dl><div><dt>你已经掌握</dt><dd>重复入队的直接原因</dd></div><div><dt>下一轮关注</dt><dd>首次发现路径与 predecessor 的稳定性</dd></div></dl><details><summary>查看答案依据与来源材料</summary><p>来源：BFS 中 visited 标记时机与重复入队问题。首次发现时同时写入 visited 与 predecessor。</p></details><button type="button" className="uv2-primary-button" onClick={() => { setAnswer(""); setExercise("answer"); }}>继续下一轮 <ArrowRight size={16} /></button></section>}
      {verification && <section className="uv2-question uv2-verification"><p className="uv2-eyebrow">7 天后的新题验证</p><h1>不查看原记录，写出 BFS 发现相邻节点时的三步操作顺序。</h1><textarea rows={5} placeholder="写下操作顺序和理由" /><p className="uv2-muted">验证结果独立保存，不会改写整条日志的复习日期。</p><div className="uv2-question-actions"><button type="button" className="uv2-secondary-button">已经衰退</button><button type="button" className="uv2-primary-button">仍然掌握</button></div></section>}
    </div>;
  }

  return <div className="uv2-coach">
    <ScreenHeader eyebrow="复习 · 学习助教" title="把卡点变成下一次练习" description="分析、训练与间隔验证都保留在同一个学习任务中。" />
    <div className="uv2-coach-tabs" role="tablist">
      {([['analysis', '待分析'], ['running', '进行中'], ['tasks', '训练与验证'], ['insights', '学习洞察']] as const).map(([id, label]) => <button type="button" role="tab" aria-selected={section === id} className={section === id ? "active" : ""} key={id} onClick={() => setSection(id)}>{label}{id === "analysis" && <b>3</b>}</button>)}
    </div>
    {section === "analysis" && <section className="uv2-analysis-list"><div className="uv2-usage-summary"><BrainCircuit size={19} /><span><strong>将分析 {selected.filter(Boolean).length} 个学习重点</strong><small>预计用量中等 · 1 张图片没有可用文字</small></span><button type="button" className="uv2-text-button">用量详情</button></div>{[
      ["BFS 中 visited 标记时机", "数据结构 · 今天", "文字完整"],
      ["TCP 拥塞窗口与发送窗口", "计算机网络 · 昨天", "1 张图片缺少文字"],
      ["缺页中断处理顺序", "操作系统 · 2 天前", "文字完整"],
    ].map((item, index) => <label className="uv2-analysis-row" key={item[0]}><input type="checkbox" checked={selected[index]} onChange={() => setSelected((current) => current.map((value, position) => position === index ? !value : value))} /><span><strong>{item[0]}</strong><small>{item[1]}</small></span><em className={index === 1 ? "warning" : ""}>{item[2]}</em></label>)}<div className="uv2-sticky-action"><span>{selected.filter(Boolean).length} 项已选择</span><button type="button" className="uv2-primary-button" disabled={!selected.some(Boolean)} onClick={() => setSection("running")}>确认并开始分析</button></div></section>}
    {section === "running" && <section className="uv2-running"><div className="uv2-running-head"><div><p className="uv2-eyebrow">分析进行中</p><h2>已完成 {completed} / 6 个学习重点</h2></div><span>{Math.round(completed / 6 * 100)}%</span></div><div className="uv2-progress-line"><span style={{ width: `${completed / 6 * 100}%` }} /></div><p>上次在处理图片文字时暂停。已完成的结果会保留，只继续处理剩余内容。</p><button type="button" className="uv2-primary-button" onClick={() => setCompleted((value) => Math.min(6, value + 1))}>{completed === 6 ? <><Check size={17} />分析已完成</> : <>继续分析 <ArrowRight size={17} /></>}</button></section>}
    {section === "tasks" && <section className="uv2-task-list"><button type="button" className="uv2-task-row" onClick={() => setExercise("answer")}><span className="uv2-task-icon"><BookOpenCheck size={19} /></span><span><small>当前任务 · 约 6 分钟</small><strong>BFS 标记时机的变化题训练</strong><em>从因果解释开始，共 3 轮</em></span><ArrowRight size={18} /></button><button type="button" className="uv2-task-row" onClick={() => setExercise("verification")}><span className="uv2-task-icon blue"><Clock3 size={19} /></span><span><small>今天到期 · 间隔验证</small><strong>TCP 窗口限制关系</strong><em>使用新题检查能否独立提取</em></span><ArrowRight size={18} /></button><div className="uv2-task-row is-muted"><span className="uv2-task-icon"><Layers3 size={19} /></span><span><small>明天</small><strong>缺页中断处理顺序</strong><em>等待进入验证窗口</em></span></div></section>}
    {section === "insights" && <section className="uv2-insights"><div><strong>4</strong><span>已完成训练</span></div><div><strong>2</strong><span>通过间隔验证</span></div><div><strong>1</strong><span>需要重新巩固</span></div><p>目前样本还少。再完成 3 次间隔验证后，这里会显示不同练习方式的稳定趋势。</p></section>}
  </div>;
};

const ReviewScreen = ({ section, setSection, onExit }: { section: ReviewSection; setSection: (section: ReviewSection) => void; onExit: () => void }) => (
  <div className={`uv2-page uv2-review-page ${section === "session" ? "is-session" : ""}`}>
    {section !== "session" && <div className="uv2-review-nav"><button type="button" className={section === "coach" ? "active" : ""} onClick={() => setSection("coach")}>学习助教</button><button type="button" className={section === "cards" ? "active" : ""} onClick={() => setSection("cards")}>卡片库</button></div>}
    {section === "session" && <ReviewSession onCoach={() => setSection("coach")} onExit={onExit} />}
    {section === "coach" && <CoachScreen />}
    {section === "cards" && <div className="uv2-card-library"><ScreenHeader title="卡片库" description="管理哪些日志参与间隔复习，不与今日复习会话混在一起。" />{records.map((record) => <div className="uv2-library-row" key={record.id}><span className="uv2-library-main"><span className="uv2-library-meta">{record.subject}</span><strong>{record.title}</strong><p>下次复习：{record.date.includes("今天") ? "今天" : "6 天后"}</p></span><button type="button" className="uv2-icon-button" aria-label="卡片操作"><MoreHorizontal size={18} /></button></div>)}</div>}
  </div>
);

const SettingsScreen = ({ onBack }: { onBack: () => void }) => {
  const [advanced, setAdvanced] = useState(false);
  const [syncError, setSyncError] = useState(false);
  return <div className="uv2-page uv2-settings"><button type="button" className="uv2-back-button" onClick={onBack}><ArrowLeft size={17} />工具</button><ScreenHeader title="设置" description="偏好、服务和数据管理集中在一个位置。" />
    <section className="uv2-settings-section"><h2>数据与同步</h2><button type="button" className="uv2-setting-row" onClick={() => setSyncError((value) => !value)}><span className="uv2-setting-icon"><Cloud size={19} /></span><span><strong>云同步</strong><small>{syncError ? "需要处理" : "刚刚同步 · 仅传输 3 项更改"}</small></span><em className={syncError ? "error" : "ok"}>{syncError ? "重试" : "已同步"}</em></button>{syncError && <div className="uv2-inline-error"><AlertCircle size={18} /><span><strong>云同步未完成</strong><small>请检查网络后重试，本机数据不会因此删除。（诊断编号 CS-K4M2Q002）</small></span><button type="button" onClick={() => setSyncError(false)}>重试</button></div>}<div className="uv2-setting-row"><span className="uv2-setting-icon"><ShieldCheck size={19} /></span><span><strong>本地与自动备份</strong><small>上次自动备份：今天 08:10</small></span><ChevronRight size={17} /></div></section>
    <section className="uv2-settings-section"><h2>AI 与服务</h2><div className="uv2-setting-row"><span className="uv2-setting-icon"><KeyRound size={19} /></span><span><strong>模型服务</strong><small>DeepSeek · 连接正常</small></span><ChevronRight size={17} /></div><button type="button" className="uv2-setting-row" onClick={() => setAdvanced((value) => !value)}><span className="uv2-setting-icon"><SlidersHorizontal size={19} /></span><span><strong>高级参数</strong><small>上下文、输出长度与回答偏好</small></span><ChevronDown size={17} className={advanced ? "is-open" : ""} /></button>{advanced && <div className="uv2-advanced-settings"><label><span>回答长度</span><select defaultValue="balanced"><option value="concise">简洁</option><option value="balanced">平衡</option><option value="detailed">详细</option></select></label><label><span>上下文范围</span><select defaultValue="auto"><option value="auto">自动</option><option value="current">仅当前日志</option></select></label></div>}</section>
    <section className="uv2-settings-section"><h2>学习与外观</h2><div className="uv2-setting-row"><span className="uv2-setting-icon"><RotateCcw size={19} /></span><span><strong>复习偏好</strong><small>每日建议 20 条 · 启用模糊间隔</small></span><ChevronRight size={17} /></div><div className="uv2-setting-row"><span className="uv2-setting-icon"><Settings size={19} /></span><span><strong>显示与阅读</strong><small>跟随系统 · 正文 16px · 舒适行距</small></span><ChevronRight size={17} /></div></section>
  </div>;
};

const ToolsScreen = ({ onSettings, onCoach }: { onSettings: () => void; onCoach: () => void }) => <div className="uv2-page uv2-tools"><ScreenHeader title="工具" description="直接启动需要的能力；所有配置统一放在设置中。" action={<button type="button" className="uv2-icon-button" onClick={onSettings} aria-label="打开设置" title="设置"><Settings size={20} /></button>} /><section className="uv2-tool-list"><button type="button"><span><BrainCircuit size={20} /></span><div><strong>学习助教</strong><small>分析卡点、训练与间隔验证</small></div><ChevronRight size={17} /></button><button type="button"><span><MessageSquareText size={20} /></span><div><strong>AI 问答</strong><small>围绕日志或搜索范围即时提问</small></div><ChevronRight size={17} /></button><button type="button"><span><Headphones size={20} /></span><div><strong>知识播客</strong><small>生成只保留在本机的收听材料</small></div><ChevronRight size={17} /></button><button type="button"><span><Mic2 size={20} /></span><div><strong>录音</strong><small>查看和整理学习录音</small></div><ChevronRight size={17} /></button></section><button type="button" className="uv2-primary-button uv2-tools-coach" onClick={onCoach}>打开学习助教</button></div>;

const QuickCreateSheet = ({ subject, onSubject, onClose, onCreate }: { subject: string; onSubject: (subject: string) => void; onClose: () => void; onCreate: () => void }) => <div className="uv2-sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="uv2-sheet" role="dialog" aria-modal="true" aria-labelledby="quick-create-title"><header><div><p className="uv2-eyebrow">新建学习日志</p><h2 id="quick-create-title">从哪个学科开始？</h2></div><button type="button" className="uv2-icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></header><div className="uv2-sheet-subjects">{subjects.map((item) => <button type="button" className={subject === item ? "active" : ""} key={item} onClick={() => onSubject(item)}><span>{item}</span>{subject === item && <Check size={17} />}</button>)}</div><label className="uv2-template-select"><span>模板</span><select defaultValue="blank"><option value="blank">空白日志</option><option value="review">知识点复盘</option><option value="mistake">错题整理</option></select></label><button type="button" className="uv2-primary-button uv2-sheet-submit" onClick={onCreate}>创建并开始记录 <ArrowRight size={17} /></button></section></div>;

const ThemeSwitcher = ({ theme, onChange }: { theme: VisualTheme; onChange: (theme: VisualTheme) => void }) => (
  <div className="uv2-theme-bar">
    <div className="uv2-theme-copy"><strong>视觉方案</strong><span>页面与输入状态会保留</span></div>
    <div className="uv2-theme-switch" role="group" aria-label="视觉主题">
      <button type="button" aria-pressed={theme === "modern"} onClick={() => onChange("modern")}>
        <i className="uv2-theme-swatch is-modern" />清爽现代
      </button>
      <button type="button" aria-pressed={theme === "reading"} onClick={() => onChange("reading")}>
        <i className="uv2-theme-swatch is-reading" />温润阅读
      </button>
    </div>
  </div>
);

export const UiV2PrototypeApp = () => {
  const [view, setView] = useState<View>("today");
  const [returnView, setReturnView] = useState<View>("today");
  const [quickCreate, setQuickCreate] = useState(false);
  const [subject, setSubject] = useState("计算机网络");
  const [reviewSection, setReviewSection] = useState<ReviewSection>("session");
  const [editorInitialEditing, setEditorInitialEditing] = useState(true);
  const [theme, setTheme] = useState<VisualTheme>("reading");

  const immersive = view === "editor" || (view === "review" && reviewSection === "session");
  const activeNav = useMemo(() => view === "editor" || view === "settings" ? returnView : view, [returnView, view]);
  const openEditor = (source: View, editing = true) => { setReturnView(source); setEditorInitialEditing(editing); setView("editor"); setQuickCreate(false); };
  const openCoach = () => { setReviewSection("coach"); setView("review"); };
  const navigate = (target: View) => { setView(target); if (target === "review") setReviewSection("session"); };

  return <div className={`ui-v2-prototype ${immersive ? "is-immersive" : ""}`} data-theme={theme}>
    {!immersive && <aside className="uv2-sidebar"><div className="uv2-brand"><span>学</span><div><strong>学习日志</strong><small>Prototype v2</small></div></div><button type="button" className="uv2-new-button" onClick={() => setQuickCreate(true)}><Plus size={18} />新建记录</button><nav>{navItems.map((item) => { const Icon = item.icon; return <button type="button" key={item.id} className={activeNav === item.id ? "active" : ""} onClick={() => navigate(item.id)}><Icon size={19} /><span>{item.label}</span></button>; })}</nav><div className="uv2-sidebar-bottom"><button type="button"><Cloud size={17} /><span>已同步</span><small>刚刚</small></button><button type="button" onClick={() => { setReturnView(activeNav); setView("settings"); }}><Settings size={18} /><span>设置</span></button></div></aside>}
    <ThemeSwitcher theme={theme} onChange={setTheme} />
    <main className="uv2-main">
      {view === "today" && <TodayScreen onWrite={() => openEditor("today")} onChoose={() => setQuickCreate(true)} onReview={() => { setReturnView("today"); setReviewSection("session"); setView("review"); }} onOpenRecord={() => openEditor("today", false)} onCoach={openCoach} />}
      {view === "library" && <LibraryScreen onOpenRecord={() => openEditor("library", false)} />}
      {view === "editor" && <EditorScreen onBack={() => setView(returnView)} initialEditing={editorInitialEditing} />}
      {view === "review" && <ReviewScreen section={reviewSection} setSection={setReviewSection} onExit={() => setView(returnView)} />}
      {view === "tools" && <ToolsScreen onSettings={() => { setReturnView("tools"); setView("settings"); }} onCoach={openCoach} />}
      {view === "settings" && <SettingsScreen onBack={() => setView(returnView)} />}
    </main>
    {!immersive && <nav className="uv2-bottom-nav" aria-label="主要导航"><button type="button" className={activeNav === "today" ? "active" : ""} onClick={() => navigate("today")}><Home size={20} /><span>今天</span></button><button type="button" className={activeNav === "library" ? "active" : ""} onClick={() => navigate("library")}><NotebookPen size={20} /><span>日志</span></button><button type="button" className="uv2-fab" onClick={() => setQuickCreate(true)} aria-label="新建学习日志"><Plus size={24} /></button><button type="button" className={activeNav === "review" ? "active" : ""} onClick={() => navigate("review")}><RotateCcw size={20} /><span>复习</span></button><button type="button" className={activeNav === "tools" ? "active" : ""} onClick={() => navigate("tools")}><Wrench size={20} /><span>工具</span></button></nav>}
    {quickCreate && <QuickCreateSheet subject={subject} onSubject={setSubject} onClose={() => setQuickCreate(false)} onCreate={() => openEditor(activeNav)} />}
  </div>;
};
