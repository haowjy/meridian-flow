# agent-edit TODO

## One save sequencing

A save still has two sequencings, and model inverses commit outside the port. The
reply save (and the pool's draft one-entry reply) prepares, persists inside the
pool's transaction and reports before commit (`response-committer.ts`); the
immediate save, `saveNow` in `tool/document-save.ts`, persists in a transaction
`appendBatch` owns and reports after durability. Undo, redo and revert journal and
deliver through collab's `drizzle-turn-inverse.ts`. So every save-time concern
lands once per path, and a drafted agent write outside a reply carries no
save-time "only if empty" precondition, which only `saveNow` passes.

Unify them: have `saveNow` run the reply path's prepare, persist and report inside
one transaction the host owns, and route inverses through `prepareSave`.

## Stale-view writes into structural blocks

A write planned on the model's view and lowered into a quote, list item, verse,
paragraph with a hard break or an image, code block or table is diffed against the
stale view, as if the writer had deleted nothing since. A model insert beside a line
the writer deleted lands split (`> A disciple.2. DRAFT-B SIDETEXT`), a rewrite can
bring the deleted line back, and a change to a word the writer retyped lands inside it.
This includes a paragraph whose line break or inline image the writer deleted: the
editor retypes the text after it, and the model's view of the block was not flat.
Plain paragraphs and headings are decided by `withoutRemovedUnits`. Dropping the room's
deletions from the view before the structural diff makes it worse: the character diff
then places the model's text at the dropped run's edge, beside what the writer typed
there, ordered by client id (`> He sigh loudlys.`). The fix is to apply the rule's
landed changes as exact positional edits into nested text with the deletions kept, and
use a structural diff only for changes that create or remove node edges
([#1363](https://github.com/haowjy/meridian-flow/issues/1363)).

## Deletes that land after a write read its room

A flat block rewrite is decided against what its room copy has deleted
(`withoutRemovedUnits`), but only what the copy holds when the call reads it. A
delete that lands later still meets a lowering that kept those units. For a draft
write the window runs from the call's room read to the step's save: the rest of the
model step, its generation and later tool calls included, seconds to minutes. For a
direct save it is the time to the save. Find writes into a paragraph or heading are
placed by their windows and survive it; other rewrites can split. The rule is a pure
function of the two blocks and the deleted units, so the fix is to run it again at
save time against the room the update merges into.

## Formatting in a paragraph the writer deleted from

When the model changes bold, italics, a link or a paragraph's attributes in a flat
paragraph that has room deletions, the paragraph is lowered as if there were no room,
so text the writer deleted there can come back as the model's. Deciding it by the rule
needs the splice path to carry format ranges applied on the view with its deletions
left in. That is a format-only replacement through `ResolvedEdit`,
`applyInlineReplacements`, `editSegments`, the semantic IR and server provenance, which
mark only text replacements today. A structural diff on a view with the deletions
dropped is not the answer: there the model's bold extends over text the writer typed
over a deletion beside it when the model's client id is higher (`He **sighed loudly**.`).

## Blocks a write removes and adds

A write that removes a block and adds another (merging or splitting top-level
paragraphs, a paragraph turned into a heading) is not decided against room deletions:
the writer's typing in the removed block goes, and text deleted from it can come back
in the added one. Covering it means deciding the replaced scope as one sequence, block
edges included, in `replaceScope`'s alignment.

## Changes the room added

The rule sees what the writer deleted, never what they added. A pasted sentence can
keep letters of the old one, which a model delete then takes (`MinKeep end.`), and a
landing change cannot tell a plain delete from typed-over text, which is why a change
that covers any deleted unit is skipped. Both need the port to also report where the
room holds text the view lacks.

## Deferred until earned

- Remove the remaining ProseMirror shape coupling from parsed-content types;
  the live-doc side already uses the neutral `AgentEditModel` seam.
- Freeze a public `DocumentPort`/`HistoryPort` after a second implementation
  reveals stable contracts.
