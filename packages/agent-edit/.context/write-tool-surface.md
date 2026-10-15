# Write tool surface

The tool surface has one typed result and one rendering path. Keep lifecycle
ownership with `ResponseCommitter`; a successful staged result is not durable.

## Results and idempotency

`read()` and `write()` return `WriteOutcome` with the versioned
`meridian.agent-edit.v1` envelope. `renderAgentEditResult` is the only path from
typed result to model text; hosts retain the typed value beside the rendered
text and never parse text back. Block groups carry `{ extent, relation, items }`;
hashes are targeting tokens, not writer-facing prose labels.

Success requires phase `staged` or `committed`; non-success excludes phase. Use
`isAgentEditResultEnvelope` to validate persisted results. Provider tool IDs are
response-local: idempotency scopes by response, then turn, then session. A
later response reusing a provider ID is a new attempt.

## Response commit lifecycle

With `responseId`, create/insert/replace/remove mutate the session runtime and
buffer exact updates and metadata in the committer. Without it, the command
appends and projects immediately. `revert` is a save boundary: the host
settles buffered writes before executing an inverse.

Lifecycle ownership is exclusive:

- **Buffered** owns the mutable buffer and may stage or drop writes.
- **Committing** owns one immutable attempt and promise across append,
  projection, and recovery; concurrent callers join it.
- **Closed** records a bounded committed or rolled-back tombstone. Further
  operations fail. An empty unknown-response commit/rollback still closes the
  response so a late handler cannot reopen it.

The attempt records journal acceptance before reporting or projection. Before
acceptance, rollback can restore/evict speculative runtime state. After
acceptance, failures recover from the journal; rollback is not allowed to claim
that durable work vanished. A projection/report failure after durable acceptance
returns degraded awareness rather than ordinary unqualified success.

Phase-C apply snapshots around awaited concurrent detection and rechecks
immediately before synchronous `Y.applyUpdate`. Peer retirement revokes the
matching document epoch, including leases issued before the first staged write;
it never revokes a replacement peer. `dropForThread` may mutate only Buffered
state. Create cleanup is eligible only for pre-commit discard.

## Mutation and selector contracts

A journal batch reports `staged` or `durable`; the owning attempt stores that
acceptance value. Public phase remains `staged` or `committed`, and hosts must
not treat staged success as durable. Discarded claims remain in the response
result alongside surviving commits.

`selector-rules.ts` is the single selector policy. Commands accept one of
`in`, `around`, or a block fragment as allowed by command schema; `around` and
`all` require `find`; `remove` accepts exactly `in` or a fragment. Validation
runs before dispatch. Copies pass nodes from host read results rather than
reading source documents inside the kernel, so whitespace and blank paragraphs
survive and copied blocks receive fresh identities.

`interaction-mode.ts` owns mutation mode and its context. The mode (and an optional
`peerBranchId`) is required end to end. Unexpected failures report safe identity
metadata to the observer and collapse to model-facing `internal_error`; observer
failures never alter mutation control flow.

The package calls its human locator `file`; a host may publish a different path
name. Internal `documentId` remains storage/journal/runtime identity and is
never inferred from writer-facing prose.

## Deferred and testing boundaries

Command-version pinning, automatic read budgeting, generic actor attribution,
and a second implementation for frozen public ports remain deferred. Cross-block
find is supported through structural lowering. Package tests cover markup,
resolution, admission, receipts, response recovery, and forward inverses;
host tests cover placement, restoration, inverse policy, and rollback.

Successful edits expose immutable `w<N>` handles to model tools. `read(format:
"edits")` pages those handles; `revert` names one edit.
The host owns policy and notices.
