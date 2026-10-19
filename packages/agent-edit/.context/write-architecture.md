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

Create, copy, and mutation commands share one `PreparedEdit` path in
`tool/write-acceptance.ts`; `write-commands.ts` owns command planning. It runs the
region check first (below), registers the refs the write minted, reserves a
write identity, captures the before cut and ordered transaction parts,
certifies each segment, then stages or submits one logical edit. The command
submits merged `editParts`; host storage chooses journal row expansion. Receipt
rendering runs outside mutation certification and preserves settlement identity
when reporting degrades.

A prepared edit plan carries `groups: [{ edits, targets }]` and one semantic IR.
Targets are the unwidened block indexes on the planning document. Ordinary
mutations and overwrites supply one group; independent revert passages supply
several (no overlapping passage windows). Acceptance prepares the view/room
indexes and snapshots once, checks each group's window once, and applies all
accepted edits in one update capture. Certification and the stored IR omit
refused edits and their deleted lineage. Empty-document `blocks` creation
remains unchecked. No edits means unchanged-success; all groups refused means
one observed `region_changed` result with their current text in document order.
The ordinary single-group refusal's 16 KB read-instead limit is unchanged;
a grouped all-refused result shows every refused passage.

A partially accepted write carries `refusedPassages` as arrays of Yjs block
identities on its staged entry. `receipt.ts` renders those blocks from the
save's after-cut, after the accepted echo, in full `not_reverted` groups;
`result-text.ts` supplies the fixed “Not reverted” heading. Observation and
shown-link evidence use those same groups, so a refused passage shown at save
credits exactly its saved text. An immediate write renders the same groups
from its saved room cut. No staging-time body is carried into settlement.
If a save cannot render, it keeps the refusal but says current text is
unavailable; a rejected write includes that note in its refusal message
(the runtime preserves rejection messages, not rejected block groups).

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
The region check covers writes to it. Echo context lines and truncated previews
never credit by being shown; the listing and the region check cover them. A
write does credit the blocks it wrote when every visible item in them (the
block, its attributes, children, text and formats) is that write's own, by the
structs its committed update created (`frontier.ts` `writtenOnlyBy`): the model
sent that text itself, so a create's truncated preview doesn't refuse its next
edit. A block holding any other author's visible item credits only when shown
in full. A degraded echo credits nothing. A
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
Its one sentence says which: "Not applied: you haven't seen all of this passage
yet." for no frontier or an unshown region block, "Not applied: this passage
changed since you last saw it." for changed words; both end "Current text:".
Exempt (`Planned = "exempt"`, never `undefined`): creating a document,
initializing an empty one, and every write when the host passes no lookups at
all (a host that keeps no frontiers; utility, seed and import writes). A reply's
model write whose lookups lack `planning` is a host bug and throws. A document
this reply created (`ReplyMutations.created`, noted when a create lands in a
missing or empty document) plans from the empty snapshot plus the reply's own
mutations when the planning lookup has no usable frontier: the model knows it
began empty, so create-then-edit in one reply lands, and anyone else's text in
it still counts in the region check. Undo and redo are never refused. The
refusal shows the region's blocks in full from the room copy and goes through
the same recording as a read, so the next attempt proceeds unless the passage
changes again. Past
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
saved document's result carries one at the save's after-state, in the room the
save committed into, crediting what its accepted receipts show. A write outside
a reply records from its save's after state, merged into its room copy. A staged result records
nothing: its save does. Shown in full: a read's rendered blocks (an outline
read credits none) and `extent: full` changed blocks (never prefix context,
copy edges or swept bodies). A result reported with `awarenessDegraded` still
records, crediting nothing. A failure is reported through
`onObservationFailed` and the result goes out without a frontier or a listing;
`frontier` never reaches `AgentEditResultV1`.

### The accepted save's report

A save has three phases with separate owners: the host's durable append
(`persist`, inside the caller's commit scope), the host's install or delivery
after root commit, and agent-edit's report. Once `persist` succeeded the write
is accepted: `document-save.ts` `reportAccepted` is the one reporting boundary
for reply saves and immediate writes alike, and any failure in it (links,
revision, detection, receipts, frontier) answers an accepted
`awarenessDegraded` result, never an error. An error would leave the tool call
uncached and invite the model to retry a write that already landed; a degraded
result keeps its write identity for idempotency, and an immediate write still
appends its own bytes to the reply's `ReplyMutations`. Ensuring a created
document belongs to the durable phase.

### Commit-time detection

`commit-detection.ts` `reportAcceptedMutation(before, after)` is the same for
both hosts and every save, on the append's cut, and never throws: it reads the updates the save's before state holds
that the first write's view (`preOwnSnapshot`) doesn't contain, the only skip,
and applies them one at a time to record which lineage each first made visible
and who wrote it. That
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
