# Copy in the tree

Named risks: a copy that waits for the server before it shows, a notice that says "Copied"
before the server has answered, an Undo that leaves copies behind (the edits made since, a
copy moved out of its folder, a Copy the server has not answered yet), a refused Copy the
writer never sees, or one that vanishes on reload or in another tab, a copy that sends a
document without the edits the device holds, a copy that takes the wrong name, and a drop or
Move… that stopped working because Copy joined them. This recipe drives the browser with
`agent-browser`. The server command has its own recipe, [The server Copy command](copy-server.md).

## Setup

1. Start an owned stack (`MODEL_PROVIDER=mock pnpm dev` for steps that seed a draft) and find
   its origins with `pnpm portless:list`. Sign in with the dev user.
2. Seed with `./mf doc put --text`: `manuscript://Book/Act 1/Chapter 1`, `manuscript://Book/Act 1/Prologue`,
   `manuscript://Book/Act 2/Chapter 2`, `manuscript://Book/Notes/Ideas`,
   `kb://characters/Hero`, `user://Templates/Style guide`. Create a Work with
   `./mf api POST /api/projects/<id>/works --data '{"name":"w","goal":"g"}'` and seed
   `scratch://Scene notes` with `--work w1`.
3. Drag with `agent-browser mouse move/down/up` in several moves; a native drag needs
   pointer events between press and release. The Files rail's User panel is short and
   scrolls: scroll a target into view before dragging to it. `agent-browser set offline on`
   holds a Copy unanswered; the app takes a few seconds to show its offline banner and the
   layout shifts when it does, so read coordinates after that.

## Steps

1. **The menu.** Drag `Chapter 2` onto User › `Templates`. The hint reads "Move to
   Templates…"; on release a menu at the pointer offers Move to Templates, Copy to
   Templates and Cancel.
2. **Copy and Undo after the answer.** Choose Copy. The copy is listed in `Templates` at
   once and the notice reads "Copying Chapter 2 to Templates…", then "Copied Chapter 2 to
   Templates." with Undo. The source stays. Undo removes the copy; the server returns 404
   for it and the source still reads.
3. **Undo before the answer.** Go offline, copy again, press Undo while the notice still
   says "Copying…". The copy leaves the list. Go online: the server's receipts show the
   copy and then its delete in that order, and no copy is left.
4. **A folder tree.** Row menu on `Book` › Copy to… › Manuscript › Copy to Manuscript:
   "Copied Book to Manuscript as Book (2)." with the whole tree under it. Add a document to
   `Book (2)` with `./mf doc put`, then Undo: the folder and the later addition are gone.
   `Book` is disabled in that picker's list, as Move… disables it.
5. **A refusal.** Go offline, copy `Prologue` to `Templates`, delete `Prologue` with
   `./mf doc rm`, go online. The rows leave `Templates` and a notice on the rail says "Couldn't
   copy Prologue to Templates. A source or the destination is no longer there." with Copy
   to… and Dismiss. Reload: it is still there. Open a second tab: it shows there too.
   Dismiss in one tab: the other loses it.
6. **A gone destination.** Offline, copy a row into a new User folder, delete the folder
   with `./mf api POST …/context/user/delete`, go online. The notice shows on the surface
   that started the Copy. Copy to… › User › Templates › Copy to Templates sends the same
   row and the notice becomes "Copied … to Templates."
7. **Unsynced edits.** Open a document, patch `WebSocket.prototype.send` to drop frames,
   type an edit, copy the document. The notice stays on "Copying…" (the server answers
   `source_behind` and the replica resends). Restore the send and close the sockets: the
   Copy lands and the server copy holds the edit.
8. **A queued rename.** Offline, copy a row, rename the copy from its row menu, go online:
   the server has the copy under the new name and nothing under the predicted one.
9. **A hidden draft at the target name.** With the mock model and a draft-mode Work, have a
   chat create `kb://Hidden/Sheet` and `kb://Hidden/Vault/Note`. Create the live folder
   `kb://Hidden`, a live `kb://Sheet` and a live `kb://Vault/Item`, and Copy to… both into
   `Hidden`: the copies take `Sheet` and `Vault`, not `Sheet (2)`, and the picker lists no
   hidden row.
10. **Regressions.** A same-system drop moves at once ("Move to Act 1", no ellipsis, no
    menu) with Undo. A cross-system Move from the menu, and its Undo, work. Move… opens
    its picker, with "Change position in <folder>" where the row already is. A folder
    dragged over its own subtree refuses with "Can't go inside itself".
11. **The phone.** Emulate 393 px, touch and a coarse pointer over CDP (`Emulation.setDeviceMetricsOverride`,
    `Emulation.setTouchEmulationEnabled`). In the drawer, a row's menu offers Copy to…;
    the picker opens at the row's folder, and a pick shows "Copied … to Knowledge Base."
    with Undo.
12. **A selection nested before the send.** Select a folder (`Part`) and a sibling document
    (`Loose`) in Manuscript, go offline, and drag the selection onto a User folder (`Targets`), then
    Copy to Targets. A drop onto Knowledge Base is a plain Move, so use User. Both rows are
    listed in `Targets` under "Copying 2 items to Targets…". Move `Loose` into `Part` with
    `./mf api POST /api/projects/<id>/context/manuscript/move`, then go online. The pending
    `Loose` row leaves `Targets` as the request goes out, the notice becomes "Copied 2 items to
    Targets.", and the copy of `Part` holds `Loose` while `Targets` has no `Loose` of its own.
    The server's copy receipt names one source.

## Not covered here

A draft tab's copy of the draft has no surface yet. The replica already carries the source
view; the server side is in [The server Copy command](copy-server.md), step 3.
