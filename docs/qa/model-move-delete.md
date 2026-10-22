# The model's move and delete

Browser checks for the model's `write` `move` and `delete`: in an auto-apply chat, tool rows,
the turn card, its Undo, and a stopped reply's rollback (steps 1 to 4); in a draft-mode chat,
the pending rows, the Work notice on the live document, Apply, Discard and the model's undo
(steps 5 to 8). Run the stack with `MODEL_PROVIDER=mock` so `./mf mock script` drives the
model.

## Setup

1. `MODEL_PROVIDER=mock pnpm dev`, then `./mf seed` five chapters `manuscript://ch1` to `ch5`,
   with `ch3` linking `[the morning Lin Feng woke](manuscript://ch1)`, and a chat
   "Chapter cleanup" (No Work, auto-apply).
2. Another Work with a draft of ch2: create the Work (`POST /api/projects/:id/works`), a chat in
   it with `./mf thread create --work w1`, switch that chat to Draft in the browser, then
   `./mf thread send` it a mock `read` of ch2 and, in a second step, a `replace` (`"in": 2`).
   One step holding both returns "Got the latest text of".
3. Queue each reply with `./mf mock script '<steps>' --match '<message>'` and send the
   message from the browser composer.

## Steps

1. **Rename.** Script `move` `{ from: { path: "manuscript://ch1" }, path:
   "manuscript://ch1-awakening" }`. The tree shows ch1-awakening, the row reads "Moved ch1 to
   ch1-awakening", and the card "Changed 1 document" lists "Moved ch1 to ch1-awakening". Open
   ch3 and activate its link (Enter on the focused chip): ch1-awakening opens.
2. **Delete, then Undo.** With ch2 open in a tab, script `delete` ch2. The tab becomes "The AI
   in Chapter cleanup deleted ch2.", the row reads "Deleted ch2" with no door, the card lists
   "Deleted ch2". The card's Undo brings ch2 back into the tree and offers Redo. The other
   Work's chat still docks "ch2 1 change Discard Apply".
3. **Location taken.** Press Redo (ch2 deleted again), create a document at `manuscript://ch2`
   (`./mf doc put`), then press Undo: the card reads "Can't undo: another document is at ch2.
   Move or rename that document, then try again." once, with no "parts stayed" repeat.
4. **Stop mid-step.** Script step 1 `move` ch4 → ch4-old; step 2 `move` ch5 → ch5-final,
   `delete` ch3, then thousands of `ls` calls to hold the step open. When ch5-final shows,
   `./mf thread stop` (the app's Stop operation; the browser struggles to render thousands of
   live rows, so reload it afterwards). ch3 and ch5 are back, ch4-old stays, and the card
   lists "Moved ch4 to ch4-old" with ch3 and ch5 under "Rolled back".

`ask_user` doesn't hold a mock step open: the reply completes.

### Draft mode (steps 5 to 8)

Setup: chapters `manuscript://ch1` to `ch5`; a Work "Ascension" (`w1`); a chat in it
(`./mf thread create --work w1`) switched to draft mode, from the composer's write-mode menu or
`./mf api POST /api/threads/<id>/controls --data '{"id":"<uuid>","control":{"kind":"write_mode","mode":"draft"}}'`.
A `replace` in the same reply as a `read` of live ch1 answers `region_changed` once the
draft forks; read the drafted path (`ch1-old`) in a later reply, then `replace`.

5. **Pending rows and the notice.** Script `move` ch1 → ch1-old, `delete` ch3, `move` ch5 →
   ch6, `move` ch4 → ch5, then (next reply) a `replace` in ch1-old. The live tree keeps ch1 to
   ch5. The dock and Work page Files list "ch1: renaming to ch1-old" with the text change
   under it, "ch3: deleting", "ch4: renaming to ch5" with "ch5 still has that name. Apply its
   change first.", and "ch5: renaming to ch6", each with Discard and Apply. Open live ch1: the
   identity row reads "Ascension is renaming this to ch1-old." (at 390 px, "Pending rename",
   its popover the sentence); ch3 reads "Ascension is deleting this.". The prose doesn't move.
6. **Apply, Discard, Apply all.** ch1's Draft view, Apply draft: the tab becomes ch1-old with
   the text change. Work page, Apply all changes: the footer asks "Applying deletes ch3."
   (Cancel). ch3's Discard: its row goes at once, ch3 stays live. Apply all changes: ch4 → ch5
   and ch5 → ch6 both land (the held one is sent again after the other).
7. **Mixed move.** Script `create` `scratch://@w1/sect-notes`, then `move` it to
   `manuscript://sect-notes`: the row says "Couldn't move sect-notes" (the model reads D45's
   refusal). Then `copy` it there and `delete` the scratch one: the dock lists sect-notes.
8. **Undo after Apply.** Script `undo` of `manuscript://ch1-old`: "Couldn't undo ch1-old";
   the model reads `cant_undo_applied`.

With more than one file, the dock's Apply asks the same question in its footer
("Applying deletes ch2.") before it sends.

## Last run

- 2026-10-22, `feat/model-tool-surface-namespace-ui` after `ee4c2555c`, local stack, mock model:
  steps 1 to 4 pass. Evidence: the work directory's `impl-pr3/evidence/phase-d/`.
- 2026-10-22, `feat/model-tool-surface-namespace` (phase G), local stack, mock model: steps 5
  to 8 pass. Evidence: the work directory's `impl-pr3/evidence/phase-g/`.
