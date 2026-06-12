# collab — document spine

DocumentSyncService is the live document spine: the Yjs CRDT substrate plus the
markdown bijection that every Meridian rich document round-trips through.

## Canonical-representation invariant

Two representations, two different jobs — not competing sources of truth:

- **Markdown is the canonical *semantic* representation.** It is the meaning of
  the document and the interchange format LLMs and humans read. Every editor
  construct MUST round-trip losslessly to readable markdown.
- **Yjs is the canonical *runtime/merge* representation.** It is the CRDT
  substrate that merges concurrent edits without conflict and carries per-edit
  provenance (origin tags in the update log). Markdown strings cannot be
  3-way-merged; Yjs is what makes concurrent agent+human editing and attribution
  possible.

The ProseMirror schema is the bijection that keeps them in sync: every Y.Doc
state has exactly one markdown rendering, and back.

### Schema rule (enforced at the adapter boundary)

No node or mark may be added to the document schema without a lossless markdown
serializer+parser pair. The structural spec lives in `@meridian/prosemirror-schema`
(specs only); the markdown syntax lives in this domain's schema adapter
(`domain/schemas.ts`). Adding a spec to the package without a serializer here is
a defect — it breaks the markdown-native guarantee.

### What lives where

| Concern | Representation |
|---|---|
| Text, headings, styling, figures, math, tables | ProseMirror nodes/marks → markdown |
| *Who* edited each span, and *when* | Yjs update-log origin tags (provenance metadata; not in the markdown body) |

## Transport — custom Yjs WS, not Hocuspocus

`DocumentSyncService` owns the live `Y.Doc` (cache, fragment cache, per-doc
`chainLock`) and the durable append-only update log with origin/attribution. The
WebSocket bridge is a thin composition-layer handler (`apps/server/server/lib/`
`ws-yjs-handler.ts`, on `y-protocols` sync + awareness) that depends only on the
injected `DocumentSyncTransport` port — not on domain internals. We deliberately
did **not** adopt Hocuspocus, because it wants to own the `Y.Doc` lifecycle we
already own and its `extension-database` cannot produce our per-update,
attributed append-only log. Full rationale (source-verified against Hocuspocus
v4.1.0) lives in the decision record — do not re-litigate without reading it:

→ [Custom Yjs document-collaboration transport (not Hocuspocus)](https://github.com/meridian-bio/docs/blob/main/kb/decisions/yjs-document-collab-transport.md)

## Deferred (post-v1) — explicit non-goals

Recorded so they are not built in a way that violates the invariant above:

- **Comments & suggestions as first-class annotations.** When built, their
  *content* must be markdown-representable (e.g. a MyST directive or
  CriticMarkup-style inline markup) so an LLM reading the doc sees them; Yjs
  tracks authorship and accept/reject.
- **Per-annotation visibility scoping** (agent-visible / human-only /
  agent-editable). This means the agent-facing markdown becomes a *filtered
  projection* of the full document, not the raw doc. The read seam
  (`readAsMarkdown` / `ContextPort.read`) takes no audience parameter today;
  adding `{ audience }` later is a purely additive change. Design from
  "it's a filtered projection," not a single global markdown string.
