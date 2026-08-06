# features/debug — Dev observability

Read-only, dev-only inspection for an authenticated project. The debug pill is
only an entry point: inspect each kind of state through the surface that already
owns it.

| Evidence | Surface |
|---|---|
| Transport health and active thread | Debug pill |
| Turn or block record | Alt+click the rendered transcript |
| Next-turn system prompt, tools, and gateway parameters | Alt+click the composer |
| Gateway lifecycle and canonical model requests | **LLM Calls** pop-out |
| Client and server event streams | **Streams** pop-out |
| Query cache and thread lifecycle | TanStack Query Devtools |
| Zustand stores | Redux DevTools |
| Raw WebSocket frames | Browser Network tools |

Do not mirror these sources inside the pill. Add app-level signals there only
when no existing inspector owns them.

## Contracts

- **Read-only.** The pill and inline inspector may read public hooks, stores,
  and owner-gated debug endpoints. They never mutate application state.
- **One mount.** `DebugOverlay` mounts from `routes/_authenticated.tsx` and owns
  the pill, inline inspector, and pop-out portals.
- **Build-stripped.** `DEBUG_FEATURE_ALLOWED` is true only for
  `import.meta.env.DEV` or a build with `VITE_DEBUG_OVERLAY=1`. The route-level
  gate must remain statically eliminable by Vite.
- **Failure isolation.** `DebugErrorBoundary` contains a failed inspector read
  without taking down the authenticated app.
- **Dev copy stays local.** Inline English does not enter the Lingui catalog.
- **Design tokens only.** Use semantic color and type utilities from
  `globals.css`; do not add raw hex or rgba values.

See [overlay-interaction.md](overlay-interaction.md) for activation and inline
inspection, [trace-viewer.md](trace-viewer.md) for Streams, and
[llm-calls.md](llm-calls.md) for model requests.
