import { PageHeader, SurfaceCard } from "../components/ui";

const usageSteps = [
  {
    title: "1. 新建学习记录",
    body: "在首页的新建学习记录区域选择学科、填写标题，先把当天真正学过、想复盘的内容记下来。默认学科只保留常用项，更多学科可以到“分类 -> 学科管理”里自己创建。",
  },
  {
    title: "2. 编辑内容",
    body: "编辑器支持正文、图片、附件、录音、公式，以及高亮块、折叠块、结构图、对照表、便签板。建议把“概念、例子、易错点、自己的解释”写在一起，后面复习和 AI 问答都会更好用。",
  },
  {
    title: "3. 加入复习",
    body: "重要记录可以点“加入复习”，默认会作为“轻回看”进入队列，适合长日志、复盘、总结和材料型笔记。复习页每天默认建议处理前 20 条，到期总数仍会完整显示，完成建议量后可以手动继续处理剩余内容。",
  },
  {
    title: "4. 查看和检索日志",
    body: "今天页适合看当天，日志页适合按日期回看，分类页适合按学科整理。图片完成 OCR 后，图片里的文字也会进入本地全文检索。",
  },
  {
    title: "5. 录音库泛听",
    body: "带录音的记录会集中到录音库。你可以按学科播放，适合通勤、散步、睡前泛听，把口头解释和课堂录音重新拉回记忆。",
  },
];

const aiExamples = [
  "请根据今天的日志，用白纸复述的方式考我。",
  "请不要给答案，先出一道变形应用题，等我回答后再批改。",
  "请用苏格拉底式追问我这个知识点，直到发现我没讲清楚的地方。",
  "请从这篇日志里找 3 个容易误以为懂了的盲区。",
  "我对这个概念的理解是：……请指出哪里不准确。",
];

const reviewStrategyItems = [
  {
    title: "轻回看",
    body: "默认策略，适合非原子化日志。它的间隔更宽松：忘记了会回到明天，模糊会尽早但不过度频繁地回来，良好和轻松会逐步拉长间隔；系统不会再因为连续几次良好就自动标记已掌握。",
  },
  {
    title: "记忆卡",
    body: "适合定义、公式、易错点、问答型知识。你可以在记录详情的复习进度里切换为“记忆卡”，它使用接近 Anki 的 FSRS 四按钮调度，但仍保持按天复习，不会几分钟后再次弹出。",
  },
  {
    title: "四个评分",
    body: "复习页统一使用“忘记了、模糊、良好、轻松”四个按钮，并显示预计下次出现时间。同一天重复评分会被视为纠正今天的评分，只保留最后一次结果，不会重复增加复习次数。",
  },
];

const voiceRecallSteps = [
  {
    title: "从复习或日志开始",
    body: "在复习页进入语音复述，或从只读日志、当前复习卡直接开始。语音练习不会自动评分，也不会改写复习间隔。",
  },
  {
    title: "确认外发范围",
    body: "开始前核对资料范围：ASR 接收麦克风音频，LLM 接收所选日志片段和确认后的转写，TTS 接收教师回复文本。日志内容只作为不可信学习资料处理。",
  },
  {
    title: "确认转写再提交",
    body: "自动、长按和点击录音三种模式互斥。转写可以修改；在学习助教中必须明确确认，才会作为这一题唯一的正式答案提交。",
  },
];

const faqItems = [
  {
    question: "AI 报“未配置供应商、API Key 或模型”怎么办？",
    answer: "进入“更多 -> AI 工具 -> AI 设置”，选择当前供应商，补齐 API Key 和模型名称后保存。",
  },
  {
    question: "图片问答失败怎么办？",
    answer: "如果当前模型不支持直接看图，把图片问答方式切换为“本地 OCR 后转文字”，并先在 OCR 设置中配置 PaddleOCR Token。",
  },
  {
    question: "OCR 提示未配置或识别失败怎么办？",
    answer: "检查 PaddleOCR Token 是否填写正确，并尽量在 Android App 内识别。失败或超时的图片可以在资源卡片里重新 OCR。",
  },
  {
    question: "换手机、重装或清理数据后 Key 不见了？",
    answer: "API Key 和 OCR Token 出于安全原因只保存在本机，不进入备份，也不会打包进 APK。换设备或重装后需要重新填写。",
  },
  {
    question: "备份导入失败怎么办？",
    answer: "确认选择的是“完整备份 zip”，不是 AI 材料导出的 Markdown、JSON 或 TXT。导入会覆盖当前本地数据，导入前请先导出一份备份。",
  },
  {
    question: "想把资料发给外部 AI，应该导出什么？",
    answer: "使用“更多 -> AI 工具 -> AI 材料导出”，选择按学科 Markdown、知识库 JSON 或纯文本 TXT。完整备份 zip 主要用于恢复，不适合直接喂给 AI。",
  },
  {
    question: "录音找不到怎么办？",
    answer: "进入“更多 -> 录音库”按学科查看，也可以回到对应日志，在资源卡片里播放或重命名录音。",
  },
  {
    question: "轻回看和记忆卡怎么选？",
    answer: "长日志、复盘、资料整理默认用轻回看；真正需要背下来的小知识点再手动切成记忆卡。切换类型会把下次复习重置到明天，但不会删除历史复习日志。",
  },
];

export const UsageGuidePage = () => (
  <main className="page usage-guide-page">
    <PageHeader
      eyebrow="Guide"
      title="使用教程"
      subtitle="从记录、复习、AI 问答到备份恢复，一次看懂学习日志的基本用法。"
      density="compact"
    />

    <section className="usage-guide-section">
      <h2>推荐使用流</h2>
      <div className="guide-step-list">
        {usageSteps.map((step) => (
          <SurfaceCard key={step.title} className="guide-step-card" variant="raised">
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </SurfaceCard>
        ))}
      </div>
    </section>

    <section className="usage-guide-section">
      <h2>复习策略</h2>
      <div className="guide-step-list">
        {reviewStrategyItems.map((item) => (
          <SurfaceCard key={item.title} className="guide-step-card" variant="raised">
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </SurfaceCard>
        ))}
      </div>
    </section>

    <section className="usage-guide-section">
      <h2>AI 学习用法</h2>
      <SurfaceCard className="guide-prose-card" variant="raised">
        <p>
          入口是“更多 -&gt; AI 工具 -&gt; AI 问答与聊天记录”。AI 可以基于你的日志做主动回忆、出题、追问、批改和迁移训练。
          你可以直接使用内置预设：白纸复述测试、变形应用题、盲区挖掘、费曼讲解测试、我的理解对不对。
        </p>
        <ul className="guide-example-list">
          {aiExamples.map((example) => (
            <li key={example}>
              <code>{example}</code>
            </li>
          ))}
        </ul>
      </SurfaceCard>
    </section>

    <section className="usage-guide-section">
      <h2>语音主动回忆</h2>
      <div className="guide-step-list">
        {voiceRecallSteps.map((step) => (
          <SurfaceCard key={step.title} className="guide-step-card" variant="raised">
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </SurfaceCard>
        ))}
      </div>
      <p className="guide-note">临时会话和主动保存的通话摘要只保存在本机，不进入云同步或完整备份。重装、清除数据或换机前，请把需要长期保留的内容整理为正式日志。</p>
    </section>

    <section className="usage-guide-section">
      <h2>AI 配置</h2>
      <SurfaceCard className="guide-prose-card" variant="raised">
        <p>
          首选可以使用
          <a href="https://www.aliyun.com/product/bailian" target="_blank" rel="noreferrer">
            阿里云百炼
          </a>
          的新用户免费额度。进入控制台后，在左侧列表找到“API Key”，创建自己的 API Key。
        </p>
        <ol>
          <li>回到软件，进入“更多 -&gt; AI 工具 -&gt; AI 设置”。</li>
          <li>点击“阿里云百炼”模板，把刚创建的 API Key 填进去。</li>
          <li>
            模型填写：<code>qwen3.7-plus-2026-05-26</code>。
          </li>
          <li>保存 AI 设置后，再进入 AI 问答页面测试。</li>
        </ol>
        <p className="guide-note">API Key 只保存在本机，不进入备份。模型名、免费额度和控制台路径若有变化，以阿里云控制台实际显示为准。</p>
      </SurfaceCard>
    </section>

    <section className="usage-guide-section">
      <h2>OCR 配置</h2>
      <SurfaceCard className="guide-prose-card" variant="raised">
        <p>
          入口是“更多 -&gt; OCR 设置”。访问
          <a href="https://aistudio.baidu.com/paddleocr" target="_blank" rel="noreferrer">
            PaddleOCR 官网
          </a>
          ，点击正中央的 API 入口，在下面的异步解析代码中找到 <code>TOKEN=""</code>，引号里的字符串就是要填写的 PaddleOCR Token。
        </p>
        <p>
          配置后，图片资源可以进行文字识别；识别出的文字会进入本地全文检索。AI 图片问答选择“本地 OCR 后转文字”时，也会复用这里的配置。
        </p>
        <p className="guide-note">目前额度通常是每日约 20000 张、每日刷新，个人学习基本用不完；如果官网规则调整，以官网实际说明为准。Token 只保存在本机，不进入完整备份，也不会打包进 APK。</p>
      </SurfaceCard>
    </section>

    <section className="usage-guide-section">
      <h2>备份与导出</h2>
      <div className="guide-step-list">
        <SurfaceCard className="guide-step-card" variant="raised">
          <h3>完整备份 zip</h3>
          <p>入口是“更多 -&gt; 备份与恢复”。完整备份包含日志、图片、音频、附件、OCR 和设置，可用于 Web 和 Android 之间恢复。</p>
        </SurfaceCard>
        <SurfaceCard className="guide-step-card" variant="raised">
          <h3>自动备份</h3>
          <p>绑定备份文件夹后，会写入 <code>study-journal-latest.zip</code>。建议选择网盘同步目录或手机公共文档目录。</p>
        </SurfaceCard>
        <SurfaceCard className="guide-step-card" variant="raised">
          <h3>AI 材料导出</h3>
          <p>入口是“更多 -&gt; AI 工具 -&gt; AI 材料导出”。支持按学科 Markdown、知识库 JSON、纯文本 TXT，这些用于阅读和问答，不用于恢复。</p>
        </SurfaceCard>
      </div>
      <p className="guide-note">导入完整备份会覆盖当前本地数据。导入前先导出一份完整备份，能给自己留一条退路。</p>
    </section>

    <section className="usage-guide-section">
      <h2>常见问题</h2>
      <div className="guide-faq-list">
        {faqItems.map((item) => (
          <SurfaceCard key={item.question} className="guide-faq-card" variant="plain">
            <h3>{item.question}</h3>
            <p>{item.answer}</p>
          </SurfaceCard>
        ))}
      </div>
    </section>

    <section className="usage-guide-section guide-contact-section">
      <SurfaceCard className="guide-contact-card" variant="raised">
        <strong>其他疑问联系作者</strong>
        <p>微信：A6472589</p>
      </SurfaceCard>
    </section>
  </main>
);
