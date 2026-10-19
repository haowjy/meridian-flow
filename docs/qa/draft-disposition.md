# Text-derived draft disposition

The [G1 runner](../../tools/qa/probes/draft-disposition/run.mts) drives the production
inverse and branch-Discard adapters against a new migrated PostgreSQL database.
It is an on-demand adapter probe, not a browser or HTTP Apply verification.

## Run

Start local PostgreSQL with `pnpm dev:infra` if needed, then:

```bash
pnpm exec tsx tools/qa/probes/draft-disposition/run.mts
```

The runner reuses the lock-free probe harness. It creates and always drops its
own `lfd_probe_*` database; it never targets the worktree database. It prints
one observation per action and finishes with `PASS G1 disposition and close`.
An assertion failure exits nonzero. No new test-suite case is registered.

## Required observations

- Revert an AI insertion removed by writer typing: `nothing_to_revert`,
  “discarded” in the explanation, and no text reinserted.
- Revert a deletion-only AI write before Discard: `success`, deleted words restored.
- Undo an applied AI write: `cant_undo_applied`.
- Revert that applied write: `success` in its originating draft, a pending review
  change and pending inverse receipt, with the live manuscript unchanged.
- Discard all across five drafts: all drafts closed with cause `discarded`,
  immutable parts and journal statuses exactly unchanged. Non-applied receipts
  read discarded; historical Apply evidence still reads applied after close.
- Revert on a closed draft: `nothing_to_revert` with discarded copy, live text
  unchanged, and no new immutable edit part. Historical readability never grants
  write admission.

Fixtures explicitly create the two review fragments following DV's fixture
pattern. They write immutable AI receipts and construct Apply records directly:
production fresh seeding and HTTP Apply belong to separate implementation lanes.
The legacy journal's required `draft_base_update_seq` receives fixture constant
zero, not a live-state subquery. This runner does not verify seeding or Apply.
Room delivery and catalog notifications are inert fixture ports; database
policy, inverse compute/commit, captured disposition and close are real.

## Browser confirmation

After running the adapter probe, start the owned branch's stack with `pnpm dev`
and discover its HTTPS routes with `pnpm portless:list`. Use a named
`agent-browser` session and the local development sign-in. Seed a Work with two
AI-edited documents using `./mf` and inspect that Work in the browser:

1. Open the draft, remove an AI insertion by editing, then ask the same chat to
   revert its write. The reply must explain that it is discarded; no text returns.
2. Make a deletion-only AI edit, then revert it before Discard. The words return.
3. Apply an AI edit. Ask Undo (refused as applied), then revert; the draft shows
   a pending change while a live manuscript view remains unchanged.
4. Make pending edits in both documents and click Discard all. Both disappear
   from the Work's pending list without rewriting their receipt history.

Capture and inspect screenshots of the relevant refusal, pending revert, and
empty list. Record any unavailable intermediate-lane controls as coverage gaps,
never a successful browser flow. Close only the named browser session and stop
only the stack you started. Store the date, commit, exact observations and
screenshot paths in the active work item's `b/g1/` evidence.
