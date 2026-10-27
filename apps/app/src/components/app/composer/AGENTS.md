# Composer document model

Authored text, reference and skill atoms, and pending or failed uploads. This
is the authoring boundary; admission and server authority live outside it.

- A reference is a standard Markdown link to a canonical URI. Rich HTML on the
  clipboard keeps identity but is untrusted: admission, not clipboard metadata,
  authorizes access.
- One `composerReference` atom whose `reference` is a union on `kind`: a
  document (with authority and an optional owned upload) or a folder (identity
  and URI only). Narrow on `kind`; only documents own uploads or follow.
- Only registered command atoms execute; typed `/slug` prose never activates a
  skill. `compact`, `handoff` and `clear` are reserved slugs.
- One button: Stop while the box is empty and a reply runs, Send once the
  writer types (a send during a reply queues a steer). Stopping and sending at
  once lives in the queue, not the composer.
- Failures are `FailureCard`s from the chat's `chatCards`, drawn in one card
  stack above attached strips, never between a strip and the box.
- Usage waiting comes from the chat's `RunState`, never a client balance guess.
- Hosts own session persistence through `initialDraft` and `onDraftChange`.
- A context row drop resolves through the same live catalog as `@` and
  inserts the same `composerReference` atom. The shared editor drop extension
  owns word snapping, spacing, one-step Undo, and the drop caret.
- A desktop file dropped on the composer or the chat's transcript attaches through
  `attachFiles`, the paperclip's one door into the chat's Uploads (`useFileDrop`
  claims `Files` drags only; tree entries stay with the reference drop above). A
  dropped folder is a failed chip: the intake takes files only.

Reference spelling, commands, Stop and Send states and copy, draft restore:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
