# Collab — branch model and durable records

This page defines the durable vocabulary and provenance boundaries for Work
drafts, text branches, review items, and publication records. Do not use a draft
ID, branch ID, item key, or presented address interchangeably.

## Vocabulary

| Term | Meaning | Wire identity |
|---|---|---|
| **draft** | The Work's one active draft. Apply leaves it open; Discard all and purge close it. | `draftId` |
| **item** | One document's place in a draft, with or without a text branch (an empty create, a created image). | `itemKey` = `${draftId}:${documentId}` |
| **text branch** | The item's `work_draft` branch: a Y.Doc holding `prosemirror` (the draft text) and the server-owned `review_base`, plus the thread peers that fork from it. | opaque room name (`branchRoomName`) |
| **base** | `review_base`: live's text as of `base_revision`, the reference every change is measured against. | `REVIEW_BASE_FRAGMENT` |
| **change** | One group of the review projection (`projectReview`). The browser computes it; the server never stores one. | `changeId` |
| **command** | One idempotent writer Apply or item/whole Discard. | `commandId` |
| **presented address** | The writer's `{ workId, itemKey, changeId? }`; it names no branch. | review selector |

There is at most one active text branch per `(documentId, draftId)`. The server
resolves every item key through the identity module
(`domain/draft-review-identity.ts`); no caller accepts an ambiguous bare ID. A
new text branch for the same item after a close has a new room name and the
owner rebinds. An item with no text branch still resolves, lists and applies.

## Text branch and rebase

A text branch shares no Yjs lineage with live. `seedDraftState` writes live's
text twice as fresh items by the reserved server client
(`DRAFT_SERVER_CLIENT_ID`), once into each fragment. Only the server writes
`review_base` (`SERVER_OWNED_ROOTS`), so writer admission refuses an update that
touches it.

Every runtime write of a branch's state (writer admission, late-peer recovery,
the rebase, seeding, Apply's base patch, inverse admission) goes through the
branch store's `writeBranchState`: a compare-and-swap on the full prior state
that writes state, `has_effect` (`!blocksEqual(review_base, prosemirror)`) and
`base_revision` together or not at all. Never store a server-client delta and
replay it later: its struct ids collide with the next write of client 1 and Yjs
drops it silently.

The rebase (`domain/draft-rebase.ts`, reached from `branch-pulls.ts`) replaces a
Yjs pull for every text branch: a three-way content merge of base, live and
draft against live's certified cut, under the branch lease. It is a no-op when
live's revision does not advance `base_revision`, and it is fenced while a
settlement batch for the document is pending or blocked. Thread peers still pull
the draft's Yjs state, after the rebase.

**Late-peer recovery.** A writer frame authored before the peer got a rebase can
type into blocks the rebase removed or retyped. A stale frame is not current
intent: on text a rebase changed it contributes only its net surviving typing,
which writer admission writes as one ordinary `writer` journal row beside its
last known neighbour, green in review. The frame's deletions of rebased text
never apply, so a replayed delete set cannot erase newer writing. Containment is
checked first, so a clean reconnect is a no-op. A later stale frame never deletes recovered typing. Rationale: the
[late-peer recovery decision][late-peer].

## Lifecycle and publication

Draft capture, Apply and Discard require an active Work under the shared
lifecycle row lock and grant confirmation. Discard is one close-only kernel
(`domain/draft-discard.ts`): item Discard closes the item's text branch, Discard
all closes the draft, and neither resets text from live. Pending edit parts of a
closed branch become `discarded`. Peer rooms retire after commit, only for
branches actually closed. Work purge reuses the kernel. Writer-side Discard of a
change is an edit of `prosemirror` inside the room, not a command.

Draft HTTP routes share one Work-access check: a deleted Work is 404 before any
draft read or mutation, while an archived Work still permits review reads and
freezes its drafts. Replaying a committed push returns its durable receipt.

Apply and whole-item or whole-draft Discard are server commands, not client loops. Reusing a `commandId`
returns its recorded result. A per-change command on a whole-document-only item
refuses `whole_item`. A durable thread peer has no unpublished authored state
after reply finalization: its writes enter the shared text branch atomically. A
rebind closes the old peer and creates one in the new Work's draft.

## Membership

An item is listed (`isListed`) when the draft created its document, or it is an
edited item whose text branch has `has_effect OR blocking`. A text branch with
no effect stays addressable and unlisted, so its next proposal keeps the same
room, history and green. `listedItemRelation` is the predicate's one SQL twin;
the list, pending counts, Work projection and chat strip all read it, so they
cannot drift. Pending counts are distinct pending documents per Work.

## Provenance and attribution

Attribution comes from persisted branch rows and live journal metadata, never
from warm runtime maps, text similarity, or block proximity. Agent writes journal
their own transaction deltas; state-vector diffs must not recreate cumulative
tombstones as authored rows. The review does not depend on authorship: it is a
pure projection of the two fragments. Chat attribution is a hint matched in the
browser from pending AI edit parts.

A certified whole-block carry validates output length and one adjacent visible
replacement; partial or ambiguous matches fail closed. Restoration aliases come
from certified retained identities and exact anchors, and equal text is never
authorship evidence.

## Durable records and checkpoints

The live journal is the durable content source. `document_branches` stores
snapshots, `has_effect`, `blocking` and `base_revision`; `branch_write_journal`
stores branch write rows; `push_lineage` stores publication identity and a
content member's frozen request. The change trail is the sole durable publication
record; a `system:reconcile` row carries replay coverage without becoming a
semantic author or inverse target. `draft_commands` keeps one row per writer
command for the Work's lifetime.

Branch mutations are durable before Hocuspocus apply, broadcast, or ack. The
awaited admission path validates authority/generation, exact containment, and
fresh provenance, then appends under the branch snapshot; `onChange` does not
own branch persistence, and transport only authenticates, adapts peers and
delegates this ordering.

Checkpoints are a separate authority concern: a room release queues its
immutable binding and a worker captures a durable cut after the releasing
transaction commits. A dropped or late checkpoint costs replay time, never data.
Releasing a room never waits on a database lock.

A peer reconstructed from journal rows is integrable only after every row has
applied with no pending structs and no pending delete set.

[late-peer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/late-peer-recovery.md
