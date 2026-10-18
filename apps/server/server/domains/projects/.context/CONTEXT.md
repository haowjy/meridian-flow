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
stable Work URI authority and offers exact same-project ID/slug resolution plus
transactional locking. `listWorkCatalog` owner-gates the requested collection
and enriches it with one set-oriented pending-draft count read.

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

Work slugs are project-unique handles assigned at creation. Rename preserves a
slug; soft deletion releases active name uniqueness but reserves the slug.
Omitted or explicit-null root creation `workId` selects locked No Work. Only a
writer Chat rebind changes a chat's Work; model tools cannot rebind it.

## Lifecycle invariants

Lifecycle writes lock the Work row and publish `{ workId }` through
`FileAccessChanges` in the same transaction so Scratch, Uploads, and draft
rooms reconnect at their new access level. Work context mutations use that
same lifecycle lock. Archive, unarchive, delete and restore lock no branch row
and bump no branch revision. Collab's append keeps the Work predicate in its
row `UPDATE` and rechecks the lifecycle in a fresh read once it holds the row;
every other draft write takes the Work through the boundary below and so orders
itself against the transition. The window that leaves: a writer key whose
post-lock read ran before the transition committed and whose `COMMIT` came
after (finalization and inserts, a few milliseconds, however long it waited for
the row) lands in the archived draft; every later key is refused, and unarchive
admits the next (decision D30 Q3, collab `.context/CONTEXT.md`).

Collab's lifecycle and structural branch and draft writes take Work rows only
through `adapters/work-projection-mutation.ts`, the Works mutation boundary: the
one owner of Work-first lock order (Work, draft, document, branch). Its
`mutate(set, operation)` locks the set's Works, runs the write and touches every
Work of the set; the pending count is read only by the list and catalog
(`list-work-catalog.ts`). A writer keystroke is an append and never enters the
boundary, even one that moves its draft in or out of review: the independent
draft-effect projection writes `has_effect` later and touches the Work then.

Work deletion soft-deletes primary chats and live Work context rows, marking
those children with `deletedByWorkId`. Drafts and their branches remain until
purge, so restore clears exactly the rows marked by that deletion; independently
trashed children remain trashed. A deleted Work cannot restore a child by a
separate path. Document and folder cascades advance location versions.

Restore is available until `workPurgeAt(deletedAt)`; after that deadline it
returns HTTP 410 `work_restore_expired` even if the purge worker has not run;
references that retain a source Work extend storage retention, never the
restore deadline. Purge
processes eligible Works in batches, removes owned rows and blobs best-effort,
and disposes originated drafts through collab's Work-draft disposal seam.
It tombstones hidden draft-created nodes before deleting draft rows. Purge also
removes lineage Scratch sources rooted in its purge set. Work delete never
marks lineage Scratch; it hides only through lineage liveness when the delete
trashes the last live member. A fork or handoff
that references another Work retains its source turns and bake; purge records
the retained dependency rather than cascading into that other Work.

Delete and purge lock the thread tree before the Work, then recheck the full
membership set; a concurrent join retries. Restore locks the threads carrying
that Work's deletion marker and clears exactly that set. A restored Work may
not clobber a reclaimed active name.
