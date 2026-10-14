# Runtime probes

Use these recipes to check the running product, in addition to `pnpm check`.
Run each one in a real browser (`agent-browser`) and judge it by what the screen
shows, with the durable transcript as truth. `./mf` only sets up state (Works,
threads, documents, mock-model scripts) and reads durable state; its output is
never evidence that the app works. Write new recipes as browser steps.
Keep evidence in the active work directory, not in this repository. Record the
commit, date, stack/provider, outcome, and evidence path after each run. A recipe
is not a claim that it passed on the current commit.

- [Runtime protocols](runtime-probes.md): RP-1 through RP-12, server protocol checks driven with `./mf`. They don't verify the app.
- [Browser state envelopes](browser-state-envelopes.md): reload all browser-persisted surfaces and reject transplanted ownership.
- [Chat submissions](chat-submissions.md): first-send and existing-send failure, FIFO ownership and tab takeover.
- [Composer drafts](composer-drafts.md): per-tab reload, submission hand-off and missing-reference recovery.
- [Journal checkpoint coverage](checkpoint-coverage.md): durable admission, compaction, generation replacement and opaque cuts.
- [Draft review](draft-review.md): visual editor and review workflows.
- [Catalog sidebar](catalog-sidebar.md): rename, move, delete, and loaded/fresh-profile convergence.
- [Debugging](../debugging.md): CLI reference, logs, and model-request inspection.
- [CI quality groups](../../tools/ci/README.md): partition coverage and required-status failure propagation.

## Script-backed checks

On-demand checks can be automated scripts, with Markdown documenting setup,
assertions, evidence and cleanup. They are not part of `pnpm test:all`; keep
browser scenarios in the configured-case inventory and list standalone
workloads separately. A missing prerequisite or skipped check is not a pass.

- `pnpm smoke:app-dev-transform`: [dev startup and public routes](../../tools/dev/smoke-app-dev-transform.ts).
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
`pnpm portless:list`; never target another worktree's process or clear its mock
queue. Stop only your stack with `pnpm dev --stop` when finished.

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

Protects #817. With your stack running (`pnpm dev`), note the count of
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
   Detail reports received/changed_after_pick; replay the part and confirm the
   receipt remains unchanged. Reload and confirm the other file is awaiting.
3. Skip the missing file with `not_found`. State becomes organizing without any
   additional browser command. Stop now cancels and removes it from the open
   list. Stop returns without waiting for storage cleanup.
4. Pick a small file, then send a 52 MiB body for its id. The response must be a
   durable failed/too_large entry, not a 413 leaving the import awaiting. Send
   Stop immediately afterwards to check keep-alive transport remains usable.
5. Seed `revealed_at` on an organizing import in the owned database (D2 later
   performs that transition). Browser Stop must return 409 `import_finished`;
   detail must remain organizing with no acknowledgement.
6. Drive Folder/Files on desktop and a 393×852 touch phone in both themes.
   Reading appears immediately. Only the pending folder root appears in the
   tree/Files listing; tapping it opens the activity card. On phone the activity
   bar must not cover the first row. On desktop the card fits the rail and does
   not collide with the development tools button.
7. Pause upload by reloading before all bytes arrive. After 60 seconds Continue
   asks for the original folder. Repick with one changed file and one missing
   file: only awaiting files send, the changed file is marked, and the missing
   choice stays inline. Navigate to another project during upload and confirm
   activity continues with the source project title. Stop in Reading, Uploading,
   Organizing, and Adding uses one confirmation and discards everything before
   reveal. Cancelling that confirmation resumes the same activity.
8. Until the organize lane is available, exercise Waiting, ready counts, Adding,
   Didn't finish (Try again and Stop), and Done through the app's fake import API.
   Keep Adding through the revealed-but-unpublished interval. A lost Stop race
   says it finished before it could stop and waits for finished. Record fake
   evidence separately from real-server evidence. Clean Done acknowledges only
   after six visible seconds; needs-a-look results stay until dismissed.
9. Once organize is available, verify atomic reveal and complete documents with
   the notes-folder fixture under
   `apps/server/server/domains/import/__fixtures__/`, including properties and links.

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

[Remember a chapter’s place](reading-position.md) covers reload, shared Editor/side-panel memory, collaborative edits and explicit-target precedence.

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

[Saved messages waiting for usage](usage-waiting.md) covers durable credit blocks,
existing and New chat, reload, Settings navigation, CLI outcomes and automatic
recovery after a ledger grant.
