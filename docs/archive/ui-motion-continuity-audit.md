# UI motion continuity audit

Updated: 2026-09-11

This checklist tracks the second-stage cleanup after the shared navigation intent and overlay presence infrastructure landed. Motion describes hierarchy or state change only; data refreshes, autosave, success text, and ordinary copy changes must not animate an entire page.

## Completed first-stage surfaces

- Root tabs: short cross-fade through `NavigationMotionIntent.tab`.
- Detail, editor, sub-setting, adaptive review, and review entry/return: directional forward/back transition.
- Web history: monotonic navigation index distinguishes forward from back while old snapshots remain readable.
- Review modes: local content fade for review queue, coach, library, and empty states.
- Review annotation: rating dock and annotation toolbar share one viewport slot and enter without changing fixed-position geometry.
- AI workspace: chat/scope and session changes keep the workspace page key stable; action sheets, context details, image actions, and history drawer use shared presence.
- Voice recall: start, scope, call, history, and summary change inside the mounted runtime workspace; pause/end sheets, details drawer, and journal confirmation use shared presence.
- Global high-frequency overlays: desktop migration, cloud conflict, editor image preview, and record-reference picker use the viewport portal and an exit lifecycle.

## Remaining migration inventory

| Area | Surface | Hierarchy | Target behavior | Status |
| --- | --- | --- | --- | --- |
| Trash | permanent delete / clear confirmation | modal | replace `window.confirm` with shared confirm dialog | pending |
| Record editor | delete and join-review confirmation | modal | shared confirm dialog; preserve draft and focus | pending |
| Backup | destructive restore confirmation | modal | shared confirm dialog before I/O starts | pending |
| Cloud maintenance | expensive cleanup and snapshot restore | modal | shared confirm dialog with quota context | pending |
| Templates | delete confirmation | modal | shared confirm dialog | pending |
| Knowledge podcast | delete confirmation | modal | shared confirm dialog | pending |
| Review feedback | history and legacy evaluation `details` | disclosure | measured height/opacity; retain native keyboard semantics | pending |
| Voice recall | advanced settings and diagnostics `details` | disclosure | measured height/opacity; retain `aria-expanded` | pending |
| Record reference | month result expansion | disclosure | measured local expansion; no page transition | pending |
| Long-tail menus | editor and management popovers | popover | migrate to shared presence where dismissal currently unmounts instantly | pending |

## Review rules

- Use `tab` only between root destinations, `forward` when entering a deeper task, `back` when returning, and `replace` for same-depth peer content.
- Keep input fields, scroll containers, audio runtimes, and active network sessions mounted across local state changes.
- An exiting overlay is immediately `inert`, `aria-hidden`, and pointer-disabled, then unmounted after its exit duration.
- Do not combine page movement with a modal or sheet movement for the same user action.
- Mobile sheets enter from the bottom; desktop drawers enter from the owning edge; popovers expand near their trigger.
- Under `prefers-reduced-motion`, transitions complete nearly immediately and never rely on motion to communicate state.

## Acceptance pass

- Keyboard: focus remains visible, returns to a logical trigger, and never enters an exiting overlay.
- Pointer/touch: no click-through during exit and no double-activation during rapid open/close.
- Layout: no horizontal overflow, fixed controls do not drift, and scroll position remains stable.
- Runtime: AI session state and voice capture/playback survive local view transitions.
