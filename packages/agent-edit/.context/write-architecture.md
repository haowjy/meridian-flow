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
applies the write to the room copy, and renders the echo. Echo targeting and deletion
anchors carry Yjs item identities, not display hashes: the same block can have
a different unique prefix among the room's siblings. Only the rendered cut
chooses the display hash. Preflight validates the full
IR and each block reference before a transaction changes Yjs. Deleting the only
remaining block clears its text while preserving the required ProseMirror
container.

## Prepared writes and receipts

Create, copy, and mutation commands share one `PreparedEdit` path. It runs the
region check first (below), registers the refs the write minted, reserves a
write identity, captures the before cut and ordered transaction parts,
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
undecodable or uncontained previous frontier is the empty snapshot: every block
is unseen, and nothing is listed as changed (the model saw no earlier version
to compare with).

`planningSnapshot` validates the room and snapshot containment. `createPlanningView`
constructs an explicit gc-off snapshot target and replays only supplied reply updates
contained in the room copy. Either pending store, or a final view whose structs or
deletions are not contained in that copy, invalidates the view. Every write
plans on that view (`write-commands.ts` `withPlanDoc`). `frontierDelta` and `changedWords` share the
same flipped-range walk; word counts clip each string item to the flipped clock range.

### The listing

Every result that shows document text (a read, a recorded write echo, a settled
receipt, a region refusal) lists under `concurrent edits:` the blocks changed
since the model's recording frontier that it doesn't show in full, unlabelled,
in document order (`observation.ts` `observeRendered`). The listing and the
recorded `unshown` are one computation over `frontierDelta`: listed blocks
credit as shown in full; past `CONCURRENT_LISTING_MAX_BYTES` (8 KB) the rest are
named by count ("N more blocks changed since you last saw them") and stay
unshown. Blocks removed since the frontier are listed on one line by hash,
without their old text; a write's own removals are named by its receipt and
left out. A full read lists nothing. Only blocks that **changed** since a usable
frontier are listed: a block `unshown` because the model never saw it (a
partial or outline read, or a first contact with no frontier) stays unshown and
unlisted, so successive partial reads don't carry the rest of the document.
The region check covers writes to it. Echo context lines and a create's
truncated preview never credit; the listing and the region check cover them. A
staged echo lists and records nothing: its settled receipt does, on the
document's last accepted receipt, where the host records the frontier.

### The region check

`region-check.ts` runs in `finishPreparedEdit` before anything is registered or
reserved. The region is the targets' window on the view (`echo.ts` `windowOf`,
the echo's ±1, overlaps merged; an insert's target is its anchor;
`create(overwrite)` of a non-empty document targets every block); in the room
copy it spans each window's surviving blocks and any top-level block inserted
between them. A write is refused (`region_changed`) when the room has no valid
planning frontier or the view is incomplete, when a region block is in the
frontier's `unshown`, or when more than `REGION_CHANGE_BUDGET_WORDS` (10)
changed words lie in the region between the view's cut and the room copy's.
Never refused: creating a document, initializing an empty one, a host that
passes no planning lookup, undo and redo. The refusal shows the region's blocks
in full from the room copy and goes through the same recording as a read, so
the next attempt proceeds unless the passage changes again. Past
`REFUSAL_REGION_MAX_BYTES` (16 KB) it names the first and last block, asks for
a read of that range, and records nothing. With no frontier and a target the
room can't place (`not_found`, `ambiguous_match`, such as a live hash in a new
draft) it says to read the document. The host records whatever frontier a
result carries, error or not.

The host names rooms; agent-edit carries the label. `readRoom` returns the
room it read (`draft:<workDraftId>`, `live:<documentId>:<generation>`; `null`
when the host has none) and nothing is resolved before the call. When the
host passes `WriteContext.frontiers = { recording, planning }`, read results
and write receipts carry a host-only `frontier` (`{ room, snapshot, unshown }`)
from the doc they rendered, chained from `recording(room)`; `planning(room)` is
the view a write plans on. An undo, redo or revert names the room its inverse
committed into (`DocumentEditResult.room`) and the echo records there from the
inverse's `after` cut. With `ResponseCommitOptions.recordingFrontier` each
saved document's result carries one at the post-commit cut, in the room the
save committed into, crediting what its accepted receipts show; journal-replay
recovery leaves the cut unknown and records none. A staged result records
nothing: its save does. Shown in full: a read's rendered blocks (an outline
read credits none) and `extent: full` changed blocks (never prefix context,
copy edges or swept bodies). A result reported with `awarenessDegraded` still
records, crediting nothing. A failure is reported through
`onObservationFailed` and the result goes out without a frontier or a listing;
`frontier` never reaches `AgentEditResultV1`.

### Commit-time detection

`captureConcurrentDetection` reads the room's updates that the first write's
view (`preOwnSnapshot`) doesn't contain, the only skip, and applies them one at
a time to record which lineage each first made visible and who wrote it. That
lineage is the swept classification's only input (until M3 replaces swept);
nothing from it renders. The draft host reads its Work draft's journal rows for
the generation, with no floor, and attributes the residual the journal can't
explain to the writer.

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
