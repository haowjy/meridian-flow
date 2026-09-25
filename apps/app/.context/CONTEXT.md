# @meridian/app — Architecture & Conventions

How the frontend is structured and why its seams exist. Visual implementation
conventions live in [visual-conventions.md](visual-conventions.md).

## Frontend performance

Recurring traps (layout `shouldReload`, relative-time clocks, editor vendor
chunks, streaming memo/coalesce) live in [frontend-perf.md](frontend-perf.md).
`EditorView` is a static host dependency; do not lazy-load it.

## Project Chat index

The Chat index feed/row contract and interaction ownership live with the feature in
[`src/features/project/chat-landing/.context/CONTEXT.md`](../src/features/project/chat-landing/.context/CONTEXT.md).

## Server config and auth surface

`src/server/config.ts` is the app server's config seam. It parses the
upstream-shaped runtime variables `APP_ENV` and `LOG_LEVEL` through
`src/server/runtime-config.ts`, then adds Meridian/WorkOS settings:
`WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI`, `WORKOS_DEV_LOGIN_*`,
`WORKOS_DEV_AUTOLOGIN`, and `MERIDIAN_API_ORIGIN`. The parsed config is
server-only; isomorphic client-path helpers such as `src/client/api/ssr-api-request.ts`
must keep their guarded env reads local instead of importing `getAppServerConfig()`.

Auth is WorkOS AuthKit: the sealed `wos-session` cookie is minted by
`/api/auth/callback` (hosted AuthKit) or `/api/auth/dev-login` (dev-only password
auth). `/logout` clears the session via `signOut()`.

`isDevAutologinEnabled()` (`src/server/dev-auth.ts`) gates dev autologin; it is
false in production and requires `WORKOS_DEV_AUTOLOGIN=1` plus
`WORKOS_DEV_LOGIN_EMAIL` / `WORKOS_DEV_LOGIN_PASSWORD`.

## Dev watcher boundary

The repository `logs/` tree is generated server observability output. Vite's
`server.watch.ignored` predicate excludes that directory and its descendants so
log mirrors do not cause app reloads; it must remain boundary-aware and must
not ignore sibling paths merely sharing a prefix such as `logs-other`.

## State + transport seams

Writer-facing AI change reporting uses durable Trail evidence, receipt
Undo/Redo, and session change marks. Trail evidence and peer marks are
read-only; `DocumentSession` owns collaboration state only and does not retain
a parallel safety-notice presentation model.

Session change-mark self-suppression uses the canonical internal Meridian
`UserId` from `/api/auth/me`, matching `change_event.admittedByUserId`. WorkOS
external ids authenticate the shell but never identify collaboration records.
Two interfaces are the only paths between the visual layer and the substrate:

- **`ThreadStoreState` / `ThreadStoreActions`** (`src/client/stores/thread-store/types.ts`) —
  read vs write contracts. **Implementation:** `src/client/stores/thread-store/thread-store.tsx`
  (Zustand vanilla store, one instance per `ThreadStoreProvider`, SSR-safe).
  **Public imports:** `@/client/stores` only — do not reach into store internals from features.
  UI reads via `useThreadStore(selector)`, `useThreadTurns(threadId)`; writes via
  `useThreadActions()` only. Before navigation or dispatch, the project new-chat composer and
  existing-thread sends write an unresolved intent to the account-stamped chat
  submission journal. Destination Chat owns persistence, idempotent replay,
  acknowledgement, and recovery. Ambiguous sends retain their journal witness;
  accepted, proved rejected, retired, or writer-abandoned sends retire it.
  `markPendingCreation`, `clearPendingCreation`, and
  `removeOptimisticUserTurn` fence deferred creation and local display only.
  The journal is an acknowledged-submission record, not a thread replica or
  offline AI runtime.
- **`ThreadCachePort`** (`src/client/stores/thread-store/thread-cache.ts`) —
  thin seam between thread-store lifecycle transitions and the React Query cache.
  The store depends on this port, not `QueryClient` directly — list/snapshot
  projections stay in Query; per-thread turn state stays in the store. Its
  lifecycle projector converges `actionRequired` across project thread lists,
  the Chat index, and every matching Work feed while Favorite remains normalized separately.
- **`useRenameThread`** (`src/client/query/useRenameThread.ts`) — P1 thread-title
  command. It projects the requested title into the project thread list
  immediately, fences per-thread overlap and stale completions through
  `thread-rename-command`, persists with `PATCH /api/threads/:id/title`, and
  announces success only after the server confirms. A 4xx refusal reverts the
  title and shows inline Retry on the title control; an unknown outcome retains
  the projection and invalidates the thread list to reconcile.
- **Thread Work binding:** `useRebindThreadWork` returns discriminated confirmed,
  reconciled, and superseded outcomes to the composer-only `ComposerWorkControl`.
  `convergeThreadWorkBinding` is the one cache-effect boundary, while
  `useThreadDurableProjections` is the one persistent transport owner. Work
  management and navigation must not call this explicit rebind path. See
  [`features/chat/.context/composer-write-mode.md`](../src/features/chat/.context/composer-write-mode.md)
  for placement, interaction ownership, and mid-thread rebind behavior.
- **Server project/thread lists + HTTP snapshots:** React Query (`client/query/` —
  `useProjectList`, `useProjectThreads`, `useWorks`, `useThreadSnapshotSync`).
  `project-invalidation` supplies project-level invalidators;
  `work-projection-cache` is the one Work-entity/binding convergence policy. Any
  thread or Work transition that can change the Chat index also invalidates `chatFeed`.
  Terminal turns and Work rebinds enter through
  `invalidateThreadProjectionDependencies`. Snapshot synchronization applies
  history and action-required lifecycle state. Favorite commands share one
  normalized project/thread authority across index and Work rows. The flat
  project feed projects Favorite flags and filtered membership optimistically,
  fences pre-command page arrival, then invalidates both filter keys. A
  failed favorite keeps the last confirmed star, exposes the exact failed
  intent through an inline row-scoped Retry on the shared row, and still
  announces the error.
  `useWorks` exposes named catalog Works plus `noWork`. The new-chat composer derives its
  initial prospective choice from the first active (then first available) named
  catalog Work, or No Work. Omitted or explicit-null root creation binds the
  locked No Work row as primary.
  Direct `/p/*` and `/chat/*` authenticated routes mount the project
  provider stack and seed the project list + `now`; the project route loader
  seeds per-project threads and works before the workspace renders, and carries
  the working-set read as an explicit `row` / `absent` / `unavailable` result.
- **Zustand (thread-store):** per-thread `turnsByThread`,
  `streamingThreadId`, pending stream metadata, snapshot reconciliation
  watermark (`snapshotNextSeqFloorByThread`). The project-store retains the
  account clock and inserts confirmed creations into the project-list cache;
  it does not own a second project list. See "Thread
  snapshot reconciliation" below.
- **`ThreadTransport`** (`src/core/transport/ThreadTransport.ts`) — the
  subscribe/cancel contract for live agent events. Runtime chat uses
  `WsThreadTransport`, which connects to `/api/threads/ws`.

These exist so adapter swaps (in-memory → Dexie, Mock → WS), protocol changes,
and reducer evolution stay contained.

## Unified live block reducer

`core/session/reduce-turn-event.ts` maps the live sequenced `AGUIEvent` stream
straight into ThreadStore actions: `ensureAssistantTurn`, `upsertAssistantBlock`,
and `patchTurnStatus`. There is no separate live-turn view model; live and
settled assistant turns are the same `Turn` rows in `turnsByThread`, with
in-flight blocks marked `status: "partial"`.

Rendering flows through `AssistantTurn` →
`partitionTurn` (`features/chat/partition-turn.ts`): ordered turn blocks become
one ordered list of process, text, and artifact items. Process items collapse
into a default-collapsed `Thinking` fold in place; text and artifacts stay
visible and close the open process run. `groupDeliverySegments` normalizes tool
delivery into ToolViews. For the full process/text/artifact contract, see
[`features/chat/.context/CONTEXT.md`](../src/features/chat/.context/CONTEXT.md).

### Transcript reference rendering

`src/rich-content/Markdown.tsx` uses the public `@meridian/markup` wikilink
grammar for presentation and `reference-occurrences.ts` for submitted-reference
authority. Those are separate decisions: grammar may make syntax readable, but
only an exact submitted `(documentId, uri)` match grants occurrence navigation.
Syntax-only navigation still goes through the project-scoped link resolver and
must never inherit attachment authority.

Occurrence coordinates are offsets in the original serialized message, not in
decoded mdast text. Keep authorized content in one source block, use
CommonMark's string decoder when mapping entity/backslash-decoded text
boundaries, and leave code and raw HTML inert. A regex scanner or a second
wikilink tokenizer will drift from the wire grammar.

Streamdown caches processors by plugin function identity/name and does not
rebuild them merely because React props changed. Keep the occurrence plugin a
stable named option-taking plugin, key the renderer by occurrence metadata, and
pass live resolution through React context. Removing any one of those seams can
reuse stale authority or stale resolution while rendering unchanged text.

### Composer reference actions and uploaded material

Reference removal changes the draft, not the uploaded file. Uploaded material
remains in Uploads until explicit file deletion, so duplicate occurrences and
Undo/Redo cannot revive references to files deleted by an atom observer.
Same-identity Change retains intake provenance; a different destination does
not acquire ownership of the former upload. Composer exposes intake but no
file-deletion port. Keep removal one history unit and never put cleanup into a
reference menu, transaction observer, or timer.

## Wire types as protocol contract

`@meridian/contracts/protocol` defines the canonical `AGUIEvent` payload and
`SequencedAGUIEvent` transport wrapper; session entities (`Thread`, `Turn`, `Block`)
are JSON-natural string IDs and ISO timestamps from `@meridian/contracts/threads`.

Both transports emit this shape; the reducer consumes this shape.

## Client-led creation patterns

Existing standalone `/chat/<id>` links still render an independent-chat view.
Their backing projects are hidden from the library by the device-local
independent-project registry until the writer promotes one through that view.
Neither the account library nor project entry exposes independent-chat creation.
`/projects/new` mints a project UUID for an idempotent create request, but
remains the pending destination until creation is confirmed or reconciled by
that ID. An uncertain outcome stays on the form for retry, not on an unconfirmed
project screen.

New-chat Send journals its intent, mints local turns, selects its current chat
in place (center replaces the URL; dock leaves the destination unchanged), then
`useThreadHandoff` persists create-or-get + admit + run on those ids. Failure
stays on that chat. An empty working turn shows "Couldn't send" with Retry on
the turn, which resubmits the same thread and message ids. `useThreadHandoff`
clears that chrome once persist and run succeed. It also resumes each distinct
active run once, including a server-initiated run that wakes the parent, so a
background child's continuation streams live; see
[`features/chat/.context/thread-live-updates.md`](../src/features/chat/.context/thread-live-updates.md).
First-send creation must replay or reconcile its durable intent in place; never
replace it with lost-message recovery copy or bounce to the project library.
Later ambiguous sends use the separate acknowledged-submission recovery
contract in `features/chat/.context/CONTEXT.md`.

### Thread snapshot reconciliation

Authoritative turn history enters the store through `applyThreadSnapshot`,
which reconciles server turns against local optimistic state via
`reconcileSnapshotTurns`. Two callers:

| Source | When | Code |
|--------|------|------|
| **HTTP** | Chat route activation (mount/remount), a new run (`RUN_STARTED`), or gap | `useThreadSnapshotSync` (Query fetch) |
| **WebSocket** | Reconnect/gap recovery | `ThreadRunController.applySnapshot` |

`useThreadSnapshotSync` is always stale and refetches on activation, and it
subscribes to the thread transport to refetch when a new run starts or a gap
opens. A thread that advanced while the writer was elsewhere — a background
child's report waking the parent — therefore appears on return without a
reload, and the handoff learns of a server-initiated run it did not start.
Cached turns render first, so navigate-first is preserved. The handoff resumes
each distinct active run once; see
[`features/chat/.context/thread-live-updates.md`](../src/features/chat/.context/thread-live-updates.md).

Do not call `applyThreadSnapshot` from `ChatView` or other view effects.
Snapshot application stays in data-sync hooks and transport recovery.

**Identity bridge.** When the user submits a message, the client creates an
optimistic turn with a `turn_local_*` ID. The POST /messages response is the
identity bridge: `acknowledgeUserTurn` rewrites the local row to the
canonical server ID. The response also carries `snapshotFloorNextSeq` — the
minimum snapshot `nextSeq` that reflects the append (the server computes
head+1; the client stores it directly, no arithmetic). Acknowledgement raises
the thread's stored snapshot floor to it, so a stale snapshot cannot remove
the rewritten row while the projector catches up.

**Monotonic sequence guard.** `applyThreadSnapshot` requires a
`nextSeq` option (the server-assigned journal sequence for the snapshot).
The store tracks `snapshotNextSeqFloorByThread` and rejects
any snapshot whose `nextSeq` is strictly less than the stored value
(BigInt comparison for journal sequences beyond Number.MAX_SAFE_INTEGER).
Both HTTP snapshot callers must pass `nextSeq`. An unsequenced caller
(no `nextSeq`) is treated as authoritative and always applies -- omitting
`nextSeq` is intentional only for the handoff/pending-creation path.

## Authenticated layout shell

`src/routes/__root.tsx` owns AuthKit and renders the route outlet directly.
The authenticated route's `AccountFeatureComposition` constructs its account
feature lifetime synchronously, so its providers and descendants render on the
first pass. An actual A-to-B account replacement synchronously fences the old
lifetime and finishes its staged teardown before constructing B; only that
replacement interval withholds descendants. The authenticated browser effect
rehydrates the browser-local Editor workspace after the shell is visible. Local persistence
reconciliation never projects an account-preparation screen or gates initial
rendering.

`src/routes/_authenticated.tsx` mounts one unconditional route composition for
every authenticated route (`AppQueryProvider` → `AccountFeatureComposition` →
`DraftApplyRecoveryProvider` → `WorkingSetSyncPreferenceProvider` →
`ProjectStoreProvider` → `ThreadStoreProvider` → `TransportProvider` →
`MeridianCopilotProvider`). No
pathname-based provider gating — conditional light↔workspace branches previously
dropped `ThreadStoreProvider` during transitions.

The account-lifetime `WorkingSetSyncPreferenceProvider` owns the cross-device
working-set preference: it runs the command hook once per account, seeds from
the loader only before the first local revision, and drives both the Settings
row and `configureWorkingSetSync` from the same confirmed value. A stale or
`null` loader commit cannot hide the switch or move the driver once a local
confirm exists; an account epoch reset clears the override.

**Settings overlay:** `?settings=<section>` is layout-owned (`validateSearch` on
`/_authenticated`) so the settings dialog is URL-addressable from any authenticated
route without changing path. See `features/account/SettingsDialog.tsx`.

## Account entry

Authenticated `/` renders the project library from the project-list query,
never the last-active project. Each cover links directly to `/p/<project-uuid>`;
its selectable title and edit recency below are not links. The account-home API
and last-active-project preference are removed; selection comes from the library,
not a remembered destination.

`/projects/new` is a separate creation destination. Its title form keeps
network pending and failure there until the server returns the authoritative
project ID, then enters that project's Chat index. No account-level composer or
project-less quick-chat entry is exposed. The existing personal-project
bootstrap may still place a starter project in the library for a new account;
this UI change does not decide zero-project onboarding.

## Project addresses and route lifetime

The authenticated project workspace uses the project's existing UUID in
`/p/<project-id>`; title and slug edits do not change browser identity.
Slug-shaped project routes are not aliases. The parent loads the owner-gated
project by ID, mounts `ProjectView` once keyed by that ID, and its `$` catch-all
selects child destinations.
There is no `/project/<UUID>` or `/projects/<UUID>` project route and no
`screen`/`thread`/`scheme`/`folder`/`path` query grammar. `/chat/<thread-UUID>`
remains the deliberately independent chat route and is outside project-address
cutover scope.

Path destinations are the Chat index (`/p/<project>`) and chat detail
(`/chat/<chat-UUID>`), Work collection/detail
(`/works`, `/work/<work-slug>`), Editor (`/editor`), and context browse or
document paths. A Work-scoped context path carries its Work slug in the path;
project-scoped context can use the explicit `work` query selector. The only
project-address query keys are `work`, `settings`, and `results`.
Selectors distinguish omitted, explicit no-Work (empty), a slug, and malformed
input; duplicate recognized keys and malformed encodings are invalid rather
than normalized into another destination. Case and trailing-slash canonical
replacement use the address serializer. Settings remains the layout-owned
overlay; Results remains auxiliary state.

`ReadableProjectRoute` is the sole browser-address parser/resolver and
`createProjectNavigation` owns history admission. Project identity and Work
slugs resolve through successful owner/project catalogs. Chat UUIDs resolve by
snapshot identity, including subagents absent from the primary list. An unavailable or
malformed explicit target parks/disables its requested host; it never falls
through to a remembered or catalog-default target. Main-destination navigation
pushes a concrete selection. Dock chat selection updates browser-local current
chat without writing history. Canonicalization and repair replace only when
their captured entry is still current. Keep route parsing and
browser history behavior out of `routing/project-route.ts`: that module now
contains stable-ID navigation command types plus `ProjectSearch`, the
compare-and-swap snapshot used only by context-removal repair, not URL grammar.

The desktop parent retains its stateful children across readable child paths and
parks inactive surfaces. Phone is a sibling shell and may mount/unmount its
active leaf; the account/provider fence is above both. Replacing an account
fences the prior account lifetime immediately. A cross-project pending or error
replaces the old project subtree with an inert boundary, while a same-project
child failure parks only the requested host.

The dedicated Work screen presents Active Work first and keeps Archived Work in
a default-collapsed disclosure. Work management has no project-wide selection
state and never resolves, repairs, or changes a chat binding. The catalog is
catalog-only and omits No Work. Omitted or null root creation binds locked
No Work; the catalog never does. The Chat index and Work each own one
screen-level `app-scroll`; neither adds a nested scroll owner.

## Visual conventions

The visual implementation contract lives in
[visual-conventions.md](visual-conventions.md).

## i18n

Every user-facing string flows through Lingui macros. Use `<Trans>` for static
text, `` t`...` `` for dynamic text, and ICU `plural`/`select` for
plurals/branching. Locale resolution is centralized in `src/lib/i18n.ts`. To add
a locale: drop a `.po` file in `src/locales/<code>/`, add the code to
`lingui.config.ts` + the `CATALOGS` map.

## Accessibility (vocabulary to follow as it lands)

A11y primitives should be centralized the same way visual tokens are:

- **Focus rings:** one `focus-ring` utility (consuming `--border-focus`) that
  every interactive component uses.
- **Visually hidden text:** a `visually-hidden` utility (or shadcn's
  `<VisuallyHidden>`) for screen-reader-only content.
- **Live regions:** one shared `aria-live="polite"` region near `<body>`, fed
  by a `useAnnouncement()` hook. Streaming text, tool progress, status
  changes route through it.
- **Semantic HTML first:** `<nav>` / `<main>` / `<aside>` / heading hierarchy.
  ARIA augments, doesn't replace.
- **Keyboard contracts:** centralize shortcuts in one registry; don't sprinkle
  `onKeyDown` handlers across components.
- **Pointer cursor on anything actionable**, which shadcn and Tailwind v4 do
  not do — their reset leaves buttons on the arrow. Human ruling: this app is
  dense with quiet controls, and a writer should not have to click to learn
  what was clickable. One base-layer rule in `src/styles/globals.css` covers
  buttons, `[role="button"]`, `a[href]` and `summary`, minus anything disabled
  by attribute or by `aria-disabled`; components add no cursor utility of their
  own. Manuscript links are the deliberate exception — inside `.ProseMirror` a
  link is text under the caret. **A shadcn refresh will try to take this back;
  it is a divergence we keep.**

## Motion (forward-looking)

When motion vocabulary is needed, follow the same pattern: define
`--motion-fast` / `--motion-normal` / `--motion-deliberate` durations and a
small easing scale in `globals.css`, consume via tokens in TSX.

## Dev limitations (pilot)

- Thread event log is in-memory in `apps/server`. Agent events lost on `apps/server` restart. Swap the adapter there without touching this app.
- Dev API proxy (`apiHttpDevProxyPlugin`) skips WebSocket upgrades (those go via Vite `server.proxy`). Its explicit route-owner inventory keeps `/api/auth/callback` and `/api/auth/dev-login` in TanStack Start while forwarding the server-owned auth family, including `/api/auth/me`, to `apps/server`.

## E2E document fixtures

E2E fixtures create document content through the authenticated context HTTP API.
They may seed the relational project, Work, thread, and context-source shell in
SQL, but never write `documents.markdown_projection` or collaboration tables.
Yjs is the content authority, while `markdown_projection` is only a derived
cache; a document row without canonical Yjs state is treated by
`ensureDocument` as an empty checkpoint. Teardown deletes the owning context
sources and relies on their document and collaboration cascades.

## Seeded from

The official TanStack Start example (originally seeded from
`TanStack/router/examples/react/start-supabase`, Supabase removed), adapted to
monorepo conventions: `@meridian/app` name, workspace deps for domain packages,
biome toolchain (prettier config removed), `tsconfig.base.json` extension.

## Cross-module links

→ [../../../.context/CONTEXT.md](../../../.context/CONTEXT.md) — harness composition, app layer architecture, DI wiring pattern
→ [../../server/AGENTS.md](../../server/AGENTS.md) — the Nitro API service (`apps/server`) this app proxies

## KB links

- [API and frontend surface](https://github.com/meridian-flow-bio/docs/blob/main/kb/decisions/api-and-frontend-surface.md)
- [WorkOS auth](https://github.com/meridian-flow-bio/docs/blob/main/kb/decisions/auth-workos.md) (archived: [Supabase auth](https://github.com/meridian-flow-bio/docs/blob/main/kb/decisions/supabase-auth.md))
