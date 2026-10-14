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
its in-document notice (`ImportDocumentNotice.tsx`) with Retry. The tree and the
phone listing show the run's own marks (`ImportRunMark`): a spinner while the
selection is read, a quiet spinner while files are sent (menu: Stop import), and
warnings for an import that didn't start (Try again, Discard), one the server wants
files for that this tab doesn't hold (Continue import…, Stop here) and one with
failed files (Retry failed files when this tab holds them, else Continue import…;
Stop here). Each menu opens with the state's sentence (`runSentence`). `run-mark.ts`
derives the kind from `display-state.ts`; Stop opens `StopImportDialog` through the
provider's `openStop` and runs the coordinator's `stop`. A future progress popup
reads the same `ImportRunInfo`. The server (`apps/server/server/domains/import`) owns
planning, allocation, conversion and landing; this feature owns what the browser
can do about it.

See [`.context/TODO.md`](.context/TODO.md) for deferred browser verification and
cleanup.

- **Navigate first, begin before reading.** `ImportCoordinator.begin(destination,
  read)` mints the id, the run and its abort signal before the selection is read;
  the provider keeps only the synchronous picker click and `DataTransfer` capture.
  The `reading` phase spins on the destination row, and `isWorking()` drives the
  unload warning while a run is reading, hashing, planning or sending. Disposal
  aborts the read; a disposed coordinator refuses `begin`. Row ids, hashing, the
  plan and the uploads run in the background; a failure is shown on the import,
  never by going back.
- **A refused or lost plan is `not-started` with its code.** `targetOf`
  (`placements.ts`, from the predicted rows until the status is read in full, then from the status) is the one contract for where an import and its marks show: the
  predicted root folder rows, else the destination folder, else each routed area's
  header (`anchors`). The tree and the phone listing render `ImportRunMark` from
  it, and its menu offers Try again (same id, same manifest) and Discard (local
  after a definite refusal; `finish` after a lost answer, since the server may hold
  the import). Reading shows the same mark on the destination.
- **One coordinator owns import state; surfaces only read.** It owns acquisition
  (the open-list poll, one full read, `?since=` cuts, a by-id read when an import
  leaves the list), the `documentId` index and retirement. Each import is one
  `ImportRecord` (`import-record.ts`: store, run, plan, read and catalog
  `Handoff`), and retiring it disposes all of that. The `Handoff`
  (`import-handoff.ts`) keeps the node ids the catalog has held (`seen`, filled
  from the narrow `CatalogReader` the provider injects) and the 30-second bridges
  that cover a row the tab drew until the catalog shows it: bridges open as a
  batch, one timer waits for the next deadline, and a batch that expires publishes
  once. A first full status, from the plan or from the poll, hands drawn rows to
  bridges in one place (`installFull`). Construction attaches nothing: `start()`
  (inside `watchOpen`) subscribes to the catalog and its disposer undoes it, so
  a render React throws away leaves no subscriber. Every answer after an await is
  fenced by the coordinator's `epoch` (advanced by `dispose`, since `watchOpen`
  revives the same object) and by the import's current record.
- **Continue resumes by id.** It re-picks the files, checks them against the
  stored plan (`continue-check.ts`), and installs the match once as a map from
  server entry id to `File`; every later send and Retry looks files up by entry
  id and never rematches. A `planning` import is resumed with
  `POST /imports/:id/resume`, never re-planned. A wanted entry with no held file
  fails locally on its row.
- **Commands need a fresh read.** Retry, Continue and resume send only after a
  successful full read (`read` answers true or false; background polls ignore
  it). On failure nothing is sent and recovery state is kept: Retry's rows keep a
  failure that says to try again, Continue's dialog shows the error, resume goes
  back to Couldn't stop. A file leaves `held` as soon as its entry's answer is
  final (landed, deleted, not imported, skipped); failed files stay for Retry.
- **Node ids are shared.** `importNodeId` (contracts) gives predicted rows
  (`client-rows.ts`) the ids the server's plan gives the same nodes, so rows,
  seen ids and expansion join by id from pick to landing.
- **Pending rows are a projection**, not resource-replica intents.
  `tree-projection.ts` is a pure function of a catalog view and the coordinator
  snapshot, following six rules (catalog row, seen, predicted, unlanded overlay,
  bridge, nothing). An overlay sits in the area of its nearest catalog ancestor by
  id (the planned area only for nodes at an area root), and an import none of
  whose nodes can land in a scheme is skipped, so an unrelated scheme keeps its
  own view. It never writes back.
- **One store per import** (`ImportStore`) is a passive cache: the full read,
  `?since=` cuts and this tab's own upload answers merge into one import status
  (`ImportStatus`, held as `state.status`). It never reads or polls.
- **One display state** (`display-state.ts`) for every surface. Counts come from
  `effectiveCounts`: a file whose send failed here is failed, though the server
  still thinks it is planned.
- **`wanted` is the send authority.** The status's `entry.wanted` decides what
  this tab sends or counts as left; never re-derive it from entry states (a
  planned/failed filter stranded crashed landings).
- **Words are the app's.** The server sends codes (`reason-copy.ts`); every
  sentence is Lingui, none separates facts with `·`, `•`, `—` or `|`, none says
  manifest, entry, plan, sniff, digest or the name of another app. The tree
  shows failed files; skipped files have no surface until the progress popup
  lands (its "Not imported" line, `ux-v2.md`).
- **No ZIP reader, no `fflate`.** A ZIP is a file. Names the server would refuse
  (`:`, `?`, `*`) are left out and reported as unreadable instead of failing the
  whole import: the manifest's `unreadable` paths keep their source names, which
  the server reports and never allocates.
- The drop dispatcher is `features/project/context/tree-drop/`. Drop targets
  capture with `lib/dropped-items.ts`; this feature only supplies the `files`
  route's reader (`read-dropped.ts`), which walks the capture.
