# domains/context

Agent-readable/writable project content addressed by context URIs. Five
schemes split into durable Project content (`manuscript://`, `kb://`,
`user://`) and ephemeral Work scratch (`work://`, `uploads://`). Bare paths
default to `manuscript://`.

Single unified `ContextPort` — callers resolve through `contextPortForThread`,
never scheme-specific adapters directly.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for contracts, URI invariants,
and ContextFS details.
