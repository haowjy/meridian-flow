# features/import

The writer-facing import: pick or drop a folder or files, watch them arrive in
the tree. Picking is the confirmation: "Import…" menus (area header, folder row,
phone `+`) offer Folder… and Files…, each opens the OS picker, and the import
starts with no dialog; an external drop starts at once on the highlighted
target. A selection that cannot start (empty, over a limit) is the only thing
that stops to say why (`selection-limits.ts`). What an import admits (limits, omitted vs skipped paths)
and the export marker parser come from `@meridian/contracts`; `limits.ts` holds
only browser scheduling. There is no report page, route or
status row; a clean finish leaves nothing: the coordinator retires the import
once its bridges close. A failed file keeps its row warning and
its in-document notice (`ImportDocumentNotice.tsx`) with Retry. No surface yet
shows a running or interrupted import; the owner is deciding a single global
import panel, which will read `coordinator.view` and `display-state.ts` as they are.
`StopImportDialog` waits for it. The server (`apps/server/server/domains/import`) owns
planning, allocation, conversion and landing; this feature owns what the browser
can do about it.

- **Navigate first.** `ImportCoordinator.start` mints the id and returns at once.
  Row ids, hashing, the plan and the uploads run in the background; a failure is
  shown on the import, never by going back.
- **One coordinator owns import state; surfaces only read.** It owns acquisition
  (the open-list poll, one full read, `?since=` cuts, a by-id read when an import
  leaves the list), the per-import set of node ids the catalog has held (`seen`,
  filled from its own subscription to the narrow `CatalogReader` the provider
  injects), the 30-second bridges that cover a row the tab drew until the catalog
  shows it, the `documentId` index, and the retirement of every store (finished or
  gone, no command in flight, no bridge open). No surface has to be mounted for a
  failure to show or a run to end.
- **Node ids are shared.** `importNodeId` (contracts) gives predicted rows
  (`client-rows.ts`) the ids the server's plan gives the same nodes, so rows,
  seen ids and expansion join by id from pick to landing.
- **Pending rows are a projection**, not resource-replica intents.
  `tree-projection.ts` is a pure function of a catalog view and the coordinator
  snapshot, following six rules (catalog row, seen, predicted, unlanded overlay,
  bridge, nothing). It never writes back.
- **One store per import** (`ImportStore`) is a passive cache: the full read,
  `?since=` cuts and this tab's own upload answers merge into one report. It never
  reads or polls.
- **One display state** (`display-state.ts`) for every surface. Counts come from
  `effectiveCounts`: a file whose send failed here is failed, though the server
  still thinks it is planned.
- **`wanted` is the send authority.** The report's `entry.wanted` decides what
  this tab sends or counts as left; never re-derive it from entry states (a
  planned/failed filter stranded crashed landings).
- **Words are the app's.** The server sends codes (`reason-copy.ts`); every
  sentence is Lingui, none separates facts with `·`, `•`, `—` or `|`, none says
  manifest, entry, plan, sniff, digest or the name of another app. The app shows
  only failed and skipped files.
- **No ZIP reader, no `fflate`.** A ZIP is a file. Names the server would refuse
  (`:`, `?`, `*`) are left out and reported as unreadable instead of failing the
  whole import: the manifest's `unreadable` paths keep their source names, which
  the server reports and never allocates.
- The drop dispatcher is `features/project/context/tree-drop/`. Drop targets
  capture with `lib/dropped-items.ts`; this feature only supplies the `files`
  route's reader (`read-dropped.ts`), which walks the capture.
