# Draft review runtime

A Work's draft is that Work's suggestion marks (`{id, work}`) in each Live document
(`packages/suggestions`). Review reads them from the editor that shows the document and acts on
them in two ways:

- **One change** (a card's ✓ or ×, a stepper's Apply or Discard) is an editor transaction on the
  Live document (`acceptSuggestion` / `rejectSuggestion`), one entry on that editor's history:
  Ctrl+Z takes it back.
- **A document, a folder, a selection or the whole Work** is a press: one server command over the
  text and tree halves (`usePressCommands`, `POST /api/projects/:id/press`, kinds `press` and
  `unpress`). The server answers per item what it took.

Both feed the same rows, counts, notices and Undo. There are no draft rooms: a review's editor is
the Live editor, opened in the Work's view (`runtime.workView`).

## What the review reads

`useOpenReviewChanges` reads the open document's changes from its host editor
(`useSuggestionRead`, `useSuggestionChanges`, `host-editor.ts`). A change is one run of one suggestion id;
its byline is the suggestion's author. The Changes list, the chat strip and a document's band read
the owner's draft list (`useOwnerDrafts`), which the server derives from the marks and the Work's
tree records; a row with text is listed whole (its count is `textChanges`), and a move or a delete
is its tree line (`tree-line.ts`), listed before the text.

The list is re-read when the server wakes the owner (`useProjectWake`). A pressed row leaves the
list while the press is in flight (`DraftCommandOwner.hold`) and comes back with a pill if the
press fails. Items never end on their own: a row leaves when a read no longer lists it.

The open document's list follows the editor's document as a transition (`useEditorDoc`): it
redraws a frame after each keystroke, and a change that reads the same keeps its row object, so
typing never waits on the band, the bar or the Changes list.

A Work's rows come from the server once it derives the document, a two-second debounce after
each write: a suggestion row is listed while the Work has changes in the document, with their
count (`textChanges`). While the document is open, its rows follow this tab's editor instead
(`usePublishChangeCounts`, `client/query/tab-change-counts.ts`, the same `pendingChanges` rule
the server counts by): the tab's own Apply, Discard, Undo and typing change the count at once,
the last change applied drops the row, and an Undo lists it again from the row last seen. A pin's
end check (`verifyPin`) reads the rows the same way, so the Live/Draft label follows too. Rows
with more than suggestions (a tree change, a whole item) stay the server's.

## Account command lifetime

`AccountFeatureLifetime.draftCommands` (`DraftCommandOwner`) is shared by editor, chat and Work
surfaces, and outlives them:

- `hold(itemKeys, applying)` marks items in flight, which hides their rows and leaves their review.
- `presses` holds every press this tab can still take back (`PressEntries`,
  [state-machines.md](state-machines.md)): one entry in the history of each open editor of its
  documents. Ctrl+Z there, or its row's or notice's Undo, sends the press's `unpress`.
- `notices` (`DraftNotices`) holds one notice per draft.

A press is sent through the command driver (`client/query/press-commands.ts`, lane
`press:<owner>`), which resends it under the same id until the server answers. A press that
fails shows a brief pill (`notifyFailure`), never a line in the row or bar pressed. An archived
Work's or a trashed chat's suggestions take every press and every keystroke: nothing in the review
reads the owner's lifecycle.

## Discard

Every Discard of a document, a folder, a selection or the Work is one press with
`verdict: "discard"`: it rejects the Work's suggestions there and discards the Work's tree changes
(a document or folder the Work created goes to Trash, an ordinary deleted document there). Trash
has no entry for the rest. Its Undo is the press's `unpress`, as Apply's is (`PressEntries`): the
notice's Undo, the sidebar's Undo step or Ctrl+Z in an open editor of its documents, once between
them, in the tab that pressed. Undo, or Trash's Restore, brings a created document back in Live,
not in the Work; whichever comes first, the other has nothing left to do, and the editor's Redo
sends it back to Trash
([press](../../../../../server/server/domains/collab/.context/press.md#discard-and-what-goes-to-trash)).
After a reload nothing offers the Undo, and the writer's own typing in the Work's view that it
rejected is gone. A Discard of
one change in the editor is an editor transaction, undone with Ctrl+Z.

### Notices

`DraftNotices` holds one notice per draft id: the latest Discard with its Undo, or the
latest Apply's facts. The writer's tree deletes use the same line under a per-project key
(`deleteNoticeKey`), only off the sidebar: on main's band or Recently opened. A newer press by
the owner replaces it; a reload starts empty. Each notice records the surface it was made on
(Changes list, a chat's strip, a document's band, a change's card) and shows only there. In the
Changes list a notice is said on its rows (`useDraftNoticeWords`, `RowWord`): a Discard's rows
stay struck through with Undo where the list showed them, and an Apply's rows keep their place
with Undo. Focus stays on the surface pressed: each surface wraps its notice and controls in one
`useFocusSuccession` container. `DraftCommandOwner.close()` ends every notice.

## Tree lines

An item with a draft tree record (a creation, move or delete) is pressed with its tree half: a
row's ✓ or × on a tree line alone sends `half: "tree"` and leaves the text. A delete supersedes
the text rows. A document that exists only in the Work is pending as its drafted create; its
text is plain Live text, so Apply makes the create live and Discard removes it.

**A chat card's Undo** is the server's `reverse_turn` command: it takes back its own reply's
changes, rejecting the suggestions the turn left (`suggestion-turn-undo.ts`). The card holds no
Apply entry.

## Not covered yet

- The review never reads as failed: an editor that never syncs (a refused room, lost access)
  leaves the band and sheet loading; nothing says "Changes couldn't load" or offers Retry.
- An inline Apply or Discard is a local edit of the tab's Y.Doc, so it can't fail as a press can
  (a press that fails shows "Couldn't apply" and its rows come back). If the tab's copy is later
  dropped unsent (the room refused), the resolve is lost silently: the dropped-copy check
  (`dropWords` in `document-session-registry-implementation.ts`) speaks only for lost words, and a
  resolve adds none.
