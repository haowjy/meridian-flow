# Thread inbox controls

`MessageIntent` distinguishes directed `message`, context-only `notice`, and
runtime `control`. A control is not model-visible chat text. Its body is
`{ kind: "compact" }` or `{ kind: "compaction_undo", compactionTurnId }`;
commands are writer-only, not tools.

`PendingInboxItem.control` carries that body on control rows. `summary` is the
writer label ("Compact conversation" or "Undo compaction"). Snapshot pending state and
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

### Compaction undo

`ControlBody` accepts `{ kind: "compaction_undo", compactionTurnId: string }`.
It shares the controls route, idempotency and pending WS projection with compact.
Completed U is a system turn with `metadata.kind: "compaction_undo"`,
`revertsCompactionTurnId`, `controlMessageId`, a reused `promptBakeId`, and frozen
`elisions`. Refused U has no blocks or bake and puts its reason in `turn.error`.
The snapshot always carries `compactionUndo`: null, or
`{ turnId, availability: "likely" | "would_recompact" }`. Availability compares
C's pre-cut size with the current trigger; actual execution remeasures.
