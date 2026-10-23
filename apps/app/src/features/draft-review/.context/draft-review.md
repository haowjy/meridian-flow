# Draft review runtime

Review is a projection of the tab's own text, never a server-vended operation
list. The shared [kernel model](../../../../../../packages/agent-edit/.context/diff-review.md)
owns diffing, grouping, move pairing and formatting context.

## One room, one runtime

`useRoomBindings` retains rooms through `readDraftRoom` and publishes lifecycle
changes, not text frames. `useRoomReviews` subscribes to those runtimes through
`useSyncExternalStore`; frames stay in the runtime rather than queued React state.
Open reviews and headless dock/Work readers share the runtime by session object; a replacement account/session cannot inherit another
room's frame. Metadata effect keys contain only the `projectId`, `workId`, `documentId` and `itemKey` address strings and metadata
revision/status/error, never the caller's object: presentation focus carries a
whole projection, and structural typing does not strip those extra fields.
The final holder destroys its runtime. The pool keeps room
sessions through its normal release grace and drains unacknowledged edits;
IndexedDB keeps the local text across reloads.

`review-frame.ts` reads the projection and its snapshot. Headless reads retain unchanged
ProseMirror nodes using the same Yjs mapping invalidation as the binding, exported by
the scoped y-tiptap patch. Attaching an editor adopts its schema and retained
nodes off the typing path. Editor projection uses the editor's own mapping;
another attached editor receives positions only if its full content agrees.
Base reads also retain ProseMirror nodes and their block array. Each base fragment has one
current-schema reader; a schema replacement disposes the old observer while frozen
frames keep their immutable nodes. Removal widgets never enter either Yjs fragment.

`review-runtime.ts` caches base blocks per schema until `review_base` changes
or the provider is invalidated. Keystrokes project against that cache after a
120 ms trailing debounce. Peer writes and base changes coalesce into an immediate
microtask projection, after Yjs/editor bindings have settled. The painter maps
existing marks while the next frame waits. A binding's whole-root PM replacement
uses the actual content-diff map, not its whole-document step map; fully erased
ranges retire instead of expanding inclusive marks across the replacement.
`projectNow()` cancels the wait and reuses a clean frame. Any Yjs update invalidates
the captured cut, including root-only changes; attribution-only publication does
not repaint an already installed text frame. Ready requires first room sync; cached changes alone are not authority to
Discard. Once synced, temporary offline status does not forget that history.

## Commands and attribution

- `setBaseProvider(baseOf)` and `invalidateBase()` let the command owner fold
  queued Apply clicks into the base. The provider receives the room and schema;
  it is not called per keystroke. No applied-id hiding or selection translation
  exists beside this projection.
- Every displayed group carries its immutable `frame`. `targetOfChanges`
  supplies that frame and group ids to command callbacks, not a later read of
  the runtime. The owner validates the frame before interpreting projection-local ids.
- `setAttributionProvider()` joins a per-group byline/membership map without
  changing boxes. An absent map entry is explicitly unknown, so candidate chat
  rows remain visible without a byline. `room-attribution.ts` owns one
  reference-counted evidence reader per session. It fetches on unresolved
  clock-range changes, Apply/restoration root revisions and reconnect, not
  text-frame identity. Local deletion witnesses cover unacknowledged typing.
  Replaced/aborted reads never publish. `review-attribution.ts` joins the
  classifier's byline/membership to owner conversations; a subagent link asks
  the existing conversation reveal controller for its spawn card.
- The controller retains explicit focus intent as a group id and immutable frame.
  A new projection invalidates that address; each subscribed leaf derives the first
  remaining group without writing a fresh frame back through the project scope.
  Header Apply eligibility comes from that same leaf projection, not a controller
  snapshot. A click reads the painter's current frame synchronously. Launch requests
  carry id and frame together. Persisted bare ids never restore selection into a
  newer projection. `useInlineReviewFocus` registers the mounted editor for
  controller-owned jumps and releases only its own claim on unmount. Same-entry
  URL replacements disable router scroll restoration so the editor owns the jump.
  An empty frame shows “No changes left” once the item has no tree line either:
  the open review lists the item's pending move or delete first (focus and the
  stepper walk only the text changes), so a text-only Discard leaves Discard
  draft and Apply draft beside the Work notice. Only the close contract can end
  the draft room or send the editor to live.

`useReviewRefresh` discovers list/metadata changes from the runtime's semantic
membership: any differences, pending owner-thread ids, and unknown attribution.
A new frame or another key with the same membership never refetches the whole
Work. A semantic change schedules only after its captured room cut is acknowledged,
so a slow append cannot leave a first change absent from the server list. This
wait gates only background discovery, never input or commands. An independent live-room update still schedules discovery; a mounted review
session is not also a live source. Its pending timer belongs to the review
identity, so rebinding an editor cannot drop discovery already scheduled by a pull.

## Other lifecycle boundaries

The room owner supplies the selected address's room name and read error directly.
Presentation state retains selection, focus, marks and `shown`, not room readiness.
Cached active metadata keeps its room mounted after a metadata refetch failure.
Initial metadata failure retries metadata; room acquisition failure retries the room read.
Editor model readiness stays local to its mount.

`useAiDraftLauncher.openReviewFile` is the shared listed-file launch adapter.
A draft-only editor is the document's single workspace tab in its review Work,
not a second tab. Closing its review is not Discard. Catalog removal and
promotion remain `DraftOnlySettlement`/the context lifecycle's responsibility;
list omission alone must not infer local Discard or successful Apply. The list
omits an active draft with no effect (a delete's held tab, a fully applied draft,
one inside the `has_effect` lag), so an unlisted draft-only tab goes live when
the catalog shows its document and closes only when its draft metadata answers
`gone`; an active or unanswered draft keeps its tab.

Closure belongs to a draft generation, not to its item key. The key (branch +
document) outlives its drafts: discarding one item leaves the branch active, and
a later write to the same document mints a new draft under the same key. The
command owner keeps each draft's record (its unsent text, its room) under its
draft id, and an item follows its newest known generation: `bind` and
`reconcileClosed` advance it, never a close. A close (room reset or metadata
`gone`) retires the generation it was issued for, so a late answer about the old
draft cannot close a newer one. While the item's known draft is closed, the
review address port (`ProjectView`) and the route's address clearing both ask
the server first (`reconcileClosed`, a fresh metadata read): `gone`, the same
closed draft, or a failed read refuse admission and clear a non-draft-only
address, since the room owner just ended that review and admitting it again
would loop; a different active draft is the replacement, and admission goes
ahead. `ReviewAddressOwner` remembers a refusal only for the port that gave it;
the port changes when the item's generation does, so a replacement that becomes
known later (another surface bound it) is retried once. The server answers `gone`
from the Work's ownership and the item key alone, before any content grant:
the active draft is what grants reading a document deleted live or a hidden
creation, so after a Discard on another device a content check would answer
404 forever. Inaccessible active content and network errors stay nonterminal.

## Account command lifetime

`AccountFeatureLifetime.draftCommands` is shared by editor, chat and Work
surfaces. The review item owns command scheduling: one `ApplyClickQueue` per item key
for its text, tree and text+tree clicks, so a tree cut waits behind the text clicks
before it and one path publishes `pending`, `applying` and `stalled` on the item's
current generation. Draft rooms are resources the item attaches. `bind(ref, session)`
joins the item and installs a replaceable session binding on that draft's room
(runtime, base-fold provider and Apply-record observer). A text click names its draft
(`body.draftId`); only that draft's room records it, folds it into its base, holds a
room reader for it (following replacement sessions even without a surface), and
cancels it on close, so a newer draft under the same key never inherits an old click.
A tree-only click has no room and its applied answer settles it. A refusal lands on
the generation the click was made for. Retiring a session detaches that binding and
refuses only its draft's unsent clicks. `captureApply(ref, target)` synchronously freezes the stable `draftId`, Yjs
snapshot, the reviewed base blocks (O), selected ids, the result of applying those
groups (P) and one room-base-to-O delta. Its acknowledgement barrier waits for
the server to acknowledge every local update in that captured cut before sending. Capture
immediately enters the immutable command in the item's account-owned FIFO. A single Apply
releases it to send at once. Apply all captures and queues every item in the click's event turn,
then the owner releases sends in server order; an earlier answer may omit a tree cut it already
settled, but never recaptures later text or a later tree revision. The queue retains a
`readDraftRoom` lease independently of React until terminal.

An editor text Apply also gives that mounted editor's history an action over the
frozen cut. Undo cancels it by command id while unsent. After send, Undo holds the
item FIFO through the durable Un-Apply; later clicks cannot pass it. Redo is a new
Apply command for only the text groups the server actually reversed, never the
original tree cut. Work and dock callers pass no editor history handle.

A deleted document (the list item's `deletedLive`, D79) is draft-only on every
surface. Existence is its own fact, never read from a name conflict. If another document took
its path, Apply restores it at the next free name, then merges. `apply(ref, target, restore)` sends
`restore` only when the writer knew: a single document's Apply whose row showed
the delete, or an Apply all for the documents its confirmation named. Without it
the server answers `needs_restore` (nothing changed); the outcome is
`needs-restore`, the list refreshes so the row shows the delete, and an Apply all
asks again by name. An applied answer carries `restored` and every final `renamed`
path. The account owner retains both facts for the document, so an editor Apply keeps
its result in the identity row after navigation. Dock and Work surfaces show the same
facts in `CommandNotice`, which renders only when there is a result or question.

`ApplyClickQueue` holds one head, with same-body retries at 1/2/4 seconds,
then an item Retry. A terminal acknowledgement failure refuses unsent cuts
with an item failure; sent heads keep their same-id settlement across session
replacement. Transient disconnects keep acknowledgement barriers pending.
Each click has two independent duties. *Release* (the head leaves the FIFO
and its optimistic contribution ends) happens exactly once: on the room's record,
or on a terminal answer; an applied answer without the record keeps its
contribution. *Completion* (the caller's outcome) comes from the full answer,
which alone carries `restored`. When the record released a click whose answer is
still in flight, the answer completes it when it arrives; when the answer is
missing or lost, in either order relative to the record, the queue reads the
stored result back under the same command id (never a resend), at 0/1/2/4
seconds. Exhausted reads complete as `landed` (it landed; `restored` is
unknown), and destroying the queue completes still-reading clicks the same way. Closed/refused answers remove only their
own contribution. A `work_archived` refusal stores no failure (`shownRefusal`):
the Works query refetches and `ArchivedWorkNotice` explains the reverted change,
so no surface shows a refusal line. Other refusals still move prose in two cases,
Show changes off (header fallback line) and a long message wrapping in the
between-paragraph bar; both are open in [#992](https://github.com/haowjy/meridian-flow/issues/992),
which needs one feedback surface outside the manuscript flow rather than another
per-width fix. A terminal close cancels unsent clicks and observes a sent
head's durable outcome; applied then needs no room record. Feedback starts at
500 ms on the addressed item. No queue or optimistic base persists. Queue changes invalidate its optimistic
contribution independently of account UI notifications; the account publishes only
changed command state or a changed item-to-draft binding. Rendering leaves subscribe
to those records; command callbacks and the project controller do not. The room
owner observes only hidden/closed lifecycle transitions. Listed-room snapshots
combine stable text and per-item command records, including deferred Discard.
Apply callbacks refresh discovery when the item's FIFO drains, not after every head.

The base provider folds `applyBase` over unrecorded clicks in order. Pending
Un-Apply folds the frozen effect backward until removal of the targeted group
records is observed; an HTTP answer alone cannot flash the applied state back.
Failure removes that fold, restores the history action at its chronological
position, and retains the same-id retry on the item. Typing remains enabled.
Only the runtime caches that fold per schema and observes `review_base`. Base,
record and queue changes invalidate it; typing only reprojects. Group targets
must still describe equal base and prose at capture; a changed pre-click
projection is refreshed and reported locally, never reinterpreted by its
old occurrence suffix. No post-click edit changes a frozen command.

`discard(ref, target, surface)` composes against that optimistic base and
calls `writeDiscardBlocks` (including `recordWriteBack`) in one transaction.
Editor Discard executes synchronously. Dock/Work Discard first publishes its
notice and a projection-scoped `discarding` target. Listed surfaces omit those
groups for one paint opportunity; room frames and editor paint still come only
from text. One animation frame allows React to commit the returned notice, a second gives
it a paint opportunity, and the next performs the whole write-back,
then clears the list overlay. Hidden pages drain on visibility change rather than
waiting for animation frames. Changed base or prose refuses the stale write and
restores the row, preserving intervening edits. Only the same item's further
Apply/Discard waits for it. Editor history tracks a dedicated Discard origin
with stop-capture boundaries. The draft-only editor plugin installs restoration
recording when its view mounts, before any writer Undo/Redo. Installation is
idempotent per manager, including the later editor Discard path. Live editors
never install it; a replacement session mounts and records its own history.
Direct writes never impersonate the binding origin: its delete-only transactions
without a writer ProseMirror transaction are schema-repair evidence. A dock
or Work notice owns a separate manager and pool lease, retains the runtime,
and installs `recordRestorations` so Undo writes links in its own transaction.
Undo captures its own session acknowledgement barrier before releasing notice ownership,
then restores a cached list item before server discovery catches up. A later item lookup
cannot prove that retired session's edits landed. At most
the surface's latest Discard history is offered; another action ends it.
The notice belongs to that exact session binding. Retiring the binding or
closing the draft ends its notice and destroys its history; replacement
documents never inherit the manager. The surface's end callback removes
the notice when the owner retires it.

Created-document removal and Work Discard all use the server through the
same account owner. Their optimistic visibility is lifecycle state, never
text-group hiding. Discard all includes bound empty drafts as well as listed
items. Removed rooms ask the existing availability owner for the record;
there is no second removal cache. `4205` maps to terminal `closed` (including
in-band code-1000 delivery), `4208` to `removed`; session teardown clears
the exact IndexedDB cache. The command owner handles a terminal room frame and
an authoritative metadata `gone` as two arrivals of the same fact. For `gone`,
it resolves the exact document through the availability owner: available goes
to that document's current live URI; deleted uses the existing removal flow.
Failed/unknown reads never prove closure. The owner deduplicates the disposition,
retains an open room during that lookup for unsent-text recovery, and asks the
pool to retire it and drop its exact cache. One-document text Discard clears neither.

Addressed room lookup is `useDraftMetadata`, never a server text preview.
The route retains this read above editor address admission, so catalog
invalidation cannot strand a review after unmounting its room readers. A gone
room is a lifecycle transition, not a room-opening error. The metadata GET returns the stable draft id and room name, or authoritative
`gone`; list item keys cannot supply room identity. An item with a branch row
(`tree`: a creation, move or delete) applies it with a tree cut: the whole item's
Apply carries `tree.revision`, and with no text to send (no room, or no changes)
it is the tree cut alone: empty `groupIds` and `baseViewDelta`, no `snapshot` or
`draftId`, in the same item FIFO. A tree cut already queued is not sent again. A
changed row answers `changed`. The server applies a move's pending occupant chain under the
branch lock, including a swap as one transaction, so single-row Apply and Apply all share the
same ordering. `discardItem` is the item's one Discard when it has a tree line: the
server drops the move or delete, and the chosen text is discarded here as always.
Its text offers no Undo, because Undo would bring back the text without the move
or delete the server already settled (#763): the owner ends the text notice at
once (the accepted write keeps its paint opportunity, then releases its room), and
the surface shows "Discarded" without Undo.

The move or delete is a row of its own, the item's tree line (`tree-line.ts`):
a `ReviewChange` with no frame and `tree` set, listed before the text changes
(`listedItemChanges`). A selection's target says whether the line is in it
(`{ kind: "tree" }` alone, `groups.tree` beside text groups), so the line's
Apply sends only the tree cut and its Discard drops only the move or delete,
keeping the text. A tree-only item needs no room, so Work Files shows its line
without expanding. A tree line's Discard and Apply remove it from the cached
list at once (the refetch restores a refusal); `hidden` covers only a tree
click in flight, since a later move of the same document reuses the item key.
The click body's `tree` is `{ revision }` only: the server's schema is strict.
A live document a Work moves or deletes says so in the identity row's notice
slot (`ManuscriptStateNotice`), from the document's branch hints
(`DocumentDraftHint.tree`), naming the Work, never its handle (#914).
