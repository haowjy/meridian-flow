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
- Every displayed group carries its immutable `frame`, the meaning of the writer's choice: a
  command names its changes by id (`TextTarget`) and, with a room open, reads the room when it
  runs. The draft's base follows Live about 2 s behind, so a click or a Redo meets a newer frame
  than the one on screen, and a command never refuses for that. `readChosen` (`review-frame.ts`)
  maps the ids chosen on `frame` to the frame being read, and Apply, Redo, Discard and `rebuilder`
  all use it: a chosen change goes only when the read has the same change. Identical edits are
  numbered `X`, `X~1` in document order, so one id can name another edit in the other frame.
  Where the two frames' draft blocks are equal (the base lag), an edit is the one over the same
  draft tokens; where their bases are equal, over the same base tokens; otherwise only an edit
  with no repeat in either frame, and the same three base tokens on each side of it in both, is named. A chosen change with no name stays in the draft: an
  Apply says `left_out_not_on_server`, a Discard says `left_out_not_in_draft` ("The draft didn't
  have this change as you saw it, so it wasn't discarded. It's kept in the draft."); a command
  never answers silently.
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
outlives its drafts: a later write to the same document after a purge mints a new draft under the same
key. The command owner keeps each draft's record under its draft id, and an item follows
its newest known generation, advanced by `bind`, never by an end.
A close retires the generation it was issued for, so a late answer about the old draft
can't close a newer one.

While this tab's Discard hid the item's draft, the review address port refuses the item outright
(the end of the hide is a new port, so a refused Discard restores the review). A draft the room owner
ended (its Work or document was purged) is refused admission, because admitting it again would loop.

The server answers `gone` from the Work's ownership and the item key alone, before any
content grant: the active draft is what grants reading a document deleted live or a
hidden creation.

## Account command lifetime

`AccountFeatureLifetime.draftCommands` is shared by editor, chat and Work surfaces. One
`ApplyClickQueue` per item key holds its text, tree and text+tree clicks, so a tree cut
waits behind the text clicks before it. Draft rooms are resources the item attaches:
`bind(ref, session)` installs a replaceable session binding on that draft's room. A text
click names its draft (`body.draftId`), and only that room folds it, holds a
reader for it (following replacement sessions even without a surface) and cancels it on
close, so a newer draft under the same key can't inherit an old click. The client never
refuses a click: when its draft's room ends (reset, terminal, access ended, destroyed) before
the click is sent, the click goes anyway, and the server's answer is the truth
about the draft (closed, archived, applied).


`apply` with the draft's room ready in this tab synchronously freezes the `draftId`, Yjs
snapshot, reviewed base blocks, selected ids, the result of applying those groups and one
room-base-to-O delta. Its acknowledgement barrier waits for the server to acknowledge every
local update in the cut before sending; a room that ends releases it, since it will deliver
nothing more. A whole-draft target then goes as the whole cut below (`wholeCut`), the draft
as the server holds it. Typing the room never delivered stays in this browser's copy of the
draft room and replays into the draft, as a change by You, the next time that room opens. A
whole cut leaves the draft with no changes, so nothing lists it and nothing opens its room: the
typing shows again only when another change comes to that draft.
A click on some changes is built again when it reaches the head of the queue (`rebuilder`): the
draft is read as the server holds it into a fresh document (`readRoomOnce`, one sync, nothing sent),
its review recomputed, and the chosen changes it finds go as an ordinary frozen click from that
read, so the snapshot is the server's exactly. A chosen change goes only when `readChosen`
names it in the read; when the bases differ (another tab applied a change, an earlier click left
part out), a repeated edit stays. Any other chosen change (typing the server never got, an edit changed since
by another client) stays in the draft, shown as `left_out_not_on_server`: a choice is never widened. Nothing left sends nothing.
The read is a request like a send: unanswered in 10 seconds, it closes and is tried again, then
the click settles `unsent`; closing the queue closes it. An Apply pressed after the room ended takes the same path (`captureEnded`); a room the
server won't open (closed, access ended) sends the frame's own cut and the server says why. A room
this build can't open (schema stale or superseded) can't be read either, so the click isn't sent:
it settles `unsent` in the client, freeing the draft's queue, and the press shows the failure pill. The ended room stays bound for its
projection only (`Entry.ended`): its rows fold the click while it runs, as any Apply's do, and
keep folding it once it lands, until a room on the draft holds the write (`at`). No lease opens a room for such a click. A click
whose typing was acknowledged before the room ended goes frozen as it is. Either way a click whose
room ended settles on its answer, and never waits on the server's sync (`unsynced` stays for live
rooms). The queue keeps its own `readDraftRoom` lease until
terminal. With no room ready, a whole-draft target (`{kind: "draft", draftId}`, the list's id)
sends a whole cut instead (`captureOnReceipt`): the server applies every change its copy of the
draft holds on receipt. That click has no optimistic base (`frozenOn` is false), so nothing folds it; its row hides until then, and the commands
drop what it took from the cached list (`dropTaken`). An editor on the draft meanwhile leaves
inline review (the item is `hidden`, `useReviewRoomOwner`) and its Apply waits on the pending
command, so no frozen click can follow the whole cut onto the same changes. A draft with no
change on receipt comes back in the answer's `skipped` (`CommandOutcome.skipped`): that item
shows no Applied notice and joins no Undo step, and a command that applied nothing has neither.
Changes holds no room: its rows, their "N text changes" (`textChanges`, counted by the server's
draft-effect projection, which wakes the list's owner when the number moves) and Apply all read
the list alone.

The chat's strip (`useDraftDock`) holds a room for a drafted row in the first eight, and for every row
whose draft is shared (`isSharedDraft`): another chat wrote in it, or the writer typed in it
(`actorThreads`, `unattributed` on the list item). Those rows show change-level text and per-change
commands, which cut this chat's changes from the others'. Every other row is a `whole` dock file
(`wholeDockFile`): the list's name and `textChanges`, a ✓ and × of its own, and a whole-draft command
(`{ kind: "draft" }`, which `withDraft` gives its `draftId`). Nobody else wrote in it, so the whole draft
is exactly this chat's changes and its count is exact. Apply all and Discard all are one command over
both kinds. A chat that touched hundreds of drafts holds eight sockets plus one per shared draft; that
last number is unbounded.

An Apply of several items (Apply all in Changes or the dock, a folder's ✓) is one command,
so one Un-Apply takes it all back (`applyGroup`, `group-apply.ts`). Every document's click is
made in the click's event turn and joins its own FIFO as a member sharing the command's id;
the member's send hands its click to the group, and the group posts `ApplyItemsClick` once
every member reached its queue's head, so each text cut lands after that document's earlier
clicks. A member that ends unsent (closed draft, unread room) is left out; a drop before the
group is sealed decides nothing. A folder is a member too: a tree cut in its own item's queue
under `folderKey(branchId, folderId)`, so a folder-only command has the same pending, refused
and unknown-delivery states as a document's; a failure is the pill. Its cut is the
list response's `folders[].revision`, read once when the command first goes, so a resend
carries the same body; folders lead the items. Every member's queue settles from the one answer,
`conflict` included, and the group's answer, which makes the Undo step and the notice, is the
first a sent member settles on: the post's, a closed queue's lookup (an unsent
member ends cancelled, and that is not the command's answer); groups are enqueued in item order in one turn, so two groups never wait on
each other. A sidebar Undo step mints its Un-Apply id once, so a press after a lost answer resends
the same id.

An editor text Apply gives that editor's history one entry (`ApplyEntries`, `apply-history.ts`) whose
Undo and Redo go through the schedule-owned command handle (`queuePort`). Undo moves the history
cursor synchronously, cancels an unsent Apply, or queues a projected Un-Apply intent. The schedule
retries the targeted Apply before the inverse when its delivery is unknown and withholds later
commands behind any intent. The Un-Apply goes when either half of the Apply landed: a
landed rename with settled text still has something to take back.

Every Redo is one request that names its Un-Apply: `{ commandId, redoOf }` (`RedoClick`, on the
Apply route). The server takes back that Un-Apply's own `undo` edit and replays its
`treeUndone` (`redoItems`), so a partial Ctrl+Z redoes only what it took back, a change another
chat proposed since is never applied with it, and one made in two documents is applied only where
the Un-Apply took it. A change the writer has since written over stays out, and a Redo that lands
nothing ends, applying nothing else. The review's queue paints a
Redo at once from the selection the Un-Apply took; what it sends is the id. Every port reads the
same landed rule (`itemLanded`: the item's text or tree landed): an `applied` answer only says the
command finished.

Existence of a deleted document is its own fact, never read from a name conflict.
An Apply brings a deleted document back to land what the click carries for it: the click
carries no `restore`, and the item's answer says `restored`. The question a
strip or Apply all asks first (it names the deletes and restores) is the writer's
heads-up, not a precondition. The account owner keeps the answer's `restored`
fact, so an editor Apply keeps its result after navigation.

An Apply never answers refused. The answer is `applied` with one entry per item in `items`,
each half `landed` or settled (`itemOf`). `outcomeOf` reads them: an item with a landed half is
`done` (an Undo step and the applied facts); an item with neither half landed is `settled`. What
stayed out says nothing, and the item stays in Changes. A click whose room cannot acknowledge it
settles `unsent` on the client. The press sends `saw`, the cut the cached draft list came
with, frozen with the click; a 503 (the server lacks something the press saw) is an unknown
delivery the queue retries with the same id. An Apply goes on the Undo stack only when an
item landed, and a press of its step that reached the server is spent: `already` or nothing
taken back never falls through to the next older step.

A Discard never refuses either, and its answer is read per item the same way (`discardAnswer`
in `draft-command-owner.ts`): an item it took, or one an earlier Discard took (`already`, quiet),
leaves review, a created document's tab closing either way. The outcome carries what the answer
says of the items sent (`took`: the ones it didn't take), and the notice lists only what it took
(`DraftNotices.answered`): its struck rows and its Undo are the answer's, never the press's. An item an
Apply took first just isn't listed; nothing says so. A move's Discard that also writes its own text is two
shares of the notice, the room's and the server's, and only the server's answer narrows. The command is `done`,
with its Undo, when it took any item, and `settled` when it took none. An Apply's Undo step
holds the nodes its answer says landed, not the ones pressed.

`ApplyClickQueue` holds one head, with same-body retries at 1/2/4 seconds. Then a sent Apply or
Un-Apply reads its stored answer by command id and settles on it; only a click with none settles
`unsent` (`cancelled` when its draft closed) (its optimistic fold ends, so the change is pending again, and the commands behind
it go), and the press shows one "Couldn't apply" pill per branch. A timeout is not one of those failures: the Apply and Un-Apply requests
(`postCommand` in `branches-api.ts`) resend under the same id after a timeout and while the
server answers `running`, so a large Apply stays `Applying` until its answer instead of
stalling. Changes shows one "Applying" line while rows are hidden by an Apply in flight, and
hides a folder whose own cut is in flight once nothing under it is listed. Transient disconnects keep acknowledgement barriers pending. Each click has two
independent duties:

- *Release* (the head leaves the FIFO and its optimistic contribution ends) happens once:
  on its stored answer. The queue knows its item's node and reads its own entry: a landed text
  half moves to `held` until the room's server clock reaches the answer's `at`.
- *Completion* (the caller's outcome) comes from the full answer, which alone carries
  `restored`. When every answer was lost, it is the stored answer the queue read back by
  command id after its last retry (`settleStored`); a closed draft's head reads it instead of
  resending.

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

Every Discard is one server command under an id the client mints (`DraftCommandOwner.discard`,
`useWorkBranchCommands.sendDiscard`): one item per document, each naming its `text` (`"all"` or
the change ids) and `tree`. A single change, a document's draft, a chat strip's or a Work's
Discard all, a folder group and the review room all send it; nothing writes the room's text.
The writer sees the result first: the owner marks the targeted changes `discarding`, and the
editor paints them as the base text they go back to (`setReviewDiscarded`, the inline-review
plugin's `discarded` class) until the room has the server's write (`releaseWhenRoomHas`, which
gives up after `ROOM_WRITE_WAIT_MS`). Named changes are read on the server at the room's snapshot, so the owner waits for the room's typing to be acknowledged (`whenCurrentChangesAcknowledged`, as a room Apply does) before it sends; a server still missing the snapshot answers 503 and the Discard does not run. One command is one Ctrl+Z entry in the editor
(`captureApply`) and one notice with one Undo, which sends the Restore.

### Notices

`DraftNotices` (owned by `DraftCommandOwner`, so account-lived) holds one notice per draft
owner key: the latest Discard with its Undo, or the latest Apply's facts. The writer's tree
deletes use the same line under a per-project key (`deleteNoticeKey`), only off the sidebar: on
main's band or Recently opened (`landing`); the sidebar's rows carry their own (see the context
tree's interactions page). A page whose document a Discard took away
(a Work's new document) shows the Discard's notice, Undo included, while it holds the document
(`discarding`); after that it says the document was discarded from the draft. A newer Apply or
Discard by the owner replaces it; a reload starts empty. Each notice records
the surface it was made on (Changes list, a chat's strip, a document's band) and shows only
there. In the Changes list a notice is said on its rows, never as a line (`useDraftNoticeWords`,
`RowWord`): every row a Discard took stays struck through with Undo, in the place the list
showed it when the writer pressed (the list is held at the press, per owner, so a switch of list
keeps it), and every document an Apply took keeps its row with "Undo" (`AppliedFact.step`): the
sentence says it was applied, with where it is now when it moved (read by id from the tree; nothing
said of where it is once it is in Trash or purged), and the Undo is the Apply's step on the sidebar's
Undo stack, the one Ctrl+Z takes (`ApplyEntries.undo`; an Apply all's rows each take back the
whole step). An Un-Apply that took something ends the applied notice; one that didn't reach the
server toasts "Couldn't undo" and leaves it. The first row an Apply took gets the focus its ✓ or Apply all had. A band notice shows on that document's review line (above the toolbar, in place of the
review controls a whole-draft Discard removed; the phone's review header gives it a row), or on
the review line of the document main went back to, or, when main went to Recently opened, in that landing's top slot. Only the document's name shortens in a notice; its verb and Undo
always show. Focus stays on the surface where the writer pressed: each surface (review line,
phone review header, Changes list, strip) wraps its notice and controls in one
`useFocusSuccession` container, so a Discard's focus goes to the notice's Undo and an Undo's to
the controls that come back (the Changes list prefers the restored row). If the writer moved
before the go-back resolved, the notice ends. Apply
facts from a band stay out of the store: the identity row shows them from the owner's per-document
facts (`useManuscriptState`). Discard all is one notice and one server command. An Undo is one Restore command: the notice ends and
the row returns when the server answers, and one that throws keeps the notice and shows the pill. Ctrl+Z in the
reviewing editor sends the same Restore (the `captureApply` entry). The server brings back only the
changes that still stand on the draft, so an edit the writer made over a discarded change leaves that
change in the base, silently.
`DraftCommandOwner.close()` ends every notice.

A whole-draft Discard (always a server command) on a draft-only page (live deleted it elsewhere)
sends main back through `ContextRemovalCoordinator.beginOwnRemoval` once the Discard is written,
so a refused Discard leaves main on the page that shows the refusal; the go-back reports where
main landed, and an Undo while main is still there returns it to the draft's review address.
While that go-back runs, the coordinator's `discardDraft` leaves the page alone, so a slow open
of the previous document doesn't let `DraftOnlySettlement` close it first and end the notice.

Chat-strip and Work Discard publish their notice and a projection-scoped `discarding` target first, so the row
and notice paint before the indivisible write-back. Hidden pages drain on visibility
change rather than waiting for animation frames. A write finds the room as it is then
and takes the chosen changes from it by `readChosen`.

Direct writes never impersonate the binding origin: its delete-only transactions without a
writer ProseMirror transaction are schema-repair evidence. A side or Work notice owns a separate manager and pool lease.
The notice
belongs to its exact session binding, so replacement documents never inherit the manager.

A draft ends only when its Work or its document is purged (`ended`, Draft end in
[state-machines.md](state-machines.md)); a Discard, a restore and an Apply of a delete leave it open.

Trash lists each Discard of whole drafts (`whole`; a Discard of single changes is final but for its Undo) and Restore brings it back (`restoreDiscard`, both halves onto the
Work's current branch): the notice's Undo, Trash's Restore and a row's Undo send that one command.
Each Discard's restore has one progress, whatever sent it (`DiscardRestores` on the command
owner, keyed by the Discard's command id): the notice and Trash's row read it, so a restore from
Trash ends the notice, and a notice's refused Undo clears once a later restore lands. A run of
Discards with nothing between them (no Apply, Un-Apply or Restore) shows as one Trash entry
(`DiscardEntry.commandIds`), and its Restore sends each command in turn. A change the writer has
since written over is not brought back, and nothing says so. A restore answered with nothing
done says why only where the answer is a bounce ("Work was closed.", "Its chat is in Trash.",
"Gone from Trash."). No Discard asks first. Only Discard all sends `all`. A Discard of a
selection (a folder group's ×, a folder changed alone) is one command over exactly those
documents and folders (`discardSelection`, `BranchDiscardRequest.items`). Their optimistic
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
- Discard draft, and the chat strip's Discard, is the server's one Discard
  (`text: "all"`, `tree`), move or delete included. The item stays in review, `discarding`, until the
  answer, so a return shows on it. A chat restored on another device and written to since
  still discards, and Undo brings the text back.

A local revert checks its room's access when it writes. A room the server already admits
read-only refuses it (`read_only`) and the list re-reads, so a stale `frozen: false` never
shows a revert the room drops. The freeze itself closes the socket with `ACCESS_CHANGED`,
which marks the room read-only at once. An unacknowledged revert is found at the read admission's
handshake: the room is replaced by one loaded from the server, so the revert's change is back in
the list, and its typing (not a Discard, which has no words) is dropped with one "Couldn't save". Until the Discard's
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

An item with a tree line is discarded by the same one command with `tree: true`, so its Undo
takes back both halves.

An Apply is held in the browser as its command id and nothing else (`ApplyEntries`,
[state-machines.md](state-machines.md)): one entry in each live history of its documents, and a
step on the sidebar's stack. Every Undo of it is `undo(from)`: the sidebar's Ctrl+Z, an applied
row's Undo, or Ctrl+Z in an editor showing one of its documents; every Redo is the editor's.
`ApplyPort` carries the two requests by id: the server's (`serverPort`, the one every surface uses),
or, for a band's Apply while the review shows the draft's room, its item queue's (`queuePort`), so
the review shows both at once. When the review lets go of the room (Draft view to Live) the band's
entry switches to the server's port. `owner.applied` holds every entry, so a session that opens
after the Apply gets it (`observeHistories`), and ends them with the owner.

**Redo during an Un-Apply** waits for that answer and goes on only when it took something back. A
Redo that lands makes the new command the one in force and shows the entry again in every live
history and on the sidebar's stack. Taken back, the entry ends when its editor drops the Redo (new
typing clears it). Ctrl+Z in one history moves its entry to Redo and hides it in the others; a press
from elsewhere leaves no Redo and ends every entry; a press that didn't reach the server shows it
again everywhere and toasts. Nothing is held for a closed owner: an Un-Apply takes what it can,
and what a closed owner keeps stays applied.

An Apply made in the sidebar, a chat's strip or Changes is also the sidebar's step
(`rememberApply`, `core/project-tree/tree-undo.ts`): on the stack from when it landed until an
Un-Apply took something back or it ended, with its watch on its tree half and its notice.

**A chat card's Undo** is the one `reverse_turn` command, and it takes back only its own reply's
changes, applied ones included: the server reads each applied change from the Apply's `carried` and
takes it out of the manuscript when it still stands there (`collab/.context/reversal.md`). The card
holds no Apply entry and sends no Un-Apply; a Changes row's Undo and Ctrl+Z still take back the
whole Apply.

The move is a row of its own (`tree-line.ts`), listed before the text changes, while a
delete supersedes the text rows. A selection's target says whether the line is in it, so
the line's Apply sends only the tree cut and its Discard keeps the text. `hidden` covers
only a tree click in flight, since a later move of the same document reuses the item key.
