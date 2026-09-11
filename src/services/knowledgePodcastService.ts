import type {
  AiCompletionResult,
  AiContextPack,
  AiKnowledgeScope,
  AppSettings,
  KnowledgePodcast,
  KnowledgePodcastAudioUnit,
  KnowledgePodcastCreativeBrief,
  KnowledgePodcastScriptDiagnostic,
  KnowledgePodcastSegment,
  RecordBlock,
  TtsProviderProfile,
} from "../types";
import { createBaseEntity, newId } from "../lib/entity";
import { buildAiKnowledgeContextPackAsync, getAiKnowledgeScopeRecords } from "./aiContextService";
import { getCurrentAiProvider } from "../lib/aiProviders";
import { calculateAiRequestBudget, sendChatCompletionDetailed } from "./aiClientService";
import { storage } from "./storageAdapter";
import { signTencentRequest } from "../lib/tencentSigning";
import { decodeDoubaoSmallTtsJson, decodeDoubaoTtsNdjson } from "../lib/doubaoTts";
import { synthesizeOnHost } from "./nativeTts";

export const FISH_AUDIO_PROVIDER_ID = "fish-audio";
export const DEFAULT_FISH_MODEL = "s2.1-pro-free";
export const PODCAST_MAX_SOURCE_RECORDS = 20;
export const PODCAST_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;
/** Per-request cap for one TTS part. Without it a stalled provider left the job
 * stuck in "generating" until the user cancelled. */
export const PODCAST_TTS_TIMEOUT_MS = 2 * 60 * 1000;

/** Combines the caller's cancellation with a wall-clock cap. */
const ttsRequestSignal = (signal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(PODCAST_TTS_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};
export const PODCAST_MIN_OUTPUT_TOKENS = 16_384;
export const PODCAST_MAX_OUTPUT_TOKENS = 32_768;
export const PODCAST_SPEECH_CHARACTERS_PER_MINUTE = 240;
export const PODCAST_DURATION_TOLERANCE = 0.15;

export const PODCAST_TEMPLATE_VARIABLES = [
  { token: "{{策划摘要}}", label: "完整策划摘要", description: "插入本期所有已填写的策划内容" },
  { token: "{{节目目标}}", label: "节目目标", description: "本期希望达成的学习效果" },
  { token: "{{目标听众}}", label: "目标听众", description: "节目面向的听众" },
  { token: "{{讲述角色}}", label: "讲述角色", description: "AI 在节目中的角色" },
  { token: "{{讲述风格}}", label: "讲述风格", description: "语气与表达方式" },
  { token: "{{组织结构}}", label: "组织结构", description: "章节组织方式" },
  { token: "{{必须覆盖}}", label: "必须覆盖", description: "必须讲到的内容" },
  { token: "{{避免内容}}", label: "避免内容", description: "需要避免的内容" },
  { token: "{{章节要求}}", label: "章节要求", description: "每章应具备的内容" },
  { token: "{{开场要求}}", label: "开场要求", description: "opening 的写作要求" },
  { token: "{{结尾要求}}", label: "结尾要求", description: "closing 的写作要求" },
  { token: "{{本期补充要求}}", label: "本期补充要求", description: "仅作用于本期的额外方向" },
  { token: "{{目标时长}}", label: "目标时长", description: "本期选择的分钟数" },
  { token: "{{目标字数}}", label: "目标字数", description: "按中文朗读速度估算的字符数" },
  { token: "{{知识范围摘要}}", label: "知识范围摘要", description: "用户选择的日志范围" },
] as const;

const PODCAST_TEMPLATE_TOKEN_NAMES = new Set(PODCAST_TEMPLATE_VARIABLES.map((item) => item.token.slice(2, -2)));
const PODCAST_BRIEF_FIELDS = [
  "objective", "audience", "narratorRole", "tone", "organization", "mustCover", "avoid",
  "chapterRequirements", "openingRequirements", "closingRequirements",
] as const;

const PODCAST_BRIEF_DEFAULTS: Record<Extract<KnowledgePodcast["mode"], "summary" | "explain">, KnowledgePodcastCreativeBrief> = {
  summary: {
    objective: "提炼重点、关键结论和记录之间的联系",
    audience: "未来的自己",
    narratorRole: "清晰的知识整理者",
    tone: "简洁、自然、重点明确",
    organization: "按主题组织，并在结尾浓缩关键结论",
    chapterRequirements: "每章先说明核心结论，再简要说明其与其他记录的联系",
    openingRequirements: "简短说明本期范围与最值得关注的主题",
    closingRequirements: "用少量结论收束，不重复逐条复述章节",
  },
  explain: {
    objective: "像老师一样讲清重点、联系和易错点，并帮助复习",
    audience: "未来的自己",
    narratorRole: "耐心的复习老师",
    tone: "自然口语化、清晰严谨、循序渐进",
    organization: "按概念关系和难度递进组织",
    chapterRequirements: "每章说明概念、联系、易错点，并穿插少量回忆提示",
    openingRequirements: "以本期要解决的学习问题开场，快速建立学习目标",
    closingRequirements: "总结最重要结论，并给出简短的复习提示",
  },
};

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : undefined;

export const hashText = async (value: string): Promise<string> => {
  if (typeof crypto !== "undefined" && crypto.subtle && encoder) {
    const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
    return Array.from(new Uint8Array(bytes)).map((item) => item.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
};

export const createPodcastAudioUnits = async (podcast: Pick<KnowledgePodcast, "opening" | "segments" | "closing">): Promise<KnowledgePodcastAudioUnit[]> => {
  const units: KnowledgePodcastAudioUnit[] = [];
  const opening = podcast.opening?.trim();
  if (opening) {
    units.push({ id: newId(), kind: "opening", order: 0, title: "开场", textHash: await hashText(opening), audioStatus: "pending" });
  }
  const segmentOffset = units.length;
  for (const [index, segment] of [...podcast.segments].sort((a, b) => a.order - b.order).entries()) {
    units.push({
      id: newId(), kind: "segment", order: segmentOffset + index,
      title: segment.title.trim() || `第 ${segment.order + 1} 章`, segmentId: segment.id,
      textHash: await hashText(segment.text), audioStatus: "pending",
    });
  }
  const closing = podcast.closing?.trim();
  if (closing) {
    units.push({ id: newId(), kind: "closing", order: units.length, title: "结尾", textHash: await hashText(closing), audioStatus: "pending" });
  }
  return units;
};

const audioUnitKey = (unit: Pick<KnowledgePodcastAudioUnit, "kind" | "segmentId">): string => `${unit.kind}:${unit.segmentId ?? ""}`;

export const reconcilePodcastAudioUnits = async (podcast: KnowledgePodcast): Promise<KnowledgePodcast> => {
  const desired = await createPodcastAudioUnits(podcast);
  const existing = new Map((podcast.audioUnits ?? []).map((unit) => [audioUnitKey(unit), unit]));
  const pendingCleanup = new Set(podcast.pendingAudioCleanupAssetIds ?? []);
  const audioUnits = desired.map((unit) => {
    const previous = existing.get(audioUnitKey(unit));
    if (!previous) return unit;
    existing.delete(audioUnitKey(unit));
    if (previous.textHash === unit.textHash) {
      return { ...previous, title: unit.title, order: unit.order, segmentId: unit.segmentId };
    }
    if (previous.audioAssetId) pendingCleanup.add(previous.audioAssetId);
    return { ...unit, id: previous.id };
  });
  for (const unit of existing.values()) {
    if (unit.audioAssetId) pendingCleanup.add(unit.audioAssetId);
  }
  return {
    ...podcast,
    audioLayoutVersion: 2,
    audioUnits,
    pendingAudioCleanupAssetIds: pendingCleanup.size ? Array.from(pendingCleanup) : undefined,
    audioStatus: "idle",
  };
};

export const invalidatePodcastAudioUnits = (podcast: KnowledgePodcast): KnowledgePodcast => {
  const pendingCleanup = new Set([
    ...(podcast.pendingAudioCleanupAssetIds ?? []),
    ...(podcast.audioUnits ?? []).flatMap((unit) => unit.audioAssetId ? [unit.audioAssetId] : []),
  ]);
  return {
    ...podcast,
    audioStatus: "idle",
    audioUnits: podcast.audioUnits?.map((unit) => ({ ...unit, audioAssetId: undefined, durationSeconds: undefined, audioStatus: "pending", error: undefined })),
    pendingAudioCleanupAssetIds: pendingCleanup.size ? Array.from(pendingCleanup) : undefined,
  };
};

const stripCodeFence = (value: string): string => value
  .trim()
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/i, "")
  .trim();

const asText = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const isBuiltinPodcastMode = (mode: KnowledgePodcast["mode"]): mode is "summary" | "explain" => mode === "summary" || mode === "explain";

export const getPodcastCreativeBriefDefaults = (mode: KnowledgePodcast["mode"]): KnowledgePodcastCreativeBrief =>
  isBuiltinPodcastMode(mode) ? { ...PODCAST_BRIEF_DEFAULTS[mode] } : {};

/** Normalizes legacy focusInstruction into the new per-episode editorial brief. */
export const normalizePodcastCreativeBrief = (
  brief?: KnowledgePodcastCreativeBrief,
  legacyFocusInstruction?: string,
): KnowledgePodcastCreativeBrief => {
  const normalized: KnowledgePodcastCreativeBrief = {};
  for (const field of [...PODCAST_BRIEF_FIELDS, "supplementaryRequirements"] as const) {
    const value = brief?.[field]?.trim();
    if (value) normalized[field] = value;
  }
  if (!normalized.supplementaryRequirements && legacyFocusInstruction?.trim()) {
    normalized.supplementaryRequirements = legacyFocusInstruction.trim();
  }
  return normalized;
};

/** Supplies built-in recommendations for old episodes without overwriting explicitly cleared fields. */
export const getPodcastCreativeBriefWithDefaults = (
  brief: KnowledgePodcastCreativeBrief | undefined,
  mode: KnowledgePodcast["mode"],
  legacyFocusInstruction?: string,
): KnowledgePodcastCreativeBrief => {
  const result: KnowledgePodcastCreativeBrief = { ...getPodcastCreativeBriefDefaults(mode), ...(brief ?? {}) };
  if (!Object.prototype.hasOwnProperty.call(brief ?? {}, "supplementaryRequirements") && legacyFocusInstruction?.trim()) {
    result.supplementaryRequirements = legacyFocusInstruction.trim();
  }
  return result;
};

/**
 * Replace only fields that still equal the previous built-in recommendation.
 * This lets mode changes update defaults without overwriting an episode's edits.
 */
export const applyPodcastCreativeBriefMode = (
  brief: KnowledgePodcastCreativeBrief | undefined,
  previousMode: KnowledgePodcast["mode"],
  nextMode: KnowledgePodcast["mode"],
  legacyFocusInstruction?: string,
): KnowledgePodcastCreativeBrief => {
  const current = getPodcastCreativeBriefWithDefaults(brief, previousMode, legacyFocusInstruction);
  if (!isBuiltinPodcastMode(nextMode)) return current;
  const previousDefaults = getPodcastCreativeBriefDefaults(previousMode);
  const nextDefaults = getPodcastCreativeBriefDefaults(nextMode);
  const next: KnowledgePodcastCreativeBrief = { ...current };
  for (const field of PODCAST_BRIEF_FIELDS) {
    const explicitlyEdited = Object.prototype.hasOwnProperty.call(brief ?? {}, field) && brief?.[field] !== previousDefaults[field];
    if (!explicitlyEdited) {
      const replacement = nextDefaults[field];
      if (replacement) next[field] = replacement;
      else delete next[field];
    }
  }
  return next;
};

export const formatPodcastCreativeBrief = (
  brief?: KnowledgePodcastCreativeBrief,
  legacyFocusInstruction?: string,
): string => {
  const current = normalizePodcastCreativeBrief(brief, legacyFocusInstruction);
  const rows: Array<[keyof KnowledgePodcastCreativeBrief, string]> = [
    ["objective", "节目目标"],
    ["audience", "目标听众"],
    ["narratorRole", "讲述角色"],
    ["tone", "讲述风格"],
    ["organization", "组织结构"],
    ["mustCover", "必须覆盖"],
    ["avoid", "避免内容"],
    ["chapterRequirements", "章节要求"],
    ["openingRequirements", "开场要求"],
    ["closingRequirements", "结尾要求"],
    ["supplementaryRequirements", "本期补充要求"],
  ];
  const content = rows
    .map(([field, label]) => current[field] ? `${label}：${current[field]}` : "")
    .filter(Boolean)
    .join("\n");
  return content ? `本期节目策划：\n${content}` : "";
};

export const validatePodcastModeTemplate = (template: string): string[] => {
  const unsupported = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const tokenName = match[1].trim();
    if (!PODCAST_TEMPLATE_TOKEN_NAMES.has(tokenName)) unsupported.add(`{{${tokenName}}}`);
  }
  return [...unsupported];
};

const templateUsesBrief = (template: string): boolean => /\{\{\s*策划摘要\s*\}\}/.test(template);

const renderPodcastModeTemplate = (template: string, variables: Record<string, string>): string => {
  const unsupported = validatePodcastModeTemplate(template);
  if (unsupported.length) throw new Error(`播客模板包含不支持的变量：${unsupported.join("、")}。`);
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, tokenName: string) => variables[tokenName.trim()] ?? "");
};

const podcastTemplateVariables = (options: {
  brief?: KnowledgePodcastCreativeBrief;
  focusInstruction?: string;
  targetMinutes: KnowledgePodcast["targetMinutes"];
  scopeTitle: string;
}): Record<string, string> => {
  const brief = normalizePodcastCreativeBrief(options.brief, options.focusInstruction);
  const targetCharacters = podcastTargetSpeechCharacters(options.targetMinutes);
  return {
    "策划摘要": formatPodcastCreativeBrief(brief),
    "节目目标": brief.objective ?? "未设置",
    "目标听众": brief.audience ?? "未设置",
    "讲述角色": brief.narratorRole ?? "未设置",
    "讲述风格": brief.tone ?? "未设置",
    "组织结构": brief.organization ?? "未设置",
    "必须覆盖": brief.mustCover ?? "未设置",
    "避免内容": brief.avoid ?? "未设置",
    "章节要求": brief.chapterRequirements ?? "未设置",
    "开场要求": brief.openingRequirements ?? "未设置",
    "结尾要求": brief.closingRequirements ?? "未设置",
    "本期补充要求": brief.supplementaryRequirements ?? "未设置",
    "目标时长": `约 ${options.targetMinutes} 分钟`,
    "目标字数": `约 ${targetCharacters} 个朗读字符`,
    "知识范围摘要": options.scopeTitle,
  };
};

export const podcastTargetSpeechCharacters = (targetMinutes: KnowledgePodcast["targetMinutes"]): number =>
  targetMinutes * PODCAST_SPEECH_CHARACTERS_PER_MINUTE;

export const estimatePodcastScriptDuration = (
  script: Pick<KnowledgePodcast, "opening" | "segments" | "closing">,
  targetMinutes: KnowledgePodcast["targetMinutes"],
): Pick<KnowledgePodcast, "speechCharacterCount" | "estimatedDurationSeconds" | "durationTargetDeviation"> => {
  const spokenText = [script.opening, ...script.segments.map((segment) => segment.text), script.closing]
    .filter((text): text is string => Boolean(text))
    .join("")
    .replace(/\s+/g, "");
  const speechCharacterCount = Array.from(spokenText).length;
  const estimatedDurationSeconds = Math.round(speechCharacterCount / PODCAST_SPEECH_CHARACTERS_PER_MINUTE * 60);
  const targetSeconds = targetMinutes * 60;
  return {
    speechCharacterCount,
    estimatedDurationSeconds,
    durationTargetDeviation: targetSeconds > 0 ? (estimatedDurationSeconds - targetSeconds) / targetSeconds : 0,
  };
};

export const parsePodcastScript = async (
  raw: string,
  records: RecordBlock[],
): Promise<Pick<KnowledgePodcast, "title" | "opening" | "segments" | "closing">> => {
  const parsed = JSON.parse(stripCodeFence(raw)) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") throw new Error("AI 返回的播客脚本不是对象。");
  const validIds = new Set(records.map((record) => record.id));
  const rawSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
  if (rawSegments.length === 0) throw new Error("AI 没有返回可播放的播客章节。");
  const segments: KnowledgePodcastSegment[] = [];
  for (const [index, item] of rawSegments.entries()) {
    if (!item || typeof item !== "object") continue;
    const sourceRecordIds = Array.isArray((item as Record<string, unknown>).sourceRecordIds)
      ? ((item as Record<string, unknown>).sourceRecordIds as unknown[]).filter((id): id is string => typeof id === "string" && validIds.has(id))
      : [];
    const text = asText((item as Record<string, unknown>).text);
    const title = asText((item as Record<string, unknown>).title) || `第 ${index + 1} 节`;
    if (!text || sourceRecordIds.length === 0) continue;
    segments.push({
      id: newId(), order: index, title, text, sourceRecordIds,
      textHash: await hashText(text), audioStatus: "pending",
    });
  }
  if (segments.length === 0) throw new Error("AI 返回的播客章节缺少正文。");
  return {
    title: asText(parsed.title) || "知识回顾",
    opening: asText(parsed.opening),
    segments,
    closing: asText(parsed.closing),
  };
};

export const buildPodcastPrompt = (options: {
  mode: KnowledgePodcast["mode"];
  customMode?: KnowledgePodcast["customMode"];
  creativeBrief?: KnowledgePodcastCreativeBrief;
  focusInstruction?: string;
  targetMinutes: KnowledgePodcast["targetMinutes"];
  context: AiContextPack;
}): string => {
  const modeText = options.mode === "summary"
    ? "精炼回顾"
    : options.mode === "explain"
      ? "复习讲解"
      : options.customMode?.title.trim() || "自定义模式";
  const builtInInstruction = options.mode === "summary"
    ? "提炼重点、结论和记录之间的联系。"
    : options.mode === "explain"
      ? "像老师一样解释重点、联系、易错点，并穿插少量回忆提示。"
      : "";
  const targetCharacters = podcastTargetSpeechCharacters(options.targetMinutes);
  const minimumCharacters = Math.round(targetCharacters * (1 - PODCAST_DURATION_TOLERANCE));
  const maximumCharacters = Math.round(targetCharacters * (1 + PODCAST_DURATION_TOLERANCE));
  const sourceIndex = [...new Map(options.context.selectedChunks.map((chunk) => [chunk.recordId, chunk.sourceLabel.split(" / ").slice(0, 3).join(" / ")])).entries()]
    .map(([id, label]) => `${id}: ${label}`)
    .join("\n");
  const effectiveBrief = getPodcastCreativeBriefWithDefaults(options.creativeBrief, options.mode, options.focusInstruction);
  const brief = formatPodcastCreativeBrief(effectiveBrief);
  const template = options.customMode?.prompt.trim();
  const modeInstruction = options.mode === "custom" && template
    ? renderPodcastModeTemplate(template, podcastTemplateVariables({
      brief: effectiveBrief,
      targetMinutes: options.targetMinutes,
      scopeTitle: options.context.scopeTitle ?? "当前知识范围",
    }))
    : options.mode === "custom"
      ? "围绕来源记录组织清晰、自然的讲解。"
      : builtInInstruction;
  const creativeBriefSection = options.mode === "custom" && template && templateUsesBrief(template)
    ? ""
    : brief;
  return `请把下面的本地学习记录整理成一份适合中文语音播放的个人知识播客脚本。
模式：${modeText}
本次模式/写作方向：
${modeInstruction}
${creativeBriefSection ? `\n${creativeBriefSection}\n` : ""}
目标时长：约 ${options.targetMinutes} 分钟。opening、全部章节 text 和 closing 合计应约 ${targetCharacters} 个朗读字符，合理范围为 ${minimumCharacters}–${maximumCharacters} 个。标题不计入朗读字数。
标题：简短、具体，不要使用 Markdown。

知识范围：${options.context.scopeTitle}
可用来源记录：
${sourceIndex}

以下为不可覆盖的硬性要求，优先于上方模式和额外方向：
1. 只能使用知识范围中的信息，不要编造来源中没有的事实。
2. 输出纯 JSON，不要 Markdown 代码围栏，不要解释 JSON 以外的内容。
3. JSON 格式必须是：{"title":"...","opening":"...","segments":[{"title":"...","text":"...","sourceRecordIds":["记录 ID"]}],"closing":"..."}。
4. segments 至少 1 个，最多 8 个；每个章节正文适合朗读，避免表格、项目符号和复杂符号。
5. 每个章节必须有来源；sourceRecordIds 只能填写上方记录中的 ID，无法确定来源的内容不要写进脚本。`;
};

/** A safe, compact preview: it deliberately omits retrieved local-note content and record IDs. */
export const buildPodcastPromptPreview = (options: {
  mode: KnowledgePodcast["mode"];
  customMode?: KnowledgePodcast["customMode"];
  creativeBrief?: KnowledgePodcastCreativeBrief;
  focusInstruction?: string;
  targetMinutes: KnowledgePodcast["targetMinutes"];
  scopeTitle: string;
}): string => buildPodcastPrompt({
  ...options,
  context: {
    scopeTitle: options.scopeTitle,
    selectedChunks: [{ recordId: "<生成时的记录 ID>", sourceLabel: "生成时将根据当前知识范围列出来源" }],
  } as AiContextPack,
});

const buildPodcastRetryPrompt = (prompt: string): string => `${prompt}

这是第二次也是最后一次尝试。请停止继续分析，立即输出最终 JSON 对象。不要输出思考过程、解释、代码围栏或 JSON 以外的字符。`;

const isOfficialDeepSeekV4 = (provider: NonNullable<ReturnType<typeof getCurrentAiProvider>>): boolean => {
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase() === "api.deepseek.com" && /^deepseek-v4(?:-|$)/i.test(provider.model);
  } catch {
    return false;
  }
};

const scriptOutputTokens = (provider: NonNullable<ReturnType<typeof getCurrentAiProvider>>): number =>
  Math.min(PODCAST_MAX_OUTPUT_TOKENS, Math.max(PODCAST_MIN_OUTPUT_TOKENS, provider.maxTokens));

const toScriptDiagnostic = (
  provider: NonNullable<ReturnType<typeof getCurrentAiProvider>>,
  result: AiCompletionResult | undefined,
  attempts: number,
): KnowledgePodcastScriptDiagnostic => ({
  providerName: provider.providerName,
  model: provider.model,
  finishReason: result?.finishReason,
  usage: result?.usage,
  requestId: result?.requestId,
  attempts,
});

export class KnowledgePodcastScriptError extends Error {
  constructor(message: string, readonly diagnostic: KnowledgePodcastScriptDiagnostic) {
    super(message);
    this.name = "KnowledgePodcastScriptError";
  }
}

const usageSummary = (result: AiCompletionResult | undefined): string => {
  const usage = result?.usage;
  if (!usage) return "";
  return [
    usage.promptTokens !== undefined ? `输入 ${usage.promptTokens} Token` : "",
    usage.completionTokens !== undefined ? `输出 ${usage.completionTokens} Token` : "",
    usage.reasoningTokens !== undefined ? `其中推理 ${usage.reasoningTokens} Token` : "",
  ].filter(Boolean).join("，");
};

export const formatPodcastScriptFailure = (
  provider: NonNullable<ReturnType<typeof getCurrentAiProvider>>,
  result: AiCompletionResult | undefined,
  attempts: number,
  parseError?: unknown,
): string => {
  const details = [
    `${provider.providerName} / ${provider.model} 未返回可用的最终脚本`,
    result?.finishReason ? `结束原因 ${result.finishReason}` : "",
    usageSummary(result),
    result?.requestId ? `请求 ID ${result.requestId}` : "",
    `已尝试 ${attempts} 次`,
    parseError instanceof Error && result?.content ? `脚本解析失败：${parseError.message}` : "",
  ].filter(Boolean);
  return `${details.join("；")}。`;
};

export const generatePodcastScript = async (options: {
  podcast: KnowledgePodcast;
  blocks: unknown[];
  assets: unknown[];
  settings: AppSettings;
  signal?: AbortSignal;
  onProgress?: (stage: "building-context" | "requesting-ai" | "retrying-ai" | "parsing-script", message: string, attempt: number) => void | Promise<void>;
}): Promise<{
  context: AiContextPack;
  script: Pick<KnowledgePodcast, "title" | "opening" | "segments" | "closing">;
  estimate: Pick<KnowledgePodcast, "speechCharacterCount" | "estimatedDurationSeconds" | "durationTargetDeviation">;
  diagnostic: KnowledgePodcastScriptDiagnostic;
}> => {
  const blocks = options.blocks as import("../types").Block[];
  const assets = options.assets as import("../types").Asset[];
  const provider = getCurrentAiProvider(options.settings.ai);
  const apiKey = provider ? (await storage.getAiSecret?.(provider.id))?.apiKey : undefined;
  if (!provider) throw new Error("请先在“更多 → AI 设置”里配置 AI 供应商。");
  const initialPrompt = `请生成一份${options.podcast.mode === "summary" ? "精炼回顾" : options.podcast.mode === "explain" ? "复习讲解" : options.podcast.customMode?.title || "自定义"}知识播客脚本。`;
  const outputTokens = scriptOutputTokens(provider);
  const podcastProvider = { ...provider, maxTokens: outputTokens };
  const initialBudget = calculateAiRequestBudget({ provider: podcastProvider, history: [], prompt: initialPrompt });
  await options.onProgress?.("building-context", "正在整理知识范围并构建本地上下文…", 1);
  const context = await buildAiKnowledgeContextPackAsync(options.podcast.scope, blocks, assets, "", options.signal, {
    maxTokens: initialBudget.retrievalTokens,
    retrievalMode: "coverage",
    preferDiverse: true,
  });
  if (context.recordIds.length === 0) throw new Error("当前知识范围没有可用于播客的记录。");
  const prompt = buildPodcastPrompt({
    mode: options.podcast.mode,
    customMode: options.podcast.customMode,
    creativeBrief: options.podcast.creativeBrief,
    focusInstruction: options.podcast.focusInstruction,
    targetMinutes: options.podcast.targetMinutes,
    context,
  });
  const budget = calculateAiRequestBudget({ provider: podcastProvider, history: [], prompt, attachment: context });
  const records = getAiKnowledgeScopeRecords(options.podcast.scope, blocks, context.date);
  const deepSeek = isOfficialDeepSeekV4(provider);
  let lastResult: AiCompletionResult | undefined;
  let lastParseError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const retrying = attempt === 2;
    await options.onProgress?.(
      retrying ? "retrying-ai" : "requesting-ai",
      retrying ? "AI 第一次未返回可用脚本，正在进行最后一次重试…" : `正在请求 ${provider.providerName} / ${provider.model} 生成脚本…`,
      attempt,
    );
    try {
      lastResult = await sendChatCompletionDetailed({
        provider,
        apiKey,
        attachment: context,
        history: [],
        prompt: retrying ? buildPodcastRetryPrompt(prompt) : prompt,
        budget,
        request: {
          maxTokens: outputTokens,
          structuredOutput: deepSeek,
          thinkingMode: deepSeek ? "enabled" : undefined,
          reasoningEffort: deepSeek ? "high" : undefined,
          timeoutMs: PODCAST_SCRIPT_TIMEOUT_MS,
          signal: ttsRequestSignal(options.signal),
        },
      });
    } catch (error) {
      if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      const rawMessage = error instanceof Error ? error.message : "未知网络错误。";
      const timeout = /超时|等待超过|timeout/i.test(rawMessage);
      throw new KnowledgePodcastScriptError(
        `${provider.providerName} / ${provider.model} ${timeout ? "网络超时" : "请求未到达供应商或未取得响应"}：${rawMessage}`,
        toScriptDiagnostic(provider, undefined, attempt),
      );
    }
    if (!lastResult.content) {
      lastParseError = undefined;
      continue;
    }
    try {
      await options.onProgress?.("parsing-script", "AI 已返回内容，正在校验章节和来源…", attempt);
      const script = await parsePodcastScript(lastResult.content, records);
      return {
        context,
        script,
        estimate: estimatePodcastScriptDuration(script, options.podcast.targetMinutes),
        diagnostic: toScriptDiagnostic(provider, lastResult, attempt),
      };
    } catch (error) {
      lastParseError = error;
    }
  }
  throw new KnowledgePodcastScriptError(
    formatPodcastScriptFailure(provider, lastResult, 2, lastParseError),
    toScriptDiagnostic(provider, lastResult, 2),
  );
};

export interface TextToSpeechProvider {
  synthesize(text: string, options: { signal?: AbortSignal }): Promise<Blob>;
}

export class FishAudioTtsProvider implements TextToSpeechProvider {
  constructor(private readonly profile: TtsProviderProfile, private readonly apiKey: string) {}

  async synthesize(text: string, options: { signal?: AbortSignal }): Promise<Blob> {
    const hosted = await synthesizeOnHost({ providerId: "fish-audio", apiKey: this.apiKey, model: this.profile.model, voiceId: this.profile.voice, text, format: "mp3" }, ttsRequestSignal(options.signal));
    if (hosted) return hosted;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await fetch("https://api.fish.audio/v1/tts", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey.trim().replace(/^Bearer\s+/i, "")}`,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
            model: this.profile.model,
          },
          body: JSON.stringify({
            text,
            reference_id: this.profile.voice,
            format: "mp3",
            normalize: true,
            mp3_bitrate: 64,
            latency: "normal",
            chunk_length: 300,
          }),
          signal: ttsRequestSignal(options.signal),
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new Error("浏览器无法直接访问 Fish Audio（可能被 CORS 拦截）。请使用桌面版、Android 版，或配置后端代理。");
      }
      if (response.ok) {
        const blob = await response.blob();
        if (blob.size === 0) throw new Error("Fish Audio 返回了空音频。");
        return blob;
      }
      const detail = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) throw new Error(`Fish Audio 请求失败（${response.status}）：${detail.slice(0, 180)}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 350 * (attempt + 1));
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("TTS cancelled", "AbortError")); }, { once: true });
      });
    }
    throw new Error("Fish Audio 请求失败。");
  }
}

export class AliyunTtsProvider implements TextToSpeechProvider {
  constructor(private readonly profile: TtsProviderProfile, private readonly apiKey: string) {}

  async synthesize(text: string, options: { signal?: AbortSignal }): Promise<Blob> {
    const hosted = await synthesizeOnHost({ providerId: "aliyun", apiKey: this.apiKey, model: this.profile.model, voiceId: this.profile.voice, text, format: "mp3" }, ttsRequestSignal(options.signal));
    if (hosted) return hosted;
    let response: Response;
    try {
      response = await fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2audio", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.profile.model, input: { text, voice: this.profile.voice }, parameters: { format: "mp3", sample_rate: 16000 } }),
        signal: ttsRequestSignal(options.signal),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Error("浏览器无法直接访问阿里云 TTS（可能被 CORS 拦截）。请使用桌面版或 Android 版。");
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`阿里云 TTS 请求失败（${response.status}）：${detail.slice(0, 180)}`);
    }
    const json = await response.json() as { output?: { audio?: { url?: string } } };
    const url = json?.output?.audio?.url;
    if (!url) throw new Error("阿里云 TTS 未返回音频地址。");
    const audioResponse = await fetch(url, { signal: ttsRequestSignal(options.signal) });
    if (!audioResponse.ok) throw new Error(`阿里云音频下载失败（${audioResponse.status}）。`);
    const blob = await audioResponse.blob();
    if (blob.size === 0) throw new Error("阿里云 TTS 返回了空音频。");
    return new Blob([blob], { type: "audio/mpeg" });
  }
}

const base64ToBlob = (b64: string): Blob => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "audio/mpeg" });
};

export class TencentTtsProvider implements TextToSpeechProvider {
  constructor(private readonly profile: TtsProviderProfile, private readonly secretId: string, private readonly secretKey: string) {}

  async synthesize(text: string, options: { signal?: AbortSignal }): Promise<Blob> {
    const hosted = await synthesizeOnHost({ providerId: "tencent", apiKey: this.secretId, apiKeySecondary: this.secretKey, model: this.profile.model, voiceId: this.profile.voice, text, format: "mp3", region: this.profile.region }, ttsRequestSignal(options.signal));
    if (hosted) return hosted;
    const host = "tts.tencentcloudapi.com";
    const payload = JSON.stringify({ Text: text, SessionId: crypto.randomUUID(), VoiceType: Number(this.profile.voice) || 101001, Codec: "mp3", SampleRate: 16000 });
    const headers = await signTencentRequest({ secretId: this.secretId, secretKey: this.secretKey, host, action: "TextToVoice", version: "2019-08-23", region: this.profile.region ?? "ap-guangzhou", payload });
    let response: Response;
    try {
      response = await fetch(`https://${host}`, { method: "POST", headers, body: payload, signal: ttsRequestSignal(options.signal) });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Error("浏览器无法直接访问腾讯云 TTS（可能被 CORS 拦截）。请使用桌面版或 Android 版。");
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`腾讯云 TTS 请求失败（${response.status}）：${detail.slice(0, 180)}`);
    }
    const json = await response.json() as { Response?: { Audio?: string; Error?: { Message: string } } };
    if (json?.Response?.Error) throw new Error(`腾讯云 TTS 错误：${json.Response.Error.Message}`);
    const audio = json?.Response?.Audio;
    if (!audio) throw new Error("腾讯云 TTS 未返回音频数据。");
    return base64ToBlob(audio);
  }
}

export class GoogleTtsProvider implements TextToSpeechProvider {
  constructor(private readonly profile: TtsProviderProfile, private readonly apiKey: string) {}

  async synthesize(text: string, options: { signal?: AbortSignal }): Promise<Blob> {
    const hosted = await synthesizeOnHost({ providerId: "google", apiKey: this.apiKey, model: this.profile.model, voiceId: this.profile.voice, text, format: "mp3", languageCode: this.profile.languageCode }, ttsRequestSignal(options.signal));
    if (hosted) return hosted;
    let response: Response;
    try {
      response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(this.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { text }, voice: { languageCode: this.profile.languageCode ?? "cmn-CN", name: this.profile.voice }, audioConfig: { audioEncoding: "MP3", sampleRateHertz: 16000 } }),
        signal: ttsRequestSignal(options.signal),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Error(`Google Cloud TTS 请求失败：${error instanceof Error ? error.message : "网络错误"}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Google Cloud TTS 请求失败（${response.status}）：${detail.slice(0, 180)}`);
    }
    const json = await response.json() as { audioContent?: string };
    if (!json?.audioContent) throw new Error("Google Cloud TTS 未返回音频数据。");
    return base64ToBlob(json.audioContent);
  }
}

export class DoubaoTtsProvider implements TextToSpeechProvider {
  constructor(private readonly profile: TtsProviderProfile, private readonly apiKey: string) {}

  async synthesize(text: string, options: { signal?: AbortSignal }): Promise<Blob> {
    const hosted = await synthesizeOnHost({ providerId: "doubao", apiKey: this.apiKey, model: this.profile.model, voiceId: this.profile.voice, appId: this.profile.appId, text, format: "mp3" }, ttsRequestSignal(options.signal));
    if (hosted) return hosted;
    if (this.profile.model === "volcano_tts") {
      if (!this.profile.appId?.trim()) throw new Error("豆包小模型 TTS 缺少旧版控制台 App ID。");
      const response = await fetch("https://openspeech.bytedance.com/api/v1/tts", {
        method: "POST",
        headers: { Authorization: `Bearer;${this.apiKey.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          app: { appid: this.profile.appId.trim(), token: this.apiKey.trim(), cluster: "volcano_tts" },
          user: { uid: globalThis.crypto?.randomUUID?.() ?? "study-journal" },
          audio: { voice_type: this.profile.voice, encoding: "mp3", rate: 16_000, speed_ratio: 1, volume_ratio: 1, pitch_ratio: 1 },
          request: { reqid: globalThis.crypto?.randomUUID?.() ?? String(Date.now()), text, text_type: "plain", operation: "query" },
        }),
        signal: ttsRequestSignal(options.signal),
      });
      const payload = await response.text();
      if (!response.ok) throw new Error(`豆包小模型 TTS 请求失败（${response.status}）：${payload.replace(/\s+/g, " ").slice(0, 240)}`);
      const audio = decodeDoubaoSmallTtsJson(payload);
      return new Blob([audio.slice().buffer], { type: "audio/mpeg" });
    }
    const resourceId = this.profile.model.trim() || "seed-tts-2.0";
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let response: Response;
    try {
      response = await fetch("https://openspeech.bytedance.com/api/v3/tts/unidirectional", {
        method: "POST",
        headers: {
          "X-Api-Key": this.apiKey.trim(),
          "X-Api-Resource-Id": resourceId,
          "X-Api-Request-Id": requestId,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          req_params: {
            text,
            speaker: this.profile.voice,
            audio_params: { format: "mp3", sample_rate: 16000 },
          },
        }),
        signal: ttsRequestSignal(options.signal),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Error(`豆包 TTS 请求失败：${error instanceof Error ? error.message : "网络错误"}`);
    }
    const payload = await response.text();
    if (!response.ok) throw new Error(`豆包 TTS 请求失败（${response.status}）：${payload.replace(/\s+/g, " ").slice(0, 240)}`);
    const audio = decodeDoubaoTtsNdjson(payload);
    return new Blob([audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer], { type: "audio/mpeg" });
  }
}

export const createTtsProvider = (profile: TtsProviderProfile, apiKey: string, apiKeySecondary?: string): TextToSpeechProvider => {
  switch (profile.providerId) {
    case "aliyun": return new AliyunTtsProvider(profile, apiKey);
    case "tencent": return new TencentTtsProvider(profile, apiKey, apiKeySecondary ?? "");
    case "google": return new GoogleTtsProvider(profile, apiKey);
    case "doubao": return new DoubaoTtsProvider(profile, apiKey);
    default: return new FishAudioTtsProvider(profile, apiKey);
  }
};

export const splitTtsText = (text: string, maxBytes = 800): string[] => {
  const parts: string[] = [];
  let current = "";
  const sentences = text.split(/(?<=[。！？!?；;])\s*|\n+/).map((item) => item.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (new TextEncoder().encode(sentence).length > maxBytes) {
      if (current) { parts.push(current); current = ""; }
      let chunk = "";
      for (const character of sentence) {
        const candidate = `${chunk}${character}`;
        if (new TextEncoder().encode(candidate).length > maxBytes && chunk) {
          parts.push(chunk);
          chunk = character;
        } else {
          chunk = candidate;
        }
      }
      if (chunk) current = chunk;
      continue;
    }
    const candidate = current ? `${current}${sentence}` : sentence;
    if (new TextEncoder().encode(candidate).length <= maxBytes || !current) {
      current = candidate;
      continue;
    }
    parts.push(current);
    current = sentence;
  }
  if (current) parts.push(current);
  return parts;
};

export const createEmptyPodcast = (scope: AiKnowledgeScope, mode: KnowledgePodcast["mode"] = "summary", targetMinutes: KnowledgePodcast["targetMinutes"] = 5): KnowledgePodcast => ({
  ...createBaseEntity(), title: "未命名知识播客", mode, targetMinutes, scope, sourceRecordIds: [], contextHash: "",
  creativeBrief: getPodcastCreativeBriefDefaults(mode),
  scriptStatus: "idle", audioStatus: "idle", segments: [], audioLayoutVersion: 2, audioUnits: [],
  ttsConfig: { providerId: "fish-audio", model: DEFAULT_FISH_MODEL, voiceId: "", format: "mp3" },
});
