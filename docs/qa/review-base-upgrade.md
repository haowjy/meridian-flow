# Review-base upgrade proof

A script-backed check that one `pnpm db:migrate` upgrades a populated train database (through `0047`, built from
#757's foundation fixture plus Yjs-seeded drafts, ensured and soft-deleted-Work drafts, edits with `action_id` and
`consumes`, `retired` and generation placements, `draft_commands` of every kind, and legacy pending, blocked and
zero-member `draft_tree` batches) to the diff-based review model. Not part of `pnpm test:all`.

```bash
DATABASE_URL=<local server url> pnpm --filter @meridian/server exec tsx scripts/prove-review-base-upgrade.ts
```

It creates `r4b_proof_*` databases on that server (cloned from one train database) and drops them at the end.
Assertions, each printed as `ok - ...`:

- the preflight refuses with batch ids and states before any migration applies, leaves schema and history identical,
  and the same command succeeds after the batches drain;
- one invocation: every `review_base` reads as its old `live_cut` text (or its own text when never written), draft
  text unchanged, `has_effect` recomputed, placements rewritten, new index definitions, the narrowed check enforced
  and validated, the six columns gone, `reviewed_*`, `pushed_at` and `journal_ids` kept, `draft_commands` and
  historical edit kinds unchanged, the dirty-log volume reported;
- a restored soft-deleted Work rebases on the converted base and the writer's deletion survives;
- a second migrate is a no-op; fresh and upgraded schema dumps are equal;
- a conversion interrupted after two rows, and 0052 cut at every statement, rerun to the same end state, with the
  placement check enforcing after every cut;
- the B3 guards fire when the step is bypassed; an unconvertible draft stops the run naming migration, step, branch
  and document ids, says to repair or recover the baseline, and the repaired run finishes.

Record the commit, date and the printed assertions in the active work directory.
