# Suggestions — a Work's draft as marks in Live

## Stored shape

Schema 3.3.0 (`packages/prosemirror-schema`) holds it:

- `suggest_ins` and `suggest_del` marks on text, each `{ id, work, chat, turn, by }`.
  `excludes: ""`, so two Works can mark one word; the Yjs binding then stores each under
  `name--<hash>` (`yjsMarkKey`).
- `sug` on a block that exists only as one Work's suggestion. Every block inside it carries the
  same `sug`.
- `sugAttrs` on a block: by Work, one layer per turn of a pending change to the block's
  attributes (`{ ...author, id, attrs, remove? }`). `remove: true` is the Work removing the
  whole block, which is how a block with no text is deleted.
- `comment` marks an anchor (`markdown: false`: the model's Markdown never writes or removes it).

`id` is one change, the unit of review: an insertion and the deletion it replaces share it.

## The view

`View` is `{ work }`: `null` is Live, otherwise Live plus that Work's suggestions. `kindOf`
classifies each run of a block as `live`, `own-ins`, `own-del` or `hidden` (another Work's
insertion, absent from this view). `viewBlock` is a block as a view reads it; readers project
through it.

Inside a block the Work added, text is its insertion, but its own deletion still counts. That
is what makes the turn rule below hold inside an added paragraph as well as in a Live one.

## Writing: `rewrite`

`rewrite(tr, state, view, author)` turns any transaction into what the view allows. It reads
the transaction's net change (`prosemirror-changeset`), rewrites each changed range from the end
backwards, and takes formatting from the final document. In a Work's view:

- Typing is the Work's insertion; deleting Live text is its deletion; formatting Live text is
  that text struck and inserted again, formatted.
- A heading or list change to a Live block is an `sugAttrs` layer; the block keeps its identity.
- A Live table's rows and columns cannot be suggested: the edit is dropped whole (`DROPPED_META`).
- **A later turn over an earlier turn's text layers.** When a model turn removes text another
  turn (or the writer) wrote, inline or inside an added block, the text stays under the later
  turn's `suggest_del`, and what it writes into an earlier turn's block carries its own
  `suggest_ins`. Removing an earlier turn's whole block is a `remove` layer. So `reject({ turn })`
  of the later turn, the card's Undo, brings the earlier wording back. Text the same turn
  wrote, and anything the writer removes, really goes.

In the Live view, edits land as typed, but hidden suggestions stay where they are and nothing
pasted carries a suggestion. `CHANGE_META` reports, per replaced range, the change an edit took;
agent-edit pairs a split's new block with it.

## Resolving: `accept` and `reject`

Each is one local transaction (`RAW_META`), filtered by `{ id }`, `{ turn }` or `{ work }`.
Accept makes insertions Live, deletes deleted text, applies attribute layers. Reject is the
reverse. Accepting a deletion rejects every other Work's change deleting the same text: the
first applied wins. A block the Work added that stays (accepted) still holds what later turns
layered on it. `list` gives the view's changes for review; `pendingTurns` the turns that still
have something to reject.

## Who calls it

- Editor: `apps/app/src/core/editor/extensions/suggestion-mode/` runs every local transaction
  through `rewrite` and paints the view. `SuggestionBand.tsx` is a throwaway review surface.
- Model: agent-edit's `suggestingModel(base, view, author)` replays a planned write as a
  ProseMirror transaction, rewrites it, and lowers it back to Yjs with `lowerBlock`.
- Server: the runtime's `workView(work, author)` is the one way to read or write a Work's view
  (a model and an agent-edit core over Live). `model` is Live's view for every Live reader.
  Card Undo calls `resolveStored(doc, schema, "reject", { turn })`.

## Known limits

- One transaction that splits off a block, gives it attributes and joins it away loses those
  attributes. No editor command or model op does that.
- `settle` (a block's attributes after an edit inside it) is called from `replaceInWork` as well
  as the driver: the one seam left.
- Toolbar state reads Live attributes, not the Work's pending ones; Enter in a block with a
  pending heading gives the new half the stored attributes.
- Typing into a block the Work removes is allowed and goes with the block on accept.
- Joining an added paragraph to a Live one leaves two paragraphs: Live text never moves into a
  block the Work added.
- A later turn's split of an earlier turn's block stays after the later turn is rejected (the
  wording comes back, in two paragraphs). Edits inside a table the Work added are real.
- Text the writer types inside a paragraph the AI added goes with it on reject.
- The editor repaints every decoration on each change.
