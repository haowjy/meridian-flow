# The model's move and delete

Browser checks for the model's `write` `move` and `delete` in an auto-apply chat: tool rows,
the turn card, its Undo, and a stopped reply's rollback. Until PR 3's phase F publishes both
commands, only the scripted mock model can call them (D66), so run the stack with
`MODEL_PROVIDER=mock`. Steps 5 to 8 (draft mode, Apply, Discard) join this page with phases
F and G.

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

## Last run

- 2026-10-22, `feat/model-tool-surface-namespace-ui` after `ee4c2555c`, local stack, mock model:
  steps 1 to 4 pass. Evidence: the work directory's `impl-pr3/evidence/phase-d/`.
