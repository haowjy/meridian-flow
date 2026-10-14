# Review-base upgrade proof

A script-backed check that one `pnpm db:migrate` upgrades a populated train database (through `0049`, built from
#757's foundation fixture (with its project's locked No Work row), #847's run-state migrations, plus Yjs-seeded drafts, ensured and soft-deleted-Work drafts, edits with `action_id` and
`consumes`, `retired` and generation placements, `draft_commands` of every kind, and legacy pending, blocked and
zero-member `draft_tree` batches) to the diff-based review model. Not part of `pnpm test:all`.

The subject is migrations `0050` to `0055` and the registered data step `review-base-conversion@1`
(`packages/database/src/migration-steps/review-base-conversion.ts`), which the runner executes between `0054` and
`0055`, whose first line carries its marker. The step turns each active `work_draft` branch's `live_cut` into its
`review_base`; `0055` drops the columns.

```bash
DATABASE_URL=<local server url> pnpm --filter @meridian/server exec tsx scripts/prove-review-base-upgrade.ts
```

The fixture seeds rows with explicit ids and revisions, so after the last seed the script advances every sequence
past its column's highest value (`advanceSeededSequences` in
`apps/server/server/test-support/foundation-upgrade-fixture.ts`): owned serials such as `push_lineage`'s, and the
free-standing `context_availability_generation_seq` and `context_namespace_observation_version_seq`. A database built
from this recipe by hand (a browser proof on the upgraded data) must do the same before the app writes to it.
Otherwise the first new push collides on `push_lineage_pkey`, and a restored Work's availability revision (say 3)
loses to a seeded head (7) under the client's monotonic rule, so the Work stays out of Active until reload (R5c U1).

Each run allocates a random prefix, `r4b_proof_<run id>_*`, for every database it creates (cloned from one train
database), never drops one it did not create, and drops only its own at the end. Runs can share a server.
Assertions, each printed as `ok - ...`:

- the preflight refuses with batch ids and states before any migration applies, leaves schema and history identical,
  and the same command succeeds after the batches drain;
- one invocation: every `review_base` reads as its old `live_cut` text (or its own text when never written), draft
  text unchanged, `has_effect` recomputed, placements rewritten, new index definitions, the narrowed check enforced
  and validated, the seven dropped columns gone (`document_edits.action_id` and `consumes`,
  `document_branches.generation`, `live_cut` and `discarded_state_vector`, `branch_write_journal.generation`,
  `push_lineage.branch_generation`; the script's assertion text says "six"), `reviewed_*`, `pushed_at` and
  `journal_ids` kept, `draft_commands` and historical edit kinds unchanged, the dirty-log volume reported;
- a restored soft-deleted Work (restored with SQL, not the Work lifecycle) rebases on the converted base through the
  pure `rebase()` and the writer's deletion survives. This proves conversion and a rebase. The restored Work's real
  restore and Apply on the new kernel is the R5c browser proof, not this script;
- a second migrate is a no-op; a fresh install passes the preflight and the step finds nothing; fresh and upgraded
  schema dumps are equal;
- a conversion interrupted after two rows, and 0054 cut at every statement, rerun to the same end state, with the
  placement check enforcing after every cut;
- the B3 guards (0055) fire when the step is bypassed, naming branch ids or unfinished batches, and destroy nothing; an unconvertible draft stops the run naming migration, step, branch
  and document ids, says to repair or recover the baseline, and the repaired run finishes.

Record the commit, date and the printed assertions in the active work directory.

## Last run

2026-10-14, branch `feat/dbr-train-e0f3` (the re-landing merged with train tip `e0f3467db`, #847's `0048` and `0049`
under our `0050` to `0055`): exit 0, **50 assertions passed**, the train database at `0049` (50 migrations applied),
no `r4b_proof_*` database left on the server afterwards.
