# Runtime probes

Use these recipes to check the running product, in addition to `pnpm check`.
Keep evidence in the active work directory, not in this repository. Record the
commit, date, stack/provider, outcome, and evidence path after each run. A recipe
is not a claim that it passed on the current commit.

- [Runtime protocols](runtime-probes.md): RP-1 through RP-11, driven with `./mf`.
- [Draft review](draft-review.md): visual editor and review workflows.
- [Debugging](../debugging.md): CLI reference, logs, and model-request inspection.

Run on an owned worktree and database. Discover HTTPS routes with
`pnpm portless:list`; never target another worktree's process or clear its mock
queue. Stop only your stack with `pnpm dev --stop` when finished.

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
