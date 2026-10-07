# Write tool surface

## Tool surface

`read()` and `write()` return host metadata plus one typed result:
`WriteOutcome { command, status, isError, result, … }` (`src/tool/types.ts`).
`result` is the versioned `meridian.agent-edit.v1` envelope. The model never
sees it as JSON: `renderAgentEditResult` (`src/tool/result-text.ts`) is the
only path to the model's text (a status line, notes, the message, then
`hash|text` blocks), and hosts keep `result` beside that text for history,
the app and code mode. Nothing parses the text back, and there is no second
text field. Block groups carry shared semantics as
`{ extent, relation, items: [{ hash, body }] }`, so multiline bodies cannot
collide with adjacent blocks without repeating metadata on every item. The only
group kinds are full `document`, `changed`, or `swept` bodies and prefix
`context` or `copied`; concurrent bodies and tombstones live under `concurrent.runs`, where
their placement already conveys the concurrent relation. Full and outline reads
derive diagnostic text and typed items from one batch serialization. Hashes are
model/tool targeting tokens: expose them in tool arguments and results, never as
labels or quoted prefixes in writer-facing prose unless the writer asks for
protocol detail.

The result lifecycle is discriminated: `status: "success"` requires
`phase: "staged" | "committed"`, while every non-success status excludes
`phase`. Hosts must use the exported `isAgentEditResultEnvelope` guard when recognizing
persisted results rather than inferring validity from the schema string alone.
`idempotency` is provided by `tool_use_id`, but provider tool ids are
response-local: cache and durable attempt ids scope them by `responseId`, or by
`turnId` when no response id exists. Same-response retries return the cached
outcome; a later response that reuses the same provider id must dispatch as a
new write.

### Response commit lifecycle

Passing `WriteContext.responseId` makes `create` / `insert` / `replace` / `remove` apply to
the session runtime immediately while `ResponseCommitter` buffers the exact
updates and mutation metadata that will be committed. Per-write echoes therefore
initially reflect cumulative response-local state; `commitResponse` returns
receipts recomputed against the settled projection for host publication. Without
a response id, the same command path appends and projects immediately. Undo/redo
never buffer, and they never save buffered writes either: the host treats a
`write` `undo` or `redo` as a save boundary and commits the reply before it, so
buffered writes at a reversal are an invariant error (`internal_error`).

Lifecycle ownership is exclusive: `Buffered | Committing | Closed`.

- **`Buffered`:** owns the mutable response buffer. Only this state may stage or
  drop writes. `commitResponse` atomically snapshots the buffer and transfers
  ownership to `Committing` before any asynchronous work begins.
- **`Committing`:** owns one immutable attempt and one promise across journal
  append, live projection, and recovery. Concurrent commit callers join that
  promise even after append has completed. The attempt records one acceptance
  value (`none | staged | durable`); observability phases derive from it instead
  of carrying a parallel lifecycle. Rollback is rejected while this owner exists;
  reporting rollback success while a commit can still persist would make the
  caller's cancellation contract dishonest.
- **`Closed`:** records a bounded `committed` or `rolledBack` tombstone. Further
  stage/commit/rollback calls fail. An unknown response id remains a valid empty
  commit/rollback because a model response may have issued no mutations, and
  that settlement still installs a tombstone so a late tool handler cannot
  reopen the response.

The mutation submission attempt records journal acceptance immediately after
append, before concurrency classification or live-projection reporting can fail.
The write boundary therefore restores speculative runtime state before
acceptance, but routes every failure after durable acceptance through journal
recovery. If destructive reporting cannot be rebuilt, the committed tool result
explicitly reports degraded awareness instead of presenting ordinary success.
State transitions verify the current owner before changing the map, preventing
stale async work from reopening or overwriting a closed response.

**Rollback and recovery follow the journal boundary.** While still `buffered`,
commit failure evicts speculative runtimes but leaves the response retryable;
rollback restores existing runtimes from live (and evicts runtime-only creates),
then closes `rolledBack`. Once a commit attempt owns the response, rollback is
rejected. A durable projection failure is therefore recovered by that commit
attempt through journal replay and runtime reconstruction. Successful recovery
is reported as a successful commit; failed recovery evicts runtimes, marks live
state stale, closes the durable response as committed, and still reports the
projection failure to the caller.
When last-resort durable recovery succeeds, the committer compares its immutable
pre-recovery snapshot with the recovered document through the same provenance
classifier used by normal projection. A detected writer-lineage loss is returned
with captured bodies as a late sweep; an unavailable recheck returns
`awarenessDegraded` and can never be laundered into plain committed.

Phase-C apply snapshots the coordinated Y.Doc before its awaited concurrent
detection and diffs it again immediately before apply. The final snapshot check
and `Y.applyUpdate` are a single synchronous block so unpersisted WebSocket edits
cannot enter an unreported gap.

`dropForThread` may mutate only a `buffered` response. Commit owns immutable
snapshots after that phase, so invalidation or hosted reversal cannot remove rows
mid-append or mid-projection. Dropped claims are either closed as `rolledBack`
when nothing remains or retained as `discardedClaims` alongside surviving commit
results; pending create cleanup remains visible through `stagedCreates`.

`commitResponse()` and `rollbackResponse()` report create outcomes for hosts
that created path placeholders before journal commit: committed creates keep
their path, while only pre-commit discards are cleanup candidates.

### Mutation outcomes

Every journal batch reports `"durable"` or `"staged"`. The owning commit attempt
stores that one acceptance value: staged failures return to `buffered`, while
durable failures enter journal recovery. The public `WriteOutcome.phase` remains
`"staged" | "committed"`; hosts must not treat a staged success as durable.
`discardedClaims` is returned directly by the owning committer and preserved by
the server response owner.

### Tool concerns

**One selector rule.** `tool/selector-rules.ts` owns which selectors `read`,
`insert`, `replace` and `remove` accept together: one of `in`, `around` or a
`#fragment`; `around` and `all` only with `find`; insert positions with
`after`, `before` or `find`; `remove` takes exactly one of `in` or a fragment.
The command schemas run it in `superRefine`, so hosts refuse a bad combination
before dispatch and the resolver never re-checks it. Field descriptions state
each rule, because refinements don't export to JSON Schema.

**Copies are nodes, not markup (D23, D24).** `insert`/`replace` take exactly
one of `content` or `from`, and `copy` creates a document from another. The engine
never reads the source: the host reads it with `WriteContext.includeNodes`
(the read returns `WriteOutcome.nodes`) and passes the blocks back as
`copiedNodes`. They are inserted as ProseMirror nodes, so blank paragraphs and
whitespace survive and every copy gets a fresh hash; a `replace` with `from`
reuses none of the replaced blocks. `copy` runs through `create`, so it stages,
rolls back and undoes like one. `tool/copy-rules.ts` holds the `from` rules.
A copy's receipt is bounded (`tool/copy-receipt.ts`): `copied: { from, blocks }`
plus, for a block copy, the first and last new block as a short `copied`
prefix group. The staged write keeps the summary so the settled receipt says
the same. An undo that leaves the document empty notes that it still exists.

`tool/interaction-mode.ts` is the sole owner of `mutationMode` and
`interactionContextForAttempt`. The mode (`"threadPeer"` plus
`branchGeneration`, or `"live"`) is required end-to-end.

Within a session, idempotency keys are scoped by response id, then turn id; with
neither, the session is the fallback scope.
`onIdempotencyHit` reports `{ toolUseId, scopeKind, scopeId, sessionId, outcome }`.
Unexpected dispatch failures call `onUnexpectedWriteError` with the original
cause plus safe command, document, session, thread, turn, response, and tool-use
identifiers before collapsing to the unchanged model-facing `internal_error`.
Response lifecycle observers receive explicit committer transitions; discarded
mutation claims surface through `onResponseClaimDiscarded` and
`ResponseCommitResult.discardedClaims`. Observer exceptions never change
mutation control flow.

**`documentId` vs package `file` / host locator names:** The host-independent
package command schema names its human-readable locator `file`; internal code
may call the parsed value `filePath`. A host may publish another model-facing
name. Meridian's server publishes `path` (for example,
`manuscript://chapter-2.md`), resolves it to an internal `documentId`, and
translates it to package `file`. `documentId` is storage/journal/runtime/coordinator
identity. Package diagnostics and re-sync hints echo the display `file` supplied
by the host. Tests should prefer UUID-like IDs plus friendly locators so
accidental UUID interpolation fails loudly.

## v1 simplifications (deferred, documented for discoverability)

- **Command-contract version selection and thread pinning** deferred (GH
  issue #68). This is distinct from the shipped `meridian.agent-edit.v1` result
  envelope. The seam stays clean through pure resolvers, stable `ResolvedEdit`,
  and a version-agnostic apply layer; no command-contract pinning is needed until
  a second command version exists.
- **Read auto-budget/truncation is not implemented.** Outline requires explicit
  selection and falls back to full selected content (reported as `full`) when no
  headings exist. Read results do not report changes since an earlier read.
  These limitations are tracked in [#523](https://github.com/haowjy/meridian-flow/issues/523).
- **Generic concurrent attribution** deferred to server adapter. `concurrent
  edits` reports `human` vs `agent` categories; no individual actor names.

- **Cross-block `find`** (find string containing `\n\n`) supported via
  structural lowering in the resolver. Routes to Tier 2+3.

## Testing

Package tests cover block-hash stability, markup round-trip, resolver with
cross-block find, 3-tier apply preflight + edge cases, echo computation, cold
undo/redo reconstruction (including the 8-case reconcile matrix, subset redo,
drift invariants, and availability), response
commit/recovery, and create lifecycle.

### Write handles and selective reversal

Every successful mutating result carries `write: { id: "w<N>" }`. The ordinal
is allocated per `(document, thread)`, persisted on the mutation row, and never
reused or renumbered by undo/redo. `WriteContext.tool_use_id` remains the durable
idempotency id in mutation metadata; `w<N>` is the model-facing range key.

Undo/redo use the same versioned result envelope as writes, with typed reversal
metadata and block records.

Undo/redo defaults to the latest write. The command surface also accepts one write (`to`), inclusive ranges (`since` + `to`; `from` always names a source), the last N writes (`last`; for redo, the N handles undone most recently), or all (`all`). Group atomicity and dependency closure can widen a selection; results list the handles actually reversed (`reversal.writes`). One dependency rule, `undo/journal-dependencies.ts`, decides both what `planUndo` offers (the receipt chip) and what the host's persisted undo accepts: a later row depends on a write when it anchors on, parents into or deletes what the write inserted, or anchors on what it deleted. An insertion inside agent text therefore blocks undo. Undo plans a selection at once; redo plans one undo group at a time, oldest undo first, and keeps going for `since`/`to`, `last`, `all` and turn selections. A reversal is `reconciled` only when its result differs from the text just before the reversed writes (undo) or the reversed undo (redo); a sweep alone doesn't make it reconciled. The cold reconstruction algorithm is unchanged except that its selected target is a set of write seqs rather than one turn id; non-selected and concurrent updates still replay untracked through Yjs UndoManager, preserving same-area merge behavior.
