# Document adoption across a reload

Protects the session-adoption commit: a New file that joins a draft and is
reloaded inside the commit window must reopen, not wedge on "Couldn't open this
document." Run on an owned `pnpm dev` stack (URLs from `pnpm portless:list`),
signed in by `DEV_AUTH_BYPASS=1`, in a project with a draft Work. Use one named
`agent-browser` session per viewport.

## Phone branches

The phone shell needs a viewport of 390x844 and a coarse pointer. `agent-browser`
has no coarse-pointer emulation, so launch it with
`AGENT_BROWSER_ARGS='--blink-settings=primaryPointerType=2'` and then
`agent-browser set viewport 390 844`.

- **Ordinary document.** Open a writable manuscript file from Files.
- **Draft-only document.** Open a New file whose draft has not been applied
  (no live room until Apply).
- **Local pointer.** Phone files don't auto-open from the Files `+` row, so that
  row never produces the pointer. Reach it at desktop width with a coarse pointer:
  hold the network offline, create a New file (a `meridianProjectSelection`
  pointer appears in history state, and the URL stays `/editor?work=<workId>`),
  then change the viewport to 390x844. Reload keeps the pointer.

1. Geometry: the editor frame's height equals its column's. A zero-height frame
   is the collapse defect. Check `[data-context-editor-document-id]` and its
   parent.
2. No remote carets or selections. The editor's accessible name is "Read-only
   live document".
3. Warm the Works catalog, then open the document: no additional Works refresh
   follows (count `GET /api/projects/<id>/works` with a per-page `fetch` wrapper;
   `agent-browser network requests` is session-wide and counts other tabs). Warm
   means: open once, wait for the Works catalog request to settle, then repeated
   opens send none. A first open after idle can refresh once because the catalog
   is stale; a refresh on every open is the defect. An archived Work still opens
   read-only.
4. Force a failed open: the card shows Retry, and Retry reopens.

## Archived Work reviewing a manuscript document

Archive Work A in the Works catalog, with a pending draft on a project-owned
manuscript file. Open the file from Files, then open A's draft review (desktop
and phone). The review opens read-only (its room follows A, not the file). After
the catalog is warm, opening and reopening the review sends no additional Works
refresh; unarchiving A from another tab sends one and the room becomes editable.
