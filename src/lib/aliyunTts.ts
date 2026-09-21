export const aliyunTtsEndpoint = (model: string): string => model.startsWith("qwen-audio-")
  ? "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"
  : "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

export const buildAliyunTtsRequest = (model: string, voice: string, text: string) => ({
  model,
  input: {
    text,
    voice,
    ...(model.startsWith("qwen-audio-") ? { format: "mp3", sample_rate: 16000 } : {}),
  },
});

export const aliyunTtsAudioUrl = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  return parsed.href;
};
