# features/import — deferred work

Delete an entry when it ships.

- **Safari, iOS Safari and a real Firefox folder chooser are unverified.**
  `read-picked.ts`, `read-dropped.ts` and `selection.ts`
  (`browserHidesDotEntries`, `noteHiddenSettings`) follow the browser evidence
  (WebKit hides dot-entries; Firefox and Chromium share them), but no folder
  pick or drop has run in Safari, on iOS, or through Firefox's native chooser.
  Follow-up: pick and drop a vault with `.obsidian/app.json` in each, and check
  the selection's roots, the `appJsonUnread` reason and the report's Obsidian
  settings line; record results in the work item's evidence.
