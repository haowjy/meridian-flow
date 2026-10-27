# Dragging from places that aren't tree rows

Named risks: a source that drags but doesn't ask (a same-system drop that moves at once), a
drag that also navigates, selects text, opens its menu or moves the text it came from, a draft
tab, crumb, receipt or change row that copies the live document or another Work's draft, an Uploads entry that can't leave or accepts a drop,
a Cancel that changes something, and a same-system row drag that stopped moving at once. The
tree's own drag is [Row selection and drag](row-drag.md); the menu's Copy is
[Copy in the tree](copy-browser.md).

## Setup

1. An owned stack on the mock model (`MODEL_PROVIDER=mock pnpm dev`; origins from
   `pnpm portless:list`; `pnpm bootstrap` first on a fresh worktree). Seed with `./mf doc put
   --text`: `manuscript://Book/Act 1/Prologue`, `…/Act 2/Chapter 2`, `…/Notes/Ideas`,
   `kb://Lore/Magic`, `user://Templates/Style guide`, and `manuscript://Book/Links` holding
   `[the prologue](<manuscript://Book/Act 1/Prologue>)`. Open Prologue and Chapter 2 so they are tabs.
2. A Work (`w1`) and a chat in it in draft mode (`./mf thread create --work w1`, then the
   `write_mode` control as in [Model move and delete](model-move-delete.md)). Seed
   `manuscript://Book/Draftdoc`; send `--mock` with a `read` then a `write` `replace` (`in: 1`) of its only
   block. An upload: `./mf api POST "/api/projects/<p>/context/uploads/upload?chatId=<chat>"
   --file file=@notes.txt --field intakeId=<uuid> --field byteDigest=<sha256>`.
3. Drag with `agent-browser mouse move/down/up` in several moves at 1440×900 (the harness in the
   evidence folder, `drag.sh`, takes two CSS selectors). A menu's items are in a portal: click them by
   `snapshot -i` ref, not by text.

## Steps

1. **Tab, same system.** Drag the Prologue tab onto Manuscript › Notes. The hint reads "Move to
   Notes…"; release opens Move to Notes / Copy to Notes / Cancel. The active tab, the URL and the
   rail stay as they were. Cancel: Prologue is still under Act 1 and nothing is under Notes.
2. **Crumb.** Drag the `Act 2` crumb (not the area crumb, which navigates) to `Lore` in the
   Knowledge Base: the menu asks. The crumb's dropdown does not open.
3. **Recent row.** Empty-editor chooser: drag Prologue to User › Templates, choose Copy. The copy is
   there, the source stays, the URL doesn't change.
4. **Composer chip.** `@Prolo` in the composer, Enter. Drag the chip to a tree folder: it asks and the
   chip stays in the composer. Drag it onto the composer's text: a second mention appears
   and the first stays.
5. **Transcript chip.** Send that message. Drag a sent chip to a folder: it asks and no tab opens.
6. **Editor link.** Open `Links`. Press on the link and sweep: the text selects (nothing drags). With
   the link's whole text selected, drag it to the end of the paragraph: the text moves there as text
   (`./mf doc read` shows the link after "for context." and nothing duplicated, no reference
   inserted). Select it again and drag it to a folder: it asks, and Copy copies the document the link
   names; the link's text stays in the document. A selection that is only part of the paragraph, an
   image and a block drag as before.
7. **Draft tab, receipt and change row.** Open `Draftdoc` and press Review: the tab now shows the draft.
   Drag the tab to Templates, Copy: `./mf doc read user://Templates/Draftdoc` reads the draft text, and the
   live document is unchanged. The leaf crumb (the filename) does the same. A receipt row ("Edited 1
   document" › Draftdoc, in the chat) and the Work page's Changes to review row copy that Work's draft
   too. Then rebind the chat to another Work (`./mf api PUT /api/threads/<chat>/work --data
   '{"workId":"<other>"}'`) and copy all three again: each still holds the first Work's draft, never the
   chat's current Work's or the live text. With the ask menu open on the change row, Discard the Work's
   draft (`POST …/works/<w>/branches/discard`) and choose Copy: nothing is copied and the notice says
   "That Work no longer has a draft of it."
8. **Uploads.** Open the chat's Files menu and drag `notes` to a folder: it asks; Copy leaves the upload in
   the menu. Drag it onto the Uploads heading: no drop, and the hint says files move or copy out of Uploads,
   not in.
9. **Rows still move.** Drag the Prologue row onto `Act 2` in the same tree: it moves at once,
   "Moved Prologue to Act 2." with Undo, no menu.
10. **Phone.** Over CDP (393×852, `isMobile`, `hasTouch`; the `phone-driver.cjs` in the evidence folder)
    open a document and the chat with sent chips: `(pointer: coarse)` matches and no element is
    `draggable`.

## Not covered

An archived Work's Scratch source asks with Move disabled ("Can't move these from here"); a draft tab
whose copy must include edits the writer has not yet synced (the Copy request carries no draft-room
state vector); Firefox (a draggable inside a `<button>` may not start a drag there).
