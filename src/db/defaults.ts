import type { AiPromptPreset, AppSettings, AutoBackupSettings, Block, DayEntry } from "../types";
import { createBaseEntity, newId } from "../lib/entity";
import { nowISO, todayISO } from "../lib/date";
import { createDefaultSubjects, DEFAULT_SUBJECT, nextRecordTitle } from "../lib/subjects";
import { createDefaultAiProviders } from "../lib/aiProviders";
import { normalizeTtsConfig } from "../lib/ttsProviders";

export const DEFAULT_EXAM_DATE = "2026-12-27";
const STABLE_BOOTSTRAP_TIME = "1970-01-01T00:00:00.000Z";

const DEFAULT_AI_PROMPTS: Array<Pick<AiPromptPreset, "title" | "prompt" | "mode">> = [
  {
    title: "白纸复述测试",
    mode: "recall",
    prompt: `请扮演严格学习考官，基于今天的日志：

1. 从今天日志中挑出 1 个最核心、最值得掌握的知识点，不要挑边缘细节。
2. 只问我一个问题：
"请脱离任何资料，用自己的话复述这个知识点：
- 它在解决什么问题？
- 它的核心含义或机制是什么？
- 它和容易混淆的概念有什么区别？
- 它最容易误解或遗漏的地方是什么？"
3. 不要先给提示，不要给答案，等我回答。
4. 我回答后，请逐条批改：
- 哪些说对了
- 哪些说错了
- 哪些虽然方向对但不准确/不完整
- 哪些关键点我完全没提到
5. 最后给一个评级：
A = 真正理解
B = 表层理解
C = 只是记住名词或句子

不要先夸我，直接开始出题。`,
  },
  {
    title: "变形应用题",
    mode: "application",
    prompt: `请基于今天日志中的知识点出 1 道"变形应用题"：

要求：
1. 题目必须考察理解和迁移，不要出简单背诵题。
2. 场景、条件或问法要和日志里的原例子不同。
3. 题目可以是计算、解释、判断、比较、案例分析或实际应用，按日志内容选择最合适的形式。
4. 不要给答案，等我作答。
5. 我作答后，请按学习掌握标准批改：
- 结论是否正确
- 推理过程是否完整
- 是否存在概念混淆
- 是否遗漏关键条件
- 如果要改进，应该怎么改，为什么
6. 最后评级：
A = 能独立迁移应用
B = 基本会用但有漏洞
C = 概念或方法明显不稳

现在出题。`,
  },
  {
    title: "盲区挖掘",
    mode: "trap",
    prompt: `请扮演严格学习教练，基于今天日志的知识点：

1. 列出 3 个"看起来懂了，但实际容易有漏洞"的点。
2. 从中选出最容易踩坑的 1 个，出一道陷阱题。
3. 陷阱题表面要简单，但要能暴露概念混淆、条件遗漏或推理漏洞。
4. 不要标注坑在哪里，让我自己判断。
5. 我回答后：
- 如果我没看出坑：指出坑在哪里，并解释我为什么容易漏掉
- 如果我看出一部分：补充我遗漏的部分
- 如果我完全看出：再出一道更难的变体
6. 目标是暴露我的"未知的未知"，不是让我刷简单题。

现在开始。`,
  },
  {
    title: "费曼讲解测试",
    mode: "feynman",
    prompt: `请扮演一个认真但完全没学过该知识点的初学者：

1. 从今天日志中选一个重要知识点。
2. 让我向你讲解，假装你完全不懂。
3. 在我讲解过程中，你要不断追问：
- "为什么？"
- "这一步是什么意思？"
- "如果条件变了会怎样？"
- "我还是不懂这个词是什么意思。"
4. 不要客气，听不懂就明确说听不懂。
5. 等我讲完后，请评价：
- 哪些地方讲得清楚
- 哪些地方讲得含糊，说明我自己可能也没真懂
- 是否有用术语解释术语的偷懒行为
- 如果要让初学者真正听懂，我应该怎么改讲法

目标：检验我是真懂，还是只是熟悉表述。`,
  },
  {
    title: "我的理解对不对",
    mode: "correction",
    prompt: `我会告诉你"我对今天某个知识点的理解"。

请你不要默认我说得对。请等我输入"我的理解是：XXX"后，再逐字分析我的说法：

1. 完全正确的部分是什么
2. 看似正确但不准确的部分是什么
3. 明显错误的部分是什么
4. 我没提到但很关键的部分是什么
5. 我这种理解在做题、表达、应用或复习中可能导致什么问题
6. 请给出一个更准确、更简洁的改写版本

不要替我提前组织表达，要针对我实际说出来的内容判断。`,
  },
];

export const createDefaultAiPresets = (): AiPromptPreset[] =>
  DEFAULT_AI_PROMPTS.map((item, order) => ({
    id: `default-ai-preset:${item.mode}`,
    createdAt: STABLE_BOOTSTRAP_TIME,
    updatedAt: STABLE_BOOTSTRAP_TIME,
    ...item,
    order,
  }));

export const isLegacyDefaultAiPresetSet = (presets: AiPromptPreset[] | undefined): boolean => {
  if (!presets || presets.length !== 4) {
    return false;
  }
  const titles = presets.map((preset) => preset.title);
  return (
    titles.some((title) => title.includes("自测") || title.includes("5")) &&
    titles.some((title) => title.includes("随机") || title.includes("抽问")) &&
    titles.some((title) => title.includes("薄弱") || title.includes("总结")) &&
    titles.some((title) => title.includes("明日") || title.includes("计划"))
  );
};

export const isCurrentDefaultAiPresetSetWithoutModes = (presets: AiPromptPreset[] | undefined): boolean => {
  if (!presets || presets.length !== DEFAULT_AI_PROMPTS.length || presets.some((preset) => preset.mode)) {
    return false;
  }
  return DEFAULT_AI_PROMPTS.every((item) =>
    presets.some((preset) => preset.title === item.title && preset.prompt === item.prompt),
  );
};

export const isCurrentDefaultAiPresetSet = (presets: AiPromptPreset[] | undefined): boolean => {
  if (!presets || presets.length !== DEFAULT_AI_PROMPTS.length) {
    return false;
  }
  return DEFAULT_AI_PROMPTS.every((item) =>
    presets.some((preset) => preset.title === item.title && preset.prompt === item.prompt && preset.mode === item.mode),
  );
};

export const isCodeBiasedDefaultAiPresetSet = (presets: AiPromptPreset[] | undefined): boolean => {
  if (!presets || presets.length !== DEFAULT_AI_PROMPTS.length) {
    return false;
  }
  const titles = presets.map((preset) => preset.title);
  const joinedPrompts = presets.map((preset) => preset.prompt).join("\n");
  const hasDefaultTitles = DEFAULT_AI_PROMPTS.every((item) => titles.includes(item.title));
  return hasDefaultTitles && (
    joinedPrompts.includes("生产代码标准") ||
    joinedPrompts.includes("具体业务场景") ||
    joinedPrompts.includes("能跑但") ||
    joinedPrompts.includes("投入生产")
  );
};

export const DEFAULT_AUTO_BACKUP_STATE: AutoBackupSettings = {
  enabled: false,
  debounceMs: 600_000,
};

export const DEFAULT_SETTINGS: AppSettings = {
  id: "settings",
  examDate: DEFAULT_EXAM_DATE,
  theme: "system",
  accentColor: "#2f6f5e",
  backupReminderDays: 7,
  fontScale: 1,
  editorFontScale: 1,
  lineHeight: 1.7,
  subjects: createDefaultSubjects(),
  ai: {
    currentProviderId: "default",
    providers: createDefaultAiProviders().map((provider) => ({ ...provider, id: "default" })),
    presets: createDefaultAiPresets(),
    imageInputMode: "local-ocr",
  },
  tts: normalizeTtsConfig(undefined),
  schemaVersion: 5,
};

export const DEFAULT_TAGS = [
  "数学",
  "英语",
  "政治",
  "计组",
  "OS",
  "计网",
  "数据结构",
  "高数",
  "线代",
  "重点",
  "疑问",
  "突破",
  "瓶颈",
];

export const createDayEntry = (date = todayISO()): DayEntry => ({
  ...createBaseEntity(),
  date,
  title: `${date} 学习日志`,
  tags: [],
  pinned: false,
  favorite: false,
});

export const createTemplateBlocks = (date: string, existingCount = 0): Block[] => {
  const timestamp = nowISO();
  return [
    {
      id: newId(),
      createdAt: timestamp,
      updatedAt: timestamp,
      type: "record",
      date,
      order: existingCount,
      subject: DEFAULT_SUBJECT,
      tags: [],
      title: nextRecordTitle(DEFAULT_SUBJECT, existingCount),
      contentHtml:
        "<h2>今日学了什么</h2><p></p><h2>卡点疑问</h2><p></p><h2>明日计划</h2><p></p>",
      assets: [],
      formulas: [],
      mistakeRefs: [],
      favorite: false,
    },
  ];
};
