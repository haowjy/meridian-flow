# The model's create, move and delete

Browser checks for the model's `write` `create`, `copy`, `move` and `delete`: in an auto-apply chat, tool rows,
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
   ch3 and activate its link (Enter on the focused chip): ch1-awakening opens. A move into
   another owner's Scratch names that owner, never its handle: `move` ch8 to
   `scratch://@w1/ideas/ch8` reads "Moved ch8 to Scratch for Ascension/ideas/ch8".
2. **Delete, then Undo.** With ch2 open in a tab, script `delete` ch2. The tab becomes "The AI
   in Chapter cleanup deleted ch2.", the row reads "Deleted ch2" with no door, the card lists
   "Deleted ch2". The card's Undo brings ch2 back into the tree and offers Redo. The other
   Work's chat still docks "ch2 1 change Discard Apply".
3. **Name taken.** Press Redo (ch2 deleted again), create a document at `manuscript://ch2`
   (`./mf doc put`), then press Undo: the original returns at `manuscript://ch2 (2)` and the
   expanded card reads "Restored as ch2 (2)." The new ch2 stays where it was. Redo and Undo
   again; the same document returns and the card names the committed path. Then script a model
   move of ch1 onto the occupied `manuscript://ch2`: its tool result, expanded turn receipt,
   Undo/Redo landing copy and Recent dock entry all name the same committed suffixed path, not
   the requested `ch2` path.
4. **Absorbed folder.** In a draft-mode chat, move a document into a new `arc/` folder, then
   move it out. Create a live `arc/` folder so it absorbs the hidden draft folder. Model Undo
   of the second move returns the document inside the live `arc/`, not `folder_missing`.
5. **Stop mid-step.** Script step 1 `move` ch4 → ch4-old; step 2 `move` ch5 → ch5-final,
   `delete` ch3, then thousands of `ls` calls to hold the step open. When ch5-final shows,
   `./mf thread stop` (the app's Stop operation; the browser struggles to render thousands of
   live rows, so reload it afterwards). ch3 and ch5 are back, ch4-old stays, and the card
   lists "Moved ch4 to ch4-old" with ch3 and ch5 "Rolled back" under "Undo leaves 2 parts as
   they are".

`ask_user` doesn't hold a mock step open: the reply completes.

### Draft mode (steps 6 to 9)

Setup: chapters `manuscript://ch1` to `ch5`; a Work "Ascension" (`w1`); a chat in it
(`./mf thread create --work w1`) switched to draft mode, from the composer's write-mode menu or
`./mf api POST /api/threads/<id>/controls --data '{"id":"<uuid>","control":{"kind":"write_mode","mode":"draft"}}'`.
A `replace` in the same reply as a `read` of live ch1 lands when the draft forks, using either
the text it found or a block hash from that read.

6. **Pending rows and the notice.** Script `move` ch1 → ch1-old, `delete` ch3, `move` ch5 →
   ch6, `move` ch4 → ch5, then (next reply) a `replace` in ch1-old. The live tree keeps ch1 to
   ch5. The dock and Work page Files list "ch1: renaming to ch1-old" with the text change
   under it, "ch3: Deleted", "ch4: renaming to ch5", and "ch5: renaming to ch6", each with
   Discard and Apply. Open live ch1: the
   identity row reads "Ascension is renaming this to ch1-old." (at 390 px, "Pending rename",
   its popover the sentence); ch3 reads "Ascension is deleting this.". The prose doesn't move.
7. **Apply, Discard, Apply all.** ch1's Draft view, Apply draft: the tab becomes ch1-old with
   the text change. Work page, Apply all changes: the footer asks "Applying deletes ch3."
   (Cancel). ch3's Discard: its row goes at once, ch3 stays live. Apply all changes: ch4 → ch5
   and ch5 → ch6 both land in dependency order from either row. Repeat with a swap: both land
   in one Apply transaction. Apply a drafted move after a new live document takes its target:
   the move lands at the next free name and the footer says "Added as <name>."
8. **Scratch crossing.** Script `create` `scratch://@w1/sect-notes`, then `move` it to
   `manuscript://sect-notes`. The result starts "not applied yet", the dock lists sect-notes at
   its manuscript destination, and live still has it in Scratch. Script `undo` by either path:
   the dock row disappears and the branch sees it in Scratch again. Redo the move and Apply it;
   live now has sect-notes in the manuscript and not in Scratch. Move `manuscript://ch2` to
   `scratch://@w1/ch2`: the branch sees it in Scratch while live keeps ch2 in the manuscript;
   Discard removes the row and leaves live unchanged.
9. **Undo after Apply.** Apply a drafted text replacement, a drafted move and a drafted delete.
   Script `undo` for
   the text edit: it reports `reverted`, restores the old text as a pending draft change, and
   leaves live unchanged. Script `undo` for the applied move: "Couldn't undo ch1-old"; the model
   reads `cant_undo_applied`. Script `undo` for the applied delete: it restores the same document.
   Redo deletes it again. Apply another drafted delete, then use the turn card's Undo; it restores
   the document. Apply once more, stop the reply so rollback runs, and verify rollback restores it.
   `write edits` lists each applied delete once. Moves and renames remain applied and cannot be
   undone ([#1024](https://github.com/haowjy/meridian-flow/issues/1024)).

With more than one file, the dock's Apply asks the same question in its footer
("Applying deletes ch2.") before it sends.

10. **One queue per item; one Discard per item.** Draft a move with a text change of ch1, ch2,
   ch3 and ch6 (moves first, then a `read` and a `replace` of each new path in later steps), a
   move-only ch4 and a delete of ch5. In the browser, wrap `fetch` to delay an Apply POST with
   text groups by 3 s and log each send. The dock's ch4 line Apply moves it with no room.
   ch3's text Apply then at once its line Apply: the line's request goes out only after the
   text's (about 3 s after its click), and ch3 lands renamed with its text. ch2's Draft view,
   Apply draft: one request with both, and the review moves on. ch6's line Discard keeps
   "white" listed and ch6 live under its name; the footer says "Discarded" with no Undo.
   With only ch1 left, the dock's Discard drops both, says "Discarded" with no Undo, and the
   Work lists nothing.
   In a Draft view of an item with a move and text, the change bar's Discard drops only the
   text: the band keeps Discard draft and Apply draft beside the Work notice, and its change
   list shows the move's line. Discard draft then drops the move.
11. **A destination folder the writer makes, and a rename the Work ends.** Script `move` ch2 →
   `arc2/ch2` (a folder only the Work sees). In the live tree, create a folder and rename it to
   `arc2`: the dock still reads "ch2: renaming to arc2/ch2". The card's Undo moves it back and
   the card expands with its draft outcome; Redo puts it in `arc2` again. Then script `move` ch4
   → ch4b, press the card's Undo, and Discard all of the Work: the card's Redo then says the
   change was discarded, not that it can't be restored.
12. **Create is one reversible change.** In an auto-apply chat, script `create` of
   `manuscript://new-chapter` with prose. The card counts the new document. Its Undo removes the
   document; Redo restores the prose. After Undo, put another document at that path and press
   Redo: the created document returns at the next free name, which the expanded card reports.
   Then script a whole-document `copy` and, in a later model step, `undo` the copy's path. One
   Undo removes the copy rather than leaving an empty document; Redo restores its content. Repeat
   after the writer replaces one of the copy's paragraphs. Undo reports that skipped text part and
   removes the document as the same edit. Redo restores the document with the writer's paragraph
   intact and reapplies the text parts Undo removed.
13. **Draft create is one pending item.** In a draft-mode chat, script a nonempty `create`, then
   an empty `create`. Each turn card counts its created document, and the dock and Work Files list
   both. Undo each card: its row disappears from both lists, while the same active draft and
   document identity remain hidden by the branch delete fact. Redo clears that fact and shows the
   same draft with its original content (or the same empty draft), listed once. Apply and Discard
   remain available on the restored row.

## Last run

- 2026-10-22, `feat/model-tool-surface-namespace-ui` after `ee4c2555c`, local stack, mock model:
  steps 1 to 4 pass. Evidence: the work directory's `impl-pr3/evidence/phase-d/`.
- 2026-10-22, `feat/model-tool-surface-namespace` (phase G), local stack, mock model: steps 5
  to 8 pass. Evidence: the work directory's `impl-pr3/evidence/phase-g/`.
- 2026-10-22, `feat/model-tool-surface-namespace-client` after `95dbe0806`, local stack, mock
  model: step 9 passes, twice. Evidence: the work directory's `impl-pr3/evidence/ef-client/`.
