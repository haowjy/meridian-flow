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

## Selection details

Esc and printable input step over an opaque object to the next writable position. A
press or drop beside a fence is not a dead end: its facing edge takes the caret when
no prose is on the other side. An adjacent object of the same type takes a restored
node selection; the ring shows it. A newly created object may open ready to edit,
while an existing one shows its state. A structural drop must resolve inside a cell
rather than manufacture a column. `typeBesideObjectTransaction` prepares the writable destination beside a
selected object; the text-input handler inserts the committed text there.

Physical keypresses and cancelable, non-composing native `insertText` input use the
same ProseMirror text-input handler chain. Composition prepares that destination at
`compositionstart`, then leaves provisional text and commit to the browser. This must
happen before ProseMirror's own compositionstart handler: it deletes a non-inline
selection when restarting composition, which would remove a selected block or empty
a selected table's cells. Waiting for `beforeinput` is too late. Ordinary text and
partial cell selections keep their existing input paths.
