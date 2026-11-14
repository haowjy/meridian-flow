# tools/mf

Agent-facing dev CLI for this worktree's app API, not application runtime code.
Read [`.context/CONTEXT.md`](.context/CONTEXT.md) first.

- `./mf` drives the shared client core ([`@meridian/thread-client`](../../packages/thread-client/AGENTS.md)),
  so its debugging is faithful. `thread view` prints the view model and never words or
  decides a row. Where a feature has no shared core yet, `./mf` calls the server API and
  its claims say so. Missing data needs a server route behind the debug
  gate, not a CLI-side database query or business logic.
- No CLI retry loop: the shared transport retries only the failed thread, and
  observers wait through retryable errors until the command deadline.
- Pass a contracts JSON decoder on HTTP reads that feed a success claim; never assert an
  unknown body into success.
- Workspace imports: `@meridian/contracts` and `@meridian/thread-client`, and for `doc` the
  tree-list and document-room clients (`project-tree`, `tree-list-sync`, `agent-edit`, `markup`,
  `prosemirror-schema`): a tree change has no route, so `./mf` writes the list as the browser
  does. From
  `tools/dev`, only the Portless route contract: `portless-prefix.ts`,
  `portless-routes.ts`, `portlessCa` in `dev-readiness.ts` and `resolveCheckoutRouteUrls` in
  `dev-session-state.ts`, so `./mf` finds the stack the way `pnpm dev` registers it.
- Keep `src/core/` domain-free. Command groups can import another group's helpers, never
  `main.ts`.
- Set `process.exitCode`, never call `process.exit()`, which can truncate piped output.
