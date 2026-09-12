import type {
  AiContextChunk,
  AiContextPack,
  AiKnowledgeScope,
  AiSkippedAsset,
  Asset,
  Block,
  ISODate,
  ISODateTime,
  RecordReviewLog,
  RecordReviewState,
  RecordBlock,
} from "../types";
import { extractDecisionBlocks } from "../features/reviewCoach/decisionBlockContent";
import { addDaysISO, todayISO } from "../lib/date";
import { parseLinearRecordContent } from "../lib/recordContent";
import { normalizeRecordTags, recordTagKey, subjectTagKey } from "../lib/recordTags";
import { describeOcrForAi } from "./ocrDiagnostics";

const MAX_SELECTED_CHARS = 12_000;
const LONG_CONTEXT_CHARS = 16_000;
const MAX_CHUNK_CHARS = 2_400;
const MAX_INDEXED_CONTEXT_CHARS = 1_000_000;
const MAX_STORED_MARKDOWN_CHARS = 64_000;
const CONTEXT_CACHE_LIMIT = 4;

export const FOCUSED_AI_RETRIEVAL_TOKENS = 16_000;
export const COVERAGE_AI_RETRIEVAL_TOKENS = 24_000;
export const MAX_AI_RETRIEVAL_TOKENS = COVERAGE_AI_RETRIEVAL_TOKENS;

export type AiRetrievalMode = "focused" | "coverage";

export interface AiContextSelectionOptions {
  maxTokens?: number;
  preferDiverse?: boolean;
  retrievalMode?: AiRetrievalMode;
}

/** Optional semantic context attached when AI is opened from a review card. */
export interface AiRecordReviewContext {
  reviewState?: Pick<RecordReviewState, "status" | "reviewKind" | "scheduler" | "nextReviewDate" | "lastReviewDate" | "lastReviewedAt" | "consecutiveRemembered" | "totalReviews" | "intervalDays">;
  reviewLogs?: readonly Pick<RecordReviewLog, "rating" | "reviewedAt" | "evaluationText" | "eventType">[];
  feedback?: readonly {
    comment: string;
    occurredAt?: ISODateTime;
    actionability?: string;
    difficultyType?: string;
    preferredPractice?: string;
  }[];
  knowledgePoints?: readonly {
    name: string;
    role?: string;
    status?: string;
  }[];
}

export interface AiKnowledgeContextOptions extends AiContextSelectionOptions {
  referenceDate?: ISODate;
  recordContexts?: Readonly<Record<string, AiRecordReviewContext>>;
}

type ContextBuildState = {
  allChunks: AiContextChunk[];
  warnings: Set<string>;
  skippedAssets: AiSkippedAsset[];
  missingOcrAssetIds: string[];
  markdownLines: string[];
  includedImages: number;
  skippedImages: number;
};

const contextCache = new Map<string, AiContextPack>();

const normalizeText = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

const assetTitle = (asset: Asset | undefined, fallback: string): string =>
  [asset?.title, asset?.fileName, fallback].find((item) => item && item.trim()) ?? "资源";

const skipped = (asset: Asset | undefined, id: string, kind: AiSkippedAsset["kind"], reason: string): AiSkippedAsset => ({
  id,
  kind,
  title: assetTitle(asset, id),
  reason,
});

const splitText = (content: string, maxLength = MAX_CHUNK_CHARS): string[] => {
  const text = normalizeText(content);
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const parts: string[] = [];
  const paragraphs = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  let current = "";
  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
    } else if (`${current}\n\n${paragraph}`.length > maxLength) {
      parts.push(current);
      current = paragraph;
    } else {
      current = `${current}\n\n${paragraph}`;
    }
  }
  if (current) parts.push(current);

  return parts.flatMap((part) => {
    if (part.length <= maxLength) return [part];
    const slices: string[] = [];
    for (let index = 0; index < part.length; index += maxLength) {
      slices.push(part.slice(index, index + maxLength));
    }
    return slices;
  });
};

const tokenize = (query: string): string[] =>
  Array.from(new Set(
    query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_]+/gu, " ")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2),
  ));

const chineseBigrams = (value: string): string[] => {
  const characters = Array.from(value.toLocaleLowerCase("zh-CN"));
  const bigrams = new Set<string>();
  for (let index = 0; index < characters.length - 1; index += 1) {
    if (/\p{Script=Han}/u.test(characters[index]) && /\p{Script=Han}/u.test(characters[index + 1])) {
      bigrams.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return [...bigrams];
};

/** A deliberately conservative local estimate used to stay below provider context windows. */
export const estimateAiTokens = (value: string): number => {
  const chars = Array.from(value);
  let cjk = 0;
  for (const char of chars) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
  }
  return Math.ceil((cjk * 1.5 + (chars.length - cjk) / 3 + 8) * 1.1);
};

export const formatAiContextSource = (chunk: AiContextChunk, index: number): string => [
  `[[S${index + 1}]] ${chunk.sourceLabel}`,
  chunk.markdown ?? chunk.content,
].join("\n");

export const estimateAiContextSourceTokens = (chunk: AiContextChunk, index: number): number =>
  estimateAiTokens(formatAiContextSource(chunk, index));

const scoreChunk = (chunk: AiContextChunk, query: string): number => {
  const queryText = normalizeText(query).toLocaleLowerCase("zh-CN");
  if (!queryText) return 0;
  const title = chunk.title.toLocaleLowerCase("zh-CN");
  const subject = chunk.subject.toLocaleLowerCase("zh-CN");
  const tags = (chunk.tags ?? []).join(" ").toLocaleLowerCase("zh-CN");
  const source = chunk.sourceLabel.toLocaleLowerCase("zh-CN");
  const content = chunk.content.toLocaleLowerCase("zh-CN");
  const markdown = (chunk.markdown ?? "").toLocaleLowerCase("zh-CN");
  const haystack = `${subject} ${title} ${tags} ${source} ${content} ${markdown}`;
  let score = haystack.includes(queryText) ? 24 : 0;

  for (const token of tokenize(query)) {
    if (title.includes(token)) score += 9;
    if (tags.includes(token)) score += 8;
    if (subject.includes(token)) score += 6;
    if (source.includes(token)) score += 4;
    if (content.includes(token) || markdown.includes(token)) score += 3;
  }
  for (const bigram of chineseBigrams(query)) {
    if (title.includes(bigram) || tags.includes(bigram)) score += 2.5;
    if (content.includes(bigram) || markdown.includes(bigram)) score += 0.75;
  }
  if (chunk.kind === "formula" && (content.includes(queryText) || markdown.includes(queryText))) score += 8;
  if (chunk.kind === "imageOcr") score += 0.5;
  return score;
};

export const getAiRetrievalMode = (query: string): AiRetrievalMode =>
  /抽测|抽问|出题|测试|考我|复盘|总结|梳理|覆盖|quiz/i.test(query) ? "coverage" : "focused";

const scopeDate = (scope: AiKnowledgeScope, referenceDate: ISODate): ISODate =>
  scope.kind === "date" ? scope.date : referenceDate;

export const aiKnowledgeScopeTitle = (scope: AiKnowledgeScope, referenceDate = todayISO()): string => {
  switch (scope.kind) {
    case "date":
      return `${scope.date} 日志`;
    case "tag":
      return `${scope.subject} / #${scope.tag}`;
    case "recent": {
      const start = addDaysISO(referenceDate, 1 - scope.days);
      return `最近 ${scope.days} 天（${start} 至 ${referenceDate}）`;
    }
    case "records":
      return `已选 ${new Set(scope.recordIds).size} 条日志`;
  }
};

export const aiKnowledgeScopeKey = (scope: AiKnowledgeScope): string => {
  switch (scope.kind) {
    case "date":
      return `date:${scope.date}`;
    case "tag":
      return `tag:${subjectTagKey(scope.subject, scope.tag)}`;
    case "recent":
      return `recent:${scope.days}`;
    case "records":
      return `records:${[...new Set(scope.recordIds)].sort().join(",")}`;
  }
};

export const sessionKnowledgeScope = (session: { scope?: AiKnowledgeScope; sourceDate?: ISODate; attachment?: AiContextPack }): AiKnowledgeScope | undefined =>
  session.scope ?? session.attachment?.scope ?? (session.sourceDate ? { kind: "date", date: session.sourceDate } : undefined) ??
  (session.attachment?.date ? { kind: "date", date: session.attachment.date } : undefined);

export const getAiKnowledgeScopeRecords = (
  scope: AiKnowledgeScope,
  blocks: Block[],
  referenceDate = todayISO(),
): RecordBlock[] => {
  const records = blocks.filter((block): block is RecordBlock => block.type === "record" && !block.deletedAt);
  const selectedRecordIds = scope.kind === "records" ? new Set(scope.recordIds) : undefined;
  const matched = records.filter((record) => {
    if (scope.kind === "date") return record.date === scope.date;
    if (scope.kind === "tag") {
      const sameSubject = record.subject.trim().toLocaleLowerCase("zh-CN") === scope.subject.trim().toLocaleLowerCase("zh-CN");
      return sameSubject && normalizeRecordTags(record.tags).some((tag) => recordTagKey(tag) === recordTagKey(scope.tag));
    }
    if (scope.kind === "records") return selectedRecordIds?.has(record.id) ?? false;
    const start = addDaysISO(referenceDate, 1 - scope.days);
    return record.date >= start && record.date <= referenceDate;
  });
  return matched.sort((left, right) =>
    left.date.localeCompare(right.date) || left.order - right.order || left.createdAt.localeCompare(right.createdAt));
};

const reviewStatusLabel = (status: string): string => {
  switch (status) {
    case "active": return "复习中";
    case "mastered": return "已掌握";
    case "removed": return "已移出复习";
    default: return status;
  }
};

const reviewRatingLabel = (rating: string): string => {
  switch (rating) {
    case "forgot": return "忘记了";
    case "fuzzy": return "模糊";
    case "good": return "良好";
    case "easy": return "轻松";
    case "remembered": return "记得";
    default: return rating;
  }
};

const recordContextLines = (record: RecordBlock, context: AiRecordReviewContext | undefined): string[] => {
  if (!context) return [];
  const lines = [
    `创建时间：${record.createdAt}`,
    `更新时间：${record.updatedAt}`,
  ];
  const review = context.reviewState;
  if (review) {
    lines.push(`复习状态：${reviewStatusLabel(review.status)}`);
    if (review.reviewKind) lines.push(`复习类型：${review.reviewKind === "memory" ? "记忆复习" : "概览复习"}`);
    if (review.scheduler) lines.push(`复习调度：${review.scheduler}`);
    if (review.nextReviewDate) lines.push(`下次复习：${review.nextReviewDate}`);
    if (review.lastReviewDate || review.lastReviewedAt) lines.push(`最近复习：${review.lastReviewDate ?? review.lastReviewedAt}`);
    lines.push(`累计复习：${review.totalReviews} 次`);
    lines.push(`连续记住：${review.consecutiveRemembered} 次`);
    lines.push(`当前间隔：${review.intervalDays} 天`);
  }
  const logs = (context.reviewLogs ?? [])
    .filter((log) => log.eventType !== "rating-undone" && Boolean(log.reviewedAt))
    .slice()
    .sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt))
    .slice(0, 5);
  if (logs.length > 0) {
    lines.push("近期复习：");
    logs.forEach((log) => {
      const evaluation = log.evaluationText?.trim();
      lines.push(`- ${log.reviewedAt}：${reviewRatingLabel(log.rating)}${evaluation ? `；评价：${evaluation}` : ""}`);
    });
  }
  const feedback = (context.feedback ?? []).filter((item) => item.comment.trim());
  if (feedback.length > 0) {
    lines.push("复习重点反馈：");
    feedback.slice(0, 5).forEach((item) => {
      const qualifiers = [item.actionability, item.difficultyType, item.preferredPractice].filter(Boolean).join(" / ");
      lines.push(`- ${item.comment.trim()}${qualifiers ? `（${qualifiers}）` : ""}`);
    });
  }
  const knowledgePoints = (context.knowledgePoints ?? [])
    .filter((item) => item.name.trim())
    .slice(0, 12);
  if (knowledgePoints.length > 0) {
    lines.push(`关联知识点：${knowledgePoints.map((item) => [item.name.trim(), item.role, item.status].filter(Boolean).join(" / ")).join("、")}`);
  }
  return lines;
};

const buildSummary = (
  scopeTitle: string,
  records: RecordBlock[],
  chunks: AiContextChunk[],
  recordContexts?: Readonly<Record<string, AiRecordReviewContext>>,
): string => {
  if (records.length === 0) return `${scopeTitle} 没有可用于 AI 问答的正式日志。`;
  const subjects = Array.from(new Set(records.map((record) => record.subject))).join("、");
  const titles = records.map((record) => `《${record.title}》`).slice(0, 6).join("、");
  const more = records.length > 6 ? `等 ${records.length} 条记录` : `${records.length} 条记录`;
  const reviewLines = records.flatMap((record) => recordContextLines(record, recordContexts?.[record.id]));
  return [
    `${scopeTitle} 共 ${more}，涉及 ${subjects || "未分类"}。主要记录：${titles}。可用上下文片段 ${chunks.length} 个。`,
    reviewLines.length > 0 ? `当前记录语义信息：\n${reviewLines.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
};

export const hashAiContext = (value: string): string => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36);
};

export const selectRelevantChunks = (
  chunks: AiContextChunk[],
  query: string,
  maxCharsOrOptions: number | AiContextSelectionOptions = MAX_SELECTED_CHARS,
): AiContextChunk[] => {
  if (chunks.length === 0) return [];
  const options: AiContextSelectionOptions & { maxChars?: number } = typeof maxCharsOrOptions === "number"
    ? { maxChars: maxCharsOrOptions }
    : maxCharsOrOptions;
  const maxChars = options.maxChars ?? (options.maxTokens ? Number.MAX_SAFE_INTEGER : MAX_SELECTED_CHARS);
  const maxTokens = options.maxTokens;
  const ranked = chunks
    .map((chunk, index) => ({ chunk, index, score: scoreChunk(chunk, query) }))
    .sort((left, right) => right.score - left.score || left.chunk.order - right.chunk.order || left.index - right.index);
  const hasPositiveScore = ranked.some((item) => item.score > 0);
  const candidates = hasPositiveScore ? ranked.filter((item) => item.score > 0) : ranked;
  const diverse = options.preferDiverse ?? (options.retrievalMode ?? getAiRetrievalMode(query)) === "coverage";
  const selected: AiContextChunk[] = [];
  const perRecord = new Map<string, number>();
  let totalChars = 0;
  let totalTokens = 0;

  const trySelect = (item: typeof candidates[number]): boolean => {
    const chars = item.chunk.content.length;
    const tokens = estimateAiContextSourceTokens(item.chunk, selected.length);
    if (selected.length > 0 && (totalChars + chars > maxChars || (maxTokens && totalTokens + tokens > maxTokens))) {
      return false;
    }
    selected.push(item.chunk);
    perRecord.set(item.chunk.recordId, (perRecord.get(item.chunk.recordId) ?? 0) + 1);
    totalChars += chars;
    totalTokens += tokens;
    return true;
  };

  const remaining = [...candidates];
  if (diverse) {
    const firstByRecord = new Map<string, typeof candidates[number]>();
    for (const item of remaining) {
      if (!firstByRecord.has(item.chunk.recordId)) firstByRecord.set(item.chunk.recordId, item);
    }
    for (const item of firstByRecord.values()) {
      trySelect(item);
      if (totalChars >= maxChars || (maxTokens && totalTokens >= maxTokens)) break;
    }
    const selectedIds = new Set(selected.map((chunk) => chunk.chunkId));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (selectedIds.has(remaining[index].chunk.chunkId)) remaining.splice(index, 1);
    }
  }

  while (remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftScore = left.score - (diverse ? (perRecord.get(left.chunk.recordId) ?? 0) * 4 : 0);
      const rightScore = right.score - (diverse ? (perRecord.get(right.chunk.recordId) ?? 0) * 4 : 0);
      return rightScore - leftScore || left.chunk.order - right.chunk.order || left.index - right.index;
    });
    const next = remaining.shift()!;
    trySelect(next);
    if (totalChars >= maxChars || (maxTokens && totalTokens >= maxTokens)) break;
  }
  return selected.sort((left, right) => left.order - right.order);
};

const createState = (scopeTitle: string): ContextBuildState => ({
  allChunks: [],
  warnings: new Set(),
  skippedAssets: [],
  missingOcrAssetIds: [],
  markdownLines: [
    `# ${scopeTitle}`,
    "",
    "> 下面内容来自本地学习日志。图片仅包含已完成 OCR 的文字；音频、PDF、附件不会参与问答。",
    "",
  ],
  includedImages: 0,
  skippedImages: 0,
});

const pushChunk = (state: ContextBuildState, chunk: Omit<AiContextChunk, "order">) => {
  state.allChunks.push({ ...chunk, order: state.allChunks.length });
};

const sourcePrefix = (record: RecordBlock): string => {
  const tags = normalizeRecordTags(record.tags);
  return `${record.date} / ${record.subject} / ${record.title}${tags.length ? ` / 标签：${tags.map((tag) => `#${tag}`).join(" ")}` : ""}`;
};

const appendRecord = (
  state: ContextBuildState,
  record: RecordBlock,
  assets: Asset[],
  reviewContext?: AiRecordReviewContext,
) => {
  const tags = normalizeRecordTags(record.tags);
  state.markdownLines.push(`## ${record.subject} / ${record.title}`, tags.length ? `标签：${tags.map((tag) => `#${tag}`).join(" ")}` : "", "");
  const contextLines = recordContextLines(record, reviewContext);
  if (contextLines.length > 0) {
    state.markdownLines.push("### 记录与复习信息", ...contextLines, "");
    pushChunk(state, {
      chunkId: `${record.id}-review-context`,
      recordId: record.id,
      date: record.date,
      subject: record.subject,
      tags,
      title: record.title,
      kind: "text",
      content: contextLines.join("\n"),
      markdown: `### 记录与复习信息\n\n${contextLines.join("\n")}`,
      sourceLabel: `${sourcePrefix(record)} / 记录与复习信息`,
    });
  }
  const nodes = parseLinearRecordContent(record, assets);
  if (nodes.length === 0) {
    state.markdownLines.push("（空记录）", "");
    return;
  }

  let nodeIndex = 0;
  for (const node of nodes) {
    nodeIndex += 1;
    if (node.kind === "text" || node.kind === "structure" || node.kind === "highlight" || node.kind === "mermaid") {
      const markdown = normalizeText(node.markdown ?? node.text);
      const parts = splitText(node.text);
      const label = node.kind === "structure" ? "结构块" : node.kind === "highlight" ? "高亮块" : node.kind === "mermaid" ? "流程图" : "正文";
      for (const [partIndex, part] of parts.entries()) {
        pushChunk(state, {
          chunkId: `${record.id}-${node.kind}-${nodeIndex}-${partIndex + 1}`,
          recordId: record.id,
          date: record.date,
          subject: record.subject,
          tags,
          title: record.title,
          kind: "text",
          content: part,
          markdown: parts.length === 1 ? markdown : part,
          sourceLabel: `${sourcePrefix(record)} / ${label}${parts.length > 1 ? partIndex + 1 : ""}`,
        });
      }
      state.markdownLines.push(markdown, "");
      continue;
    }

    if (node.kind === "formula") {
      const content = normalizeText(node.formula.latex);
      const markdown = node.inline ? `$${content}$` : `$$\n${content}\n$$`;
      if (content) {
        pushChunk(state, {
          chunkId: `${record.id}-formula-${node.formula.id || nodeIndex}`,
          recordId: record.id,
          date: record.date,
          subject: record.subject,
          tags,
          title: record.title,
          kind: "formula",
          content,
          markdown,
          sourceLabel: `${sourcePrefix(record)} / 公式${node.formula.title ? `：${node.formula.title}` : ""}`,
        });
      }
      if (node.formula.title) state.markdownLines.push(`### ${node.formula.title}`);
      state.markdownLines.push(markdown, "");
      continue;
    }

    const kind = node.asset?.kind ?? node.ref.kind;
    const title = assetTitle(node.asset, node.ref.title);
    if (kind === "image") {
      const diagnostic = describeOcrForAi(node.asset);
      if (diagnostic.included && node.asset?.ocrText?.trim()) {
        state.includedImages += 1;
        const parts = splitText(node.asset.ocrText);
        for (const [partIndex, part] of parts.entries()) {
          pushChunk(state, {
            chunkId: `${record.id}-image-${node.ref.id}-${partIndex + 1}`,
            recordId: record.id,
            date: record.date,
            subject: record.subject,
            tags,
            title: record.title,
            kind: "imageOcr",
            content: part,
            markdown: `### 图片文字：${title}\n\n${part}`,
            sourceLabel: `${sourcePrefix(record)} / 图片OCR：${title}`,
          });
        }
        state.markdownLines.push(`### 图片文字：${title}`, node.asset.ocrText.trim(), "");
      } else {
        state.skippedImages += 1;
        state.missingOcrAssetIds.push(node.ref.id);
        state.skippedAssets.push(skipped(node.asset, node.ref.id, "image", diagnostic.reason));
      }
      continue;
    }

    state.skippedAssets.push(skipped(
      node.asset,
      node.ref.id,
      kind,
      kind === "audio" ? "音频文件暂不参与 AI 问答。" : "附件暂不参与 AI 问答。",
    ));
  }
};

const finalizeState = (
  scope: AiKnowledgeScope,
  scopeTitle: string,
  referenceDate: ISODate,
  records: RecordBlock[],
  state: ContextBuildState,
  query: string,
  options: AiContextSelectionOptions,
  recordContexts?: Readonly<Record<string, AiRecordReviewContext>>,
): AiContextPack => {
  if (records.length === 0) state.warnings.add("当前范围没有可用于 AI 问答的日志记录。");
  if (state.missingOcrAssetIds.length > 0) {
    state.warnings.add(`有 ${state.missingOcrAssetIds.length} 张图片未提供可用 OCR 文本，未参与本次问答。`);
  }
  const skippedNonImages = state.skippedAssets.filter((asset) => asset.kind !== "image");
  if (skippedNonImages.length > 0) {
    state.warnings.add(`有 ${skippedNonImages.length} 个音频或附件已跳过，不参与本次问答。`);
  }
  const limitedChunks: AiContextChunk[] = [];
  let indexedChars = 0;
  for (const chunk of state.allChunks) {
    if (indexedChars + chunk.content.length > MAX_INDEXED_CONTEXT_CHARS) {
      state.warnings.add("当前范围内容较多，AI 上下文已按安全上限截取；原始记录未受影响。");
      break;
    }
    limitedChunks.push(chunk);
    indexedChars += chunk.content.length;
  }
  const markdown = state.markdownLines.join("\n").replace(/\n{3,}/g, "\n\n").slice(0, MAX_STORED_MARKDOWN_CHARS).trim();
  if (state.markdownLines.join("\n").length > MAX_STORED_MARKDOWN_CHARS) {
    state.warnings.add("AI Markdown 预览已按安全上限截取；AI 问答仍使用选中的语义分片。");
  }
  const summary = buildSummary(scopeTitle, records, limitedChunks, recordContexts);
  const totalChars = limitedChunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
  const shouldSelect = totalChars > LONG_CONTEXT_CHARS || query.trim() || options.maxTokens;
  const selectedChunks = shouldSelect
    ? selectRelevantChunks(limitedChunks, query, options)
    : limitedChunks;
  const warnings = [...state.warnings];
  const contextHash = hashAiContext([
    aiKnowledgeScopeKey(scope),
    scopeTitle,
    summary,
    ...limitedChunks.map((chunk) => `${chunk.chunkId}:${chunk.content}:${chunk.markdown ?? ""}`),
    ...warnings,
  ].join("\n"));

  return {
    date: scopeDate(scope, referenceDate),
    scope,
    scopeTitle,
    recordIds: records.map((record) => record.id),
    markdown,
    summary,
    selectedChunks,
    allChunks: limitedChunks,
    totalChunks: limitedChunks.length,
    estimatedChars: selectedChunks.reduce((sum, chunk) => sum + chunk.content.length, 0),
    warnings,
    skippedAssets: state.skippedAssets,
    missingOcrAssetIds: Array.from(new Set(state.missingOcrAssetIds)),
    ocrSummary: { includedImages: state.includedImages, skippedImages: state.skippedImages },
    contextHash,
  };
};

const cacheKeyFor = (
  scope: AiKnowledgeScope,
  referenceDate: ISODate,
  records: RecordBlock[],
  assets: Asset[],
  recordContexts?: Readonly<Record<string, AiRecordReviewContext>>,
): string => {
  const assetIds = new Set(records.flatMap((record) => record.assets.map((asset) => asset.id)));
  const recordFingerprint = records.map((record) => [record.id, record.updatedAt, record.tags.join("\u0000"), record.contentHtml.length].join(":"));
  const assetFingerprint = assets
    .filter((asset) => assetIds.has(asset.id))
    .map((asset) => [asset.id, asset.updatedAt, asset.ocrStatus, asset.ocrText?.length ?? 0].join(":"));
  const contextFingerprint = records.flatMap((record) => recordContextLines(record, recordContexts?.[record.id]));
  return hashAiContext([aiKnowledgeScopeKey(scope), referenceDate, ...recordFingerprint, ...assetFingerprint, ...contextFingerprint].join("\n"));
};

const rememberContext = (key: string, pack: AiContextPack) => {
  contextCache.delete(key);
  contextCache.set(key, pack);
  while (contextCache.size > CONTEXT_CACHE_LIMIT) contextCache.delete(contextCache.keys().next().value!);
};

const selectFromCachedPack = (pack: AiContextPack, query: string, options: AiContextSelectionOptions): AiContextPack => {
  const totalChars = pack.allChunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
  const shouldSelect = totalChars > LONG_CONTEXT_CHARS || query.trim() || options.maxTokens;
  const selectedChunks = shouldSelect ? selectRelevantChunks(pack.allChunks, query, options) : pack.allChunks;
  return {
    ...pack,
    selectedChunks,
    estimatedChars: selectedChunks.reduce((sum, chunk) => sum + chunk.content.length, 0),
  };
};

const buildContext = (
  scope: AiKnowledgeScope,
  blocks: Block[],
  assets: Asset[],
  query: string,
  options: AiKnowledgeContextOptions,
): AiContextPack => {
  const referenceDate = options.referenceDate ?? todayISO();
  const records = getAiKnowledgeScopeRecords(scope, blocks, referenceDate);
  const cacheKey = cacheKeyFor(scope, referenceDate, records, assets, options.recordContexts);
  const cached = contextCache.get(cacheKey);
  if (cached) {
    contextCache.delete(cacheKey);
    contextCache.set(cacheKey, cached);
    return selectFromCachedPack(cached, query, options);
  }
  const scopeTitle = aiKnowledgeScopeTitle(scope, referenceDate);
  const state = createState(scopeTitle);
  records.forEach((record) => appendRecord(state, record, assets, options.recordContexts?.[record.id]));
  const base = finalizeState(scope, scopeTitle, referenceDate, records, state, "", {}, options.recordContexts);
  rememberContext(cacheKey, base);
  return selectFromCachedPack(base, query, options);
};

export const buildAiKnowledgeContextPack = (
  scope: AiKnowledgeScope,
  blocks: Block[],
  assets: Asset[],
  query = "",
  options: AiKnowledgeContextOptions = {},
): AiContextPack => buildContext(scope, blocks, assets, query, options);

export interface DecisionBlockAiContextPack extends AiContextPack {
  decisionBlockId: string;
  contentVersion: number;
}

export const buildDecisionBlockAiContextPack = (
  record: RecordBlock,
  decisionBlockId: string,
  assets: Asset[],
  query = "",
  options: AiContextSelectionOptions = {},
): DecisionBlockAiContextPack => {
  const decisionBlock = extractDecisionBlocks(record.contentHtml, record.updatedAt)
    .find((block) => block.decisionBlockId === decisionBlockId);
  if (!decisionBlock) throw new Error("指定的复习重点不存在或已被删除。");

  const scope: AiKnowledgeScope = { kind: "records", recordIds: [record.id] };
  const scopeTitle = `${record.title} / 复习重点`;
  const scopedRecord: RecordBlock = { ...record, contentHtml: decisionBlock.innerHtml };
  const state = createState(scopeTitle);
  appendRecord(state, scopedRecord, assets);
  const pack = finalizeState(scope, scopeTitle, record.date, [scopedRecord], state, query, options);
  return {
    ...pack,
    decisionBlockId,
    contentVersion: decisionBlock.contentVersion,
  };
};

export const buildAiContextPack = (
  date: string,
  blocks: Block[],
  assets: Asset[],
  query = "",
): AiContextPack => buildContext({ kind: "date", date }, blocks, assets, query, { referenceDate: date });

const yieldAiContext = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    if (typeof window !== "undefined") {
      window.setTimeout(resolve, 0);
    } else {
      setTimeout(resolve, 0);
    }
  });
};

export const buildAiKnowledgeContextPackAsync = async (
  scope: AiKnowledgeScope,
  blocks: Block[],
  assets: Asset[],
  query = "",
  signal?: AbortSignal,
  options: AiKnowledgeContextOptions = {},
): Promise<AiContextPack> => {
  const referenceDate = options.referenceDate ?? todayISO();
  const records = getAiKnowledgeScopeRecords(scope, blocks, referenceDate);
  const cacheKey = cacheKeyFor(scope, referenceDate, records, assets, options.recordContexts);
  const cached = contextCache.get(cacheKey);
  if (cached) return selectFromCachedPack(cached, query, options);

  const scopeTitle = aiKnowledgeScopeTitle(scope, referenceDate);
  const state = createState(scopeTitle);
  for (const record of records) {
    if (signal?.aborted) throw new DOMException("AI context cancelled", "AbortError");
    appendRecord(state, record, assets, options.recordContexts?.[record.id]);
    await yieldAiContext();
  }
  const base = finalizeState(scope, scopeTitle, referenceDate, records, state, "", {}, options.recordContexts);
  rememberContext(cacheKey, base);
  return selectFromCachedPack(base, query, options);
};

export const buildAiContextPackAsync = async (
  date: string,
  blocks: Block[],
  assets: Asset[],
  query = "",
  signal?: AbortSignal,
): Promise<AiContextPack> => buildAiKnowledgeContextPackAsync(
  { kind: "date", date },
  blocks,
  assets,
  query,
  signal,
  { referenceDate: date },
);

/** Sessions retain only the current retrieval result; the large local index lives in the in-memory cache. */
export const compactAiContextPack = (pack: AiContextPack): AiContextPack => ({ ...pack, allChunks: [] });

export const clearAiContextCache = () => contextCache.clear();
