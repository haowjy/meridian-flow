# Suggestion review

The draft review's reading half (`features/draft-review/AGENTS.md`): the review's
changes read from the host's Live editor (`useSuggestionChanges`, `host-editor.ts`), and the
press commands for documents, folders and Works (`usePressCommands`).

The review's list follows the editor's document as a transition (`useEditorDoc`): it redraws a
frame after each keystroke, and a change that reads the same keeps its row object, so typing
never waits on the band, the bar or the Changes list.

A Work's rows come from the server once it derives the document, a two-second debounce after
each write: a suggestion row is listed while the Work has changes in the document, with their
count (`textChanges`). While the document is open, its rows follow this tab's editor instead
(`usePublishChangeCounts`, `client/query/tab-change-counts.ts`, the same `pendingChanges` rule
the server counts by): the tab's own Apply, Discard, Undo and typing change the count at once,
the last change applied drops the row, and an Undo lists it again from the row last seen. A pin's
end check (`verifyPin`) reads the rows the same way, so the Live/Draft label follows too. Rows
with more than suggestions (a tree change, a whole item) stay the server's.

## Not covered yet

- The review never reads as failed: an editor that never syncs (a refused room, lost access)
  leaves the band and sheet loading; nothing says "Changes couldn't load" or offers Retry.
- An inline Apply or Discard is a local edit of the tab's Y.Doc, so it can't fail as a press can
  (a press that fails shows "Couldn't apply" and its rows come back). If the tab's copy is later
  dropped unsent (the room refused), the resolve is lost silently: the dropped-copy check
  (`dropWords` in `document-session-registry-implementation.ts`) speaks only for lost words, and a
  resolve adds none.
- A socket admitted to a Work-only document's room keeps its draft target after the document is
  applied into Live: a later change to that Work (archived) re-checks the old target and can
  close or freeze the tab until it reconnects (`lib/yjs-ws-handler.ts`).
