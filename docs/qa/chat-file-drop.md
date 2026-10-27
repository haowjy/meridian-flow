# Desktop files dropped on a chat

This recipe checks the named risk that a file dragged from the desktop onto a
chat lands somewhere other than the chat's Uploads, takes a different path from
the paperclip, stays lit after the drag, or steals a drop owned by the tree.

## Setup

Use the lane's `pnpm dev` stack at 1440×900 and a chat that has one reply. Make
a scratch directory outside the checkout with: three small text files, a 60 MB
file, an `.exe`, a file named `bad:name.txt`, and a folder holding one file.

Headless Chromium cannot start an OS drag, and a synthetic `DragEvent` carries no
real files or folders. Send a native one over CDP instead: connect to the page
target (`agent-browser get cdp-url`, then the target's `webSocketDebuggerUrl`)
and call `Input.dispatchDragEvent` with `type` `dragEnter`, `dragOver` and `drop`
and `data: { items: [], files: ["/abs/path", …], dragOperationsMask: 1 }`. A
folder path arrives as a directory entry. `dragCancel` does not deliver
`dragleave`; end a hover by moving over a surface outside the chat.

## Steps

1. Hold a file drag over the composer: the box lights and the pointer hint
   reads **Attach to this chat**. Hold it over the transcript: the composer
   lights, not the transcript, with the same hint. Move over the sidebar: both go.
2. Drop three files on the transcript. Three chips appear at the composer's
   caret in drop order, one space apart, each `name…` until its intake answers,
   then the chip the paperclip makes. Send stays disabled while any is pending.
   Repeat on the composer and in the New chat composer.
3. Drop a 60 MB file and an `.exe`: both attach. The intake has no size limit and
   classifies any type as a binary file, so neither is refused.
4. Drop `bad:name.txt`: its chip reads "bad:name.txt (This filename contains
   unsupported characters. Rename the file and attach it again.)" and the other
   files dropped with it still attach.
5. Drop the folder with a file: the folder is a failed chip, "folder (Folders
   can't be attached)", and the file attaches. The file input cannot pick a
   folder either.
6. `agent-browser set offline on`, drop two files: both chips fail with "Couldn't
   reach the server. Check your connection." (not "Failed to fetch"). Go online
   and click one chip: it retries and becomes a document chip; the other stays failed.
7. Drag a tree row onto the composer text: the caret and **Mention** hint show
   and one mention chip lands. Over the transcript nothing lights and nothing
   lands. Drop a desktop file on a Manuscript row: **Import into Manuscript** and
   the import toast, with the composer unlit.
8. Emulate the phone shell (CDP `Emulation.setDeviceMetricsOverride` mobile with
   `setTouchEmulationEnabled`, held open while driving, as in
   [Chat Files menu](chat-files.md)) and drag a file over the composer: nothing
   lights, no hint, nothing attaches.

Record the commit, date and a screenshot of each state in the active work
directory or the PR asset directory.
