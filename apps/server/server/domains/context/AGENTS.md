# domains/context — context filesystem

This domain exposes agent-readable and writable content through context URIs.
It owns URI routing, source/document location, catalog views, arrivals, and
the storage seam; file access remains the responsibility of [file policy](../file-policy/.context/CONTEXT.md).

## Mental model

- `manuscript://`, `kb://`, and `unfiled://` are project content; `user://` is
  personal content. A named Work owns `scratch://@slug/`. A chat owns its
  uploads at `uploads://@/c12/`, where bare `uploads://name` is the asking
  chat's and a subagent uses its top chat's. A fork or handoff owns its own;
  the Work and No Work own none.
- A No Work chat lineage owns `scratch://@/c12/`. The locked No Work row owns no
  Scratch source. `scratchOwnerFor(thread, work)` is the single owner rule for
  bare Scratch and file policy.
- `skills://` is model-only skill loading, not a context scheme. All callers
  resolve through the unified `ContextPort` for the thread.
- Work URI authorities use the persisted opaque slug. Membership selects a
  thread's primary Work but does not grant context access.

## Rules that change behavior

- Routes and tools ask file policy before calling this domain. Storage
  transactions begin with `lockSeamWorks`, then namespace/source locks; lifecycle
  loss is reported as `context_unavailable`.
- Capabilities are declared in `ports/context-adapter.ts`. Uploads authority stays
  separate from `UploadIntake`; uploads are flat while Scratch accepts nested
  intake paths.
- Text creation and writes resolve filetype and use the collab document engine;
  never seed a Y.Doc with an assumed Markdown schema.
- A move writes no document content. Stable links re-spell on read, and every
  arrival settles ahead refs once against its final tree.
- The catalog and ContextFS use the same tree view. Draft-hidden rows never
  escape that view; Apply and Discard reconcile tree changes inside their own
  completion transactions.
- Lineage hiding is reversible authority loss, not document deletion. Folder
  deletes validate the supplied folder identity before recursive mutation.

See [context contracts](.context/CONTEXT.md), [tree visibility](tree/AGENTS.md),
[upload intake](uploads/.context/CONTEXT.md), and [collab codecs](../collab/AGENTS.md).
Deferred work is in [.context/FUTURE.md](.context/FUTURE.md).
