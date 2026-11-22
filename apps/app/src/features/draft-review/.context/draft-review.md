# Draft review runtime

Phase 1 of the move to Loro has no text drafts: a Work's draft is its tree records (a document or
folder it created, renamed, moved or deleted), and every text write lands Live. Text drafts come
back in phase 2 as fork rooms of the document, and with them per-change review in the editor.

A document, a folder, a selection or the whole Work is pressed: one server command over the items'
tree changes (`usePressCommands`, `POST /api/projects/:id/press`, kinds `press` and `unpress`). The
server answers per item what it took.

## What the review reads

The Changes list, the chat strip and a document's band read the owner's draft list
(`useOwnerDrafts`), which the server derives from the Work's tree records. A move or a delete is
its tree line (`tree-line.ts`); a document the Work created is one whole-item change
(`useOpenReviewChanges`).

The list is re-read when the server wakes the owner (`useProjectWake`), and in each of the
account's tabs when a press or its Undo settles (`press-commands.ts`); both read the same
things (`refreshDraftReads`). A pressed row leaves the
list while the press is in flight (`DraftCommandOwner.hold`) and comes back with a pill if the
press fails. Items never end on their own: a row leaves when a read no longer lists it.

## Account command lifetime

`AccountFeatureLifetime.draftCommands` (`DraftCommandOwner`) is shared by editor, chat and Work
surfaces, and outlives them:

- `hold(itemKeys, applying)` marks items in flight, which hides their rows and leaves their review.
- `presses` holds every press this tab can still take back (`PressEntries`,
  [state-machines.md](state-machines.md)). The sidebar's Undo step, or its row's or notice's
  Undo, sends the press's `unpress`.
- `notices` (`DraftNotices`) holds one notice per draft.

A press is sent through the command driver (`client/query/press-commands.ts`, lane
`press:<owner>`), which resends it under the same id until the server answers. A press that
fails shows a brief pill (`notifyFailure`), never a line in the row or bar pressed. An archived
Work's or a trashed chat's draft takes every press: nothing in the review reads the owner's
lifecycle.

## Discard

Every Discard of a document, a folder, a selection or the Work is one press with
`verdict: "discard"`: it discards the Work's tree changes there
(a document or folder the Work created goes to Trash, an ordinary deleted document there). Trash
has no entry for the rest. Its Undo is the press's `unpress`, as Apply's is (`PressEntries`): the
notice's Undo or the sidebar's Undo step, once between them, in the tab that pressed. Undo puts a created document back where it was before the press:
pending in the Work, out of Trash and Live. Trash's Restore brings it into Live instead; whichever
comes first, the other has nothing left to do. An Apply's Undo takes a created document out of Live too: if main shows it, main reopens it on
its review item (`unpress` in `usePressCommands`), read before the Undo is sent, since main
unmounts the document as soon as Live loses it
([press](../../../../../server/server/domains/collab/.context/press.md#discard-and-what-goes-to-trash)).
After a reload nothing offers the Undo.

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
row's ✓ or × on a tree line sends `half: "tree"`. A document that exists only in the Work is
pending as its drafted create; its text is plain Live text, so Apply makes the create live and
Discard removes it.

**A chat card's Undo** is the server's `reverse_turn` command: it takes back its own reply's
changes. The card holds no Apply entry.

## Not covered yet

- Main follows a created document back to its review item only in the tab that pressed the Undo.
  Another tab or device with it in main shows "This destination is unavailable." until the writer
  opens it from Changes: a Work-only document resolves only through its review item, and nothing
  makes main follow its document when the document leaves Live.
- After a Discard's Undo, main stays where the Discard sent it; the created document is pending
  in Changes.
