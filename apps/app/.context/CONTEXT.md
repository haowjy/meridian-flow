# @meridian/app — Architecture & Conventions

How the frontend is structured, why the seams exist, and what conventions
govern visual and interaction work.

## Project Home

The Home client boundary, feed/row layout contract, interaction ownership, and
test-specific browser constraint live with the feature in
[`src/features/project/home/.context/CONTEXT.md`](../src/features/project/home/.context/CONTEXT.md).

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
  `useThreadActions()` only. Project Home first-message continuity lives in one
  account-scoped IndexedDB owner, not Zustand. Home stages the immutable
  Composer envelope before navigation; destination Chat atomically claims
  `ready` as `dispatching`, while a remounted `dispatching` or `ambiguous`
  record performs ledger lookup only. `ThreadRunController` joins append,
  lookup, and explicit retirement to a typed settlement boundary. Definite rejection remains durable until
  the matching shared Composer acknowledges an idempotent restoration; when a
  newer draft exists, the failed first send is prepended with a blank-line
  document separator so both writer-authored documents survive. Ambiguous admission stays
  quarantined without blind retry. If a writer changes the Home draft while
  creation or routing is pending, the immutable first message remains the
  admitted turn and the latest authored revision transfers separately into the
  destination Composer, even when that revision's text is byte-equal to the
  submitted message. The shared Composer reports a monotonic authoring revision;
  content equality is never a draft-version test.
  Continuity survives route and reload but is not an outbox: it has no timer,
  worker, polling, or blind retry. Deferred project-creation flows separately use
  `markPendingCreation`, `clearPendingCreation`, and `removeOptimisticUserTurn`;
  the last one is only rollback for a locally appended user turn that failed
  before server acknowledgement.
- **`ThreadCachePort`** (`src/client/stores/thread-store/thread-cache.ts`) —
  thin seam between thread-store lifecycle transitions and the React Query cache.
  The store depends on this port, not `QueryClient` directly — list/snapshot
  projections stay in Query; per-thread turn state stays in the store. Its
  lifecycle projector converges `actionRequired` across project thread lists,
  Home, and every matching Work feed while Favorite remains normalized separately.
- **`useRenameThread`** (`src/client/query/useRenameThread.ts`) — optimistic
  thread-title rename via `patchThreadInProjectCaches`; lives beside Query hooks
  (cache-only today, no PATCH endpoint) rather than on the thread store.
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
  thread or Work transition that can change Home also invalidates `homeFeed`.
  Terminal turns and Work rebinds enter through
  `invalidateThreadProjectionDependencies`. Snapshot synchronization applies
  history and action-required lifecycle state. Favorite commands share one
  normalized project/thread authority across Home and Work rows; Home alone
  projects the affected item between its categories without invalidation.
  `useWorks` exposes only the owned-project Work catalog. Home derives its
  initial prospective choice from the first active (then first available) catalog
  Work and sends that explicit ID; omitted root-chat creation remains the sole
  server boundary where omission and explicit null both mean no primary Work.
  Direct `/project/*` and `/chat/*` authenticated routes mount the project
  provider stack and seed the project list + `now`; the project route loader
  seeds per-project threads and works before the workspace renders, and carries
  the working-set read as an explicit `row` / `absent` / `unavailable` result.
- **Zustand (thread-store):** per-thread `turnsByThread`,
  `streamingThreadId`, pending stream metadata, snapshot reconciliation
  watermark (`snapshotNextSeqFloorByThread`). Soft-delete undo lives in the
  **project-store**, not here. See "Thread snapshot reconciliation" below.
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
`partitionTurnSegments` (`features/chat/partition-turn-segments.ts`): ordered
turn blocks are split at checkpoint boundaries, and each segment renders a
default-collapsed `Thinking` fold plus its visible `ActivityBlock` frontier.
`groupDeliverySegments` normalizes tool delivery into ToolViews while preserving
image-producing tool results as image blocks. For the full Thinking/Activity
contract, see [`features/chat/.context/CONTEXT.md`](../src/features/chat/.context/CONTEXT.md).

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

`src/lib/optimistic-independent-chat.ts` owns the retained standalone-chat
optimistic flow: client-generated UUID → navigate immediately → API call →
reconcile on response. It is deliberately separate from project-address
creation, whose destination must not own an unresolved project/thread create.

Home first send deliberately orders the boundary differently: stable client ID
→ canonical create or same-ID ambiguity reconciliation → optimistic turn and
durable continuity stage → route → destination claim. A definite stale Work or Agent refusal, whether
returned by the initial create or its guarded same-ID retry after absence
reconciliation, is identified only by the named `work_unavailable` or
`agent_not_found` code, refreshes the relevant catalog, and unlocks prospective
context repair while retaining the stable ID and immutable first text. Every
other uncertain create remains locked to that original envelope while same-ID
reconciliation continues. A canonical mismatch is never handed off; Start over
retires it before a later submission allocates a fresh ID.

Future optimistic surfaces (rename, soft-delete, undo) follow the same
shape: optimistic store update first, API call second (`threads-api.ts`),
deterministic reconcile path on response or failure.

### Thread snapshot reconciliation

Authoritative turn history enters the store through `applyThreadSnapshot`,
which reconciles server turns against local optimistic state via
`reconcileSnapshotTurns`. Two callers:

| Source | When | Code |
|--------|------|------|
| **HTTP** | Chat route mount / reload | `useThreadSnapshotSync` (Query fetch) |
| **WebSocket** | Reconnect/gap recovery | `ThreadRunController.applySnapshot` |

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
rehydrates the device Context desk after the shell is visible. Local persistence
reconciliation never projects an account-preparation screen or gates initial
rendering.

`src/routes/_authenticated.tsx` mounts one unconditional route composition for
every authenticated route (`AppQueryProvider` → `AccountFeatureComposition` →
`DraftApplyRecoveryProvider` → `ProjectStoreProvider` → `ThreadStoreProvider` →
`TransportProvider` → `MeridianCopilotProvider`). No
pathname-based provider gating — conditional light↔workspace branches previously
dropped `ThreadStoreProvider` during transitions.

**Settings overlay:** `?settings=<section>` is layout-owned (`validateSearch` on
`/_authenticated`) so the settings dialog is URL-addressable from any authenticated
route without changing path. See `features/account/SettingsDialog.tsx`.

## Readable project addresses and route lifetime

The authenticated project workspace has one readable public grammar rooted at
`/p/<project-slug>`; all internal query/cache/session identities remain IDs.
The parent resolves the owner-scoped project slug, mounts `ProjectView` once
keyed by that resolved ID, and its `$` catch-all selects child destinations.
There is no `/project/<UUID>` or `/projects/<UUID>` project route and no
`screen`/`thread`/`scheme`/`folder`/`path` query grammar. `/chat/<thread-UUID>`
remains the deliberately independent chat route and is outside project-address
cutover scope.

Path destinations are Home (`/p/<project>`), chat collection/new/detail
(`/chats`, `/chats/new`, `/chat/<chat-slug>`), Work collection/detail
(`/works`, `/work/<work-slug>`), Editor (`/editor`), and context browse or
document paths. A Work-scoped context path carries its Work slug in the path;
project-scoped context can use the explicit `work` query selector. The only
project-address query keys are `chat`, `work`, `settings`, and `results`.
Selectors distinguish omitted, explicit no-Work (empty), a slug, and malformed
input; duplicate recognized keys and malformed encodings are invalid rather
than normalized into another destination. Case and trailing-slash canonical
replacement use the address serializer. Settings remains the layout-owned
overlay; Results remains auxiliary state.

`ReadableProjectRoute` is the sole browser-address parser/resolver and
`createProjectNavigation` owns history admission. Project, Work, and chat
slugs resolve only through successful owner/project catalogs. An unavailable or
malformed explicit target parks/disables its requested host; it never falls
through to a remembered or catalog-default target. Main-destination navigation
pushes a concrete selection; dock selection, canonicalization, and repair
replace only when their captured entry is still current. Keep route parsing and
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
catalog-only: omitted/null root creation is explicitly no-Work. Home and Work
each own exactly one screen-level `app-scroll`; neither adds a nested scroll
owner.

## Visual conventions — tonal manuscript shell

Agent entry point: [DESIGN.md](../../../DESIGN.md) (repo-root design doc; YAML snapshot).
This section is the implementation contract (tiers, overflow chain, discipline test).

The shell follows the settled **earthen value ladder** — one grey-gold family
separated by lightness: shelf `oklch(0.91 0.012 84)` (pressed
`oklch(0.86 0.014 84)`), one chrome field `oklch(0.945 0.012 84)` shared
pixel-identically by tab band and dock, and warm paper `oklch(0.977 0.007 95)`
as the brightest page. Light mode
uses one black ink `oklch(0.24 0.009 100)` throughout. Jade is action-only;
cinnabar is a scarce seal. The visual tokens live in
`packages/design-tokens/src/ink-jade.css`.

**Skin, not shell.** The palette, typography, accent semantics, brand mark, and
login hero are a skin. Sidebar/composer structure and interaction patterns stay
stable; token changes must not alter layout or behavior.

### Token hierarchy

**Tier 1 — semantic tokens (`@meridian/design-tokens/ink-jade.css`).**
Shared palette imported into `globals.css` as Tailwind v4 `@theme` variables,
consumed everywhere as classes (`bg-card`, `shadow-card`, `text-headline-hero`)
or direct `var(--color-*)` CSS references. Categories:

- **Three-tone ladder:** shelf (rail — chrome one shade darker), sidebar (tab band ≡ dock chrome), background (warm paper page — brightest), card (local lifted fields/menus)
- **Ink and accents:** foreground (one black ink), primary/jade-text (actions, links, focus), cinnabar (scarce seal only), muted and ink hierarchy roles
- **Composer:** manuscript-tone `composer-surface` plus `composer-border`; it does not borrow chrome or action color
- **Borders:** `border`, `border-subtle`, `border-focus` — in-pane controls and hairlines only; shell-region separation is tonal, with no seam borders
- **Shadows:** `shadow-card`, `shadow-hero`, `shadow-button`, `shadow-rail-left`
- **Atmosphere:** `dock-airlight` lifts the dock floor; the shelf stays flat so scrolled navigation keeps constant contrast
- **Type scale:** `text-headline-hero`, `text-headline-section`, `text-body`,
  `text-compact` / `text-caption` (secondary-prose roles — bundle a relaxed
  reading line-height), `text-sm` / `text-xs` (UI-control sizes),
  `text-meta` (dense metadata). Custom `--text-*` size tokens must be registered
  in `cn()`'s font-size group (`lib/utils.ts`) or tailwind-merge silently drops
  them next to a `text-<color>`.
- **Radii:** explicit `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-xl` values where component geometry needs distinct values
- **Status colors:** `status-streaming`, `destructive` (distinct from cinnabar)

Contrast guardrails: black ink is about 12.6:1 on the flat shelf and 10.7:1 on
its pressed step; muted and hint roles are 6.5:1. The
[Earthen Value Ladder decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/earthen-value-ladder-shell.md)
owns the deeper rationale, measurements, and rejected directions.

When a new visual concept appears in ≥2 places, it becomes a Tier 1 token. New
shared tokens land in `packages/design-tokens/src/ink-jade.css` (or project-only
`@theme` in `globals.css` when app-specific); only then are they consumed.

**Tier 2 — `@utility` primitives (also in `globals.css`).** Composite patterns
that bundle multiple tokens into a reusable class. Today's primitives:

- `surface-card` — the rounded card surface
- `streaming-dot` — live indicator
- `app-frame` — viewport-locked shell (`h-svh max-h-svh overflow-hidden`); one screen, no page scroll
- `app-scroll` — designated vertical scroll region inside `app-frame`
- `main-pane` — flex shrink + horizontal clip (`min-w-0 max-w-full overflow-x-hidden`); use on shell inset, chat surface, scroll region — **not** on turn leaves
- `chat-column` — chat conversation column (`max-w-chat-column`, horizontal padding)
- `home-column` — home page column (`max-w-home`, vertical padding; grid `li` shrink)
- `chat-scroll-fade-bottom` — bottom-edge mask on the chat scrollport (`--chat-scroll-fade-size`, scrollbar gap tokens); fades messages behind the pinned composer, not an overlay scrim
- `user-turn` / `user-message-bubble` — right-aligned user prompt chrome
- `prose-tokens` — Streamdown/markdown wrapper (typography + code/table overflow).
  Font size is `calc(1rem * var(--text-scale))`; all inner element sizes
  (headings, code, tables) are `em` so the whole tree rides the text-size
  preference. Element styling for markdown lives here, not in Streamdown
  component overrides — Streamdown's baked fixed-rem utilities (`text-sm` on
  inline code / table cells) must be overridden by a declaration, or they pin
  that element off-scale.
- `text-tier-chat` — remaps `--text-scale` to `--text-scale-chat` for a
  subtree: chat reads **one preference stop below the manuscript** (md→sm,
  sm→xs, lg→md). Mounted once on `ChatSurface`; the manuscript editor rides
  the full scale. Conversation is working material; the manuscript is the
  artifact. Tiers are DOM inheritance: portaled overlays escape to manuscript
  scale by design.
- `text-tier-compact` — the dense meta voice for markdown (tool output,
  reasoning): parameterizes `prose-tokens` (`--text-scale`, `--prose-leading`,
  `--prose-color`) instead of stacking a second font-size utility, so no two
  classes compete for the same property by source order. Fixed size (does not
  ride the reading preference).

When a className composition repeats in ≥2 places, promote it to a primitive.
Thin React wrappers (`ChatColumn`, `HomeColumn`) only pin a utility name — no
extra layout logic.

### Horizontal overflow (flex shrink chain)

Page-level horizontal scroll is prevented by a **boundary chain**, not per-turn
`min-w-0` classes:

1. `html` / `body` — locked height, `overflow: hidden`
2. `app-frame` — viewport shell (`AppShell`, bare-view root, `SidebarProvider`)
3. `app-scroll` — designated vertical scroll regions inside the frame
4. `AppShell` → `SidebarInset` — `main-pane`
5. `ChatSurface` root + scroll region — `main-pane`
6. `chat-column` / `home-column` — include `main-pane`
7. `prose-tokens` — `break-words`; `pre` / table wrapper scroll inside the column
8. `user-turn` — `max-w-[95%]` on the bubble column

Cross-repo OSS comparison for shell/scroll boundaries:
[source-app-shell-patterns.md](source-app-shell-patterns.md).

**Exceptions (keep `min-w-0` on the truncating flex child only):** `disclosure-trigger`,
ProcessDisclosure / process-fold summary rows, sidebar `ThreadRow` rename field,
`ErrorBlock` / `ImageBlock` flex rows.

**Tier 3 — Tailwind base scale (in TSX).** Component-internal spacing only.
`gap-2`, `p-3`, `mb-4`, `space-y-1`. Use the base scale, never arbitrary
pixels. Component-specific *geometry* (a particular avatar size, a specific
rounded corner) is acceptable inline.

### Spacing

Spacing is contextual and resists full centralization:

- **Centralize (Tier 1)** when the value defines *cross-component rhythm* —
  page gutter, sidebar width, `--container-chat-column` (48rem), `--container-home`
  (45rem), composer footer fade, section gap. Two components need to agree on the value.
- **Use the Tailwind scale (Tier 3)** for *component-internal* spacing —
  internal padding, gap between sibling elements, button padding. The
  component owns the value.
- **Magic pixels are a smell.** If a value isn't in the Tailwind scale, it's
  either (a) Tier 1 rhythm that needs promoting, or (b) you should round to
  the nearest scale step.

Dropdown row geometry is shared by `components/ui/dropdown-presentation.ts`.
Row-bearing regions add vertical breathing only; `dropdownRowVariants` alone
owns the horizontal text gutter and square, full-bleed state paint. Keyboard
focus uses block-edge rules and the theme-specific semantic dropdown focus
indicator, whose contrast is protected against every shared row fill, not a
four-sided inset halo. It remains visible inside popup clipping without reading
as another card. Search
fields, headings, and state copy add their own local gutters. This keeps
selected, hover, and focus boundaries edge-attached across menus, selects,
pickers, composer navigation, and the thread switcher.

Shared Radix dropdown and context-menu content must cancel non-primary
`pointerup` during capture. Radix otherwise selects the row underneath the
release that summoned a context menu, even though that row never received the
press; a right-click can therefore run Open, Copy, or another first-row action
while the writer is only asking to inspect. Keep the guard in the shared
`components/ui/` wrappers rather than repeating it at feature call sites.

### Typography

Three fonts via `@theme`: `--font-heading` → Cormorant Garamond (display),
`--font-prose` → Noto Serif (editor/turns/markdown), `--font-sans` → Inter (UI
chrome). Loaded via Google Fonts in the app root layout. Headline weight/size
comes from `text-headline-*` tokens — components consume token classes, not font
family names directly.

### UI themes and dark mode

Theme switching is token-contained: `@meridian/design-tokens/themes.css`
holds `:root[data-ui-theme="<name>"]` blocks (currently `dark`) that
re-point the same token names; the default light palette is the absence of
the attribute. The device-local preference lives in `src/lib/ui-theme.ts`
(localStorage + pre-paint boot script in `__root.tsx`, mirroring text
size) and is switched from Settings → Preferences. Tailwind's `dark:`
variant keys off the same attribute (see `globals.css`) — never a `.dark`
class.

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

## Discipline test

Before merging a change that touches visuals: grep the touched files for
`#`-hex colors, `rgba(...)`, `rounded-[N]`, `text-[N]px`, `gap-[N]px`,
`mt-[N]px`. Each one is either justified (genuinely surface-specific
geometry) or it's a token that wants promoting.

UI tests assert a behavior or semantic seam—roles, names, state, callback
outcomes, accessible errors, or a public component boundary—not Tailwind
styling vocabulary. Browser-measure real layout and hit boxes; JSDOM cannot
establish geometry.

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
