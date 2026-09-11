/** Decodes the newline-delimited base64 audio chunks returned by Doubao V3 TTS. */
export const decodeDoubaoTtsNdjson = (payload: string): Uint8Array => {
  const chunks: Uint8Array[] = [];
  for (const line of payload.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let item: { data?: unknown; code?: unknown; message?: unknown };
    try {
      item = JSON.parse(trimmed) as { data?: unknown; code?: unknown; message?: unknown };
    } catch {
      throw new Error("豆包 TTS 返回了无法解析的响应。");
    }
    const code = item.code == null ? "" : String(item.code).trim();
    // V3 sends a final `{ code: 20000000, message: "OK" }` event after
    // the base64 audio chunks. It is a successful end marker, not an error.
    if (code && code !== "0" && code !== "20000000") {
      const detail = typeof item.message === "string" ? item.message : `错误码 ${String(item.code)}`;
      throw new Error(`豆包 TTS 请求失败：${detail}`);
    }
    if (typeof item.data !== "string" || !item.data) continue;
    const binary = atob(item.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    chunks.push(bytes);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!total) throw new Error("豆包 TTS 未返回音频数据。");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

/** Decodes the legacy small-model V1 JSON response (success code 3000). */
export const decodeDoubaoSmallTtsJson = (payload: string): Uint8Array => {
  let item: { code?: unknown; message?: unknown; data?: unknown };
  try {
    item = JSON.parse(payload) as typeof item;
  } catch {
    throw new Error("豆包小模型 TTS 返回了无法解析的响应。");
  }
  if (Number(item.code) !== 3000) {
    const detail = typeof item.message === "string" ? item.message : `错误码 ${String(item.code ?? "未知")}`;
    throw new Error(`豆包小模型 TTS 请求失败：${detail}`);
  }
  if (typeof item.data !== "string" || !item.data) throw new Error("豆包小模型 TTS 未返回音频数据。");
  const binary = atob(item.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};
