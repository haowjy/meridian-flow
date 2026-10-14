# Document adoption across a reload

Protects the session-adoption commit: a New file that joins a draft and is
reloaded inside the commit window must reopen, not wedge on "Couldn't open this
document." Run on an owned `pnpm dev` stack (URLs from `pnpm portless:list`),
signed in with dev-login, in a project with a draft Work. Use one named
`agent-browser` session per viewport.

## Desktop: 30 reloads

1. Open the draft Work in Editor. Create a New file in the draft-join flow (the
   flow that creates an Untitled document and joins its draft).
2. Within about 0.3 s of the create ack, run `agent-browser reload`. Wait for the
   editor to paint.
3. Judge:
   - The editor is on screen. The "Couldn't open this document." card is absent.
   - The console shows no `immutable`, `adoption-pending` or `does not own this
     reservation`.
   - Within 2 s of painting, the room is `bindable`. In the page, open IndexedDB
     `meridian:document-session-authority:<accountId>`, store `room-order`, key the
     document id: `persistence.phase === "bindable"`, and its `generation` equals
     the lifecycle generation in the document's resource metadata.
4. Repeat 30 times. The race reproduced about twice in 30 before the commit was
   fenced; any failure is a defect.

## Phone: 10 runs, three branches

Set `agent-browser set viewport 390 844` with touch emulation so the phone shell
matches. Repeat steps 1 to 3 above 10 times, then check each phone branch once:

- **Ordinary document.** Open a writable manuscript file from Files.
- **Draft-only document.** Open a New file whose draft has not been applied
  (no live room until Apply).
- **Local pointer.** Create a New file from Files. Until the create acks, the
  route is the local pointer: `?screen=context&scheme=unfiled&path=` with the
  pointer in history state (`meridianProjectSelection`), not in the URL. Reload keeps it.

For each branch:

1. Geometry: the editor frame's height equals its column's. A zero-height frame
   is the collapse defect. Measure with `eval` on `[data-context-editor-document-id]`
   and its parent.
2. No remote carets or selections. The editor's accessible name is "Read-only
   live document". Tapping text never raises the keyboard.
3. Warm the Works catalog and let its request settle, then open the document:
   no additional Works refresh follows (watch the network panel for the Works
   snapshot request). An archived Work still opens read-only.
4. Presence stands down from the click that requests a review.
5. Force a failed open: the card shows Retry, and Retry reopens.

Record commit, date, stack, viewport, run counts and the evidence path in the
active work directory.

## Archived Work reviewing a manuscript document

Archive Work A in the Works catalog, with a pending draft on a project-owned
manuscript file. Open the file from Files, then open A's draft review (desktop
and phone). The review opens read-only (its room follows A, not the file). After
the catalog is warm and settled, opening and reopening the review sends no
additional Works refresh; unarchiving A from another tab sends one and the room
becomes editable.
