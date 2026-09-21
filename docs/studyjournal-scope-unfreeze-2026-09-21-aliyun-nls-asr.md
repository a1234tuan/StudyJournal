# StudyJournal scope extension - Aliyun NLS ASR reliability

## Decision

On 2026-09-21 the maintenance scope was extended for one voice-recall reliability incident and one independently selectable ASR fallback:

- prevent a valid finalized Aliyun Paraformer sentence from leaving the call in `finalizing-asr` for 30 seconds when the provider's terminal `task-finished` frame is delayed or lost;
- add Alibaba Cloud Intelligent Speech Interaction (NLS) SpeechTranscriber as a candidate ASR profile for the already published 16 kHz `识音石 V1` project;
- accept only a project AppKey plus a temporary NLS Access Token in the device-local `aiSecrets` store;
- add deterministic protocol/transport/UI tests and one opt-in real-account handshake test.

This decision does not change the frozen voice conversation prompt, learning semantics, schema, synchronization, backup, export, navigation, LLM, or TTS behavior.

## Credential boundary

The NLS WebSocket protocol requires the temporary Access Token in the connection URL and the project AppKey in `StartTranscription`. A console-issued Token is for testing only and expires after 24 hours. It may be entered in the app on a trusted device, but it must never be committed, logged, included in screenshots, backed up, synchronized, or embedded in an APK.

Long-running use requires a trusted token issuer that refreshes the Token through the Alibaba Cloud SDK or OpenAPI and returns only the short-lived Token to the client. AccessKey Secret is never accepted by the app and must not be stored in `aiSecrets` for this profile.

## Provider status

- The NLS protocol lifecycle and a real-account desktop/Node WebSocket session were verified on 2026-09-21 with silence PCM: connection, `StartTranscription`, binary audio, `StopTranscription`, and `TranscriptionCompleted` all succeeded.
- The profile remains `candidate`. Android physical-device speech accuracy, multi-turn recovery, weak-network behavior, Token expiry UX, concurrency, usage accounting, and billing still require controlled validation.
- The verified default remains Aliyun DashScope Paraformer ASR plus the configured LLM and Fish Audio TTS. NLS is an explicit alternative, not an automatic fallback and not a silent replacement.
- NLS speech synthesis was not added. The app already exposes Fish Audio, Doubao, and Aliyun Bailian TTS profiles; NLS TTS would require a separate host transport, credential lifecycle, audio-format validation, and latency comparison before it is suitable.

## Root-cause proof

The reported pause matched two nested waits: the Paraformer transport previously waited 30 seconds for `task-finished` even after receiving a valid final sentence, while the workspace remained in `finalizing-asr`. The transport now grants the terminal frame 1.5 seconds after the most recent final sentence, then completes locally if it never arrives; a no-result completion still fails after 8 seconds. A regression test first reproduced the unresolved wait and passes only with this behavior.

## Official references

- [NLS WebSocket realtime recognition protocol](https://help.aliyun.com/zh/isi/developer-reference/websocket)
- [NLS Access Token lifecycle](https://help.aliyun.com/zh/isi/getting-started/obtain-an-access-token-1)
- [Console temporary Token](https://help.aliyun.com/zh/isi/getting-started/obtain-an-access-token-in-the-console)
