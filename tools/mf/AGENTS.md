# tools/mf — Agent Rules

Agent-facing dev CLI for this worktree's app API, not application runtime code.
Read [`.context/CONTEXT.md`](.context/CONTEXT.md) first.

- **`./mf` wraps the API; it never reimplements it.** Missing data needs a server
  route behind the debug gate, not a CLI-side database query or business logic.
- **Imports:** only `@meridian/contracts` and `@meridian/thread-client` from
  workspace packages. From `tools/dev`, only the Portless route contract:
  `portless-prefix.ts`, `portless-routes.ts` and `portlessCa` in
  `dev-readiness.ts`, so `./mf` finds the stack the way `pnpm dev` registers it.
  Never import `apps/`.
- Declare runtime and development dependencies in this package's `package.json`.
- Keep `src/core/` domain-free. Command groups can import another group's
  helpers, never `main.ts`.
- Preserve the output and exit-code contracts. Set `process.exitCode`, never
  call `process.exit()`, which can truncate piped output.
