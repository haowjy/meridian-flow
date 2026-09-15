# Context browser TODO

- `ContextViewer.tsx`: replace the minimal empty state with an explicit recent-document list. Recents are offered for user selection, never auto-opened on mount or screen entry.
- Chat frame and Editor pane: add a chat-launched Scratch/Uploads viewer as a temporary overlay over only the Editor pane, beside the still-usable chat. Block Editor tab switching until it closes, then reveal the same underlying document. Never create resource tabs. Chat-focused viewing belongs in its future right sidebar. Include intake controls there, not in the main document tree. Deferred by the writer; not implemented in this change. GitHub issue publication needs approval.
