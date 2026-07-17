# Debug overlay interaction

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
