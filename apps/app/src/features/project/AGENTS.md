# Project workspace

Composes the authenticated workspace. Chat, editor and context domain behavior stays in those
features.

- Route boundaries own destination state and typed navigation. Child surfaces don't write URLs.
- Desktop stateful surfaces stay mounted at one grid depth across destinations, so drafts, scroll
  and sessions survive: moving an item between main and the side changes its slot, not its host.
  Phone is a sibling shell and may mount only its active destination.
- Main shows what the address names (`resolveMainDocument`, shared with the phone). The side shows
  one item, never main's. Where an item opens and what each pane shows after it follow
  [`.context/pane-state-machine.md`](.context/pane-state-machine.md): read it before changing pane
  placement, and change its rules and diagrams in the same commit.
- Project navigation never captures or repairs editor pixel scroll; the mounted reading-position
  hook owns it.
- Navigation and Work management never rebind a chat.
- Subagents are identities, not primary-list lookups.

## Child guides

- [`context/AGENTS.md`](context/AGENTS.md)
- [`mobile/AGENTS.md`](mobile/AGENTS.md)

Shell, routes and hydration: [`.context/CONTEXT.md`](.context/CONTEXT.md). Document lifecycle:
[`.context/editor-document-lifecycle.md`](.context/editor-document-lifecycle.md). Resource
architecture:
[`.context/resource-lifecycle-architecture.md`](.context/resource-lifecycle-architecture.md).
Phone: [`mobile/.context/CONTEXT.md`](mobile/.context/CONTEXT.md).
