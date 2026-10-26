# Runtime probes

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

- [Rich mock provider](mock-provider.md): samples, large output, thinking, pacing, cancellation, tool scripts and startup defaults.
- [The model's move and delete](model-move-delete.md): tool rows, the turn card's lines and Undo at a free name, absorbed-folder Undo, and a stopped reply's rollback, in the browser on the mock model.
- [Atomic frozen Apply](atomic-apply.md): production API-core command, merge, rollback, lifecycle and trail probes over a scratch database.
- [Document removal records](document-removal-records.md): populated upgrade, actor readback, Trash list/read/restore, pending-Work retention, permanent purge, closure/admission races, storage release and after-commit room retirement.
- [Document existence admission](document-existence-admission.md): live frames, saves and Apply against a removal, head creation only by create or repair, with the pause controller.
- [Runtime protocols](runtime-probes.md): RP-1 through RP-20, server protocol checks driven with `./mf`; RP-17 runs `./mf` beside the browser. They don't verify the app.
- [Project chrome and shell](project-chrome-manual.md): the browser checks that replaced nine slow DOM tests in `apps/app`. Their durable halves are RP-13 and RP-14.
- [Stop and hand-back](stop-and-hand-back.md): written steps for the pure Stop rows with no unit case, each naming the DB row or browser item that pins it.
- [Failure cards](failure-cards.md): the failed reply, refused and lost Retry, failed compaction, handoff brief and live-region clearing, driven in the browser with injected faults.
- [Queue controls](queue-controls.md): QC-01 to QC-08, the queued look, the x, Cancel queue, Send now and every failure card, driven in the browser with injected faults.
- [Browser state envelopes](browser-state-envelopes.md): reload all browser-persisted surfaces and reject transplanted ownership.
- [Settled chat Markdown](chat-markdown.md): manuscript parity, list rhythm, highlighting and code copy.
- [Chat session](chat-session.md): compare a chat in the browser with `./mf thread view --json` by row identity, kind, item kinds and text, the `cN` ref steps, and SY-01 to SY-07, the live-sync recipes (join, reload, navigate, another client's message, Stop, a held write-mode switch, a network gap).
- [Chat submissions](chat-submissions.md): first-send and existing-send failure, FIFO ownership and tab takeover.
- [Composer drafts](composer-drafts.md): per-tab reload, submission hand-off and missing-reference recovery.
- [Folder mentions](folder-mentions.md): the `@` Mention row, composer and Editor folder chips, the drill-in menu a folder chip opens, and rename or delete then click.
- [Chat Files menu](chat-files.md): shared nested Scratch plus chat uploads; search, rename, move, delete, fork source and phone parity.
- [Crash and two processes](crash-and-two-process.md): P5, a server crash between a draft write's commit and its ack, then the resend; P6, two servers on one database with a tab on each, using `tools/qa/shared-db-server.ts` and `draft-readback.ts`.
- [Draft content rebase](draft-review-rebase.md): fresh client-1 seeds, the server append rebase, late typing recovery, badge convergence and inverse cutover through PostgreSQL.
- [Stable draft identity and terminal closes](draft-generations.md): draft rooms through Discard all, a fresh server instance and live restore; `4205`, `4207` and removal `4208`.
- [Lock-free drafts seam probes](drafts-lock-free-probes.md): the PostgreSQL interleavings behind lock-free drafts (Work-first order, attempt ownership, archived drafts, sampled Discard, Undo ordering, room delivery, sequenced appends, the effect projection and its sweep, the reconnect order), run with one command against a scratch database.
- [Document existence admission](document-existence-admission.md): live frames, saves and Apply against a removal, head creation only by create or repair, with the pause controller.
- [#871 cells](871-cells.md): the writer types into a passage while the AI rewrites it, four cells in auto-apply and draft mode, in the browser; what is kept, what is lost to ancestor delete, and how the result names the user.
- [Model text reversal](model-revert.md): model Undo, Redo and Revert by Yjs identity, including partial changes, destination routing, repeated text and a revert of a revert, in auto-apply and draft mode.
- [Selected keep-open reads](selected-keep-open.md): compaction uses ordinary read arguments, with ordinary observation credit and whole-only duplicate elision.
- [Scratch before compaction](scratch-compaction.md): zero to three calls, honest held results, summary, bypasses, cancellation and unchanged ownership.
- [Frontier survives compaction](frontier-survives-compaction.md): a Yjs snapshot restores after the branch store folds the journal, fails loudly on a gc-on origin, and containment refuses a re-fork; pure Yjs, one command.
- [Editor schema notices](editor-notices.md): one-line repair and fence bars, the Details popover, copy refusals and Dismiss focus.
- [Journal checkpoint coverage](checkpoint-coverage.md): durable admission, compaction, generation replacement and opaque cuts.
- [Document adoption across a reload](document-adoption-reload.md): New file reloaded inside the adoption commit window, desktop and the phone's three document branches.
- [Document open: commit first](document-open.md): immediate Editor, dock, and phone placement; one content open; transfer ownership; failures, removal, fencing, passages, projection readiness, streaming, and keystrokes.
- [Draft review](draft-review.md): visual editor and review workflows.
- [Text-derived draft disposition](draft-disposition.md): inverse policy, historical Apply evidence and whole-Work close, with an isolated PostgreSQL runner.
- [Catalog sidebar](catalog-sidebar.md): rename, move, delete, and loaded/fresh-profile convergence.
- [Row selection and drag](row-drag.md): multi-select, dragging rows into folders and areas, reordering on row edges and through Move…, refusals, Undo, Scratch and Work Files.
- [Mention drops](mention-drop.md): selected rows copied into the composer and manuscript as word-snapped `@` references, with refusals and drop-regression checks.
- [Debugging](../debugging.md): CLI reference, logs, and model-request inspection.
- [CI quality groups](../../tools/ci/README.md): partition coverage and required-status failure propagation.
- [Staged typechecking](../../tools/ci/README.md#staged-hook-probe-recipe): index selection, dependent projects, shared configuration, cache invalidation and hook failures.

## Script-backed checks

On-demand checks can be automated scripts, with Markdown documenting setup,
assertions, evidence and cleanup. They are not part of `pnpm test:all`; keep
browser scenarios in the configured-case inventory and list standalone
workloads separately. A missing prerequisite or skipped check is not a pass.

- `pnpm smoke:app-dev-transform`: [dev startup and public routes](../../tools/dev/smoke-app-dev-transform.ts).
- [Dev route ownership](dev-route-ownership.md): detached-checkout names, conflict refusal and explicit takeover without disturbing sibling stacks.
- `pnpm smoke:prod-boot`: [production build, startup and public routes](../../tools/dev/smoke-app-prod-boot.ts). Both boot checks also run in CI; neither verifies authenticated writing.
- `bash tools/deploy/smoke-check.sh`: [staging health](../../tools/deploy/smoke-check.sh). Requires `STAGING_URL`; without it the script exits successfully without probing.
- `CHAT_SMOKE_TURNS=200 pnpm exec playwright test --config apps/app/e2e/playwright.chat-smoke.config.ts`: [chat virtualization](../../apps/app/e2e/chat-performance-smoke.pw.ts). Supply the owned app URL and database URL; a missing database skips the scenario. Capture the runner report and trace.
- [Project repository smoke](../../tools/dev/smoke-project-domain.ts) is not recommended on a shared database: it deletes a fixed project UUID before seeding. It needs run-scoped fixture ownership before becoming a safe catalog entry.

Large-chapter editing, image-in-table layout and browser first-send/concurrent
editing recovery still lack dedicated, cataloged script-backed writer checks.
The recipes below and in linked pages do not certify those workflows today.
Script automation and catalog repairs are tracked in [#726](https://github.com/haowjy/meridian-flow/issues/726).

Run on an owned worktree and database. Discover HTTPS routes with
`pnpm portless:list` and confirm they carry your worktree's prefix before any
`./mf seed` or send, then pass `MF_APP_URL` and `MF_SERVER_URL` explicitly. A
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

[Writer names at intake](document-intake.md) covers prose suffixes, MIME inference,
DOCX corpus conversion, numbered collisions, bootstrap, CLI and file download.

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

[Remember a chapter’s place](reading-position.md) covers reload, shared Editor/side-panel memory, collaborative edits and explicit-target precedence.

## Messages waiting for usage

[Saved messages waiting for usage](usage-waiting.md) covers durable credit blocks,
existing and New chat, reload, Settings navigation, CLI outcomes and automatic
recovery after a ledger grant.
