# agent-edit on Loro, scripted

`loro-write.probe.ts` drives the Loro core (`createLoroEditCore`) over the in-memory rooms
(`createInMemoryLoroHost`) with scripted commands, no stack and no model. Run it when the core, the
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
- Turn Undo (`undoTurn`, by content from the writes' recorded `delta`) takes the AI's words out and
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
  holds) answers with the text as it stands, and the same rewrite asked again lands.
- A Draft chat (`host.chat("d1")`) reads its fork room before the draft has written there, writes
  two paragraphs into the draft only, the writer applies one, and the chat's next write to it plans
  on the fork (no duplicate, Live keeps the applied text); `format: "changes"` shows the pending
  changes as CriticMarkup; `Restore before` the turn returns the draft to Live with the applied
  paragraph left in Live; a Live chat's `changes` read has none.
- A chat reads in Live and writes in Draft: the write plans on the Live read (the writer's sentence
  typed since stays) and the report names the writer's forwarded Live change as `the user`.
- The model's `undo` of two Draft writes takes the one nobody touched out of the draft, leaves the
  one the writer typed over in the draft, and says so; Live is untouched.
- A Draft chat's write into a draft the writer emptied lands under fresh ids and lists every block.

The scenarios fail on the old code paths they guard: planning on the room copy instead of the view
breaks the first, skipping the transcript merge breaks the cutoff scenario, resolving a `find`
only on the view breaks the Undo one, importing the write into the room copy without answering its
removals breaks the removal one, looking the read up only under the fork's own name breaks the Live
to Draft switch, and answering a plain `unchanged` breaks the rewrite after the Undo.
