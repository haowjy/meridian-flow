# Changelog

## context-URI + model-gateway cleanse (2026-06-16, branch h/v3)

- Context addressing unified behind one port and one scheme vocabulary.
  `manuscript://` is the book and the bare-path default; `kb://` / `user://`
  durable; `work://<id>/…` and `uploads://<id>/…` work-scoped. `fs1://` and
  `work://.results` are gone.
- Threads address multiple Works (M:N `thread_works`); `threads.workId` dropped.
  Work-scoped browse requires membership.
- Move/delete are content-safe: a concurrent edit landing during a move/delete
  is rejected (revision CAS) instead of silently clobbering content.
- One model registry (config + pinned pricing). OpenRouter works again; cost
  comes from the provider when it reports one. The flat token-rate table is gone.
- Cancel is billing-correct: cancelling or disconnecting mid-turn drains partial
  usage and bills it once; a failed turn ends as an error instead of hanging on
  "streaming".
- Dev login no longer breaks when tests run: DB-backed tests use an isolated
  fixture identity, run only under `RUN_DB_TESTS` against a throwaway database,
  and can no longer truncate the dev database.

## v3 full-stack rebuild (2026-06-14, branch h/v3)

Ground-up TypeScript rebuild replacing the prior Go backend. Single squashed
commit (`de6269a0`) contains the full v3 codebase.

See `AGENTS.md` for architecture overview and `DEVELOPMENT.md` for setup.
