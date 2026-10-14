# features/import

The writer-facing import: pick or drop a folder or files, watch them arrive in
the tree. Picking is the confirmation: "Import…" menus (area header, folder row,
phone `+`) offer Folder… and Files…, each opens the OS picker, and the import
starts with no dialog; an external drop starts at once on the highlighted
target. A selection that cannot start (empty, over a limit) is the only thing
that stops to say why (`selection-limits.ts`). There is no report page, route or
status row; a clean finish leaves nothing and is dismissed for the writer once
the catalog draws every row the tab held. A failed file keeps its row warning and
its in-document notice (`ImportDocumentNotice.tsx`) with Retry. No surface yet
shows a running or interrupted import; the owner is deciding a single global
import panel, which will read `ImportStore` and `display-state.ts` as they are.
`StopImportDialog` waits for it. The server (`apps/server/server/domains/import`) owns
planning, allocation, conversion and landing; this feature owns what the browser
can do about it.

- **Navigate first.** `ImportCoordinator.start` mints the id, draws the rows and
  returns at once. Hashing, the plan and the uploads run in the background; a
  failure is shown on the import, never by going back.
- **Pending rows are a projection**, not resource-replica intents.
  `tree-projection.ts` layers an import's rows over a catalog view: rows the
  server has not made yet come from the importing tab's selection, real rows gain
  "arriving" and "failed" marks. The server is the only writer of these documents.
- **One store per import** (`ImportStore`): the full read, `?since=` cuts and this
  tab's own upload answers merge into one report; every surface reads it.
  Polling runs only while something watches.
- **One display state** (`display-state.ts`) for every surface. Counts come from
  `effectiveCounts`: a file whose send failed here is failed, though the server
  still thinks it is planned.
- **`wanted` is the send authority.** The report's `entry.wanted` decides what
  this tab sends or counts as left; never re-derive it from entry states (a
  planned/failed filter stranded crashed landings).
- **No Sort with AI yet.** Nothing offers it; the manifest's `sort`
  is always false until P7 (see
  [the server FUTURE.md](../../../../server/server/domains/import/.context/FUTURE.md)).
- **Words are the app's.** The server sends codes (`reason-copy.ts`); every
  sentence is Lingui, none separates facts with `·`, `•`, `—` or `|`, none says
  manifest, entry, plan, sniff, digest or the name of another app. The app shows
  only failed and skipped files and ignores the server's other findings.
- **No ZIP reader, no `fflate`.** A ZIP is a file. Names the server would refuse
  (`:`, `?`, `*`) are left out and reported as unreadable instead of failing the
  whole import: the manifest's `unreadable` paths keep their source names, which
  the server reports and never allocates.
- The drop dispatcher is `features/project/context/tree-drop/`. Drop targets
  capture with `lib/dropped-items.ts`; this feature only supplies the `files`
  route's reader (`read-dropped.ts`), which walks the capture.
