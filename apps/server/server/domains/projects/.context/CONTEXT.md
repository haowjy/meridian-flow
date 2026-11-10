# domains/projects — project and Work contracts

Work lifecycle is in the [archive and delete][archive], [lifecycle
fence][fence] and [pending count][count] decisions.

## Work operations

Archive only changes `archivedAt`; it never changes the AI-owned status text.
Delete enqueues no Work context, since its chats go with it; update, archive,
and restore do.

Work mutation refusals map in one place, `lib/work-http.ts`, and the app's copy
for each code in `client/query/work-update-failure.ts` changes in both places or
neither.

## Lifecycle contracts

Lifecycle writes lock the Work row and publish `{ workId }` through
`FileAccessChanges` in the same transaction so Scratch, Uploads, and draft rooms
reconnect at their new access level. Work context mutations use that same
lifecycle lock.

Work deletion marks primary chats and live Work context rows with
`deletedByWorkId`. Branches and their drafts remain until purge, so restore
clears exactly the rows marked by that deletion. Purge tombstones hidden
branch-created nodes before deleting branch rows.

Work delete, and a receipt reversal that deletes a Work, ends each deleted
thread's run and subagent subtree, its open questions included, in the delete's
own transaction (`stopThreads`), before `lockWorkThreadTree` locks the tree's
rows parents first.

A lineage lock (`pg_advisory_xact_lock` on `draft-owner:lineage:<root>`) follows the
Work locks and precedes branch, namespace and document locks; the thread tree lock,
trash and restore take it too, because they change whether a lineage is live. Purge
also disposes the active branches of the lineages it deletes.
Delete and purge lock the thread tree before the Work, then recheck the full
membership set; a concurrent join retries. Restore locks the threads carrying
that Work's deletion marker and clears exactly that set.

[archive]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/work/lifecycle.md#archive-freezes-the-works-own-material
[fence]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/work-lifecycle-fences-drafts.md
[count]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/works-notice-follows-pending-count.md
