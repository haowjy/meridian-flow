# features/debug — Dev observability

The debug pill is an entry point: inspect each kind of state through the surface
that already owns it, and add a signal to the pill only when no inspector owns it.

| Evidence | Surface |
|---|---|
| Transport health and active thread | Debug pill |
| Turn or block record | Alt+click the rendered transcript |
| Next-turn system prompt, tools, and gateway parameters | Alt+click the composer |
| Gateway lifecycle and canonical model requests | **LLM Calls** pop-out |
| Client and server event streams | **Streams** pop-out |
| Thread lifecycle | `./mf thread view` |
| Zustand stores | Redux DevTools |
| Raw WebSocket frames | Browser Network tools |

## Contracts

- **Read-only.** The pill and inline inspector read public hooks, stores and
  owner-gated debug endpoints. The exception is the throwaway account-skill
  add/delete section, which is deleted before release.
- **Build-stripped.** `DEBUG_FEATURE_ALLOWED` is true only for
  `import.meta.env.DEV` or a build with `VITE_DEBUG_OVERLAY=1`. The route-level gate
  has to stay statically eliminable by Vite, or debug code ships.

See [overlay-interaction.md](overlay-interaction.md),
[trace-viewer.md](trace-viewer.md) and [llm-calls.md](llm-calls.md).
