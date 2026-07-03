# Changelog

## [Unreleased]

- `apps/app`, `apps/server`: inline draft review. Reviewing an AI draft now
  opens the manuscript itself with Track-Changes-style highlights — green for
  AI proposals, gold for the writer's own edits, red strikethrough widgets for
  deletions. A proposals sidebar shows one card per change (AI badge or You
  badge) with per-proposal Discard; discard is instant, Ctrl+Z brings it back,
  and discarding again still returns the passage to the manuscript text. The
  writer edits the draft freely during review; Apply commits the curated
  result to the manuscript in one click. Large rewrites fall back to the
  existing changes panel.

- `apps/server`: drafts are now scoped to a Work instead of a thread — sibling
  threads in the same work see and contribute to one shared draft, and
  finalization invalidates in-flight responses work-wide. Migration remaps
  existing draft rows.

- `apps/server`: each draft is its own collaboration room (`draft:<id>`)
  persisted to the draft journal; the live manuscript room is untouched during
  review. Draft finalization closes the room and fences late writes.

- `apps/server`: agent writes to a draft are blocked while a writer is
  reviewing it (presence-derived lease with a 30s reconnect grace); agents get
  a "writer is reviewing" result instead of silent drops.

- `apps/server`: Apply is fenced by the draft revision the writer actually
  reviewed — if the draft changed under them, Apply refuses and the review
  refreshes instead of committing unseen content.

- `apps/server`: historical Yjs journal reads are now bounded — a newer live
  checkpoint can no longer leak future state into a draft's base, overlap
  detection, or reject reconstruction.

- `apps/app`: draft review is one flow with two surfaces. The editor now keeps a docked review bar with Show changes / Apply / Discard plus a docked diff panel; the centered modal is only the no-editor fallback. Chat cards and the bar share server-backed undo state that survives reloads, and every document draft gets its own row so Undo stays visible when another draft arrives.

- `apps/app`: threads with unreviewed AI drafts now show a count chip in the sidebar and Switch chat menu, so pending changes outside the focused conversation stay findable.

- `apps/server`, `apps/app`, contracts: runtime human pause is now an interrupt; checkpoint is reserved for Yjs restore snapshots. The blocked-thread badge says "Needs your answer", wire/status names moved to interrupt (`waiting_interrupt`, `kind: "form"`, `kind: "ask"`), and a migration updates the turn status constraint.

- Tests: billing free-tier grants use deterministic ledger time, and draft/write-mode route
  coverage now protects behavior without pinning route-core choreography.

- `apps/server`, `apps/app`: accepting an AI draft is now its own user-attributed transcript event. The accept footer says "You accepted this draft · Undo", and undo reverses that accepted change instead of attaching to the proposing assistant turn.

- `apps/server`: draft accept/reject is now DB-fenced. Concurrent accepts report in progress, stale draft responses cannot recreate closed drafts, and applied retry recovers the live Yjs doc after a crash between journal write and live apply.

- `apps/server`: reloading the page or a dropped WebSocket no longer cancels an
  in-flight agent turn. The run finishes server-side and a reconnecting client
  reattaches via the existing snapshot/resume path — long turns survive accidental
  reloads and flaky connections instead of losing the work and spent credits. Only
  an explicit Cancel (or a real provider error) stops a turn now. Removed the dead
  connection-token run-ownership seam left over from the old disconnect-cancel. (#104)

- `apps/app`: one font everywhere — **Inter** is now the single typeface across UI
  chrome, the editor, rendered markdown, conversation turns, and headings.
  Headings/emphasis differ by size + weight only. Dropped the Noto Serif prose
  face and the Cormorant Garamond display face (and their font downloads); the
  `--font-heading`/`--font-prose` tokens are gone. (`apps/www` keeps a Fraunces
  landing hero as an isolated marketing exception.)

- `apps/app`: toolbar list buttons work again — bullet/ordered list commands now
  target the renamed `list_item` node instead of throwing "no node type named
  'listItem'". Guarded by an editor command test.

- `apps/app`: pasting a GFM markdown table now inserts a real table instead of
  plain-text paragraphs. Plain prose paste is untouched (conservative
  header+delimiter detection only).

- `apps/app`: fenced code blocks now render on a distinct warm code surface with
  syntax highlighting, replacing the near-white unstyled box. Syntax colors are
  design tokens (no vendor highlight.js theme).

- `apps/app`: TipTap document schema now includes GFM table nodes, `strike`, and
  task-list `list_item.checked` state, with schema-parity coverage for table roles.

- `packages/markup`: markdown codecs now recognize the v3 `strike` mark and
  mdast GFM table/task-list shapes as codec inputs.

- `packages/prosemirror-schema`: schema version 4 adds GFM table nodes, a
  `strike` mark, and task-list state on `list_item` for markdown/Yjs
  round-tripping.
- Chat editing: find/replace now tolerates the `hash|` block prefixes that `read`
  emits. The model can paste `read` output straight into a `find` without it
  failing and triggering a "run read to re-sync" loop. The raw document is still
  matched literally, so genuine `|` content (tables, etc.) is unaffected.

- Chat editing: a block hash shown by `read` is now always resolvable. Displayed
  hashes extend just enough to stay a unique prefix of their block, so referencing
  a hash the model saw no longer silently fails when another block shares a short
  prefix. Lookups also accept any unique-length prefix, so a hash stays usable
  even as sibling blocks come and go.

- Chat editing: referencing an ambiguous block hash now reports it as ambiguous
  (not a misleading "not found"), and a `read` on an ambiguous hash shows every
  matching block with its full disambiguating hash so the model can re-target.

- Chat editing: when a concurrent edit lands mid-turn, the agent is now re-shown
  the changed block bodies with their current hashes after its write commits,
  instead of just a list of changed hashes — so it can keep editing against
  current content without a full re-read. Concurrent deletions are now surfaced too.

- Chat editing: a destructive whole-scope `replace`/delete addressed only by a
  scope (hash, index, range, or section) with no `find` is now refused with a
  "re-read and retry" prompt when the document changed since the agent's last
  read — so a stale address can't silently destroy a moved/reclaimed target.
  Content-confirmed (`find`-based) edits and all non-destructive ops still
  auto-resync silently.

- Chat editing: a destructive `replace`/delete targeting a hex-shaped `#hash`
  fragment no longer silently falls back to a same-named heading section when the
  hash is stale/missing — it returns not-found instead of editing the wrong
  section. Reads still resolve `file#hash` to a section by slug.

- Chat editing: `create` (and `create overwrite`) now checks existence and
  computes its overwrite from the canonical + staged view, not a stale replica —
  so an overwrite fully replaces canonical content, a duplicate create in the same
  turn is rejected, and a non-overwrite create no longer leaves stale phantom
  blocks attached to the session.

- Chat: assistant turns with many edits no longer stall the UI. An unstable
  checkpoint callback was defeating memoization and causing a render storm.

- Collab: undo/redo after retention compaction no longer corrupts the document.
  Reconstruction now reads from the compacted checkpoint instead of the original
  baseline, so undoing a still-retained write stops resurrecting edits that
  compaction folded away. Compaction now folds only a contiguous update prefix.

- Collab: pending undo/redo notifications coalesce deterministically (latest wins)
  even when several land in the same millisecond.

- Collab: live undo/redo planning now ignores draft-scoped agent-edit rows, so
  draft proposals cannot appear as reversible live writes before acceptance.

- Collab: grouped undo/redo notifications now carry each write handle's original turn id
  instead of collapsing mixed-turn groups onto the seed turn.

- Collab: grouped redo boundaries are now treated as atomic undo units; selecting one write from a grouped redo expands to every write in that redo so document content and reversal metadata stay in sync.

- Collab: undoing "the latest turn" now reverses every group that turn touched,
  even when a grouped reversal pulled in writes from an earlier turn. The scope
  loop pins to the selected turn instead of the representative reported turn, so
  it no longer stops early and leaves part of the turn reversed.

- Chat editing: after a writer undoes the agent's edits, the agent's next edit
  no longer fails with "run read to re-sync." The agent's document replica
  re-syncs automatically from canonical, so the model never spends a tool call
  re-reading just to keep editing.

- Chat editing: the message telling the model which edits a writer reversed now
  lists the specific reversed write ids per file, so the model can tell exactly
  what changed without re-reading.

- Collab: undo/redo now uses persisted reversal lineage instead of delete-set ownership guessing, so concurrent edits in other blocks or non-overlapping ranges survive repeated undo/redo cycles without corruption.

- Collab: reversal rows now persist the redo re-apply update seq so the next undo/redo lineage pass can stop guessing redo ownership. No planner behavior changes in this slice.

- Chat: assistant turns that edited documents now show a "N documents changed" footer.
  Expand it to see each document, click a document name to open it in the editor, and
  undo/redo per document or all at once. Already-undone or expired edits show the
  right state.
- Chat editing: when a writer undoes the agent's edits and then sends another
  message, the model is told which edits were reversed (net undo/redo state,
  injected once on the next turn) so it stops redoing unwanted work.

- Chat editing: turn-scoped undo/redo can now reverse every document a turn touched.
  The reverse API accepts `scope: "turn"` without `uri`, resolves affected
  documents from the agent-edit journal, and returns a shared per-document
  `TurnReversalOutcome` contract.

- Billing: stripped to a thin Stripe gateway + FIFO usage ledger. No "credits"
  anywhere — users see dollars (extra-usage balance, per-message cost) and a
  monthly-usage percentage; grant amounts stay server-side. Free tier is a $0/mo
  plan granting $2/mo of usage; paid plans are Standard $10 and Premium $25.
  Extra usage is a free-form top-up requiring no subscription — pick any amount
  from $5 to $500 (quick-pick chips + custom input, default $10). Deleted the
  custom payment-provider/subscription machinery and the `user_subscriptions`
  table; added `users.stripe_customer_id`. Model calls now meter at provider cost
  ×1.15. Checkout is unavailable in dev until Stripe test keys are set; free tier
  and consumption work regardless. The recent-activity feed shows friendly labels
  ("Monthly usage", "Extra usage") instead of leaking raw Stripe ids, and the
  usage meter reads as a remaining-percentage gauge.

- Preferences: projects store AI write mode (`direct`/`draft`) for future reviewable AI drafts.

- `packages/agent-edit`: the resolver→apply write core is now CRDT-neutral — it
  works on opaque `BlockRef`/`DocHandle` handles with all Yjs (and Tier-2
  ProseMirror construction) behind the model adapter, so the editing protocol no
  longer hard-codes the Yjs document model. No change to how edits, undo/redo, or
  echoes behave.
- `packages/agent-edit`: the agent `write` command schema is one Zod source. The
  `view` command is renamed to **`read`**; the model-facing tool schema is
  generated from the same schema; and validation is now strict — unknown or
  command-irrelevant fields are rejected instead of silently stripped.

- `packages/markup`: new `@meridian/markup` package — the codec (text ↔
  ProseMirror, markdown + MDX) extracted out of `@meridian/agent-edit` into a
  standalone leaf package with a composable builder/plugin API
  (`createMarkupCodec().use(mdx()).build()`) and `markdownCodec`/`mdxCodec`
  presets. MDX is the canonical format; MDX components are closure-captured by
  the `mdx()` plugin rather than threaded through context. `@meridian/agent-edit`
  now wraps it with a thin `AgentEditCodec` for hash-prefixed echo serialization,
  and the editor (`apps/app`) and collab server (`apps/server`) consume the codec
  directly. No behavior change — pure extraction.

- `packages/agent-edit`: simplified write echo to one per-block `v_pre` →
  `v_post` content-diff path with word-based context truncation, removed
  commit-time echo recomputation, and made undo/redo return the same structured
  metadata+echo blocks as writes.

- Dev tooling: added `pnpm dev:prune-worktrees` to safely clean merged worktrees, linked Meridian work items, dev processes/routes, and per-worktree databases with dry-run planning.

- Collab/DB integrity pass (branch `db-collab-integrity-fixes`):
  - `packages/agent-edit`: `requireSynced` now reconciles a persisted sync-state
    row against the live document before authorizing a mutate. After a restart the
    persisted snapshot is treated as a fast-start baseline only, so a stale `find`
    can no longer resolve against human edits the agent never saw.
  - `apps/server` collab: server journal `read()` guards against stale persisted
    schema versions — heads stamp the running `COLLAB_SCHEMA_VERSION` on upsert and
    `read()` throws `StaleDocumentSchemaError` instead of replaying CRDT bytes built
    for an older ProseMirror schema. Rebuild-from-markdown recovery stays a follow-up.
  - `@meridian/database`: added the `document_yjs_heads.latest_checkpoint_id` →
    `document_yjs_checkpoints.id` foreign key (`ON DELETE SET NULL`), replacing a
    comment that falsely claimed the FK already existed in custom SQL
    (migration `0006`).
  - `@meridian/database`: backfilled the missing `meta/0005_snapshot.json` so
    `db:generate` no longer re-emits `agent_edit_sync_state` into the next
    migration; the snapshot chain is consistent (`drizzle-kit check` + no-op
    `db:generate` are clean).
  - Dev tooling: `migration-lint` now exempts the real `0000_` baseline (not
    `0001_`), cutting baseline noise from 125 warnings to 12 real follow-up
    warnings. It also gains `--strict` (warnings fail) and `--changed <ref>`
    (lint only migrations changed since a ref); a CI `migration-checks` job runs
    `drizzle-kit check` (always blocking) and scoped migration-lint on PRs
    (`--strict` only when merging to `main`/`staging`), and pre-commit lints
    staged migration SQL.
  - `apps/server` collab: head `schema_version` advances monotonically on upsert,
    so a downgraded server cannot stamp it backward and erase the stale-schema fence.
- Dev tooling: repo-pinned pnpm moves to 10.34.3 so Corepack pnpm
  commands no longer emit Node DEP0169 from pnpm's bundled package-arg
  resolver.
- Editor: document load no longer builds a throwaway TipTap editor before the
  real collaboration session is available.

- Chat editing: a writer can now reverse the agent's edits themselves, not just
  the agent. New authenticated endpoint reverses (undo/redo) at three
  granularities — a single write (`w<N>`), a whole turn, or the entire thread —
  and the reversal is attributed to the user. Reversing a turn/thread that was
  undone in several steps now restores the whole scope in one call instead of
  silently leaving part reversed.

- Collab: agent/user undo now correctly marks the edit reversed in Postgres.
  Previously the Drizzle journal matched reversal by the wrong key, so in
  production an undone write stayed flagged active and undo availability drifted;
  the document content reverted but the bookkeeping lied. A cross-adapter
  conformance contract now pins in-memory and Postgres to the same behavior.

- Dev (`pnpm dev`): Tailscale sharing works across multiple worktrees at once.
  `tools/dev` now owns the Tailscale-serve → app mapping on deterministic
  per-worktree ports, so each worktree's app/www gets its own stable
  `https://<node>.ts.net:<port>` instead of two worktrees fighting over `:443`
  and serving a proxy 404.

- Server DB: completed the Drizzle thread repository contract for usage/cost
  rollups. Threads now persist `total_cost_usd`; turns persist response count,
  latest model/provider, reasoning/cache tokens, request/response metadata; model
  responses persist reasoning/cache tokens; block rows persist provider metadata.
  Drizzle now maps the same thread/turn/model-response semantics as the
  in-memory conformance adapter, including decimal zero normalization.

- `packages/agent-edit`: undo/redo now runs on a single cold reconstruction path;
  the live `Y.UndoManager` ("hot") path is deleted. Behavior is unchanged for
  callers — agent undo still reverts only the agent's edits and preserves
  overlapping human edits. Public API drops `WriteTool.registry` and the
  `undoRegistry` option; adds an optional `createRuntimeDoc` so the host controls
  forward-write doc creation.

- Collab: a Yjs clientID band `[0,999]` is reserved for server-authored reversal.
  The browser editor and server docs draw their clientID outside the band, and
  inbound collaboration updates carrying a band clientID are rejected at ingest —
  so agent reversal authoring can never collide with a real collaborator's edit
  stream.

- Chat editing: the agent now edits documents through one `write(command=...)`
  tool (create / view / insert / replace / undo / redo) backed by
  `@meridian/agent-edit`. Edits land as real Yjs collaborator operations —
  character-level, position-anchored — so multiple people and the agent can edit
  the same document live, and undo/redo is native (never silently no-ops). The
  old `read`/`edit`/full-replace `write` tools are gone.

- `packages/agent-edit`: `write()` returns a structured `WriteOutcome`
  (`command`, `status`, `isError`, `text`); hosts read the envelope instead of
  parsing status out of the text. Package is host-agnostic: it requires an
  injected ProseMirror schema and carries no Meridian dependency
  (`@meridian/prosemirror-schema` is devDependency-only). Public API trimmed to
  the supported surface. Yjs+ProseMirror is the v1 content model; a swappable
  non-ProseMirror content model is deferred (GH #70).

- Server collab: full-document markdown engine extracted out of `composition.ts`
  into a focused module; `CollabDomain` split into narrow ports
  (`AgentEditAccess`, `MarkdownDocumentStore`, `DocumentProjectionRefresher`,
  `DocumentCheckpoints`, `DocumentAttribution`, `CollabTransport`).

- Runtime gateway: cancelled-call settlement moved behind a provider-neutral
  `Gateway.settleCancelledResult` hook; the orchestrator/loop no longer reference
  any model provider by name, so a new provider needs only a gateway adapter.

- Dev (`pnpm dev`): the per-worktree `DATABASE_URL` rewrite is injected directly
  into the tmux pane instead of trusting the launching shell's direnv state — a
  stale direnv cache no longer boots the server against the wrong database. The
  resolved DB name is logged at launch.

- Dev (`pnpm dev`): fail fast when the live database has drifted from the repo's
  migration baseline (compares applied vs expected migration hashes) instead of
  failing later, deep in feature code, on the first schema mismatch.

- `packages/agent-edit`: scaffold `@meridian/agent-edit` with port interfaces
  (`UpdateJournal`, `DocumentCoordinator`, `ActorSessionStore`, `Codec`,
  `DocumentModel`, `ComponentSpec`) — types only, no implementations yet.

- Dev tooling: clarified migration drift remediation (migrate/apply-functions
  for simple catch-up, reset for divergence), removed duplicate env/git helpers,
  and added `pnpm dev:gc-dbs` for stale worktree DB cleanup.

- Test suite pruning: deleted low-value contract/helper tests, in-memory
  conformance wrappers, skipped DB conformance wrappers, and duplicate golden
  coverage; collapsed broad runtime, gateway, MDX, turn-reducer, and WS suites
  to representative boundary cases.

- Brand mark: compass needle on a cream-jade disc with hairline ring (disc-cream-ring);
  replaces the bare needle and cinnabar seal-square favicon. Proto route at
  `/proto/logo-mark` for comparing discarded framing options.

- Docs: consolidated local setup in `DEVELOPMENT.md`; slimmed
  `tools/dev/.context/CONTEXT.md` to module contracts only; `AGENTS.md` points
  to `DEVELOPMENT.md` for setup and `tools/dev/AGENTS.md` when editing dev tools.

- Dev (`pnpm bootstrap`): run `direnv allow` automatically when direnv is
  installed so linked worktrees trust `.envrc` without a manual step first.

- Dev (worktree DB isolation): linked git worktrees rewrite `DATABASE_URL` to
  sibling databases on the local Postgres server (`meridian_<slug>`); the main
  checkout keeps bare `meridian`. `applyDevEnvToProcess`, `.envrc`, and
  `bootstrap` apply the rewrite so migrations and `db:reset` are worktree-scoped.

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

## Editor cursor colors and cleanup (2026-06-19, branch h/mdx-manuscript)

- Fixed CollaborationCaret "unsupported color format" warning: replaced
  `var(--color-primary)` with concrete hex colors for cursor rendering.
- Cursor colors are now assigned by join order from a rotating 8-color palette
  (Google Docs style): each client picks the first palette color not already
  claimed by another connected user via awareness state.
- Deleted dead barrels, the skeleton agents domain export, stale project-shell
  components, the legacy agent route, and unused re-exports.

## MDX manuscript format — schema narrowing (2026-06-18, branch h/mdx-manuscript)

- Narrowed shared ProseMirror schema for markdown-representable subset: `image`
  forbids marks, table cells drop colspan/rowspan/colwidth, added `horizontal_rule`
  scene-break node. Bumped `COLLAB_SCHEMA_VERSION` to 2. TipTap editor parity preserved.
- MDX ingress: skip tilde-fenced code blocks in prose-escape pre-pass; reject
  boolean/shorthand `<Figure>` attrs (quoted strings only).
- MDX ingress: CommonMark-complete inline code span handling (N-backtick open/close)
  so `<`/`{` inside multi-backtick code is not backslash-corrupted; document
  Phase-1 limits for indented code and angle-bracket autolinks.

## Hocuspocus collab transport (2026-06-18, branch h/hocuspocus)

- Replaced the custom Yjs WebSocket transport with Hocuspocus v4 end-to-end:
  the server now owns every live `Y.Doc` (single owner), and the client uses a
  `HocuspocusProvider` bound to the existing editor session. Same editor
  experience, but with built-in heartbeat, reconnect, and per-document auth —
  the attributed update log is preserved (overload-dropped updates are not).
- Deleted the legacy transport stack: custom WS handler, `yjs-multiplex` wire
  protocol + message constants, the old client transport, the
  `DocumentSyncTransport` port, and the dead agent route.

- Fixed document session status when access is denied before first server sync:
  terminal/unauthorized transport states now pre-empt the initial-sync gate so
  the pill shows access-lost instead of stuck syncing.
- Tightened Hocuspocus terminal-denial classification to explicit 4401/4403 close
  codes and `onAuthenticationFailed` (per-doc denial), dropping loose reason
  substring heuristics that could misclassify transient closes.
- Added regression tests for denial-before-sync status, transport terminal
  classification, and registry union-of-openers retention lifecycle.
- Deferred document session teardown with a grace window so React strict-mode
  release→retain churn does not detach Hocuspocus providers on the shared socket.
- Versioned client IndexedDB persistence keys by `COLLAB_SCHEMA_VERSION` so schema
  bumps invalidate stale local Yjs caches and force server resync; best-effort GC
  deletes older per-document IndexedDB entries.
- Added a soft live-document session cap warning in `DocumentSessionRegistry`
  (no hard eviction).
- Added shared `COLLAB_SCHEMA_VERSION` in `@meridian/prosemirror-schema` and
  `schema_version` on `document_yjs_heads`; server journal writes stamp the current
  version on head upsert and `read()` throws `StaleDocumentSchemaError` when a
  stored head is older than the running schema (loud guard, not silent replay).
  Rebuild-from-markdown stale-schema recovery remains a planned follow-up.
- Extended collab persistence metrics with live document and open connection counts;
  shutdown drain emits the augmented payload.
- Fixed `storeDocument` checkpoint writes clobbering `latestUpdateSeq` via targeted
  `setLatestCheckpointId` updates on the document store port.
- Made Hocuspocus shutdown drain a quiescence loop so async close work cannot leave
  persistence queues or in-flight stores behind.

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
