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

**A slot in flight says so in the document, and who is filling it is
ephemeral.** The slot carries an `uploadToken` attribute; awareness carries the
tokens each client is currently filling. Joining those two is what lets a
collaborator draw "uploading elsewhere" instead of "abandoned", and it is why a
move no longer kills an upload.

Four homes, and nothing lives in two of them:

| Fact | Home | Why |
|---|---|---|
| The slot, its `alt`, its final `src` | the document | It is content, and peers must see it |
| That this slot is being filled (`uploadToken`) | the document, as a node attribute | A move must copy it and a peer must read it; nothing else can do both |
| Which upload is MINE, progress, failure, the bytes, the abort | the ingress plugin's state (`image-ingress-runtime.ts`) | Keyed by the same token; a percent must never reach the wire |
| Which slots are being filled ELSEWHERE, and their shape | awareness (`image-upload-presence.ts`), projected into plugin state | It stops being true when a tab closes, and a document fact would outlive its own truth |
| A drag in the air, a refusal | `image-ingress-store.ts` | Neither produced a document change, and law 5 still wants the reason in view |

The app's half is `features/editor/surfaces/images/` — it registers the two
ports (upload, fetch-bytes) and feeds the asset index. Until a host registers,
every door refuses out loud rather than opening onto nothing.

## Layout

| File | What it owns |
|---|---|
| `ImageIngressExtension.ts` | The wiring: storage, the plugin, the drop and clipboard props, decorations |
| `image-ingress-runtime.ts` | The editor's record of what is in flight, and the one way to write to it |
| `image-upload-presence.ts` | The ephemeral half: this client's tokens out, every other client's in |
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
- **A pending picture is found by its token, never by a hold.** `NodeHold` says
  a Yjs move is a new identity and a held gesture must stop referring to it
  (`anchors.ts`) — correct for a surface aimed at a node, wrong for a slot the
  design promises the writer may move mid-upload. So an upload's identity is the
  `uploadToken` on its node, and the entry is keyed by the same string. An import
  is the exception: its placeholder is a range of TEXT with no attribute to carry,
  so it keeps an `EditorAnchor` and reads its own link back the way a link does.
- **Announce the owner before the slot.** `insertImageFile` opens the entry (and
  with it the awareness field) and only then inserts the node. Awareness leaves on
  the announcement's dispatch, the document update on the insert's, so no peer can
  ever see a token'd slot before it knows who owns it.
- **Losing the slot cancels the upload.** Deleting the node, or undoing its
  insert, leaves no node carrying the token; the sweep aborts the request. A MOVE
  is not losing the slot, which is the whole point of the token. Nothing is
  written into a slot the writer took back.
- **A slot the writer cannot recover offers Remove, never Retry.** A reload or a
  redo can leave an empty-src node whose bytes were one browser's and are gone. A
  Retry there would be a dead control. This is the ONLY empty-src reading that may
  offer Remove: a token with a live owner is somebody's upload in progress, and a
  peer that offered Remove there would cancel a collaborator's picture.
- **Closing the editor closes the uploads.** `onDestroy` aborts every entry and
  the presence plugin releases the owner field. A request that outlived its editor
  would finish into nothing and leave a project asset no document mentions.
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
- A percent, a filename, or a byte count on the ephemeral channel. Awareness
  carries a token and the picture's measured shape: the fact that an upload is
  live, and the box a peer must reserve so completion moves nothing for them
  either. Nothing a peer could not act on.
- Reading an empty `src` as failure. Without a token, or without an owner for it,
  it is recoverable; with a live owner it is somebody's upload.
- Turning a refused paste-import into a document write. The link the paste
  landed is already the honest answer.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — the lifecycle in detail, the
  ports, and the paste-import seam
→ [`../AGENTS.md`](../AGENTS.md) — the editor runtime this mounts inside
→ [`../../../features/editor/surfaces/images/AGENTS.md`](../../../features/editor/surfaces/images/AGENTS.md)
  — the app's half
→ design of record: `editor-toolbar-split/interaction-model.md` §5.6, mockup 10
