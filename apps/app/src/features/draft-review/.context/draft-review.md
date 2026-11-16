# Draft review runtime

Review is a projection of the document's own text, not a server-vended operation list. The
shared [kernel model](../../../../../../packages/agent-edit/.context/diff-review.md)
owns diffing, grouping, move pairing and formatting context.

## One room, one runtime

`useRoomBindings` publishes lifecycle changes, not text frames, and `useRoomReviews`
subscribes to the runtimes, so frames stay out of queued React state. Open reviews and
headless readers share the runtime by session object, so a replacement account or
session can't inherit another room's frame. Metadata effect keys hold only address
strings and metadata revision/status/error, never the caller's object: presentation
focus carries a whole projection, and structural typing doesn't strip those fields.

Headless reads retain unchanged ProseMirror nodes using the binding's Yjs mapping
invalidation, exported by the scoped y-tiptap patch. Another attached editor receives
positions only if its full content agrees. A schema replacement disposes the old base
reader while frozen frames keep their immutable nodes. Removal widgets never enter
either Yjs fragment.

`review-runtime.ts` caches base blocks per schema. Keystrokes project after a 120 ms
trailing debounce; peer writes and base changes coalesce into a microtask, after
Yjs/editor bindings have settled. The painter maps existing marks while the next frame
waits. A binding's whole-root PM replacement uses the actual content-diff map, not its
whole-document step map, and fully erased ranges retire rather than expanding inclusive
marks across the replacement. Any Yjs update invalidates the captured cut, including
root-only changes. Ready requires first room sync: cached changes alone are not
authority to Discard.

## Commands and attribution

- The base provider receives the room and schema and isn't called per keystroke.
- Every displayed group carries its immutable `frame`. Command callbacks get that frame,
  not a later read of the runtime, and the owner validates it before interpreting
  projection-local ids.
- An absent attribution entry is explicitly unknown, so candidate chat rows stay visible
  without a byline. `room-attribution.ts` fetches on unresolved clock-range changes,
  Apply/restoration root revisions and reconnect, not text-frame identity. Local
  deletion witnesses cover unacknowledged typing.
- The controller keeps focus intent as a group id and immutable frame. A new projection
  invalidates it, and each leaf derives the first remaining group without writing a
  fresh frame back through the project scope. Header Apply eligibility comes from that
  leaf, and a click reads the painter's current frame synchronously. Same-entry URL
  replacements disable router scroll restoration so the editor owns the jump.
- "No changes left" shows once the item has no tree line either: focus and the stepper
  walk only text changes, so a text-only Discard can leave Discard draft and Apply draft
  beside the Work notice. Only the close contract can end the draft room or send the
  editor to live.

`useReviewRefresh` discovers from semantic membership (any differences, pending
owner-thread ids, unknown attribution), so a new frame with the same membership doesn't
refetch the Work. A semantic change schedules only after its captured room cut is
acknowledged, so a slow append can't leave a first change absent from the server list.
That wait gates background discovery only. The pending timer belongs to the review
identity, so rebinding an editor can't drop it.

## Lifecycle boundaries

Presentation state retains selection, focus, marks and `shown`, not room readiness.
Cached active metadata keeps its room mounted after a metadata refetch failure.

A draft-only document is presented by the hosts that mount it
(`DraftOnlyPresentations`, one token per mount) and, after a live delete, by a hold for
the draft its view pins; closing its review is not Discard. List omission alone can't
infer Discard or Apply: the list omits an active draft with no effect (a delete's held
document, a fully applied draft, one inside the `has_effect` lag). So
`DraftOnlySettlement` promotes an unlisted presentation when a fresh catalog read shows
its document, and ends it only on that same presentation's answer: its draft metadata
says `gone`, or the view no longer pins that draft (a Discard of the last change, which
leaves the draft active and empty). The scope's draft of the document, if any, takes
over; otherwise the document closes.

Closure belongs to a draft generation, not its item key. The key (branch + document)
outlives its drafts: a later write to the same document mints a new draft under the same
key. The command owner keeps each draft's record under its draft id, and an item follows
its newest known generation, advanced by `bind` and `reconcileClosed`, never by a close.
A close retires the generation it was issued for, so a late answer about the old draft
can't close a newer one.

While the item's known draft is closed, or this tab's Discard hid it, the review address port
and the route's address clearing ask the server first (`reconcileClosed`), with a read that goes
to the server rather than joining the cached query (a restore's invalidation would cancel it).
`gone` or a failed read refuse admission, because the room owner just ended that review and
admitting it again would loop; the same draft active again, read after the end, is a restore,
which reopens it (`metadataActive`) whether or not any surface holds its room; a different
active draft is the replacement. While a Discard is still in flight the port refuses the item
outright for the same reason; the end of the hide is a new port, so a refused Discard restores
the review. `useReviewAdmission` (one per document host) remembers a refusal only for the port
that gave it, so a replacement that becomes known later is retried once.

The server answers `gone` from the Work's ownership and the item key alone, before any
content grant: the active draft is what grants reading a document deleted live or a
hidden creation, so after a Discard on another device a content check would answer 404
forever.

## Account command lifetime

`AccountFeatureLifetime.draftCommands` is shared by editor, chat and Work surfaces. One
`ApplyClickQueue` per item key holds its text, tree and text+tree clicks, so a tree cut
waits behind the text clicks before it. Draft rooms are resources the item attaches:
`bind(ref, session)` installs a replaceable session binding on that draft's room. A text
click names its draft (`body.draftId`), and only that room records it, folds it, holds a
reader for it (following replacement sessions even without a surface) and cancels it on
close, so a newer draft under the same key can't inherit an old click. Retiring a
session refuses only its draft's unsent clicks.

`apply` with the draft's room ready in this tab synchronously freezes the `draftId`, Yjs
snapshot, reviewed base blocks, selected ids, the result of applying those groups and one
room-base-to-O delta. Its acknowledgement barrier waits for the server to acknowledge every
local update in the cut before sending. The queue keeps its own `readDraftRoom` lease until
terminal. With no room ready, a whole-draft target (`{kind: "draft", draftId}`, the list's id)
sends a whole cut instead (`captureOnReceipt`): the server applies every change its copy of the
draft holds on receipt. That click has no optimistic base and no room to record it (`frozenOn`
is false), so it settles on the server's answer; its row hides until then, and the commands
drop what it took from the cached list (`dropTaken`). An editor on the draft meanwhile leaves
inline review (the item is `hidden`, `useReviewRoomOwner`) and its Apply waits on the pending
command, so no frozen click can follow the whole cut onto the same changes. A draft with no
change on receipt comes back in the answer's `skipped` (`CommandOutcome.skipped`): that item
shows no Applied notice and joins no Undo step, and a command that applied nothing has neither.
Changes holds no room: its rows, their "N text changes" (`textChanges`, counted by the server's
draft-effect projection, which wakes the list's owner when the number moves) and Apply all read
the list alone.

An Apply of several items (Apply all in Changes or the dock, a folder's ✓) is one command,
so one Un-Apply takes it all back (`applyGroup`, `group-apply.ts`). Every document's click is
made in the click's event turn and joins its own FIFO as a member sharing the command's id;
the member's send hands its click to the group, and the group posts `ApplyItemsClick` once
every member reached its queue's head, so each text cut lands after that document's earlier
clicks. A member that ends unsent (closed draft, unread room) is left out; a drop before the
group is sealed decides nothing. A folder is a member too: a tree cut in its own item's queue
under `folderKey(branchId, folderId)`, so a folder-only command has the same pending, refused
and unknown-delivery states, shown on the folder row with Retry, as a document's. Its cut is the
list response's `folders[].revision`, read once when the command first goes, so a resend
carries the same body; folders lead the items. Every member's queue settles from the one answer,
`conflict` included, and the group's answer, which makes the Undo step and the notice, is the
first a sent member settles on: the post's, a Retry's, or a closed queue's lookup (a queue
refuses an unsent click itself, under the group's id, and that refusal is not the command's); groups are enqueued in item order in one turn, so two groups never wait on
each other. A sidebar Undo step mints its Un-Apply id once, so a press after a lost answer resends
the same id.

An editor text Apply gives that editor's history the Undo and Redo callbacks of the
schedule-owned command handle. The handle owns command identity, reversal outcome and
replay selection; the mounted history owns only navigation. Undo moves the history cursor
synchronously, cancels an unsent Apply, or queues a projected Un-Apply intent. The
schedule retries the targeted Apply before the inverse when its delivery is unknown and
withholds later commands behind any stalled intent. The Un-Apply goes when either half of
the Apply landed: a landed rename with settled text still has something to take back. Redo
queues a new Apply for the text groups the server actually reversed, and the tree cut when
the Un-Apply's `treeUndone` names the item.

Existence of a deleted document is its own fact, never read from a name conflict.
An Apply brings a deleted document back to land what the click carries for it: the click
carries no `restore`, and the item's answer says `restored`. The question a
strip or Apply all asks first (it names the deletes and restores) is the writer's
heads-up, not a precondition. The account owner keeps the answer's `restored` and `renamed`
facts, so an editor Apply keeps its result after navigation.

An Apply never answers refused. The answer is `applied` with one entry per item in `items`,
each half `landed` or settled with lines (`itemOf`). `outcomeOf` reads them: an item with a
landed half is `done` (an Undo step and the applied facts) and carries every line of both
halves beside it, so a landed delete with a left-out rename reads as applied, with the line;
an item with neither half landed is `settled`. Every `overtaken` or `left_out` line, with its
half and the command that overtook it, becomes the item's `apply-left-out` state
(`overtaken_discarded`, `overtaken_removed`, `left_out_<why>`), and the surfaces show one
sentence per distinct reason: as a note (`InlineErrorRow`'s `note`) when the other half landed,
as an error when neither did. `already` and `restored` are quiet. `viewOf` is the one place a settlement line becomes what
is shown, a closed owner's `returned` included; `settledOf` gives every line of a flat answer
(Discard, Restore, Un-Apply) that names an item. A click whose room cannot acknowledge it
settles `unsent` on the client. The press sends `saw`, the cut the cached draft list came
with, frozen with the click; a 503 (the server lacks something the press saw) is an unknown
delivery the queue retries with the same id. An Apply goes on the Undo stack only when an
item landed, and a press of its step that reached the server is spent: `already` or nothing
taken back never falls through to the next older step.

A Discard never refuses either, and its answer is read per item the same way (`discardAnswer`
in `draft-command-owner.ts`): an item it took, or one an earlier Discard took (`already`, quiet),
leaves review, a created document's tab closing either way. The outcome carries what the answer
says of the items sent (`took`: the ones it didn't take, and of those the ones an Apply took
first), and the notice lists only what it took (`DraftNotices.answered`): its struck rows and its
Undo are the answer's, never the press's. An item an Apply took first says "Applied first" where
the writer pressed: on its row while the list draws it, else as the chip a bounce shows (the
Changes bar, the strip, the band, or the change card pressed, where a closed owner's bounce
goes) when the Discard took nothing else. A move's Discard that also writes its own text is two
shares of the notice, the room's and the server's, and only the server's answer narrows. The command is `done`,
with its Undo, when it took any item, and `settled` when it took none. An Apply's Undo step
holds the nodes its answer says landed, not the ones pressed.

`ApplyClickQueue` holds one head, with same-body retries at 1/2/4 seconds, then an item
Retry. A timeout is not one of those failures: the Apply and Un-Apply requests
(`postCommand` in `branches-api.ts`) resend under the same id after a timeout and while the
server answers `running`, so a large Apply stays `Applying` until its answer instead of
stalling. Changes shows one "Applying" line while rows are hidden by an Apply in flight, and
hides a folder whose own cut is in flight once nothing under it is listed. Transient disconnects keep acknowledgement barriers pending. Each click has two
independent duties:

- *Release* (the head leaves the FIFO and its optimistic contribution ends) happens once:
  on the room's record or a terminal answer. The queue knows its item's node and reads its
  own entry: an answer whose entry says this item's text landed waits for the record, and one
  whose text was settled is final, whatever a sibling in the same command landed.
- *Completion* (the caller's outcome) comes from the full answer, which alone carries
  `restored`. When the answer is missing or lost, the queue reads the stored result back
  under the same command id, never a resend, at 0/1/2/4 seconds. Exhausted reads complete
  as `landed`, with `restored` unknown.

A closed owner (an archived or deleted Work, or a chat in Trash) locks nothing: Apply and Un-Apply land and
leave the Work closed. A Discard, Discard all, a folder's ×, a change's Discard and an Undo of a Discard come
back on their own: the server answers `done` with a settled `returned { why }` (`work_archived`, `work_deleted`,
`chat_frozen`) and changes nothing. `returnedOf` reads `settled`, never the status, into the `returned` words the
Undo already uses (`work-closed`, `chat-in-trash`); the owner's outcome is `returned`, and `bounced` in the command
hook is the one place that makes it a notice (`showBounce`, a `discarded` notice with status `bounced`) and reads the
Works list again. The notice is a chip ("Work was closed", "Its chat is in Trash") in the trailing slot of the
control pressed, for 6 s, with the full sentence on hover, focus or long press: a Changes row's notice slot (a
folder's ×: the folder's row; Discard all: the bar's), the strip's first line, the document band, a change card's own row (one press, one chip, on the card pressed). It adds no line,
so `hasLine` is false for it. A change's Discard in a closed Work writes in a room the server admits read-only;
`startDraftDiscardSession` returns `returned` there, with the word for the room's `closedWhy`, instead of a
`read_only` refusal. The room names `closedWhy` itself: a `read_only` stateless message after every read admission (`why` only for a closed owner), or the 4409 close's reason; the client infers none. A read admission, and any 4409 that names no reason, holds `reasonPending` (so the review is not `ready`, and the controls show their loading state) until its message arrives, and a known reason survives the reconnect meanwhile. A Discard's deferred write answers from the room only once it is settled read-only; while the reason is pending it writes at once, as an offline press does, and the next admission decides. A created document's Discard closes its tab only after `done`, so a returned answer's chip has a band to show on. A returned Undo of a Discard is the same word on its
notice, Trash's row and the editor's pill. Other refusals still move prose in two cases, open in
[#992](https://github.com/haowjy/meridian-flow/issues/992). No queue or optimistic base
persists. The room owner observes only hidden/closed lifecycle transitions. Rendering
leaves subscribe to command records; command callbacks and the project controller don't.

The base provider folds `applyBase` over the schedule's unresolved Apply, Un-Apply and
Redo intents in delivery order. A pending Un-Apply folds its effect backward until removal
of the targeted group records is observed, because an HTTP answer alone could flash the
applied state back. Failure removes that fold and restores the history action at its
chronological position. Group targets have to describe equal base and prose at capture; a
changed projection is refreshed and reported locally, never reinterpreted by its old
occurrence suffix.

## Discard

`discard(ref, target, history)` composes against the optimistic base and calls
`writeDiscardBlocks` in one transaction with an origin of its own, so the write is one
`StackItem`. `history` is the issuing host's own editor (the controller's `reviewEditor`), or
`notice` for a surface with no editor; the room's runtime may list more than one attached
editor, so the session never picks one. Either way the session returns one Undo handle, which
the owner's notice holds. Editor Discard is synchronous.

### Notices

`DraftNotices` (owned by `DraftCommandOwner`, so account-lived) holds one notice per draft
owner key: the latest Discard with its Undo, or the latest Apply's facts. The writer's tree
deletes use the same line under a per-project key (`deleteNoticeKey`), only off the sidebar: on
main's band or Recently opened (`landing`); the sidebar's rows carry their own (see the context
tree's interactions page). A page whose document a Discard took away
(a Work's new document) shows the Discard's notice, Undo included, while it holds the document
(`discarding`); after that it says the document was discarded from the draft. A newer Apply or
Discard by the owner replaces it; only a bounced one (below) has a timer; a reload starts empty. Each notice records
the surface it was made on (Changes list, a chat's strip, a document's band) and shows only
there. In the Changes list a notice is said on its rows, never as a line (`useDraftNoticeWords`,
`RowWord`): every row a Discard took stays struck through with Undo, in the place the list
showed it when the writer pressed (the list is held at the press, per owner, so a switch of list
keeps it), and every document an Apply took keeps its row with "Undo" (`AppliedFact.step`): the
sentence says it was applied, with where it is now (read by id from the tree, the removal sentence once it is in Trash or purged), the name a clash gave it or that it came back
to the manuscript, and the Undo is the Apply's step on the sidebar's Undo stack, the one Ctrl+Z
takes (`undoApply`; an Apply all's rows each take back the whole step). Whatever the Un-Apply
answers ends the applied notice, so its result shows on the rows as a press's does: nothing, when it
took everything back; "Partly undone" or "Not undone", when a tree change stayed because it was
changed since or has writing in it since (`unappliedOf`, in `draft-notices.ts`, the one reading of an Un-Apply answer); "Retry", when it
didn't reach the server. The first row an Apply took gets the focus its ✓ or Apply all had. A band notice shows on that document's review line (above the toolbar, in place of the
review controls a whole-draft Discard removed; the phone's review header gives it a row), or on
the review line of the document main went back to, or, when main went to Recently opened, in that landing's top slot (above a
removed-documents notice). Only the document's name shortens in a notice; its verb and Undo
always show. Focus stays on the surface where the writer pressed: each surface (review line,
phone review header, Changes list, strip) wraps its notice and controls in one
`useFocusSuccession` container, so a Discard's focus goes to the notice's Undo and an Undo's to
the controls that come back (the Changes list prefers the restored row). If the writer moved
before the go-back resolved, the notice ends. Apply
facts from a band stay out of the store: the identity row shows them from the owner's per-document
facts (`useManuscriptState`). Discard all is one notice and one server command. A room's Undo is done
once the prose is back in the room, which sends it whenever it can: the notice ends and the row
returns at once, offline too. This path does not re-read the owner list, and the view does not
follow back to the draft, until the server lists the draft again (`relistedOwnerDraft`, polled
after the acknowledgement): the list omits a draft until the server re-judges its effect, about 250 ms
after the write, and a read before then drops the row. Following sooner opened a draft-only page
on a draft the list omitted: `verifyPin` dropped the view's pin and `DraftOnlySettlement` closed
the page as discarded ("This destination is unavailable"). If the server never lists it within
the retries, main stays where it is. A room that turned read-only (its Work archived) ends the notice. An Undo
that throws keeps the notice with Retry, and Retry takes back only the rooms that failed.

A notice's Undo holds while the draft's prose is as the Discard left it. Any other transaction on
the `prosemirror` fragment (writer typing, a model write), the room closing or resetting
(`binding.notices`), or Ctrl+Z popping the item from the reviewing editor ends it silently. So
the notice and Ctrl+Z can never undo the same Discard twice. While the reviewing editor lives and
the item is on top of its stack, the notice's Undo is that editor's Undo; once the editor is gone
the item is undone alone through a short-lived manager.
Both paths record restorations, so marks after an Undo match marks before the Discard. Each Undo
handle holds a room lease and entry user until it ends, so one notice per owner bounds the rooms
kept open; `DraftCommandOwner.close()` ends every notice.

A whole-draft Discard (always a server command) on a draft-only page (live deleted it elsewhere)
sends main back through `ContextRemovalCoordinator.beginOwnRemoval` once the Discard is written,
so a refused Discard leaves main on the page that shows the refusal; the go-back reports where
main landed, and an Undo while main is still there returns it to the draft's review address.
While that go-back runs, the coordinator's `discardDraft` leaves the page alone, so a slow open
of the previous document doesn't let `DraftOnlySettlement` close it first and end the notice.

Chat-strip and Work Discard publish their notice and a projection-scoped `discarding` target first, so the row
and notice paint before the indivisible write-back. Hidden pages drain on visibility
change rather than waiting for animation frames. Changed base or prose refuses the stale
write and restores the row.

Direct writes never impersonate the binding origin: its delete-only transactions without a
writer ProseMirror transaction are schema-repair evidence. The draft-only editor plugin
installs restoration recording when its view mounts, before any writer Undo/Redo; live
editors never install it. A side or Work notice owns a separate manager and pool lease.
The notice
belongs to its exact session binding, so replacement documents never inherit the manager.

What a closed draft does on screen follows what closed it (`ended`, Draft end and reopen in
[state-machines.md](state-machines.md)), never which message arrived first. A Discard made
anywhere but in this tab (`in-trash`), or its document going to Trash (`document`, an Apply of a
delete included), keeps the draft on screen: the review keeps its room's session read-only, the
route keeps its address, and the page keeps painting it while the list no longer has it
(`useDocumentPaint`, until the writer chooses another version). The editor's status pill says
"This draft is in Trash" with the Discard's Restore, or "This document is in Trash" with the
document's (`InTrashStatus`). This tab's own Discard (`here`) leaves for Live, where its notice
has the Undo; any other close (`other`, a purge) leaves too. Restore, the notice's Undo and Trash's
Restore send the one `restoreDiscard`; every tab learns of it from fresh draft metadata (the
owner hint re-reads it), and `metadataActive` clears what the tab held as ended and lets the
room join again under the same id: the session on screen rejoins in place, and every reader whose
read of the room failed while it was closed asks again, whichever reader brought the answer. While closed, the
review keeps the room its metadata last named (`useRoomBindings`), and the band and change
bars offer nothing to act on (`useOpenReviewChanges` reads `gone`).

Every Discard of a whole draft is a server command under an id the client mints, so Trash
lists it and Restore brings it back: one document's draft as an item Discard
(`discardOnServer`, everything the branch holds on the document), a move or delete as
`discardItem`. Only a Discard of some changes in a read frame is a local text Discard, whose
Undo the room holds. Every Discard shows the owner's notice, and its Undo takes back each share:
a room's text locally, a server Discard by Undo of a Discard (`restoreDiscard`, both halves onto
the Work's current branch), the one command Trash's Restore and the editor's Restore send too.
Each Discard's restore has one progress, whatever sent it (`DiscardRestores` on the command
owner): the notice, Trash's row and the editor's pill all read it, so a restore from Trash ends
the notice, and a notice's refused Undo clears once a later restore lands. `leftOut` stays on the
notice as what couldn't come back, and a restore answered with nothing done says why ("Work was
closed.", "Its chat is in Trash.", "Gone from Trash."). No Discard asks first. A Discard row Trash shows restored has Undo, a new Discard of everything
the entry took: its drafts' documents and every node its tree half settled (`tree.nodes`), so
one that only moved, renamed or deleted goes back too. A Discard of a
selection (a folder group's ×, a folder changed alone) is one server command over exactly those
documents and folders, both halves, with what stands on them (`discardSelection`,
`BranchDiscardRequest.items`); only Discard all sends `all`, the one command that closes the
branch. Neither falls back to the other. A Discard never reports success for a draft it didn't discard. Their optimistic
visibility is lifecycle state, never text-group hiding. `4205` maps to terminal `closed`,
including in-band code-1000 delivery, and `4208` to `removed`.

A frozen owner's drafts go through the server too. A frozen owner is a chat lineage whose
chats are all in Trash. Its rooms admit read-only and drop the writer's text, so a local
revert would show a Discard that never landed. Frozen state comes only from the server:
the owner list's `frozen`, the same `lifecycle` the rooms and commands enforce. A chat's
subagents are not trashed with it, so a lineage with a live subagent is not frozen, and
the thread list can't tell. The list re-reads on the `draft-owner-hint` that trash and
restore publish, and when a review room's access disagrees with the host's `readOnly`.

While frozen:
- the review's editor is read-only under `TrashedChatNotice` (`useDocumentFreeze`, the
  archived Work's path);
- single changes are locked and Apply is hidden;
- Discard draft, and the chat strip's Discard, is the server's whole-item Discard
  (`ends: "item"`), move or delete included. The item stays in review, `discarding`, until the
  answer, so a return shows on it. A chat restored on another device and written to since
  still discards, and Undo brings the text back.

A local revert checks its room's access when it writes. A room the server already admits
read-only refuses it (`read_only`) and the list re-reads, so a stale `frozen: false` never
shows a revert the room drops. The freeze itself closes the socket with `ACCESS_CHANGED`,
which marks the room read-only at once. An unacknowledged revert is found at the read admission's
handshake: the room is replaced by one loaded from the server, so the revert's change is back in
the list, and its typing (not a Discard, which has no words) is handed back. Until the Discard's
`returned` answer on replacement lands (it needs the closed-Work notices of never-refuse PR B),
the Discard's local write is simply gone with the old room and shows no chip.

Restore restores the lineage's first chat and thaws only once the list says so. Thawing
first would let the writer type into a room that still drops their text.

A terminal room frame and an authoritative metadata `gone` are two arrivals of the same
fact. For `gone`, the owner resolves the exact document through the availability owner:
available goes to its current live URI, deleted uses the removal flow, and failed reads
never prove closure. It keeps an open room during that lookup for unsent-text recovery.

A draft's metadata is its row in the owner's list when the list holds it: each row carries
its `draftId`, and the room name follows from it, so a review of 200 drafts reads one list,
not 200 addresses (`useDraftMetadata`). The list read is stamped with when it started
(`readAt`), the time its rows speak for, as an addressed read is. A listed answer is stored
as the draft's own answer, so a surface that mounts after the list drops the row still finds
its room, and it reports the list's re-read as its own fetch: when the Work's tree drops a
discarded document before the list answers, the review waits instead of calling the draft
unavailable; a failed re-read shows as an error with Retry. A draft the list doesn't hold (an empty draft, or one it dropped) reads its
address, and an answer older than the list that dropped it counts as being read again: the metadata GET returns the
stable draft id and room name, or authoritative `gone`, which is how an open review learns
its draft ended once the list drops the row. The route keeps this read above editor address
admission, so catalog invalidation can't strand a review after unmounting its room readers.

Each room's authorship evidence (`room-attribution.ts`) goes in one request per owner
(`POST /drafts/provenance`): one is in flight at a time, and the rooms that ask meanwhile go
together in the next, at most `DRAFTS_PROVENANCE_MAX` drafts a request, so the reads stay a
handful whatever the row count, and the server captures every named draft with one query per
kind of fact. A failed read leaves every room in it without evidence (text stays, no byline);
each asks again on its next change or reconnect. The old one-room route
(`…/documents/:documentId/draft/provenance`) answers protocol-3 tabs until they reload; it goes
in the release after this one (#1677).

## Tree lines

An item with a branch row (a creation, move or delete) applies it with a tree cut: the
item's Apply carries `tree: true`, and with no text to send it is the tree cut alone, in
the same item FIFO.

`discardItem` is the item's one Discard when it has a tree line: the server's tree-only
Discard (`ends: "tree"`) beside the local text revert. Its notice's Undo takes back both, so
the text never comes back without its move or delete.

An Apply made in the sidebar or a chat's strip goes on the sidebar's Undo stack as one step
(`rememberApply`, `core/project-tree/tree-undo.ts`): Ctrl+Z there sends Un-Apply by the
command's id, and the press is spent once the server answers, whatever it took back. What it
couldn't take back (text edited since, a tree change named by a `left_out` line) is said on the
rows it stayed on (`unappliedOf`); only a tree step is skipped for the one before it. A band's
Apply has its editor's Undo instead.

Either Apply also enters the Undo history of every live session this tab holds for its
documents (`registry.liveHistory`: a shown editor or an open tab), so Ctrl+Z there takes the
Apply back instead of the writer's typing under it. One entry spans those histories
(`SharedApply`, `apply-history.ts`) for as long as the Apply is in force: Ctrl+Z in any of them
takes back the whole Apply once, and the others hide it. Whenever it comes back into force (a
Redo, an Un-Apply that failed or was refused), every history shows it again at its place, under
what was typed after the Apply and with its Redo kept, and a live history that never had it (a
session opened since) gets it on top. A sidebar or strip Apply's entry is the
step's (`AppliedEntry`): its Ctrl+Z is the step's Un-Apply, its Redo sends the same Apply again
as a new command whose step the entry follows, and an Un-Apply from the sidebar or a notice hides
it in every history until it answers: `unapplied` or `skipped` ends it, `failed` brings it
back. A band's entry (`BandApply`) is its item queue's Un-Apply and Redo while the review's room
shows the draft, so the review shows them at once. The review letting go of the room (Draft view
to Live) doesn't end it, since the Apply is still in force: the queue settles an Un-Apply only by
watching that room, so the entry leaves the queue, with the click it froze, and sends its
Un-Apply and Redo itself, settled by the server's answer alone. Either way an Un-Apply refused,
or one that reversed nothing, ends it, a lost answer brings it back, and the draft ending
(`finishClose`) ends it without asking. Otherwise it lasts until sign-out, when the account's
owner closes.

The move is a row of its own (`tree-line.ts`), listed before the text changes, while a
delete supersedes the text rows. A selection's target says whether the line is in it, so
the line's Apply sends only the tree cut and its Discard keeps the text. `hidden` covers
only a tree click in flight, since a later move of the same document reuses the item key.
