# Collab — push settlement and change trail

This page records the single push pipeline and its durable settlement boundary.
Branch locks, live-document locks, journal admission, trail projection, and
completion fencing must remain ordered; no caller may publish a partial push.

## Push pipeline

`BranchCriticalSections` owns the keyed branch mutex. It deduplicates and sorts
branch IDs, then callers acquire live coordinator locks in document-ID order.
Do not make the mutex reentrant or split push and coordinator mutexes: either
hides or creates lock-order cycles.

Whole-branch and selected-row builders produce one candidate batch consumed by
the shared push pipeline. Locked preparation computes the diff from the live
cut; trail projection turns that diff into the sole durable publication
record. A typed branch generation supplies idempotency, not a second diff.

The transition captures the immutable LOCK-WS cut, admits concurrent rows
through the document mutation lock, and performs one snapshot CAS. It delivers
the committed replace-set to connected bare-document rooms only after the
completion fence reports applied or already applied. Delivery is a session hint,
not a durable outbox and cannot make a committed push fail.

Whole Apply publishes the current branch, including rows created after a
preview. Per-change Apply and Discard replay only complete selected classes and
require their displayed live revision, class identities, immutable member keys,
and server-vended admission evidence. A missing or changed selected class
returns typed stale/gone/incomplete refusal without mutation. Whole Discard is
unfenced. Selective Discard re-forks from live plus surviving rows and creates
no restoration edit. Success returns only after the settlement completion fence,
never after a durable outbox handoff.

## Trail and attribution

The change trail is the durable publication record. It carries document-scoped
Yjs block identities `{ clientID, clock }`, nullable before/after identities,
and authorized evidence for receipts and navigation. Display hash prefixes and
serialized prose are not durable identity. Before/After evidence is read-only;
receipt Undo/Redo is the reversal authority.

Trail detail authorization precedes detail materialization: each occurrence
resolves to available, deleted, or denied before any manuscript-bearing title
or prose is read. Denied occurrences disappear; authorized deleted anchors
keep their evidence under an explicit `anchorState`.

Trail rows persist every edit without classification. Missing sweep evidence
suppresses a live editor's elevation and never blocks Apply. Elevation goes
only to an authenticated connected editor, for their own overwritten
post-observation edits, and a push's admission identity never transfers AI
authorship to the admitting writer.

Apply retains original authored rows and appends a `system:reconcile` row for
causal replay coverage. The reconcile row is not a new author, inverse target,
or provenance shortcut. Immutable edit parts and certified restoration aliases
retain authorship across settlement. Trail projection must never infer an
owner from equal text, rendered position, or an ambiguous relocation chain.

Trail, receipt, journal disposition, publication, settlement, and turn-lifecycle
producers append dirty signals in their own transaction. Reconciliation follows
those signals through one semantic owner resolver under sorted aggregate locks,
then deletes exactly the signals it observed. Sequence allocation is not commit
order. Active drafts do not block reconciliation, but rollback-pending journals
and pending live settlements do.

Provenance admission is root-unit injective: one protected root unit has one
visible target, so divergent restoration or replication blocks rather than
granting deletion credit to either copy.

Push completion settles arriving ahead refs in its completion transaction. Draft
moves are not hidden-view moves: a draft can create, edit, and delete, while
location changes settle in the tree-store move transaction. Draft-held moves are
rejected because a document's address would depend on the view. An Apply arrival is
already at its final SQL address when completion calls the arrivals seam.

## Settlement and recovery

`PendingSettlementStore` owns pending/blocked/completed state, claims, backoff,
trail refinement, and fenced completion. Journal and staged-push admissions
join post-cut updates through one SQL seam inside the document-mutation
transaction. Root-effect materialization failure yields no swept elevation and
never becomes settlement authority.

Settlement takes the completion transaction's locks again before certification.
It rejects retired generations, stale ownership, and unexplained post-cut
changes. A transient failure stays pending and retries with backoff. Only a
known corrupt durable projection is blocking; other projection errors remain
retryable. Failure reports carry stable correlation IDs and diagnostic codes,
not manuscript content.

Recovery runs as an independent lane with bounded pages of actionable
settlements, owner keys, and outbox rows. It keeps its own root transaction,
uses a wraparound cursor, and acquires selected trail locks in sorted order.
Unfinished shells remain eligible after signal consumption.

## Undo-restored publication

Net live-to-draft hunks use the same clock attribution index as review. A
cancelled writer delete/restore must not add writer ownership to an AI-only
publication. Certified restoration aliases replay from journal metadata;
physical writer rows remain untouched. Apply trail and receipt keep the
originating AI turn, including during cold replay.
