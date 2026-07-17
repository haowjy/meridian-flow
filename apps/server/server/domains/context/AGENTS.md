# domains/context

Agent-readable/writable project content addressed by context URIs. Five
schemes split into durable Project content (`manuscript://`, `kb://`,
`user://`) and work-item-scoped scratch (`scratch://`, `uploads://`). Bare paths
default to `manuscript://`.

Single unified `ContextPort` — callers resolve through `contextPortForThread`,
never scheme-specific adapters directly.

Text creation and writes must resolve the document filetype and use the collab
document engine. Never seed Yjs by hand with an assumed markdown schema.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for contracts, URI invariants,
and ContextFS details.

→ [`domains/collab`](../collab/AGENTS.md) owns schema-aware Yjs codecs and
journaling.

## HTTP routes

Seven context routes live under
`routes/api/projects/[projectId]/context/[scheme]/`. All share `_helpers.ts`
which provides:

- `resolveContextRoute(event)` — the common preamble: auth → project ownership
  → scheme parsing → workId resolution → context port resolution. Returns
  `{ app, userId, projectId, scheme, workId, port }`.
- `sanitizePath(raw)` — rejects `.`/`..` segments at the route boundary
  (defense-in-depth; the domain layer also validates).
- `parseScheme`, `contextErrorToHttp`, `toUri`.

Routes: `tree.get.ts`, `read.get.ts`, `create.post.ts`, `create-untitled.post.ts`, `rename.post.ts`,
`delete.post.ts`, `upload.post.ts`.
