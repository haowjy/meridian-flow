# domains/projects — project and Work contracts

Work lifecycle is in the [archive and delete][archive], [lifecycle
fence][fence] and [pending count][count] rules.

## New-account bootstrap

A new account's default project, its locked No Work and its first `Chapter 1`
commit together with a durable readiness flag. Authenticated entry reads that
flag lock-free (`ensureDefaultBootstrapReady`), and only an incomplete workspace
re-enters the locked bootstrap: running it on every request made the warm path
pay for work it no longer needed. A failed seed leaves the flag unset for a
later repair and doesn't fail the request that found it.

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

Work deletion marks primary chats, result rows and the Work's context sources with
`deletedByWorkId`; restore clears exactly the rows marked by that deletion. A source's end is
its row's: the cascade writes no node, because the project's tree list is the only writer of
node rows and its replay follows the source. Branches and their drafts remain until purge, so
restore finds them. Purge ends the Work's branches through collab's Discard, which settles every
pending record of the Work; the documents it drafted are then in no view and context retention
releases them after its window. Purge also deletes the documents of the Work's own nodes before
their source rows go (the nodes follow the sources by foreign key).

Delete, restore, archive and unarchive take the project's tree list lock
(`shared/tree-list-lock.ts`) after the Work rows and before the namespaces, so the open Works an
admission reads under that key are current.

Work delete, and a receipt reversal that deletes a Work, ends each deleted
thread's run and subagent subtree, its open questions included, in the delete's
own transaction (`stopThreads`), before `lockWorkThreadTree` locks the tree's
rows parents first.

A lineage lock (`pg_advisory_xact_lock` on `draft-owner:lineage:<root>`) follows the
Work locks and precedes branch, list, namespace and document locks; the thread tree lock,
trash and restore take it too, because they change whether a lineage is live. Purge
also disposes the active branches of the lineages it deletes.
Delete and purge lock the thread tree before the Work, then recheck the full
membership set; a concurrent join retries. Restore locks the threads carrying
that Work's deletion marker and clears exactly that set.

[archive]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/work/lifecycle.md#archive-freezes-the-works-own-material
[fence]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-store-concurrency.md#an-owners-lifecycle-fences-its-drafts-through-one-boundary
[count]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-store-concurrency.md#pending-counts-announce-only-when-they-move
