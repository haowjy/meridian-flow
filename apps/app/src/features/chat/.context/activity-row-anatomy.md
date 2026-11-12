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

## Subagent cards

Each run is one card in the transcript, at the turn that started it, from launch to
finish: running it shows the live tool and elapsed time, finished it folds to the
report. Its completion also keeps a quiet "… finished" row where it arrived: a long
run finishes many turns after its card, and that row is where the writer learns it is
done and opens it from. The band's Subagents popover is the one list of every child,
running ones first, and its rows jump to the card.

The composer's Stop ends only this chat's reply, so a running background card carries
its own Stop beside Open: `SubagentStop` presses the child's hand-back operation
through `useSubagentStop`. The parent holds no live copy of the child's record, so each
press first reads the child's snapshot into the store; `stopRequest` needs that
record's execution and watermark. A failed Stop is a `handBackCards` card under that
card's row. `ChatView` provides the stop scope; a card rendered without one has no
Stop.

The server sends only the viewed thread's direct children. A subagent's path row reads
its direct parent's activity for its own run times, not the root's.
