const HEADER_SIZE = 4;
const MESSAGE_FULL_CLIENT = 0x1;
const MESSAGE_AUDIO_CLIENT = 0x2;
const MESSAGE_FULL_SERVER = 0x9;
const MESSAGE_ERROR = 0xf;
const FLAG_POSITIVE_SEQUENCE = 0x1;
const FLAG_NEGATIVE_SEQUENCE = 0x2;
const FLAG_NEGATIVE_WITH_SEQUENCE = 0x3;
const SERIALIZATION_JSON = 0x1;
const COMPRESSION_GZIP = 0x1;

const uint32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
};

const buildFrame = (messageType: number, flags: number, serialization: number, payload: Uint8Array) => {
  const result = new Uint8Array(HEADER_SIZE + 4 + payload.byteLength);
  result.set([0x11, (messageType << 4) | flags, serialization << 4, 0x00], 0);
  result.set(uint32(payload.byteLength), HEADER_SIZE);
  result.set(payload, HEADER_SIZE + 4);
  return result;
};

export interface DoubaoAsrStartRequest {
  requestId: string;
  sampleRate: number;
  language?: string;
  model?: string;
  punctuation?: boolean;
  inverseTextNormalization?: boolean;
  disfluencyRemoval?: boolean;
}

export const buildDoubaoAsrStartFrame = (request: DoubaoAsrStartRequest): Uint8Array => {
  const payload = new TextEncoder().encode(JSON.stringify({
    user: { uid: request.requestId },
    audio: {
      format: "pcm",
      codec: "raw",
      rate: request.sampleRate,
      bits: 16,
      channel: 1,
      ...(request.language ? { language: request.language } : {}),
    },
    request: {
      reqid: request.requestId,
      sequence: 1,
      model_name: request.model || "bigmodel",
      enable_itn: request.inverseTextNormalization ?? true,
      enable_punc: request.punctuation ?? true,
      enable_ddc: request.disfluencyRemoval ?? false,
      show_utterances: true,
      result_type: "full",
    },
  }));
  return buildFrame(MESSAGE_FULL_CLIENT, 0, SERIALIZATION_JSON, payload);
};

export const buildDoubaoAsrAudioFrame = (payload: Uint8Array, final = false): Uint8Array =>
  buildFrame(MESSAGE_AUDIO_CLIENT, final ? FLAG_NEGATIVE_SEQUENCE : 0, 0, payload);

export interface ParsedDoubaoAsrFrame {
  messageType: number;
  flags: number;
  final: boolean;
  errorCode?: number;
  payload: Uint8Array;
}

const decompressGzip = async (payload: Uint8Array): Promise<Uint8Array> => {
  if (typeof DecompressionStream === "undefined") throw new Error("当前运行环境不支持豆包 ASR 的 GZIP 响应。");
  const input = new Blob([payload.slice().buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(input).arrayBuffer());
};

export const parseDoubaoAsrFrame = async (input: Uint8Array): Promise<ParsedDoubaoAsrFrame> => {
  if (input.byteLength < 8) throw new Error("豆包 ASR 返回了过短的数据帧。");
  const headerSize = (input[0] & 0x0f) * 4;
  if (headerSize < HEADER_SIZE || input.byteLength < headerSize + 4) throw new Error("豆包 ASR 数据帧头无效。");
  const messageType = input[1] >> 4;
  const flags = input[1] & 0x0f;
  const compression = input[2] & 0x0f;
  let offset = headerSize;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const hasSequence = messageType !== MESSAGE_AUDIO_CLIENT
    && (flags === FLAG_POSITIVE_SEQUENCE || flags === FLAG_NEGATIVE_SEQUENCE || flags === FLAG_NEGATIVE_WITH_SEQUENCE);
  if (hasSequence) {
    if (input.byteLength < offset + 4) throw new Error("豆包 ASR 响应缺少序号。");
    offset += 4;
  }
  let errorCode: number | undefined;
  if (messageType === MESSAGE_ERROR) {
    if (input.byteLength < offset + 4) throw new Error("豆包 ASR 错误响应缺少状态码。");
    errorCode = view.getUint32(offset, false);
    offset += 4;
  }
  if (input.byteLength < offset + 4) throw new Error("豆包 ASR 响应缺少负载长度。");
  const payloadSize = view.getUint32(offset, false);
  offset += 4;
  if (input.byteLength < offset + payloadSize) throw new Error("豆包 ASR 响应负载不完整。");
  let payload: Uint8Array = input.slice(offset, offset + payloadSize);
  if (compression === COMPRESSION_GZIP) payload = await decompressGzip(payload);
  return {
    messageType,
    flags,
    final: flags === FLAG_NEGATIVE_SEQUENCE || flags === FLAG_NEGATIVE_WITH_SEQUENCE,
    ...(errorCode !== undefined ? { errorCode } : {}),
    payload,
  };
};

export const isDoubaoAsrResultFrame = (frame: ParsedDoubaoAsrFrame) => frame.messageType === MESSAGE_FULL_SERVER;
export const isDoubaoAsrErrorFrame = (frame: ParsedDoubaoAsrFrame) => frame.messageType === MESSAGE_ERROR;
