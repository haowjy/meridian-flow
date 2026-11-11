# Draft review runtime

Review is a projection of the tab's own text, not a server-vended operation list. The
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

A draft-only editor is the document's single tab in its review Work, and closing its
review is not Discard. List omission alone can't infer Discard or Apply: the list omits
an active draft with no effect (a delete's held tab, a fully applied draft, one inside
the `has_effect` lag). So an unlisted draft-only tab goes live when the catalog shows its
document and closes only when its draft metadata answers `gone`.

Closure belongs to a draft generation, not its item key. The key (branch + document)
outlives its drafts: a later write to the same document mints a new draft under the same
key. The command owner keeps each draft's record under its draft id, and an item follows
its newest known generation, advanced by `bind` and `reconcileClosed`, never by a close.
A close retires the generation it was issued for, so a late answer about the old draft
can't close a newer one.

While the item's known draft is closed, the review address port and the route's address
clearing ask the server first (`reconcileClosed`). `gone`, the same closed draft or a
failed read refuse admission, because the room owner just ended that review and admitting
it again would loop; a different active draft is the replacement. While a command hides
the item (a Discard in flight), the port refuses it outright for the same reason; the end of the hide is a new port, so a refused Discard restores the
review. `useReviewAdmission` (one per document host) remembers a refusal only for the port
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

`captureApply` synchronously freezes the `draftId`, Yjs snapshot, reviewed base blocks,
selected ids, the result of applying those groups and one room-base-to-O delta. Its
acknowledgement barrier waits for the server to acknowledge every local update in the
cut before sending. Apply all captures every item in the click's event turn, then
releases sends in server order; an earlier answer may omit a tree cut it already settled,
but later text or a later tree revision is never recaptured. The queue keeps its own
`readDraftRoom` lease until terminal.

An editor text Apply gives that editor's history the Undo and Redo callbacks of the
schedule-owned command handle. The handle owns command identity, reversal outcome and
replay selection; the mounted history owns only navigation. Undo moves the history cursor
synchronously, cancels an unsent Apply, or queues a projected Un-Apply intent. The
schedule retries the targeted Apply before the inverse when its delivery is unknown and
withholds later commands behind any stalled intent. Redo queues a new Apply for only the
text groups the server actually reversed, never the original tree cut.

Existence of a deleted document is its own fact, never read from a name conflict.
`apply(ref, target, restore)` sends `restore` only when the writer knew: an Apply whose
row showed the delete, or an Apply all for the documents its confirmation named. Without
it the server answers `needs_restore`, nothing changes, and the row shows the delete.
The account owner keeps the answer's `restored` and `renamed` facts, so an editor Apply
keeps its result after navigation.

`ApplyClickQueue` holds one head, with same-body retries at 1/2/4 seconds, then an item
Retry. Transient disconnects keep acknowledgement barriers pending. Each click has two
independent duties:

- *Release* (the head leaves the FIFO and its optimistic contribution ends) happens once:
  on the room's record or a terminal answer. An applied answer without the record keeps
  its contribution.
- *Completion* (the caller's outcome) comes from the full answer, which alone carries
  `restored`. When the answer is missing or lost, the queue reads the stored result back
  under the same command id, never a resend, at 0/1/2/4 seconds. Exhausted reads complete
  as `landed`, with `restored` unknown.

A `work_archived` refusal stores no failure: the Works query refetches and
`ArchivedWorkNotice` explains. Other refusals still move prose in two cases, open in
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
`writeDiscardBlocks` in one transaction. `history` is the issuing host's own editor (the
controller's `reviewEditor`), whose Undo takes it back, or `notice` for a surface with no
editor; the room's runtime may list more than one attached editor, so the session never picks
one. Editor Discard is synchronous. Chat-strip and Work Discard publish their notice and a projection-scoped `discarding` target first, so the row
and notice paint before the indivisible write-back. Hidden pages drain on visibility
change rather than waiting for animation frames. Changed base or prose refuses the stale
write and restores the row.

Direct writes never impersonate the binding origin: its delete-only transactions without a
writer ProseMirror transaction are schema-repair evidence. The draft-only editor plugin
installs restoration recording when its view mounts, before any writer Undo/Redo; live
editors never install it. A dock or Work notice owns a separate manager and pool lease.
Undo captures its own session acknowledgement barrier before releasing notice ownership,
because a later item lookup can't prove that retired session's edits landed. The notice
belongs to its exact session binding, so replacement documents never inherit the manager.

Created-document removal and Work Discard go through the server. Their optimistic
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
  (`ends: "item"`), move or delete included. The item stays in review, `discarding`, until the answer, so a refusal shows
  on it. It carries the row's `updatedAt` as `draftSeenAt`, so a chat restored on another
  device and written to since refuses `draft_changed` instead of closing text the writer
  never saw. A created document's Discard in a live chat sends no fence: the writer's own
  typing would refuse it.

A local revert checks its room's access when it writes. A room the server already admits
read-only refuses it (`read_only`) and the list re-reads, so a stale `frozen: false` never
shows a revert the room drops. The freeze itself closes the socket with `ACCESS_CHANGED`,
which marks the room read-only at once; an unacknowledged revert then resets the room as
`refused` instead of staying on screen.

Restore restores the lineage's first chat and thaws only once the list says so. Thawing
first would let the writer type into a room that still drops their text.

A terminal room frame and an authoritative metadata `gone` are two arrivals of the same
fact. For `gone`, the owner resolves the exact document through the availability owner:
available goes to its current live URI, deleted uses the removal flow, and failed reads
never prove closure. It keeps an open room during that lookup for unsent-text recovery.

The metadata GET returns the stable draft id and room name, or authoritative `gone`; list
item keys can't supply room identity. The route keeps this read above editor address
admission, so catalog invalidation can't strand a review after unmounting its room readers.

## Tree lines

An item with a branch row (a creation, move or delete) applies it with a tree cut: the
item's Apply carries `tree.revision`, and with no text to send it is the tree cut alone, in
the same item FIFO. The click body's `tree` is `{ revision }` only, because the server's
schema is strict.

`discardItem` is the item's one Discard when it has a tree line: the server's tree-only
Discard (`ends: "tree"`) beside the local text revert. Its text offers no Undo,
because Undo would bring back the text without the move or delete the server already
settled.

The move is a row of its own (`tree-line.ts`), listed before the text changes, while a
delete supersedes the text rows. A selection's target says whether the line is in it, so
the line's Apply sends only the tree cut and its Discard keeps the text. `hidden` covers
only a tree click in flight, since a later move of the same document reuses the item key.
