# core/editor/objects — the second register's physics

Objects are the design's other kind of content (§1): nodes the writer selects
rather than types into, usually machine-written. This directory is the physics
they all share — click selects, arrows walk on and past, Enter engages, Esc
goes home — with nothing about any particular object in it.

## Mental model

`EDITOR_OBJECT_TYPES` is the whole per-type story: a node name, an optional
predicate for types that are only sometimes objects, what the pointer finds
inside the object, what Enter means, and which control surface the object
carries. A lane that ships a new object type adds one row and, if Enter opens
a surface, registers the handler from its mounted React component.

Object-ness is a **registration, never a structural guess**. ProseMirror cannot
tell a figure from a blockquote, and a mermaid diagram is a `code_block` whose
`language` attr decides. The chrome kernel imports this table rather than
re-deriving it, so there is one answer to "is this an object".

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
  a plain fence and a table cell keep their caret.
- **`body` decides whether the object can be grabbed** (§5.8). An `opaque`
  body — a picture, a rule, a rendered diagram — is a drag source: pressing it
  starts the same block drag the margin handle starts, in
  [`surfaces/blocks`](../../../features/editor/surfaces/blocks/AGENTS.md). A
  `text` body declines, because a table's cells already own the pointer that
  sweeps across them. The registration is the answer; nothing downstream reads
  a node name to guess it — it decides the TYPE, and the block surface still
  asks whether that occurrence is the whole block before dragging it.
- **Arrows never leap out of a sentence.** A block object is beside the caret
  only at the very edge of its text block; an inline image is beside it
  directly.
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
  how the jade ring went missing for a whole session. Derive it.
- Scoping a key by what it is about rather than where it must work. The arrow
  walk is `block` scope, not `object`: walking ONTO an object starts from the
  prose beside it, where no object is selected yet.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../chrome/AGENTS.md`](../chrome/AGENTS.md)
→ design of record: `editor-toolbar-split/interaction-model.md` §1, §4, §5.2
