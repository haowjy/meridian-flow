# Presented documents and Editor lifecycle

Reference detail for how the Editor presents documents in this browser tab: hosts, removals
and draft-only presentation. Read
[CONTEXT.md](CONTEXT.md) for the feature-level contracts first.

## Tree projection

Every tree, picker and reference browser projects from the project's replay (`useProjectTreeViews`,
`useProjectTrees`; see [CONTEXT.md](CONTEXT.md), Tree ownership). There is no second copy of
placement and no catalog to acquire: a create, rename, move or delete the writer makes shows in
every view at once, and an offline one stays in the copy until the connection returns.

Whether a document is still there is the project's list's answer, not a lookup: `ProjectStandings`
reads the list's replay for a document and says it is in the tree, in Trash, purged, not in the
list, or waiting for the list (an absence is not an answer until the list has been read). The
removal observer (`list-removal-observer.ts`), the editor and the route all
read it, so nothing is polled and nothing is stamped with a generation. A document that leaves the
live tree closes its views; one that comes back is let back. The
removal's effect on views is applied by
`ContextRemovalCoordinator.applyRemovals`; the route follows the replay itself.

`useFileSuggestions` projects directly from the normalized scope views. It
never walks or caches a second recursive tree and never adds a server-search path; hosts constrain
schemes and file/directory kinds, then mount the presentation-only list.

Desktop scheme/query orchestration lives in `useContextTree` (`ContextTreePanel.tsx`): one
source's rows from its top or from a folder (`rootPath`, as the Agents tab shows `~/.agents/`),
rendered by `ContextTreeBody`. `ContextTreePanel` is that plus the pane's heading and search;
the Agents tab stacks two of them. `ContextTreeRows`
selects each expanded row's direct children by stable parent ID through one
scheme-scoped environment. Mobile renders one level at a time via route params.

## Presented documents

The writer-facing destination is **Editor**. `ContextRemovalCoordinator` owns
the effect of a removal on presented documents from what the list says;
route continuity is the route's (the history entry's remembered id, `ReadableProjectRoute`). The account's document sessions (`core/editor/local-document-copies.ts`) independently
own content durability. Neither owns the other's state.

New appends a provisional `create` in Unfiled and opens the node by the name the replay gives
it, before the server has heard of it; its text room connects once the create is admitted and is
retried while it is not (`4211`). On Draft a create (New, a tree's New file, a link's Create) makes
the Work's text draft at its admission, which only the server can name, so the page opens on that
draft once the Work's list has the item (`useOpenCreatedDocument` in `review-launch.tsx`) and the
new row shows in the tree meanwhile. Leaving main removes only browser-local presentation. It never
deletes the document.

Nothing persists open documents: main shows the document its address names, the side shows
the project's current chat or document, and the newest document shown that is off screen stays mounted
hidden (`kept`) until a close, a Discard or a removal forgets it. Each browser tab/window presents independently. Accepted navigation commits browser history in one prepared operation.
Returning to an empty Editor does not restore a closed document.

`OpenDocumentSessionBoundary` opens the ordinary live binding (`useLiveDocumentBinding`: open,
bind, explicit retry). `ProjectDocumentLiveOpener.open` asks the list's standing for the document
(`ProjectStandings`), so a document made here, before the server has heard of it, opens at once:
the session paints from the browser's local copy and its room connects when the server has the
`create` (the room closes non-terminally, `4211`, until then). The binding presents the live
session in place of the cached one, and shows the session's own connection state. A failed binding
offers Retry; the phone's document host (`DocumentHost`, phone presentation) uses the same binding.

A document that exists only in a Work (a new document the Work created) opens in its Live room
like any other: its text is plain Live text, and the project's list doesn't have it, so the host
admits it as the Work's (`workOnly`, from the pin's row saying `isNew`) and the room gateway
admits the room for that Work. Both shells find the document through `route-document-owner.ts`:
the bound identity in the live tree, then the document the answered address names
(`addressedDocument`, built from the address's draft row when live lacks it), before any path
occupant. A plain path never settles on a Work-only document; only its address with `owner` and
`item` reaches it. Once Apply makes it live, the same room stays open.

## Editor versus chat resources

Editor trees list project document schemes, plus the picked named Work's
Scratch as a sidebar source. Scratch documents open in main from there, from
links and from a chat's Files menu, owned by their Work or, for a No Work chat,
by their lineage; a Scratch crumb links nowhere. Uploads remain storage and
reference/tool resources; their direct URLs show the viewing-not-available state.

Eligibility is enforced at live transitions, including bootstrap,
adoption and availability updates. Hiding a row alone must not leave an
ineligible document available.

A removed document empties its view and nothing else moves. Neither the
planner nor the coordinator picks a neighbouring document or repairs the address: a trash,
a lost access or a document that was never there leaves the address as written, and
the route says "unavailable" there. Addresses resolve from the tree list's replay, so a removal
and a restore show in the answer as soon as the list has them, with nothing cached to rewrite.
A document a draft still holds (a host presents it draft-only, or a pinned draft is bound to it)
keeps painting: a draft held over a document deleted live, and admission has nothing to install
for it. A chapter the writer deleted while its draft was under review opens as the draft from its
review address, read in the Work's tree.

Every editable document keeps `OpenDocumentSessionBoundary` as the same React ancestor, so a
rename or move (the replay changing) does not remount the editor. Close releases the content
lease; a host leaving the screen does not close registry transport retained for the presented
documents.

## Tree observation

Composite UI consumers use `useProjectTreeViews` once for their scheme set. It cuts the session's
replay to each scheme's source, so a view is rebuilt when the list's version changes and not for
unrelated renders. The Editor sidebar derives its schemes from the project and account lists; link
suggestions derive six, including the current Work/no-Work scope. Collapsed sidebar sections stay
mounted.

### Removed documents

A presented document that something else deleted or discarded closes, and nothing is said: no
sentence, chip or toast names who removed it. Who deleted a document is a fact only where the
writer opened a list of them (the Trash row, `TrashedDocument.tsx`).
Two owners:

- **The list's standing.** `ProjectStandings.standing(projectId, documentId)` reads the replay of
  the project's list (and the account's, for `user://`): `in-tree`, `in-trash`, `purged`,
  `not-in-list`, or `waiting` until the list has been read. Nothing is polled and nothing is
  stamped. `useRemovalAnswer` is the React reader: `SessionEditor` and the reopened review address.
- **The observer.** `observeListRemovals` (`list-removal-observer.ts`, mounted per project by
  `ProjectContextRemovalController`) watches the documents the app holds (views, account recents,
  retained sessions) and applies what the list says as one batch through
  `ContextRemovalCoordinator.applyRemovals`: a document in Trash or purged closes its views and
  leaves the recents, one back in the tree is let back, and when main shows a document that went
  to Trash main opens its Trash view (who deleted it, Restore). A purged document's local copy is
  deleted (Trash retention and a Work's purge both write the `purge` record, so the list is the one
  source of it), and so is the copy of a document whose source ended (Work or chat deleted; an archived
  Work's source stays) or whose project the account lost (`denied`).

The writer's own removal sends main back: the tree delete and a Discard of a
created (draft-only) document begin through the removal coordinator
(`beginOwnRemoval`) before the request. If main shows one of
the removed documents, `beginOwnRemoval` also sends main back at once, before
the removal lands: to the document main showed before it, read from Recently
opened (this browser's record, merged with other devices' opens from the
server; the entry after it in opening order that still exists and is not
being removed; a draft-only page is never recorded, so main never goes back
to one), else to Recently opened itself (the bare Editor). The open replaces
the history entry, so Back skips the removed document. A removal by someone
else, from another device, or a remote Discard keeps the address on the
removed document. A tree delete's notice has an Undo (`entry-failure.ts`); a created
document's Discard has the press's Undo (in the tab that pressed); a restore from Trash never moves main. A Discard of an existing
document's edits removes nothing. Discard is a server command, not a record the browser writes.

A page only a draft holds closes the same way when it leaves that draft for Live, which lacks it
(design §6): the toggle or the version chip moving to Live, or `Delete draft` on its draft. The
route sees the pin drop on a draft-only address and calls the coordinator's `leaveDraftOnly`
instead of writing the bare address; main goes back as above and the page's tab closes once main
has left. When main isn't leaving (its presented document lags the address), the route writes the
bare address after all, which shows "Only in draft". `Delete draft` begins it itself, so its notice
follows main (`notices.landed`). One hook, `useDraftOnly`, decides "draft-only" for the route, the
chip and `Delete draft`: the row is new and no live tree has the document, so a chapter another
tab applied, whose list hasn't refetched, isn't closed. The
document's chip offers no `Live` there. A Work switch is not a move to Live: the page stays pinned
to its draft. A bare Live address that still reaches such a page (a reload, another tab, a stripped
link) shows "Only in draft" with `Open draft` when the scope's draft list, which the route already
holds, has it (`draftOnlyAt`); otherwise "This destination is unavailable".

A document in Trash still takes text: the live room admits it until its node is purged and
closes (`4208`) at the purge. Typing into a document someone else deleted is saved into it, and a
restore brings it back. A host still open on a purged room says nothing (`SyncStatus`).

Reopening a review address whose document was removed shows what the removal left: a Discard's
notice with its Undo, or an uncreated document's words (item key parsed by
`@meridian/contracts`' `parseDraftItemKey`); otherwise "This destination is unavailable", as a plain
path address does: once nothing lives at the path it names no document, and finding the newest
tombstone at a path belongs to a later track.

Unsent text is kept: a delete closes the view, but the session and its local copy stay until the
unsent edits are acknowledged; only a purge, an ended source, a lost project or sign-out deletes the
copy (`local-document-copies.ts`).

### Multi-Work review representations

A presented document carries no review state. Which Work's view a document shows is its view's
pin. Whether it exists only in that Work comes from the pin's row in the owner's draft list
(`useDocumentLiveness`: a drafted create, or a delete Live made): such a page offers Close where
others offer Back to live. A live delete of a document closes its view like any removal; a
draft's fork of it stays and comes back with a Restore.
