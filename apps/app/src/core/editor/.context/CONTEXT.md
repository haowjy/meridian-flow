# App editor — TipTap/Yjs runtime contract

The app editor builds the browser-side TipTap schema and binds it to the shared
Yjs document session. It must stay structurally aligned with
`@meridian/prosemirror-schema`; schema drift corrupts y-prosemirror documents.

## Contracts

- `createEditorExtensions()` is the only app-side extension assembly point for
  collaborative documents, and its TipTap schema must stay structurally equal to
  `buildDocumentSchema()`. The two are built separately and parity is not
  enforced, so a node or attr added on either side is a two-file change.
- Collaboration uses the shared `PROSEMIRROR_FRAGMENT_NAME` Y.XmlFragment. Do
  not create a second fragment name or a second editor sync path.
- `DocumentSessionRegistry` is keyed by the Yjs room key, not by editor surface:
  live rooms use the bare document id; review rooms use the opaque,
  generation-fenced `reviewRoomName` vended by the preview. Switching live ↔
  review is a session identity change and must remount the TipTap editor because
  Collaboration binds to a concrete Y.Doc/fragment at construction. A review
  mount requires both `reviewDraftId` and `reviewRoomName`; neither selects the
  live surface, while either one alone is invalid and must fail rather than
  falling back to live.
- `mounted-editor.ts` is the editor-lifetime boundary, and the split it draws is
  the contract:
  - `EditorMountIdentity` is a discriminated union over the two surfaces (live
    room, optionally detached, versus a generation-fenced review room) plus the
    construction facts both share: document, project, schema type, and whether
    CollaborationCaret is installed. Every field changes which extensions exist
    or which shared document backs them, so `editorMountKey()` renders it into
    the React key that owns the mount, and `editorRoomKey()` names the room the
    session registry must supply. Callers derive both from the same identity, so
    a session swap cannot arrive without a new mount.
  - `useMountedEditor()` freezes one construction bundle on first render:
    extension configuration, initial options, and the witness's document,
    horizon-degradation flag, and report callback. It manually constructs TipTap
    in its own effect. One synchronous block snapshots the Y.Doc, arms the
    schema-repair witness in its open phase, calls `new Editor`, and flips the
    witness to live before yielding. The hook also owns destruction. Surface
    changes are reconciled onto the live instance with `setOptions()` and
    `setEditable()`; they never become construction dependencies or alter the
    armed witness.
  - `EditorSurfaceOptions` (editability and ProseMirror `editorProps`) is
    everything that may change mid-mount. Editability needs its own
    `setEditable()` call because TipTap's option sync deliberately re-asserts
    the running editable flag. A caller that rebuilds `editorProps` every render
    pays an extra `view.setProps` — never a rebuild — so editor handlers do not
    have to be identity-stable; they read live editability off `view.editable`
    rather than closing over props.
  - `EditorView.lifetime.test.tsx` is the enforcement: it proves a thread-query
    refetch and a live surface change keep the same editor and UndoManager while
    a room change replaces them.
- Live sessions may use versioned IndexedDB persistence. Review sessions do not:
  the branch room is server-persisted and generation-fenced, and a local cache
  risks recovering state into the wrong review generation.
- Before binding, `EditorView` waits for local persistence and, for attached
  rooms, first server sync under one five-second overall timeout. Detached live
  rooms wait only for local persistence. Expiry always permits binding and
  passes degraded evidence through the mount into each resulting verdict; the
  horizon buys better evidence and is never an admission gate.
- `schema-repair-witness.ts` owns one Y.Doc update listener across open and live
  phases. Open-phase local delete-only normalization is classified
  synchronously during construction and resolved against the pre-bind snapshot
  by Y item identity; structural boundary tokens keep separate removed passages
  from being concatenated. In live mode, `beforeAllTransactions` and
  `afterAllTransactions` bound candidate lifetime to one Yjs batch. A local,
  y-sync-origin delete-only transaction becomes its own candidate; its pre-GC
  `afterTransaction` capture belongs to an attempt opened at Yjs
  `beforeTransaction`. TipTap's `beforeTransaction`/`transaction` lifecycle
  identifies attempts created by a writer PM transaction, which are discarded
  individually; binding meta (`binding` or `isChangeOrigin`) claims the oldest
  unclaimed attempt, while remote-interleaved unclaimed attempts fall back at
  batch close. This is per-candidate correlation, not one verdict decision for
  the whole batch: unrelated user transactions do not discard other candidates.
  If remote cleanup folds a writer deletion and delete-only normalization into
  one Y transaction, the writer's PM-step deletion evidence is removed from the
  candidate. A normalization coalesced into a mixed delete-and-insert Y
  transaction is not a candidate at all; the repair still merges and journals,
  but its notice is lost. Batch close clears PM context synchronously and
  tokenizes deferred fallback so binding meta cannot leak into a later ordinary
  writer command. Evidence degrades to node types plus clock magnitude rather
  than suppressing a candidate verdict.
  Verdicts append to
  `DocumentSessionSnapshot.schemaRepairs`; they do not raise a schema fence,
  write quarantine, change connection status, or pause editing.
  Reporting is per replica: a client reports only a repair performed by its own
  binding. Several replicas can therefore report the same arriving invalid
  content, while a replica that only receives another replica's remote repair
  reports nothing. There is no room-level reporter or suppression protocol.
- Live peer marks are the session projection of durable trail changes. Their
  anchored popover lazy-reads trail detail and the originating thread snapshot.
  The popover is evidence and navigation only; producing-turn receipt Undo/Redo
  is the sole reversal authority for AI changes.
- Opening a mark belongs to the projection, not to the host: the press
  ([`extensions/peer-mark-press.ts`](../extensions/peer-mark-press.ts)) is a
  per-editor store the plugin writes from its own DOM handlers, holding the
  `changeId` and the caret the writer left as an `EditorAnchor`. The surface reads
  it. An editor with no projection has no press to read, which is why draft
  review needs no suppression flag.
- Peer-mark manuscript color describes the change, not the thread identity:
  added/modified marks use jade and deletions use crimson. Ordinary ranges rest
  as an underline only; a sweep is the sole resting warning tint. Per-thread
  hues belong only to identity chrome such as the hover label and popover dot.
  Localized mark and trail verbs come from `change-mark-labels.ts`; do not
  duplicate English labels in the ProseMirror extension or UI surfaces.
  The thread name inside a mark label arrives through `AgentNameStore`, a
  subscribable lookup the projection repaints from. It is a store rather than a
  resolver callback because the editor is built once per room: a closure over
  the thread-list query would re-key the editor on every refetch, and thread
  titles land after the turn that created the mark. An untitled thread
  contributes no name, so the label falls back to "AI".
- Live `DocumentSession`s own an ephemeral `SessionMarkerStore` sidecar.
  Change-event replace sets survive editor remounts during the registry's
  retention window but are never persisted or projected into branch rooms.
  Every accepted replace set advances its group revision before changes admitted
  by the current writer are filtered, so an all-self set still clears older
  marks and fences delayed replays. Unresolved anchors expire on their own timer
  even while the editor is idle; store teardown cancels that timer.
  The ProseMirror projection clears a whole mark only for a local writer edit
  through its range or tick; remote sync, selection, and boundary-adjacent typing
  never clear it.
- Deletion marks are caret-sized inline ticks. A boundary anchor resolves into
  the first or last descendant textblock on its affinity side, falling back to
  the opposite adjacent container; never leave the widget between block nodes
  as an anonymous line. Deletions use crimson for their tick and focus ring.
- Collaboration awareness is a browser protocol boundary: theme-owned cursor
  colors must be resolved before publication and serialized as concrete
  six-digit RGB hex. CSS variables and OKLCH strings are valid token sources,
  not valid y-prosemirror awareness colors.
- Live sessions may be created `detached`: their Y.Doc and IndexedDB persistence
  exist before server transport. Ordinary acquisition of an existing detached
  room leaves it detached; post-create reconciliation explicitly attaches
  transport to that same session once. Retention accepts an explicit detached
  room set so restored pending tabs create local sessions without probing a
  server row that does not exist yet. If an older client already left that room
  terminally denied, post-create reconciliation restarts it before attachment.
  Teardown always preserves IndexedDB by
  default because it may contain the only copy of unsynced words; only confirmed
  cleanup paths may request persistence deletion. Retention and unavailable-room
  recovery must not materialize or replace a detached session implicitly.
- A schema fence is orthogonal session state, not a connection status:
  `DocumentSessionSnapshot.schemaFence` composes with detached, synced, offline,
  and access-lost states. The first fence wins, is persisted through the
  version-keyed localStorage quarantine producer, and remains observable for the
  session lifetime; it never changes `deriveStatus()`. A quarantine loaded
  before attachment keeps the room detached. Raising a fence on an attached
  session pauses editing and presence but does not itself detach transport.
  Storage failure leaves the in-memory fence effective but not durable.
- A `4406 client-schema-superseded` reset gets one silent reload before the
  session raises `client-superseded`. The sessionStorage guard is keyed by room
  and the schema `major.minor` tag, is written before `location.reload()`, and
  clears only after first transport sync. IndexedDB persistence and localStorage
  quarantine use the same tag: patch releases reuse them, while a minor or major
  change partitions them. A blocked guard or repeated refusal raises the fence
  without another reload. `4407 document-schema-stale` never reloads or raises
  a fence because a new bundle cannot repair a server/head major mismatch.
- TipTap extensions may provide editing behavior, but they must not add node or
  mark types outside the shared schema unless the schema package and server
  markdown adapter are updated in the same change.
- Inserted images are inline `image` nodes: inline where the insertion point can
  hold one, in a paragraph of their own where it cannot. Their `src` is a stable
  `asset:<documentId>`; `ImageNodeView` resolves a signed read
  URL through `asset-image-render-state.ts`, while the markup codec materializes
  project-relative paths. One failed media load may refresh the signed URL
  automatically; the next one surfaces an error instead of looping. That budget
  is per picture the browser reported rendering (`onLoad`), not per mounted node
  view — a view lives as long as the chapter is open, so a budget spent once
  would leave every later expiry with a placeholder. A failure arriving while a
  load is in flight is ignored: a refresh keeps the expiring URL on screen, and
  the request already running is the answer.
- A picture in flight is a document node. `images/` inserts
  the `image` node with `src: ""` before the upload starts and sets `src` on that
  same node when the bytes land, so nothing is inserted at completion and the
  manuscript does not reflow. The hold on the slot is a `NodeHold`, the same one
  every other long-lived surface uses; progress, the file, and the abort live in the plugin's
  state; losing the slot (a delete, an undone insert) aborts the request. Failure
  keeps the node with Retry and Remove on it. The empty `src` is the wire-safety
  decision: it round-trips as `![alt]()`, while an `asset:` ref minted before its
  asset exists throws in the codec's `pathForAsset`.
- Assets cross the clipboard as project-relative paths and live inside the
  editor as stable refs. `images/image-workflow.ts` owns both directions, and the
  asset index behind them lives in the ingress extension's storage because a path
  only means something inside one project's asset namespace.
- A paste never lands an image the project does not own.
  `resolveImagesFromClipboard` is the one seam: a copied path comes home as its
  ref, and every other address becomes a link to itself. The ingress extension
  then attempts the import — fetch the bytes through its port, take the ordinary
  upload path, and replace the link with the picture — so an external `src` is
  never written to the shared document even briefly. Each import owns its own
  entry in the pending state, so two pasted pictures are two lifecycles. A site that refuses the fetch (CORS is the
  common answer) leaves the link, which is the honest result rather than a
  broken figure. The link is found again through `pastedContentRange` plus
  `pastedImageLinkRange`, held as an `EditorAnchor` for the length of the
  import.
- Block alignment lives as an `align` attr on `paragraph`, `heading`, and
  `table`, mirroring `@meridian/markup`'s reserved `Layout` wire wrapper. Only
  `null`, `"center"`, and `"right"` exist; there is no `"left"` ghost state
  because unaligned is the default. Table alignment renders twice — through the
  node's `renderHTML` and through `MeridianTableView`, because the resize plugin
  takes over table DOM once `resizable` is on.
- `table-operations.ts` owns the table transforms prosemirror-tables omits (row
  and column moves, whole-column alignment, layout reset). All of them refuse a
  table containing spans — not for the wire (spans serialize fine since the
  codec's GFM-to-HTML escalation) but because row/column moves over merged
  cells would break prosemirror-tables' rectangular invariants. Row zero is
  the structural GFM header and never moves.
- The slash trigger lives under `extensions/slash/` and is summarized below.
- `pointer-boundary.ts` answers a press that landed outside the prose:
  `pointerBoundaryDecision(view, clientX, clientY)` reads the prose rectangle
  and the neighbouring block rectangles, and `resolvePointerBoundary` decides
  over that geometry plus the document alone. Three sites, two policies. A
  press whose y is inside a block's band — or past the first or last band,
  which is the page above and below the document — is a press ON that block:
  it takes the `posAtCoords` line beside the pointer unless that line is an
  opaque object's interior, in which case it falls to the nearer of the
  block's edges. A press in the vertical strip BETWEEN two bands is a seam and
  belongs to neither block: the following block's first writer text answers
  first, then the preceding block's last, then a gap cursor at the boundary
  when prosemirror-gapcursor admits one, then the nearest writer text outward
  (forward first). `writerTextEdge` is what "writer text" means — never an
  opaque object's interior, and at a seam never a source block either, since
  the seam belongs to no block and prose beats syntax. `PointerBoundaryDecision`
  is a discriminated union so the last case, a document with no visible caret
  anywhere, declines out loud instead of falling through to
  `TextSelection.near`. The decision table in `pointer-boundary.test.ts` is the
  contract; `EditorSurfaceFrame` only dispatches what it returns.
- Enter on a whole-block selection is object physics', not the base keymap's
  (§4). What it means comes from the block: a registered object with a
  `surface` intent opens its lane's surface, a table takes the caret into its
  first cell, and a selected plain fence takes the caret to its own start —
  its rendering IS its source, so there is nothing else to open. The binding
  sits at `block` scope precisely because a plain fence is NOT an object;
  making it one would trade click-to-caret for click-to-select. It always
  consumes the key, because letting Enter reach the base keymap splits the
  block and leaves a stray paragraph behind.
- A lane that owns an object's surface registers it with
  `registerObjectEngagement`, and receives an `ObjectOpening` saying why it was
  asked: `"engage"` for something that already exists, `"created"` for one made
  a moment ago. Law 2's sole exception rides that distinction — a new empty
  diagram opens ready to work rather than showing a viewer with nothing in it.
- A `code_block` whose `language` is `mermaid` renders as a diagram and hides
  its own `<pre>`; every other language is the fence itself.
  `MermaidCodeBlock.tsx` is that node view and `mermaid-render.ts` is the async
  parser edge behind it. It has three faces and none of them is a code block
  (§5.2, "the page never shows Mermaid syntax"): the render; the LAST GOOD
  render plus a parse note, once an edit stops parsing; and an error card with
  mermaid's own message and an Edit source button, for source that has never
  rendered at all. Source access belongs to the diagram dialog
  (`features/editor/surfaces/objects`); caret-enters-source is not coming back.
  The one exception the view owns is a caret INSIDE the fence — a fence typed
  as markdown is filled in by hand, and a caret in a hidden element eats every
  keystroke it is given. Its invariant: **a selection inside the fence implies
  a visible, connected source content DOM, and rendering that implication must
  not itself change the selection.** The second half is structural. The
  `NodeViewContent` host is the wrapper's first child and never conditional,
  and the render layer is one stable sibling after it, mounted for the life of
  a mermaid fence — so neither a face swap nor a parse settling moves DOM in
  front of ProseMirror's live selection. DOM vanishing ahead of a live
  selection is what made the two faces alternate, and
  `MermaidCodeBlock.test.tsx` asserts the sibling list ahead of the host across
  both transitions. The face is derived from the current selection on every
  render (`useSyncExternalStore`, no local face state) and tests nothing about
  how the caret arrived, so a keystroke, a command, a peer's mapped write and a
  press all converge after one render. Do not reintroduce a provenance test:
  the premise that a pointer cannot produce this caret was false. Where an
  outside press may land is `pointer-boundary.ts`; object physics selecting an
  opaque body on the PRESS (see `objects/.context`) is one more entry it
  closes, and neither of them is what makes the node view safe.
- `useMermaidSvg` keeps the LAST GOOD svg across a failing edit, which is what
  lets the dialog show a live preview beside source that does not parse yet.
  Every consumer gets its own render id: mermaid writes it into the markup, and
  two faces of one diagram sharing an id collide over the arrow markers they
  reference.
- The clipboard has two doors, one per flavour it can carry. HTML goes through
  `sanitize-paste.ts`, which rebuilds rather than scrubs: allowed elements are
  copied into a fresh document under an attribute allowlist, so a
  newly-supported browser attribute is unsafe by default. `createEditorConfig`
  composes it *after* any caller `transformPastedHTML` so a caller can never
  reintroduce markup the schema would accept.
- Clipboard **text** goes through `markdown-paste.ts` and comes out as the
  document it describes. It is the same `markdownCodec` the wire uses, so
  headings, lists, quotes, fences, tables, links and `[[wikilinks]]` all arrive
  as themselves and nothing in the app has to know what markdown looks like.
  `markdownCodec` rather than `mdxCodec`: clipboard text comes from anywhere and
  MDX reads `<` and `{` as syntax, which fiction contains.
  Four refusals bound it, and each is a behaviour, not an implementation detail:
  paste-without-formatting yields characters; a caret inside a code block or a
  table cell yields characters, because block structure cannot live there; and
  `markdownPasteAddsStructure` declines any parse that amounts to the paragraphs
  the default paste would have produced anyway. That last one is the
  false-positive guard, and it is decided on the parsed blocks rather than on a
  guess about the raw text: pasted prose never takes a detour through a parser
  that could re-spell it. A lone paragraph comes back as an open slice so a
  bolded phrase joins the sentence at the caret; anything with blocks comes back
  closed so its structure survives.
  Only text-only clipboards reach this door. ProseMirror prefers `text/html`
  when the source offers both, which is how copying between rendered surfaces
  already worked.
- Editable link clicks place a cursor instead of navigating: `openOnClick` is
  off and a plugin calls `preventDefault()` while still letting ProseMirror
  resolve the selection. `link-url.ts` is the single normalizer for
  writer-entered targets (http/https/mailto only).

## Holding a position across a remote write

Any surface that outlives a keystroke — an open menu aimed at a link, a form
mid-typing, a drop line, a grip, a decoration — has to answer "where is my
thing now" after the document changes. ProseMirror's transaction mapping
answers that for a local edit and **not** for a remote one.

Every remote change arrives as a replacement of the WHOLE document.
y-prosemirror rebuilds the ProseMirror doc from the Yjs type and dispatches a
single `tr.replace(0, doc.content.size, …)` (`sync-plugin.js`, `_typeChanged`).
So every position maps to a boundary and every `mapResult` reports `deleted`,
whatever the change actually was. A surface holding raw numbers is pointing at
nothing, and one that closes on `deleted` closes on every peer edit and every
AI write — which this product produces constantly.

The mechanism that survives it is Yjs relative positions, through
[`relative-position-runtime.ts`](../relative-position-runtime.ts). It is what
y-prosemirror itself uses to carry the selection across the rebuild, and what
peer marks, live-range navigation, and inline review already hold their anchors
with. [`anchors.ts`](../anchors.ts) is that mechanism as one type, and every
surface holding a position consumes it — links, blocks, the fence source pane,
the peer-mark popover, the slot a picture is being uploaded into. A second copy of the
machinery is the thing this module exists to prevent.

```ts
type EditorAnchor = {
  from: number;
  to: number;
  /** null on an editor with no shared document: there is nothing to survive. */
  relative: { start: Y.RelativePosition; end: Y.RelativePosition } | null;
};

const anchor = anchorRange(state, { from, to });   // pin when the surface opens
followAnchor(state, anchor, transaction.mapping);  // re-pin on every transaction
resolveAnchorIn(state, anchor);                    // read it where no mapping is in hand
```

`carryAnchor` and `resolveAnchorIn` are the halves behind those, for a holder
that cannot do both at once — a plugin's `apply` runs before the Yjs binding
has finished describing the new document, so it carries the numbers there and
resolves at read time (`BlockDragExtension`).

`isRemoteDocumentRebuild(transaction)` names the same fact for surfaces that
diff rather than point: the fence source pane cannot carry its base's offsets
across a rebuild, so it re-reads instead.

Three rules a lane holding one should follow:

- **Position is half the answer.** Coordinates outlive the thing that was at
  them. Re-read what is actually there and compare it — a mark by attributes, a
  node by type — or the surface acts on whatever slid into the numbers.
- **A rebuilt document makes new objects.** Object identity (`===`) fails for
  equal marks and nodes after a remote write; equality (`Mark.eq`, `node.eq`)
  is what "the same thing" means here.
- **Bounds-check what you resolve.** A relative position can land at the very
  end of the document, and resolving one past it throws inside a Yjs update
  handler, where the throw is swallowed and the editor quietly stops applying
  peer writes.

A deleted thing's anchor resolves to the seam it left behind, so "is it still
there" needs an answer of its own, and positions cannot give it. `NodeHold`
([`anchors.ts`](../anchors.ts)) is that answer, and every long-lived surface in
the editor holds one: the node's two seams for where it is, plus the **Yjs
element** behind it for which node it is, plus its type as the read-back check.
The element is the same object for as long as the node lives — local typing, a
peer's typing, an AI write all mutate it in place — and a different one for
anything that is really a new node. It is found by walking the Yjs tree and the
document in step, so a hold works at any depth: a top-level figure, an inline
image inside a paragraph, a cell two levels down.

Both halves earn their place. Without identity, a peer deleting the document's
only heading leaves the schema to supply an empty paragraph in its place, and
the seams describe that replacement perfectly: uncollapsed, at depth 0, a
good-looking block a menu would happily delete. Without the seams, an editor
with no shared document has no deletion signal at all, because there is no
element to compare.

`holdBlock` / `resolveBlockHold` / `followBlock` are the same hold with one
extra rule — it must still be a TOP-LEVEL block — which is what the block
surfaces need and what a wrap into a blockquote breaks.

## Elements are geometry, holds are identity

A DOM element is the other thing a surface is tempted to remember, and it is
never the answer to "what is this aimed at". ProseMirror rebuilds node views and
decoration spans whenever it decides they no longer match, which is not the same
question as whether the writer's content is still there:

- a keyed peer-mark widget is rebuilt when the mark is emphasised or its author's
  name arrives, while the mark has not moved;
- a node view is replaced when a rebuild reconciles a same-type sibling onto its
  desc, while the node it was showing lives on somewhere else.

So an element is read for exactly one purpose — where something is drawn, right
now — and dropped. `useNodeHold`
([`features/editor/chrome/useNodeHold.ts`](../../../features/editor/chrome/useNodeHold.ts))
is the React binding: take a hold, carry it through every transaction, let go
when the node is gone. Letting go IS a surface's dismissal, which is what keeps
a menu from retaining state for a block that has been deleted.

## TipTap v3 defaults we intentionally disable

- `trailingNode: false` — TipTap v3's StarterKit can append a trailing paragraph
  after terminal blocks. In this Yjs-backed editor that would be a real shared
  document mutation on open/sync, not visual chrome. Keep trailing-space UX as an
  explicit editor feature if needed, not an inherited StarterKit default.
- `undoRedo: false` — collaborative history is not TipTap local history. The
  history is the Yjs UndoManager the collaboration extension installs, and
  `UndoRedoKeymapExtension` binds Mod-z / Mod-y / Mod-Shift-z to it above every
  other keymap. Meridian owns those keys rather than inheriting them (ruling
  17): undo is the writer's recovery over LLM writes, so no later extension may
  shadow it. It mounts only alongside collaboration — a standalone editor has
  no undo command to bind.
- `link`, `underline`, `listKeymap` and built-in camelCase schema extensions are
  disabled where Meridian installs custom schema-parity wrappers.

## Slash trigger — the `/` menu

Colocated under `extensions/slash/`, with its own
[`AGENTS.md`](../extensions/slash/AGENTS.md). It is one spec over the lane
mechanism in `extensions/suggestion/`, which `[[` shares, so the first two
contracts below hold for every lane; the store and catalog a lane publishes
through are `core/completion/`. Two contracts cross this boundary:

- **The catalog is the host's, read at open.** `slashCommands.catalog()` is
  called when the menu opens and may return null, which is how a surface turns
  the trigger off. `EditorView` withdraws it behind a schema fence, because a
  slash command dispatches through a TipTap chain and chains run on a
  non-editable editor: withdrawing editability alone would leave an open menu
  able to insert.
- **The open menu is a store, not a render prop.** `getSlashMenu(editor)`
  returns what the surface subscribes to; the surface never reads editor state
  to decide what the menu shows. It may be null on an editor without the
  extension.
- **A pick never leaves a table cell.** The insertion walk stops at the cell
  the caret is in; entries that cannot live there are refused with a reason the
  menu renders, rather than landing after the table. Lists are the other rule:
  a bullet's table lands after the whole list, because a list item is only part
  of its list.
- **A new object opens through `engageObject`.** The slash lane does not know
  what a diagram dialog is; it hands the node it just made to the object lane,
  which resolves the surface a type registered. Enter on a selected object
  takes the same path, so "what opens this" has one answer.

The trigger mounts with the catalog option rather than through
`EDITOR_CHROME_EXTENSIONS`, so a surface that offers no catalog pays for no
plugin.

## Markdown autoformat while typing (ruling 18)

The surface is mostly inherited. TipTap's node and mark extensions ship GFM
input rules, its engine refuses to run any of them inside a node or mark whose
spec is `code`, and it completes a rule on Enter as well as on the trigger
character. Because the parity wrappers rename types and nothing else, those
rules resolve `strong`, `em`, `bullet_list`, `code_block` on their own. So the
whole ruled set — `# `…`###### `, `**b**` / `*i*` / `~~s~~` / `` `c` ``, `> `,
`- ` / `* ` / `+ `, `1. `, `---`, and the fence — is live without a second set
of rules to race the first.

Two places the live surface is wider than ruling 18's wording, deliberately.
Headings go to `######` rather than stopping at `###`: the schema, the codec and
every paste path already carry h4-h6, so denying the trigger would leave a
writer who typed valid markdown holding literal `#### `. Fences accept `~~~` as
well as ``` , and bullets accept `+`, for the same reason: all of them are GFM
the codec reads, and all of them produce the same node.

`MarkdownAutoformatExtension` owns only what inheritance gets wrong, and
`MarkdownAutoformatExtension.test.ts` is the truth table for the surface as a
whole, inherited rules included: a dependency upgrade that drops a trigger has
to fail there rather than in a manuscript.

- The code fence takes the whole GFM info string, lowercased. TipTap's rule
  captures `[a-z]+`, so ` ```Python `, ` ```c++ ` and ` ```ts-node ` produced no
  block at all. Lowercasing is what makes the attr a usable key: highlighting
  and the plain-editable `mermaid` block both look it up. The opening run is
  captured apart from the info token, because the two differ per fence
  character — a backtick fence's info string may not hold backticks, a tilde
  fence's may hold anything — and because a run longer than three is one fence
  with no info, not a failed match. The fence rules live here and
  `MeridianCodeBlockLowlight` yields its own.
- Backspace reverts the transform the last keystroke made. TipTap reaches for
  `undoInputRule` too, but from the core keymap, which sits below every node
  extension's: CodeBlock's "delete the empty block" binding got to a just-opened
  fence first and swallowed the ``` that opened it. A rule completed by Enter
  restores a literal newline along with its source, and that newline comes back
  out — Enter is a key, not a character the writer typed.

Attribute names are parity too, not just type names, and an inherited rule that
writes TipTap's name loses the value: the ordered-list rule writes `start` where
the schema says `order`, so every list opened at one whatever number was typed.
`MeridianOrderedList` renames it across the input rule and the DOM mapping
both. Expect the same shape from any other inherited rule that carries attrs.

## Draft review — projection-only view extension

Colocated under `extensions/inline-review/`. The extension is a ProseMirror
plugin that owns a single `DecorationSet` describing every hunk in the current
server review model. Keep this directory view-only: plugin state, decorations,
commands, and the lightweight hunk model used by the plugin.

- Only installed when the editor is bound to a review branch room. The
  `enableDraftInlineReview` flag on `createEditorExtensions` follows the
  `review` variant of `EditorMountIdentity`, which needs both a draft id and its
  generation-fenced room name; live editors never pay for it.
- The plugin is the sole owner of decoration state. React talks to it via TipTap
  commands (`setInlineReviewModel`, `setInlineReviewActiveOperation`,
  `scrollInlineReviewOperationIntoView`) — never by holding decoration objects.
- Anchor resolution routes through the shared `relative-position-runtime.ts`
  extraction of the y-prosemirror binding (`ySyncPluginKey` state).
  `Y.RelativePosition` decode is separated from
  decoration construction so anchor handling can be unit-tested without a DOM.
- Remote Yjs sync and a new model from `useInlineReviewSync` re-resolve
  RelativePositions; local writer typing maps the existing set through the
  transaction. The extension has no optimistic attribution path — the next
  server model owns writer attribution. Review dispositions never use browser
  mutation origins or collaborative history; Ctrl+Z is not a review restore
  mechanism.
- Editor-side click seam: mousedown on any decoration DOM
  (`[data-review-operations]`) dispatches
  `setInlineReviewActiveOperation` for the first listed operation. This is
  the editor→sidebar direction of bidirectional linking; the sidebar
  reads plugin state via `useEditorState` and reacts (scroll card into
  view + emphasise). Pure deletions use an empty, visible navigation seam with
  focused-operation emphasis; its DOM contains no manuscript text.

Attribution → highlight color (agent = jade, writer = gold), review palette
lives in `packages/design-tokens/src/ink-jade.css` under `--color-review-*`.

The plugin paints **one decoration per `ReviewHunk.spans` entry** rather
than one per hunk, so nested authorship (a writer edit inside an AI
insertion) renders in each owner's own color — gold inside green. Hunks with no
resolvable spans fall back to whole-hunk coloring via `hunkKind`.

## Change-trail navigation

`change-trail-navigation.ts` is the authorize/open/sync/validate boundary for
historical trail clicks. It temporarily retains the target `DocumentSession`
until the synced Y.Doc anchor has passed `@meridian/agent-edit`'s item-ID block
validation and the mounted live editor accepts the range. The always-installed
`LiveRangeNavigationExtension` owns the temporary decoration and scrolling;
zero-width deletion anchors render a caret-like boundary rather than inventing
a replacement range. Chat supplies route resolution, but must not decode,
validate, or map anchors itself.

## Search-passage navigation

`passage-navigation.ts` is the retain/sync/resolve boundary for search-match
doors. Its anchor is a block hash plus the term that matched, not an encoded
position: the hash derives from the block's immutable Yjs item id, so it
survives every edit inside the block and dangles only when the block goes.

Opening is **not** part of it. A search row is a document door first; the route
change happens either way, and this only decides where inside the document to
land. Ownership of that decision advances at the project route's door boundary
(`features/project/chat/usePassageDoors.ts`), which every door reports to,
passage or not — a resolution the writer has clicked past must not arrive
behind them. Three outcomes, produced by `passage-resolution.ts` against live
ProseMirror text:

1. the hash names a live block and the term is still in it — mark its
   occurrences there;
2. the block is gone, or no longer holds the term, and the term occurs exactly
   once in the document — mark that;
3. otherwise `stale`, which surfaces as a notice
   (`passage-notice-store.ts`). Never a landing chosen among duplicates: taking
   a novelist to a nearby-but-wrong paragraph is worse than saying nothing was
   found.

The notice's lifetime is store-owned and token-scoped, never the rendering
component's. A notice is about a navigation, and navigations continue while its
document is off screen; leaving expiry to the component stranded it, so
returning to that document later replayed a forgotten complaint.

The searchable projection is where honesty is won or lost. Text runs break at
every non-text inline leaf, so `gate` and `keeper` either side of a hard break
can never read as the unique `gatekeeper` step 2 is allowed to jump to. Each
run then folds as one string, the way the server folds: case is contextual, and
`"ΟΣ"` lowercases to `"ος"` whole but `"οσ"` letter by letter, which both misses
the searched word and matches a different one. Every folded unit still carries
the source range behind it, because `"İ".toLowerCase()` is longer than its
source.

`PassageHighlightExtension` owns the mark and the reveal. It is **never a
selection** — the writer's cursor may be elsewhere mid-sentence — it scrolls
center-biased only when the passage is not already on screen, and it clears on
the writer's next edit or caret move. Remote Yjs transactions (`ySyncPluginKey`
meta) do not clear it: they arrive constantly and would wipe the mark before it
was read.

## Selective Discard (dock Changes cards)

Each card's **Discard** is a server disposition command for its authoritative
Discard class. It never edits the review Y.Doc from the browser. The review
session's synchronous disposition lock serializes commands, and the awaited
preview refetch replaces the projection and decorations before the lock releases.

## Math extension decision

Meridian keeps the custom `math_display` node. Do not enable
`@tiptap/extension-mathematics` directly: TipTap v3 adds `blockMath` and
`inlineMath`, which are not in the shared markdown-safe schema.
