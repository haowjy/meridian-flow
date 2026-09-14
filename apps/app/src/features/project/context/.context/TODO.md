# Context browser TODO

- `ContextViewer.tsx`: replace the minimal empty state with an explicit recent-document list. Recents are offered for user selection, never auto-opened on mount or screen entry.
- Chat frame and Editor pane: add a chat-launched Scratch/Uploads viewer as a temporary overlay over only the Editor pane, beside the still-usable chat. Block Editor tab switching until it closes, then reveal the same underlying document. Never create resource tabs. Chat-focused viewing belongs in its future right sidebar. Include intake controls there, not in the main document tree. Deferred by the writer; not implemented in this change. GitHub issue publication needs approval.

- `account-feature-lifetime.ts`, `context-identity-mutation.ts`, `untitled-reconciler-browser.ts` and create/delete callers (#480/#270): complete durable namespace operation/receipt ownership in the resource journal before old-writer handoff. A promise drain cannot recover an HTTP receipt arriving after authority versionchange. Preserve pending local/session effects; delete displaced owners during the sole-owner cutover. Do not drain the reconciler's content-sync waits.
