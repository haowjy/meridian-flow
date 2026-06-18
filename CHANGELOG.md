# Changelog

## Dev portless app stability (2026-06-17, branch h/v3)

- Fixed app dev websocket proxy startup when `MERIDIAN_API_ORIGIN` is present
  but blank in `.env`; the app now falls back to the portless server origin
  instead of crashing Vite on `/api/threads/ws`.

## TipTap v3 editor upgrade (2026-06-17, branch h/tiptap-v3-upgrade)

- Upgraded the shared TipTap editor stack to v3, including the collaboration
  extension rename to CollaborationCaret and the StarterKit undoRedo option.
- Kept the custom Meridian schema as the editor/server contract: removed the
  standalone Mathematics extension because v3 adds blockMath/inlineMath nodes
  that are not in the shared markdown-safe schema.

## Server architecture alignment (2026-06-17, branch h/v3)

- Ported Voluma-hardened server observability foundations: interrupt HTTP error handler registration, process-scoped deferred EventSink, request observability, safe-event redaction, and local stdout + optional JSONL event output.
- Split production server assembly so `app.ts` binds process resources while `compose.ts` owns adapter-port construction and runtime service wiring.

## Local Supabase removed + migration squash (2026-06-16, branch h/v3)
- Local Supabase CLI and `supabase/` directory removed. Dev Postgres is now a
  plain `postgres:16` Docker container (`pnpm dev:infra`, compose project
  `meridian-dev`, host port `54422`). No `supabase:*` npm scripts remain.
- All 13 migrations `0001`–`0013` collapsed into ONE baseline
  `0000_careless_rockslide.sql`. No migration references `auth.users`.
  `pnpm db:generate` works again (snapshot debt resolved).

## Fixes (2026-06-16, branch h/v3)

- "New chat" works from the default composer again. The client-only `general`
  default agent slug is no longer sent on thread create (it has no server agent),
  so the request no longer 400s with `Agent not found: general`.

## WorkOS auth (2026-06-16, branch h/v3)

- Authentication is now WorkOS AuthKit, not Supabase GoTrue/JWKS. Sessions are a
  sealed `wos-session` cookie; the API server and collab WebSocket authenticate
  from that cookie. No bearer JWT, no JWKS.
- Identity is app-owned: a `public.users` row keyed by the WorkOS user id,
  provisioned on first sign-in. The Supabase-managed `auth.users` table and its
  foreign keys are gone (squashed into single baseline).
- Dev sign-in is a real WorkOS password auth (`/api/auth/dev-login`), gated to
  non-production with dev creds present (`WORKOS_DEV_AUTOLOGIN=1`). `pnpm
  bootstrap` applies schema only (no user/project seed); identity provisioned on
  first sign-in, personal project auto-created on first login.
- `@supabase/supabase-js` is removed from both apps.
- `pnpm dev` now defaults to `--tailscale` sharing; opt out with
  `pnpm dev --no-tailscale` (or `pnpm dev:local`).

## Onboarding wizard removed (2026-06-16, branch h/v3)

- Onboarding wizard (`/onboarding` route + domain + `user_preferences.onboarding_state` column) deleted and replaced with voluma-style auto-creation: on first authenticated request `provisionAuthenticatedUser` → `ensureDefaultBootstrap` provisions the personal project, guard-railed by a cheap existence check. `GET /api/projects/home` resolves the landing project; `/` redirects to `/projects/$id/agent`. `/home` now renders the HomeView composer for creating additional projects.
- `user_preferences.onboarding_state` column dropped.
- Existing changelog claim "project created via onboarding" corrected to "personal project auto-created on first login".

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
