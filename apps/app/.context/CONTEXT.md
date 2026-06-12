# @meridian/app — Architecture & Conventions

How the frontend is structured, why the seams exist, and what conventions
govern visual and interaction work.

## State + transport seams

Two interfaces are the only paths between the visual layer and the substrate:

- **`ThreadStoreState` / `ThreadStoreActions`** (`src/client/stores/thread-store/types.ts`) —
  read vs write contracts. **Implementation:** `src/client/stores/thread-store/thread-store.tsx`
  (Zustand vanilla store, one instance per `ThreadStoreProvider`, SSR-safe).
  **Public imports:** `@/client/stores` only — do not reach into store internals from features.
  UI reads via `useThreadStore(selector)`, `useThreadTurns(threadId)`; writes via
  `useThreadActions()` only. Composer handoff uses `markHandoffPending` +
  `useThreadHandoff` (not inline in `ChatView`).
- **Server project/thread lists + HTTP snapshots:** React Query (`client/query/` —
  `useProjectList`, `useProjectThreads`, `useWorks`, `useThreadSnapshotSync`). The
  `_authenticated` loader seeds the project list + `now`; the `$projectId`
  loader seeds per-project threads + works before the workspace renders.
- **Zustand (thread-store):** per-thread `turnsByThread`, handoff flags,
  `streamingThreadId`, pending stream metadata. `applyThreadSnapshot` writes
  turns only. Soft-delete undo lives in the **project-store**, not here.
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
default-collapsed `Thinking ptN` fold plus its visible `ActivityBlock` frontier.
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

Future optimistic surfaces (rename, soft-delete, undo) follow the same
shape: optimistic store update first, API call second (`threads-api.ts`),
deterministic reconcile path on response or failure.

### Thread snapshot writes (two sources, two hooks)

Authoritative turn history enters the store through exactly two paths:

| Source | When | Code |
|--------|------|------|
| **HTTP** | Chat route mount / reload | `useThreadSnapshotSync` (Query fetch → `applyThreadSnapshot` for turns) |
| **WebSocket** | Reconnect/gap recovery | `ThreadRunController` fetches a snapshot and calls `applyThreadSnapshot` |

Do not call `applyThreadSnapshot` from `ChatView` or other view effects. Snapshot application stays in data-sync hooks and transport recovery, and uses identity-based block reconciliation.

## Project workspace screen routing

`src/routes/_authenticated/project/$projectId.tsx` owns the workspace search
params (`?screen=`, `?thread=`, `?scheme=`, `?folder=`, `?path=`, `?ext=`) and is
the single source of screen/thread ownership. `ProjectView` and its children are
controlled — they never set the URL directly, only call the route's handlers.

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

## Visual conventions — Warm Paper design language

Agent entry point: [DESIGN.md](../../../DESIGN.md) (repo-root design doc; Stitch-shaped overview + YAML snapshot).
This section is the implementation contract (tiers, overflow chain, discipline test).

### Token hierarchy

**Tier 1 — semantic tokens (`@meridian/design-tokens/warm-paper.css`).**
Shared palette imported into `globals.css` as Tailwind v4 `@theme` variables,
consumed everywhere as classes (`bg-surface-warm`, `shadow-card`, `text-headline-hero`) or direct `var(--color-*)` CSS references. Categories:

- **Colors:** background, foreground, primary, muted, ink-*, chip-*, status-*
- **Surfaces:** `surface-warm`, `card`, `surface-subtle`
- **Borders:** `border`, `border-subtle`, `border-focus`
- **Shadows:** `shadow-card`, `shadow-hero`, `shadow-button`, `shadow-mark`
- **Gradients:** `gradient-mark`, `gradient-avatar`
- **Type scale:** `text-eyebrow`, `text-headline-hero`, `text-headline-section`,
  `text-body`, `text-sm`, `text-xs`, `text-meta`, `text-answer`
- **Radii:** explicit `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-xl` values where component geometry
  needs distinct values
- **Status colors:** `status-streaming`, `destructive`

When a new visual concept appears in ≥2 places, it becomes a Tier 1 token. New
shared tokens land in `packages/design-tokens/src/warm-paper.css` (or workbench-only
`@theme` in `globals.css` when app-specific); only then are they consumed.

**Tier 2 — `@utility` primitives (also in `globals.css`).** Composite patterns
that bundle multiple tokens into a reusable class. Today's primitives:

- `surface-card` — the rounded card surface
- `status-pill` — small uppercase muted label
- `icon-chip` — size-9 icon button wrapper
- `streaming-dot` — live indicator
- `soft-hover-card` — hover-lift used on Recent cards
- `app-frame` — viewport-locked shell (`h-svh max-h-svh overflow-hidden`); one screen, no page scroll
- `app-scroll` — designated vertical scroll region inside `app-frame`
- `main-pane` — flex shrink + horizontal clip (`min-w-0 max-w-full overflow-x-hidden`); use on shell inset, chat surface, scroll region — **not** on turn leaves
- `chat-column` — chat conversation column (`max-w-chat-column`, horizontal padding)
- `home-column` — home page column (`max-w-home`, vertical padding; grid `li` shrink)
- `chat-scroll-fade-bottom` — bottom-edge mask on the chat scrollport (`--chat-scroll-fade-size`, scrollbar gap tokens); fades messages behind the pinned composer, not an overlay scrim
- `user-turn` / `user-message-bubble` — right-aligned user prompt chrome
- `answer-body` — plain streaming text typography
- `prose-tokens` — Streamdown/markdown wrapper (typography + code/table overflow)

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

**System UI stack** for both body and headings (`--font-sans` / `--font-heading`
in `@theme`). Headline weight/size still comes from `text-headline-*` tokens —
components never reference font families directly. Webfonts were removed to avoid
FOUT during dev.

### Dark mode (not yet shipped, prepare the seams)

Today the shared design-token package defines the light `@theme` values and
`globals.css` adds only workbench-specific theme/root variables. Adding dark mode is a single
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
- Dev API proxy (`apiHttpDevProxyPlugin`) skips WebSocket upgrades (those go via Vite `server.proxy`) and skips `/api/auth/*` (auth-kit session middleware must run in-process).

## Seeded from

The official TanStack Start + Supabase example
(`TanStack/router/examples/react/start-supabase`), adapted to monorepo
conventions: `@meridian/app` name, workspace deps for domain packages, biome
toolchain (prettier config removed), `tsconfig.base.json` extension.

## Cross-module links

→ [../../.context/CONTEXT.md](../../.context/CONTEXT.md) — harness composition, app layer architecture, DI wiring pattern
→ [../server/AGENTS.md](../server/AGENTS.md) — the Nitro API service (`apps/server`) this app proxies

## KB links

- [API and frontend surface](https://github.com/meridian-flow-bio/docs/blob/main/kb/decisions/api-and-frontend-surface.md)
- [Supabase auth](https://github.com/meridian-flow-bio/docs/blob/main/kb/decisions/supabase-auth.md)
