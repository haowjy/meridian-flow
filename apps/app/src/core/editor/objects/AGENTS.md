# core/editor/objects — the second register's physics

Objects are the design's other kind of content (§1): nodes the writer selects
rather than types into, usually machine-written. This directory is the physics
they all share — click selects, arrows walk on and past, Enter engages, Esc
goes home — with nothing about any particular object in it.

## Mental model

`EDITOR_OBJECT_TYPES` is the whole per-type story: an id, a node name, an
optional predicate for types that are only sometimes objects, what a press on
the body does, what Enter means, which control surface the object carries, and
which of its own attributes that surface can edit. A lane that ships a new object
type adds one row and, if Enter opens a surface, registers the handler from its
mounted React component.

Object-ness is a **registration, never a structural guess**. ProseMirror cannot
tell a figure from a blockquote, and a diagram is a `code_block` whose `language`
attr decides. The chrome kernel imports this table rather than re-deriving it, so
there is one answer to "is this an object".

**The `id` is the registration's identity, and what surfaces register against.**
Not the node type: fenced diagrams all share `code_block`, and their rows are
generated from the diagram-provider catalog
([`../diagrams/AGENTS.md`](../diagrams/AGENTS.md)) so a new diagram kind is one
row THERE and nothing here. An engagement, a per-object keymap, and the resolved
chrome context (`objectSpec`) all speak in ids, which is what lets two dialects
of one node type register apart.

## Key rules

- **A surface opens through `engageObject`, whoever asked.** Enter on a
  selected object and a lane that just created one are the same request, and
  law 2's exception (a new empty object opens ready to edit) is why the second
  exists. A lane that resolves the engagement map itself will drift from the
  key.
- **A selected object always consumes Enter**, even when its intent is `none`
  or its lane has not shipped yet. Letting Enter fall through hands a node
  selection to the base keymap, which splits the block around it and leaves
  stray paragraphs in the manuscript. Inert, not destructive — which is why
  `ObjectEngagement` returns nothing, and why a `surface` type with no handler
  says so in development instead of shipping a dead key.
- **Click reads** (law 1). `handleClickOn` acts only on the node the pointer
  directly hit; without that, a click in a table cell would walk out and select
  the whole table.
- **An object body that refuses a caret takes the PRESS**, not the click.
  `handleClickOn` runs on mouseup, and between the two events the browser has
  already hunted for the nearest editable position — which, inside a node view
  that hides its own text, is that hidden text. The rule is the DOM's own
  (`contenteditable="false"` under the pointer), never a list of node types, so
  a plain fence and a table cell keep their caret. An `inline` drag is the one
  exception, and refusing the press there would refuse the gesture: Chrome
  starts no drag out of a press whose default was taken away, and beside an
  inline picture the nearest editable position is the sentence it already
  stands in.
- **`body` is ONE column for what a press on the body does** (§5.8), because
  caret-landing and drag-start are the same fact told twice. `text` shows its own
  text, takes a caret like prose, and starts no drag: a table's cells take the
  sweep across them. `block-drag` and `inline-drag` are both opaque — they stand
  in for text the page does not show, so no press from the gutters, the seams, or
  the page below may put a caret in one
  ([`../pointer-boundary.ts`](../pointer-boundary.ts) keeps that rule) — and they
  differ in the gesture they start. `block-drag` starts the drag the margin
  handle starts, in
  [`surfaces/blocks`](../../../features/editor/surfaces/blocks/AGENTS.md), and
  that surface still asks whether this occurrence IS the whole block first.
  `inline-drag` leaves the press to ProseMirror's own drag, which carries the
  node as an inline slice and lands it anywhere a caret can go — between two
  words, with the dropcursor drawing the caret there (human ruling, 2026-07-29: a
  picture drags in between text). Landing there is only half of it: a picture as
  wide as the prose column fills the line box it landed in, so what stands in a
  line has to be sized for one
  ([`../images/AGENTS.md`](../images/AGENTS.md), human ruling, 2026-07-30). The
  same file owns the drag's own preview, because the browser's default for a
  picture is the picture. A figure has no inline place to land and stays
  `block-drag`; only a node the schema calls inline can say `inline-drag`, and
  its node view has to carry `data-drag-handle` or TipTap refuses the browser's
  dragstart. Splitting this back into two columns takes a real object that wants
  a combination one value cannot say (tech-lead ruling, 2026-07-29).
- **`surfaceFields` is what the object's ⋮ can edit** — its alt text, and a
  figure's caption and label (§5.6). One image surface serves the inline picture
  and the captioned figure because the row, not the node type, says which fields
  exist. A node view never grows a form for them.
- **A letter types beside a selected object; only Delete and Backspace
  destroy it.** ProseMirror replaces the selection on any input, so one
  printable character used to be the end of a picture the writer had just
  closed the lightbox on, or of every cell in a table.
  `typeBesideObjectTransaction` lands the caret after the object (making a
  paragraph when there is nothing after) and inserts there. `selectedObject`
  is the whole gate: a partial `CellSelection` is a writer editing inside the
  table, so typing still replaces the cells they swept.
- **The destructive verbs take the NODE, not the selection.** A table is
  selected as a `CellSelection` over every cell, so `deleteSelection` blanks
  the cells and leaves the grid standing. `deleteObjectTransaction` removes
  the object itself, at kernel scope `object`, for every type alike.
- **Arrows never leap out of a sentence.** A block object is beside the caret
  only at the very edge of its text block; an inline image is beside it
  directly. The same split runs through the drag: a block object travels
  between blocks, an inline one travels between characters.
- **A caret walk steps ONTO an object, never into it** (human ruling,
  2026-07-30). Both halves of the walk read the registration: the press that
  starts in prose (`objectBeside`) and the press that starts on an object
  (`caretBesideObjectTransaction`), which is where the rule was missing —
  `Selection.near` knows the schema and nothing else, a rendered diagram is a
  `code_block`, and arrowing off the scene break below one landed in the
  mermaid source and turned the picture back into syntax. Crossing an object is
  therefore two presses from either side and in either axis, and the two verbs
  that need somewhere to TYPE (Esc, a printable character) step over an opaque
  interior rather than onto it. `opaqueObjectAround` is that reading, shared
  with [`../pointer-boundary.ts`](../pointer-boundary.ts): a body standing in
  for text the page does not show is not caret territory, for the keyboard and
  the pointer alike.
- **A dead end is an answer.** `caretBesideObjectTransaction` returns null
  rather than silently walking the other way — pressing Right on the last block
  in the document must not move the caret left. Esc uses
  `caretHomeFromObjectTransaction`, which is allowed to land in front, and
  which makes a paragraph when the object IS the document. That last case is a
  write on a dismissal, and it is still right: law 3 says nobody is trapped,
  and a chapter holding one diagram has nowhere else to stand.
- Keys register through the kernel at scope `object`, so a surface open over
  the document still gets them first.

## Anti-patterns

- Branching on a node type in `ObjectPhysicsExtension`. Add a row to the table.
- Reading `selection instanceof NodeSelection` to find the selected object: a
  table cannot hold one (see the kernel's `.context`). Call `selectedObject`.
- Registering keys with a new TipTap extension priority instead of a scope.
- Marking editor state from a node view's `selectNode`/`deselectNode`. Those
  fire once, and a peer's write rebuilds the node view without them — which is
  how the jade ring went missing for a whole session. Derive it. The ring's own
  decoration carries the fact in its spec (`objectSelectedInDecorations`), so a
  node view that has to DO something about being selected — an image's resize
  grips — reads that rather than TipTap's `selected` prop.
- Scoping a key by what it is about rather than where it must work. The arrow
  walk is `block` scope, not `object`: walking ONTO an object starts from the
  prose beside it, where no object is selected yet.
- Asking ProseMirror where a caret goes near an object. `Selection.near` and
  `Selection.findFrom` answer from the schema, which cannot tell a rendered
  diagram from a paragraph of code. Read the landing back through the
  registration.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../chrome/AGENTS.md`](../chrome/AGENTS.md)
→ design of record: `editor-toolbar-split/interaction-model.md` §1, §4, §5.2
