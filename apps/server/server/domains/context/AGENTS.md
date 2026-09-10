# domains/context

Agent-readable/writable content addressed by context URIs. Five schemes split
into durable Project content (`manuscript://`, `kb://`), authenticated personal
content (`user://`), and Work/no-Work material (`scratch://`, `uploads://`).
Bare paths default to `manuscript://`.

Single unified `ContextPort` — callers resolve through `contextPortForThread`,
never scheme-specific adapters directly.

Wire-qualified Work URIs use `@slug`. Parsing produces grammar-only `WorkSlug`;
project resolution couples an exact non-deleted Work ID and persisted slug into
the opaque authority used for stable serialization and adapter dispatch.
`thread_works` membership selects the thread's primary Work but never grants
context access.

Scheme capabilities are declared once in `ports/context-adapter.ts` and enforced
by the router. F0 owns Uploads authority, provisioning, and resolution; F4 owns
the actual `UploadIntake` lifecycle. `uploads://` does not allow general clients
to create context entries or directories, so binary intake is flat;
`scratch://` is the Work authoring space and accepts nested intake paths.

Text creation and writes must resolve the document filetype and use the collab
document engine. Never seed Yjs by hand with an assumed markdown schema.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for contracts, URI invariants,
and ContextFS details.

→ [`domains/collab`](../collab/AGENTS.md) owns schema-aware Yjs codecs and
journaling.

## HTTP routes

Eight filesystem mutation/content routes live under
`routes/api/projects/[projectId]/context/[scheme]/`. Most use `_helpers.ts` for
auth, project ownership, scheme/Work resolution, canonical error translation,
and URI construction. Writer-facing mutation input goes through the shared
reason-coded validators in `lib/context-mutation-validation.ts`.

`move.post.ts` is intentionally a thinner shell over `lib/context-move-route.ts`:
the route core resolves every requested locator to exact project/no-Work/Work
authority before it calls
`ContextPort.commitWriterLocation`. Proven destination occupation returns a
collision locator with that same authority; any port identity mismatch is an
internal contract error. Stale source/target plans return a retry result instead.

`create-untitled.post.ts` accepts a client-minted document ID. Idempotent retries
recover that ID across all project and authorized Work schemes, returning its
canonical scheme/path/Work authority. Returned `name` values are full filenames.

Routes: `read.get.ts`, `create.post.ts`, `create-untitled.post.ts`,
`rename.post.ts`, `move.post.ts`, `delete.post.ts`, `upload.post.ts`, and the
identity-bound `upload.delete.ts`. Upload routes delegate all authority,
classification, collision, persistence, and deletion decisions to `UploadIntake`.
Composer reference removal never calls the separate upload-delete route.

Metadata browsing uses the sibling catalog routes: complete compact snapshot,
whole-commit changes, direct children, and stable-ID/canonical-URI lookup. Every
single-source command is owned by `ContextFS`; whole-tree commands are owned by
`ContextTreeMover`. Lazy source resolution and stores only join that ambient
Drizzle transaction, and typed failures roll it back; content-only
Yjs/projection changes do not publish.
Catalog files preserve persisted tracked or binary classification. The context
domain emits best-effort truth-free wake hints after commit through the existing
authenticated thread socket; focus and bounded polling repair dropped hints.
Routes authenticate and translate transport only; catalog transaction and replay
policy live in the context domain.

Internal document links resolve through the same domain at
`POST /api/projects/[projectId]/links/resolve`. The route accepts a discriminated
wikilink, scheme, or relative target and returns `{ document: null }` for both
misses and ambiguity.
