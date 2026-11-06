# Project workspace

Composes the authenticated workspace. Chat, editor and context domain behavior stays in those
features.

- Route boundaries own destination state and typed navigation. Child surfaces don't write URLs.
- Desktop stateful surfaces stay mounted at one grid depth across destinations, so drafts, scroll
  and sessions survive: placement changes slots, not ownership. Phone is a sibling shell and may
  mount only its active destination.
- Project navigation never captures or repairs editor pixel scroll; the mounted reading-position
  hook owns it.
- Navigation and Work management never rebind a chat.
- Subagents are identities, not primary-list lookups.

## Child guides

- [`chat-index/AGENTS.md`](chat-index/AGENTS.md)
- [`context/AGENTS.md`](context/AGENTS.md)
- [`dock/AGENTS.md`](dock/AGENTS.md)
- [`mobile/AGENTS.md`](mobile/AGENTS.md)

Shell, routes and hydration: [`.context/CONTEXT.md`](.context/CONTEXT.md). Document lifecycle:
[`.context/editor-document-lifecycle.md`](.context/editor-document-lifecycle.md). Resource
architecture:
[`.context/resource-lifecycle-architecture.md`](.context/resource-lifecycle-architecture.md).
Phone: [`mobile/.context/CONTEXT.md`](mobile/.context/CONTEXT.md).
