# collab — branch-backed document infrastructure

This page records the contracts that cross collab's Yjs, persistence, review,
and transport boundaries. The focused pages hold branch vocabulary, authority,
reversal, settlement, and WebSocket details; this page keeps their shared rules.

## Boundary and destinations

`CollabDomain` supplies Postgres/Hocuspocus adapters around
`@meridian/agent-edit`. Model reads and writes enter through the thread-peer
pool and carry an explicit destination. A `live` destination uses the live
core and creates no Work draft or thread peer; a `draft` destination uses the
thread-peer core and names its Work. Scratch and uploads are always live.

A reply may hold a live core and a thread core at once. Staged writes overlay
only reads of the destination to which they were pinned. A live read never
shows staged draft content. Rebinding is resolved again for each query; a
read-only draft query without a peer may pull live into the shared Work draft,
but does not create a peer.

The composition root wires required services and provider ports. It owns no
business behavior, mutable runtime state, or optional capability matrix.
`collab-facade.ts` only assembles the domain surface. Agent-edit owns the
memory-only mutation kernel; collab owns authorization, persistence,
coordination, settlement, and trail projection.

## Revision and review authority

`domain/document-revision.ts` produces a revision from the encoded Yjs
snapshot, holder URI, and sorted stored-link/image identities. It must include
both the delete set and the holder's link spelling: a state vector misses
pure deletion and a document snapshot misses tree-only moves. Reads and applies
compute the token synchronously in their prepared link scope; an unverified
recovery returns `null`, never a later read's token.

The review lives in the browser: a draft room projects `prosemirror` against its
server-owned `review_base` (`projectReview` in `@meridian/agent-edit/diff`). The
server stores no review operations, classes, tokens or evidence, and a review read
needs no repeatable-read snapshot. It answers item metadata (`roomName`, `isNew`,
`wholeItem`, `hasChanges`; a closed item is `gone`), the list (draft tree merged
with text branches, each row carrying the location token; live text moving never refuses), the commands, and the chat-attribution hint.
Apply is a content merge of the change the writer saw into live's current text.
Discard of a change or draft is a writer edit inside the room, undone by that
surface's Ctrl+Z, with no command. Apply is server-authored and has no Ctrl+Z. Only
item Discard and Discard all are kernel commands; they close branches and never
reset text from live.

Closing a branch retires only the peers whose upstream is that branch, after
commit. A fresh peer in the same thread and peers for other Works survive.
Thread-core invalidation is a post-discard side effect.

## Save, replay, and grants

The thread-peer pool is the only model document entry point. Each call carries
the caller's `FileGrant`; writes run under the grant scope and a reply pins a
document to its first grant. The response transaction saves all live and draft
journals, receipt records, and callbacks together. Live rooms publish only
after commit, so rollback is invisible to open editors.

A chat's write mode decides only where its new AI writes go; chats in
one Work may differ. A draft write never pushes itself live: a draft
that an auto-apply chat leaves behind, or another chat keeps writing, waits
there like a kept change, and the dock shows it. Switching a chat to
auto-apply touches no draft; Apply stays the writer's command. Branches carry
no push policy. Trail reconciliation consumes transactional dirty signals and
never publishes a draft. Active unapplied rows do not delay a terminal receipt.

A reply's save resolves exactly the peer each document was pinned to and
refuses that document stale when the pin no longer holds (closed peer, reset or
closed branch, closed draft). Peers are created only by pulls in an existing
draft, never by a save.

Save confirms every grant used by the reply once, drops writes whose Work lost
access, and marks the remaining writes for the journal's no-grant guard. A
write against a different version from the thread's last read returns
`read_required`. Model inverse commands use the current destination grant and
the immutable edit policy, not a legacy journal selection.

Prepared replay treats concurrent chat edits and writer deletions as Yjs peers.
A staged write is refused only on inverse evidence or a failed integration; text
that merely disappeared (a writer's Discard, a rebase) merges like any peer's edit.
Replay drops the rejected logical write and its later dependency closure, retains
independent writes, and reports the typed refusal in notices and receipts.

## Work mode and branch persistence

Live writer SET and agent writes routed to live never touch a pending Work draft:
the next rebase merges the live edit into it by content, keeping every draft change.
`./mf doc put --overwrite` is not that path: it deletes the document and creates a
new one at the same URI, and the new identity inherits no drafts.

A Work draft is shared by every thread editing the same document in that Work. A
text branch holds `prosemirror` and the server-owned `review_base`, shares no Yjs
lineage with live, and catches up by a three-way content rebase (base, live, draft)
on live's certified cut; only thread peers still pull the draft's Yjs state. Every
server write into a text branch (seed, rebase, Apply's base patch, late recovery)
goes through `writeBranchState`, computed against the state it compare-and-swaps
onto under the branch lease; a stored server-client delta replayed later is dropped
silently by Yjs. A late peer's stale frame is rebased onto the current text: its
surviving typing is recovered as paragraphs, and its stale deletions are never
replayed ([late-peer recovery][late-peer]). Draft Apply merges
content; no draft bytes reach live and the draft stays open.

Attribution is based on immutable journal provenance and dependency closure,
not text similarity or block proximity. Writer rows retain their identity.
Independent deleting edits remain independent when their insertion clients are
different; cumulative delete ranges from retained rows still participate when
they are genuine dependencies. Agent writes use fresh writer clients and
journal their own transaction deltas. Recognized adjacent structural runs may
share a segment, but sharing a paragraph alone never joins edits.

## Transaction and lock contracts

Pulls commit in their own root transactions outside a caller's response
transaction. A pull takes its branch leases before its root transaction and
keeps them through persistence. Live pulls snapshot before opening the root
transaction and re-read branch membership; thread-peer pulls lease the peer
and upstream together. A shared pull promise resolves only after commit. A
caller joining an in-flight live pull awaits one coalesced run that starts
after its call, since the in-flight snapshot may predate a writer edit it must
see. Pulls run after persisted live updates, on branch review room open and
reconnect, and at agent tool boundaries; room open awaits one before admitting
frames, and a failure is logged without aborting the connection.

Room loads read in the caller's transaction because that transaction may
already hold the authority head. Provisioning locks the canonical thread row
before committing the Work draft and peer in a root transaction, and the root
must not re-lock that thread. Referenced rows must be committed before a root
peer can reference them, so manifest identity and its live head commit in a
root transaction. Live manifest writes instead load the manifest in the
caller's transaction: during cold project bootstrap the project and source are
uncommitted and must roll back together, and no such path provisions a root
peer. Use `NO KEY UPDATE` where a root insert needs FK key
share against a caller-held lifecycle lock.

The practical lock order is: in-process leases, Work rows, draft row, sorted
namespace/advisory keys, then document locks in ID order. Never take a
namespace lock while holding a document lock; compute the complete namespace
set first and revalidate. Background timers remain armed across failed pulls;
only a committed run with no newer work may clear them.

## Authority, checkpoints, and derivation

A live document's authority identity and generation bind its loaded Y.Doc,
room, checkpoint, writer frame, Markdown replacement, and agent journal batch.
Persistence validates the binding under the document mutation lock and drops
stale bytes rather than relabeling them. Restore retires acquired handles and
rooms; late load or connection completion revalidates the binding. Sequence
bounds never authorize retired-generation history.

A checkpoint is a host-minted `CapturedCheckpointCut`, not a free state-vector
and watermark pair and not warm-room bytes. It covers every journal row at or
below its cut. Materialize outside the persistence lock, then revalidate
identity, generation, and retention under lock. Retention is tracked by the
head's generation-local retired-through sequence. A stale checkpoint returns
`stale_generation`; it does not manufacture a successful checkpoint ID.
Compaction exists but has no production caller, so live journal rows are never
deleted.

`domain/document-derivations.ts` is the sole projection pipeline for search,
listings, sizes, and the link index. It derives from a journal-locked durable
cut. Push completion derives in its ambient completion transaction, so trail,
projection, watermark, and settlement succeed or roll back together. Recovery
sweeps stale rows and retries failures without advancing certification; a
projection is never substituted for live Yjs when serving document content.

## Links and tree changes

Stored links and image sources carry stable `doc:` or `ahead:` identities;
Markdown does not. The scoped codec assigns or preserves those identities on
write and spells them from the current document tree on read. Moves and renames
therefore write no document bytes. Link extraction and revision hashing use
the same occurrence rules, and failed ahead-ref registration is repaired by
the derivation sweep.

Each concurrent-attribution preflight and final recheck uses its own upstream
cut. Baseline containment compares struct clocks and the delete set: equal
state vectors alone do not establish equality, so delete-only writer edits are
still attributed. The journal floor is a provisional, commit-bound cursor, never
a global maximum.

`document_links` is a hint from a certified cut, never link authority. Changing
the extractor bumps its version, and no second post-write publisher exists.

Chat attribution is a hint: the browser matches the AI edit parts pending in the
branch (`…/draft/attribution`) against the room to name chats on changes. Nothing
gates on it, and writer edits are never listed. A text branch's effect is base-versus-draft equality; manifest changes have their
own operations and never become prose hunks.

## Disposition and response retirement

An item whose draft equals its base is unlisted but stays addressable with its
room, history and next proposal; no empty-draft reset exists. Staged item Apply
compares its location token only at the staging check: staging is the consent
boundary. Cleanup failure after a committed disposition cannot reject the command.

Thread-peer publication applies ordered per-segment journal rows to a
provisional target clone and never regenerates durable Work journal rows from a
raw state-vector diff, which would reintroduce cumulative tombstones. An
unresolved sync dependency is an integrity failure, never a partially journaled
update. Manifest membership mutations still journal cumulative sync bytes
([#753](https://github.com/haowjy/meridian-flow/issues/753)).

Forward inverses append ordinary immutable journal parts with restoration
aliases. They do not rewrite target rows, mark them reversed, or use a reserved
undo client. Model `revert` is a new edit in the current destination, shown in a draft as a
change the writer applies. Stored `undo` and `redo` edit kinds remain readable
history; nothing writes them.

Response helpers are private to agent-edit's committer. Every tool and scoped
read obtains a prepare lease; reporting uses disposable replicas. Rollback
keeps the helper until transaction outcome is known. When a write cannot
integrate, the helper is replaced with the current generation plus surviving
stages before subsequent tool resolution; dropped writes are named once in the
next result. Whole Discard retires only the addressed peer and does not roll
back unrelated documents in the reply.

## Focused references

- [Branch model and durable records](branch-model-and-records.md)
- [Document authority, schema, and connection admission](document-authority-and-schema.md)
- [Reversal](reversal.md)
- [Push settlement and change trail](settlement-and-trail.md)
- [WebSocket concurrency boundary](websocket-concurrency.md)
- [Collab visual explainer](collab-domain.html)
- [Draft/live visual model](draft-live-model.html)
- [Deferred work](FUTURE.md) and [TODO](TODO.md)

[late-peer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/late-peer-recovery.md
