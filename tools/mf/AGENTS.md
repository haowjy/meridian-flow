# tools/mf — Agent Rules

Agent-facing dev CLI for this worktree's app API, not application runtime code.
Read [`.context/CONTEXT.md`](.context/CONTEXT.md) first.

- **`./mf` debugs; it does not verify the browser.** Verification is a prober's
  browser run. `./mf` shares code with the app so its debugging is faithful: it drives the
  shared client core (`@meridian/thread-client`: socket, turn reducer, transcript
  view model), so never reimplement that logic here; `thread view` prints the
  view model and never words or decides a row itself. Where a feature has no shared core yet, `./mf`
  calls the server API and its claims say so. Missing data needs a server route
  behind the debug gate, not a CLI-side database query or business logic.
- **Share a rule's inputs and recovery, not only its reducer.** `send` and `tail --until-idle`
  follow through the app's `ThreadSync`, so the rules that need a read to finish (a divider waiting for
  its anchor turn, a waiting writer message the transcript lacks) are the sync's. Never build
  another reducer or turn store here. Biome restricts reducer/store module imports and
  re-exports in the two hosts, including relative source paths. This guards the import boundary,
  not independently written reduction logic.
- **Replay failures are not connection failures.** The shared socket transport correlates
  requests, retries only the failed thread, and keeps healthy subscriptions live. Both the sync
  observer and journal subscription wait through retryable errors and replay deadlines until
  the command deadline; a refusal ends the command. Do not add a CLI retry loop. A diagnostic
  failure after a proving read preserves that result and marks observation incomplete.
- **Success claims require validated evidence.** Every domain-success claim printed by
  `./mf` comes from a contracts-validated response (or the shared client's validated
  protocol evidence). Pass a contracts JSON decoder on HTTP reads that feed a claim; never assert an
  unknown body into success. Identity/reference projections validate only their declared
  inputs and cannot authorize writes. Diagnostic-only `project list`, `log` and
  `thread context` retain casts; generic `api` prints raw server data and its exit 0
  means HTTP 2xx only, not domain success.
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
