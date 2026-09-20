# StudyJournal scope extension - voice-recall latency maintenance

Date: 2026-09-20

This note records the narrowly scoped maintenance exception requested for the
frozen StudyJournal voice-recall workspace:

- begin playback as soon as the first ordered TTS audio segment is available,
  while retaining the existing process-memory-only replay cache;
- replace the fixed automatic endpoint delay with a deterministic adaptive
  policy driven by local audio activity and the timing/shape of ASR updates;
- add device-local, text-free latency observations and an explicitly opt-in
  real-provider comparison between Aliyun Paraformer and Doubao streaming ASR
  2.0.

The modular `ASR -> LLM -> TTS` architecture, prompt versions, learning-fact
boundaries, record-level scheduling, confirmation rules, and provider selection
remain unchanged. The work adds no database schema, cloud-sync entity, backup
field, export payload, persistent audio cache, or raw-audio retention. TTS audio
continues to exist only in memory for the active call and is cleared on call end
or view unmount. ASR, LLM, and TTS credentials remain device-local and must not
enter source, tests, docs, logs, screenshots, backup, or sync data.

Ordinary automated validation uses deterministic providers only. Paid-provider
comparison remains opt-in, requires user-supplied environment variables or the
existing local credential UI, and cannot by itself promote a candidate provider
to verified/default status. Physical-device multi-turn acceptance remains a
release gate.

## Opt-in ASR comparison

Prepare one headerless 16 kHz, mono, signed 16-bit little-endian PCM sample.
The live comparison is disabled unless every required variable and the explicit
run switch are present:

```powershell
$env:VOICE_ASR_AB_RUN = "1"
$env:VOICE_ASR_AB_PCM = "D:\private\voice-sample.pcm"
$env:VOICE_ASR_AB_ALIYUN_KEY = "<device-local value>"
$env:VOICE_ASR_AB_DOUBAO_KEY = "<device-local value>"
# Only for a legacy Doubao App-ID + Access-Token account:
$env:VOICE_ASR_AB_DOUBAO_TOKEN = "<device-local value>"
npx vitest run src/features/voiceRecall/asrComparison.live.test.ts
```

The console report contains provider id, connection/partial/final/completion
latency, completion state, and final character count only. It never prints the
audio, transcript, file path, or credentials. A release decision still needs
at least 10 consecutive physical-device turns per provider, using the same
utterance set and recording first partial/final latency, correction rate,
endpoint errors, and failed turns. Doubao ASR 2.0 remains a candidate until
that controlled run passes.
