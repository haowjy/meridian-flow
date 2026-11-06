# Text-derived draft disposition

The [draft-disposition runner](../../../../../../../tools/qa/probes/draft-disposition/run.mts)
drives the production inverse and branch-Discard adapters against a new
migrated PostgreSQL database. It is an adapter probe, not browser or HTTP Apply
verification.

## Run

Start local PostgreSQL with `pnpm dev:infra` if needed, then run:

```bash
pnpm exec tsx tools/qa/probes/draft-disposition/run.mts
```

The runner creates and drops its own `lfd_probe_*` database, prints one
observation per action, and exits nonzero on failure.

## Required observations

- Revert an AI insertion removed by writer typing: `nothing_to_revert`,
  discarded explanation, and no text reinserted.
- Revert a deletion-only AI write before Discard: `success`, with deleted words
  restored.
- Undo an applied AI write: `success`, reported as reverted in its originating
  draft, with a pending inverse change while the live manuscript stays unchanged.
- Discard all across five drafts: every draft closes with cause `discarded`,
  immutable parts and journal statuses stay unchanged, and historical Apply
  evidence remains `applied` after close.
- Revert on a closed draft: `nothing_to_revert`, discarded copy, unchanged live
  text, and no new immutable edit part.

The runner creates review fragments, immutable AI receipts, and Apply records
through production adapters. Receipts retain immutable origins; current text
and Apply evidence decide disposition. Production seeding and HTTP Apply are
separate checks.
