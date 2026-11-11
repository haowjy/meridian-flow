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
- Usage waiting comes from the chat's `RunState`, never a client balance guess.
- Hosts own session persistence through `initialDraft` and `onDraftChange`.

Reference spelling, commands, draft restore:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
