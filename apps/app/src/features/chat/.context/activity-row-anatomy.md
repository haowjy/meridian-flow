# features/chat — Activity row anatomy

How one tool row is composed. The model above it is
[turn-composition.md](turn-composition.md); what opens behind a row is
[tool-expands.md](tool-expands.md).

## Names are doors

`DocumentName.tsx` renders every document name in the timeline and alone decides
linkability, so renderers hold no navigation policy.

- One predicate answers linkability and navigation. Deriving "is this a link" from
  anything else brings back a control that looks live and does nothing.
- `write` input commonly carries a bare path. Without `contextUriFromWritePath`
  before the predicate, most write rows silently stop linking.
- A door is muted with a persistent underline; a plain name is `--prose` with none.
  Muted and undecorated reads as a control turned off.
- The timeline promises the URI the agent used, not that the document still
  exists. Pre-checking the cached context tree would make one row link or not by
  cache warmth; a missing document says so at the destination.
- `insideDoor` is for the receipt's full-width document rows, whose ancestor is
  already the door: a door inside a door is invalid HTML and a second tab stop.

## Two actions, one row

A row expands; a name inside it navigates. The large forgiving target carries the
safe reversible action, and the small precise one carries leaving the transcript.
`subagent/SubagentRow` splits the same way.

`ActivityRow` is a stretched button: an empty absolutely-positioned toggle after
the title, with the door lifted above it at `z-10`. They have to be DOM siblings:
a door authored as a JSX child of the toggle is not rescued the way the HTML parser
rescues static markup.

- The stretched area covers the title row only, so a click inside an open expand
  can't collapse it.
- The title row can't clip: the door grows past its line box to a ~37px touch
  target. Each title renderer truncates its own content instead.

## Tone

The glyph carries shape only, one per command. The `work` family shares the Work
mark, which says "this touched your Works, not your book".

Nothing in the row tints for a mutating command. The verb already says it, and the
receipt reports what landed rather than what a command intended. Jade in the
timeline then means one thing, a door; a second jade would cost the door its only
signal.

A fixed-width command column is the escalation if type isn't enough. It costs
64px, 21% of a 360px side chat.

## Verbs and tense

`command-descriptor.ts` also feeds `useLiveTurnAnnouncements`, so the visible row
and the announced string can't drift. Tense comes from protocol state
(`status === "complete"`), never timing. A partial write names no document, because
its path hasn't settled.

## Expands

- Whatever answers "is there anything here?" has to agree with whatever fills the
  expand: parse once and use that parse for both, or use a payload contract strict
  enough that its shape is the answer. A second validator beside the real one is
  how they disagree.
- `ToolRenderer.expand` returns a builder, because a settled turn holds a dozen
  closed rows and none should parse grep results.
- Open state is local to the row. Process folds live and settled alike, so
  settlement is not a remount and the state needs no hoisting.

## Subagent strip

The server sends only the viewed thread's direct children, and the strip consumes
that list unfiltered. A subagent's path row reads its direct parent's activity for
its own run times, not the root's.

The composer's Stop ends only this chat's reply, so each running child's row
carries its own Stop: `useSubagentStop` presses the child's hand-back operation.
The parent holds no live copy of the child's record, so each press first reads the
child's snapshot into the store; `stopRequest` needs that record's execution and
watermark. A failed Stop is a `handBackCards` card under that row.

Each child's row keeps one keyed position in the strip's list, however many
children there are, and a collapsed list hides rows without unmounting them. The
snapshot read is local to the row, so a remount mid-read would drop the press with
"Stopping" already announced. A hidden row that owes a card shows anyway.
