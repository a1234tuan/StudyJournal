# Voice-recall TTS Android validation — 2026-09-21

## Scope and reproduced failures

The user authorized short live-provider tests on their connected Android phone. Existing journal data, credentials, ASR behavior, replay buffering, signing identity, and local-only history boundaries are preserved. Test conversations use a free topic and keyboard-confirmed text; these results validate the real LLM -> TTS -> Android audio path, not a new microphone/ASR acceptance or a subjective audio-quality ranking.

- Qwen Audio 3.1 and 3.0 both failed with HTTP 400 and InvalidParameter (task can not be null). The old implementation sent both model families to the obsolete text2audio endpoint, and the built-in Qwen Audio profile incorrectly used the older Qwen-TTS Cherry voice.
- Correcting the protocol exposed a second Android failure: the provider's signed audio URL used HTTP, which the app correctly blocks. Downloads now upgrade to HTTPS without changing the signed path/query; Android cleartext traffic remains disabled.
- The newly supplied Doubao API credential returned HTTP 401, Invalid X-Api-Key. It was not persisted. The pre-existing device-local Doubao TTS credential succeeded and remains unchanged. No cloud-account Access Key was used.

## Implementation

- Qwen Audio 3.x uses /api/v1/services/audio/tts/SpeechSynthesizer, with text, voice, format, and sample_rate under input.
- Existing qwen3-tts-flash/Cherry uses /api/v1/services/aigc/multimodal-generation/generation; it is not silently converted to Qwen Audio.
- Independent voice-recall presets pair qwen-audio-3.1-tts-flash with longanfengyue_v3.1 and qwen-audio-3.0-tts-flash with longanfengyue.
- Web fallback, desktop host, and Android host are aligned. Qwen Audio requests MP3; legacy Qwen-TTS WAV responses are no longer labelled as MP3. Empty Android audio responses fail explicitly.
- No replay, sentence dispatch, ASR, learning facts, database schema, backup, or sync behavior was changed in this TTS patch.

## Physical-device evidence

All three candidates completed a real voice-recall conversation using the configured LLM and actual provider calls. The requested reply was three short Chinese sentences, dispatched as two audio segments (18 and 9 text characters). Two synthesis operations started before either completed; playback remained ordered.

- Qwen Audio 3.1: two successful native syntheses, 66,907 and 35,803 bytes. Cache replay produced two running Web Audio source nodes of 4.176 and 2.232 seconds, with completed playback events and no new synthesis (request count stayed 2).
- Qwen Audio 3.0: two successful native syntheses, 68,059 and 32,347 bytes; playback durations 4.248 and 2.016 seconds. Replay advanced the played-segment count from 2 to 4 while synthesis stayed at 2. Manual cache clear returned the UI to no cached audio.
- Doubao seed-tts-2.0: two successful native syntheses, 44,115 and 18,483 bytes; playback durations 5.508 and 2.304 seconds. Replay advanced the played-segment count from 2 to 4 while synthesis stayed at 2. The actual cache Map held 62,598 bytes before hangup and had size 0 after hangup.

Adjacent source start/end callbacks occurred in the same event-loop turn; this confirms ordered queue handoff, not a guarantee of sample-accurate gapless audio or perceived sound quality. No generated audio, provider credential, signed download URL, or user study material is included in this record. Test summaries are discarded rather than retained as history or formal journals. The original Fish Audio selection and automatic input mode are restored after testing.

## Regression coverage and remaining gates

src/services/aliyunTtsProvider.test.ts covers both new models, the legacy family, model-specific presets, signed HTTPS downloads, host/cancellation behavior, and missing/empty audio. VoiceProviderSettings.test.tsx covers switching between both new presets and back to Fish Audio. Existing voice-workspace replay/clear tests and queue/playback tests remain applicable.

This controlled run does not establish provider billing/free-quota accounting, long-duration reliability, weak-network behavior, subjective speaker audibility, or a new full ASR acceptance. Do not mark the complete production template universally verified on the strength of TTS tests alone.

Final local validation: 209 test files / 1,528 unit tests passed; five opt-in live tests were skipped. The voice-recall production Playwright spec passed 6/6 across desktop and narrow Android layouts. TypeScript/Vite and the signed Android release build passed. The release APK (versionCode 14, versionName 0.2.3) was reinstalled with adb install -r, preserving app data; DEBUGGABLE is absent and the temporary ADB debug forward was removed. APK SHA-256: 798EAF64B9F6F6B1489B8A2DF3471EAA849FF3B0F060C5D6A7D4C06C5C3C390C.

## Official references checked

- https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
- https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list
- https://help.aliyun.com/zh/model-studio/qwen-tts-api
