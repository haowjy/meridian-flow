# features/chat — What tool expands show

What opens behind a row's chevron. The row itself is
[activity-row-anatomy.md](activity-row-anatomy.md).

Raw JSON stays out of chat: renderers produce titles, listing rows, quoted previews and
terminal tails, and raw payloads belong behind a dev-only setting. Generative
(model-authored) rendering is not implemented.

Renderers are keyed by tool name, and a renderer doesn't switch on the command:
`tool-command.ts` classifies it and `command-descriptor.ts` says what to do.

Work mutation rows are records built from the server's `metadata.workReceipt`. Their
reversal lives on the turn edits receipt, because the reversal seam is turn-scoped and
turn lineage owns Undo authority.

A grep hit and a listing entry are both `{uri, …}`, so a payload can't be asked what it
is: guessing from the first recognizable entry discards every later row that disagrees.
The caller knows the tool, so it calls that tool's normalizer.

## Three channels

| Channel | Question | Surface | Source of truth |
|---|---|---|---|
| Process | What did the agent do? | Tool rows in the fold | Turn blocks |
| Intent | What did it look at, or mean to write? | Row expands | Tool input and the typed read result |
| Outcome | What changed in my manuscript? | Turn edits receipt | Lineage and inverse receipts |

A write expand reads `tool.input.content`, never the content: the content is what the model
saw, the typed result is a receipt, and a write can succeed as a tool call and still be
superseded downstream. Rendering its output as a change would assert something that may
not have landed.

The diff palette doesn't appear here, because those tokens mean a real, persisted change.
Intent and outcome are told apart by material, not a label.

## Contents

A copy, `move`, `delete`, `remove`, `undo` and `redo` have no expand; the title carries
the source. `delete`'s title has no door, since the old address may hold another document.
`read` shows the passage that came back, `create`/`insert`/`replace` the submitted
content, and `ls` a record of what the model received: the tree panel already browses, so
folders carry no affordance.

A failed document tool shows why it failed in place of its usual expand. A refused `move`
or `delete` is worded from its typed `refusal`. A failed `grep` or `ls` opens onto
nothing. Whether every failure deserves an expand is an open design question.

`read-payload.ts` reads the typed `meridian.agent-edit.v1` result and never parses the
model's text, so a `|` in the writer's prose is left alone. Targeting is resolved
server-side, so the rule is "show the top of what came back" for every read.

An outline is a discrete list, not prose: it takes the listing cap and a count, with no
fade or second door.

## The grep card

Eight passages loose in the transcript would read as eight more actions, so the result
set gets one contained surface, with a rule between documents.

- The header carries the totals and doesn't repeat the query: the `Searched ‹query›` row
  title sits directly above it. When results and documents are equal it drops to
  `3 documents`.
- The bound line (`4 of 42`) is documents shown of documents matched, and appears only
  when the list was cut.
- The count badge is per document and always present, because a blank cell in a column
  reads worse than a `1`. It counts the whole document, so it stays honest when the
  server's cap clipped the list. A hit without a positive count or a passage is refused
  at normalization, so downstream code takes the shape as given.
- `N more` sits after the passage it extends, so reading, DOM and focus order agree. It
  grows inline, with no nested scrollport.
- The matched term carries the door's underline and hover, and the whole row is the click
  target: one button per passage, never a control inside a control.
- A passage with no anchor isn't a door: non-manuscript schemes carry no block hash. The
  door doesn't pre-check that its passage survived; `core/editor/passage-navigation.ts`
  lands on the block or a single re-found occurrence, or says it changed. It never guesses
  among duplicates.
- Every door retires the last one, so a resolution the writer clicked past can't land
  behind them. Ownership advances at the door boundary
  (`features/project/chat/usePassageDoors.ts`), not per passage row.

Hashes travel in their own field and excerpts arrive as prose, so no renderer parses the
hashline format.

## Bounds

`ClippedExpand.tsx` owns both ways an expand is cut.

- Continuous prose clamps by height and fades its bottom edge, with no count.
- Discrete lists cap by item count and state the rest as a fact. Listings and outlines
  cap at 8; search hits cap at 4, because each is three lines.

A stream tail is bottom-pinned with a top fade, because for a running command the newest
output wins. A preview is the opposite. Reusing a tail here shows the end of the chapter.

Clipped prose gets a second door at the fade, `Open ‹Document›`. "Show more" would promise
more of a finite payload, and the document is a larger and different thing.

Every clamp is `overflow: hidden`, because the transcript is the single scroll owner.

Previews render through `text-tier-quoted`, which demotes headings and drops the editor's
block margins, so a chapter title inside a preview can't outrank the assistant's own
voice.
