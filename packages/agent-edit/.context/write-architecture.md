# Write architecture

`write.ts` is a composition facade; each module owns one part of planning,
certification, application, receipt, or inverse behavior. The resolver→apply
currency is typed content, not Markdown strings or raw Yjs diffs.

## Codec and link pipeline

`@meridian/markup` parses source into block/mark nodes and serializes nodes back
to source. `AgentEditCodec` adds display hash prefixes at render time; a hash is
a sibling-unique targeting token, never durable identity. `block-hash.ts` owns
the one address space: a seeded block hashes its live origin item and a later
block hashes its own item. Rendering and lookup use the same identities.

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

Create, copy, and mutation commands share one `PreparedEdit` path. It registers the refs the write minted, reserves a
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

`src/frontier.ts` stores the exact gc-off Yjs snapshot a result rendered and the host journal position captured with that cut. Snapshot containment checks both state-vector clocks and delete ranges; a state vector alone misses delete-only changes. `planningSnapshot` validates the room and containment, and `createPlanningView` reconstructs that cut before replaying the reply's own accepted mutations.

Every write plans on that view and merges its update into the current room. If no usable frontier exists, it plans on the current room. A Work draft's first write projects an exact live seed cut into revision 0. If live advanced between observation and seeding, revision 0 remains the planning base and the resolved cut carries the bounded live interval for attribution. The persisted frontier remains only the room, snapshot, and journal position; the live-to-draft bridge exists for that lookup only. Seed snapshots and immutable block origins make both cases possible; projection never gates the write. Legacy seeds without the added live state and position still plan from revision 0 and conservatively report its blocks as `unattributed`.

### The listing

Reads, immediate write echoes, and the last successful receipt of each document a save settles share one host lookup. Inverse echoes (`undo`, `redo`, `revert`) record a frontier but skip the lookup, so any change they list is `unattributed`. A cheap snapshot comparison skips it when there is no concurrent change. Otherwise the host reads only journal rows after the frontier position and through the rendered cut, without loading a reconstruction checkpoint. Work-draft journals use the same bounds; a projected first write also reads the live observation-to-seed interval. Missing or compacted rows leave an `unattributed` residual. Delete-only changes remain visible because comparison uses full snapshots. A reply's staged and already accepted updates are supplied as its own writes, so a later read does not report them as concurrent work.

Concurrent blocks are grouped by evidenced author. Human journal rows render as `the user`; agent rows render as `agent (cN)` or `agent (pN)`, and as `agent` when their handle cannot be resolved. Changed state that no retained row explains renders as `unattributed`. The listing stops at 8 KiB of UTF-8 and names the rest as `N more changes`. A changed block already shown in full is named by hash without repeating its body; removed blocks are named by hash. Full reads can therefore include hash-only groups for changed blocks they just displayed.

### Offline writes merge

An unscoped find normally resolves on the planning view. If its observed block disappeared, the resolver tries the current document and preserves ambiguity checks; an explicitly held deleted block still returns `not_found`. A missing find, missing document, malformed selector, or ambiguous selector keeps its existing status. Concurrent changes and partially read text never refuse a write.

The host names rooms and records frontiers as `{ room, snapshot, position }`. `readRoom` returns the room and journal high-water mark for the same cut. Immediate echoes use the save cut's position, and settled receipts use the accepted append cut. A staged echo records nothing; its save records the frontier. Reporting failure never changes whether the write landed.

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

Forward-inverse receipt capture uses the canonical lineage range algebra through
field adapters; retained item-span lookup stays in `yjs-mutation.ts`. It normalizes
update spans as ranges. It removes
cross-part insert/delete transients range-wise, then intersects each range with
the retained `prosemirror` item structs; other roots and GC structs never expand
into per-clock identities. The published effects remain clock-ordered, deduplicated
and adjacency-merged, including items nested under the prose fragment.

## Draft write granularity

One logical draft write may contain paragraph-level segments. Each segment is
one transaction with a fresh shared-protocol client; reply receipts and rollback
remain per tool call while storage expands segments into rows. Recognized
adjacent splits/merges and contiguous insertion/deletion runs stay one
structural segment. Sharing a paragraph alone never joins independent writes.
