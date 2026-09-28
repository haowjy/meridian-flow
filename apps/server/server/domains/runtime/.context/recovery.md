# Recovery: orphan repair and process lanes

Recovery separates work owned by a run lease from durable work owned by an
independent service. Rationale: [Process Death Turn Recovery][kb-process-death].

## Placeholder repair

`PENDING_PLACEHOLDER_ROLES` describes every pending transcript placeholder and
keeps `system` handoff seeds in the partial discovery index.
`RUN_OWNED_PLACEHOLDER_ROLES` is the repair-owned subset (`compaction` only).
`finalizeOrphanedTurns`, the placeholder lane in
`spawn/orphan-report-repair.ts`, `finalizeOrphanedPlaceholders`, and idle
materialization use the run-owned subset. They also repair dead primary
assistant turns. No repair path settles a pending handoff seed.

Run repair holds the destination thread lock and run claim. Expired lease rows
alone do not prove death. Recovered compactions settle through
`finalizeExecution` and record `interrupted/recovery`; late writer messages
stay unacknowledged and can be redelivered.

## Handoff brief recovery

The independent `handoff-briefs` lane pages pending handoff seeds from the
existing pending-placeholder index and calls `HandoffBriefs.launch`. A
process-shared session advisory claim admits one attempt per seed; dropping the
reserved database session releases its claims and aborts local workers. The
pending S row remains the durable record. `launches` bounds repeated crashes;
the third launch settles a poison seed as `interrupted/recovery`. A clean
shutdown abort leaves S pending and decrements the launch count for retry.

`app.ts` registers `handoff-briefs` alongside wake scan, orphan repair, report
publication, idle Work materialization and change-trail drain. Each lane starts
at boot and rearms after completion without overlapping itself. The wake scan
does not select destinations gated by pending handoff seeds. See
[handoff lifecycle](handoff.md).

Paid response rows held only in memory at process death are lost and cannot be
debited; the next claimed attempt may make a duplicate provider call.

[kb-process-death]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/runtime/process-death-turn-recovery.md
