# features/import — deferred work

Delete an entry when it ships.

- **Safari, iOS Safari and a real Firefox folder chooser are unverified.**
  `read-picked.ts`, `read-dropped.ts` and `selection.ts` follow the browser
  evidence (WebKit hides dot-entries; Firefox and Chromium share them), but no
  folder pick or drop has run in Safari, on iOS, or through Firefox's native
  chooser. Follow-up: pick and drop a folder holding `.obsidian/app.json` in
  each, check the selection's roots and whether the settings reached the
  manifest, and record results in the work item's evidence. Also check that the
  hidden file input still opens from a menu item in Safari (the picker opens
  after the menu closes).

- **The sending tab may compute `importing-elsewhere` for one frame.** On the
  deleted status row, the tab that was sending showed "Sending from another
  window" for one 50 ms sample just before the finish (D1 re-check runs). The
  sender-identity check likely loses the local run for one render as it
  finishes (`display-state.ts`). Nothing renders that state today. Follow-up:
  before the progress popup reads `display-state.ts`, keep the sending tab's
  identity until the finished status is installed. Evidence:
  `evidence/d1-fix/run2-timeline.txt` in the work item.

- **A document deleted through the API took about 11 s to leave the tree.**
  `./mf doc rm` on imported `Lore/Sects` cleared from the sidebar ~11 s later
  (D1 re-check run 4b). This may be pre-existing catalog wake latency rather
  than import code; reproduce on `main` before fixing. Evidence:
  `evidence/d1-fix/run4-delete-timeline.txt`.

- **The phone's area chooser has no run mark.** `MobileContextBrowser.tsx`
  shows the import marks in a folder listing and its header, but the
  top-level Manuscript/Knowledge Base/Unfiled list shows none, so a refused
  routed export is only visible after opening an area. Follow-up: render the
  operation target's mark on the chooser's area rows, reading `targetOf`.

- **Drop acceptance should say what a drop will do.** `tree-drop/` accepts
  external files with a hard-coded copy effect and "Import here" label.
  Internal row drags (the drag-anywhere lane) need the accepting route to
  return its effect and label so targets render either without knowing which
  route accepted. See `reviews/simplify-app.md` finding 7 in the work item.
