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
merges concurrent updates, and renders the echo. Preflight validates the full
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
