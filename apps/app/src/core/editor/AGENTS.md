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
  time; storing one puts an expiring value into the shared document. Nor an
  address from the web: a pasted `<img>` lands as a link to where it came from,
  and the import that follows replaces the link with the picture once the bytes
  belong to the project. The third source is `""` — a picture whose slot exists
  and whose bytes do not yet — and it belongs to the ingress lifecycle below.

- **A picture in flight is a document node, not a status report.** The `image`
  node stands in its final slot before a byte leaves, and the upload updates it
  in place, so the writer can move, delete, or undo it and the manuscript never
  reflows on completion. Progress, the bytes, and the abort live in
  `images/`'s plugin state keyed by an anchored hold — never in an attribute
  (the wire would carry every percent) and never in the shell (one scalar
  cannot hold two uploads, and it describes an insertion that has not
  happened). See [`images/AGENTS.md`](images/AGENTS.md).
- Do not persist, branch-project, or locally author peer marks. Resolve
  awareness cursor colors to concrete RGB before publication.
- Markdown autoformat is mostly inherited: TipTap's own input rules already
  resolve the parity schema and already refuse to run inside code. Check
  whether a trigger is already firing before writing a rule for it, because a
  second rule races the first. `MarkdownAutoformatExtension` owns the
  exceptions and its test is the truth table for the whole surface.

- **Which characters close themselves is a registration, not a keymap.**
  `extensions/auto-pair/` holds one table of `{ open, close, contexts }` rows
  and one mechanism that opens, steps over, and unpairs by reading it; a new
  pair is a one-row change. It writes real characters, so the wire never
  learns about it. Two things it deliberately does not do: pair `*`, `_`, `~`
  or the prose backtick, whose completion path is the autoformat's input
  rules, and consume a closing keystroke it is not certain it wrote. See
  [`extensions/auto-pair/AGENTS.md`](extensions/auto-pair/AGENTS.md).

- **A menu the writer types underneath is a spec, not a plugin.**
  `extensions/suggestion/` holds one mechanism that wires `@tiptap/suggestion`,
  the kernel keymap, and the catalog fence for every lane; `/` and `[[` each
  declare a spec (char, envelope predicate, matches, row projection, choice) and
  nothing else, so a third trigger is a spec rather than a third copy of the
  lifecycle. The presentation-neutral half — the open-menu store and the document
  catalog's ranking — sits in [`../completion/`](../completion/AGENTS.md) rather
  than here, because the chat composer completes references into a textarea and
  must not import the editor to do it. See
  [`extensions/suggestion/suggestion-lane.ts`](extensions/suggestion/suggestion-lane.ts).

- Control-surface policy is the chrome kernel's, not an extension's private
  habit. `ChromeKernelExtension` owns the Esc chain, the right-click claim
  table, deepest-context resolution, and gesture suppression; object physics
  reads one registration table for what a selectable object is. An extension
  that wants a key, a menu, or a dismissal registers with the kernel rather
  than binding it. See [`chrome/AGENTS.md`](chrome/AGENTS.md) and
  [`objects/AGENTS.md`](objects/AGENTS.md).

- **A press outside the prose is answered once**, by
  [`pointer-boundary.ts`](pointer-boundary.ts) rather than by whichever layout
  component caught it. The pane has no click-dead margins, so the gutters, the
  page below the last block, and the inert strip between two blocks all place a
  caret — and `posAtCoords` alone hands a seam press the hidden source of the
  rendered diagram above it. The resolver is pure over geometry plus the
  document and returns a typed decision whose refusal is one of its cases. Two
  rules hold for every block kind alike: an outside press never lands in an
  opaque object's interior, and a press in a SEAM prefers prose to source. A
  new block view adds nothing here, because the answer reads the object
  registration.

- **A node view that hides its own text derives that face from the selection,
  and never restructures around it.** A selection inside a rendered diagram
  fence implies a visible, connected source content DOM; rendering that
  implication must not change the selection, or the two faces alternate. So the
  content host stays the wrapper's first child and only its visibility changes,
  the render layer is a stable sibling behind it, and the face has no memory and
  no test of how the caret arrived. A caret gets there by keystroke, command,
  peer write, or pointer, and all four must converge.

- **A key the editor owns is owned on its refusals too.** Undo
  (`UndoRedoKeymapExtension`) and Tab (`TabKeymapExtension`) both consume
  their key whether or not the verb had anything to do, because a binding
  that declines hands the key to the browser: Mod-z becomes whatever the page
  does, and Tab moves DOM focus out of the manuscript while the ProseMirror
  selection stays put, discarding every keystroke after it in silence.
- **Tab makes a tab**, and its four meanings are one kernel ladder rather
  than four extensions' habits: cells in a table, line-wise indent in a
  fence, sink/lift in a list, one `\t` in prose. Prose tabs are a wire
  question as much as an editor one (law 9) — a LEADING tab parses back as an
  indented code block, so the codec writes it `&#x9;`, and `packages/markup`'s
  codec test is what keeps the key safe to press.

- What an href means is `links/`, once. A link is four kinds — wikilink,
  scheme, relative, external — and every consumer (the click, the hover hint,
  the menu, the mark's own rendering, the paste sanitizer) reads the same
  classifier. TipTap's link extension does not know the internal family and
  must be configured against ours.

- **A surface that outlives a keystroke cannot hold raw positions, and cannot
  hold DOM.** Every remote change rebuilds the whole document, so ProseMirror's
  mapping reports every position deleted whatever actually happened, and the
  node views and decoration spans in the page are rebuilt under it. Yjs relative
  positions plus Yjs element identity are what survive both.
  [`anchors.ts`](anchors.ts) is the one mechanism: hold an `EditorAnchor` for a
  range, a `NodeHold` for a node, never a number and never an element, and never
  a second copy of the machinery. **Elements are geometry, holds are identity**:
  read an element to measure or to run a verb this frame, and let go of it.
  `features/editor/chrome/useNodeHold.ts` is the React half. The contract and
  the three rules that come with it are in
  [`.context/CONTEXT.md`](.context/CONTEXT.md).

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for session, peer-mark, draft-review,
and navigation contracts.

→ [`chrome/AGENTS.md`](chrome/AGENTS.md) — the headless chrome kernel
→ [`extensions/auto-pair/AGENTS.md`](extensions/auto-pair/AGENTS.md) — closers the editor writes
→ [`extensions/slash/AGENTS.md`](extensions/slash/AGENTS.md) — the `/` trigger
→ [`extensions/wikilink/AGENTS.md`](extensions/wikilink/AGENTS.md) — the `[[` trigger
→ [`../completion/AGENTS.md`](../completion/AGENTS.md) — the headless menu store and reference catalog
→ [`objects/AGENTS.md`](objects/AGENTS.md) — object physics
→ [`diagrams/AGENTS.md`](diagrams/AGENTS.md) — which fences draw, and who draws them
→ [`blocks/AGENTS.md`](blocks/AGENTS.md) — what the document knows about a block drag
→ [`links/AGENTS.md`](links/AGENTS.md) — the link system
→ [`images/AGENTS.md`](images/AGENTS.md) — how a picture gets into a document
