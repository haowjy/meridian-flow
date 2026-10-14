# features/import — deferred work

Delete an entry when it ships.

- **Safari, iOS Safari and a real Firefox folder chooser are unverified.**
  `read-picked.ts`, `read-dropped.ts` and `selection.ts`
  (`browserHidesDotEntries`, `noteHiddenSettings`) follow the browser evidence
  (WebKit hides dot-entries; Firefox and Chromium share them), but no folder
  pick or drop has run in Safari, on iOS, or through Firefox's native chooser.
  Follow-up: pick and drop a vault with `.obsidian/app.json` in each, and check
  the selection's roots and the `appJsonUnread` reason; record results in the
  work item's evidence. Also check that the hidden file input still opens from a
  menu item in Safari (the picker opens after the menu closes).

- **A planned folder can draw twice for about half a second while
  "Preparing".** The catalog can hold the planned folder before the plan's
  answer is installed, and the provisional client folder hands off only after
  that answer (a same-named existing folder must not swallow it). Seen at
  282–782 ms in two D1 re-check runs; predates the per-row handoff. Follow-up:
  let the provisional folder yield to a catalog row with the plan's path once
  the plan resolves, without matching a pre-existing folder by name.
  Evidence: `evidence/d1-fix/README.md` (runs 2 and 4) in the work item.

- **The sending tab can read as "importing elsewhere" for one frame.**
  In every D1 re-check run, the old status row in the tab that was sending showed
  "Sending from another window" for one 50 ms sample just before the finish. The
  sender-identity check likely loses the local session for one render as the
  run finishes (`display-state.ts`). Follow-up: keep the sending tab's identity
  until the finished report is installed, before the global import panel reads
  it. Evidence: `evidence/d1-fix/run2-timeline.txt`.

- **A document deleted through the API took about 11 s to leave the tree.**
  `./mf doc rm` on imported `Lore/Sects` cleared from the sidebar ~11 s later
  (D1 re-check run 4b). This may be pre-existing catalog wake latency rather
  than import code; reproduce on `main` before fixing. Evidence:
  `evidence/d1-fix/run4-delete-timeline.txt`.
