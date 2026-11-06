# Object physics contracts

Inline rows have to be schema-inline and expose `data-drag-handle`. `surfaceFields`
is the only list of attrs the object surface edits. A shipped `surface` row needs an
engagement handler; the key is consumed even when none is available.

## Selection and pointer

`selectObjectTransaction` may dispatch a NodeSelection for a table because the table
plugin normalizes it on entry. The mousedown listener sits beside, not inside,
ProseMirror's click machinery so double-click counting survives.

## Walk and destructive actions

The resolved landing of a walk is read back through registration, because
schema-aware `Selection.near` can't distinguish hidden rendered source from prose.

Arrow movement and Escape differ. Arrow asks for the adjacent object and may stop at
a dead end. Escape searches forward for writable prose, skipping opaque objects and
leaves, and looks behind only when nothing is ahead. A partial `CellSelection` is a
writer editing inside the table, so typing still replaces the swept cells.

A picture drags between words and a figure has no inline place. Esc on an object that
is the whole document makes a paragraph so the writer isn't trapped. Enter on a
selected plain code fence takes the caret to its start and always consumes the key,
because Enter reaching the base keymap would split the block. A fence isn't an object,
so that binding sits at `block` scope; the arrow walk does too, because walking onto
an object starts from the prose beside it.
