# Suggestions — a Work's draft as marks in Live

## Stored shape

Schema 3.3.0 (`packages/prosemirror-schema`) holds it:

- `suggest_ins` and `suggest_del` marks on text, each `{ id, work }` (`SuggestionAttrs`).
  `excludes: ""`, so two Works can mark one word; the Yjs binding then stores each under
  `name--<hash>` (`yjsMarkKey`).
- `sug` on a block that exists only as one Work's suggestion, `{ id, work }`. Every block inside
  it carries the same `sug`.
- `sugAttrs` on a block: by Work, one layer per turn of a pending change to the block's
  attributes (`{ id, work, attrs, remove? }`). `remove: true` is the Work removing the
  whole block, which is how a block with no text is deleted.
- Who wrote each change, `{ chat, turn, by }` (`Author`), once per change id in the Y.Doc's
  `suggestion_authors` map beside the fragment. The pure code reads and writes it as `Authors`
  (`get`/`set`, a `Map` in tests); agent-edit's `suggestionAuthors(doc)` is the map on a Y.Doc,
  and reads an entry that is not an author as none (any client writes the map).

A mark holds only what `kindOf` reads per run, because every changed word carries it on its
insertion and its deletion and Live's history keeps it for good. `work` stays on the mark rather
than in the map: the view is `{ work }` for any document, and a map lookup per run would make every
reader's view depend on the document's map. Change ids are 12 base-36 characters (`newChangeId`).
- `comment` marks an anchor (`markdown: false`: the model's Markdown never writes or removes it).

`id` is one change, the unit of review: an insertion and the deletion it replaces share it.
One edit is one change: every suggestion a rewritten transaction makes takes the first id it
picks (the same author's change it touches, or a fresh one, which `rewrite` records in
`Authors`). "Same author" and "same turn" are read from `Authors`; an id with no entry is no
one's, so an edit over it layers and never continues it. The model writes a block in one
transaction, so a write that rewrites two sentences of a paragraph is one change; each block it
writes is its own. An edit never takes another author's change (another turn or chat), even where
it rewrites that change's text: a later turn's rewrite is its own row in `list`.

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
  `suggest_ins`. Removing an earlier turn's whole block treats it as a removed Live block: a
  `remove` layer, its text under the later turn's `suggest_del`. So `reject({ turn })` of the
  later turn, the card's Undo, brings the earlier wording back. Text the same turn wrote, and
  anything the writer removes, really goes. Attributes do not layer: a later turn that makes an
  earlier turn's paragraph a heading sets it directly, and its Undo leaves the heading.

In the Live view, edits land as typed, but hidden suggestions stay where they are and nothing
pasted carries a suggestion. `CHANGE_META` reports, per replaced range, the change an edit took;
agent-edit pairs a split's new block with it.

## Resolving: `accept` and `reject`

Each is one local transaction (`RAW_META`), filtered by `{ id }`, `{ turn }` (read through
`Authors`) or `{ work }`. Accept makes insertions Live, deletes deleted text, applies attribute
layers. Reject is the reverse. Either only deletes text and blocks and removes marks and
attributes: nothing it keeps is rewritten. Accepting a deletion rejects every other Work's change deleting the same text: the
first applied wins. A block the Work added that stays (accepted) still holds what later turns
layered on it. `list` gives the view's changes for review; `pending` the turns and the Works
(with their change ids) that still have something to resolve.

## Who calls it

- Editor: `apps/app/src/core/editor/extensions/suggestion-mode/` runs every local transaction
  through `rewrite` and paints the view. `SuggestionBand.tsx` is a throwaway review surface.
- Model: agent-edit's `suggestingModel(base, view, author)` replays a planned write as a
  ProseMirror transaction, rewrites it, and lowers it back to Yjs with `lowerBlock`.
- Resolving, everywhere: agent-edit's `resolveStored(doc, schema, verdict, filter)`
  (`model/stored-suggestions.ts`) runs `accept` or `reject` on the stored document and lowers
  each changed block with `lowerResolved`: the exact deletes, unmarks and attribute changes,
  paired through the transaction's mapping, not diffed. Every Yjs item the verdict keeps stays,
  so text typed inside a resolved word, a comment's anchor and a cursor keep their place. The
  tab's Apply and Reject (`acceptSuggestions`, `rejectSuggestions`) run it on the editor's
  Y.Doc as one writer edit (origin `ySyncPluginKey`, `addToHistory`), so Ctrl+Z takes back
  only it; the binding then redraws the editor. Card Undo runs it with `{ turn }`.
- Press: Apply or Discard on documents, folders or a Work is a server command
  (`domains/collab/adapters/drizzle-press.ts`). `pressStored` runs `resolveStored` as one Yjs
  transaction and returns its inserted and deleted id ranges; `undoPressStored` takes those
  ranges back as a Yjs undo, the same undo Ctrl+Z is in the tab. A whole-Work press finds its
  documents through `pending_works`.

## Readers

Every reader of a document's text reads a view: `viewBlock`, `viewDoc` for a whole document,
`visibleSlice` for a selection, `kindOf` and `visible` where positions in the stored document
matter. A view reads `live` and `own-ins` text, and no block that is another Work's or that the
view removes. The Markdown codecs throw on a suggestion mark, so a reader that skips the view
fails loudly; a reader of plain text does not, which is where to look for the next miss. The
server's one way to a view is the runtime's `model` (Live) or `workView.model(work)`; the
browser's is `suggestionView(state)`, the view the editor shows, and `shownText(state, from,
to)` for a range's words with their positions back in the stored document.

| Reader | View | Why |
|---|---|---|
| Export, the frozen and Markdown reads, derived blocks and word counts, `ls -v` | Live | What the project is until someone applies |
| AI `read`, `grep`, copy from a Work | The chat's Work | The AI works on its own draft; `grep` skips stored text for a Work in `pending_works` |
| Editor word count, search passage landing, link form and dragged link name | The editor's | What the writer is looking at |
| Trash preview, an untitled document's suggested name | Live | No Work's draft is open on it |
| The derivation's `document_hash` (behind `updated_at`) | Live | A Work's suggestion is not an edit to the document |

A passage landing resolves in the editor's view, which can differ from the view the search ran
in: a Work's hit in text the editor shows only in Draft reads as changed until the writer
switches. A code block takes no marks, so its text holds no suggestion.

Read from the stored document on purpose, because none of them shows text as the document's:
`document_links` (ahead-ref registration needs every Work's links), the view revision
(a freshness token over the whole document, so another Work's suggestion marks a read stale),
rescued typing and unsent edits (the writer's own items, by Yjs id), and the Live turn inverse
(it captures and takes back stored blocks, marks included, so it is consistent with itself;
a later Work suggestion inside the range makes the change stop standing, and Undo skips it).

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
  wording comes back, in two paragraphs). Block edits inside a container the Work added (a
  table's rows, a `jsx_container`'s blocks) are real and belong to that container's turn.
- Text the writer types inside a paragraph the AI added goes with it on reject.
- The editor repaints every decoration on each change.
- Live's history keeps every suggestion for good. A 4,200-word chapter (24 KB of history)
  stores about 400 KB per whole-chapter AI rewrite (30% of words changed) and under 1 KB per
  discard; ten discarded rewrites come to 3.9 MB (A2, measured as B2 did; with the earlier
  `{ id, work, chat, turn, by }` marks and diffed resolves it was 7.5 MB). What is left per changed
  word is Yjs structure: the new text, and a format item at each edge of its insertion and its
  deletion, each holding the mark's key and `{ id, work }`. Dropping `work` from the mark would
  save about another 20%.
