# extensions/auto-pair — closers the editor writes

Typing `[` gives `[]` with the caret between them; typing `]` walks back out
of the closer rather than doubling it; Backspace between the halves takes
both. A registry says which characters do this and where.

## Mental model

**One table, three gestures.** [`auto-pairs.ts`](auto-pairs.ts) is a
declarative list of `{ open, close, contexts }` rows, and
[`AutoPairExtension.ts`](AutoPairExtension.ts) is the single mechanism that
opens, steps over, and unpairs by reading it. A new pair is one row and
nothing else. This is the same seam shape as
[`../../objects/object-types.ts`](../../objects/object-types.ts).

**Openers are one character and pairs compose.** `[[` is the `[` row firing
twice: `[` gives `[]`, a second `[` gives `[[]]`, and `]]` steps out of both
in order. A multi-character row would need its own matching logic and would
race the single-character rows it overlaps.

**A step is only ever over a closer this plugin wrote.** The plugin state
holds the positions of its own closers, mapped forward through every
transaction and confirmed against the document character before any keystroke
is consumed. A writer's own `]` is their text, and typing `]` in front of it
writes a second one. Every path fails toward plain insertion, because a
keystroke that lands as itself costs far less than one that disappears.

## Key rules

- **Never eat a keystroke.** Remote collab edits replace the whole document
  (see [`../../anchors.ts`](../../anchors.ts)), so every tracked position is
  reported deleted and the table empties. That is the designed outcome, not a
  bug: the writer gets the literal character.
- **The markdown autoformat owns its own delimiters.** `*`, `_` and `~` are
  absent from the registry on purpose, and so is the backtick outside a code
  fence — their completion path is an input rule that fires when the writer
  types the closing run, and putting that run in the document early means the
  rule never fires. The registry comment carries the reasoning; do not "fix"
  the omission.
- **A pair is a text-input concern only.** Nothing here binds Esc, Tab, or
  Enter, and the Backspace binding refuses whenever it has no pair to take, so
  the rest of the chain is untouched.
- **One transaction per gesture**, so one undo takes the whole thing back.
- **A range replacement that ends at the caret has to swallow the closers
  written for it.** `autoClosedRunLength` is that seam, and the `[[` menu is
  its one caller: a link inserted over the trigger's own range would otherwise
  strand `]]` behind it.

## Anti-patterns

- Matching a closer by character alone. That is how `]` typed before a `]` the
  writer typed themselves silently disappears.
- Special-casing a pair inside the plugin. If a pair needs behavior the table
  cannot express, the table is the wrong shape.
- Dispatching during composition. An IME is mid-word and a transaction
  underneath it corrupts the composition.

→ [`../wikilink/AGENTS.md`](../wikilink/AGENTS.md) — what `[[` opens once the
  brackets are there
→ [`../MarkdownAutoformatExtension.ts`](../MarkdownAutoformatExtension.ts) —
  the rules this stays out of the way of
