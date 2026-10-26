# domains/projects — project and Work contracts

This domain owns project bootstrap, project persistence, Work metadata, and Work
lifecycle transitions. HTTP routes are adapters over owner-gated operations;
this page keeps the invariants that routes and context/collab must share.

## Bootstrap and project identity

`ProjectBootstrapRepository.ensureDefaultBootstrap(userId)` converges the
personal project, its Manuscript source, `chapter-1.md`, and locked No Work row. It creates no thread or membership. Ordinary
project creation creates its project-scoped Manuscript source, locked No Work,
and catalog lifecycle state, but does not seed the chapter document or
Work-owned sources. The canonical bootstrap URI is
`manuscript://chapter-1.md`.

Personal bootstrap and ordinary creation serialize allocation under the owner
lock. The project, initial source/document state, No Work, seed,
and readiness flag commit atomically. Chapter seeding is initialize-only and
uses canonical journal state, never the Markdown projection. Readiness is true
only after document authority is durable. Repeated bootstrap returns the same
logical bundle. The auth path trusts the durable readiness flag as its
lock-free fast path and retries an incomplete bootstrap transactionally; a seed
failure leaves no partial bootstrap and does not fail unrelated requests.
Legacy data repair belongs to a future import, never a process-local readiness
overlay.

Project handles are owner-scoped and stable across title renames; browser
project paths use UUIDs. Soft deletion reserves project, Work, and chat handles.
ID and slug lookup are exact and never fall back to each other. Ownership is
checked before deletion; missing, foreign, and deleted projects remain
unavailable to ordinary routes. Missing and foreign projects keep the generic
404 `Project not found`; an owned deleted project returns an attested 404
`project_deleted` with `details.authenticatedUserId` (same message for existing
unavailable and SSR paths), and the Work HTTP mapper preserves that proof
rather than replacing it with `work_not_found`. Explicit `includeSoftDeleted`
access still permits idempotent project Delete and independent context
availability reads on tombstones. The repository uses `name` and `systemPrompt`;
HTTP DTOs translate them to `title` and `description`.

WorkOS `external_id` is the automatic user identity key. Provisioning serializes
the exact email key before inspecting its owner; email collisions across
external IDs fail closed rather than merging accounts.

## Work operations

`WorkRepository` owns create/list/update/archive/unarchive/delete/restore.
`ProjectWorkAuthorityResolver` is the only projects-domain mint for opaque,
stable Work URI authority and offers exact same-project ID/handle resolution plus
transactional locking. `listWorkCatalog` owner-gates the requested collection
and serves each Work's stored pending count (`works.pending_document_count`, the
badge) from the same row as its revision; it counts nothing at read time.

`createWork` creates metadata without binding a thread or enqueueing Work
context. `updateWorkTransition` is the shared metadata policy for human PATCH
and `work.update`: lock the lifecycle row, refuse archived/deleted state,
normalize semantic fields, persist only real changes, and return exact
before/after facts. Archive only changes `archivedAt`; it never changes the
AI-owned status text. Delete and restore return exact state, including
concurrent no-ops, and publish Work access changes after real transitions.
Delete enqueues no Work context (its chats go with it); update, archive, and
restore do. Work mutation refusals map in one place (`lib/work-http.ts`): 409
`work_archived`, 404 `work_not_found` (missing or deleted), 409
`work_name_conflict`, and the app's copy for each code in
`client/query/work-update-failure.ts` changes in both places or neither. Work
collections nest under `/api/projects/:projectId/works`, items are flat under
`/api/works/:workId`, and a collection response never selects a Work
implicitly.

Work handles (`w1`, `w2`, ...) are minted per project from `project_handle_counters`
at creation and never reused. Rename preserves the handle; soft deletion releases
active name uniqueness but keeps the handle reserved. Names are labels, unique among
non-deleted Works.
Omitted or explicit-null root creation `workId` selects locked No Work. The
writer route and an edit Agent's `work switch` both use the canonical chat
rebind transition. The model path runs under its execution's existing claim;
the writer route acquires an exclusive claim.

## Lifecycle invariants

Lifecycle writes lock the Work row and publish `{ workId }` through
`FileAccessChanges` in the same transaction so Scratch, Uploads, and draft
rooms reconnect at their new access level. Work context mutations use that
same lifecycle lock. Archive, unarchive and restore lock no draft row
and bump no draft revision. Delete removes Work-owned documents through the tree
removal kernel, closing their drafts permanently; restore revives documents,
not those closed drafts. Collab's append keeps the Work predicate in its
row `UPDATE` and rechecks the lifecycle in a fresh read once it holds the row;
every other draft write takes the Work through the boundary below and so orders
itself against the transition. The window that leaves: a writer key whose
post-lock read ran before the transition committed and whose `COMMIT` came
after (finalization and inserts, a few milliseconds, however long it waited for
the row) lands in the archived draft; every later key is refused, and unarchive
admits the next. The window is accepted rather than a Work lock on every
keystroke (collab `.context/CONTEXT.md`).

Collab's lifecycle and structural branch and draft writes take Work rows only
through `adapters/work-projection-mutation.ts`, the Works mutation boundary: the
one owner of Work-first lock order (Work, branch, document, draft). A
transaction that locks a Work through the boundary recounts it at commit:
`lockWorks(set)` locks the set's Works (opening a branch, Apply's batch plan, a
reply save's grants), `mutate(set, operation)` is `lockWorks` then the write
(closing a branch through Discard, draft writes, the draft-effect projection).
At commit each locked Work's pending count is reconciled once (one SQL aggregate
over collab's membership rule, `WorkBranchPendingCounts`, however many locks the
transaction took) against the stored value, and only a Work whose count moved
gets a revision bump and a Works-changed notice. A write that leaves the count
alone sends nothing: the count is the only thing collab's writes change in a
Works snapshot. Apply's completion, which places draft rows and clears their
`blocking` under `lockWorks`, is covered the same way. `touchWorks(set, at)` is
activity (`lastActivityAt`: a turn, a document edit, Apply completion) and
always notifies; lifecycle and metadata writes notify directly. A writer
keystroke is an append and never enters the boundary, even one that moves its
draft in or out of review: the independent draft-effect projection runs after
every append (and its sweep after a crash) and reconciles through `mutate`
then. Because the comparison is
against the stored value, not a count taken before the transaction, a count an
append moved outside the boundary is still announced by the next reconcile
(the `effect-projection` probe's staging arm).

Work deletion soft-deletes primary chats and live Work context rows, marking
those children with `deletedByWorkId`. Branches and their drafts remain until
purge, so restore clears exactly the rows marked by that deletion; independently
trashed children remain trashed. A deleted Work cannot restore a child by a
separate path. Document and folder cascades advance location versions. The
deleted threads include subagent children; after the commit, `stopThreads` ends
each one's run and subagent subtree, its parked questions included.

Restore is available until `deletionPurgeAt(deletedAt)`; after that deadline it
returns HTTP 410 `work_restore_expired` even if the purge worker has not run;
references that retain a source Work extend storage retention, never the
restore deadline. Purge
processes eligible Works in batches, removes owned rows and blobs best-effort,
and disposes originated branches through collab's Work-branch disposal seam.
It tombstones hidden branch-created nodes before deleting branch rows. Purge also
removes lineage Scratch sources rooted in its purge set. Work delete never
marks lineage Scratch; it hides only through lineage liveness when the delete
trashes the last live member. A fork or handoff
that references another Work retains its source turns and bake; purge records
the retained dependency rather than cascading into that other Work.

Delete and purge lock the thread tree before the Work, then recheck the full
membership set; a concurrent join retries. Restore locks the threads carrying
that Work's deletion marker and clears exactly that set. A restored Work may
not clobber a reclaimed active name.
