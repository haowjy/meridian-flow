# core/editor — Collaborative editor runtime

This directory owns the browser-side TipTap schema, Yjs document sessions, and
editor-only projections. It is the app boundary for collaborative manuscript
editing; it does not own server persistence or trail authority.

## Mental model

One collaborative editor binds to one shared Yjs document fragment through the
`DocumentSessionRegistry`. Live peer marks are ephemeral projections of durable
change-trail events, not manuscript content.

## Key rules

- Assemble collaborative extensions only through `createEditorExtensions()` and
  keep the app schema aligned with `@meridian/prosemirror-schema`.
- Keep a single Yjs fragment and sync path per editor. Changing a room identity
  requires a TipTap remount.
- Do not persist, branch-project, or locally author peer marks. Resolve
  awareness cursor colors to concrete RGB before publication.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for session, peer-mark, draft-review,
and navigation contracts.
