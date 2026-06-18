# Changelog

## [Unreleased]

- Docs (app comments): retarget stale Warm Paper file-header comments in
  `globals.css` and `desktop-layout.ts` to Ink & Jade / Quiet Pro wording.

- Docs (Ink & Jade knowledge capture): updated DESIGN.md, design-tokens/app/root
  `.context`, and app AGENTS.md after the ink-jade-skin merge — Quiet Pro surfaces,
  ThreadCachePort decoupling, settings overlay, and unified authenticated providers.

- Frontend cleanup: dropped the placeholder Import workspace screen — removed
  `?screen=import` from nav (`SCREENS`), desktop `ImportPaneController`, phone
  import pane, `CorpusImportPanel`, and the unused corpus-upload client API.
  Server import endpoints stay for a future entry point.

- Docs (DB knowledge layer): promoted the DB schema map from the docs-repo work
  dir into the qi-layer as a durable, regenerate-on-demand artifact —
  `packages/database/.context/schema-map.md` (orientation text) +
  `schema-map/index.html` (interactive ER view). Converted all source links to
  paths relative to the `.context/` home, added staleness metadata (map
  regenerated 2026-06-18 vs. DB layer last changed 2026-06-16 `d864bab9`, derived
  from `git log -1 -- packages/database/src`), and wired both into
  `.context/CONTEXT.md` with the regenerate-on-demand convention.

- Test hardening (`tools/dev/dev-db.test.ts`): the `describe.skipIf(!DATABASE_URL)`
  integration block parsed `new URL(adminUrl)` at collection time, so a missing
  `DATABASE_URL` crashed the whole suite (`TypeError: Invalid URL`) instead of
  skipping. Build the throwaway URL lazily inside the test so the skip is actually
  protective.
- Docs (DB knowledge layer): added `packages/database/.context/CONTEXT.md`
  (qi-layer expected it; only `AGENTS.md` + `README.md` existed). Records the
  timestamp `mode` policy (default `Date` via `_shared.ts`; only `mode:"string"`
  exceptions are `users.{created_at,updated_at}` and `thread_works.created_at`),
  the "never bind a JS `Date` into a raw `sql` fragment" invariant with the
  canonical typed-comparator and `::timestamptz` round-trip patterns, the
  migration workflow, and a pointer to the `apps/server` transaction model.
- Docs (DB knowledge layer): corrected stale wording — `packages/database/AGENTS.md`
  said migrations were "squashed to single baseline" but the journal now has a
  baseline plus additive migrations (`0000_careless_rockslide` + `0001_tidy_siren`);
  and `domains/billing/.context/CONTEXT.md` pointed at a `lib/` shared module for
  the transaction helper whose real path is
  `apps/server/server/shared/drizzle-transaction.ts`.
- Frontend cleanup (R1, step 2): relocated `rename()` out of the thread store.
  Thread rename was a pure query-cache mutation with no store state living on
  `ThreadStoreActions`. Moved it to a `useRenameThread` hook beside
  `useProjectThreads` (`client/query/useRenameThread.ts`); `ChatThreadHeader`'s
  inline rename uses the hook. Dropped `rename` from the store action surface,
  the `selectThreadActions` selector, the `ThreadStoreActions` type, and the
  controller-test action mock. No behavior change.
- Frontend cleanup (R1, step 1): decoupled the thread store from React Query.
  Introduced a thin `ThreadCachePort` (`client/stores/thread-store/thread-cache.ts`)
  with `upsertThread` / `patchThread` / `invalidateThread`, backed by the existing
  `project-thread-cache` helpers. `createThreadStore` now takes a `threadCache`
  port instead of a raw `QueryClient`, so the store no longer mutates the query
  cache directly — the dual ownership behind the recurring `useThreadStore`/
  `QueryClient` fragility. The terminal-turn `queueMicrotask` invalidation moved
  into the port (render-safe deferral, documented there). No behavior change.
- Frontend cleanup (F6): minor settings/composer tidies. `SettingsDialog` now
  drives both the desktop rail and both presentations' section bodies from a
  single `SECTION_CONTENT` map keyed by `SETTINGS_SECTIONS` (killed the
  duplicated `profile|preferences|usage` triplets). Removed the never-set
  `dividerBefore` field from `PhoneSettings`. Removed the no-op attach paperclip
  from `Composer` (it was a visual placeholder with no upload wired) and updated
  its now-stale doc comments. Added a comment at `_authenticated.tsx`'s
  `<Outlet key={pathname}>` explaining the intentional per-route remount.
- Frontend cleanup (F5): removed the double viewport lock on `/billing`.
  `_authenticated.tsx` already owns the `app-frame` (`h-svh`/`overflow-hidden`)
  and the Outlet wrapper, so `BillingPage` re-locking with its own inner
  `app-frame` nested two `h-svh overflow-hidden` shells. The page now renders as
  a single `app-scroll` region (matching `HomeView`/`HomeScreen`), one scroll
  owner inside the layout-provided frame.
- Frontend cleanup (F4): unified the duplicated credit-balance UI behind a new
  `CreditBalanceCard` (`features/billing/`) with `compact`|`full` variants. The
  settings Usage section composes the `compact` box and `/billing` composes the
  `full` hero card with the usage bar; both share the one `useBillingBalance()`
  query + `creditsFromMillicredits` formatter instead of re-deriving the balance
  markup in two places. No visual change.
- Frontend cleanup (F3): collapsed the ~120-LOC near-duplicate between
  `LeftSidebar` (desktop rail) and `NavigationDrawer` (phone Sheet) into a shared
  `WorkspaceNavBody` + `ScreenNavItem` in `features/project/shell/`. Both
  sidebars are now chrome-only wrappers (collapse control / Sheet + wordmark);
  the body owns the screen nav, Chats controls, thread list, and account row. A
  `presentation` prop carries the desktop↔phone touch/spacing differences, and
  "close the drawer on select" stays a wrapper concern via wrapped callbacks —
  mirroring the SettingsDialog/PhoneSettings split. Behavior unchanged.
- Design tokens (S7): the jade gradient/shadow lifts in `ink-jade.css` now derive
  from the existing OKLCH tokens — `--background-image-gradient-mark`/`-avatar`
  reference `var(--color-mark-from|-to)` / `var(--color-avatar-from|-to)`, and
  `--shadow-button`/`-mark` use `color-mix(in oklab, var(--color-mark-from) …%,
  transparent)` instead of re-encoding jade as raw hex/rgba. Jade is defined once
  (the OKLCH ladder). Verified the tokens still compile under Tailwind v4 with all
  `var()` references emitted. (`--color-cream*` left as-is.)
- Dev tooling (S7): `assertDevInfraReady` (`tools/dev/lib/dev-infra.ts`) now
  throws a typed `DevInfraNotReadyError` instead of calling `process.exit`,
  matching the throw-style of every `dev-db.ts` function and keeping the
  "reusable by CI/bootstrap" claim honest. The `dev-tmux.ts` entry point's
  existing `main().catch` prints the message and exits.
- Server hardening (S4): the observability error serializer
  (`unknownToEventPayload`) now copies Postgres driver diagnostics
  (`code`, `severity`, `detail`, `hint`, `constraint`, `column`, `table`, and a
  truncated `query`) under a `postgres` key when the error is postgres-js-shaped,
  so a driver/binding failure no longer surfaces as an opaque "Failed query".
  Defensive — reads fields by name and never throws.
- Server hardening (S6): made `@meridian/contracts/protocol` the canonical
  billing wire types — the credit-ledger domain port now aliases
  `CreditTransactionSummary`/`CreditBalanceBreakdown` to `BillingTransaction`/
  `BillingBalanceResponse` instead of re-declaring field-for-field duplicates, so
  the domain return shape and the HTTP response can't silently drift. Also fixed
  the stale checkout fallback URL (`/settings/billing` → `/billing`) in
  `billing-route.ts` and aligned its test.
- Server hardening (S3): collapsed the 5-way nested ternary that chose the
  credit-lot `onConflictDoNothing` target/where (with the insert boilerplate
  repeated per arm) into one `resolveLotConflictGuard(src, input)` dispatcher and
  a single insert site. Same conflict targets/predicates, no behavior change.
- Server hardening (S5): replaced the residual raw
  ``sql`${stripeSubscriptionId} <> ${id}``` comparators in the Drizzle
  subscription store with the typed `ne(...)` operator, so the store uses one
  canonical comparator style (matching the `gt`/`lt`/`lte`/`eq` Date fix).
- Server hardening (S1): wrapped the Drizzle subscription `upsert` (probe →
  newer-sibling guard → cancel-superseded UPDATE → insert/update) in
  `runInDrizzleTransaction`, matching `credit-ledger.grant`. A crash mid-flow can
  no longer leave a user's prior subscriptions cancelled with no replacement row;
  the multi-statement upsert now commits atomically. No behavior change on the
  happy path; billing route tests still pass.
- Server hardening (S2): lifted the subscription monotonic-replacement rule into
  one pure domain module (`billing/domain/subscription-policy.ts`:
  `isMonotonicReplacement` + `classifyActiveSibling` + `ACTIVE_SUBSCRIPTION_STATUSES`),
  killing two of the three drifting copies. The drizzle store keeps only its thin
  SQL projection (`monotonicUpdateWhere`) and the in-memory store now calls the
  shared predicates instead of re-implementing the loop — so a divergent (and
  previously Date-unsafe) SQL path can't re-enter through an adapter. No behavior
  change; billing route + in-memory ledger tests still pass.
- Frontend cleanup (F2): removed the throwaway `/proto/palette` explorer — its
  route (`routes/proto.palette.tsx`), its `features/proto/palette/**` feature
  (~736 LOC), and the proto-index link card. The chosen palette already lives
  in `packages/design-tokens/src/ink-jade.css`, so the live-override explorer is
  disposable. Route tree regenerated via the tanstackStart generator. The other
  `/proto/*` experiments (persistent-surfaces, spike-layout) are untouched.
- Frontend cleanup (F1): deleted the dead `AppShell` desktop-shell island
  (`components/app/AppShell.tsx`, `AppSidebar.tsx`, `ProjectListSection.tsx`,
  `ProjectRow.tsx`, `SidebarUndoPill.tsx`), its sole consumer the shadcn
  `components/ui/sidebar.tsx` primitive, and the now-orphaned
  `hooks/use-mobile.ts` (`useIsMobile`, used only by `ui/sidebar`). ~1,172 LOC,
  zero behavior change — the live desktop shell is `features/project/shell/`
  and the live viewport hook is `use-phone-shell`.
- Fix authenticated tailnet cold loads/reloads: SSR API seeding now uses the
  same-origin app `/api` proxy for `.ts.net` app hosts instead of falling back to
  the bare local server origin, which made browser-authenticated reloads render
  TanStack's `Request failed: 503` error page while client-side `/api` calls
  succeeded.
- Fix billing checkout 500 (`POST /api/billing/checkout-sessions`): the Drizzle
  subscription upsert compared `currentPeriodStart` via raw ``sql`… > ${date}```
  fragments, which bind the JS `Date` straight to postgres-js and throw
  `TypeError [ERR_INVALID_ARG_TYPE]` (the server logger surfaced it only as an
  opaque "Failed query"). Switched those comparisons to Drizzle's typed
  `gt`/`lt`/`lte`/`eq` operators so the timestamp column encodes the `Date` to an
  ISO string. Pre-existing bug, newly reachable now that `/billing` exposes
  Checkout. (`apps/server` subscription-store.)
- Settings overlay + unified provider tree (voluma-derived): collapsed
  `_authenticated.tsx` to ONE unconditional provider tree (AppQuery → project →
  thread → transport → copilot) for every authenticated route, deleting the
  pathname-based `usesWorkspaceProviders` light branch. That branch dropped
  `ThreadStoreProvider` on light↔workspace navigations (e.g. billing → project),
  throwing `useThreadStore must be used within ThreadStoreProvider`; the single
  tree makes that crash structurally impossible. Settings is now a URL-driven
  overlay (`?settings=<section>`, layout-owned `validateSearch`) with Profile /
  Preferences / Usage sections — the stub `SettingsDialog`/`PhoneSettings` are
  now real, the account menu + ⌘, open it, and the Usage section shows the
  credit balance with a link to purchase. Billing purchase moved from
  `/settings/billing` to a standalone `/billing` route (links + checkout return
  URLs updated). Removed the redundant sidebar credit-balance badge (deleted
  `CreditBalanceBadge`) — the balance now lives in the Usage section.
- Dev infra preflight: `pnpm dev` now fails fast when `DATABASE_URL` is unset or
  the dev Postgres is unreachable, instead of booting the app servers (whose DB
  connections are lazy) and only surfacing the failure as a runtime `HTTPError`
  on the first DB-touching request. Restores the database-readiness gate that
  was dropped when `dev-tmux.ts` was forked from voluma, reusing the existing
  `formatPgError` hints (`pnpm dev:infra` / credentials / `pnpm bootstrap`). Adds
  a read-only `pingDatabaseForUrl` probe and a shared `assertDevInfraReady`
  (in `tools/dev/lib/dev-infra.ts`) so the same gate can back CI/bootstrap. The
  check is read-only — it never starts the container or creates databases.

## Ink & Jade re-skin (2026-06-17, branch h/ink-jade-skin)

- Grounds + chrome (Quiet Pro): replaced the cream "Warm Manuscript" surface
  ladder with the cooler, low-chroma warm-grey "Quiet Pro" ladder (hue ~100,
  chroma ≤0.005) so nothing reads as parchment. Bright surfaces (cards, message
  bubbles, composer/search fields via `surface-warm`) now lift ABOVE the canvas
  while the rails/dock recede below it, divided by hairline borders — flush, not
  floating (dropped the rounded rail corners + rail shadows).
- Cinnabar pulled back to a scarce seal: routine selection is now neutral — the
  active sidebar row uses a warm-grey fill + a jade "you are here" marker (not a
  cinnabar tint/stripe) and the "Pinned" header is muted. Cinnabar is reserved
  for the brand mark, the pin/favorite star, and destructive deletions only;
  red was reading as "error". (Supersedes the earlier cinnabar-on-active-row.)
- Texture: added a barely-there fixed paper-grain overlay (`paper-grain` utility
  on `<body>`, ~0.02 opacity, pointer-events none) for the rice-paper tooth; the
  manuscript editor is raised above it so long-form prose stays pristine.
- Login: rebuilt the placeholder page as a branded split — a deep-ink hero with
  the glowing needle, Cormorant wordmark, italic tagline, faint jade ink-wash,
  and a corner cinnabar seal, beside a paper card with a jade primary call to
  action. Drives the existing flows only (WorkOS hosted sign-in and dev login);
  no new auth plumbing.
- Brand mark: replaced the off-brand gradient hexagon with the compass needle
  (cinnabar north / jade south, token-driven fills) and added an SVG favicon
  using the seal-square needle housing.
- Chrome accents: the active sidebar row now carries the cinnabar seal (faint
  cinnabar tint, cinnabar text, and a short rounded cinnabar marker instead of a
  full side-stripe), and the thread pin/favorite star plus its "Pinned" header
  read cinnabar. The composer send button picks up jade automatically from the
  primary token.
- Typography: load Cormorant Garamond (display), Noto Serif (prose), and Inter
  (UI chrome) via Google Fonts in both app and www roots; added a `--font-prose`
  token and repointed `--font-heading`/`--font-sans`. Applied the prose serif and
  a calm ~68ch measure with generous leading to the manuscript editor and the
  conversation/markdown surfaces; headings use the Cormorant display serif.
- Renamed the shared token file `warm-paper.css` to `ink-jade.css` and swapped
  the palette to the Ink & Jade direction: warm rice-paper grounds, near-black
  ink type, jade primary, and a new cinnabar seal accent (chrome only). Added
  `jade-text`, `cinnabar`, `cinnabar-tint`, `ink-deep`, `cream`/`cream-muted`
  tokens; shifted `destructive` to a cooler crimson so error never reads as
  favorite. Updated the app/www imports, the package export, the renamed
  `UserPreferences.ui.theme` enum value, and the manifest theme color.

## Hocuspocus collab hardening (2026-06-18, branch h/hocuspocus)

- Added shared `COLLAB_SCHEMA_VERSION` in `@meridian/prosemirror-schema`, persisted
  `schema_version` on Yjs heads, and rebuild-from-markdown recovery when a stored
  head is on an older version.
- Extended collab persistence metrics with live document and open connection counts;
  shutdown drain emits the augmented payload.

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
