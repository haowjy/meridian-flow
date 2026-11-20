# Suggestion review

Suggestion mode's half of the draft review (`features/draft-review/AGENTS.md`): the review's
changes read from the host's Live editor (`useSuggestionChanges`, `host-editor.ts`), and the
press commands for documents, folders and Works (`usePressCommands`).

The review's list follows the editor's document as a transition (`useEditorDoc`): it redraws a
frame after each keystroke, and a change that reads the same keeps its row object, so typing
never waits on the band, the bar or the Changes list.

A list's text-change counts (`textChanges`) come from the server once it derives the document,
a two-second debounce after each write. While the document is open, the counts read this tab's
editor instead (`usePublishChangeCounts`, `client/query/tab-change-counts.ts`, the same
`pendingChanges` rule the server counts by), so the tab's own Apply, Discard, Undo and typing
show at once.

## Not covered yet

- A press Apply is in each open editor's history but not on the sidebar's Undo stack: Ctrl+Z in
  the Changes list does nothing after Apply all, where a draft's Apply takes it back. Its seat's
  `push` is empty; the draft Apply's seat pushes an `ApplyStep` on the tree list session.
- The review never reads as failed: an editor that never syncs (a refused room, lost access)
  leaves the band and sheet loading, where a draft room's review shows "Changes couldn't load"
  with Retry.
- A socket admitted to a Work-only document's room keeps its draft target after the document is
  applied into Live: a later change to that Work (archived) re-checks the old target and can
  close or freeze the tab until it reconnects (`lib/yjs-ws-handler.ts`).
- Whether a document is listed at all still waits for the server: after the tab applies a
  document's last change, the Work's "to review" count and the Live/Draft label change 3 to 5
  seconds later, when the derivation lists it gone. Row presence drives the pin's end
  (`features/project/views.ts`, `askEnd`), which asks the server, so a row the tab drops on its
  own would be asked about while the server still lists it.
