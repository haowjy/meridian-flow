# Thread inbox controls

`MessageIntent` distinguishes directed `message`, context-only `notice`, and
runtime `control`. A control is not model-visible chat text. Its current body
is `{ kind: "compact" }`, `{ kind: "compaction_undo", compactionTurnId }`, or `{ kind: "handoff_brief", seedTurnId?: string }`.
The seed pointer is internal to handoff creation; public Retry omits it.
Commands are writer-only, not tools.

`PendingInboxItem.control` carries that body on control rows. `summary` is the
writer label ("Compact conversation", "Undo compaction", or "Write handoff brief"). Snapshot pending state and
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

Handoff seeds are pending `system` placeholders with current-turn kind
`handoff_brief` and phase `briefing`. The first seed is owned by its pending
control row, so crash recovery completes that same seed. Its custom block
carries frozen `modelText` and available/unavailable brief data. See
[handoff API](../../../../docs/api/thread-handoff.md).

### Compaction undo

`ControlBody` accepts `{ kind: "compaction_undo", compactionTurnId: string }`.
It shares the controls route, idempotency and pending WS projection with compact.
Completed U is a system turn with `metadata.kind: "compaction_undo"`,
`revertsCompactionTurnId`, `controlMessageId`, a reused `promptBakeId`, and frozen
`elisions`. Refused U has no blocks or bake; `metadata.reason` holds its typed
reason (the server's `CompactionUndoFailureReasonCodec`) and `turn.error` holds
writer copy.
The snapshot always carries `compactionUndo`: null, or
`{ turnId, availability: "likely" | "would_recompact" }`. Availability compares
C's pre-cut size with the current trigger; actual execution remeasures.
