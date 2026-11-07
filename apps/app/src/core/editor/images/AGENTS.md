# core/editor/images — image ingress and document lifecycle

This directory owns picker, drop, paste-import, pending uploads, node-view
rendering, and resize behavior. Project asset storage, signed URLs, and image
surface registration are adapters outside this directory.

## Mental model

An image is inserted in its final document slot before bytes upload. The node's
`uploadToken` and stable `src` travel with the document; progress, bytes, abort,
and failure live in plugin state. Awareness reports only live upload ownership
and measured shape. A moved slot remains the same upload; a deleted or undone
slot aborts it.

## Rules

- Stored `src` is `asset:<documentId>`, a document address, or `""` for a
  pending slot. Never store signed, blob, or data URLs. Renderers resolve
  short-lived URLs at render time and classify failures through the render
  policy.
- Announce the upload entry before inserting its tokened node. Completion
  updates the same node. Insert completion clears token and writes source out of
  history so undo removes the insertion; replace clears token out of history,
  then commits source and alt as one historical edit.
- The picker accepts only an `EditorAnchor` insert target or `NodeHold` replace
  target. Resolve and schema-check it when the file returns; never fall back to
  the current selection or another location.
- `width` is the sole persistent display-size answer, capped by the prose
  column. Resize previews write DOM only and release one `setNodeMarkup` using a
  `NodeHold`; a drag that changes nothing on screen writes nothing, and a grip
  stops at the height cap. A table-cell paragraph needs size containment before
  the picture can be capped by its column.
- A very tall picture pushes the writer's text out of view, so the view caps
  every picture at about 60% of the pane (`--meridian-picture-cap`), ratio kept.
  The cap depends on the viewer's pane and the stored picture doesn't, so it is
  never written: not to `width`, not to the wire, not to export or copied
  Markdown. Clicking a picture the cap is holding back opens the viewer, and the
  object row's Open full screen does the same. Because the box has to narrow to
  keep the ratio, the node view needs the shape: an upload's frame, or the
  natural size once the picture draws.
- Inline images use the same baseline/line-box behavior in prose and cells.
  Measured upload frames reserve intrinsic size; failed or abandoned slots
  return to the fallback frame.
- Selected state comes from object-selection decoration, not a node-view
  lifecycle prop. A picture drop lands where `landing/` says, and a structural drop never
  manufactures a table column.
- A picture is one object at one size wherever it stands, as in Docs or Word.
  A big picture mid-sentence makes a tall line, up to the height cap above. Never
  reintroduce a mid-sentence-only decoration, class, or cap.
- An empty-`src` slot with no live owner (a reload or redo left it) offers
  Remove, never Retry; a token with a live owner is a collaborator's upload and
  never offers Remove. An unresolved stored source draws unavailable without
  Retry, and a 404 from the signed-URL route draws gone.
- Use the session presence port for upload ownership. Do not write raw
  Awareness, progress, filenames, or byte counts to the wire.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — lifecycle, ports, resize, and
  paste-import contracts
→ [`../AGENTS.md`](../AGENTS.md) — editor anchors and session boundary
→ [`../../../features/editor/surfaces/images/AGENTS.md`](../../../features/editor/surfaces/images/AGENTS.md) — host adapters
