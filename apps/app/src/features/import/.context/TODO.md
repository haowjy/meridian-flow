# features/import — deferred work

Delete an entry when it ships.

- **Safari, iOS Safari and a real Firefox folder chooser are unverified.**
  `read-picked.ts`, `read-dropped.ts` and `selection.ts` follow the browser
  evidence (WebKit hides dot-entries; Firefox and Chromium share them), but no
  folder pick or drop has run in Safari, on iOS, or through Firefox's native
  chooser. Follow-up: pick and drop a folder holding `.obsidian/app.json` in
  each, check the selection's roots and whether the settings reached the
  selection, and record results in the work item's evidence. Also check that the
  hidden file input still opens from a menu item in Safari (the picker opens
  after the menu closes).

- **A document deleted through the API took about 11 s to leave the tree.**
  `./mf doc rm` on imported `Lore/Sects` cleared from the sidebar ~11 s later
  (re-check run 4b). This may be pre-existing catalog wake latency rather
  than import code; reproduce on `main` before fixing. Evidence:
  `evidence/d1-fix/run4-delete-timeline.txt`.

- **Drop acceptance should say what a drop will do.** `tree-drop/` takes the hint's
  label from the accepting route's verdict (`EntriesVerdict`, shared by the entries
  and files routes), while the drop effect still comes from the route kind
  (`kind === "files" ? "copy" : "move"`). A route that could Copy or Move by place
  should return its effect too, so a target renders it without knowing which route
  accepted. See `reviews/simplify-app.md` finding 7 in the work item.
