# Write architecture

## Architecture

`write.ts` is the composition façade; behavior belongs in the module that owns
its concern.

### Codec pipeline
```
@meridian/markup: source string → unified parser → mdast → BlockCodec dispatch → MarkCodec dispatch → PM nodes
@meridian/markup: PM nodes → BlockCodec.serialize → MarkCodec.serialize → mdast → unified stringify → source string
```
Block hash prefix added by `AgentEditCodec.serializeBlock()` at render time (not stored as
attribute). In the built-in adapter the hash is derived from the adapter-internal
Y.XmlElement CRDT item ID (`clientID`, `clock`); the displayed prefix is unique
within the current sibling set and is not durable identity. Kernel callers see
only the neutral `BlockRef`.

### Ref assignment (`src/links/`)
Parse is pure syntax: every parsed link, `image` and `figure` has `ref: null`.
The handler prepares the host's link scope, the resolver plans the write
(`planWrite`), the handler prepares the planned nodes, and the plan assigns
their refs through the command's `WriteLinkAssigner` before block
alignment, so assigned nodes are the resolver→apply currency. Serialization
spells through the command's scoped codec (`tool/command-links.ts`). See [link identity](link-correspondence.md).

### Semantic certification and apply (`src/semantic-edit-ir.ts`, `src/apply/apply-edits.ts`)
The resolver emits `SemanticEditIRV1` bound to the exact input Yjs revision. It
declares scope and deletion ranges plus a disjoint, exhaustive partition of
each output into preserved continuation, fresh payload, copy, or certified
restoration. A whole-scope zero-continuation edit uses the distinct
`fullScopeFreshReplacement` intent. Validation rejects stale revisions,
out-of-scope sources, missing/overlapping output claims, restoration without a
retained certificate, and UTF-16 surrogate splits before mutation.

Plain same-block find (one or all matches) emits one `textRanges` edit with exact, ordered match
spans. The adapter adds those replacements back-to-front to one ProseMirror
`Transform` and projects each exact step inside one Yjs transaction. Unmatched
gaps therefore keep their CRDT items; the semantic IR partitions the replacement
window into fresh payload and `materialization: "retained"` preserved runs.
Retained gaps keep their original roots visible, so the write façade forwards
the whole IR and the provenance writer excludes those runs from its insertion
stream. Any non-retained continuation or restoration run in the same IR still
receives its provenance fact; fresh payloads remain agent-born by normal
insertion attribution.
Formatted and cross-block finds keep the serialized-markdown reconciliation path.

A scope rewrite (`replace` over `in`, a formatted or cross-block find, and
`create { overwrite: true }`) goes through `replaceScope`, which aligns the
scope's blocks with the parsed replacement (`resolver/block-alignment.ts`):
equal blocks get no edit; between them, blocks that may pair (same node type,
same heading level) pair by shared edge text first and by position after, and
each pair becomes a `block` edit that `updateYFragment` diffs in place,
attributes included. Only unpaired blocks are inserted or deleted, so a new
paragraph never takes over an edited one's element and comments. A write that resolves to no edits (a document's own export written back, or a
find replaced with itself) returns `unchanged` before a write handle is
reserved, so it journals nothing and leaves nothing to undo.
`weightedOrderedMatches` (`src/ordered-matching.ts`) is shared by alignment
and echo. Past the table limit, alignment pairs the gap by position; echo
falls back to block-identity diffing. Scoring and gap policy stay with callers.

Flat inline offsets exclude atoms (pictures, hard breaks), so `textRanges` edits
apply only to blocks without atoms; anything else is a `block` edit.

### Prepared edits and receipts (`tool/write-commands.ts`, `tool/receipt.ts`)

Create, copy and mutation planning feed one `PreparedEdit` finishing path. It
reserves identity, captures the before cut and ordered transaction parts, applies
and certifies each segment, then stages or submits one logical edit. Certification
runs inside each segment's own transaction before its fresh client rotates.
Restoration handles pre-acceptance failure; receipt rendering is outside it.
Creation ownership and its empty-document admission precondition stay explicit.

Commands submit one merged update with ordered `editParts`, not expanded journal
rows. The host storage adapter chooses row expansion (paragraph parts for a draft,
one update for live). Accepted before/after cuts feed the pure receipt renderer;
report failures preserve settlement identity and return degraded awareness.

### Edit application (`src/apply/apply-edits.ts`)
`applyEdits` owns mutation and returns ordered live touched IDs, deleted IDs,
and inserted IDs in insertion order, without rendering prose or building per-edit
summaries. The write/commit owner takes
its own snapshots, merges concurrent updates, and produces the final echo.
Preflight-before-mutate discipline: the write owner validates semantic IR,
then apply validates all block references. Each edit is preflighted (content
and offsets) before its transaction mutates the document.
ProseMirror nodes are the resolver→apply currency: `insert` carries its
`blocks`, `textRanges` replacements carry an inline `content` fragment, and
`block` carries its replacement node. The resolver parses each write once
(formatted finds parse their spliced range once); apply never parses or
serializes, so a node attribute the markup codec does not spell survives to
Yjs. Edit text (`insert.newText`, `textRanges.output`) is semantic-IR
provenance only. Every agent
text edit lowers through ProseMirror (`applyInlineReplacements`), the single
inline mutation seam. `applyTextEdit` remains as the
model's plain-text verb for undo repair and trims unchanged edge text before
touching Yjs.

| Kind | Mechanism |
|---|---|
| `textRanges`, or a matched block changes (`block`) | Adapter-owned exact inline ranges (`applyInlineReplacements`) or whole-block replacement + per-block updateYFragment |
| `insert` / `delete` | Adapter-owned block insert/delete (Y.XmlElement fragment ops in the built-in adapter) |

Last-block edge case: deleting the only remaining block clears text instead of
structurally deleting (the built-in adapter preserves ProseMirror `doc(block+)`
internally). Structural replacement inserts its new blocks before deleting old
parents, so a non-empty requested document never leaves a cleared trailing block.

### Forward inverses (`src/undo/`)

`forward-inverse.ts` computes a new edit from immutable target parts, durable
restoration aliases and the current view. The host persists its parts under an
action ID and chooses its policy and destination. Model stack commands, writer
card actions and failed-response rollback all use this primitive. Journal history
is never marked reversed, and no historical UndoManager is rebuilt.

Forward-write attribution comes from explicit actor context and immutable receipts,
not transaction-origin identity. Model handles are reserved through
`UpdateJournal.reserveWriteOrdinal` before staging; immutable receipts retain
those ordinals independently of transport compaction. Certified aliases are the
only persisted restoration correspondence, never text or length guesses.

### CRDT-neutral seam, ProseMirror content currency

The resolver→apply kernel is neutral across the CRDT axis: Yjs documents and
blocks are carried as opaque `DocHandle`/`BlockRef` handles, and resolver/apply
code asks `AgentEditModel` for identity, lookup, mutation, projection, and
serialization. That does **not** mean the package is ProseMirror-neutral.
`codec-types.ts` still aliases `Block = PMNode`, `ParsedContent` still transits
the kernel, and resolver code still inspects PM block shape (`type.name`,
`isTextblock`, heading attrs, body serialization). Full PM-out-of-kernel work is
deferred in [TODO.md](TODO.md).

### Per-write journal deltas

The write command captures the synchronous Yjs `update` events from content
application and semantic certification, then merges them into the logical write’s V1 update (and retains its ordered
segment updates for draft journal submission).
This includes that write's structs and deletes, not tombstones inherited from
earlier writes. The listener is detached before submission, peer synchronization,
or recovery, including on failure. Full snapshots remain the rollback and cold
reconstruction currency; a state-vector diff is not a per-write deletion delta.

Dependencies remain in the original Yjs references and client clocks. Independent
writes can be reviewed separately when their insertion clients differ. Live writes retaining one runtime still require same-client clock-prefix closure.
Draft writes rotate to a fresh client per segment and do not inherit that coupling.

## Draft write granularity

Flat same-type block rewrites lower to exact whole-word text splices when their
replay reproduces the target, including marks. The shipped policy is one paragraph per logical
write, not one paragraph across writes. A segment executes in one transaction with a fresh
shared-protocol client ID. One staged logical write holds its ordered updates;
receipts, rollback and before-snapshots stay per tool call. Journal submission
alone flattens those segments into rows. Live writes capture one merged update.

Recognized adjacent paragraph splits/merges and contiguous inserted or removed
block runs stay one structural segment. Alignment carries their boundary identity
into lowering; the segmenter consumes those recognized structural joins rather
than rediscovering correspondence.
Different logical writes remain separate unless their Yjs edits are dependent,
even when they edit the same paragraph.

Changed pairs never join each other through text correspondence. Only adjacent
unpaired blocks are split/merge candidates, fenced by kept blocks. Each boundary
checks whether the head's last word and tail's first word occur contiguously
in the unsplit paragraph, ignoring whitespace. Words include adjacent non-space
punctuation; fragments match by substring and any occurrence counts. On the
outward walk the already-joined middle piece is used whole. This boundary
recognition uses substring continuation, without LCS, subdivision or a cell
budget; block pairing separately uses `weightedOrderedMatches` with
`MAX_TABLE_CELLS`. Windows over 4,096 UTF-16 units join conservatively.
Structural joins and physical insert/delete runs close into union-find components.
Consecutive insertion
edits sharing an old anchor carry one ordered run; execution chains each through
the preceding insertion’s returned tail, in both live and draft destinations.
