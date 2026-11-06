# tools/mf — Agent Rules

Agent-facing dev CLI for this worktree's app API, not application runtime code.
Read [`.context/CONTEXT.md`](.context/CONTEXT.md) first.

- **`./mf` drives the shared client core** (`@meridian/thread-client`), so its debugging
  is faithful: never reimplement that logic here, and `thread view` prints the view model
  and never words or decides a row. Where a feature has no shared core yet, `./mf` calls
  the server API and its claims say so. Missing data needs a server route behind the debug
  gate, not a CLI-side database query or business logic.
- **Do not add a CLI retry loop.** The shared transport retries only the failed thread, and
  observers wait through retryable errors until the command deadline.
- **Success claims require validated evidence.** Pass a contracts JSON decoder on HTTP reads
  that feed a claim; never assert an unknown body into success.
- **Imports:** only `@meridian/contracts` and `@meridian/thread-client` from workspace
  packages. From `tools/dev`, only the Portless route contract: `portless-prefix.ts`,
  `portless-routes.ts`, `portlessCa` in `dev-readiness.ts` and `resolveCheckoutRouteUrls` in
  `dev-session-state.ts`, so `./mf` finds the stack the way `pnpm dev` registers it. Never
  import `apps/`.
- Keep `src/core/` domain-free. Command groups can import another group's helpers, never
  `main.ts`.
- Set `process.exitCode`, never call `process.exit()`, which can truncate piped output.
