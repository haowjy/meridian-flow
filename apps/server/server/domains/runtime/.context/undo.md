# Undo

Undo restores the history a compaction C replaced by appending a complete undo
marker U that opens a new prompt epoch on C's predecessor bake. It is a
queued `compaction_undo` control ([controls](controls.md)) and makes no model
call. Rationale and the provisional refusal policy (R-C6-2):
[Compaction Undo Restores History at a Named Epoch][kb-undo].

`loop/compaction-undo.ts` prepares and persists U and hosts the snapshot's
availability reader (`createCompactionUndoReader`).

A boundary expands consecutive due undos and may then execute a following
compact control. Reservation and terminal checks use that expanded list, not
only its head. Handoff seeds are outside the inbox and never participate in
undo expansion.

`compaction-undo.ts` prepares U over the restored raw history. Only the active,
local completed C is eligible. Runtime eligibility returns `not_active` for an
inherited target; the enqueue route rejects a target outside this thread with
`compaction_not_found` before execution. U reuses `bakeIdAt` immediately before C, owns a
fresh document-staleness pass, and measures the decorated restored request
against today's trigger. The sole refusal predicate implements Q2: reaching the
trigger is `would_recompact`. The baseline is the last assistant response before
C, never a response to C's summary. Model/bake mismatch, subsequent image eviction,
or an elision inside that response's prefix removes the baseline.

U has no reservation or model phase. Delivery inserts and completes it through
`beginPromptEpoch` in the same transaction as adoption, control acknowledgement,
and the next control/reply binding or lease release. Successful U is inserted
pending privately, then announced complete in the journal; readers never receive
a pending U. Inbox-only rows beyond U are planned after it, not folded into its
adopted prefix. An idle undo reserves no
assistant and admits no execution. A refused U has no blocks or bake; its reason
lives in typed undo metadata (`already_undone`, `not_active`, `would_recompact`,
`undo_failed`), while `turn.error` carries writer copy. The journal keeps the
existing undo error codes and includes the reason in error details.
A failed undo commit rolls back, then retries the delivery transaction with those
undo controls marked `undo_failed`; ordinary messages still continue.

Projection applies the active C's elisions to its retained tail, followed by the
latest complete U after C. U plans from raw blocks, including earlier U owners'
blocks but excluding replacements still owned by active C. A later C ends U's
ownership. Image inclusion selects the latest decision after filtering out all
reverted C owners from the same effective transcript. Fork cutoffs bound both.

## Availability advisory

The snapshot's `compactionUndo` names at most one divider and an
`availability`. The app offers Undo only where it reads `likely`, so undo is
effectively a manual-compaction feature: an autocompaction's restored history
usually crosses the trigger.

Snapshot availability is advisory and estimates the restored size from active
local C's `tokensBefore` plus growth since C, using the latest post-C assistant
response's input tokens relative to C's `tokensAfter`. A pending compaction
makes availability null. An error U refused as `would_recompact` keeps that
advisory when its recorded trigger matches today's trigger. Execution still
measures the fully restored request; a missing model catalog entry yields null
availability without hiding the durable snapshot.

[kb-undo]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/compaction-undo.md
