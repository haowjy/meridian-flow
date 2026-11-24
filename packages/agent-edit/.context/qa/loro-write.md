# agent-edit on Loro, scripted

`loro-write.probe.ts` drives the Loro core (`createEditCore`) over the in-memory rooms
(`createInMemoryHost`) with scripted commands, no stack and no model. Run it when the core, the
Loro model, the frontiers, the concurrent-change report or the host's write records change:

```sh
pnpm --filter @meridian/agent-edit exec tsx .context/qa/loro-write.probe.ts
```

It prints `ok: <n> checks`, or the first failed check with what it found, and exits non-zero.

What it covers:

- A chat reads a chapter, the writer edits a sentence of a paragraph, the chat rewrites the whole
  paragraph as it read it with the other sentence changed: the writer's sentence stays (the write
  plans on a view at the read's frontiers), and the result lists the paragraph under `the user`.
- The chat's own earlier write in the same turn is not listed as someone else's change.
- Turn Undo (`undoTurn`, by each write's recorded Loro `edit` through `undoInRooms`) takes the AI's words out and
  leaves a later writer edit.
- `read` with `format: "edits"` lists the chat's writes by handle.
- Another chat's change is named by its chat (`authorOfTurn`), and a block the writer removed is
  listed as removed.
- Writes into an emptied document (the unstored `/empty` paragraph) land: a replace with one
  paragraph or three, and an insert after it. The result lists what was written: the paragraph's
  ref follows the fresh id `applyOps` stores it under (`renamed`). Then `create` writes a new
  document.
- After the writer's turn Undo restores text the chat last saw replaced, an exact `find` of the
  restored text lands, though the chat's view still holds its own words there.
- A read whose frontiers are below the history cutoff (the host's `compact`) plans on the
  transcript: a paragraph rewritten as read keeps the writer's deletion made since.
- The writer types in a paragraph after the chat read it, and the chat removes it as read: the
  removal did not read the typing, so the paragraph comes back (design §1, "Removed blocks"), and
  the receipt does not list it as removed.
- After the writer's turn Undo, the chat's rewrite by hash of its own words (which its view still
  holds) lands nothing, says the text was edited since and shows it with no instruction to write
  again, and the same rewrite asked after it lands.
- A Draft chat (`host.chat("d1")`) reads its fork room before the draft has written there, writes
  two paragraphs into the draft only, the writer applies one, and the chat's next write to it plans
  on the fork (no duplicate, Live keeps the applied text); `format: "changes"` shows the pending
  changes as CriticMarkup; the turn's restore press returns the draft to Live with the applied
  paragraph left in Live; a Live chat's `changes` read succeeds and says nothing waits.
- A chat reads in Live and writes in Draft: the write plans on the Live read (the writer's sentence
  typed since stays) and the report names the writer's forwarded Live change as `the user`.
- The model's `undo` of two Draft writes takes the one nobody touched out of the draft, leaves the
  one the writer typed over in the draft, and says so; Live is untouched.
- A Draft chat's write into a draft the writer emptied lands under fresh ids and lists every block.
- A chat reads its draft's own text, is switched to Live, and rewrites the paragraph after the
  writer typed in Live: the read can't be checked out in Live, so the write plans on the
  transcript, the writer's Live typing stays and the draft gets no duplicated text.
- A chat reads in Draft before the draft wrote anything, is switched to Live: it plans on that
  read, the writer's Live word stays, and the report names the writer.
- A chat reads in Live, Live is compacted past the read, the writer types, and the chat writes as a
  Draft chat: the transcript (shown blocks from every room) keeps the writer's word in the draft.
- A press since the read: after the writer applies a draft's new paragraph (its text reaches Live
  with it), the chat's rewrite of it plans on the read with no duplicate; after the writer discards
  a draft's rewrite of a paragraph, the chat's rewrite of it as read leaves the discard standing,
  and the report names the press.
- `format: "changes"` marks a moved block, escapes closing delimiters in the text, and lists a
  comment whose body only the draft changed.
- The model's second `undo` takes back the edit before the one it already took back.

The scenarios fail on the old code paths they guard: planning on the room copy instead of the view
breaks the first, skipping the transcript merge breaks the cutoff scenario, resolving a `find`
only on the view breaks the Undo one, importing the write into the room copy without answering its
removals breaks the removal one, looking the read up only under the fork's own name breaks the Live
to Draft switch, and answering a plain `unchanged` breaks the rewrite after the Undo. Looking reads
up per room name (the core asking under its own room, or its Live room for a fork) and the
transcript under its own room breaks the three switch scenarios; the old "write it again" message,
the old `changes` format, an undo that picks edits already taken back, and `applyBlocks` without
its Live text for a created block each break their scenario.
