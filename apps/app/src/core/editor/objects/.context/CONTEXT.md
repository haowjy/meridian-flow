# Object physics contracts

Object rows are an append-only policy table. They describe physics and
engagement once so pointer, keyboard, and chrome surfaces cannot disagree.

## Row contract

```ts
{
  id, nodeType, body: "text" | "block-drag" | "inline-drag",
  engage: "surface" | "caret-inside" | "none",
  surfaceFields?, matches?
}
```

`text` permits a caret and owns its pointer; `block-drag` is opaque and moves
between top-level seams; `inline-drag` is opaque and delegates native dragging
to ProseMirror. Inline rows must be schema-inline and expose
`data-drag-handle`. `surfaceFields` is the only list of attrs edited by the
object surface. Diagram IDs are `diagram:<language>` and must remain distinct
even though all diagrams use `code_block`.

Engagement receives the registration ID, node, position, and reason (`engage` or
`created`). A surface handler is required for a shipped `surface` row; the key
is consumed even when no handler is available. Double-click and Enter call the
same registration. `caret-inside` enters the first text position; `none` does
nothing.

## Selection and pointer

`selectedObject` recognizes ordinary `NodeSelection` plus a full-table
`CellSelection`. `selectObjectTransaction` may dispatch a NodeSelection because
the table plugin normalizes it on entry. Non-editable object bodies are selected
on mousedown before the browser can place a caret in hidden content. The
listener sits beside, not inside, ProseMirror's click machinery so double-click
counting survives. Inline-drag rows bypass this refusal.

The ring is a decoration projected from selection. It must repaint after a
remote Yjs rebuild, unlike node-view lifecycle selection props.

## Walk and destructive actions

`objectBeside` checks the immediate inline neighbor, then an edge sibling at the
current block depth, climbing only when the edge belongs to a parent structure.
Walking onto an opaque object selects it; walking from one passes it. The
resolved landing is read back through registration, because schema-aware
`Selection.near` cannot distinguish hidden rendered source from prose.

Arrow movement and Escape intentionally differ. Arrow asks for the adjacent
object and may stop at a dead end. Escape searches forward for writable prose,
skipping opaque objects and leaves, and only looks behind when nothing is ahead.
Printable input uses the same opaque-body rule. Deletion and Backspace remove
the registered node; typing beside it creates or uses prose instead of replacing
the object. A partial `CellSelection` is a writer editing inside the table, so
typing still replaces the swept cells.

Writer-visible rulings: a picture drags between words (`inline-drag`) and lands
anywhere a caret can go, while a figure has no inline place and stays
`block-drag`; arrows select a diagram and never reveal its source; Esc on an
object that is the whole document makes a paragraph so the writer is never
trapped. Enter on a selected plain code fence takes the caret to its start (its
rendering is its source) and always consumes the key, because Enter reaching the
base keymap would split the block and leave a stray paragraph. A fence is not an
object, so that binding sits at `block` scope. The arrow walk is `block` scope
for the same reason: walking onto an object starts from the prose beside it.
