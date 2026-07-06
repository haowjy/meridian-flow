# domains/context — deferred / future work

Durable scope this domain will grow into but hasn't yet. Each entry points to a
tracking issue; details live there, not here. Delete an entry when it ships.

## Tree file-ops: delete/rename surface + manuscript ordering & agent reorder tool

[haowjy/meridian-flow#144](https://github.com/haowjy/meridian-flow/issues/144)

The tree is **read + create only** from the app. Sibling order is derived
(`tree.get.ts` `sortTree` → dirs-first, `name.localeCompare`); `folders.sort_order`
exists in schema but is unwired, and `documents` has no order column.

Two tiers:

- **Delete + rename (small):** `move`/`delete` domain primitives already exist
  with CAS (`context-tree-mover.ts`, `ContextTreeMutationStore`) — the gap is HTTP
  routes + frontend hooks. No schema change.
- **Manuscript ordering + drag-reorder (real slice):** manual order decouples
  order from filename → explicit order field on `documents`, serializer sorts by
  order, a reorder port method + route, and an **agent reorder/move tool** (the AI
  co-authors the manuscript, so create/move become order-aware). Resolve the
  design question first — Scrivener-style explicit binder order for manuscript, and
  how the agent participates — via design-lead → tech-lead.

Surfaced by the writer-ux context file-tree redesign; interaction spec lives in
that work's `file-tree-mock.html`.
