import {
  ArrowRight,
  BookOpenCheck,
  BrainCircuit,
  Check,
  ChevronDown,
  Headphones,
  MessageCircleQuestion,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { PageHeader } from "../components/ui";

const guideSections = [
  { id: "understand", label: "理解产品" },
  { id: "quick-start", label: "快速开始" },
  { id: "record", label: "记录与整理" },
  { id: "review", label: "间隔复习" },
  { id: "coach", label: "学习助教" },
  { id: "ai-modes", label: "AI 学习方式" },
  { id: "library", label: "资料管理" },
  { id: "safety", label: "数据与设置" },
  { id: "find", label: "按任务查找" },
] as const;

const quickStartSteps = [
  ["记一条", "在“今天”新建日志，写下概念、例子、易错点和自己的理解。"],
  ["加入复习", "保存后将值得回看的日志加入复习；需要重点训练的内容可以标记为复习重点。"],
  ["先回忆", "到期后打开“复习”，先在脑中尝试复述，再查看正文。"],
  ["再评分", "选择最符合本次表现的评分，系统据此安排下一次复习。"],
] as const;

const taskLinks = [
  ["开始第一次学习", "quick-start", "完成一次记录与复习"],
  ["整理或找到日志", "library", "分类、标签、搜索与收藏"],
  ["安排复习", "review", "选择策略并理解评分"],
  ["反复卡在同类问题", "coach", "用学习助教设计针对性训练"],
  ["围绕资料追问", "ai-modes", "使用 AI 问答"],
  ["边走边复习", "ai-modes", "选择语音复述或知识播客"],
  ["换设备或恢复数据", "safety", "查看备份与本机数据边界"],
] as const;

export const UsageGuidePage = () => (
  <main className="page usage-guide-page">
    <PageHeader
      eyebrow="Product guide"
      title="使用教程"
      subtitle="先建立自己的学习闭环，再按需要使用 AI、语音和资料工具。"
      density="compact"
    />

    <nav className="guide-toc" aria-label="教程目录">
      {guideSections.map((section, index) => (
        <a key={section.id} href={`#${section.id}`}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          {section.label}
        </a>
      ))}
    </nav>

    <article className="guide-document">
      <section id="understand" className="usage-guide-section guide-intro-section">
        <p className="guide-section-index">01 · 先理解这个 App</p>
        <h2>把学过的内容留下，再在需要的时候重新想起来</h2>
        <p className="guide-lead">
          学习日志不是资料仓库，也不以记录数量为目标。它把记录、间隔复习和主动回忆连成一条路径，帮助你发现真正的理解缺口，并在之后再次验证。
        </p>
        <div className="guide-principles" aria-label="产品核心原则">
          <span><BookOpenCheck size={17} />日志保存学习现场</span>
          <span><BrainCircuit size={17} />回忆暴露理解缺口</span>
          <span><Check size={17} />用户保留最终判断</span>
        </div>
        <figure className="guide-figure guide-figure-wide">
          <img
            src="/guide/learning-loop.png"
            alt="学习闭环：记录学习内容、整理重点、间隔复习、写下卡点、辅助强化、延迟验证并再次复习"
            loading="eager"
            decoding="async"
          />
          <figcaption>记录是起点；真正的学习发生在回忆、反馈和再次验证中。</figcaption>
        </figure>
      </section>

      <section id="quick-start" className="usage-guide-section">
        <p className="guide-section-index">02 · 快速开始</p>
        <h2>先完成一次最短闭环</h2>
        <p className="guide-section-summary">第一次使用不必先配置所有工具。完成一条日志和一次复习，就能理解产品的核心。</p>
        <ol className="guide-quick-steps">
          {quickStartSteps.map(([title, body], index) => (
            <li key={title}>
              <span>{index + 1}</span>
              <div><h3>{title}</h3><p>{body}</p></div>
            </li>
          ))}
        </ol>
        <p className="guide-callout"><Sparkles size={17} />AI、OCR、语音和播客都是扩展能力，不是开始记录的前置条件。</p>
      </section>

      <section id="record" className="usage-guide-section">
        <p className="guide-section-index">03 · 记录与整理</p>
        <h2>让一条日志成为可复习的学习单元</h2>
        <div className="guide-definition-grid">
          <div><span>它是什么</span><p>一条日志可以同时保存文字、图片、音频、附件、公式、结构内容和其他日志的引用。</p></div>
          <div><span>为什么有用</span><p>学科负责大范围归类，标签连接具体主题，复习重点标记真正值得检验的内容。</p></div>
          <div><span>怎么使用</span><p>从“今天”快速记录；到“日志”浏览、筛选和搜索；重复结构可先建立模板。</p></div>
        </div>
        <figure className="guide-figure guide-figure-record">
          <img
            src="/guide/record-structure.png"
            alt="一条日志由标题、学科、标签、正文、图片、音频、公式、复习重点和引用组成，并用于搜索、间隔复习和 AI 问答"
            loading="lazy"
            decoding="async"
          />
          <figcaption>写入日志的有效内容，会继续服务于搜索、复习和 AI 上下文。</figcaption>
        </figure>
      </section>

      <section id="review" className="usage-guide-section">
        <p className="guide-section-index">04 · 间隔复习</p>
        <h2>评分决定下一次出现，而不是宣布永久掌握</h2>
        <p className="guide-section-summary">进入“复习”后，先主动回忆，再根据这一次的真实表现评分。按钮下方会显示预计下次复习时间。</p>
        <div className="guide-compare">
          <div><h3>轻回看</h3><p>默认策略，适合长日志、复盘、总结和材料型内容，间隔相对宽松。</p></div>
          <div><h3>记忆卡</h3><p>适合定义、公式、易错点和短问答，使用 FSRS 安排按天复习。</p></div>
        </div>
        <p className="guide-rating-line"><strong>忘记了</strong><ArrowRight size={15} /><strong>模糊</strong><ArrowRight size={15} /><strong>良好</strong><ArrowRight size={15} /><strong>轻松</strong></p>
        <p className="guide-muted">复习时可使用批注辅助思考；若日志含复习重点，还可以写下真实卡点。整卡评分只调整日志的复习时间，不直接判断某个重点已经掌握。</p>
        <figure className="guide-figure guide-figure-wide">
          <img
            src="/guide/review-spacing.png"
            alt="主动回忆后选择忘记了、模糊、良好或轻松，系统据此安排不同的下次复习时间"
            loading="lazy"
            decoding="async"
          />
          <figcaption>每次评分描述的是当下表现，系统再据此调整复习间隔。</figcaption>
        </figure>
      </section>

      <section id="coach" className="usage-guide-section">
        <p className="guide-section-index">05 · 学习助教</p>
        <h2>把“哪里不会”变成一次具体训练</h2>
        <div className="guide-definition-grid">
          <div><span>它是什么</span><p>位于“复习 → 学习助教”的反馈与训练工作区。</p></div>
          <div><span>为什么有用</span><p>普通评分只表达回忆结果；真实卡点能帮助系统理解你究竟卡在哪里。</p></div>
          <div><span>怎么使用</span><p>为复习重点写评论，确认 AI 整理的理解，再发起分析并完成生成的训练任务。</p></div>
        </div>
        <p className="guide-callout"><BrainCircuit size={17} />AI 负责整理反馈和设计训练，用户仍需亲自作答并确认结果。</p>
        <figure className="guide-figure guide-figure-wide">
          <img
            src="/guide/coach-flow.png"
            alt="从复习重点和真实卡点开始，经过 AI 整理、用户确认、生成任务、完成训练和延迟验证"
            loading="lazy"
            decoding="async"
          />
          <figcaption>即时答对不等于长期保持；训练之后仍需要延迟验证。</figcaption>
        </figure>
      </section>

      <section id="ai-modes" className="usage-guide-section">
        <p className="guide-section-index">06 · AI 学习方式</p>
        <h2>同一份资料，选择不同的学习动作</h2>
        <div className="guide-mode-list">
          <div><MessageCircleQuestion size={20} /><span><h3>AI 问答</h3><p>从“更多 → AI 问答”选择日志范围，适合追问、抽测、解释和辨析。</p></span></div>
          <div><BrainCircuit size={20} /><span><h3>语音复述</h3><p>从复习页或只读日志开始，把内容讲出来，让 AI 一次问一个问题。练习不会自动评分或改写原笔记。</p></span></div>
          <div><Headphones size={20} /><span><h3>知识播客</h3><p>从“更多 → 知识播客”选择知识范围，先生成并编辑脚本，再按章节生成和播放音频。</p></span></div>
        </div>
        <div className="guide-prompt-examples" aria-label="AI 问答示例">
          <span>可以这样开始</span>
          <p>“根据这些日志考我，先不要给答案。”</p>
          <p>“找出我最容易误以为已经理解的三个地方。”</p>
        </div>
        <figure className="guide-figure guide-figure-wide">
          <img
            src="/guide/ai-learning-modes.png"
            alt="学习资料可以用于 AI 问答、语音复述和知识播客，分别对应提问、表达和聆听"
            loading="lazy"
            decoding="async"
          />
          <figcaption>提问用于探索，表达用于主动回忆，聆听用于整理和反复回顾。</figcaption>
        </figure>
      </section>

      <section id="library" className="usage-guide-section">
        <p className="guide-section-index">07 · 搜索与资料管理</p>
        <h2>在需要时快速找回，而不是记住每个入口</h2>
        <p className="guide-section-summary">常用浏览留在“日志”；低频整理工具集中在“更多”。</p>
        <div className="guide-reference-list">
          <div><Search size={18} /><span><strong>搜索与 OCR</strong><p>全局搜索可查找日志内容；在“更多 → OCR 设置”配置后，已识别的图片文字也会参与检索和 AI 上下文。</p></span></div>
          <div><BookOpenCheck size={18} /><span><strong>学科、标签与收藏</strong><p>学科建立稳定目录，标签连接细分主题，收藏保留最近常用或最重要的日志。</p></span></div>
          <div><Headphones size={18} /><span><strong>录音库</strong><p>日志录音和知识播客可按来源集中播放；原始内容仍与对应日志保持关联。</p></span></div>
        </div>
        <details className="guide-details">
          <summary><span>模板、批量操作与回收站</span><ChevronDown size={17} /></summary>
          <div>
            <p><strong>模板：</strong>保存重复使用的日志结构，新建记录时可直接套用。</p>
            <p><strong>批量操作：</strong>日志资料库支持选择多条记录加入复习或导出。</p>
            <p><strong>回收站：</strong>删除的日志先保留 30 天，可恢复；永久删除后无法找回。</p>
            <p><strong>学习状态：</strong>在“更多 → 统计”查看待复习、逾期、完成进度和带样本量的回忆表现。</p>
          </div>
        </details>
      </section>

      <section id="safety" className="usage-guide-section">
        <p className="guide-section-index">08 · 数据安全与设置</p>
        <h2>先知道什么会保存，再配置长期使用方式</h2>
        <p className="guide-section-summary">完整备份用于恢复；AI 材料导出用于阅读和问答。两者不能互相替代。</p>
        <div className="guide-details-list">
          <details className="guide-details">
            <summary><span><ShieldCheck size={18} />备份、恢复与导出</span><ChevronDown size={17} /></summary>
            <div>
              <p><strong>完整备份：</strong>在“更多 → 备份与恢复”导出可恢复的 zip，也可以绑定自动备份文件夹。</p>
              <p><strong>日志互通：</strong>用于选择性迁移日志，不等同于完整恢复。</p>
              <p><strong>AI 材料导出：</strong>在 AI 问答的“更多操作”中导出 Markdown、JSON 或 TXT，不用于恢复应用数据。</p>
              <p className="guide-warning">导入完整备份会覆盖当前本地数据。导入前先导出一份当前备份。</p>
            </div>
          </details>
          <details className="guide-details">
            <summary><span><Sparkles size={18} />AI、OCR 与语音数据</span><ChevronDown size={17} /></summary>
            <div>
              <p>AI 供应商凭据和 OCR Token 只保存在本机，不进入备份或云同步；换设备或清除数据后需要重新填写。</p>
              <p>语音复述的临时会话和主动保留的本机历史不进入云同步或完整备份。需要长期保留时，请在摘要页整理为正式日志。</p>
              <p>服务商、模型和语音链路以各设置页面当前显示为准，教程不固定推荐某个供应商。</p>
            </div>
          </details>
          <details className="guide-details">
            <summary><span>外观与阅读偏好</span><ChevronDown size={17} /></summary>
            <div>
              <p>“更多 → 设置”可以调整视觉风格、明暗模式、界面字号、日志正文字号、行距和目标日期。</p>
              <p>界面字号影响导航和控件；正文字号只调整日志编辑、详情和复习中的阅读内容。</p>
            </div>
          </details>
        </div>
      </section>

      <section id="find" className="usage-guide-section guide-find-section">
        <p className="guide-section-index">09 · 按任务查找</p>
        <h2>你现在想做什么？</h2>
        <div className="guide-task-index">
          {taskLinks.map(([title, target, detail]) => (
            <a key={title} href={`#${target}`}>
              <span><strong>{title}</strong><small>{detail}</small></span>
              <ArrowRight size={17} />
            </a>
          ))}
        </div>
        <details className="guide-details guide-troubleshooting">
          <summary><span>常见问题</span><ChevronDown size={17} /></summary>
          <div>
            <p><strong>AI 无法开始：</strong>在 AI 问答的“更多操作 → AI 设置”中检查当前供应商、API Key 和模型。</p>
            <p><strong>图片内容无法检索：</strong>在“更多 → OCR 设置”检查 Token，并在图片资源中重新识别。</p>
            <p><strong>换设备后凭据消失：</strong>这是正常的本机安全边界，需要在新设备重新配置。</p>
            <p><strong>录音找不到：</strong>打开侧栏“录音”或“更多 → 录音库”，也可回到对应日志查看。</p>
          </div>
        </details>
      </section>
    </article>
  </main>
);
