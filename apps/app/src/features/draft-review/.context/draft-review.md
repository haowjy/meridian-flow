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

## Commands and attribution are separate seams

- `setBaseProvider(baseOf)` and `invalidateBase()` let the command owner fold
  queued Apply clicks into the base. The provider receives the room and schema;
  it is not called per keystroke. No applied-id hiding or selection translation
  exists beside this projection.
- Every displayed group carries its immutable `frame`. `targetOfChanges`
  supplies that frame and group ids to command callbacks, not a later read of
  the runtime. Apply/Discard delivery remains the command owner's job.
- `setAttributionProvider()` joins a per-group byline/membership map without
  changing boxes. An absent map entry is explicitly unknown, so candidate chat
  rows remain visible without a byline. The attribution lane owns fetching,
  evidence revisions and classification.
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
