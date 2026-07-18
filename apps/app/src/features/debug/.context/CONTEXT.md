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
  for model-request capture (see [overlay interaction](overlay-interaction.md)).
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

## Layout

`DebugOverlay.tsx` renders a floating pill: a collapsed button showing a
connection-state chip, which expands to a fixed-size scrollable panel with two
sections — **Transport** (`TransportSection`) and **Active thread**
(`ConversationSection`: active-thread-id resolution only). No section registry —
the pill renders its handful of sections directly. New app-level signals are
added inline in `DebugPill`; per-turn/block debugging goes inline on the
transcript instead. See [overlay interaction](overlay-interaction.md) for the
toggle, inspector, active-thread resolution, and hydration invariant.

## Pop-out observability viewers

The **Streams** action and its transport-observation contracts live in
[trace-viewer.md](trace-viewer.md). The metadata-only gateway call projection
and its content-isolation boundary live in [llm-calls.md](llm-calls.md). Both
viewers use the shared `DebugPopout` window lifecycle and chrome.

## Document sessions

`core/editor/document-session-registry.ts` is the process-wide owner of live
and generation-fenced branch `DocumentSession`s; editor views consume sessions
rather than owning their lifetime. The debug surface does not currently expose
a document-session summary. If one is needed, read through the registry's
public `observe`/session snapshot contracts instead of reaching into its maps
or creating another editor/session registry. Add the small read-only section
inline in `DebugPill` (there is no section registry).
