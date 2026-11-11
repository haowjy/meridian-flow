# core/editor/images — image ingress and document lifecycle

Picker, drop, paste-import, pending uploads, node-view rendering and resize. Asset
storage, signed URLs and image surface registration are adapters outside this
directory ([host adapters](../../../features/editor/surfaces/images/AGENTS.md)).

An image is inserted in its final document slot before bytes upload. The node's
`uploadToken` and stable `src` travel with the document; progress, bytes, abort and
failure live in plugin state. A moved slot is the same upload; a deleted or undone
slot aborts it.

- Stored `src` is `asset:<documentId>`, a document address, or `""` for a pending
  slot. Never store signed, blob or data URLs; renderers resolve short-lived URLs at
  render time.
- Announce the upload entry before inserting its tokened node. Insert completion
  clears the token and writes `src` out of history, so undo removes the insertion;
  replace clears the token out of history, then commits `src` and alt as one
  historical edit.
- The picker accepts only an `EditorAnchor` insert target or `NodeHold` replace
  target. Resolve and schema-check it when the file returns; never fall back to the
  current selection.
- `width` is the only persistent display size, capped by the prose column. Resize
  previews write DOM only and release one attribute step using a `NodeHold`
  (`setNodeMarkup` replaces a leaf and drops the selection).
- The view caps every picture at about 60% of the pane (`--meridian-picture-cap`).
  The cap depends on the viewer's pane and the stored picture doesn't, so it is never
  written: not to `width`, the wire, export or copied Markdown.
- A picture is one object at one size wherever it stands, as in Docs or Word. Never
  reintroduce a mid-sentence-only decoration, class or cap.
- Selected state comes from object-selection decoration, not a node-view lifecycle
  prop.
- An empty-`src` slot with no live owner (a reload or redo left it) offers Remove,
  never Retry; a token with a live owner is a collaborator's upload and never offers
  Remove.
- Report upload ownership through the session presence port. Never write raw
  Awareness, progress, filenames or byte counts to the wire.

Lifecycle, ports, resize, cap behavior and paste-import:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
