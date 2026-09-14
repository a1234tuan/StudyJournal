/**
 * Role system prompt for every Review Coach structured-data call (F-17).
 *
 * Why this exists: `buildAiMessages` used to inject the conversational `CHAT_SYSTEM_PROMPT`
 * unconditionally. That prompt asks for Markdown and LaTeX and for a trailing source list, while
 * every coach gateway asks for "one JSON object, no extra fields, never reveal the answer". The
 * model was therefore given contradictory instructions on every call.
 *
 * Kept deliberately short: it only removes what conflicts with the JSON contract and states the
 * non-negotiables from the product boundary document (`docs/新的方案.md`).
 */
export const REVIEW_COACH_ROLE_SYSTEM_PROMPT = [
  "你是一个结构化数据生成器，为本地学习日志应用输出 JSON。",
  "只输出一个 JSON 对象，不要 Markdown、不要代码围栏、不要 LaTeX、不要在 JSON 之外追加任何文字（包括来源列表）。",
  "不得改变输入中给定的目标、来源引用与版本；不得补造来源、改写用户原话或宣告用户已掌握。",
  "信息不足时按输入要求返回 insufficient-context，不要猜测。",
].join("\n");
