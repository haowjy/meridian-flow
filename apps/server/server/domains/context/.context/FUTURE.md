# domains/context — deferred / future work

Optional local improvements and future domain scope. Cross-cutting entries link
to tracking issues. Delete an entry when it ships.

## Manuscript ordering & agent reorder tool

[haowjy/meridian-flow#144](https://github.com/haowjy/meridian-flow/issues/144)

Delete + rename shipped (PR #145): `rename.post.ts`, `delete.post.ts` routes,
client mutation hooks, desktop context menu + kebab, mobile trailing action
button. All context routes share `_helpers.ts` (resolveContextRoute,
sanitizePath, contextErrorToHttp). Inline name forms share `useInlineNameForm`.

Remaining from #144 — **manuscript ordering + drag-reorder:**

Sibling order is derived by the catalog projection (dirs-first, then
`name.localeCompare`); `folders.sort_order` exists in schema but is unwired,
and `documents` has no order column. Manual order decouples order from
filename → explicit order field on `documents`, serializer sorts by order, a
reorder port method + route, and an **agent reorder/move tool** (the AI
co-authors the manuscript, so create/move become order-aware). Resolve the
design question first — Scrivener-style explicit binder order for manuscript,
and how the agent participates — via design-lead → tech-lead.

## Batch revision availability lookups

`document-revisions.ts` `current` calls `availability.lookup` once per
document, though the port accepts a `documentIds` batch. Compaction calls it
twice (before the summary and once per successor-prepare attempt) over every
document recorded in the history it checks. Unmeasured; batch it if those
round trips show in compaction latency.
