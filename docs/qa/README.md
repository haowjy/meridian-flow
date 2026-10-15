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

- [Runtime protocols](runtime-probes.md): RP-1 through RP-14, server protocol checks driven with `./mf`. They don't verify the app.
- [Project chrome and shell](project-chrome-manual.md): the browser checks that replaced nine slow DOM tests in `apps/app`. Their durable halves are RP-13 and RP-14.
- [Stop and hand-back](stop-and-hand-back.md): written steps for the pure Stop rows with no unit case, each naming the DB row or browser item that pins it.
- [Browser state envelopes](browser-state-envelopes.md): reload all browser-persisted surfaces and reject transplanted ownership.
- [Chat session](chat-session.md): compare a chat in the browser with `./mf thread view --json` by row identity, kind, item kinds and text.
- [Chat submissions](chat-submissions.md): first-send and existing-send failure, FIFO ownership and tab takeover.
- [Composer drafts](composer-drafts.md): per-tab reload, submission hand-off and missing-reference recovery.
- [Chat uploads menu](chat-uploads-menu.md): the top-bar list of a chat's files: add, open, delete, fork source and dock restore.
- [Journal checkpoint coverage](checkpoint-coverage.md): durable admission, compaction, generation replacement and opaque cuts.
- [Document adoption across a reload](document-adoption-reload.md): New file reloaded inside the adoption commit window, desktop and the phone's three document branches.
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
