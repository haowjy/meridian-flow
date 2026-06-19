# collab — document spine

DocumentSyncService is the live document spine: the Yjs CRDT substrate plus the
markdown bijection that every Meridian Flow rich document round-trips through.

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

## Transport — Hocuspocus v4

Hocuspocus v4 owns the Y.Doc lifecycle and WebSocket transport
(`domain/hocuspocus-collab-adapter.ts`). The adapter bridges Hocuspocus hooks
to the domain's durable update log, checkpoint store, and markdown projection.
Client connects via `HocuspocusProvider` with a shared
`HocuspocusProviderWebsocket` singleton.

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
