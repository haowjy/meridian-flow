# tools/mf — Agent Rules

Agent-facing dev CLI for this worktree's app API, not application runtime code.
Read [`.context/CONTEXT.md`](.context/CONTEXT.md) first.

- **`./mf` is evidence about the browser only for code both run.** It drives the
  shared client core (`@meridian/thread-client`: socket, turn reducer, transcript
  view model), so never reimplement that logic here; `thread view` prints the
  view model and never words or decides a row itself. Where a feature has no shared core yet, `./mf`
  calls the server API and its claims say so. Missing data needs a server route
  behind the debug gate, not a CLI-side database query or business logic.
- **Share a rule's inputs and recovery, not only its reducer.** When a shared
  rule needs a snapshot to finish (a divider waiting for its anchor turn), use
  the package's waiting list and recover as the app does. A CLI-only fallback,
  or none, diverges from the browser without failing any check.
- **Imports:** only `@meridian/contracts` and `@meridian/thread-client` from
  workspace packages. From `tools/dev`, only the Portless route contract:
  `portless-prefix.ts`, `portless-routes.ts`, `portlessCa` in
  `dev-readiness.ts` and `resolveCheckoutRouteUrls` in `dev-session-state.ts`, so
  `./mf` finds the stack the way `pnpm dev` registers it and discovers an active
  session's identity the way `pnpm dev` does. Import nothing else from there.
  Never import `apps/`.
- Declare runtime and development dependencies in this package's `package.json`.
- Keep `src/core/` domain-free. Command groups can import another group's
  helpers, never `main.ts`.
- Preserve the output and exit-code contracts. Set `process.exitCode`, never
  call `process.exit()`, which can truncate piped output.
