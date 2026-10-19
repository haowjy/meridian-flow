# Document removal records

This recipe covers the removal record, not removal admission or room retirement.
Run it on a disposable stack. Use `./mf` for server setup/readback and finish
by deleting a document in the browser. The record lookup is owner-gated through
`POST /api/projects/:projectId/context/availability`.

## Populated upgrade (0069 to 0072)

1. Dump a populated 0069 database into a **new scratch database**, never another
   checkout's database. It needs a user, project, manuscript source and Work.
2. Run `tools/qa/probes/document-removal-upgrade.sql` with `psql -w -v
   ON_ERROR_STOP=1` against the scratch copy.
3. Run 0070 transactionally, 0071 **without a transaction**, then 0072
   transactionally. Re-run 0071.
4. Read the four `a1-` documents: tree and both cascade rows must be `deleted`;
   the hidden end-use row must be `discarded`. Cascade takes precedence over
   hidden. Read `a1-active`: closed, `document_removed`, revision 18 (was 17).
   Read `a1-closed`: closed, `discarded`, revision unchanged. The current
   generation's pending part must be exactly `{"kind":"discarded"}`; the older
   generation's part must remain pending. Its tree-use row must be absent.
5. Confirm another 0071 run changes none of those values, and remove the scratch
   database.

The migration fixture is retained because the upgrade transforms persisted
writer data. No additional unit case is needed for these recipe-covered risks.

## Current producers

- Create and delete a document with `./mf doc put` and `./mf doc rm`. Read
  `documents`: reason `deleted`, authenticated writer in
  `deleted_by_user_id`, no Work marker or system cause.
- Create a draft through a draft-mode chat, then use Discard all. The hidden
  created document must have reason `discarded` and that writer's ID, never
  `deleted_by_work_id`.
- Create Scratch in a named Work. Delete that Work: reason `deleted`, Work
  marker set. Availability must say `authority-unavailable`, not independent
  deletion. Restore the Work: all removal fields are null.
- Move a file over another with overwrite: the victim records `deleted` and
  the writer; the moved document remains living.
- Retract a create after a failed write and after reply rollback: reason
  `discarded`, system causes `create_failed` and `reply_rolled_back`.
  A prior completed tool response followed by Stop is **not** this scenario:
  the prior response has already saved.
- Seed an unused hidden document, then create at its path; separately invoke
  read-triggered hidden-node repair. Both old identities must record
  `discarded` with system cause `repair`.

Read removal records through `DocumentRemovals.lookup`: only tombstones
appear, actor names are current, unknown historical actors remain null.
Instantiate `DocumentRemovedError` with one result and check it retains the
same document ID and record. The optional availability `removal` is filled
only on identities its existing view exposes: hidden tombstones are currently
not visible, even to the branch view after its tree-use row is gone.

## Browser finish

Sign in, create/open a document, delete it using its Files menu, and confirm
the tab/tree update without an error. Capture a screenshot outside this repo.
The removal notice and terminal 4208 client behavior belong to E2's client
lane; this record-only change does not claim to implement them.
