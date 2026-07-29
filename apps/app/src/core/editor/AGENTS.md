# core/editor — Collaborative editor runtime

This directory owns the browser-side TipTap schema, Yjs document sessions, and
editor-only projections. It is the app boundary for collaborative manuscript
editing; it does not own server persistence or trail authority.

## Mental model

One collaborative editor binds to one shared Yjs document fragment through the
`DocumentSessionRegistry`. Live peer marks are ephemeral projections of durable
change-trail events, not manuscript content.

## Key rules

- Assemble collaborative extensions only through `createEditorExtensions()` and
  keep the app schema aligned with `@meridian/prosemirror-schema`.
- Keep a single Yjs fragment and sync path per editor, and let
  `mounted-editor.ts` be the only thing that can end an editor's life: a
  rebuild destroys the Yjs UndoManager and drops keystrokes in flight.
  `EditorMountIdentity` carries every construction fact, `editorMountKey()`
  turns it into the React key that owns the mount, and `useMountedEditor()`
  constructs and destroys TipTap itself so the schema-repair witness can
  synchronously bracket every extension lifecycle mutation. Anything a caller
  can change while the writer keeps typing is `EditorSurfaceOptions` and
  reaches the running instance; projection data arrives through stores the
  extensions subscribe to (`SessionMarkerStore`, `AgentNameStore`). A new
  construction knob belongs in the identity type — never in an effect
  dependency list.
- Schema repair is observed and reported, never fenced. Keep the pre-bind
  snapshot, single update listener, and atomic open-to-live phase transition
  together in `schema-repair-witness.ts`; do not add a second listener or move
  construction back behind TipTap's deferred `useEditor` lifecycle. Its live
  correlation resolves each delete-only candidate independently within a Yjs
  transaction batch; the batch bounds candidate lifetime, not a batch-wide
  verdict. Ordinary writer transactions must remain zero-verdict. A repair
  coalesced into a mixed delete-and-insert transaction is intentionally not
  classified, so do not weaken the delete-only gate without a sound attribution
  design.
- An image's `src` is a stable `asset:<documentId>`, never the signed URL the
  upload just returned. Node views resolve a short-lived read URL at render
  time; storing one puts an expiring value into the shared document.
- Do not persist, branch-project, or locally author peer marks. Resolve
  awareness cursor colors to concrete RGB before publication.
- Markdown autoformat is mostly inherited: TipTap's own input rules already
  resolve the parity schema and already refuse to run inside code. Check
  whether a trigger is already firing before writing a rule for it, because a
  second rule races the first. `MarkdownAutoformatExtension` owns the
  exceptions and its test is the truth table for the whole surface.

- Control-surface policy is the chrome kernel's, not an extension's private
  habit. `ChromeKernelExtension` owns the Esc chain, the right-click claim
  table, deepest-context resolution, and gesture suppression; object physics
  reads one registration table for what a selectable object is. An extension
  that wants a key, a menu, or a dismissal registers with the kernel rather
  than binding it. See [`chrome/AGENTS.md`](chrome/AGENTS.md) and
  [`objects/AGENTS.md`](objects/AGENTS.md).

- What an href means is `links/`, once. A link is four kinds — wikilink,
  scheme, relative, external — and every consumer (the click, the hover hint,
  the menu, the mark's own rendering, the paste sanitizer) reads the same
  classifier. TipTap's link extension does not know the internal family and
  must be configured against ours.

- **A surface that outlives a keystroke cannot hold raw positions.** Every
  remote change rebuilds the whole document, so ProseMirror's mapping reports
  every position deleted whatever actually happened, and Yjs relative positions
  are what survive it. [`anchors.ts`](anchors.ts) is the one mechanism: hold an
  `EditorAnchor`, never a number, and never a second copy of the machinery. The
  contract and the three rules that come with it are in
  [`.context/CONTEXT.md`](.context/CONTEXT.md).

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for session, peer-mark, draft-review,
and navigation contracts.

→ [`chrome/AGENTS.md`](chrome/AGENTS.md) — the headless chrome kernel
→ [`extensions/slash/AGENTS.md`](extensions/slash/AGENTS.md) — the `/` trigger
→ [`objects/AGENTS.md`](objects/AGENTS.md) — object physics
→ [`blocks/AGENTS.md`](blocks/AGENTS.md) — what the document knows about a block drag
→ [`links/AGENTS.md`](links/AGENTS.md) — the link system
