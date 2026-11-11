# Runtime probes

Recipes live beside the code they check, in `.context/qa/<name>.md`. List them with
`git ls-files '*/.context/qa/*.md'`: ripgrep and most globs skip hidden folders.

Use these recipes to check the running product, in addition to `pnpm check`.
While working, `./mf` is the verification tool for the code it shares with the
app (the socket client, message serializer and chat event processing), and a
`./mf` run is evidence for that code against the real server. A command with no
shared client code behind it is evidence of the server only. What the writer
sees (rendering, the composer, optimistic UI, client state) is checked in the
browser (`agent-browser`), judged by the screen with the durable transcript as
truth. A PR that changes app behavior confirms it in the browser at least once,
at the end. A new recipe uses `./mf` steps where the code is shared, and ends
with a browser confirmation.
Keep evidence in the active work directory, not in this repository. Record the
commit, date, stack/provider, outcome, and evidence path after each run. A recipe
is not a claim that it passed on the current commit.
A gate's probe runs on its own fresh stack and database, from a detached
checkout pinned to the commit under test. Never reuse another session's stack or
probe the integration worktree's: a checkout that moves under a watching dev
server, or a reused database, produces regressions that vanish on a clean
stack.

- [Signed-out redirects](../../apps/www/.context/qa/signed-out-redirects.md): the circle between the landing page, sign-in, sign-up and log out, with the auth bypass off.
- [Rich mock provider](../../apps/server/server/domains/runtime/gateway/.context/qa/mock-provider.md): samples, large output, thinking, pacing, cancellation, tool scripts and startup defaults.
- [The model's move and delete](../../apps/server/server/domains/collab/.context/qa/model-move-delete.md): tool rows, the turn card's lines and Undo at a free name, absorbed-folder Undo, and a stopped reply's rollback, in the browser on the mock model.
- [Model-owned chat actions](../../apps/server/server/domains/runtime/.context/qa/model-agent-actions.md): Work switch during a reply, next-reply write mode, out-of-lineage background messaging, and read-Agent refusals.
- [Atomic frozen Apply](../../apps/server/server/domains/collab/.context/qa/atomic-apply.md): production API-core command, merge, rollback and lifecycle probes over a scratch database.
- [Document removal records](document-removal-records.md): populated upgrade, actor readback, Trash list/read/restore, pending-Work retention, permanent purge, closure/admission races, storage release and after-commit room retirement.
- [Document existence admission](../../apps/server/server/domains/collab/.context/qa/document-existence-admission.md): live frames, saves and Apply against a removal, head creation only by create or repair, with the pause controller.
- [Direct upload canary](../../apps/server/server/domains/storage/.context/qa/direct-put.md): signed PUT length and type, copy, ranged reads, CORS and expiry against MinIO or R2, with a browser PUT.
- [Runtime protocols](../../apps/server/server/domains/runtime/.context/qa/runtime-probes.md): RP-1 through RP-21, server protocol checks driven with `./mf`; RP-17 runs `./mf` beside the browser. They don't verify the app.
- [Project chrome and shell](../../apps/app/src/features/project/.context/qa/project-chrome-manual.md): the browser checks that replaced nine slow DOM tests in `apps/app`.
- [Stop and hand-back](../../apps/server/server/domains/runtime/.context/qa/stop-and-hand-back.md): written steps for the pure Stop rows with no unit case, each naming the DB row or browser item that pins it.
- [Failure cards](../../apps/app/src/features/chat/.context/qa/failure-cards.md): the failed reply, refused and lost Retry, failed compaction, handoff brief and live-region clearing, driven in the browser with injected faults.
- [Queue controls](../../apps/app/src/features/chat/.context/qa/queue-controls.md): QC-01 to QC-08, the queued look, the x, Cancel queue, Send now and every failure card, driven in the browser with injected faults.
- [Durable questions](../../apps/server/server/domains/runtime/.context/qa/ask.md): answer, own words, Skip, timeout, restart and crash recovery, claim races, the queue barrier, and fork refusal.
- [Unsent edits hold a live session](../../apps/app/src/core/editor/.context/qa/unsent-edits-session-hold.md): offline edit, tab closed, reconnect without reopening, and the removal exit; plus the two-draft Apply and untitled-document probes.
- [Browser state envelopes](../../apps/app/.context/qa/browser-state-envelopes.md): reload all browser-persisted surfaces and reject transplanted ownership.
- [Settled chat Markdown](../../apps/app/src/features/chat/.context/qa/chat-markdown.md): manuscript parity, list rhythm, highlighting and code copy.
- [Chat session](../../apps/app/src/features/chat/.context/qa/chat-session.md): compare a chat in the browser with `./mf thread view --json` by row identity, kind, item kinds and text, the `cN` ref steps, and SY-01 to SY-07, the live-sync recipes (join, reload, navigate, another client's message, Stop, a held write-mode switch, a network gap).
- [Chat submissions](../../apps/app/src/features/chat/.context/qa/chat-submissions.md): first-send and existing-send failure, FIFO ownership and tab takeover.
- [Folder mentions](../../apps/app/src/features/links/.context/qa/folder-mentions.md): the `@` Mention row, composer and Editor folder chips, the drill-in menu a folder chip opens, and rename or delete then click.
- [Chat Files menu](../../apps/app/src/features/chat/.context/qa/chat-files.md): shared nested Scratch plus chat uploads; search, rename, move, delete, fork source and phone parity.
- [Crash and two processes](../../apps/server/server/domains/collab/.context/qa/crash-and-two-process.md): P5, a server crash between a draft write's commit and its ack, then the resend; P6, two servers on one database with a tab on each, using `tools/qa/shared-db-server.ts` and `draft-readback.ts`.
- [Stable draft identity and terminal closes](../../apps/app/src/features/draft-review/.context/qa/draft-generations.md): draft rooms through Discard all, a fresh server instance and live restore; `4205`, `4207` and removal `4208`.
- [Lock-free drafts seam probes](../../apps/server/server/domains/collab/.context/qa/drafts-lock-free-probes.md): the PostgreSQL interleavings behind lock-free drafts (Work-first order, attempt ownership, archived drafts, Undo ordering, room delivery, sequenced appends, the effect projection and its sweep, the reconnect order), run with one command against a scratch database.
- [#871 cells](../../apps/app/src/features/draft-review/.context/qa/871-cells.md): the writer types into a passage while the AI rewrites it, four cells in auto-apply and draft mode, in the browser; what is kept, what is lost to ancestor delete, and how the result names the user.
- [Model text reversal](../../apps/server/server/domains/collab/.context/qa/model-revert.md): model Undo, Redo and Revert by Yjs identity, including partial changes, destination routing, repeated text and a revert of a revert, in auto-apply and draft mode.
- [Scratch before compaction](../../apps/server/server/domains/runtime/.context/qa/scratch-compaction.md): zero to three calls, honest held results, summary, bypasses, cancellation and unchanged ownership.
- [Frontier survives compaction](frontier-survives-compaction.md): a Yjs snapshot restores after the branch store folds the journal, fails loudly on a gc-on origin, and containment refuses a re-fork; pure Yjs, one command.
- [Editor schema notices](../../apps/app/src/features/editor/.context/qa/editor-notices.md): one-line repair and fence bars, the Details popover, copy refusals and Dismiss focus.
- [Journal checkpoint coverage](checkpoint-coverage.md): durable admission, compaction, generation replacement and opaque cuts.
- [Document adoption across a reload](../../apps/app/src/features/project/.context/qa/document-adoption-reload.md): New file reloaded inside the adoption commit window, desktop and the phone's three document branches.
- [Document open: commit first](../../apps/app/src/features/project/.context/qa/document-open.md): immediate main, side, and phone placement; one content open; transfer ownership; failures, removal, fencing, passages, projection readiness, streaming, and keystrokes.
- [Draft review](../../apps/app/src/features/draft-review/.context/qa/draft-review.md): visual editor and review workflows.
- [Text-derived draft disposition](../../apps/server/server/domains/collab/.context/qa/draft-disposition.md): inverse policy, historical Apply evidence and whole-Work close, with an isolated PostgreSQL runner.
- [Catalog sidebar](catalog-sidebar.md): rename, move, delete, and loaded/fresh-profile convergence.
- [Row selection and drag](row-drag.md): multi-select, dragging rows into folders and areas, reordering on row edges and through Move…, refusal toasts, Scratch and Work Files.
- [Refused document creates](../../apps/app/src/features/project/context/.context/qa/refused-create.md): a create the server refuses settles once, keeps the document and its text in Unfiled with a mark, and files again from the row or the identity bar; network drops still retry.
- [New folder](../../apps/app/src/features/project/context/.context/qa/folder-create.md): a folder listed at once and settled in the background: offline and reload, documents and reorders put in a pending folder, a refused create with contents, deleting before it lands, rename, and two tabs.
- [Copy in the tree](../../apps/app/src/features/project/context/.context/qa/copy-browser.md): a drop across systems and Copy to… in the browser: the menu, predicted names, a refusal toast, a source with unsynced edits, a queued rename, a hidden draft at the target name, a selection another peer nested before the send and the phone, with `agent-browser`.
- [The server Copy command](../../apps/server/server/domains/context/.context/qa/copy-server.md): rich folder, hidden occupants, draft sources, fifty documents, a failure on the last child, replay, a source not yet caught up, positions, refusals, other owners and the model's copy, driven with `./mf`.
- [Desktop files dropped on a chat](../../apps/app/src/features/chat/.context/qa/chat-file-drop.md): files onto the composer and the transcript attach through the paperclip's intake; folders, a bad name, offline, the tree's own drops and the phone.
- [Dragging from places that aren't tree rows](../../apps/app/src/features/project/context/.context/qa/drag-sources.md): main's document title, path crumbs, Recent rows, mention chips (composer and transcript), selected Editor links, receipt and Work change rows and Uploads entries dragging out, always asking Move / Copy / Cancel, a draft title copying its draft, Uploads refusing drops, same-system row drags still moving at once and the phone with no drag, with `agent-browser`.
- [Dragging a text selection](../../apps/app/src/core/editor/.context/qa/selection-drag.md): pressing a highlight and dragging it at once (letters, the space between lines, a double-click then press), no-travel clicks, move, copy, Escape, a selected link, the composer copying, a 5s pause, autoscroll and cells, with a real mouse.
- [Saved file display](../../apps/app/src/features/project/.context/qa/file-display.md): a TIFF, HEIC or BMP draws from a server-made preview in the viewer, a DOCX's inline image and chat; any file the browser can't draw is a card with Download, never Retry.
- [Mention drops](mention-drop.md): selected rows copied into the composer and manuscript as `@` references that land where the caret showed (word, gap, margin, past the end, bullets, inline code, diagram, empty document), with refusals and drop-regression checks.
- [Presses](../../apps/app/src/core/editor/.context/qa/presses.md): clicks with no text under them (margin, gap, wrapped line, cell padding, below each kind of ending) put the caret where pointed and never make a paragraph.
- [Model `grep`](../../apps/server/server/domains/context/.context/qa/grep.md): regex search over a 450-document project, each output mode, scoping, refusals, staged and draft text, each case with its predicted and measured time.
- [Debugging](../debugging.md): CLI reference, logs, and model-request inspection.
- [CI quality groups](../../tools/ci/README.md): partition coverage and required-status failure propagation.
- [Staged typechecking](../../tools/ci/README.md#staged-hook-probe-recipe): index selection, dependent projects, shared configuration, cache invalidation and hook failures.

## Script-backed checks

On-demand checks can be automated scripts, with Markdown documenting setup,
assertions, evidence and cleanup. They are not part of `pnpm test:all`; keep
browser scenarios in the configured-case inventory and list standalone
workloads separately. A missing prerequisite or skipped check is not a pass.

- `pnpm smoke:app-dev-transform`: [dev startup and public routes](../../tools/dev/smoke-app-dev-transform.ts).
- [Dev route ownership](../../tools/dev/.context/qa/dev-route-ownership.md): detached-checkout names, conflict refusal and explicit takeover without disturbing sibling stacks.
- `pnpm smoke:prod-boot`: [production build, startup and public routes](../../tools/dev/smoke-app-prod-boot.ts). Both boot checks also run in CI; neither verifies authenticated writing.
- `bash tools/deploy/smoke-check.sh`: [staging health](../../tools/deploy/smoke-check.sh). Requires `STAGING_URL`; without it the script exits successfully without probing.
- `CHAT_SMOKE_TURNS=200 pnpm exec playwright test --config apps/app/e2e/playwright.chat-smoke.config.ts`: [chat virtualization](../../apps/app/e2e/chat-performance-smoke.pw.ts). Supply the owned app URL and database URL; a missing database skips the scenario. Capture the runner report and trace.
- `pnpm --filter @meridian/server exec tsx scripts/probe-link-resolution.ts`: [import link resolution and frontmatter parse timings](../../apps/server/scripts/probe-link-resolution.ts) at vault scale; pure, no database. These scale checks stay out of the correctness gate.
- [Project repository smoke](../../tools/dev/smoke-project-domain.ts) is not recommended on a shared database: it deletes a fixed project UUID before seeding. It needs run-scoped fixture ownership before becoming a safe catalog entry.

Large-chapter editing, image-in-table layout and browser first-send/concurrent
editing recovery still lack dedicated, cataloged script-backed writer checks.
The recipes below and in linked pages do not certify those workflows today.
Script automation and catalog repairs are tracked in [#726](https://github.com/haowjy/meridian-flow/issues/726).

Run on an owned worktree and database. Discover HTTPS routes with
`pnpm portless:list` and confirm they carry your worktree's prefix before any
`./mf seed` or send, then pass `MF_SERVER_URL` explicitly (recipes use `MF_APP_URL` as the browser URL). A
detached-HEAD checkout has no prefix: when another checkout holds the unprefixed
routes, `pnpm dev` still reports `started` with that checkout's URLs, and `./mf`
writes into its database ([#615](https://github.com/haowjy/meridian-flow/issues/615)).
Put a comparison base on a throwaway branch instead. Never target another
worktree's process or clear its mock queue. Stop only your stack with
`pnpm dev --stop` when finished; never `pkill` or `killall` by pattern, which
matches every worktree's stack.

Leave a shared checkout as you found it. To compare against an older revision,
extract its modules with `git show` into a scratch directory outside the
checkout, or point a scratch test config at them; never substitute files in the
checkout, even briefly. Check `git status` before reporting, and never report a
change you made as pre-existing.

Drive the browser through a named session (`agent-browser --session <name>`) and
close only that session with `agent-browser --session <name> close`. Never pass
`--all` to `close`: it closes every agent-browser session on the machine,
whatever `--session` says, including other teams' probes.

## Dev watcher: sibling installs

Checks that an install in a sibling worktree does not restart this worktree's
server. With your stack running (`pnpm dev`), note the count of
`startup.complete` lines in `logs/events/*.jsonl`. In a sibling worktree run
`pnpm install`, or just hardlink one store file:
`ln <store file under node_modules/.pnpm> ../probe-link` (the link must be on the
same filesystem as the store file, so not `/tmp` when that is tmpfs). Remove the
link afterwards. Wait 10 seconds.
Expect no new `startup.complete` and no `[nitro] Server built` in
`logs/portless.log`. Then edit a server source file: one rebuild is expected.
Without the stack running, this cannot be checked.

## Document intake

DOCX corpus conversion, numbered collisions, bootstrap, CLI and file download.

## Import

Start the owned stack with `pnpm dev`; discover HTTPS origins with
`pnpm portless:list`. The upload-first server and app switch together: do not use
the old landing UI or old plan/finish probe scripts to certify the new protocol.

For the upload-phase server slice, use an authenticated browser against the
worktree's API origin and inspect the rendered detail/open-list responses:

1. Create a selection with two small files and one declared over 50 MiB. Create
   returns uploading, a pending root identity (`created: false`), and one failed
   `too_large` file. No Context folder or document exists yet.
2. Send one numbered multipart file, with its id in `X-Import-Changed-Entries`.
   Repeat with a 200-part request (distinct numbered files under 8 MiB). All 200
   must be received, selection sizes must stay unchanged, and changed-file
   attention must count once. A header naming an absent part must return 400.
   Detail reports received/changed_after_pick; replay the part and confirm the
   receipt remains unchanged. Reload and confirm the other file is awaiting.
3. Skip the missing file with `not_found`. State becomes organizing without any
   additional browser command. Stop now cancels and removes it from the open
   list. Stop returns without waiting for storage cleanup.
4. Pick a small file, then send a 52 MiB body for its id. The response must be a
   durable failed/too_large entry, not a 413 leaving the import awaiting. Send
   Stop immediately afterwards to check keep-alive transport remains usable.
5. Race Stop against the real reveal. Stop first leaves no live rows; reveal first
   leaves the complete tree and returns 409 `import_finished` from Stop.
6. Drive Folder/Files on desktop and a 393×852 touch phone in both themes.
   Reading appears immediately. Only the pending folder root appears in the
   tree/Files listing; tapping it opens the activity card. On phone the activity
   bar must not cover the first row. On desktop the card fits the rail above its account/navigation footer; View
   projects remains clickable. Devtools is bottom-right on desktop and absent on phone.
7. Pause upload by reloading before all bytes arrive. The reloaded tab reads Upload
   paused with Continue… at once, not Uploading in another window: it holds no upload
   lock and no other tab does. Continue asks for the original folder. Repick with one
   changed file and one missing file: only awaiting files send, the changed file is
   marked, and the missing choice stays inline. Navigate to another project during
   upload: nothing shows there, and the source project's Import button still carries
   the spinner when you return. Stop in Reading,
   Uploading, Organizing, and Adding uses one confirmation and discards everything before
   reveal. Cancelling that confirmation resumes the same activity.
8. Let the real organizer finish. The whole staged tree and catalog appear together
   with Done; no imported child is visible beforehand. A lost Stop race says it
   finished before it could stop. A clean result acknowledges at once, or when
   an open popup that shows it closes; a needs-a-look result stays until its popup is opened
   and closed. The fake import API remains
   useful for isolated rendering work, but is not acceptance evidence.
9. Fail the first create transport, then return an empty open list. Retry and
   Stop must remain available with held files. Restore transport and Retry:
   the same import id succeeds. A later 4xx must not turn an earlier unanswered
   create into a refusal that closes locally.
10. Verify atomic reveal and complete documents with the notes-folder fixture under
   `apps/server/server/domains/import/__fixtures__/`, including properties and links.
11. Verify order. In one project make a Knowledge Base folder with four documents and
   reorder one of them (Move… > Change position, or a row-edge drag) so the folder is
   manual; make a second folder with the same documents and leave it alone. Import 100+
   files and a nested folder into each. In the default folder the arrivals list in name
   order (folders first, numeric-aware); in the manual folder they sit after the last
   existing row, with ranks above its largest (`select name, rank from documents where
   folder_id = … order by rank collate "C"`), and the nested folder's own children stay
   unranked. The pending root drawn while organizing is already in that slot. Then export
   the project: each folder's entries stream in tree order, depth first, and a manual
   folder's order survives. Drag a desktop file onto a row's edge and onto a folder: both
   light the whole folder, the hint says "Import into <folder>", no insertion line draws,
   and the file lands by the folder's rule, not at the edge.
12. Files that aren't documents. Import (Files…) a truncated `.docx` (its first 6 bytes
   `PK\x03\x04\x14\x00`), a real `.docx` cut to 500 bytes, 3 KB of random bytes named
   `binary.md`, `page.html`, a `.txt` of invalid UTF-8 (`\xff\xfe\xfa\xfb…`), a good `.md`,
   a good `.docx` and a Chinese `.txt`. Done says 5 need a look; each of the first five
   opens as a card with Download (never "PK" or tags as text) and its See files line reads
   "Couldn't turn this into a document. Kept as a file."; the names keep `.md`, `.txt`,
   `.html`. The good `.md`, `.docx` and Chinese `.txt` open as prose.
   Then Rename (a name without a suffix keeps it: `binary.md` → `renamed` is `renamed.md`),
   Move into a folder, Copy, Delete and Restore each kept file at the root and in a folder:
   each keeps its name and suffix and still opens as a card. With a document `binary` beside
   a kept `binary.md`, each opens its own content and a link `[x](binary.md)` binds the kept
   file, `[x](binary)` the document. Rename the open kept file, and Move it to another area: it stays in main and its card stays, also after leaving main and clicking the row, and after a reload. In a
   draft-mode chat an agent `write move` of a kept file keeps its suffix too.
13. Reconcile a re-picked folder. To stop mid-upload at a known point, wrap
   `XMLHttpRequest.prototype.send` in the page so `POST …/imports/<id>/files` fails
   after N requests, then reload. Check each case with the done card's See files list
   and the entry rows (`reason`):
   - Edit a received file and Continue with the same folder. It lists as "Edited after
     it uploaded. The imported copy is the earlier version." (the entry's
     `changed_after_upload` column), and the landed document keeps the old text:
     received bytes are never sent again.
   - Edit an awaiting file and let one Continue send it, then pause again and Continue
     with the same folder. It still lists "Changed after you picked it."
     (`reason = changed_after_pick`): the second Continue must not clear a mark that was
     true. Keep one other file awaiting (fail its request) so the import stays uploading
     between Continues, then edit the file again and Continue: it lists both sentences
     (`changed_after_pick` and `changed_after_upload`). Revert it to the uploaded bytes and
     Continue: only "Changed after you picked it." remains, because the file is not the
     one originally picked (its modified time changed). Check the rows after each step.
   - Pick a copy of the folder with later modified times and some files removed, then
     Pick again with the original after editing two files that landed from the copy. The
     copy's marks clear; only the edits list, each with the "Edited after it uploaded"
     sentence (a file that arrived from the copy and was then edited also lists "Changed
     after you picked it", because the edit destroys the proof that mark was false). Pick
     again must send the files the copy lacked.
   - `chmod 000` a received file and touch it, then Continue. Everything else still
     sends; the file keeps its reason and is not listed. Do the same to an awaiting file
     and remove another, then Retry: both skip as unreadable and the rest send.
   - Make the hash report fail once (wrap `fetch` so the first `POST …/picked` returns
     500) while a second batch is still sending. The card keeps reading Uploading until
     that batch lands, then stalls with the error and Retry; the import stays uploading
     with the last batch held back. Retry repeats the report, then sends the batch, and
     the import completes. A 400 from `picked` drops the report instead: the held batch
     sends, the import completes with no marks and Retry is never needed.
   - Click Import without them while the hash pass is still running (slow
     `Blob.prototype.arrayBuffer` for `File`s). The report's `POST …/picked` goes before
     the skip, and the edited files still list "Edited after it uploaded".
   - Make a read never settle (`arrayBuffer` returning a pending promise for one edited
     received file, or `slice(0, 1)` for an awaiting one). After 30 seconds the file counts
     as unreadable: the report goes without it, or the send skips it. The import
     completes, `navigator.locks.query()` lists no `import-upload`, and a synthetic
     `beforeunload` event is not prevented.
   - During a Continue that has received files to hash, the card reads Uploading, never
     Upload paused.
14. Two tabs. Start an upload in tab A with slow sends, then open the project in tab B:
   B's first render reads Uploading in another window, with no Continue (check with a
   MutationObserver registered at document start; the card must never read Upload paused
   first). `navigator.locks.query()` lists `import-upload:<id>` while A works. Close A:
   within one refresh (two seconds while the import is uploading) B reads Upload paused
   with Continue…. Make A's sends fail until its queue stalls: A shows Retry and releases
   the lock, and B offers Continue… rather than Uploading in another window. A background
   tab's slow timers must not change this; presence is the lock, not a heartbeat.
   Check the start of a fresh upload too, where the lock used to lapse between creating and
   the first send: put B in its own window (a background tab's timers slow to one a
   second), log `navigator.locks.query()` in B every 20 ms before A picks the folder, and
   slow A's sends. `import-upload:<id>` must show from its first appearance until A
   settles with no gap, and B must never read Upload paused for that import.
   Reload A mid-upload: A's first render reads Upload paused with Continue…, never
   Uploading in another window.

For the large gate, generate a 3,219-file/1,207-folder vault with
`pnpm --filter @meridian/server exec tsx scripts/build-import-performance-fixture.ts <output-dir>`.
Import it through the browser. Sample the import header and `/readyz` while it runs;
record selection-to-`organizing` as upload, `organizing` to every entry `prepared`
as organize, and all-prepared to `revealed_at` as reveal. Keep upload, organize,
reveal, batch count and unrelated-route p95 separate. The targets are under 60 s,
under 5 s and under 300 ms respectively.

The DB upload suite covers overlapping receipts, cumulative byte overflow,
per-user admission, expiry, tombstones, key-age fences, and binary retention.
Those checks do not replace the browser workflow on the merged app.

## Before you call it a defect

Three harness artifacts have produced false defects. Rule them out first.

- **Persistence.** Before judging whether an edit saved, wait until the
  server route's `/readyz` returns 200 and the browser's authenticated
  `/ws/yjs` WebSocket upgrades with 101 (CDP `Network.webSocket*` events).
  Read the result back with `./mf doc read <uri>` or a fresh browser profile,
  never the browser that made the edit: its IndexedDB shows the edit whether or
  not the server has it. A stack restarted after a port collision is the usual
  cause.
- **Scripted copy.** After a scripted selection (`locator.selectText()`), wait
  about 100 ms before Ctrl+C so ProseMirror's selection catches up. Otherwise
  the editor's copy handler sees an empty selection and Chromium does a native
  copy, which carries none of the app's clipboard data. Assert the holder
  document's URI before testing copy and paste between documents.
- **Offline emulation.** Attaching and then detaching a temporary CDP session
  (for example, one opened only for `Page.captureScreenshot`) flips
  `navigator.onLine` and TanStack's `onlineManager` back to true, while
  `Network.emulateNetworkConditions` on the owning session keeps the transport
  offline. The app then sends commands it should have refused, and they fail
  at the transport. During an offline window, take screenshots through the
  owning page or session (`page.screenshot()`), never a new target session.
  Log both `navigator.onLine` and `onlineManager.isOnline()` (from the loaded
  app module) right before every command, and treat transport reachability as
  a separate fact.

## Device reading memory


## Project export

1. Start an owned worktree with `pnpm dev` and discover its HTTPS routes with
   `pnpm portless:list`. Seed links across Manuscript and Knowledge Base, a
   binary image, case-only siblings, two Works with Scratch and Uploads, and a
   No Work chat with Scratch. Seed `documents.metadata.properties` directly
   as `{ "format": "yaml", "text": "..." }`.
2. Download a chapter with
   `./mf api GET /api/documents/<id>/download --output /tmp/chapter.md`.
   Check raw frontmatter, relative `.md` links, unescaped `[[text]]`, and
   escaped `[ref]` and `[^1]`. Ordinary `./mf doc read` stays escaped.
3. Preview with `./mf api GET '/api/projects/<id>/export/preview?scratch=0&uploads=0'
   --json`. Check outside-link and pending-draft counts. Download directly with
   `./mf api GET '/api/projects/<id>/export.zip?scratch=0&uploads=0' --output /tmp/project.zip`.
   Repeat with both options 1. Each GET independently reauthorizes files and
   Works; delete a disposable document or Work after preview and confirm it is
   absent from the download. No ticket, expiry or server affinity exists.
   Use `unzip -l` and extract to a temporary folder. Default exports omit Works;
   opt-in exports group by Work and No Work Scratch by lineage chat. Compare
   image SHA-256. The marker counts actual ZIP content, not the preview.
4. The scripted relative-link check is in
   `apps/server/server/domains/export/domain/project-export.test.ts`. It
   verifies default and opt-in vaults and an in-flight move. The default
   marker counts excluded Scratch/Uploads links; opt-in links resolve to
   actual entries. Open the exported project folder in a note app for visual
   review (not part of the automated check).
5. In the project title menu, choose Export project. Both switches begin off.
   A quiet preview loads beneath the switches, updates after a debounce and
   hides zero counts. Preview failures offer Retry without blocking Export.
   Export follows the native GET with the chosen options and closes the dialog.
   Browser owns progress and failures; the app never buffers a ZIP or claims
   download completion. Stop only
   this stack with `pnpm dev --stop`.
## Messages waiting for usage

[Saved messages waiting for usage](../../apps/app/src/features/chat/.context/qa/usage-waiting.md) covers durable credit blocks,
existing and New chat, reload, Settings navigation, CLI outcomes and automatic
recovery after a ledger grant.
