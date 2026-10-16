# Draft review reference

This reference covers the review model, Discard, Apply, and draft-only
settlement. Paths are relative to `apps/app/src`. Commands, rooms, paint, and
delivery are separate owners.

## The model

An item's text branch room holds two fragments: `review_base` (the live text as
of the branch's last rebase; the server advances it) and `prosemirror` (the
item's text). The review is `projectReview(diffBlocks(base, draft))` from
`@meridian/agent-edit/diff`, recomputed in the browser whenever either fragment
changes. Group ids are content hashes. An empty `review_base` is a real base
once the room has synced.

One runtime per draft room (`review-runtime.ts`) publishes an immutable frame
(`review-frame.ts`: diff and groups, `Y.Snapshot`, each change's pin) in a
`ReviewState`, joined with the classified attribution and the draft's command
records. Mounted editors attach and paint it (`useInlineReviewSync`); with no
editor `useRoomReview` retains the room headlessly (Work page, strip) and the
runtime reads its Yjs text. Surfaces read the state with `useReviewState`;
nothing copies it into the controller.

The headless source retains one conversion meta (node mapping and mark metadata) per
Yjs room, shared by runtime projection and headless Discard/pin lookup. Its deep
observer calls the patched `@tiptap/y-tiptap` `refreshProseMirrorDoc`: the same
function the editor binding uses to invalidate changed types, ancestors and
deleted structs, then rebuild only missing nodes. Unchanged paragraphs keep their
identity whether a write is local, remote, AI or Undo. The room owns the observer;
it is removed on document destruction. Do not infer changed paragraphs from PM
transaction steps: remote and Undo updates replace the whole document in one step
while preserving the untouched nodes inside it.

At attachment the retained room source adopts the editor's actual schema, nodes and a copy
of its Yjs mapping. The runtime projects that editor immediately, warming its schema-bound
unit cache off the typing path rather than making the first key pay for every unit. This
adds a cold projection to opening a previously headless room. After detach the headless
source keeps the adopted schema and retained nodes; its base read reuses the same schema's
base array. TipTap owns its extension-bound schema; never content-key tokens across schemas.
Each editor still projects commands in its own schema. Base arrays for other editors are
weakly held, so repeated mounts do not retain every old schema.

Pins reuse both a retained Yjs top-level type and its immutable PM node, at a unit-local
offset. PM identity alone is insufficient: a move or equal-prose recreation can replace
Yjs items. Boundary pins are rebuilt because they depend on neighbouring items.

Who wrote a change is one classifier (`classifyChanges`, `@meridian/agent-edit/diff`, `attribution.ts`)
over the room's Yjs items and the attribution payload (`review-attribution.ts` joins its answer to
conversations). Three rules, each one sentence:

- **Byline.** A change names an author when, for one of its edits, every alignment the draft's items can
  account for gives that author part of the edit. Under doubt it names fewer, down to none.
- **Membership.** A change belongs to a conversation when any alignment of any of its edits puts one of that
  conversation's AI writes (its own or a subagent's) in it. Under doubt it includes.
- **Status.** An AI part reads applied only when no alignment of any change puts it in a change. Under doubt
  it reads pending.

An alignment is one place the text allows an edit to sit (a repeated word or a boundary space can slide).
Byline is the intersection over an edit's alignments; membership and status are the union. The classifier
collects membership and Apply evidence from raw word/structural footprints first; bounded character
refinement chooses only names. It reads lengths, ids and restoration links, so the browser (gc on) and the server (gc off) agree. Authors are identities:
`user(userId)` (the card says "You" while a project has one user) and `thread(threadId, turnId, toolCallId?)`.

Consumers read one answer. The card renders the byline: "You" first, then a link per writing thread. A
byline never hides its author: the first chat is always drawn and truncates with an ellipsis (full title in
its tooltip and accessible name), and later chats go behind "+N", a menu of the same links. The focused bar
fits whole names after the first; a list row shows the first alone and gives its width to the change's
red and green text first, keeping the byline at a floor ("You", about six letters, "+N"). A primary thread's link reveals the write's
turn and tool call; a subagent's write belongs to its nearest primary ancestor conversation (`owner`), the
link carries the parent conversation's title (the subagent's task title is in its label and tooltip), and
it reveals the outermost spawn row. The draft dock, chat-scoped Apply and Discard and the thread
draft-files list read `members` through `owner.threadId`. The runtime detects arrivals by AI operation identity (thread, turn, tool call), not group hashes or
byline changes. Its first attribution payload is the baseline and never pulses. Later unseen operations
pulse only the resolved footprints containing them, once per room runtime. A surface consumes the
runtime's arrival sequence; writer edits and regrouping cannot mint arrivals.

Undo of a Discard keeps the chat through restoration links (`restorations.ts`): every UndoManager that can
restore draft text (the editor's surface history, `room-discard`) registers `recordRestorations`, which on each
`stack-item-popped` copies Yjs's `redone` pointers (`restored range → original id`, for text, elements,
descendants, formats and attributes) into the draft's `__meridian_review_restored_v1` root.
Registration also wraps Undo/Redo in the manager's own transaction, keeping its direction flag set
through cleanup so the opposite history stack is filled. Prose and links travel together. The root is
outside the fragment-scoped history, is writer-writable, and persists with the draft. The classifier
follows chains with ID-range validation; neither source nor intermediate tombstones need survive GC. An Apply appends an Apply record to a server-owned root
of the draft doc in the same write that moves `review_base`, naming the items Apply moved into the base, so
applied AI text reads as base and a stale AI deletion no longer blurs a later point.
Discard preserves compatible text runs in place, including inline-atom paragraphs and low-similarity
reverts. Structural copies carry source links; only the remaining inserted IDs become three-number
base ranges in the restoration root, in the same text transaction. The fragment-scoped history does not
undo those records. Undo links (five-number tuples) take precedence and follow
their original source; deleting Discard's write-back later reads as a base deletion,
while Undo-restored AI text keeps its chat.

The runtime observes both provenance roots even with editors attached. Its attribution cache and
settlement reuse include a room provenance revision: a separately delivered restoration link or Apply
record republishes names and membership without a text transaction. Attribution reads carry an encoded Yjs snapshot (state vector plus delete set), captured with its pending AI parts in one read-only repeatable-read database snapshot. The classifier names unlisted inserted IDs as the
writer only inside that fence or from this browser's own client. Unlisted deletions require the delete
set fence, since deletion-only updates do not advance a state vector. Unknown evidence retains inclusive
membership and does not name the writer. Runtime refresh keys include snapshot identity, not group
content hashes, so equal-prose rewrites still refetch. Membership is loading, ready, or failed with Retry;
a cached payload alone is not proof of readiness. The requested evidence revision is separate from the
revision actually covered by the classifier. One read joins in-flight work and drains again if its
response leaves the latest frame unresolved. Three uncovered reads for a revision stop at failed;
Retry or new unresolved evidence starts a fresh attempt budget. Ordinary writer snapshots do not
request attribution: the browser's insertions and locally witnessed deletions are already resolved.
Unknown footprint item ranges beyond the payload fence, restoration/Apply root changes, and Retry
request reads; query mount/focus/staleness does not. Local deletion witnesses are runtime-owned and
never broaden the server's provenance fence. This bounds stale-success responses,
not just network errors, without relaxing the attribution fence.

The chat dock reads its files' rooms even while collapsed. Flat file readers publish into one keyed membership-summary owner; rows,
summary count and command targets read that owner. Unknown membership shows a neutral summary without commands;
known-empty files disappear unless they hold a failure, an in-flight command, Discard/Undo or an
overrode notice. Loading and read failures are not empty membership. Authoritative metadata `gone` is settled empty
membership immediately, even while the thread list still includes the file; it does not settle
commands or erase Discard/Undo and failure notices. A known-empty retained notice
never offers commands. A failed read opens the file's existing error/Retry row. Summary commands wait
until every listed file is ready, avoiding a silent partial chat Apply; individual ready-file changes
remain actionable. No file-count cap is used. A cold collapsed dock still acquires one room, metadata
read and attribution read per file; the SQL list is not a membership projection.

Every `ReviewChange` carries the frame it was listed from. A click acts on that
frame: Apply sends its snapshot, Discard finds its pin and content hash in the
current text and refuses when it cannot. Painting may be newer than chrome; that
never changes what a click on older chrome means.

## Inline paint continuity

Semantic IDs remain content hashes plus occurrence ranks, used by commands and navigation.
Render keys are editor-local, disposable hunk identities, never command authority. Match a
new hunk only to an unambiguous previous hunk at its mapped range, with block and ordinal
context; ambiguous splits/merges get new keys. The projection remains text-only.
Focus, pulse and fold state belong to the view, outside decoration equality. Stable widgets
update their text and labels in place. A consumed arrival never restarts on a repaint.

| Event | Semantic ID | Render key | Transient paint state |
| --- | --- | --- | --- |
| Typing inside / beside a change | Recomputed from text | Retain on unambiguous mapped overlap | Focus follows current semantic change; no arrival |
| Typing away from a change | Unchanged except occurrence ranks | Retain mapped hunk | Unchanged; no arrival |
| Enter / paste | Recomputed; may split or merge | Retain only proven matches; new keys for new shapes | No arrival from writer edits |
| Backspace empties a change | Change disappears | Retire | Retire its focus/fold paint |
| Remote AI write | Recomputed | Retain proven matches; new keys otherwise | Provenance arrival pulses once, consumed at DOM |
| Remote writer edit | Recomputed | Same mapping/matching rule; broad replacements may lose identity | No arrival |
| Undo / Redo | Determined only by resulting text | Match surviving hunks; resurrected hunks may get new keys | No synthetic arrival; retired fold state is not history |
| Discard / Undo Discard | Removed / restored by resulting text | Retire / match or mint | No arrival; Undo restores text, not paint history |
| Apply | Clicked snapshot/hash remains authority; base eventually advances | Retire applied paint | No animation or identity authority from optimistic hide |
| Caret / click / stepper focus | Unchanged | Unchanged | Toggle emphasis in existing DOM; slot may move independently |
| Arrival pulse | Unchanged | Unchanged | Consume without a class under reduced motion; otherwise add once and remove on animationend/cancel; rebuild does not replay |
| Fold / expand removal | Unchanged | Unchanged | Toggle existing widget and accessible label in place |
| Locale | Unchanged | Unchanged | Refresh widget labels; redraw permitted |
| Show changes off / on | Unchanged | Retain while hidden | DOM unmount/remount allowed; consumed pulse never replays |
| IME / mobile composition | Runtime may recompute | Map existing paint; defer replacement until compositionend | Defer view updates during composition |
| Reload | Recomputed from base and draft | Fresh editor-local keys | Reset focus/folds; initial attribution is quiet |

Mapped decoration sets survive ordinary transactions. On projection, retain equal mapped
decorations and remove/add only changed descriptors, rather than recreating the full set.
Composition deferral is a paint constraint, not a delay to editing or the review runtime.
PM can rebuild decorated wrappers during final composition cleanup with an unchanged EditorState;
the view hydrates these updates too, restoring semantic click targets and emphasis.
It also removes view-owned semantic attributes from nodes whose PM decoration has retired;
a move/Undo can preserve a DOM node after its render attribute disappears.
The view brackets DOM-only updates with ProseMirror's observer stop/start so they cannot be parsed
as manuscript edits. Ordinary cancelable `insertText` at a painted range uses the existing PM
`handleTextInput` chain before native DOM mutation: PM otherwise dirties/replaces a decorated text
wrapper even with equal decorations. Composition, paste, deletion, replacement input and a target
range different from the PM selection remain native. No input history decides review semantics.

## Discard

`draft-discard.ts` composes the clicked group, applies it to the draft blocks and
writes in one transaction under the editor's own undo origin, so that editor's
`Y.UndoManager` restores it with one Ctrl+Z. Discard draft sets the draft blocks
to the base blocks. A surface with no editor does the same through
`room-discard.ts` (`useHeadlessDiscards`): its own `Y.UndoManager` and a lease on
the room last until the row's Undo or the writer leaves. Only item Discard and
the Work page's Discard are server commands; they close the item or draft.

## Apply

Apply merges the change into live's current text. Scope `"change"` sends
`apply-changes` with the change ids and the `Y.encodeSnapshot` of the projection
the writer clicked, after the server holds every update it contains; scope
`"item"` sends `apply`. Apply all sends listed items with no snapshots (staging is
consent). One lifecycle per draft (`draft-command-record`,
`draft-command-executor`) serves every entry point; the claim is taken at the
click and a preparation failure lands on that draft's row.

- Changes leave the screen at the click, bound to the clicked frame. Ids are not
  identity: an entry or failure names a change by pin plus content hash, and a
  confirmed entry retires when the review's base differs from the clicked one.
- A failure restores the changes with the reason on them; an Apply still out
  keeps the draft "completing", never "No changes left".
- Failures are classified from typed status evidence, never message text.
  Unknown (sent without an answer) never reports success or closes a review.

## Draft-only lifecycle

A new document has server document/Yjs state without live catalog membership.
Its draft-only tab is not persisted and is the document's one workspace tab;
closing review does not discard the draft. Apply promotes through the existing
live presentation only when document, Work and draft match.
`DraftOnlySettlement` observes each represented Work independently of selection
and promotes a draft-only tab once the replica shows its document. It never
infers closure from a list omission or a gone/404 read; the item's own command
outcome removes the presentation. The dock persists its review address and one `reviews` entry, and
restore admits the address with the server.

## Durable decisions and verification

- [Diff-based review][editable]
- [Server command authority][authority]
- [Apply is done at server confirmation][confirmation]
- [Late peer recovery][late]
- [Runtime verification recipes](../../../../../../docs/qa/draft-review.md)

[editable]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/diff-based-review-is-the-draft-review.md
[authority]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/apply/command-outcomes-are-recorded.md
[confirmation]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-apply-done-at-server-confirmation.md
[late]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/late-peer-recovery.md
