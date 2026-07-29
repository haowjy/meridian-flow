# core/editor/images — how a picture gets into a document, and what it looks like on the way

This directory owns image ingress end to end: the picker, the drop, the pasted
file, the pasted address, the asset index the clipboard translates through, and
the pending lifecycle the writer sees. It does not own project asset storage,
the figure endpoint, or signed-URL rendering policy (`asset-image-render-state.ts`).

## Mental model

**A picture in flight is a document node, not a status report.** The `image`
node is inserted in its final slot before any byte leaves; the upload then
updates that node in place. So the writer can move it, delete it, type around it
and undo it exactly as they would any other node, and the manuscript does not
reflow when the bytes land.

Three homes, and nothing lives in two of them:

| Fact | Home | Why |
|---|---|---|
| The slot, its `alt`, its final `src` | the document | It is content, and peers must see it |
| Which upload owns which slot, progress, failure, the bytes, the abort | `ImageIngressExtension`'s plugin state | Position must survive a peer's write; a percent must never reach the wire |
| A drag in the air, a refusal | `image-ingress-store.ts` | Neither produced a document change, and law 5 still wants the reason in view |

The app's half is `features/editor/surfaces/images/` — it registers the two
ports (upload, fetch-bytes) and feeds the asset index. Until a host registers,
every door refuses out loud rather than opening onto nothing.

## Key rules

- **A pending node's `src` is `""`.** It is the schema's own default and the one
  source that names nothing, so a document synced or saved mid-upload
  round-trips as `![alt]()` (pinned in `packages/markup`'s codec test). Never
  mint an `asset:` ref before the asset exists: `pathForAsset` throws for an id
  the project does not know and takes the whole document's serialization with
  it. Never write a `blob:` or `data:` src either, for the reason the paste
  never writes a web address.
- **Progress is a decoration, never an attribute.** An attribute would put every
  percent in Yjs, on the wire, and in every peer's undo history. The decoration's
  attributes double as the node view's repaint signal, which is why
  `MeridianImage`'s node view passes an explicit `update` — a picture in flight
  never changes its node.
- **Identity is an `EditorAnchor` plus a read-back.** A remote write replaces the
  whole document; a number would point at nothing, and a deleted picture's anchor
  resolves to the seam it left behind. Every read checks the node it lands on is
  still a pending image (`resolvePendingImage`).
- **Losing the slot cancels the upload.** Deleting the node, or undoing its
  insert, orphans the entry; the sweep aborts the request. Nothing is written
  into a slot the writer took back.
- **A slot the writer cannot recover offers Remove, never Retry.** A reload or a
  redo can leave an empty-src node whose bytes were this browser's and are gone.
  A Retry there would be a dead control.
- **One entry per upload.** Two pictures arriving together are two lifecycles.
  Nothing about one upload gates another, which is why the toolbar's image
  control has no busy state.

## Anti-patterns

- A shell-level upload status, progress ref, or completion timer. That was the
  condemned shape: a single scalar beside the manuscript, synchronized to an
  insertion that had not happened yet.
- Awaiting an upload before inserting anything.
- A second asset index. One per mounted editor lives in this extension's
  storage, because a project-relative path only means something inside one
  project's namespace.
- Turning a refused paste-import into a document write. The link the paste
  landed is already the honest answer.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — the lifecycle in detail, the
  ports, and the paste-import seam
→ [`../AGENTS.md`](../AGENTS.md) — the editor runtime this mounts inside
→ [`../../../features/editor/surfaces/images/AGENTS.md`](../../../features/editor/surfaces/images/AGENTS.md)
  — the app's half
→ design of record: `editor-toolbar-split/interaction-model.md` §5.6, mockup 10
