# Thread inbox controls

`MessageIntent` distinguishes directed `message`, context-only `notice`, and
runtime `control`. A control is not model-visible chat text. Its current body
is `{ kind: "compact" }` or `{ kind: "handoff_brief", seedTurnId?: string }`.
The seed pointer is internal to handoff creation; public Retry omits it.
Commands are writer-only, not tools.

`PendingInboxItem.control` carries that body on control rows. `summary` is the
writer label ("Compact conversation"). Snapshot pending state and
`inbox.changed` share the same schema. A queued control has no transcript
position. It is rendered at the transcript tail until a divider with
`metadata.controlMessageId` replaces it. An autocompaction may satisfy the row,
identified by `metadata.satisfiesControlId`.

Manual dividers use role `compaction`, `trigger: "manual"`, and ordinary turn
statuses: `pending`, `complete`, `error`, `cancelled`. Failure reason metadata
is `nothing_to_compact`, `context_too_large`, `compaction_failed`, or
`interrupted`. Completed summary blocks carry `summary`, `tokensBefore`, and
`tokensAfter`. `pinnedRequestTurnIds` records every unanswered directed request
plus the newest writer request; ids may identify user or directed system turns.

See [the HTTP control API](../../../../docs/api/thread-controls.md) for enqueue
idempotency and withdrawal outcomes. Frontend commands and divider rendering
are separate from these transport contracts.

Handoff seeds are pending `system` placeholders with current-turn kind
`handoff_brief` and phase `briefing`. The first seed is owned by its pending
control row, so crash recovery completes that same seed. Its custom block
carries frozen `modelText` and available/unavailable brief data. See
[handoff API](../../../../docs/api/thread-handoff.md).
