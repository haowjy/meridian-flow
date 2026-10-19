# Draft review runtime

Review is a projection of the tab's own text, never a server-vended operation
list. The shared [kernel model](../../../../../../packages/agent-edit/.context/diff-review.md)
owns diffing, grouping, move pairing and formatting context.

## One room, one runtime

`useRoomBindings` retains rooms through `readDraftRoom` and publishes lifecycle
changes, not text frames. `useRoomReviews` subscribes to those runtimes through
`useSyncExternalStore`; frames stay in the runtime rather than queued React state.
Open reviews and headless dock/Work readers share the runtime by session object; a replacement account/session cannot inherit another
room's frame. Metadata effect keys contain only the four draft-address strings and metadata
revision/status/error, never the caller's object: presentation focus carries a
whole projection, and structural typing does not strip those extra fields.
The final holder destroys its runtime. The pool keeps room
sessions through its normal release grace and drains unacknowledged edits;
IndexedDB keeps the local text across reloads.

`review-frame.ts` reads the projection and its snapshot. Headless reads retain unchanged
PM nodes using the same Yjs mapping invalidation as the binding, exported by
the scoped y-tiptap patch. Attaching an editor adopts its schema and retained
nodes off the typing path. Editor projection uses the editor's own mapping;
another attached editor receives positions only if its full content agrees.
Base reads also retain PM nodes and their block array. Each base fragment has one
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
surfaces. `bind(ref, session)` joins one stable draft-row queue and installs a replaceable
session binding (runtime, cached base provider and root observers). A pending
queue owns a room reader that follows replacement sessions even without a surface.
Retiring a session detaches that binding, not the draft queue. `apply(ref, target)` synchronously freezes the Yjs
snapshot, O/P blocks, selected ids and one room-base-to-O delta. The queue
retains a `readDraftRoom` lease independently of React until terminal.

`ApplyClickQueue` holds one head, with same-body retries at 1/2/4 seconds,
then an item Retry. A terminal acknowledgement failure refuses unsent cuts
with an item failure; sent heads keep their same-id settlement across session
replacement. Transient disconnects keep acknowledgement barriers pending.
A record alone proves landing; an applied answer without
the record keeps its contribution. Closed/refused answers remove only their
own contribution. A terminal close cancels unsent clicks and observes a sent
head's durable outcome; applied then needs no room record. Feedback starts at
500 ms in reserved footer space. No queue or optimistic base persists. Queue changes invalidate its optimistic
contribution independently of account UI notifications; the account publishes only
changed command state or a changed item-to-draft binding.

The base provider folds `applyBase` over unrecorded clicks in order. Base,
record and queue changes invalidate it; typing only reprojects. Group targets
must still describe equal base and prose at capture; a changed pre-click
projection is refreshed and reported locally, never reinterpreted by its
old occurrence suffix. No post-click edit changes a frozen command.

`discard(ref, target, surface)` composes against that optimistic base and
calls `writeDiscardBlocks` (including `recordWriteBack`) in one transaction.
Editor Discard executes synchronously. Dock/Work Discard first publishes its
notice and a projection-scoped `discarding` target. Listed surfaces omit those
groups for one paint opportunity; room frames and editor paint still come only
from text. The next animation frame after that paint performs the whole write-back,
then clears the list overlay. Hidden pages drain on visibility change rather than
waiting for animation frames. Changed base or prose refuses the stale write and
restores the row, preserving intervening edits. Only the same item's further
Apply/Discard waits for it. Editor history tracks a dedicated Discard origin
with stop-capture boundaries.
Direct writes never impersonate the binding origin: its delete-only transactions
without a writer ProseMirror transaction are schema-repair evidence. A dock
or Work notice owns a separate manager and pool lease, retains the runtime,
and installs `recordRestorations` so Undo writes links in its own transaction.
Undo restores a cached list item before server discovery catches up. At most
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
room is a lifecycle transition, not a room-opening error. The metadata GET and
no-text creation Apply capability are integration
requirements: the browser cannot derive a draft id from the list item key,
nor manufacture a text snapshot for an image. Such an Apply is not offered.
