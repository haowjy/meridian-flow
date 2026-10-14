# Review-base upgrade proof

A script-backed check that one `pnpm db:migrate` upgrades a populated train database (through `0047`, built from
#757's foundation fixture plus Yjs-seeded drafts, ensured and soft-deleted-Work drafts, edits with `action_id` and
`consumes`, `retired` and generation placements, `draft_commands` of every kind, and legacy pending, blocked and
zero-member `draft_tree` batches) to the diff-based review model. Not part of `pnpm test:all`.

The subject is migrations `0048` to `0053` and the registered data step `review-base-conversion@1`
(`packages/database/src/migration-steps/review-base-conversion.ts`), which the runner executes between `0052` and
`0053`, whose first line carries its marker. The step turns each active `work_draft` branch's `live_cut` into its
`review_base`; `0053` drops the columns.

```bash
DATABASE_URL=<local server url> pnpm --filter @meridian/server exec tsx scripts/prove-review-base-upgrade.ts
```

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
- a conversion interrupted after two rows, and 0052 cut at every statement, rerun to the same end state, with the
  placement check enforcing after every cut;
- the B3 guards (0053) fire when the step is bypassed, naming branch ids or unfinished batches, and destroy nothing; an unconvertible draft stops the run naming migration, step, branch
  and document ids, says to repair or recover the baseline, and the repaired run finishes.

Record the commit, date and the printed assertions in the active work directory.

## Last run

2026-10-14, branch `feat/dbr-kf6` at `341b71486` on the renamed `0050` to `0053` chain: exit 0, **49 assertions
passed** in 63 s, no `r4b_proof_*` database left on the server afterwards. **Provisional:** KF4 removes
`document_branches.rebase_cuts` and regenerates `0048` to `0053`; the final proof is re-run in R5c after that merges.
