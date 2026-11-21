# Suggestions — a draft as marks in Live

## Stored shape

Schema 3.3.0 (`packages/prosemirror-schema`) holds it:

- `suggest_ins` and `suggest_del` marks on text, each `{ id, draft }` (`SuggestionAttrs`, the
  draft's 12-character id). `excludes: ""`, so two drafts can mark one word; the Yjs binding then stores each under
  `name--<hash>` (`yjsMarkKey`).
- `sug` on a block that exists only as one draft's suggestion, `{ id, draft }`. Every block inside
  it carries the same `sug`.
- `sugAttrs` on a block: the layers of pending changes to the block's attributes, by layer id
  (`AttrLayer`, `{ id, draft, layer, order, attrs, remove? }`). `remove: true` is the draft
  removing the whole block, which is how a block with no text is deleted. Yjs stores each layer
  as its own element attribute, `sugAttrs--<layer id>`, and ProseMirror sees the one record:
  `@meridian/prosemirror-schema` `layer-key.ts` folds and expands them, and the binding patch
  and agent-edit's lowering apply that rule, comparing layers by content so a layer left alone
  keeps its item. A draft's layers apply in `order`, then by layer id; an edit appends one layer
  per block (merging only into a layer the same edit added) and never rewrites a layer another
  edit wrote, so concurrent proposals on one block all stand. A layer key that is not a layer
  reads as none (`layersOf`).
- Who wrote each change, `{ chat, turn, by }` (`Author`), once per change id in the Y.Doc's
  `suggestion_authors` map beside the fragment. The pure code reads and writes it as `Authors`
  (`get`/`set`, a `Map` in tests); agent-edit's `suggestionAuthors(doc)` is the map on a Y.Doc,
  and reads an entry that is not an author as none (any client writes the map).
- How each resolve decided a change, in the Y.Doc's `suggestion_verdicts` map: one key per
  decision, `<id>:accept` or `<id>:reject`, value `true` (`suggestionVerdicts(doc)` in agent-edit).
  A key per decision, not a value per change, because two peers can resolve one change opposite
  ways at once and Yjs keeps both texts' deletions: both entries stand, and each Undo takes back
  only its own.

Yjs keeps a text mark as an item that opens it and one that closes it, which concurrent edits can
leave unpaired: the mark then runs to the end of the block, and an insertion's mark hides those
words from Live. Three rules keep the pairs (`apps/app/src/core/editor/.context/qa/offline-press.md`
checks them): the binding formats only the runs whose marks a local edit changed (y-tiptap
patch); Yjs no longer deletes the format items a delete or a remote change leaves redundant, which
a peer's concurrent insertion between them needs (yjs patch); and no item that opens a decided
change's mark stays live. A resolve deletes its own changes' openings in its transaction
(`resolveStored`), so its Undo brings them back. Each editing tab deletes, from what it receives,
any opening of a change with a verdict (agent-edit's `dropResolvedMarks`, wired in
`DocumentSession`): typing inside a change's text re-opens its mark after the typing, and a
concurrent resolve deletes the closing item. That sweep is why verdicts are never forgotten.
Ruled out: reading a decided change's marks as none instead of deleting them. Every reader of
marks (the binding, the server's projections) would need the verdicts, and the binding would
still write the difference back the next time the writer edits the paragraph.

A mark holds only what `kindOf` reads per run, because every changed word carries it on its
insertion and its deletion. `work` stays on the mark rather than in the map: the view is `{ draft }`
for any document, and a map lookup per run would make every reader's view depend on the document's
map. Change ids are 12 base-36 characters (`newChangeId`).
- `comment` marks an anchor (`markdown: false`: the model's Markdown never writes or removes it).

`id` is one change, the unit of review: an insertion and the deletion it replaces share it.
One edit is one change: every suggestion a rewritten transaction makes takes the first id it
picks (the same author's change it touches, or a fresh one, which `rewrite` stages on its
transaction under `STARTED_META`; the caller that applies the transaction records it in `Authors`
with `recordStarted`, so a dropped or refused edit leaves no entry). "Same author" and "same turn" are read from `Authors`; an id with no entry is no
one's, so an edit over it layers and never continues it. The model writes a block in one
transaction, so a write that rewrites two sentences of a paragraph is one change; each block it
writes is its own. An edit never takes another author's change (another turn or chat), even where
it rewrites that change's text: a later turn's rewrite is its own row in `list`.

## The view

`View` is `{ draft }`: `null` is Live, otherwise Live plus that draft's suggestions. `kindOf`
classifies each run of a block as `live`, `own-ins`, `own-del` or `hidden` (another draft's
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
`Authors`) or `{ draft }`, which stages how it decided each change it touches under
`DECIDED_META` (id → `accept` or `reject`): an accept's superseded changes as `reject`. Accept makes insertions Live, deletes deleted text, applies attribute
layers. Reject is the reverse. Either only deletes text and blocks and removes marks and
attributes: nothing it keeps is rewritten. Accepting a deletion rejects every other Work's change deleting the same text: the
first applied wins. A block the Work added that stays (accepted) still holds what later turns
layered on it. `list` gives the view's changes for review, each change's text joined with a space
where Live text separates its pieces; `pending` the turns and the Works
(with their change ids) that still have something to resolve.

## Who calls it

- Editor: `apps/app/src/core/editor/extensions/suggestion-mode/` runs every local transaction
  through `rewrite` and paints the view (`suggestion-paint.ts`): after an edit it maps the
  decorations and paints again only the top-level blocks whose content differs, read by
  diffing the documents, so the binding's whole-document redraw after Undo or a peer's edit
  repaints only what changed. Whether changes are marked is one attribute on the editor that
  the CSS reads. The review (`apps/app/src/features/draft-review/`)
  reads `list` from the editor's document, so the Changes list, the band, the change card and
  the phone's sheet draw a Work's suggestions as they drew a draft's.
- Model: agent-edit's `suggestingModel(base, view, author)` replays a planned write as a
  ProseMirror transaction, rewrites it, and lowers it back to Yjs with `lowerBlock`. A write plans
  on what the model was last shown (its frontier), less every suggestion the room records as
  rejected (`withdrawRejected`, called by `createPlanningView`, reads `suggestion_verdicts`):
  without that, the same rewrite asked for after a card Undo, a Discard or an inline Reject
  matched the model's view and changed nothing. The withdraw only deletes view items the room has
  deleted or replaced: the write ships the view's own updates to the room. A block's attribute
  layer is one item of its change and leaves with the change's text. An accepted change stays in the view, whose text is the same
  either way, and a change an edit removed has no verdict and stays too, as Live text the writer
  removed after the model's read does. `suggestionItems` there is the item-level twin of
  `pendingBy`: a change to how marks, `sug` or attribute layers are stored updates both.
- Edit list: `read(format: "edits")` says `applied` or `discarded` from the verdicts of the
  changes a write's own receipt bytes carry (`writeVerdict`), not the document's items, whose
  content a checkpoint drops once deleted; with none, or both, it reads the text.
- Resolving, everywhere: agent-edit's `resolveStored(doc, schema, verdict, filter)`
  (`model/stored-suggestions.ts`) runs `accept` or `reject` on the stored document, lowers the
  whole transaction from the root with `lowerResolved`, and writes the staged verdicts into
  `suggestion_verdicts` in the same Yjs transaction; it returns them (empty: nothing changed).
  The lowering is exact, not diffed: a kept node is visited, a deleted one is a delete, and the
  filler ProseMirror puts in where a delete would leave a parent invalid (an emptied document,
  cell or `jsx_container` gets an empty paragraph) is read from its step and inserted. A result
  that doesn't pair is a bug and throws. Every Yjs item the verdict keeps stays, so text typed
  inside a resolved word, a comment's anchor and a cursor keep their place. The
  tab's Apply and Reject (`acceptSuggestions`, `rejectSuggestions`) run it on the editor's
  Y.Doc as one writer edit (origin `DIRECT_WRITE_ORIGIN`, which the Undo history tracks), so Ctrl+Z takes back
  only it; the binding then redraws the editor. Card Undo runs it with `{ turn }`.
- **A verdict is undone with its text.** The tab's history
  (`apps/app/src/core/editor/editor-history.ts`) holds `resolveScope(doc)`, the fragment and the
  verdicts map, and the press's Undo forgets the entries its press wrote whose changes it made
  pending again (`forgetVerdicts`), never another client's entry. So an entry exists exactly while
  its resolve stands. An Undo that left an
  undone resolve's verdict standing would have the planning view withdraw a suggestion that is
  pending again.
- Press: Apply or Discard on documents, folders or a Work is a server command
  (`domains/collab/adapters/drizzle-press.ts`). `pressStored` runs `resolveStored` as one Yjs
  transaction and returns the blocks it changed, before and after, and the verdict entries it
  wrote. Its Undo is by content, as the card's is: each change that still stands is taken back
  out (`takeBack` in collab's `inverse-text.ts`), so a change the writer typed inside since stays
  as they left it. It reads no deleted item, whose content a checkpoint drops. A whole-Work press finds its
  documents among its project's and account's: those `pending_changes` lists for it where the
  derivation is current, and every one it hasn't caught up on
  (`apps/server/server/domains/collab/.context/press.md`).

## Readers

Every reader of a document's text reads a view: `viewBlock`, `viewDoc` for a whole document,
`visibleSlice` for a selection, `kindOf` and `visible` where positions in the stored document
matter. A view reads `live` and `own-ins` text, and no block that is another Work's or that the
view removes. The Markdown codecs throw on a suggestion mark, so a reader that skips the view
fails loudly; a reader of plain text does not, which is where to look for the next miss. The
server's one way to a view is the runtime's `model` (Live) or `draftView.model(work)`; the
browser's is `suggestionView(state)`, the view the editor shows, and `shownText(state, from,
to)` for a range's words with their positions back in the stored document.

| Reader | View | Why |
|---|---|---|
| Export, the frozen and Markdown reads, derived blocks and word counts, `ls -v` | Live | What the project is until someone applies |
| AI `read`, `grep`, copy from a Work | The chat's Work | The AI works on its own draft; `grep` skips stored text for a Work in `pending_changes` |
| Editor word count, search passage landing, link form and dragged link name | The editor's | What the writer is looking at |
| Trash preview, an untitled document's suggested name | Live | No Work's draft is open on it |
| The derivation's `document_hash` (behind `updated_at`) | Live | A Work's suggestion is not an edit to the document |

A passage landing resolves in the editor's view. A chat's own hit in a document it drafted opens
in its Work's view (`useOpenDraft` turns the sidebar's toggle to Draft); a hit opened anywhere
else reads in the view on screen, so text only a Work has reads as changed until the writer
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
- `settle` (a block's attributes after an edit inside it) is called from `replaceInDraft` as well
  as the driver: the one seam left.
- Enter in a block with a pending heading gives the new half the stored attributes. (The toolbar
  reads the view: `shownState` in the editor's suggestion mode.)
- Typing into a block the Work removes is allowed and goes with the block on accept.
- A Live paragraph does not join into a paragraph the Work added before it: Backspace at the
  Live paragraph's start, or Delete at the added one's end, only moves the caret to the added
  paragraph's end. Live text never moves into a block the Work added, or a reject would take it.
  The other way works: Backspace at the start of an added paragraph joins it into the Live one
  before it. A fix would move the added paragraph's text into the Live one as the same change,
  with the added paragraph's attributes (an added heading's level) as a pending attribute
  change on the Live one: two changes for one keystroke, which the review lists separately.
- A later turn's split of an earlier turn's block stays after the later turn is rejected (the
  wording comes back, in two paragraphs). Block edits inside a container the Work added (a
  table's rows, a `jsx_container`'s blocks) are real and belong to that container's turn.
- Text the writer types inside a paragraph the AI added goes with it on reject.
- A change the writer removed by typing (a pending AI insertion deleted, an applied one then
  deleted) has no verdict: an identical re-proposal from the same stale plan keeps the writer's
  deletion, as for Live text, and the next read shows the model the real text.
- Accepting a later layer trims an earlier kept layer of the keys Live now has: the one write
  that rewrites a layer in place. Two tabs accepting two later layers of one draft on one block
  at once each trim the same earlier layer, and one trim wins, so the earlier layer keeps a value
  Live already has and reads as still pending. Nothing is lost; the writer can discard it.
- Each attribute edit appends a layer (about 120 bytes) until it is resolved: changing one
  block's heading five times leaves five layers.
- Rejecting an earlier turn's change first leaves a later turn's insertion over it standing
  beside the restored text ("Alpha one1"): the review lists it as that turn's own change, to
  discard. Kept on purpose: taking it with the earlier reject would drop a later turn's work
  the writer did not reject.
- Typing that continues a change (the writer's own earlier suggestion) offline while another
  client resolves it loses its marks when the tab reconnects (`dropResolvedMarks`): an insertion
  stays as Live text, a deletion is dropped. Ctrl+Z of a tab's inline resolve, when a peer had
  typed inside the change concurrently, leaves the change's text after that typing unmarked; the
  press's Undo, by content, does not.
- Enter pressed offline inside a paragraph undoes a concurrent change to the text after the caret
  (a resolve's deletions come back): the binding writes the tail again as new items. Not specific
  to suggestions ([#1827](https://github.com/haowjy/meridian-flow/issues/1827)).
- A verdict entry is never removed, except by an Undo of the resolve that wrote it; an author
  entry only by `dropDraft` when its draft's Work or chat is purged: a change that is accepted, rejected or deleted keeps its entry in `suggestion_authors` (about 60
  bytes each), and each decision about 44 bytes in `suggestion_verdicts`. Typing never writes
  the verdicts.
- Live's history keeps each suggestion's item skeleton after a checkpoint, including its item id,
  so a later edit can still integrate against that item. Checkpoint materialization runs
  `dropUnseenContent`: it collects the text, marks and subtrees of deleted items unless the room's
  latest model-read frontier still shows them. Live content that has not been deleted remains, but
  a discarded or otherwise deleted suggestion's words are not kept forever.
