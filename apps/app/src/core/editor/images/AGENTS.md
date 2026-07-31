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
| Whether this client is on the wire at all | the session's presence port (`../local-presence.ts`) | Inline review and a schema fence hide the writer, and a publisher cannot know it is hidden |
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
| `image-drag-preview.ts` | The ghost a picture drags with |
| `measure-image.ts` | The picture's own size, read from the local file |
| `image-resize.ts` | How big the writer wants it: the drag's arithmetic, and the one transaction |
| `ImageResizeHandles.tsx` | The four grips a selected picture wears |

## Key rules

- **A picture is a big glyph, and inline means what Docs and Word mean.** Its
  bottom sits on the text baseline, so the words before it and after it stand at
  its foot, the line box grows as tall as the picture, and what follows wraps
  onto the line below (human ruling, 2026-07-30, against a capped picture with
  the words floating at its mid-height). There is ONE reading of a picture: the
  same object at the same size mid-sentence or alone in its paragraph, with the
  prose column as its only bound. A big picture in a sentence makes a tall line,
  and that is the right answer rather than a bug to cap. The document always
  said this much: a drop has always landed the node between two text nodes of
  one paragraph and the wire has always carried `text ![alt](p) text`. How a
  picture is PLACED is therefore the CSS in
  [`../../../features/editor/editor.css`](../../../features/editor/editor.css)
  and nothing else, and that CSS holds one fact worth knowing before touching
  it: baseline alignment goes on TipTap's own inline wrapper, the box the line
  box is built out of, and everything inside that wrapper is block-level so its
  baseline falls back to the bottom margin edge instead of a line box that would
  hang the font's descender under the picture.
- **How big a picture is has ONE answer, and the document holds it.** `width`
  is the number of CSS pixels the writer dragged to, or null for the file's own
  size; the prose column caps both alike (human ruling, 2026-07-30: the Docs
  model). Null is the state nearly every picture is in and the state whose wire
  form stays plain `![alt](src)`, so the escalation to `<img … width>` is paid
  for only by pictures that were actually resized (`packages/markup`). This is
  what makes the Docs look reachable rather than absent: a picture as wide as
  the column fills the line it stands in by definition, and dragging it smaller
  is how words come to stand beside it.
- **A cell has to be GIVEN a width before it can cap a picture.** The prose
  column caps by `max-width: 100%`, which needs a box that was decided without
  the picture. A table cell is not one: auto layout sizes columns from what is
  inside them and drops percentages while it does, so the column becomes as wide
  as the picture's own pixels and the cap resolves against the damage. The fence
  is size containment on the cell's paragraph
  ([`../../../features/editor/editor.css`](../../../features/editor/editor.css)):
  that line is measured as if it were empty and asks the table for one definite
  8rem, so the column is settled first and the picture fills it. Never answer
  this with hidden overflow, and never fence a cell that holds no picture — the
  table's columns are its prose's to size.
- **The drag is geometry; only the release is an edit.** Each frame writes a
  width onto the picture's own element, which the writer sees and no peer does,
  and the release dispatches one `setNodeMarkup` carrying every other attribute
  through, `uploadToken` included. A per-frame dispatch would put the whole
  gesture on the wire, in every peer's repaint, and in the undo stack a hundred
  times over. The target is a `NodeHold`, because a peer or an AI write can move
  the picture between the press and the release
  ([`image-resize.ts`](image-resize.ts)).
- **A resize stops at the narrowest box between the picture and the manuscript**,
  not at the nearest block. A block can be wider than what the writer can see of
  it — a cell inside the table's horizontal scroller — and a ceiling read from
  the block alone let a drag put the far grips where no pointer could reach them.
- **The grips are inside the node view**, which is what
  `features/editor/chrome/object-overlay.ts` already calls the default for an
  object that owns its DOM: chrome rendered in the element it decorates rides
  scroll and reflow with the manuscript, so there is no rect to re-measure and
  no way to strand a grip beside the paragraph that took the picture's place.
  Never measure them onto the viewport.
- **Selected-ness reaches the node view as a decoration**, never as TipTap's
  `selected` prop: that prop comes from `selectNode`, which a peer's
  whole-document rebuild does not call, and the jade ring learned that the hard
  way ([`../objects/AGENTS.md`](../objects/AGENTS.md)). `MeridianImage`'s node
  view repaints on that decoration for the same reason it repaints on the
  pending one.
- **A measured frame is the measured box, at any size.** The slot an upload
  reserves is the file's own width and ratio, so a 32px icon reserves 32px and
  the landing moves nothing. The placeholder's readable minimums are the
  UNMEASURED fallback and never a floor under a measured frame — that was the
  shipped bug: a 32px icon reserving 128x72 and collapsing when the bytes
  arrived. A frame too small for the placeholder to speak in drops its name
  rather than growing, and a slot that is asking something instead of waiting
  (failed, abandoned, an address that would not resolve) gives the frame back.
- **A picture names its own drag preview, from `window`.** Left alone, a big
  picture drags a ghost the size of the whole picture and the writer cannot see
  what they are aiming at (human ruling, 2026-07-30: keep the drag, lose the
  ghost). `image-drag-preview.ts` names one capped at 240px on its long edge —
  and it listens on `window`, not on the editor's DOM, because TipTap's node view
  sets a drag image of its own from a React handler and React dispatches that at
  its root container. Above the root is the only place later in the same event,
  and the last `setDragImage` is the one the browser paints. Where the drag starts
  is not fixed either: from the node view's outer element for an unselected
  picture, from the `<img>` inside it for a selected one, so the target is read
  both ways up.
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
- **The picker aims at a HELD target, never at a number.** The writer is in
  front of an operating-system dialog while peers and AI writes move the
  document, so a position taken before the dialog opened means something else by
  the time a file comes back. `openImagePicker` therefore takes one
  `ImagePickerTarget` and nothing else: an `EditorAnchor` for a new picture
  (`imageCaretTarget`, or the anchor the slash lane pins where its trigger text
  was), a `NodeHold` for §5.6's Replace (`imageReplaceTarget`). Each is resolved
  when the file arrives and read back before anything is opened — the place
  through `acceptsInlineImage`, the node through `objectSurfaceKind` — and a
  target that is gone refuses out loud, with no entry opened and no asset
  uploaded. Nothing falls back to the selection or hunts for another home: a
  picture that appeared past the table the writer asked from is what this
  contract exists to prevent. Replace then runs the ordinary lifecycle on the
  node that was already there, so nothing is inserted or removed and the alt
  text and a figure's caption and label survive; it works for `figure` for the
  same reason, since the landing writes `src` on whatever node the hold
  resolves to.
- **What one undo takes back depends on how the slot was opened.** The entry
  carries it (`landing`). An INSERT's landing stays out of history, because the
  insert already IS the writer's event and undo should take the picture away
  rather than empty its frame. A REPLACE's landing is the event — old picture to
  new — so it commits `src`/`alt` in one historical transaction after clearing
  the token outside history. Never make every landing nonhistorical again: that
  is the shape that promised one-step undo and delivered none.

## Anti-patterns

- A shell-level upload status, progress ref, or completion timer. That was the
  condemned shape: a single scalar beside the manuscript, synchronized to an
  insertion that had not happened yet.
- Awaiting an upload before inserting anything.
- A second asset index. One per mounted editor lives in this extension's
  storage, because a project-relative path only means something inside one
  project's namespace.
- A local awareness field written straight onto `Awareness`. The write is a
  silent no-op whenever presence is suspended, and this lane learned that the
  hard way: the port is the only door (`../local-presence.ts`).
- A percent, a filename, or a byte count on the ephemeral channel. Awareness
  carries a token and the picture's measured shape: the fact that an upload is
  live, and the box a peer must reserve so completion moves nothing for them
  either. Nothing a peer could not act on.
- Reading an empty `src` as failure. Without a token, or without an owner for it,
  it is recoverable; with a live owner it is somebody's upload.
- Turning a refused paste-import into a document write. The link the paste
  landed is already the honest answer.
- A second reading of how big a picture is. There is one: the `width`
  attribute, or the file's own size when it is null, capped by the prose column
  either way. The condemned shape was a decoration plugin, a class, a 15rem cap,
  and a scaled upload frame, all so a picture mid-sentence could be a different
  object than the same picture alone.
- Dispatching from inside the resize drag. One gesture is one event.
- A size in local state, a ref, or a CSS variable the wire never learns about. A
  size only one writer can see is a size their collaborator's screen disagrees
  with, and the manuscript is what both of them are reading.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — the lifecycle in detail, the
  ports, and the paste-import seam
→ [`../AGENTS.md`](../AGENTS.md) — the editor runtime this mounts inside
→ [`../../../features/editor/surfaces/images/AGENTS.md`](../../../features/editor/surfaces/images/AGENTS.md)
  — the app's half
→ design of record: `editor-toolbar-split/interaction-model.md` §5.6, mockup 10
