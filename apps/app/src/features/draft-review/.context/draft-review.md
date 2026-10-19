# Draft review runtime

Review is a projection of the tab's own text, never a server-vended operation
list. The shared [kernel model](../../../../../../packages/agent-edit/.context/diff-review.md)
owns diffing, grouping, move pairing and formatting context.

## One room, one runtime

`useRoomReviews` retains the rooms of the rows on screen through
`readDraftRoom`. Open reviews and headless dock/Work readers share the runtime
by session object; a replacement account/session cannot inherit another
room's frame. The final holder destroys its runtime. The pool keeps room
sessions through its normal release grace and drains unacknowledged edits;
IndexedDB keeps the local text across reloads.

`review-frame.ts` reads the projection and its snapshot. Headless reads retain unchanged
PM nodes using the same Yjs mapping invalidation as the binding, exported by
the scoped y-tiptap patch. Attaching an editor adopts its schema and retained
nodes off the typing path. Editor projection uses the editor's own mapping;
another attached editor receives positions only if its full content agrees.
Removal widgets never enter either Yjs fragment.

`review-runtime.ts` caches base blocks per schema until `review_base` changes
or the provider is invalidated. Keystrokes project against that cache after a
120 ms trailing debounce. Peer writes and base changes coalesce into an immediate
microtask projection, after Yjs/editor bindings have settled. The painter maps
existing marks while the next frame waits. `projectNow()` cancels that wait.
Ready requires first room sync; cached changes alone are not authority to
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
- The controller's focus is one group id. Missing ids reconcile to the first
  remaining group. Launch requests carry group ids all the way into focus.
  An empty frame shows “No changes left”; only the close contract can end the
  draft room or send the editor to live.

`useReviewRefresh` retains its pending timer by review identity, independently
of the room subscription. Rebinding an editor must not drop a refresh already
scheduled from a live pull.

## Other lifecycle boundaries

`useAiDraftLauncher.openReviewFile` is the shared listed-file launch adapter.
A draft-only editor is the document's single workspace tab in its review Work,
not a second tab. Closing its review is not Discard. Catalog removal and
promotion remain `DraftOnlySettlement`/the context lifecycle's responsibility;
list omission alone must not infer local Discard or successful Apply.

## Account command lifetime

`AccountFeatureLifetime.draftCommands` is shared by editor, chat and Work
surfaces. `bind(ref, session)` joins one stable draft-row owner and installs
its cached base provider. `apply(ref, target)` synchronously freezes the Yjs
snapshot, O/P blocks, selected ids and one room-base-to-O delta. The queue
retains a `readDraftRoom` lease independently of React until terminal.

`ApplyClickQueue` holds one head, with same-body retries at 1/2/4 seconds,
then an item Retry. A record alone proves landing; an applied answer without
the record keeps its contribution. Closed/refused answers remove only their
own contribution. A terminal close cancels unsent clicks and observes a sent
head's durable outcome; applied then needs no room record. Feedback starts at
500 ms in reserved footer space. No queue or optimistic base persists.

The base provider folds `applyBase` over unrecorded clicks in order. Base,
record and queue changes invalidate it; typing only reprojects. Group targets
must still describe equal base and prose at capture; a changed pre-click
projection is refreshed and reported locally, never reinterpreted by its
old occurrence suffix. No post-click edit changes a frozen command.

`discard(ref, target, surface)` composes against that optimistic base and
calls `writeDiscardBlocks` (including `recordWriteBack`) in one transaction.
Editor history uses the binding origin with stop-capture boundaries. A dock
or Work notice owns a separate manager and pool lease, retains the runtime,
and installs `recordRestorations` so Undo writes links in its own transaction.
Undo restores a cached list item before server discovery catches up. At most
the surface's latest Discard history is offered; another action ends it.

Created-document removal and Work Discard all use the server through the
same account owner. Their optimistic visibility is lifecycle state, never
text-group hiding. Discard all includes bound empty drafts as well as listed
items. Removed rooms ask the existing availability owner for the record;
there is no second removal cache. `4205` maps to terminal `closed` (including
in-band code-1000 delivery), `4208` to `removed`; session teardown clears
the exact IndexedDB cache. One-document text Discard clears neither.

Addressed room lookup is `useDraftMetadata`, never a server text preview.
The metadata GET and no-text creation Apply capability are integration
requirements: the browser cannot derive a draft id from the list item key,
nor manufacture a text snapshot for an image. Such an Apply is not offered.
