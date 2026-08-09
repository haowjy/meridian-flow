# features/chat — Tool rendering tiers and what expands show

How a tool call becomes a row, and what opens behind that row's chevron. The
row's own anatomy (doors, glyph, verb, tone) lives in
[activity-row-anatomy.md](activity-row-anatomy.md); this page owns the
rendering tiers and the expand contents.

## Three tiers of tool rendering

| Tier | What it is | What it renders |
|---|---|---|
| 1 · default | An unregistered tool | The humanised tool name, one line. No expand, no destination. |
| 2 · registered | The entries in `tool-renderers.tsx` | A per-command title plus curated expand contents. |
| 3 · generative | Model-authored React | Not implemented. |

**Never expose raw JSON in default UX.** Renderers produce curated content:
titles, listing rows, quoted previews, terminal tails. Raw payloads are a
debugging concern and belong behind a dev-only setting, never in chat.

Tier 2 is keyed by **tool name**, but one `write` tool carries reading,
skimming, creating, editing, reverting and reviewing. Which of those a row is
comes from `tool-command.ts`, and what to do about it comes from
`command-descriptor.ts`, including the expand's shape. A renderer never
switches on a command itself.

**Work rows are receipts.** A `work` mutation's row title is the server's
receipt line (`metadata.workReceipt.line`, carried on the tool result), worn
verbatim minus its terminal period — it is already the factual sentence, in
Work names. Reads keep one minimal generic row; failures title with the
failure verb and open onto the structured message. A mutation receipt's
`inverse` (`workReceipt` in `tool-command.ts`) makes create/update/delete
reversible, and that action lives on the turn edits receipt, not on this row:
the reversal seam (`/api/threads/:id/context/reverse`) is turn-scoped and turn
lineage owns Undo authority. Switch receipts remain factual rows with
`inverse: null`; they never create an Undo card. This row stays a record.

**The tool picks the parser.** A search hit and a listing entry are both
`{uri, …}`, so a payload cannot be asked what it is: guessing from the first
recognizable entry discards every later row that disagrees. The caller knows
the tool, so it calls that tool's normalizer; the parsed row's own discriminant
then decides how it renders.

## The three channels

The timeline separates what the agent *did*, what it *meant*, and what
*changed*. Expands are the middle one, and keeping them there is what stops the
transcript from claiming things it cannot stand behind.

| Channel | Question | Surface | Source of truth |
|---|---|---|---|
| Process | What did the agent do? | Tool rows in the fold | Turn blocks |
| Intent | What did it look at, or mean to write? | Row expands | Tool **input** and read output |
| Outcome | What changed in my manuscript? | Turn edits receipt | Change trail |

**A write expand reads `tool.input.content`, never the output.** The output is
formatted status plus diagnostics; only the input holds exactly what was sent.
A write can succeed as a tool call and still be superseded downstream, so
rendering its output as a change would assert something that never landed.

**Never the diff palette here.** Those tokens mean a real, persisted change,
which is the receipt's claim. Intent and outcome are told apart by material
(recessed quoted surface versus bordered receipt chrome), never by a label:
the UI says neither "intent" nor "outcome".

## What each expand shows

| Command | Expand | Cut by | Doors inside |
|---|---|---|---|
| `read` | The passage that came back, as quoted prose | Height, with a fade | The document, at the fade |
| `read format:outline` | The headings it saw, indented by depth | The listing cap, with a count | None; the row title's door serves |
| `create` / `insert` / `replace` | The submitted content, on the recessed surface | Height, with a fade | The document, at the fade |
| `undo` / `redo` / `diff` | Nothing | — | — |
| `search` | A result card: totals, then a section per document | The document cap, with a count | Each matched passage |
| `ls` | Listing rows: name plus glyph | The listing cap, with a count | Each document; folders are inert |
| `invoke` | Output tail, or one of two availability failures | The tail's own bound | — |
| unknown | Nothing | — | — |

A **failed `write`** always shows why it failed, in place of whatever the
command would otherwise have opened onto. No other tool has a general failure
expand: `invoke` recognises two availability failures and shows nothing for the
rest, and a failed `search` or `ls` opens onto nothing at all. Whether every
failure deserves an expand is an open design question; do not invent an answer
in a renderer.

An outline is a **discrete list, not prose**: it takes the listing cap and
states a count when cut. It gets no fade and no second door, because those
belong to continuous prose, where the need to see the rest arrives only after
reading. A clipped outline is already answered by the door in the row title.

Read payloads arrive as hashlines, and outline reads interleave locator lines
the model uses to read further. Both are addressing machinery and are stripped
in `read-payload.ts` before any renderer sees them. That module reads through
`splitHashline`, not the anchored stripper: this payload was serialized by this
system, so the reader that inverts the writer is the correct one, and an empty
hash would otherwise leak its separator into the writer's prose. Targeting is resolved
server-side, so a scoped read's payload already *is* the region asked for: the
preview rule is "show the top of what came back" for every read.

A search expand is **a card, not a run of rows.** The transcript is a column of
the agent's actions; eight passages loose in it read as eight more actions. The
result set gets one recessed contained surface, its border a step firmer than
the rules inside it so the container always outranks its own divisions.
Separation between documents is the point of the shape, and it is carried by a
rule, never by spacing alone.

### What the card says

- **The header carries the totals and nothing else.** `12 results in 3
  documents`, VS Code's grammar. It never repeats the query: the `Searched
  ‹query›` row title sits directly above it, and saying it twice makes the card
  read as a different question. When results and documents are equal every
  document matched once, so the header drops to `3 documents` rather than
  saying the same thing twice.
- **The bound line keeps one job**: how many documents were *shown* of how many
  matched (`4 of 42`). That is a different fact from the totals and it only
  appears when the list was actually cut.
- **The count badge is per document, right-aligned, and always present** —
  including at one. The contract guarantees it: a hit without a positive count,
  or without a passage to show, is refused at normalization rather than
  rendered around. Downstream code takes the shape as given. It sits in a column, and a blank cell in a column is worse
  than a `1`. It counts the whole document, not the passages fetched, so it
  stays honest when the server's cap clipped the list. The words live in
  screen-reader-only text; the badge itself is the bare number, because a
  column reads by shape.

### What the card does

- **Each document shows its best passage, and grows in place.** `N more`
  discloses the passages the server sent but the section kept folded. It grows
  inline: no nested scrollport, because the transcript is the single scroll
  owner. If the server's cap clipped more than it sent, the disclosure shows
  what it has and the badge still names the total.
- **The disclosure sits after the passage it extends**, not beside the document
  name. In the header it would take focus before the passage the writer is
  reading, and a focus order that disagrees with reading order is what keyboard
  users cannot recover from. Reading, DOM, and focus order are the same order:
  document name, its passage, `N more`, the rest.
- **The matched term is the door's handle.** Underlining a whole excerpt turns
  the writer's prose into a link and buries the word they searched for, so the
  term carries the underline and the jade hover while the whole row stays the
  click target. One button per passage, never a control inside a control: the
  visible affordance is smaller than the target, which is the point.
- **A passage with no anchor is not a door.** Non-manuscript schemes carry no
  block hash, so those excerpts render as prose and the document's own name
  stays the way in. The passage door also does not pre-check that its passage
  survived; it degrades at the destination, through the resolution ladder in
  `core/editor/passage-navigation.ts`, which lands on the block, or on a single
  re-found occurrence, or says the passage changed. It never guesses among
  duplicates.
- **Every door retires the last one.** Ordinary doors included: a resolution
  the writer has clicked past must not land a highlight or a notice behind
  them, so ownership advances at the door boundary
  (`features/project/chat/usePassageDoors.ts`), not per passage row.

Passages come from the payload's `matches` array, capped server-side; the
client never invents one, and a closed row never parses one (see
[activity-row-anatomy.md](activity-row-anatomy.md) for how the chevron stays
honest without that parse). The hash travels in its own field and the excerpt
arrives as prose, so no renderer parses the hashline format to show a sentence
to a writer — that parsing lives once, on the server, where the format is
already known.

An `ls` expand is **a record of what the model received, not a file browser.**
The tree panel already browses, and nothing consumes a folder route, so folders
carry no affordance.

## Bounds and the clipped-expand primitive

`ClippedExpand.tsx` owns both ways an expand is cut, and both ways it says so.

- **Continuous prose** clamps by height and fades its bottom edge. No count:
  a clipped passage never looks complete, and "first 240 words" is not a unit
  writers think in.
- **Discrete lists** cap by item count and state the rest as a fact — `4 of 42`,
  never "Showing…", which is systems voice. Listings and outlines cap at 8, one
  line each; search hits cap at 4, because each is three lines.

**The anchor is the trap.** `StreamTail` is bottom-pinned with a *top* fade,
because for a running command the newest output wins. A preview is the
opposite: **top-anchored with a bottom fade**, because the opening of the
passage wins. Reusing `StreamTail` here shows the end of the chapter.

**A second door sits at the fade** of clipped *prose*, labelled `Open
‹Document›`. The row title carries the first door, at the top; this one sits
where the writer has read to the bound. Never "Show more": more promises more
of a payload that is finite, and the document is a larger and different thing.
Prose that fits gets neither fade nor door, and a discrete list never gets
either: its count already says what was left out.

**No nested scrollports.** The transcript is the single scroll owner, so every
clamp is `overflow: hidden`. What a writer cannot see in an expand they reach
by opening the document.

## Typography is the wall-of-text defence

Length is not the risk; salience is. Rendered document prose at reading scale
competes with the assistant's own voice for "this is the content". Previews
render at the compact stop in muted ink through the `text-tier-quoted` wrapper,
which demotes headings to bold body text and drops the editor's block margins,
so a chapter title inside a preview cannot outrank the prose quoting it.
