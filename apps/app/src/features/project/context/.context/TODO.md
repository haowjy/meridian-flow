# Context browser TODO

## Optimistic interaction contract

- **CTX-001: Project folder creation into the tree immediately where identity permits.** Project it only if the client can mint the stable tree identity; otherwise keep it server-confirmed rather than projecting a fake row. Keep recursive folder deletion and Work-authority changes server-confirmed.
- **CTX-002: Make by-ID document doors commit the destination before admission.** `open-project-document.ts` awaits both local resource opening and, when absent, server availability before changing the address for links, trail receipts, and search results. Preserve latest-attempt fencing while moving materialization and failure onto the destination.

- Chat frame and Editor pane: add a chat-launched Scratch/Uploads viewer as a temporary overlay over only the Editor pane, beside the still-usable chat. Block Editor tab switching until it closes, then reveal the same underlying document. Never create resource tabs. Chat-focused viewing belongs in its future right sidebar. Include intake controls there, not in the main document tree. Deferred by the writer; not implemented in this change. GitHub issue publication needs approval.
