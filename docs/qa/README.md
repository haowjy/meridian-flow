# Runtime probes

Use these recipes to check the running product, in addition to `pnpm check`.
Keep evidence in the active work directory, not in this repository. Record the
commit, date, stack/provider, outcome, and evidence path after each run. A recipe
is not a claim that it passed on the current commit.

- [Runtime protocols](runtime-probes.md): RP-1 through RP-12, driven with `./mf`.
- [Browser state envelopes](browser-state-envelopes.md): reload all browser-persisted surfaces and reject transplanted ownership.
- [Chat submissions](chat-submissions.md): first-send and existing-send failure, FIFO ownership and tab takeover.
- [Composer drafts](composer-drafts.md): per-tab reload, submission hand-off and missing-reference recovery.
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
- `pnpm probe:db apps/server/scripts/probe-import-performance.ts --out <file.ndjson> [--notes 2000]`: [import plan, bulk tree creation and landing timings](../../apps/server/scripts/probe-import-performance.ts) on a generated vault and an owned database.
- `pnpm --filter @meridian/server exec tsx scripts/probe-link-resolution.ts`: [import link resolution and frontmatter parse timings](../../apps/server/scripts/probe-link-resolution.ts) at vault scale; pure, no database. These scale checks stay out of the correctness gate.
- [Project repository smoke](../../tools/dev/smoke-project-domain.ts) is not recommended on a shared database: it deletes a fixed project UUID before seeding. It needs run-scoped fixture ownership before becoming a safe catalog entry.

Large-chapter editing, image-in-table layout and browser first-send/concurrent
editing recovery still lack dedicated, cataloged script-backed writer checks.
The recipes below and in linked pages do not certify those workflows today.
Script automation and catalog repairs are tracked in [#726](https://github.com/haowjy/meridian-flow/issues/726).

Run on an owned worktree and database. Discover HTTPS routes with
`pnpm portless:list`; never target another worktree's process or clear its mock
queue. Stop only your stack with `pnpm dev --stop` when finished.

## Document intake

[Writer names at intake](document-intake.md) covers prose suffixes, MIME inference,
DOCX corpus conversion, numbered collisions, bootstrap, CLI and file download.

## Import

Run on an owned worktree and database; use `pnpm dev:local` if the app's fixed
port is taken. Copy `apps/server/server/domains/import/__fixtures__/notes-folder`
somewhere outside the repository, then:

1. Log in at `/api/auth/dev-login`, open a project's Editor, expand Knowledge
   Base and hover its header. The Import… icon opens a menu with Folder… and
   Files….
2. Choose Folder… and give the real hidden input the copy:
   `agent-browser upload '[data-import-input="folder"]' <copy>`. The import
   starts with no dialog and the folder appears in the tree, muted until its
   files land, with the area and the new folder expanded.
3. A clean finish leaves no report, status row or badge. Open
   `Chapters/Chapter 1 - The Gate`: Properties sits under the path bar, aligned
   with the prose, with list values as chips.
4. Repeat with Files… and with a drop onto a folder row (highlighted "Import
   here"). Pick an empty folder: a dialog says there is nothing to import.
5. To see a failed file, make a send fail (block the import's file requests in
   the browser's network tools). The file's row shows the warning and its
   document shows the notice with Retry.

## Before you call it a defect

Two harness races have produced false defects. Rule them out first.

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
