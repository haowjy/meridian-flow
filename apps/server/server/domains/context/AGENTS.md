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

Eight context routes live under
`routes/api/projects/[projectId]/context/[scheme]/`. Most use `_helpers.ts` for
auth, project ownership, scheme/Work resolution, canonical error translation,
and URI construction. Writer-facing mutation input goes through the shared
reason-coded validators in `lib/context-mutation-validation.ts`.

`move.post.ts` is intentionally a thinner shell over `lib/context-move-route.ts`:
the route core authorizes every referenced Work authority and calls
`ContextPort.commitWriterLocation`. Proven destination occupation returns a
collision locator; stale source/target plans return a retry result instead.

`create-untitled.post.ts` accepts a client-minted document ID. Idempotent retries
recover that ID across all project and authorized Work schemes, returning its
canonical scheme/path/Work authority. Returned `name` values are full filenames.

Routes: `tree.get.ts`, `read.get.ts`, `create.post.ts`, `create-untitled.post.ts`,
`rename.post.ts`, `move.post.ts`, `delete.post.ts`, `upload.post.ts`.
