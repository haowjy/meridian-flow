# Copy in the tree

Named risks: a refused Copy the writer never sees, a copy that sends a
document without the edits the device holds, a copy that takes the wrong name, and a drop or
Move… that stopped working because Copy joined them. This recipe drives the browser with
`agent-browser`. The server command has its own recipe, [The server Copy command](../../../../../../../server/server/domains/context/.context/qa/copy-server.md).

## Setup

1. Start an owned stack (`MODEL_PROVIDER=mock pnpm dev` for steps that seed a draft) and find
   its origins with `pnpm portless:list`. Sign in with the dev user.
2. Seed with `./mf doc put --text`: `manuscript://Book/Act 1/Chapter 1`, `manuscript://Book/Act 1/Prologue`,
   `manuscript://Book/Act 2/Chapter 2`, `manuscript://Book/Notes/Ideas`,
   `kb://characters/Hero`, `user://Templates/Style guide`. Create a Work with
   `./mf api POST /api/projects/<id>/works --data "{\"commandId\":\"$(cat /proc/sys/kernel/random/uuid)\",\"name\":\"w\",\"goal\":\"g\"}"` and seed
   `scratch://Scene notes` with `--work w1`.
3. Drag with `agent-browser mouse move/down/up` in several moves; a native drag needs
   pointer events between press and release. The Files rail's User panel is short and
   scrolls: scroll a target into view before dragging to it.

## Steps

1. **The menu.** Drag `Chapter 2` onto User › `Templates`. The hint reads "Move to
   Templates…"; on release a menu at the pointer offers Move to Templates, Copy to
   Templates and Cancel.
2. **Copy.** Choose Copy. The copy is listed in `Templates` and the source stays.
   No toast.
3. **A folder tree.** Row menu on `Book` › Copy to… › Manuscript › Copy here:
   a second `Book` appears with the whole tree under it (its path `Book~…`). `Book` is disabled in that picker's
   list, as Move… disables it.
4. **A refusal.** Copy `Prologue` to `Templates` with a one-shot `window.fetch` rewrite that posts `{}`
   to `/context/copy`: the server refuses it, the rows never appear, and a toast at the top right
   says "Couldn't copy Prologue to Templates." with the route's reason when it gave one. Retry
   sends the Copy again as a new Copy and the rows appear.
5. **Unsynced edits. Blocked until Stage C fixes Copy.** The browser never sends
   `sources[].stateVector` (`execute-copy.ts`), and the server checks for missing edits only when
   that vector is present (`copy-command.ts`), so the `source_behind` refusal below can't happen
   yet and the Copy lands without the unsynced edit. Run this step once Copy sends the vector.

   Open a document, patch `WebSocket.prototype.send` to drop frames,
   type an edit, copy the document. The server answers `source_behind`: the toast says "The latest
   edits hadn't reached the server." with Retry. Restore the send and close the sockets, then
   Retry: the Copy lands and the server copy holds the edit.
6. **A hidden draft at the target name.** With the mock model and a draft-mode Work, have a
   chat create `kb://Hidden/Sheet` and `kb://Hidden/Vault/Note`. Create the live folder
   `kb://Hidden`, a live `kb://Sheet` and a live `kb://Vault/Item`, and Copy to… both into
   `Hidden`: the copies take `Sheet` and `Vault`, not `Sheet (2)`, and the picker lists no
   hidden row.
7. **Regressions.** A same-system drop moves at once ("Move to Act 1", no ellipsis, no
    menu). A cross-system Move from the menu works. Move… opens
    its picker, with "Change position" where the row already is. A folder
    dragged over its own subtree refuses with "Can't go inside itself".
8. **The phone.** Emulate 393 px, touch and a coarse pointer over CDP (`Emulation.setDeviceMetricsOverride`,
    `Emulation.setTouchEmulationEnabled`). In the drawer, a row's menu offers Copy to…;
    the picker opens at the row's folder, and a pick lands the copy with no toast. A 393 px
    window with a fine pointer is the desktop shell: that is not a phone run.

## Not covered here

A draft document's copy of the draft has no surface yet. The browser already sends the source
view; the server side is in [The server Copy command](../../../../../../../server/server/domains/context/.context/qa/copy-server.md), step 3.
