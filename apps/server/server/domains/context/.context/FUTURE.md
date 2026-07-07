# domains/context — deferred / future work

Durable scope this domain will grow into but hasn't yet. Each entry points to a
tracking issue; details live there, not here. Delete an entry when it ships.

## Manuscript ordering & agent reorder tool

[haowjy/meridian-flow#144](https://github.com/haowjy/meridian-flow/issues/144)

Delete + rename shipped (PR #145): `rename.post.ts`, `delete.post.ts` routes,
client mutation hooks, desktop context menu + kebab, mobile trailing action
button. All context routes share `_helpers.ts` (resolveContextRoute,
sanitizePath, contextErrorToHttp). Inline name forms share `useInlineNameForm`.

Remaining from #144 — **manuscript ordering + drag-reorder:**

Sibling order is derived (`tree.get.ts` `sortTree` → dirs-first,
`name.localeCompare`); `folders.sort_order` exists in schema but is unwired,
and `documents` has no order column. Manual order decouples order from
filename → explicit order field on `documents`, serializer sorts by order, a
reorder port method + route, and an **agent reorder/move tool** (the AI
co-authors the manuscript, so create/move become order-aware). Resolve the
design question first — Scrivener-style explicit binder order for manuscript,
and how the agent participates — via design-lead → tech-lead.
