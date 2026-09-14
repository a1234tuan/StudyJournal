import { AI_MIN_TOKENS_PER_CHAR, estimateAiTokens } from "../../lib/aiTokens";
import { DEFAULT_AI_CONTEXT_WINDOW_TOKENS } from "../../lib/aiProviders";
import type { VoiceTeacherMessage } from "./contracts";
import { UNTRUSTED_LEARNING_CONTENT_GUARD } from "./contentBoundary";

/**
 * @deprecated Superseded by the token budget derived from the provider context window. Retained
 * so historical callers and diagnostics keep compiling; do not introduce new uses.
 */
export const VOICE_TEACHER_MAX_MATERIAL_CHARACTERS = 6_000;
/**
 * @deprecated Superseded by per-record token allocation. A single record is no longer capped at a
 * fixed length — it may use the whole material budget when it is the only selected record.
 */
export const VOICE_TEACHER_MAX_RECORD_CHARACTERS = 1_200;

export const VOICE_TEACHER_HISTORY_TURNS = 10;
export const VOICE_CONVERSATION_PROMPT_VERSION = "voice-conversation-prompt@1.0";

/** Share of the provider context window that voice material is allowed to occupy. */
export const VOICE_MATERIAL_WINDOW_RATIO = 0.7;
/** Head-room kept free for provider-side framing and tokenizer drift. */
export const VOICE_MATERIAL_SAFETY_RESERVE_TOKENS = 512;
/** Reply reservation used when the caller does not pass the profile's clamped `maxTokens`. */
export const VOICE_DEFAULT_OUTPUT_RESERVE_TOKENS = 256;
/**
 * Fixed framing allowance for the material message header (including the truncation
 * declaration) and its JSON envelope.
 */
export const VOICE_MATERIAL_FRAMING_TOKENS = 96;
/** Per-record framing allowance (`《title》` plus envelope escaping). */
export const VOICE_MATERIAL_RECORD_FRAMING_TOKENS = 24;
/** Below this allocation a record cannot carry a usable excerpt, so it is skipped instead. */
export const VOICE_MATERIAL_MIN_RECORD_TOKENS = 48;
/** Appended to a record whose tail was cut so the model knows the excerpt is incomplete. */
export const VOICE_MATERIAL_TRUNCATION_MARKER = "\n…（本条内容过长，已截断）";

/**
 * Allocation strategy for the material budget. One strategy is implemented today; the constant
 * exists so a future switch is a deliberate, reviewable change rather than an implicit one.
 *
 * `equal-share-with-unified-recycle`: every record with content starts with an equal share of the
 * budget. Records that fit whole release their leftover into one pool, which is then re-split
 * evenly across the records that are still too large. It never weights one record above another,
 * so N equal records over a budget of N×k all end up roughly equally truncated.
 */
export const VOICE_MATERIAL_ALLOCATION = "equal-share-with-unified-recycle" as const;

export const VOICE_CONVERSATION_SYSTEM_PROMPT = [
  "你正在和用户进行一通语音电话。你说的每个字都会被转换成语音播放给对方，所以请像打电话一样自然说话。",
  "每次回复通常使用 1–3 句话，尽量控制在 50 字以内。内容较多时，先说最核心的一点；如果继续展开确实有帮助，可以先讲一小段，再询问对方是否继续。",
  "使用自然口语，不使用列表、Markdown 或格式化标题。遇到公式、数字、英文名称或符号时，用适合朗读的方式准确表达，不要机械朗读排版符号。",
  "默认先回应对方刚才表达的内容，再根据对话需要自然推进。可以在有助于理解、继续讨论或用户明确邀请时提问，但不要为了维持某种固定流程而提问。",
  "对方的话经过语音识别转写，可能存在同音字、断句或少量识别错误。能够根据上下文判断原意时，直接按合理原意回应；只有数字、名称或其他关键信息可能影响回答时，才向对方确认。",
  "示例：",
  "用户：我昨天看的傅里叶变换还是没太懂。",
  "你：你卡在哪一步？是不太理解它为什么能把时域变成频域吗？",
  "用户：对，就是这里。",
  "你：那我从一个直觉的比喻讲起，一次说一小段，你随时打断我。",
].join("\n\n");

export interface VoiceTeacherMaterial {
  title: string;
  /** Ordered plain-text segments of the record (`recordToPlainTextNodes`). Truncation is applied
   *  on these boundaries, so a segment is only ever cut when no whole segment fits. */
  nodes?: readonly string[];
}

export interface VoiceTeacherTurn {
  confirmedText?: string;
  teacherText?: string;
  assistantText?: string;
  playedText?: string;
  pendingText?: string;
  playbackStatus?: import("./localTypes").VoicePlaybackStatus;
  systemGenerated?: boolean;
}

export interface VoiceMaterialBlock {
  /** Index of the source record inside the caller-supplied `materials` array. */
  index: number;
  title: string;
  text: string;
  tokens: number;
  truncated: boolean;
}

export interface VoiceMaterialDrop {
  index: number;
  title: string;
  reason: "insufficient-share";
}

/** Machine-readable cause of a non-complete material set. */
export type VoiceMaterialReason = "budget" | "safety-cap" | "insufficient-share";

export interface VoiceMaterialStats {
  totalRecords: number;
  sentRecords: number;
  totalChars: number;
  sentChars: number;
  sentTokens: number;
  materialBudgetTokens: number;
  allocation: typeof VOICE_MATERIAL_ALLOCATION;
  truncated: boolean;
  truncatedRecords: number;
  reasonCodes: VoiceMaterialReason[];
  reasons: string[];
  droppedRecords: VoiceMaterialDrop[];
}

export interface VoiceMaterialPlan {
  blocks: VoiceMaterialBlock[];
  stats: VoiceMaterialStats;
}

const SEGMENT_JOIN = "\n\n";

const appendMarker = (body: string, useMarker: boolean): string =>
  useMarker ? `${body}${VOICE_MATERIAL_TRUNCATION_MARKER}` : body;

/**
 * Truncates a single segment. Prefers a line boundary (the segment usually still contains the
 * paragraph breaks inserted by `stripHtml`), and only then falls back to a raw character cut.
 */
const truncateInsideSegment = (text: string, tokenBudget: number): { text: string; tokens: number; truncated: boolean } => {
  if (tokenBudget <= 0) return { text: "", tokens: 0, truncated: true };
  const markerTokens = estimateAiTokens(VOICE_MATERIAL_TRUNCATION_MARKER);
  const useMarker = tokenBudget > markerTokens + VOICE_MATERIAL_MIN_RECORD_TOKENS;
  const bodyBudget = useMarker ? tokenBudget - markerTokens : tokenBudget;
  if (bodyBudget <= 0) return { text: "", tokens: 0, truncated: true };

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    const keptLines: string[] = [];
    for (const line of lines) {
      const candidate = [...keptLines, line].join("\n");
      if (estimateAiTokens(candidate) > bodyBudget) break;
      keptLines.push(line);
    }
    if (keptLines.length > 0) {
      const body = appendMarker(keptLines.join("\n"), useMarker);
      return { text: body, tokens: estimateAiTokens(body), truncated: true };
    }
  }

  // `estimateAiTokens` is monotonic in character count, so a binary search finds the longest
  // prefix that still fits. Code points (not UTF-16 units) avoid splitting surrogate pairs.
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateAiTokens(characters.slice(0, mid).join("")) <= bodyBudget) low = mid;
    else high = mid - 1;
  }
  const body = appendMarker(characters.slice(0, low).join("").trimEnd(), useMarker);
  return body.trim() ? { text: body, tokens: estimateAiTokens(body), truncated: true } : { text: "", tokens: 0, truncated: true };
};

/**
 * Longest prefix of `segments` that fits `tokenBudget`.
 *
 * Whole segments are preferred so a cut never lands inside a formula or a sentence. Only when
 * not even the first segment fits does it degrade to a boundary inside that segment.
 */
const takeWithinBudget = (segments: readonly string[], tokenBudget: number): { text: string; tokens: number; truncated: boolean } => {
  const kept: string[] = [];
  for (const segment of segments) {
    const candidate = [...kept, segment].join(SEGMENT_JOIN);
    if (estimateAiTokens(candidate) > tokenBudget) break;
    kept.push(segment);
  }

  if (kept.length === segments.length) {
    const text = kept.join(SEGMENT_JOIN);
    return { text, tokens: estimateAiTokens(text), truncated: false };
  }
  if (kept.length > 0) {
    const text = kept.join(SEGMENT_JOIN);
    return { text, tokens: estimateAiTokens(text), truncated: true };
  }
  return truncateInsideSegment(segments[0], tokenBudget);
};

/**
 * Resolves how many tokens the log material may spend this turn.
 *
 * The result is the tighter of two bounds:
 * - what is actually left of the window once the reply, the prompt, and the history are paid
 *   for; and
 * - a fixed share of the window (70%).
 *
 * Taking the minimum is required: with a small window and a long history the free remainder is
 * the binding constraint, while on a large window the 70% share keeps real head-room instead of
 * filling the window to its brim.
 */
export const resolveVoiceMaterialBudget = (input: {
  contextWindowTokens?: number;
  outputReserveTokens?: number;
  fixedTokens?: number;
} = {}): number => {
  const contextWindow = input.contextWindowTokens && input.contextWindowTokens > 0
    ? input.contextWindowTokens
    : DEFAULT_AI_CONTEXT_WINDOW_TOKENS;
  const outputReserve = Math.max(0, input.outputReserveTokens ?? VOICE_DEFAULT_OUTPUT_RESERVE_TOKENS);
  const fixed = Math.max(0, input.fixedTokens ?? 0);
  const availableForMaterials = contextWindow - outputReserve - fixed - VOICE_MATERIAL_SAFETY_RESERVE_TOKENS;
  const windowShare = Math.floor(contextWindow * VOICE_MATERIAL_WINDOW_RATIO);
  return Math.max(0, Math.min(availableForMaterials, windowShare));
};

/**
 * Character count that provably cannot exceed `materialBudgetTokens`.
 *
 * Dividing by the *cheapest* per-character rate means this cap can never fire before the token
 * budget does; it exists only as a defensive backstop, not as the primary limit.
 */
export const resolveVoiceMaterialCharacterCap = (materialBudgetTokens: number): number =>
  Math.max(0, Math.ceil(Math.max(0, materialBudgetTokens) / AI_MIN_TOKENS_PER_CHAR));

/**
 * Pure function that decides which part of each selected record is sent to the LLM.
 *
 * It is deterministic and side-effect free so the same inputs can be replayed for the call
 * details panel on demand — the plan is never persisted.
 */
export const planVoiceMaterials = (input: {
  materials?: readonly VoiceTeacherMaterial[];
  materialBudgetTokens: number;
  /** Optional defensive character ceiling layered on top of the token budget. */
  hardCharacterCap?: number;
  minRecordTokens?: number;
}): VoiceMaterialPlan => {
  const budget = Math.max(0, input.materialBudgetTokens);
  const minRecord = Math.max(1, input.minRecordTokens ?? VOICE_MATERIAL_MIN_RECORD_TOKENS);

  const entries = (input.materials ?? []).map((material, index) => {
    const segments = (material.nodes ?? []).map((node) => (node ?? "").trim()).filter(Boolean);
    const text = segments.join(SEGMENT_JOIN);
    return { index, title: material.title, segments, text, tokens: text ? estimateAiTokens(text) : 0 };
  });

  const fitted = new Map<number, (typeof entries)[number]>();
  const dropped = new Map<number, VoiceMaterialDrop>();

  // Equal share with unified recycle. `pending` only ever shrinks, so the loop is bounded by the
  // record count even though the share grows on every pass.
  let pending = entries.filter((entry) => entry.tokens > 0);
  while (pending.length > 0) {
    const used = [...fitted.values()].reduce((sum, entry) => sum + entry.tokens, 0);
    const share = (budget - used) / pending.length;
    if (share < minRecord) {
      for (const entry of pending) {
        dropped.set(entry.index, { index: entry.index, title: entry.title, reason: "insufficient-share" });
      }
      break;
    }
    const fits = pending.filter((entry) => entry.tokens <= share);
    if (fits.length === 0) break;
    const fittedIds = new Set(fits.map((entry) => entry.index));
    for (const entry of fits) fitted.set(entry.index, entry);
    pending = pending.filter((entry) => !fittedIds.has(entry.index));
  }

  const usedByFitted = [...fitted.values()].reduce((sum, entry) => sum + entry.tokens, 0);
  const oversizedShare = pending.length > 0 ? Math.max(0, budget - usedByFitted) / pending.length : 0;
  const planned = new Map<number, VoiceMaterialBlock>();

  for (const entry of entries) {
    const whole = fitted.get(entry.index);
    if (whole) {
      planned.set(entry.index, { index: entry.index, title: entry.title, text: whole.text, tokens: whole.tokens, truncated: false });
      continue;
    }
    if (!pending.some((item) => item.index === entry.index)) continue;
    if (oversizedShare < minRecord) {
      dropped.set(entry.index, { index: entry.index, title: entry.title, reason: "insufficient-share" });
      continue;
    }
    // Note: unlike a pure "node never fits ⇒ drop" rule, an oversized record whose very first
    // segment exceeds the share is still cut inside that segment rather than dropped. Dropping
    // would waste the share entirely, and the recycle loop above already terminates by
    // construction, so that rule is not needed to prevent an infinite loop here.
    const cut = takeWithinBudget(entry.segments, oversizedShare);
    if (!cut.text) {
      dropped.set(entry.index, { index: entry.index, title: entry.title, reason: "insufficient-share" });
      continue;
    }
    planned.set(entry.index, { index: entry.index, title: entry.title, text: cut.text, tokens: cut.tokens, truncated: cut.truncated });
  }

  let blocks = entries
    .map((entry) => planned.get(entry.index))
    .filter((block): block is VoiceMaterialBlock => Boolean(block));

  const reasonCodes = new Set<VoiceMaterialReason>();

  // Defensive character backstop. The derived cap cannot bind before the token budget, but a
  // caller may layer a tighter legacy cap on top.
  const hardCharacterCap = input.hardCharacterCap;
  if (typeof hardCharacterCap === "number" && Number.isFinite(hardCharacterCap)) {
    const sentChars = blocks.reduce((sum, block) => sum + block.text.length, 0);
    if (sentChars > hardCharacterCap) {
      console.warn(`[voice-recall] material characters ${sentChars} exceed cap ${hardCharacterCap}; trimming the tail.`);
      reasonCodes.add("safety-cap");
      const kept: VoiceMaterialBlock[] = [];
      let used = 0;
      for (const block of blocks) {
        const room = hardCharacterCap - used;
        if (room <= 0) break;
        const text = block.text.length <= room ? block.text : block.text.slice(0, room).trimEnd();
        if (!text) break;
        kept.push({ ...block, text, tokens: estimateAiTokens(text), truncated: block.truncated || text.length < block.text.length });
        used += text.length;
      }
      blocks = kept;
    }
  }

  const totalChars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
  const sentChars = blocks.reduce((sum, block) => sum + block.text.length, 0);
  const sentTokens = blocks.reduce((sum, block) => sum + block.tokens, 0);
  const truncatedRecords = blocks.filter((block) => block.truncated).length;
  const droppedRecords = [...dropped.values()].sort((left, right) => left.index - right.index);
  if (truncatedRecords > 0) reasonCodes.add("budget");
  if (droppedRecords.length > 0) reasonCodes.add("insufficient-share");

  const reasons: string[] = [];
  if (truncatedRecords > 0) reasons.push(`有 ${truncatedRecords} 条日志超出本次可发送的篇幅，只保留了开头部分。`);
  if (droppedRecords.length > 0) reasons.push(`本次可发送的篇幅不足，已跳过 ${droppedRecords.length} 条日志。`);

  return {
    blocks,
    stats: {
      totalRecords: entries.length,
      sentRecords: blocks.length,
      totalChars,
      sentChars,
      sentTokens,
      materialBudgetTokens: budget,
      allocation: VOICE_MATERIAL_ALLOCATION,
      truncated: truncatedRecords > 0 || droppedRecords.length > 0,
      truncatedRecords,
      reasonCodes: [...reasonCodes],
      reasons,
      droppedRecords,
    },
  };
};

export interface VoiceTeacherBuildInput {
  topic?: string;
  confirmedText?: string;
  materials?: readonly VoiceTeacherMaterial[];
  turns?: readonly VoiceTeacherTurn[];
  /** Provider context window in tokens. Falls back to the application default when omitted. */
  contextWindowTokens?: number;
  /** Clamped reply reservation. Falls back to `VOICE_DEFAULT_OUTPUT_RESERVE_TOKENS`. */
  outputReserveTokens?: number;
  /** @deprecated Legacy absolute character cap, applied as an extra backstop when provided. */
  maxMaterialCharacters?: number;
}

export interface VoiceTeacherTurnBuild {
  messages: VoiceTeacherMessage[];
  materialPlan: VoiceMaterialPlan;
  materialBudgetTokens: number;
  materialCharacterCap: number;
  /** Estimated tokens of the finished request, including the untrusted-content guard. */
  estimatedRequestTokens: number;
}

const buildTurnMessages = (input: VoiceTeacherBuildInput): VoiceTeacherMessage[] => {
  const messages: VoiceTeacherMessage[] = [];
  for (const turn of (input.turns ?? []).slice(-VOICE_TEACHER_HISTORY_TURNS)) {
    if (turn.systemGenerated) continue;
    if (turn.confirmedText?.trim()) {
      messages.push({ role: "user", content: turn.confirmedText.trim(), contentBoundary: "user-utterance" });
    }
    const assistantText = (turn.playedText ?? turn.assistantText ?? turn.teacherText)?.trim();
    if (assistantText) {
      const playbackNote = turn.pendingText || ["pending", "interrupted", "failed", "truncated"].includes(turn.playbackStatus ?? "")
        ? "\n（上一条回复还有内容未播放）"
        : "";
      messages.push({ role: "assistant", content: assistantText + playbackNote });
    }
  }
  if (input.confirmedText?.trim()) {
    messages.push({ role: "user", content: input.confirmedText.trim(), contentBoundary: "user-utterance" });
  }
  return messages;
};

/**
 * Declares exactly how much of the selected material travelled, so the model never mistakes a
 * partial excerpt for the whole record.
 */
export const describeVoiceMaterialHeader = (stats: VoiceMaterialStats): string => {
  if (!stats.truncated) return "【日志内容】";
  const scope = `本次发送 ${stats.sentRecords}/${stats.totalRecords} 条，共 ${stats.sentChars}/${stats.totalChars} 字`;
  return stats.reasonCodes.includes("safety-cap")
    ? `【日志内容（素材因异常被截断：${scope}；本次素材不完整，不要假设已看全）】`
    : `【日志内容（${scope}；未发送部分未提供，不要假设已看全）】`;
};

export const buildVoiceTeacherTurn = (input: VoiceTeacherBuildInput): VoiceTeacherTurnBuild => {
  const materials = input.materials ?? [];
  // The context branch is chosen from the raw material list rather than from the plan, because
  // the plan depends on the fixed-token estimate, which depends on that branch. Using the raw
  // list keeps the two decisions from feeding back into each other.
  const inMaterialMode = materials.some((material) => (material.nodes ?? []).some((node) => Boolean(node?.trim())));

  const conversationContext = inMaterialMode
    ? "背景：用户想围绕下面这段自己写的学习日志和你聊。它是对话素材，不是你必须逐条讲解的任务清单。"
    : input.topic?.trim()
      ? `当前通话主题：${input.topic.trim()}。\n主题只是对话的起点。如果用户聊到别处，跟着用户走，不要把话题拉回来。`
      : "";
  const systemContent = [VOICE_CONVERSATION_SYSTEM_PROMPT, conversationContext].filter(Boolean).join("\n\n");

  const turnMessages = buildTurnMessages(input);
  const fixedTokens = estimateAiTokens(systemContent)
    + (inMaterialMode ? estimateAiTokens(UNTRUSTED_LEARNING_CONTENT_GUARD) : 0)
    + turnMessages.reduce((sum, message) => sum + estimateAiTokens(message.content), 0)
    + (inMaterialMode ? VOICE_MATERIAL_FRAMING_TOKENS + materials.length * VOICE_MATERIAL_RECORD_FRAMING_TOKENS : 0);

  const materialBudgetTokens = resolveVoiceMaterialBudget({
    contextWindowTokens: input.contextWindowTokens,
    outputReserveTokens: input.outputReserveTokens,
    fixedTokens,
  });
  const derivedCharacterCap = resolveVoiceMaterialCharacterCap(materialBudgetTokens);
  const materialCharacterCap = typeof input.maxMaterialCharacters === "number"
    ? Math.min(derivedCharacterCap, Math.max(0, input.maxMaterialCharacters))
    : derivedCharacterCap;

  const materialPlan = planVoiceMaterials({
    materials,
    materialBudgetTokens,
    hardCharacterCap: materialCharacterCap,
  });

  const messages: VoiceTeacherMessage[] = [{
    role: "system",
    content: systemContent,
    contentBoundary: "trusted-instruction",
  }];

  if (materialPlan.blocks.length) {
    messages.push({
      role: "user",
      content: `${describeVoiceMaterialHeader(materialPlan.stats)}\n${materialPlan.blocks
        .map((block) => `《${block.title}》\n${block.text}`)
        .join(SEGMENT_JOIN)}`,
      contentBoundary: "untrusted-learning-content",
    });
  }

  messages.push(...turnMessages);

  const contextWindow = input.contextWindowTokens && input.contextWindowTokens > 0
    ? input.contextWindowTokens
    : DEFAULT_AI_CONTEXT_WINDOW_TOKENS;
  const outputReserve = Math.max(0, input.outputReserveTokens ?? VOICE_DEFAULT_OUTPUT_RESERVE_TOKENS);
  const estimatedRequestTokens = messages.reduce((sum, message) => sum + estimateAiTokens(message.content), 0)
    + (inMaterialMode ? estimateAiTokens(UNTRUSTED_LEARNING_CONTENT_GUARD) : 0);
  if (estimatedRequestTokens > contextWindow - outputReserve) {
    // Final safety net: the budget already accounts for every fixed part, so reaching this branch
    // means the estimate itself is drifting. Warn rather than silently overflow the window.
    console.warn(
      `[voice-recall] assembled request ~${estimatedRequestTokens} tokens exceeds ${contextWindow - outputReserve} of a ${contextWindow} token window.`,
    );
  }

  return { messages, materialPlan, materialBudgetTokens, materialCharacterCap, estimatedRequestTokens };
};

export const buildVoiceTeacherMessages = (input: VoiceTeacherBuildInput): VoiceTeacherMessage[] =>
  buildVoiceTeacherTurn(input).messages;
