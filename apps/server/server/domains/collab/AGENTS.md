# domains/collab

Live document spine: Yjs CRDT substrate + markdown/MDX bijection. Every
Meridian Flow rich document round-trips through this.

Two representations, two jobs — not competing sources of truth:
- **Markdown/MDX** — canonical semantic representation. What LLMs and humans read.
- **Yjs** — canonical runtime/merge representation. CRDTs for concurrent edits
  and per-edit provenance.

The ProseMirror schema (`@meridian/prosemirror-schema`) is the bijection. Server
and frontend must build **structurally identical** schemas or y-prosemirror
corrupts the CRDT — guarded by `schema-parity.test.ts`.

No node or mark may be added without a lossless serializer+parser pair in
`domain/schemas.ts`.

Transport is Hocuspocus v4 (`domain/hocuspocus-collab-adapter.ts`).

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for contracts and invariants.
