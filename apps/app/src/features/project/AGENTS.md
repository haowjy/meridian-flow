# Project workspace

This feature composes the authenticated project workspace: persistent desktop
rails and dock, phone shell, route-controlled destinations, and project-scoped
screens. Chat, editor, and context domain behavior stays in those features.

- Route boundaries own destination state and typed navigation. Child surfaces
  render through controllers and do not write URLs.
- Desktop stateful surfaces stay mounted at one grid depth across destinations;
  placement changes slots, not ownership. Phone is a sibling shell and may
  mount only its active destination.
- Navigate first. Creation, persistence, and connection follow in the
  background; failures stay on the destination or acted-on row.
- Editor reading memory belongs to the mounted reading-position hook. Project
  navigation never captures or repairs editor pixel scroll.
- Work selection is catalog state and chat binding is explicit composer state;
  navigation and Work management never rebind a chat implicitly.
- One tab-local current chat and remembered Work are restored through the
  tab-first helpers. Subagents are identities, not primary-list lookups.
- Project identity is its route UUID plus mutable title. Rename in workspace
  chrome with the optimistic title command; never couple it to URL or context
  URI slugs.

## Child guides

- [`chat-index/AGENTS.md`](chat-index/AGENTS.md)
- [`context/AGENTS.md`](context/AGENTS.md)
- [`dock/AGENTS.md`](dock/AGENTS.md)
- [`mobile/AGENTS.md`](mobile/AGENTS.md)

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for shell layout, route
contracts, hydration, and document lifecycle. The phone-specific contract is
in [`mobile/.context/CONTEXT.md`](mobile/.context/CONTEXT.md).
The document lifecycle detail is [`.context/editor-document-lifecycle.md`](.context/editor-document-lifecycle.md)
and the resource architecture is [`.context/resource-lifecycle-architecture.md`](.context/resource-lifecycle-architecture.md).
