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

The phone shell needs a viewport of 390x844 and a coarse pointer. `agent-browser`
has no coarse-pointer emulation, so launch it with
`AGENT_BROWSER_ARGS='--blink-settings=primaryPointerType=2'` and then
`agent-browser set viewport 390 844`. That gives `(pointer: coarse)` and the phone
shell. The first launch with extra args can fail with "Multiple targets are not
supported in headless mode"; retry.

The phone join runs differ from the desktop ones: New file does not open the file
on the phone, it stays in the Files listing. Each of the 10 runs is: create a New
file, reload at the create ack plus the delay, tap the row to open it, then judge
as in step 3 above. Then check each phone branch once:

- **Ordinary document.** Open a writable manuscript file from Files.
- **Draft-only document.** Open a New file whose draft has not been applied
  (no live room until Apply).
- **Local pointer.** Phone files don't auto-open from the Files `+` row, so that
  row never produces the pointer. Reach it at desktop width with a coarse pointer:
  hold the network offline, create a New file (a `meridianProjectSelection`
  pointer appears in history state, and the URL stays `/editor?work=<workId>`),
  then change the viewport to 390x844. Reload keeps the pointer.

For each branch:

1. Geometry: the editor frame's height equals its column's. A zero-height frame
   is the collapse defect. Measure with `eval` on `[data-context-editor-document-id]`
   and its parent.
2. No remote carets or selections. The editor's accessible name is "Read-only
   live document".
3. Warm the Works catalog, then open the document: no additional Works refresh
   follows (count `GET /api/projects/<id>/works` with a per-page `fetch` wrapper;
   `agent-browser network requests` is session-wide and counts other tabs). Warm
   means: open once, wait for the Works catalog request to settle, then repeated
   opens send none. A first open after about 20 s idle can refresh once because
   the catalog is stale; that is not the defect. A refresh on every open is. An
   archived Work still opens read-only.
4. Force a failed open: the card shows Retry, and Retry reopens.

Manual, on a real touch device (headless has no touch keyboard or review click):

- Presence stands down from the click that requests a review.
- Tapping text never raises the keyboard.

Record commit, date, stack, viewport, run counts and the evidence path in the
active work directory.

## Archived Work reviewing a manuscript document

Archive Work A in the Works catalog, with a pending draft on a project-owned
manuscript file. Open the file from Files, then open A's draft review (desktop
and phone). The review opens read-only (its room follows A, not the file). After
the catalog is warm (defined above), opening and reopening the review sends no
additional Works refresh; unarchiving A from another tab sends one and the room
becomes editable.
