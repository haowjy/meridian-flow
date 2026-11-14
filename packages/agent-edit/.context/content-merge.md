# The content merge: its rules, repairs, rescues and known losses

`src/content-merge/` merges a draft's blocks with live's. The server runs it on a Work's pull
and on Apply and un-Apply; the browser runs `applyBase` to fold queued clicks. This page lists
everything in the system that changes document text other than a person's or a model's own edit,
and everything that gives text back. Adding a merge rule, a repair or a rescue is the owner's
decision; `rules.ts` is the one place a rule's name is declared, so a new one is a visible
one-line change.

## The rule

Where the merge cannot tell what each side meant, **the draft wins, as one counted clash**.
Live's change there shows in review as a difference from the review base, and the writer can take
it. No rule drops a word the draft has, and no rule drops a word live wrote except through the
clashes below. The oracle in `merge.test.ts` follows each word through a merge and fails on one
lost, doubled or invented.

A **plain merge** is diff and patch with no choices: a change only one side made applies, and the
same change on both sides applies once. A **merge rule** is anything the merge does beyond that.

## Where the code is

`content-merge/` depends on `diff/` (tokens, `align`, `correspond`, `buildBlocks`), never the
other way. Import it as `@meridian/agent-edit/content-merge`: `contentMerge`, `applyBase`, `RULES`.

`contentMerge(schema, base, live, draft)` returns `{ blocks, rules, overrode, conflicts, orderConflict }`.
`rules` is the rule name to the number of times it fired in that merge. It carries no text.
`overrode` is the count of live's words the draft replaced in contested text, and it overstates
that when the draft deleted words live never touched. `conflicts` holds the clashes with their
tokens for the tests' oracle and does not leave the package. Every block it returns has an id (a
paragraph it makes from nothing gets a fresh one, so `writeBlocks` never throws on its output).

Counts reach the server's event sink as `merge.counted` (source `collab.draft_pull`) and
`apply.merge.counted` or `unapply.merge.counted` (source `collab.draft_review`). Apply and un-Apply report the sum over the click's
groups.

Order of work in `merge.ts`: pair blocks by id (`correspond`), unify blocks both sides added
(`unifyAdded`), settle the stretches that cannot be trusted to the token merge (`settleStretches`),
merge attributes, merge block order (`mergeOrder`), align both sides to base as tokens, lift
moved text, then group the touching hunks into clusters and decide each, and last put whitespace
back (`settleWhitespace`) and build blocks (`buildBlocks`).

## Merge rules

"Case" is a row of `CASES` in `merge.fixtures.ts`. The test fails when a row fires a rule it does
not list, or lists one it does not fire.

**Where both sides changed the same place**

| Rule | What it does | Code | Case |
|---|---|---|---|
| `draft-wins-text` | Both sides changed the same words differently: the draft's text stands. Covers a rewrite against a delete | the clash branch of `merge.ts` | `word-conflict`, `replace-vs-delete` |
| `whole-block-unit` | A figure or table is one token, so a change on both sides is one clash and the draft's whole block stands | same branch | `table-column-vs-row` |
| `containers-merged` | Both sides changed a table kept as the same shape: rows and cells merge one by one, at every depth. Falls back to `whole-block-unit` when the shapes differ or the result is not a rectangle | `mergeContainers` | `table-cells` |
| `draft-wins-stretch` | One side removed a block the other changed, or both changed which blocks are at one place (a split, a join, a move-in): the draft's blocks stand there | `settleStretches` in `stretch.ts` | `id-far-addition` |
| `block-attributes-merged` | A block both sides kept takes each attribute from the side that changed it, the draft's where both did | `mergeAttributes` | `heading-vs-heading` |

**Where both sides added or moved text**

| Rule | What it does | Code | Case |
|---|---|---|---|
| `insertions-kept-both` | Both sides inserted at one point: both stay, live's first; a word both typed stays once | `unionInsertions` in `merge-settle.ts` | `insert-different` |
| `same-block-added-twice` | Both sides made the same block at one place (equal but for ids): one block, with live's id | `unifyAdded` | `id-typed-twice` |
| `marks-merged` | Both sides only reformatted one word: each mark comes from the side that changed it | `mergeMarks` in `merge-hunks.ts` | `bold-vs-italic` |
| `shared-edge-kept-once` | One side inserted words the other side's replacement also starts or ends with: kept once. Off, words double | `peel` | `shared-edge-kept-once` |
| `typed-at-end-of-deleted` | Words typed at the end of a paragraph the other side deleted are a clash, not a join onto the paragraph before. Off, a word is joined onto a paragraph neither side joined it to | `typedAtEndOfDeleted`, through `touch` | `typed-at-end-of-deleted` |
| `moved-text-dropped` | Live cut and pasted text (3 or more words, or a whole inserted run) whose source the draft changed: live's paste is left out and the draft's text stays at the source. The draft's own paste of text live changed stays and is not counted | `dropMovedText` | `live-moves-sentence-draft-edits-it` |
| `neighbouring-changes-joined` | Two one-sided changes within three unchanged tokens are one change the two diffs placed differently. Off, words double | `coalesce` | `neighbouring-changes-joined` |

**Block order**

| Rule | What it does | Code | Case |
|---|---|---|---|
| `moved-paragraph-keeps-edits` | A block one side moved is paired with its old self by id, so the other side's edits go with it | `mergeOrder` in `merge-order.ts` | `id-draft-moves-live-deletes` |
| `draft-wins-order` | Both sides moved one block to different places, or the two orders cannot both hold: the draft's order | `mergeOrder` | `move-move` |

**Whitespace.** A token carries the space before it, so a patch has to pick one. Taking it from a
side where the same two tokens are neighbours is how the patch is put back, not a choice.

| Rule | What it does | Code | Case |
|---|---|---|---|
| `draft-wins-space` | Both sides changed the space before one word differently: the draft's | `settleWhitespace` | `draft-wins-space` |
| `space-added-between-words` | Two words no side had side by side get one space, except in scripts written without spaces | `settleWhitespace` | `coords` |

**Shape** (`buildBlocks` in `diff/tokens.ts`; review's `composeHunks` shares it and does not count)

| Rule | What it does |
|---|---|
| `mark-dropped` | A mark the merged block's type cannot hold is dropped |
| `inline-moved-out` | An inline node the block cannot hold moves to a new paragraph after it |
| `stray-inline-wrapped` | Inline content with no paragraph to hold it gets one |

These three fired in no case and in none of 60,000 generated merges, because the generator has no
such blocks. Each keeps content and changes shape, so each stays, counted, with no case row, until
a count from production says it never fires.

**Not rules, and not counted**

- `draftAbsorbsLive` decides that an overlap is no clash because the draft's text already holds live's
  change. It is part of how `draft-wins-text` counts.
- The diff's own choices of where a change sits (`align`: `separateBlocks`, `canonicalize`,
  `refine`) run on every diff, review's too.
- The size limits (`coarse-diff`: a paragraph or run of changed paragraphs past 1,000 tokens, a
  diff past 4,000 keys, pairing past 40,000 block pairs) turn a diff into one whole replacement, so a
  change on both sides is one clash and the draft's text stands. `diff/tokens.ts` and `diff/align.ts`
  apply them and the merge does not count them yet.

## Mechanics of some rules

Blocks pair by id first: see "Block correspondence: by id" in [diff review](diff-review.md).

### Block attributes: `block-attributes-merged`

Before the token merge (`mergeAttributes`), a block both sides kept (paired by id,
one type on all three) takes each attribute from the side that changed it, and the draft's where both
changed it to different values (one `attributes` conflict for the block). The three versions then
carry the same attributes, so the token merge sees none changed and a text edit or an inserted block
beside it merges as if no attribute had changed: live indents an item and the draft checks it, and
both land. A block one side removed is left to the token merge. A table's rows and cells are not
reached (`mergeContainers` has its own attribute rule).

A removal of several blocks is one removal per block in the merge, so one side's removal of a
run meets the other side's edit or removal of each block separately. A run of removed blocks and
a run of added blocks between two units are a removal and an addition after it, so a side that
removed what the other also removed and added something else keeps what it added. A shared edge
of two replacements is kept once only inside one block (`shared-edge-kept-once`): two paragraphs
that end in the same word do not share it. A hunk keeps the side range it came from
(`sfrom`..`sto`); a filter such as moved-text dropping changes its payload and `sidx`, never its
range.

What stays doubled: text one side carried out of a block into another place (a cut and paste, a
split then a join) while the other side changed the block it came from. Characters have no id across
a draft and live, so the draft's paragraph stands and the carried text is in the result twice; review
shows the draft's paragraph as an addition the writer can refuse. `moved-text-dropped` is as it was
(three words, where live's pasted text meets a source the draft changed).

### Stretches: `draft-wins-stretch`

Where one side removed a block the other changed, or both changed which blocks there are at one
place, the draft's version of that stretch stands as one counted clash, and the merge never combines,
doubles or silently drops words. `settleStretches` (`stretch.ts`) runs before any token
merges. It lays each side's correspondence over the base: every block of a side sits in a base
block's place or in a gap, and the places it changed are text (paired in place, differs), removed, or
restructured (split, joined, moved, or added in a gap). Two sides' changes clash where they meet
and the token merge cannot be trusted with them:

- at a base block: one side removed the block and the other changed it in any way, or both
  restructured it, or one side split or joined a container (a table row) that the other
  changed: a container is one token to the token merge, so an edit cannot travel into its pieces
  as it does into a paragraph's;
- at a gap inside a join: the other side has anything there.

Text against text, text against a split, a join or a move of that block (the edit travels with
the block), additions by both sides at one gap, and removals of different blocks are left to the
token merge. A paragraph the draft moved and live deleted stays where the draft put it, with a clash;
live moved and the draft deleted stays removed. A stretch is the changes joined by clashes; where
both sides hold the same blocks in it in the same places (a moved base block's place is the order
merge's), it is no clash. Otherwise the draft's blocks stand, live is handed on with its changes to
the stretch undone (the base's blocks in place), one conflict is recorded with the base blocks it
covers, and live's words the draft lacks count under `overrode`. Live is set back to the base
rather than to the draft's blocks: copying the draft's blocks in doubled them when the sides
also disagreed about order.

A block rewritten in place keeps its id, so both sides' edits to it go to the token merge (live's
new sentence with the draft's appended word, no clash); a block deleted and another typed in its
place is two blocks, and the draft's edit of the deleted one brings it back beside the new one with
one clash.

Move-text matching checks whether the other side touched a source or pasted the same text
only after selecting the globally longest run. Filtering sources first would change the
winner and can silently lose moved words. Both the modifying and report-only passes use this
ordering.

## Repairs

A repair is a write nobody asked for, made so a document is one the editor can show. It may remove
text. There is one: the **binding's schema repair**, in `y-prosemirror`'s `sync-plugin.js`. It
deletes an element the schema cannot build, and folds an adjacent text run the reading client
made into its neighbour. It fires wherever ProseMirror nodes are built from Yjs.

- **Where it fires, and its count.** `schemaRepairCounts()` (`@meridian/agent-edit`,
  `model/schema-repair.ts`) returns how often it fired in this process under three paths:
  `editor` (the witness in `apps/app/src/core/editor/schema-repair-witness.ts` counts its own
  repairs with `countSchemaRepair("editor")`), `projectBlocks` (`model/y-prosemirror.ts`) and
  `readBlocks` (`diff/fragments.ts`). The last two read through `readRepairedRoot`, which counts a
  read that deleted something once. A read that repairs nothing is not counted.
- **On the server.** The repair reaches the room as an ordinary Yjs update. `isSchemaRepairUpdate`
  recognises it (the update adds nothing, and every item it deletes is, or sits inside, an element
  whose node name the schema lacks), and `yjs-ws-handler.ts` journals it with a system origin: no
  actor and no edit row. A repair of an element the schema knows but refuses the content of (a
  block inside a paragraph) is not recognised, and journals as the writer's own update.
- **In the editor.** The witness reports the removed words, and the "Some text was removed" bar
  shows them with Copy, so the text is not silently gone (see Rescues).

## Rescues

A rescue gives typed text back to its author after something else took it away. It never removes.

- **Late typing**, on the server: `diff/late-peer.ts` finds typing a pull deleted or re-created
  under it, and `diff/late-peer-recovery.ts` writes it back with the typist's byline or none.
  `draft-runtime.ts` and `draft-receipts.ts` call them.
- **The schema witness's removed text**, in the browser: when the binding's repair removes text, the
  witness (`schema-repair-witness.ts`) reports the removed prose so it is not silently gone.
- **A closed draft's "Copy unsent text"**, in the browser: the writer takes the text a closed draft
  never delivered.

## Other writes that are not merges

- **The rebuild** (`diff/writer.ts`, `writeChildren`): a block with no minimal edit is deleted and
  re-created. It never changes the text, only which Yjs items hold it. `WriteStats.replaced` counts it
  and no caller reads it.
- **The empty-document convention**: an empty fragment and one empty paragraph are one document,
  because the editor cannot show zero blocks (`diff/equal.ts`, `buildBlocks`).

## Known losses

Each is a row in [EDGE-CASES][edge], left as it is because no fix exists at its cause.

- A sentence live moved between paragraphs, while the draft changed its source, appears twice after
  the merge; review shows it (28 of 3,000 generated merges). Text one side carried out of a block
  while the other changed the source block does the same (34 of 3,000). Two similar
  but unequal paragraphs typed once on each side are two blocks.
- Where the merge cannot tell (one side removed a block the other changed, both changed which blocks
  are at one place) the draft's stretch stands as one counted clash, so live's edit near it can be
  undone with the clash (`draft-wins-stretch`).
- Where both sides changed one table and the shapes differ, live's change to a cell the draft also
  changed loses to the draft's whole table (`whole-block-unit`).
- A join across a block that moved is not read as a join: the other block is removed and its words
  go to the first.
- One merged list had one id on two blocks, once in 24,000 generated merges, with a ten-word
  vocabulary.
- Yjs: a cut-and-paste racing an edit of the cut text doubles it; offline typing into a run another
  person deletes beside an image is lost; a paragraph split while someone types in it re-creates the
  text under the splitter's byline.
- The model rewriting a paragraph so that no word survives while a person types in it rebuilds the
  paragraph and loses the typing.
- A closed or removed room's local copy is cleared with the room, so text typed into a Work's
  draft room and not delivered is lost if its Discard is undone after the room closed.

[edge]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/release-coordination/EDGE-CASES.md
