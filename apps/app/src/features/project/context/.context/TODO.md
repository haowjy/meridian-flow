# Context browser TODO

## Optimistic interaction contract

- **CTX-001: Project folder creation into the tree immediately where identity permits.** Project it only if the client can mint the stable tree identity; otherwise keep it server-confirmed rather than projecting a fake row. Keep recursive folder deletion and Work-authority changes server-confirmed.
- **CTX-002: Make by-ID document doors commit the destination before admission.** `open-project-document.ts` awaits both local resource opening and, when absent, server availability before changing the address for links, trail receipts, and search results. Preserve latest-attempt fencing while moving materialization and failure onto the destination.

- Uploads in the chat's dock document: the dock shows Scratch notes; a chat-launched Uploads viewer with intake controls is still deferred (#625, #631).
