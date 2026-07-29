# core/editor/objects — the second register's physics

Objects are the design's other kind of content (§1): nodes the writer selects
rather than types into, usually machine-written. This directory is the physics
they all share — click selects, arrows walk on and past, Enter engages, Esc
goes home — with nothing about any particular object in it.

## Mental model

`EDITOR_OBJECT_TYPES` is the whole per-type story: a node name, an optional
predicate for types that are only sometimes objects, and what Enter means. A
lane that ships a new object type adds one row and, if Enter opens a surface,
registers the handler from its mounted React component.

Object-ness is a **registration, never a structural guess**. ProseMirror cannot
tell a figure from a blockquote, and a mermaid diagram is a `code_block` whose
`language` attr decides. The chrome kernel imports this table rather than
re-deriving it, so there is one answer to "is this an object".

## Key rules

- **A selected object always consumes Enter**, even when its intent is `none`
  or its lane has not shipped yet. Letting Enter fall through hands a node
  selection to the base keymap, which splits the block around it and leaves
  stray paragraphs in the manuscript. Inert, not destructive.
- **Click reads** (law 1). `handleClickOn` acts only on the node the pointer
  directly hit; without that, a click in a table cell would walk out and select
  the whole table.
- **Arrows never leap out of a sentence.** A block object is beside the caret
  only at the very edge of its text block; an inline image is beside it
  directly.
- **A dead end is an answer.** `caretBesideObjectTransaction` returns null
  rather than silently walking the other way — pressing Right on the last block
  in the document must not move the caret left. Esc uses
  `caretHomeFromObjectTransaction`, which is allowed to land in front.
- Keys register through the kernel at scope `object`, so a surface open over
  the document still gets them first.

## Anti-patterns

- Branching on a node type in `ObjectPhysicsExtension`. Add a row to the table.
- Reading `selection instanceof NodeSelection` to find the selected object: a
  table cannot hold one (see the kernel's `.context`). Call `selectedObject`.
- Registering keys with a new TipTap extension priority instead of a scope.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../chrome/AGENTS.md`](../chrome/AGENTS.md)
→ design of record: `editor-toolbar-split/interaction-model.md` §1, §4, §5.2
