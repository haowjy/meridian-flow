# @meridian/app — Architecture & Conventions

How the frontend is structured, why the seams exist, and what conventions
govern visual and interaction work.

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

## State + transport seams

Hocuspocus stateless `safety_notice` messages enter through the existing
document transport and are retained on `DocumentSession`. Live editor surfaces
render `late_sweep` and `checkpoint_sweep` as a quiet, dismissible receipt below
the toolbar; no parallel toast/notification store exists. `beforeContentRef` is
retained in the notice payload, but the client currently has no reconstruction
endpoint keyed by that reference, so the receipt intentionally has no
`View change` action yet.

Two interfaces are the only paths between the visual layer and the substrate:

- **`ThreadStoreState` / `ThreadStoreActions`** (`src/client/stores/thread-store/types.ts`) —
  read vs write contracts. **Implementation:** `src/client/stores/thread-store/thread-store.tsx`
  (Zustand vanilla store, one instance per `ThreadStoreProvider`, SSR-safe).
  **Public imports:** `@/client/stores` only — do not reach into store internals from features.
  UI reads via `useThreadStore(selector)`, `useThreadTurns(threadId)`; writes via
  `useThreadActions()` only. Composer handoff uses `markHandoffPending` +
  `useThreadHandoff` (not inline in `ChatView`). Deferred first-send flows use
  `markPendingCreation`, `clearPendingCreation`, and
  `removeOptimisticUserTurn`; the last one is only rollback for a locally
  appended user turn that failed before server acknowledgement.
- **`ThreadCachePort`** (`src/client/stores/thread-store/thread-cache.ts`) —
  thin seam between thread-store lifecycle transitions and the React Query cache.
  The store depends on this port, not `QueryClient` directly — list/snapshot
  projections stay in Query; per-thread turn state stays in the store.
- **`useRenameThread`** (`src/client/query/useRenameThread.ts`) — optimistic
  thread-title rename via `patchThreadInProjectCaches`; lives beside Query hooks
  (cache-only today, no PATCH endpoint) rather than on the thread store.
- **Server project/thread lists + HTTP snapshots:** React Query (`client/query/` —
  `useProjectList`, `useProjectThreads`, `useWorks`, `useThreadSnapshotSync`).
  `useWorks` also exposes the server-resolved `defaultWorkId`; `useDefaultWorkId`
  is the chat-independent seam for work-scoped surfaces.
  Direct `/project/*` and `/chat/*` authenticated routes mount the project
  provider stack and seed the project list + `now`; the project route loader
  seeds per-project threads and works before the workspace renders, and carries
  the working-set read as an explicit `row` / `absent` / `unavailable` result.
- **Zustand (thread-store):** per-thread `turnsByThread`, handoff flags,
  `streamingThreadId`, pending stream metadata, snapshot reconciliation
  watermark (`lastAppliedSnapshotSeqByThread`). Soft-delete undo lives in the
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

## Wire types as protocol contract

`@meridian/contracts/protocol` defines the canonical `AGUIEvent` payload and
`SequencedAGUIEvent` transport wrapper; session entities (`Thread`, `Turn`, `Block`)
are JSON-natural string IDs and ISO timestamps from `@meridian/contracts/threads`.

Both transports emit this shape; the reducer consumes this shape.

## Optimistic flow pattern

`src/lib/optimistic-project.ts` is the template for client-led writes:
client-generated UUID → navigate immediately → call `threads-api.ts` → reconcile
on response. The Composer's submit-from-Home flow follows it.

`src/lib/deferred-project-chat.ts` is the existing-project variant for a
client-only thread that should not be created on the server until first send. It
seeds an optimistic thread, marks **only the thread id** pending creation, and
leaves `pendingCreation.projectIds` untouched because the project already
exists. `DeferredFirstSendLatch` guards the create+submit path against
double-submit; if first-send fails after an optimistic user turn is appended,
`removeOptimisticUserTurn(threadId, optimisticTurnId)` removes that local user
turn while preserving the pending thread row for retry.

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
canonical server ID. The response also carries `ackHeadSeq`, the journal head
observed after the append committed. Acknowledgement raises the thread's stored
snapshot floor to `ackHeadSeq + 1` (snapshot `nextSeq` terms), so a stale
snapshot cannot remove the rewritten row while the projector catches up.

**Monotonic sequence guard.** `applyThreadSnapshot` accepts an opt-in
`nextSeq` parameter (the server-assigned journal sequence for the snapshot).
When supplied, the store tracks `lastAppliedSnapshotSeqByThread` and rejects
any snapshot whose `nextSeq` is strictly less than the stored value
(BigInt comparison for journal sequences beyond Number.MAX_SAFE_INTEGER).
Both HTTP snapshot callers must pass `nextSeq`. An unsequenced caller
(no `nextSeq`) is treated as authoritative and always applies -- omitting
`nextSeq` is intentional only for the handoff/pending-creation path.

**Anti-pattern: reapplying captured snapshots for side effects.**
`useThreadSnapshotSync`'s attention-downgrade effect previously reapplied
the entire captured snapshot after `markThreadOpened` resolved, solely to
set `attention: "none"`. A delayed continuation could reapply an older
snapshot after a newer one had advanced the sequence watermark, dropping the
user turn again. The fix: use the narrow
`setThreadAttention(threadId, attention)` action instead. Never replay a
whole snapshot to achieve a single field mutation.

**Rejected alternative: extending acknowledged-ID retention windows.** The
alternative of retaining acknowledged IDs "until all in-flight snapshots
settle" was rejected. There is no clean signal for when older in-flight
snapshots cannot apply -- React Query deduplicates concurrent fetches of the
same key, but nothing in the cache contract guarantees ordering of
independent fetches. The monotonic sequence guard solves the ordering
problem structurally.

## Authenticated layout shell

`src/routes/_authenticated.tsx` mounts one unconditional provider tree for every
authenticated route (`AppQueryProvider` → `ProjectStoreProvider` →
`ThreadStoreProvider` → `TransportProvider` → `MeridianCopilotProvider`). No
pathname-based provider gating — conditional light↔workspace branches previously
dropped `ThreadStoreProvider` during transitions.

**Settings overlay:** `?settings=<section>` is layout-owned (`validateSearch` on
`/_authenticated`) so the settings dialog is URL-addressable from any authenticated
route without changing path. See `features/account/SettingsDialog.tsx`.

## Project screen routing

`SCREENS` (`features/project/shell/screens.ts`) is the single source of
route-valid primary destinations: **home, chat, context** (Import removed).
Settings and phone Results are auxiliary routed surfaces (`?settings=`,
`?results=`), not drawer/sidebar destinations.

`src/routes/_authenticated/project/$projectId.tsx` owns the workspace search
params (`?screen=`, `?thread=`, `?scheme=`, `?folder=`, `?path=`, `?results`) and
is the single source of screen/thread/context ownership. `ProjectView` and its
children are controlled — they never set the URL directly, only call the route's
handlers. Direct `/chat/$threadId` renders the independent chat view inside the
same provider stack.

Ownership rules:

- **`?screen=` wins; a bare `?thread=` (no screen) implies `chat`.** The
  Context/KB, extensions, and home screens are therefore reachable *with threads
  present* — a thread no longer forces the chat screen.
- **`onSelectThread` is screen-changing** (sets `screen: undefined` + `thread`,
  i.e. navigate to chat); **`onSelectDockThread` is screen-preserving** (patches
  only `thread`). The persistent `ChatDockPanel` (right-hand dock beside non-chat
  screens) uses the dock handler so its thread switcher swaps the conversation
  without stealing `?screen=` from the KB/file view.
- **The dock's fallback thread is display-only.** When no valid `?thread=` is set,
  the dock shows the first primary thread in its selector but **must not** write
  that fallback into the route — non-chat screens own `?screen=`, so forcing the
  fallback into the URL would flip the screen to chat.
- **Stale/invalid params are normalized at the route.** A `?thread=` that isn't in
  the loaded thread set is stripped via a `replace` navigation once threads load;
  `validateSearch` rejects `folder`/`path` supplied without a `scheme` (no
  contradictory KB state from hand-typed/stale URLs). Switching screens drops the
  subordinate params of the screen left behind.

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
- **Atmosphere:** `shelf-depth` / `dock-airlight` background-image tokens that do not add another shell material
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

### Typography

Three fonts via `@theme`: `--font-heading` → Cormorant Garamond (display),
`--font-prose` → Noto Serif (editor/turns/markdown), `--font-sans` → Inter (UI
chrome). Loaded via Google Fonts in the app root layout. Headline weight/size
comes from `text-headline-*` tokens — components consume token classes, not font
family names directly.

### Dark mode (not yet shipped, prepare the seams)

Today the shared design-token package defines the light `@theme` values and
`globals.css` adds only project-specific theme/root variables. Adding dark mode is a single
move: add a `.dark` block that overrides the same token names with dark
values. Because every component consumes via tokens, the swap stays token-contained.

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

## Motion (forward-looking)

When motion vocabulary is needed, follow the same pattern: define
`--motion-fast` / `--motion-normal` / `--motion-deliberate` durations and a
small easing scale in `globals.css`, consume via tokens in TSX.

## Discipline test

Before merging a change that touches visuals: grep the touched files for
`#`-hex colors, `rgba(...)`, `rounded-[N]`, `text-[N]px`, `gap-[N]px`,
`mt-[N]px`. Each one is either justified (genuinely surface-specific
geometry) or it's a token that wants promoting.

## Dev limitations (pilot)

- Thread event log is in-memory in `apps/server`. Agent events lost on `apps/server` restart. Swap the adapter there without touching this app.
- Dev API proxy (`apiHttpDevProxyPlugin`) skips WebSocket upgrades (those go via Vite `server.proxy`) and skips `/api/auth/*` so TanStack Start route handlers can own WorkOS AuthKit cookie auth in-process.

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
