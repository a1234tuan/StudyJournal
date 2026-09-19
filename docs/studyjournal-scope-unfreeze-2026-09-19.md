# StudyJournal scope extension — OCR failure dashboard and readable record export

Date: 2026-09-19

This note records the narrowly scoped maintenance exception requested for the
StudyJournal repository:

- add a device-local global OCR worklist for image references whose OCR is
  idle, queued, running, failed, or timed out, including a direct retry path;
- add human-readable single-record exports in Markdown, HTML, and plain text;
- keep the existing JSON record-transfer package as a separately named,
  machine-readable export.
- add a desktop-only native context menu for common editing commands (undo,
  redo, cut, copy, paste, paste as text, delete, and select all).

The change does not alter record persistence, OCR result semantics, cloud-sync
entity mapping, backup/restore formats, or AI context rules. OCR queue state
continues to follow the existing device-local operational rules; only the
existing OCR result fields and retry operation are surfaced. Readable exports
are projections of the current record and assets and are not importable.
The desktop context menu delegates to Chromium editing roles and therefore
reuses the existing editor clipboard event path; web and mobile surfaces are
unchanged.

## Voice output replay and local-history clarification

Date: 2026-09-20

This extension covers the voice-recall TTS clarification requested for the
frozen maintenance baseline:

- keep TTS audio as a streaming, device-local playback buffer only; do not add
  a persistent audio-cache table, backup field, cloud entity, or export payload;
- expose the current storage policy and live in-memory cache size with a cleanup
  action; when there is no active cache the UI reports `0 B`, so it does not
  imply that a hidden persistent cache exists;
- make an existing assistant reply a replay button that reuses the current
  call's in-memory TTS chunks, without creating a new formal turn, changing
  learning facts, or adding audio to local history; a reply restored without a
  current-session cache is synthesized once and then cached;
- explain that only a cache miss may consume additional TTS usage, and clarify that saved
  call history is an explicitly retained, device-only summary/usage record — not
  automatic session continuation, AI context, sync, or backup data.

This remains within the existing voice-recall local-only boundary. No schema
version, persistence contract, backup/restore behavior, cloud-sync mapping, or
formal review semantics change.
