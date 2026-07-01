# @meridian/contracts

Shared TypeScript contracts for IDs, DTOs, protocols, thread events, agents,
interrupts, preferences, projects, works, drafts, and runtime wire shapes.

- `drafts/` — wire types for AI draft preview, accept, reject.
- Keep types JSON-natural at boundaries.
- Do not import server adapters, database clients, React, or provider SDKs.
- Prefer branded IDs and explicit protocol events over untyped strings.
