# Write architecture

`write.ts` is a composition facade; each module owns one part of planning,
certification, application, receipt, or inverse behavior. The resolver→apply
currency is typed content, not Markdown strings or raw Yjs diffs.

## Codec and link pipeline

`@meridian/markup` parses source into block/mark nodes and serializes nodes back
to source. `AgentEditCodec` adds display hash prefixes at render time; a hash is
a sibling-unique targeting token, never durable identity.

Parse is pure syntax: links, images, and figures start with `ref: null`. The
command opens a host link scope, plans the write, prepares planned nodes, and
assigns refs before block alignment and no-op detection. Serialization uses the
same scoped codec. See [link correspondence](link-correspondence.md).

## Semantic IR and apply

The resolver emits `SemanticEditIRV1` bound to the input Yjs revision. Its output
partition is disjoint and exhaustive across preserved continuation, fresh
payload, copy, and certified restoration. Validation rejects stale revisions,
out-of-scope sources, overlapping/missing claims, uncertified restoration, and
invalid UTF-16 splits before mutation.

Plain same-block find lowers exact spans right-to-left in one adapter transform;
unmatched gaps retain their CRDT items. Formatted, escaped, atom-containing, or
cross-block finds use serialized-range reconciliation and structural lowering.
Scope replacement aligns compatible blocks, updates paired blocks in place, and
inserts/deletes only unpaired blocks. A no-op returns `unchanged` before a write
handle or journal row exists.

`applyEdits` mutates from typed nodes and returns ordered touched, deleted, and
inserted identities. It never parses or serializes. The write owner snapshots,
merges concurrent updates, and renders the echo. Echo targeting and deletion
anchors carry Yjs item identities, not display hashes: the same block can have
a different unique prefix among the room's siblings. Only the rendered cut
chooses the display hash. Preflight validates the full
IR and each block reference before a transaction changes Yjs. Deleting the only
remaining block clears its text while preserving the required ProseMirror
container.

## Prepared writes and receipts

Create, copy, and mutation commands share one `PreparedEdit` path. It reserves
a write identity, captures the before cut and ordered transaction parts,
certifies each segment, then stages or submits one logical edit. The command
submits merged `editParts`; host storage chooses journal row expansion. Receipt
rendering runs outside mutation certification and preserves settlement identity
when reporting degrades.

The forward-inverse primitive computes a new edit from immutable target parts,
certified restoration aliases, and the current view. Hosts persist parts under
an action ID and choose policy and destination. Card actions, model stack
commands, and failed-response rollback all use it; history rows are never
marked reversed and no historical UndoManager is rebuilt. Forward-write
attribution comes from explicit actor context and immutable receipts, never
transaction-origin identity. Model handles are reserved through
`UpdateJournal.reserveWriteOrdinal` before staging, and receipts retain those
ordinals independently of transport compaction. Certified aliases are the only
persisted restoration correspondence, never text or length guesses.

## Observation frontiers

`src/frontier.ts` is pure Yjs and host-agnostic. A frontier is a snapshot of
the doc a result was rendered from plus `unshown`: top-level block ids
(`client:clock`) changed since the previous frontier and not shown in full.
A block changed when an item in its subtree is visible at exactly one of the
two cuts; given containment those items are exactly the clocks born before
the previous cut and deleted since, plus the clocks born since and still
visible, so the fold visits only those structs plus one `Y.snapshot` walk
(about 4 ms at 440k structs). Containment needs every state-vector clock and
every deleted range of the snapshot: a delete-only staged update allocates no
clock, so the state vector alone accepts a refused staged deletion. An absent,
undecodable or uncontained previous frontier is the empty snapshot.

`planningSnapshot` validates the room and snapshot containment. `createPlanningView`
constructs an explicit gc-off snapshot target and replays the supplied reply updates;
either pending structs or pending delete ranges invalidates the view. These primitives
are not yet connected to the write door. `changedSince` and `changedWords` share the
same flipped-range walk; word counts clip each string item to the flipped clock range.

The host names rooms; agent-edit carries the label. When the host passes
`WriteContext.observe = { room, prev }`, read results and write receipts carry
a host-only `frontier` (`{ room, snapshot, unshown }`) from the doc they
rendered. An undo, redo or revert renders from the version the host's inverse
ran on, which only its result names (`DocumentEditResult.draftId`), so the host
passes `observeInverse(draftId)` and the echo records from the inverse's
`after` cut. With `ResponseCommitOptions.observe(documentId)` each saved
document's result carries one at the post-commit cut (`saveObservation`),
crediting what its accepted receipts show; journal-replay recovery leaves the
cut unknown and records none. Shown in full: a read's rendered blocks (an
outline read credits none) and `extent: full` changed blocks (never prefix context, copy
edges or swept bodies). A result reported with `awarenessDegraded` still
records, crediting nothing. A failure is reported through
`onObservationFailed` and the result goes out without one; `frontier` never
reaches `AgentEditResultV1`.

## CRDT and content boundaries

Resolver/apply code is CRDT-neutral through opaque `DocHandle` and `BlockRef`
ports. The v1 content currency remains ProseMirror nodes through
`AgentEditModel`; full ProseMirror removal is deferred in [TODO.md](TODO.md).

The write listener captures synchronous Yjs update events for one logical write,
including its own structs and deletes but not inherited tombstones. It detaches
before journal submission, synchronization, recovery, or failure. A state-vector
diff is not a per-write deletion delta. Live writes merge one update; draft
segments use fresh clients and keep independent logical writes separate unless
Yjs dependencies join them.

## Draft write granularity

One logical draft write may contain paragraph-level segments. Each segment is
one transaction with a fresh shared-protocol client; reply receipts and rollback
remain per tool call while storage expands segments into rows. Recognized
adjacent splits/merges and contiguous insertion/deletion runs stay one
structural segment. Sharing a paragraph alone never joins independent writes.
