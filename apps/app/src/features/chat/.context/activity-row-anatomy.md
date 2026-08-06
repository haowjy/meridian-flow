# features/chat — Activity row anatomy and navigation

How one tool row is composed, and the rules that make the timeline readable at
fold density. The composition model above it (zones, partitioning, settlement)
lives in [turn-composition.md](turn-composition.md).

## Names are doors

> Every writer-facing document name rendered anywhere in the timeline opens
> that document. Folders, patterns, skills and chrome are not documents and
> render as inert text.

`DocumentName.tsx` is the whole rule. It renders every document name — row
titles via `tool-renderers`, `search` match rows via `ResultRows`, receipt rows
via `TurnEditsReceipt` — and it alone decides linkability. There is no
navigation policy per renderer to remember or uphold.

### Contracts

- **One predicate for both linkability and navigation.** `DocumentName` asks
  `useChatContextRoutability()` and routes through `useChatContextNavigation()`.
  Deriving "is this a link" from anything else makes a control that looks live
  and does nothing reachable again.
- **Normalize before asking.** `write` input commonly carries a bare path
  (`chapter.md`); `contextUriFromWritePath` runs before the predicate. Without
  it most write rows silently stop linking.
- **The name is the whole claim.** A row renders the document's name and no
  location tag: the door already goes wherever the document lives, so
  `Wrote elara` rather than `Wrote elara (Knowledge Base)`. Location earns its
  keep in exactly one place, the dead-route pane, whose entire job is to say
  which section a missing document is missing from.
- **Tone and decoration move together.** A door is `--muted` with a persistent
  1px underline at the border token, 3px offset, jade on hover and focus. A
  plain name is `--prose` with no decoration. Never muted and undecorated: that
  reads as a control that has been turned off.
- **Degradation is structural.** Outside a project shell both hooks are `null`,
  so nothing is a link and no underline renders. The underline carries
  clickability only, never meaning.
- **The timeline promises the URI the agent used, not that the document still
  exists.** Do not pre-check against the cached context tree: the same row
  would link or not depending on cache warmth. Missing documents degrade at the
  destination, which names the document and says it is gone
  (`features/project/context/context-pane-state.ts`, `dead-route`). That
  explanatory pane is the other half of this decision: without it, not
  pre-checking would be the wrong call.
- **One door, two precisions.** A name standing for a whole document opens the
  document; a name standing for a matched passage (`search` match rows) carries
  that passage in the same call and opens there. Same affordance, same
  underline, same predicate — only the destination is finer. A passage anchor
  is a block hash plus the term that matched, and a row without a hash is
  simply a document door.
- **`insideDoor`** is for the one case where an ancestor is already the door
  (the receipt's full-width document rows). A door inside a door is invalid
  HTML and a second competing tab stop.

## Two actions, one row

A row expands; a name inside it navigates. Never invert: the large forgiving
target carries the safe reversible action, the small precise one carries
leaving the transcript.

`ActivityRow` builds this as the stretched-button pattern — an empty
absolutely-positioned toggle rendered **after** the title content, with the
door lifted above it at `z-10`. The two buttons are DOM siblings; authoring the
door as a JSX child of the toggle is not rescued the way the HTML parser
rescues static markup.

- The stretched area covers the **title row only**, so a click inside an open
  expand cannot collapse it.
- The toggle has no text, so it takes `aria-labelledby` pointing at the title.
  Two tab stops per row: `Open ‹document›`, and the title with `aria-expanded`.
- The title row must not clip: the door grows past its line box to reach a
  ~37px touch target, bounded so it never covers a neighbouring row. Each title
  renderer truncates its own content instead.

## The command outranks the parameter

Did the agent *look at* my book or *change* it is the timeline's most important
distinction, and doors add weight to the parameter. Two layers answer it:

1. **One glyph per command, not per tool.** The icon column is already an
   aligned channel; bound to the command it becomes scannable. The glyph
   carries **shape only**, at one neutral tone for every command. One
   deliberate exception: the `work` command family shares the Work mark
   (`Layers`), because the mark's job is to say "this touched your Works,
   not your book" and the verb carries the rest.
2. **Type.** Command at `--ink`/500, parameter at `--muted`/400.

**Row chrome is tone-flat, deliberately.** The chip is a place to put the
glyph, not a signal: it does not tint for mutating commands, and neither does
anything else in the row. Mutation is carried by the verb the row already says
(`Wrote`, `Edited` against `Read`, `Searched`) and, durably, by the edits
receipt, which reports what actually landed rather than what a command
intended. That leaves jade meaning exactly one thing in the timeline: **this is
a door.** A second jade in the row chrome would spend the accent on something
the words already say, and cost the door its only signal.

A fixed-width command column is the escalation if type is not enough. It is
deferred, not rejected: 64px is 21% of a 360px docked chat.

## Verbs live in one place

`tool-command.ts` classifies the writer-facing command; `command-descriptor.ts`
holds one exhaustive table of what the timeline does with it, including both
tenses, the glyph, the failure verb, and the expand shape. Renderers consume the table; nothing derives past tense inline, and
adding a command is one entry. The same vocabulary feeds
`useLiveTurnAnnouncements`, so the visible row and the announced string cannot
drift — they had, for `ls`.

Tense is a pure function of protocol state (`status === "complete"`), never of
timing. A partial write names no document: its path has not settled, so the row
offers no door onto one.

## Expands

The row owns whether there is an expand and when it is built. What goes inside
one lives in [tool-expands.md](tool-expands.md).

- **No chevron unless there is something behind it.** An expand affordance is a
  promise, so whatever answers "is there anything here?" has to agree with
  whatever fills the expand. Two ways to keep them agreeing: parse once and use
  that parse for both, or lean on a payload contract strict enough that its
  shape alone is the answer. Never a second validator beside the real one —
  that is how the two came to disagree the first time.
- **Built on open, not on render.** `ToolRenderer.expand` returns a builder;
  deciding *whether* there is content is cheap, rendering it is not. `search`
  takes the contract route: a hit that cannot fill a section is refused at
  normalization, so a non-empty payload *is* content and a closed row reads
  `Array.isArray` and stops. Sections and the totals scan wait for the writer
  who opens the row — a settled turn holds a dozen closed rows, and none of
  them should be parsing search results.
- **Open state is local to the row.** It resets when frontier rows fold at
  settle. That is correct — the fold reopens calm — so do not hoist it.
