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
| Which upload owns which slot, progress, failure, the bytes, the abort | the ingress plugin's state (`image-ingress-runtime.ts`) | Position must survive a peer's write; a percent must never reach the wire |
| A drag in the air, a refusal | `image-ingress-store.ts` | Neither produced a document change, and law 5 still wants the reason in view |

The app's half is `features/editor/surfaces/images/` — it registers the two
ports (upload, fetch-bytes) and feeds the asset index. Until a host registers,
every door refuses out loud rather than opening onto nothing.

## Layout

| File | What it owns |
|---|---|
| `ImageIngressExtension.ts` | The wiring: storage, the plugin, the drop and clipboard props, decorations |
| `image-ingress-runtime.ts` | The editor's record of what is in flight, and the one way to write to it |
| `image-uploads.ts` | A picture from this machine: picker, insert, Replace, upload, land, Retry, Remove |
| `image-imports.ts` | A picture the clipboard pointed at: fetch, upload, replace the link |
| `pending-images.ts` | What the document knows about a picture in flight, and how it is drawn |
| `image-workflow.ts` | Pure answers: what a drop means, what a paste carries, asset paths |
| `ImageNodeView.tsx` | An inline picture at every point in its life |
| `measure-image.ts` | The picture's own size, read from the local file |

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
- **A pending picture is held the way every long-lived surface here holds its
  target**: a `NodeHold` from `anchors.ts` (the anchor for where, the Yjs element
  for which). A remote write replaces the whole document, so a number points at
  nothing and a deleted picture's anchor resolves to the seam it left behind. An
  import is the exception the hold itself names: it holds a range of TEXT, so it
  reads its own link back the way a link range does.
- **Losing the slot cancels the upload.** Deleting the node, or undoing its
  insert, orphans the entry; the sweep aborts the request. Nothing is written
  into a slot the writer took back.
- **A slot the writer cannot recover offers Remove, never Retry.** A reload or a
  redo can leave an empty-src node whose bytes were this browser's and are gone.
  A Retry there would be a dead control.
- **One entry per upload.** Two pictures arriving together are two lifecycles.
  Nothing about one upload gates another, which is why the toolbar's image
  control has no busy state.
- **Replace is an upload aimed at a slot that already exists.** The object
  surface's Replace verb (§5.6) starts the ordinary lifecycle on the node the
  writer is pointing at, so nothing is inserted or removed, the alt text and a
  figure's caption and label survive, and undo takes the whole replacement back
  in one step. It works for the `figure` node for the same reason: the landing
  writes `src` on whatever node the hold resolves to.

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
