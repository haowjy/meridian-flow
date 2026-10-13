# Journal checkpoint coverage

Use an isolated, owned Postgres database and the production collab adapters.
These races cannot be timed reliably through the browser. Keep the executable
probe and stdout in the active work directory. Use the canonical dev DB helpers
to provision and drop the database. Previous executable probes are recorded in
the [checkpoint capture decision][checkpoint-decision].

## Admission before room apply

1. Create a document and bind an empty room to its durable authority.
2. Admit a writer update through `admitLiveWriterUpdate`, without applying it to
   the room. Confirm the room is still empty.
3. Store and drain the room checkpoint. Separately exercise the explicit
   checkpoint service at this same boundary.
4. Confirm a new persisted checkpoint covers the admitted sequence. Cold-load
   through the production loader and confirm every admitted word is present.
   A no-op checkpoint store must fail the persisted-coverage assertion.

## Capture and invalidation

- Capture inside an ambient transaction. Verify capture-owned advisory locks
  release before materialization, caller-owned locks remain, and concurrent
  captures do not roll back sibling work.
- Capture a cut, append another row, and materialize. Its ceiling must remain
  fixed; cold load must still replay the later row.
- Capture before compaction, both when compaction folds rows and when a routine
  or explicit checkpoint already covers them. Verify deletion and
  `retired_through_seq` publish atomically, including rollback. The old cut must
  fail materialization and both persistence doors, even if already materialized
  or waiting for the mutation lock. Recapture must preserve all text.
- Replace the authority generation. Verify retirement resets, old cuts cannot
  persist, and new cuts can. Document deletion must also invalidate old cuts.
- Spread-copy a cut and substitute bytes. Both persistence doors must reject the
  unrecognized capability.
- Invalidate a background room store through compaction. Observe
  `checkpoint.failed`, then request another store and confirm fresh capture and
  persistence. No automatic same-request retry is promised.
- Apply the generated retirement-column migration to populated heads in an
  isolated transaction. Verify row retention and zero defaults, then roll back.

Record the revision, exact commands, observed cold-loaded text, persisted
coverage, failure events, and cleanup. Run `pnpm check` separately; runtime
probes do not replace the gate.

[checkpoint-decision]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/concurrent-safety/journal/checkpoint-capture-from-journal.md
