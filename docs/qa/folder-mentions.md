# Folder mentions

Checks that `@` can mention a folder in the composer and the Editor, and that a
folder chip opens the drill-in menu inside its folder, wherever the folder now
lives.

Use this checkout's `pnpm dev` stack and the URLs from `pnpm portless:list`.
Sign in with dev-login. Seed a chat with `./mf seed tools/mf/fixtures/basic.json`,
then a folder with one document and an empty subfolder:

```bash
./mf doc put "manuscript://Act 1/Opening.md"
./mf doc put "manuscript://Act 1/Battle/Draft.md"
./mf doc rm "manuscript://Act 1/Battle/Draft.md"   # leaves Battle empty
```

1. **Picker.** In the chat composer type `@`, choose Manuscript, then Act 1.
   The first row under Back reads "Mention Act 1" with a folder icon. Pressing
   Act 1's row in the Manuscript listing drills into it; it doesn't insert
   anything. Battle is listed even though it is empty, and drilling into it
   shows "Mention Battle" in place of "This folder is empty." The Manuscript
   listing itself has no Mention row. Typing a search inside Act 1 hides the
   Mention row.
2. **Composer chip.** Choose "Mention Act 1". The chip looks like a document
   chip, with a folder icon and the label Act 1. Reload: the chip returns.
   Copy the chip and paste it into the same composer: it pastes as a folder chip.
3. **Composer menu.** Click the chip. The menu opens inside Act 1: Back,
   Opening, Battle. Battle drills, Back climbs to Manuscript, and Opening opens
   the document. Enter on the focused chip opens the same menu.
4. **Editor link.** Open Opening in the Editor and type `@`, then mention Act 1.
   The link chip has a folder icon; the stored Markdown (`./mf doc read
   "manuscript://Act 1/Opening.md"` after the save) is
   `[Act 1](manuscript://Act%201/)`. Hover shows Act 1. Click it: the drill-in
   menu opens below the link. Escape closes it and returns the caret to the
   prose. The link menu's Open does the same.
5. **Rename, then click.** Rename Act 1 to "Act One" in the sidebar. The Editor
   chip, the composer chip and the Editor hover read "Act One". Clicking any of
   them opens the menu inside Act One.
6. **Transcript.** Once sending works (it needs the server lane), send a message
   with the folder chip. The transcript chip keeps the label it was sent with,
   and clicking it opens the menu inside the folder after a rename or a move.
   Delete the folder: the chip turns dashed and opens nothing.
7. **Deleted folder in an open menu.** Mention a folder in the composer, delete
   the folder from the sidebar, then click the chip. The menu says "This folder
   is no longer available."

Record the commit, date, stack, outcome and screenshot paths in the active work
directory after a run.
