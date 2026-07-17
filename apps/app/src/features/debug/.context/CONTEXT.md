# features/debug — Project Debug Pill

Read-only, dev-only observability surface for the authenticated project.
A small floating **pill** (bottom-right) that expands to a compact panel.

**Deliberately thin.** Only state with no better home lives here: WS/transport
health and active-thread resolution. Everything an off-the-shelf tool already
does well is delegated — and that bar is applied aggressively (the lifecycle
projection and raw wire-log were deleted once their data was reachable
elsewhere):

- **Query cache + thread lifecycle → TanStack Query Devtools** (mounted dev-only
  from `routes/_authenticated.tsx`; its own button, bottom-left). `waitingForUser`
  / `runningTurnId` live on the `["projects", projectId, "threads"]` query.
- **Zustand stores → Redux DevTools** (via the `devtools` middleware on the
  store creators — see `dom-anchors-contract`).
- **Raw WS frames → Chrome DevTools → Network → WS → Messages.**
- **Per-turn/block records → inline on the real transcript** via
  `data-turn-id` / `data-block-id` anchors + a global alt+click popover
  (`InlineInspector`), not a side-panel mirror.

Lives entirely under `features/debug/`; mounts exactly once from
`routes/_authenticated.tsx`.

## Hard rules

- **Read-only.** No mutations to any store, cache, or transport. Pill sections
  read via public hooks (`useThreadTransport`, `useThreadStore`,
  `useRouterState`). `InlineInspector` also issues a lazy owner-gated HTTP read
  for model-request capture (see below).
- **Defensive reads.** Files are being moved by the concurrent product-lift
  track. Every section is wrapped in `DebugErrorBoundary` so a single missing
  hook or shape change degrades to "not available" instead of tearing down
  the overlay.
- **Dev-only, build-stripped.** `DEBUG_FEATURE_ALLOWED` is defined in
  `core/debug-gate.ts` and re-exported by `use-debug-enabled.ts`; it is `import.meta.env.DEV ||
  import.meta.env.VITE_DEBUG_OVERLAY === "1"`. Vite strips the false branch
  from production builds, taking the overlay and its imports with it.
- **i18n exception.** This feature never ships to end users. All strings are
  inline English by design — adding them to the Lingui catalog would pollute
  production translations with debug labels. Each file states this in its
  header.
- **Design tokens only.** Semantic utilities from `globals.css`
  (`bg-card`, `bg-muted`, `border-border`, `border-border-subtle`,
  `text-meta`, `text-xs`, `text-foreground`, `text-muted-foreground`,
  `focus-ring`, `surface-card`, etc.). No hex, rgba, or magic px.

## Gating + toggle

`use-debug-enabled.ts` implements three layers:

1. **Build gate** — `DEBUG_FEATURE_ALLOWED`. False in production unless
   `VITE_DEBUG_OVERLAY=1` is set at build time.
2. **Force on (sticky)** — `?debug=1` enables the overlay AND persists the
   preference to `localStorage`, so you can drop the param from the URL and it
   stays on across reloads/navigation until explicitly disabled. (Without the
   sticky write the param was session-only and the overlay vanished on any
   reload to a param-less URL.)
3. **Toggle + persistence** — ⌘⌃D (macOS) / Ctrl+Shift+D (other) flips a
   boolean persisted to `localStorage` under `meridian:debug-overlay`. ⚠️ The
   macOS combo collides with the system Dictionary-lookup shortcut, so the
   reliable on-switch is `?debug=1`; the panel's "disable" button is the
   reliable off-switch.

## Layout

`DebugOverlay.tsx` renders a floating pill: a collapsed button showing a
connection-state chip, which expands to a fixed-size scrollable panel with two
sections — **Transport** (`TransportSection`) and **Active thread**
(`ConversationSection`: active-thread-id resolution only). No section registry —
the pill renders its handful of sections directly. New app-level signals are
added inline in `DebugPill`; per-turn/block debugging goes inline on the
transcript instead (see below).

## Inline inspector — alt+click the real transcript

`InlineInspector.tsx` (mounted from `DebugOverlay` alongside the pill, so it
shares the build gate + enable toggle) installs ONE capture-phase `click`
listener on `document`. On `event.altKey`, it resolves the closest
`[data-block-id]` (preferred — most specific) or `[data-turn-id]` from the
event target, looks the turn/block record up in the thread store
(`turnsByThread`, held in a ref so the stable listener reads fresh data), and
opens a cursor-anchored popover rendering that record via `JsonTree`.

- **Capture-phase + `preventDefault`/`stopPropagation`** so the inspect gesture
  never fires the app's own click handlers. Non-alt clicks bail immediately and
  pass through untouched.
- **Read-only** — thread store reads only; never writes. Model-request capture
  is a separate lazy path (below).
- **Model requests (lazy HTTP)** — header "model requests" button fetches
  `GET /api/threads/:threadId/debug/model-requests?turnId=…` (owner-gated on
  the server). Not loaded on alt+click; only on explicit button click. Returns
  404 (`not_found`) when capture is disabled on the server — the inspector
  shows a disabled notice. In-flight fetches are keyed to the active
  `{threadId, turnId}` so fast reselection cannot show another turn's rows.
  Rendered records pass through the full API payload (including `threadId` /
  `turnId`) via `JsonTree`.
- **Dead-end-free** — if an id isn't in the store, the popover still shows the
  DOM attributes (role/status or blockType/seq) so the id is never lost.
- **Copy** — a header "copy" button writes `JSON.stringify(record, null, 2)` to
  the clipboard (`navigator.clipboard.writeText`; needs a real click for
  user-activation), with a brief "copied" label flash.
- **Dismiss** — a sibling transparent `<button>` backdrop (keyboard-clean, no
  static-element click handler) or `Escape`.
- **Why this consumes DOM anchors but scroll-to-turn does NOT:** the inspector
  only acts on elements that are currently rendered (you click what you see), so
  virtualization is irrelevant. scroll-to-turn must reach OFF-screen rows, which
  `react-virtuoso` does not mount — so it lives in `TurnList` via `scrollToIndex`
  and is owned by the chat track, not here.

## Active-thread resolution

1. `useThreadStore((s) => s.streamingThreadId)` (primary).
2. Fallback: TanStack Router location — `/chat/$threadId` path param or the
   project route's `?thread=…` search param (note: `thread`, NOT `threadId`).
3. None → reports `resolvedActiveThreadId: null`.

This section reads only the thread store + router location. It deliberately does
NOT subscribe to the query cache — an earlier version scanned the project-threads
cache for a `ThreadListItem` lifecycle projection, which both duplicated Query
Devtools and forced a `queueMicrotask`-deferred `useSyncExternalStore` wrapper to
dodge a setState-in-render crash. Both were deleted; that hazard class is gone.

## React-safety invariant (subtle — verified at runtime)

- **SSR-safe gate (no hydration mismatch).** `useDebugEnabled` returns
  `enabled: false` on the first render (matching the server, which has no
  `window` and renders nothing), then resolves the real value from
  `?debug=1` / `localStorage` in a post-mount effect. Reading storage in the
  `useState` initializer makes the first client render diverge from server
  HTML → *"Hydration failed"*.

## Realtime stream inspector — client half live

The pill's **Streams** action opens `TraceViewer` in a separate browser window
and portals the React tree into it. The popup shares the opener's JavaScript
context, so capture state stays in the main page and remains live while the
editor is used; closing the popup never stops capture. The popup clones the
opener's active style/link nodes and document attributes. Popup controls use
owner-document browser primitives so keyboard focus, clipboard activation, and
downloads stay in the child window rather than leaking back to the opener.
Its plain-TypeScript store (`trace/trace-store.ts`) owns a 2,000-entry
`EventRecord` ring and exposes the producer boundary `appendTraceEvent` /
`noteTapError`; producers append the shared contracts envelope, never a
viewer-specific record. The store drops the oldest record at capacity, counts
ring drops and tap errors, and coalesces subscriber notification per JavaScript
turn without coalescing captured records. The viewer provides composable
stream, message-class, direction, and correlation filters; frozen live-tail
inspection; record detail; and filtered JSONL copy, download, and
accessibility-tree output. Freeze snapshots the current projection while
capture and eviction continue. Future lenses project over this same store
rather than adding data paths.

The dev-only shared Hocuspocus socket carries a `TappedWebSocket` observer
seam (`core/transport/tapped-websocket.ts`); `trace/yjs-wire-tap.ts` maps its
frames to metadata-only `EventRecord`s. The authenticated composition root
synchronously calls `installYjsTap()` before rendering any subtree that can
create the shared socket; the visual overlay remains lazy. Capture is always on
for the page lifetime and the runtime toggle gates only the viewer. Vite hot
data preserves the observer sequence and room attribution when Fast Refresh
replaces the tap.
Server-side
collab operations still emit zero success-path structured events — the server
half (S4: correlation receipts, SSE feed, durability columns, and thread-WS
coverage) is
[#239](https://github.com/haowjy/meridian-flow/issues/239) in cluster
[#235](https://github.com/haowjy/meridian-flow/issues/235). The current viewer
is the client-Yjs core, not the final multi-source surface: S6 adds the LLM
calls lens only after S4's feed and S5's gateway events exist. Burst grouping
is intentionally deferred beside the S4 viewer merge; see `.context/FUTURE`.

## Document sessions

`core/editor/document-session-registry.ts` is the process-wide owner of live
and generation-fenced branch `DocumentSession`s; editor views consume sessions
rather than owning their lifetime. The debug surface does not currently expose
a document-session summary. If one is needed, read through the registry's
public `observe`/session snapshot contracts instead of reaching into its maps
or creating another editor/session registry. Add the small read-only section
inline in `DebugPill` (there is no section registry).
