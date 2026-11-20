# Suggestion review

The draft review's reading half (`features/draft-review/AGENTS.md`): the review's
changes read from the host's Live editor (`useSuggestionChanges`, `host-editor.ts`), and the
press commands for documents, folders and Works (`usePressCommands`).

## Not covered yet

- A press Apply is in each open editor's history but not on the sidebar's Undo stack: Ctrl+Z in
  the Changes list does nothing after Apply all. Its seat's `push` is empty.
- The review never reads as failed: an editor that never syncs (a refused room, lost access)
  leaves the band and sheet loading; nothing says "Changes couldn't load" or offers Retry.
- A socket admitted to a Work-only document's room keeps its draft target after the document is
  applied into Live: a later change to that Work (archived) re-checks the old target and can
  close or freeze the tab until it reconnects (`lib/yjs-ws-handler.ts`).
