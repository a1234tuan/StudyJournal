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

The initial report matched two nested waits: the Paraformer transport waited 30 seconds for `task-finished` after receiving valid text while the workspace remained in `finalizing-asr`. The first fix was too narrow: it covered only a Paraformer final sentence, while NLS and Doubao could still lose partial text when a terminal event was absent or a WebSocket closed first; Doubao retained the full 30-second wait. The automatic retry also compared against the pre-cancellation operation generation, so it invalidated its own scheduled restart.

All three transports now preserve recognized text after capture finishes, promote the latest non-empty partial only at a terminal/completion boundary, and complete after a 1.5-second grace when the provider omits its final control frame. A provider close after finish is completion when text exists, not a reason to clear the queue; a truly empty result has a 12-second diagnostic timeout. Regression tests cover partial promotion, missing terminal frames, and provider-close ordering for Paraformer, NLS, and Doubao. The retry uses the post-cancellation generation.

The earlier real-account gate sent silence and proved only authentication/protocol lifecycle. The follow-up streamed a paced 16 kHz Chinese PCM utterance through the checked-in NLS transport and required a non-empty `final`; it passed in 5.3 seconds. This proves the published project can recognize real speech through the implementation, while Android physical-device capture and multi-turn behavior remain separate gates.

## Official references

- [NLS WebSocket realtime recognition protocol](https://help.aliyun.com/zh/isi/developer-reference/websocket)
- [NLS Access Token lifecycle](https://help.aliyun.com/zh/isi/getting-started/obtain-an-access-token-1)
- [Console temporary Token](https://help.aliyun.com/zh/isi/getting-started/obtain-an-access-token-in-the-console)
