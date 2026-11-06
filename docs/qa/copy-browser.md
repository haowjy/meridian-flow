# Copy in the tree

Named risks: a copy that waits for the server before it shows, a refused Copy the
writer never sees, a copy that sends a
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
2. **Copy.** Choose Copy. The copy is listed in `Templates` at once and the source stays.
   No toast.
3. **A folder tree.** Row menu on `Book` › Copy to… › Manuscript › Copy to Manuscript:
   `Book (2)` appears with the whole tree under it. `Book` is disabled in that picker's
   list, as Move… disables it.
4. **A refusal.** Go offline, copy `Prologue` to `Templates`, delete `Prologue` with
   `./mf doc rm`, go online. The rows leave `Templates` and a toast at the top right says
   "Couldn't copy Prologue to Templates. A source or the destination is no longer there."
   It stays until closed and has no Retry, because the source is gone. Reload: it shows
   again. Open a second tab: it shows there too. Close it in one tab: the other loses it,
   and a reload shows nothing. Two refusals at once show two toasts. A forced refusal (post
   `{}` to `/context/copy`) with the source still there offers Retry, which copies the rows.
   Force that refusal, then delete the source: the toast stays and loses its Retry. Retry
   pressed in the moment before that shows the toast again without Retry.
5. **A gone destination.** Offline, copy a row into a new User folder, delete the folder
   with `./mf api POST …/context/user/delete`, go online. The toast has no Retry.
6. **Unsynced edits.** Open a document, patch `WebSocket.prototype.send` to drop frames,
   type an edit, copy the document. The copy stays listed while
   the server answers `source_behind` and the replica resends. Restore the send and close the sockets: the
   Copy lands and the server copy holds the edit.
7. **A queued rename.** Offline, copy a row, rename the copy from its row menu, go online:
   the server has the copy under the new name and nothing under the predicted one.
8. **A hidden draft at the target name.** With the mock model and a draft-mode Work, have a
   chat create `kb://Hidden/Sheet` and `kb://Hidden/Vault/Note`. Create the live folder
   `kb://Hidden`, a live `kb://Sheet` and a live `kb://Vault/Item`, and Copy to… both into
   `Hidden`: the copies take `Sheet` and `Vault`, not `Sheet (2)`, and the picker lists no
   hidden row.
9. **Regressions.** A same-system drop moves at once ("Move to Act 1", no ellipsis, no
    menu). A cross-system Move from the menu works. Move… opens
    its picker, with "Change position" where the row already is. A folder
    dragged over its own subtree refuses with "Can't go inside itself".
10. **The phone.** Emulate 393 px, touch and a coarse pointer over CDP (`Emulation.setDeviceMetricsOverride`,
    `Emulation.setTouchEmulationEnabled`). In the drawer, a row's menu offers Copy to…;
    the picker opens at the row's folder, and a pick lands the copy with no toast. A 393 px
    window with a fine pointer is the desktop shell: that is not a phone run.
11. **A selection nested before the send.** Select a folder (`Part`) and a sibling document
    (`Loose`) in Manuscript, go offline, and drag the selection onto a User folder (`Targets`), then
    Copy to Targets. A drop onto Knowledge Base is a plain Move, so use User. Both rows are
    listed in `Targets`. Move `Loose` into `Part` with
    `./mf api POST /api/projects/<id>/context/manuscript/move`, then go online. The pending
    `Loose` row leaves `Targets` as the request goes out, and the copy of `Part` holds `Loose` while `Targets` has no `Loose` of its own.
    The server's copy receipt names one source.

## Not covered here

A draft tab's copy of the draft has no surface yet. The replica already carries the source
view; the server side is in [The server Copy command](copy-server.md), step 3.
