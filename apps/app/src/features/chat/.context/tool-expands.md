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
| `grep` | Match rows: document, and the passage that matched | The search cap, with a count | Each document |
| `ls` | Listing rows: name plus glyph | The listing cap, with a count | Each document; folders are inert |
| `invoke` | Output tail, or one of two availability failures | The tail's own bound | — |
| unknown | Nothing | — | — |

A **failed `write`** always shows why it failed, in place of whatever the
command would otherwise have opened onto. No other tool has a general failure
expand: `invoke` recognises two availability failures and shows nothing for the
rest, and a failed `grep` or `ls` opens onto nothing at all. Whether every
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

A search row shows the **document and its passage, and no line number**:
chapters are not line-addressed, and a line number is developer vocabulary in a
novelist's transcript. The passage is centred on the match rather than started
at the line's beginning, cut on a word boundary with a leading ellipsis when
run-up was dropped, and the matched words carry weight through type alone. No
coloured ground: this is the writer's own prose, and a highlighter across it
reads as markup rather than as their sentence.

Two things the design asks of this expand are **blocked on the payload**
(meridian-flow #433), not forgotten: a per-document match count, and the
`12 results in 3 documents` bound. The adapter returns only the first match per
document, so results and documents are always equal and both would state a
tautology. Until the payload carries counts, the bound stays `N of M`.

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
