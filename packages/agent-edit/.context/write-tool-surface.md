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

With `responseId`, create/insert/replace/remove plan on the view, echo on the
call's room copy and buffer the exact captured update and metadata in the
committer. Without it, the command is an immediate save (`saveNow`): it appends
and projects at once. The draft host instead runs such a write as a one-entry
reply, through the reply's save. Undo and redo are save boundaries: the host
settles buffered writes before executing an inverse.

Lifecycle ownership is exclusive:

- **Buffered** owns the mutable buffer and may stage or drop writes.
- **Committing** owns one immutable attempt and promise across append,
  projection, and recovery; concurrent callers join it.
- **Closed** records a bounded committed or rolled-back tombstone. Further
  operations fail. An empty unknown-response commit/rollback still closes the
  response so a late handler cannot reopen it.

The attempt records journal acceptance before reporting or projection. Before
acceptance, rollback drops the buffer; nothing else holds the speculative
state. After
acceptance, failures recover from the journal; rollback is not allowed to claim
that durable work vanished. A projection/report failure after durable acceptance
returns degraded awareness rather than ordinary unqualified success.

Phase-C apply snapshots around awaited concurrent detection and rechecks
immediately before synchronous `Y.applyUpdate`. Peer retirement revokes the
matching document epoch, including a room read bound before the first staged
write, and the revoked call is refused with the retirement's reason; it never
revokes a replacement peer. A host's room read that finds its bound draft taken
by a Discard throws `DocumentAccessLostError(reason)`, refused the same way.
`dropStaged` may mutate only Buffered state. Create cleanup is eligible only for pre-commit discard.

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

`interaction-mode.ts` owns mutation mode and its context. The mode and draft
generation are required end to end. Unexpected failures report safe identity
metadata to the observer and collapse to model-facing `internal_error`; observer
failures never alter mutation control flow.

The package calls its human locator `file`; a host may show a different path
name. Internal `documentId` remains storage/journal/runtime identity and is
never inferred from writer-facing prose.

## Deferred and testing boundaries

Command-version pinning, automatic read budgeting, generic actor attribution,
and a second implementation for frozen public ports remain deferred. Cross-block
find is supported through structural lowering. Package tests cover markup,
resolution, admission, receipts, response recovery, and forward inverses;
host tests cover placement, restoration, stack policy, and rollback.

Successful edits expose immutable `w<N>` handles to model tools. `read(format:
"edits")` pages those handles; undo/redo take counts and revert names one edit.
The host owns policy and notices, and handles do not reach the writer card.
Undo/redo stay on the inverse port, exempt from region checks. Revert is a
forward write through the ordinary grouped acceptance boundary: `region_changed`
when all passages are refused; otherwise a normal write echo plus any refused
passages from the saved cut. Unavailable source history is `cant_revert`; an
unknown handle is `invalid_write`; an empty plan is unchanged success. Edit
history offers revert for writes with cuts and names unavailable pre-cut history.
