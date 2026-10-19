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
Receipts retain immutable origins; current text and Apply evidence decide their
disposition. This runner does not verify seeding or Apply.
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

Also exercise model inverse history on a production fresh-seeded draft: replace
one passage, Undo back to the review base, then Redo. Redo must restore the edit
even though the Undo contributes no shown review change. Repeat with two edits:
Undo count 2, Redo count 3 must report only two available and change nothing,
then Redo count 2 succeeds. Use the same chat/Work and verify live stays untouched.
A failed reply's durable Undo or Revert must itself roll back and remain terminal
on retry; the existing inverse-rollback DB cases cover that error seam.

Capture and inspect screenshots of the relevant refusal, pending revert, model
Undo/Redo responses and empty list. Record any unavailable intermediate-lane controls as coverage gaps,
never a successful browser flow. Close only the named browser session and stop
only the stack you started. Store the date, commit, exact observations and
screenshot paths in the active work item's `b/g1/` evidence.

## Populated review cutover (0077–0081)

Prepare an owned database using the previous release, not SQL-only draft seeds:

1. Use `./mf` to create named Works and draft-mode chats with a mock-model Agent.
   Edit existing documents, Apply one of two independent changes, Discard the
   remainder, then edit the reset draft again. Apply another document and close
   its Work. Keep one Work active. Preserve one released creation as well.
2. In the browser, type into a draft and type at least 520 keys. Check that its
   checkpoint advanced and that a tail remains; save the acknowledged prose.
3. Fail one owned Apply's completion after staging. The accepted batch/member
   must survive. Preflight must refuse it with the drain instruction. Remove
   the fault, run the previous release with `DRAIN_APPLY_SETTLEMENT=1`, wait for
   that command id to read done/applied, then stop the old server.
4. Clone the stopped populated database through `cloneDatabaseForUrl`. In the
   clone, temporarily clear one active Work draft's cut: migration 0077 must
   refuse, and its ledger entry must remain absent. Restore the cut and retry.
5. Hold the second eligible draft row from another connection. Run 0078's
   companion in a child process, wait for the first row's revision to advance,
   then kill it. Release the hold and start two converter processes. Each
   eligible row must advance exactly once. A subsequent run must leave state
   bytes and revisions identical. Do not replace this with SKIP LOCKED scans.
6. Before and after retirement, compare every prose fragment, immutable receipt
   range, journal id/update, lineage receipt and command result. Check historical
   Apply entries on retained closed drafts and older generations, even when
   their items are absent from current text. Released bytes must remain empty.
   Run PR B's inverse readers on both sides of the drops; compare dispositions,
   refusal/skip copy and revert availability, ignoring only fresh action UUIDs.
7. Run EXPLAIN with the reader's actual pending-origin/draft-id predicate and
   agent filter. It must use `document_edit_parts_pending_origin_idx` without
   disabling sequential scans. Verify the active draft's `review_base` and
   writer-visible text through the app after cutover. An intermediate branch
   without room-backed review is a coverage gap, not a browser pass.

Run `pnpm check`, `pnpm test:db`, migration lint/history, Drizzle check and a
second schema generation (no changes). Keep raw logs outside the work directory;
record the populated proof and screenshots in the active work item. Drop only
owned clones, remove faults and fixtures, and stop stacks/browser sessions.
