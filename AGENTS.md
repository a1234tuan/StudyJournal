# NoteProject Engineering Guide

## Current Baseline

- The 2026-09-11 voice-recall stage is frozen after controlled Android physical-device validation of automatic half-duplex multi-turn conversation. See `docs/voice-recall-freeze-2026-09-11.md`. Manual input modes and end-of-call data actions remain open gates; keep live tests explicitly excluded from ordinary validation and require separately approved paid-provider tests.

- Canonical open-source branch: `main`. The pre-publication history remains in the legacy repository on `feature/review-effect-coach-v2`.
- Product boundary: `docs/新的方案.md`.
- Database version: schema 21. Store definitions live in `src/db/reviewCoachSchema.ts`; schema 19 finalizes confirmed legacy facts and removes the six old Coach projection/execution tables, schema 20 adds device-local `reviewAnnotationDrafts`, and schema 21 adds the three device-local voice-recall stores.
- AI cockpit implementation is complete: Stages 0-8 were completed and verified on 2026-09-07, and Stage 9 automated release acceptance is complete. Physical-device upgrade and controlled real-account Firebase quota sign-off remain release gates; do not describe the release itself as signed off until they pass.
- Product UI migration is complete through final automated acceptance. `src/styles/visual-v2.css` is the active visual layer; `reading` is the default visual theme and `modern` is the alternative. The visual theme is device-local and independent from the existing light/dark/system setting; do not add it to the database or cloud-sync contract.
- The UI migration preserves formal create/save/rating semantics and routes Review Coach through `Review -> Learning Coach`. All caught errors rendered by React pages/components must pass through `src/lib/uiError.ts`; `src/lib/uiErrorSurface.test.ts` prevents raw `error.message` regressions.
- The 2026-09-08 review-workspace follow-up adds compact primary-page headers, process-lifetime cross-tab rating undo, and a first-stage read-only annotation surface. The annotation toolbar is viewport-fixed and dynamically avoids visible rating controls.
- The voice-recall production workspace uses a real, independently selectable `ASR -> LLM -> TTS` pipeline with device-local credentials, real transcript/reply streaming, manual input modes, and automatic half-duplex mode. Automatic half-duplex has been validated on an Android physical device across multiple consecutive rounds using Aliyun ASR, the configured LLM, and Fish Audio TTS. Doubao streaming ASR 1.0/2.0 (SAUC V3), large-model TTS 2.0 (V3), and small-model TTS (legacy V1) now have protocol and Desktop/Android host support, but remain unverified with an activated real account. Doubao end-to-end realtime voice is a separate combined runtime and is only documented as pre-support, not exposed as a modular provider. SiliconFlow real-time ASR, barge-in, and PCM/Opus gapless playback remain unimplemented. Manual push-to-talk/tap-to-record, keyboard/caption input, pause/continue/end actions, and local-log retention actions remain physical-device gates. `?preview=voice-recall` remains the isolated Mock call-control prototype. See `docs/doubao-voice-provider-compatibility.md`, `docs/voice-recall-freeze-2026-09-11.md`, and `docs/realtime-voice-recall-implementation.md`.
- The 2026-09-09 record-editor follow-up is complete through automated acceptance: mobile editor chrome shares one width basis, the tag field is a low-contrast labelled input, and expanded formatting/insertion tools use a compact grouped toolbar. These changes are scoped to `.record-editor-page` and do not alter record persistence or editor document semantics.
- The 2026-09-12 editor toolbar follow-up is complete through automated acceptance: the log editor uses a compact icon-only recorder on narrow screens, recorder feedback occupies a full-width row, and the code-language selector spans two mobile grid cells. These changes remain scoped to `.record-editor-page` and do not alter record persistence or editor document semantics.
- The 2026-09-12 usage-guide follow-up is complete through automated acceptance: More -> Usage Guide is organized as a task-oriented document with nine chapters, five responsive semantic illustrations under `public/guide/`, and a narrow-screen horizontal chapter index. The guide describes only implemented product capabilities and keeps provider credentials, local voice history, backup, and sync boundaries explicit.

## Voice Recall Boundaries

- Voice recall is an `ASR -> LLM -> TTS` active-recall medium, not a video-call feature or a third learning truth system.
- `voiceRecallSessions`, `voiceRecallTurns`, and `voiceRecallLocalHistory` are local-only schema 21 stores. They never enter Firebase, ZIP/streaming/native backup, knowledge export, record transfer, or cloud mutation bookkeeping.
- Full restore clears transient sessions/turns but preserves pre-existing local history. Cloud pull/no-op sync preserves all three stores. Local history itself is not portable; durable preservation must go through an explicitly created journal record.
- `userMuted` and `systemCaptureGate` are independent. Navigation, backgrounding, and view unmount pause capture/playback without ending the session; recovery always resumes paused.
- `NativeVoiceCapture` is separate from `NativeAudioRecorder`, and the two Android microphone paths must remain mutually exclusive.
- The deterministic `voice-mock-cn@1` template is verified for automation. `voice-default-cn@2` defaults to Aliyun Paraformer ASR, the user's current LLM, and Fish Audio TTS, while the start workspace can independently select configured ASR/LLM/TTS profiles. The default three legs were verified against live services on 2026-09-09, but the template stays `candidate` until physical-device acceptance. Doubao speech profiles remain candidates because no activated real account has validated them; never claim model, voice, quota, cost, browser-direct support, or streaming behavior from configuration alone.
- The reply chain must clamp `max_tokens` (currently 320) and send `thinking: { type: "disabled" }`: a reasoning model otherwise spends the whole budget on reasoning and returns an empty body. `voicePipeline.live.test.ts` covers this with a real provider when keys are supplied.
- Web permits only Mock, a user-controlled relay, or a profile explicitly validated as `browserDirectSupported`. Provider credentials and account-specific overrides remain device-local.
- Voice practice never writes FSRS or auto-rates a review card. A user-confirmed Coach transcript uses the existing `ReviewCoachOrchestrator.submitQuizAnswer` path with one answer per formal turn; a voice summary becomes a journal only after explicit confirmation.

## Review Annotation Boundaries

- Review annotations wrap the read-only review editor and never mutate `RecordBlock.contentHtml`.
- Drafts live only in `reviewAnnotationDrafts`. They are excluded from cloud sync, ZIP/streaming/native backup, knowledge export, and record transfer, and annotation writes must not mark a cloud mutation.
- An unscored draft survives component unmounts, navigation changes, reloads, and app restarts on the same device. A successful rating clears the matching `(recordId, reviewOccurrenceKey)` draft; undoing that rating restores the card but never restores the old annotation.
- Rating undo history belongs to the App-level `ReviewSessionRuntimeState`. It survives navigation while the App root remains mounted, but is not serialized into tab history, Dexie, backup, or sync.
- The current annotation editor supports browsing, pen/highlighter/eraser, basic shapes, text/input/select elements, color, width, opacity, and annotation undo/redo. Selection transforms, grouping, z-order editing, orphan repair, and full Excalidraw parity remain future work; do not describe them as implemented.

## Review Coach Boundaries

- `RecordBlock.contentHtml` is the only editable source of decision-block content. `DecisionBlock` is an index, not a second content copy.
- Formal review-coach writes go through `src/features/reviewCoach/repository.ts`; cross-entity workflows belong in `orchestrator.ts`, not `useAppData.ts`.
- Projections must be rebuildable from formal facts. AI responses and local execution caches are not truth sources.
- Record-level FSRS remains responsible for whole-record scheduling. Decision-block facts must not silently rewrite FSRS state.
- Stage 3 added block feedback, immutable history, tombstones, queue enrollment, exclusion/restoration, analysis notes, and manual legacy-comment association.
- Stage 4 calls only the quick feedback interpreter and preserves original feedback.
- Stage 5 adds the manually confirmed deep-analysis workbench, validated `SessionBlueprint` creation, and deterministic current/waiting/deferred task scheduling.
- Stage 6 adds the dedicated adaptive review page, Blueprint-constrained turn generation, independent question quality review, answer evaluation, hint/skip/invalid/defer/abandon dispositions, and atomic answer/outcome commits.
- Stage 7 schedules delayed verification through deterministic local policy, requires fresh retrieval questions, records retained/decayed outcomes independently from record FSRS, rebuilds block/effect projections from formal facts, and applies aging plus a two-verification streak cap to task selection.
- Stage 8 makes schema 11/16 migration transactional and retryable, retains confirmed legacy quiz/KnowledgePoint facts and record-level comments without automatic block binding, syncs every formal entity and tombstone, archives losing decision-block content conflicts, strips prompts/raw provider responses/secrets at export boundaries, and removes old Coach runtime tables.
- Stage 9 adds deterministic Playwright coverage at desktop and Android-narrow viewports plus isolated Firebase Emulator acceptance for namespace rules, bounded incremental writes, no-op replay, interruption recovery, and revision-based clock-skew convergence.
- The post-Stage-8 cloud audit keeps AI prompts, device-local backup paths, and knowledge-podcast rows/audio outside cloud and portable exports; restore preserves those local values transactionally. Ordinary no-op sync skips the cloud lock, and large read/write plans require explicit confirmation.
- App initialization may refresh due verifications, but must not select or replace the current task. Startup-created verification tasks use IDs and queue timestamps derived from the verification fact so two devices produce identical sync hashes.
- Cloud review-event history is append-only until a checkpoint plus event-tombstone protocol is designed. Do not delete remote events merely because local retention compacts old logs.
- Stage 6 quick-model calls use strict JSON and explicitly disable thinking. Controlled real-provider acceptance may use `https://api.deepseek.com` with `deepseek-v4-flash`; never persist API keys in source, tests, docs, logs, screenshots, backup, or sync data.

## Cross-Cutting Checks

When changing decision-block or review-coach behavior, verify all affected paths:

- Dexie migration and repository invariants
- backup/restore and record-transfer round trips
- cloud-sync entity mapping and tombstones
- export privacy at cloud, ZIP, streaming, and native repository boundaries
- read/write quota estimates and no-op lock avoidance
- record deletion and mixed-record cleanup
- Desktop and Android narrow-screen interaction

## Verification

```powershell
npm run test -- --exclude "**/*.live.test.ts"
npm run test:voice-host
npm run test:e2e
npm run test:firebase
npm run build
git diff --check
```

Use deterministic mocks in automated tests. Real AI providers are limited to explicit, controlled acceptance runs and must never replace deterministic CI coverage.

The current automated acceptance baseline is `158` deterministic Vitest files / `978` tests (the two additional opt-in live files are explicitly excluded from ordinary acceptance), `52` Playwright tests collected across Desktop and Android-narrow projects (`51` passed and one Desktop-only assertion was skipped on Android-narrow), and `4` isolated Firebase Emulator tests. The local host protocol gates also include two Node WebSocket tests and one Android OkHttp MockWebServer test. Physical Android keyboard/IME, system back, image gestures, real-device audio behaviour, and controlled real-account Firebase quota checks remain manual release gates. See `docs/second-audit-repair-acceptance.md` for R1–R15 and credential setup.

For local Stage 3 UI acceptance, run `npm run build`, start `npm run preview -- --host 127.0.0.1 --port 4177`, and open `http://127.0.0.1:4177/?preview=stage3`. This localhost-only query seeds an isolated `BFS Stage3 Preview` record with an overdue review, block feedback, and an analysis-queue item; it is gated out of normal URLs and native shells.

For Stage 4 UI acceptance, use `http://127.0.0.1:4177/?preview=stage4`. It adds a deterministic completed quick-model interpretation with diagnostics and confirmation controls without contacting an AI provider.

For Stage 5 UI acceptance, use `http://127.0.0.1:4177/?preview=stage5`. It seeds deterministic eligible blocks, an OCR warning, a partial analysis result, and current/waiting/deferred tasks without contacting an AI provider.

For Stage 6 UI acceptance, use `http://127.0.0.1:4177/?preview=stage6`. It seeds a deterministic in-progress task with one displayed, quality-checked turn; hints, answer submission, skip, invalid-question reporting, defer, and abandon controls can be exercised without contacting an AI provider.

For Stage 7 UI acceptance, use `http://127.0.0.1:4177/?preview=stage7`. It seeds one in-progress delayed verification plus retained and decayed history, then rebuilds block and intervention-effect projections without contacting an AI provider.

For a combined Review Coach showcase, use `http://127.0.0.1:4177/?preview=coach`. It renders the dashboard, adaptive training, and delayed verification in a localhost-only preview shell. Its controls use deterministic in-memory behavior and do not mount cloud sync or contact an AI provider.
