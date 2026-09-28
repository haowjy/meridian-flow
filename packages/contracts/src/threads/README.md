# Thread inbox controls

`MessageIntent` distinguishes directed `message`, context-only `notice`, and
runtime `control`. A control is not model-visible chat text. Its current body
is `{ kind: "compact" }`; commands are writer-only, not tools.

`PendingInboxItem.control` carries that body on control rows. `summary` is the
writer label ("Compact conversation"). Snapshot pending state and
`inbox.changed` share the same schema. A queued control has no transcript
position. It is rendered at the transcript tail until a divider with
`metadata.controlMessageId` replaces it. An autocompaction may satisfy the row,
identified by `metadata.satisfiesControlId`.

Manual dividers use role `compaction`, `trigger: "manual"`, and ordinary turn
statuses: `pending`, `complete`, `error`, `cancelled`. A failed divider of
either trigger carries a typed `reason` and `phase` in metadata (crash recovery
is `interrupted` at `recovery`); the server's `CompactionFailureReasonCodec`
and `CompactionFailurePhaseCodec` in `threads/domain/turn-metadata.ts` own the
values. Its `turn.error` code stays `nothing_to_compact`, `context_too_large`,
`context_window_exceeded`, or `compaction_failed`, with the outcome in
`details`. Completed summary blocks carry `summary`, `tokensBefore`, and
`tokensAfter`. `pinnedRequestTurnIds` records every unanswered directed request
plus the newest writer request; ids may identify user or directed system turns.

See [the HTTP control API](../../../../docs/api/thread-controls.md) for enqueue
idempotency and withdrawal outcomes. Frontend commands and divider rendering
are separate from these transport contracts.
