# client/chat-submissions

The account-stamped journal of unresolved chat submissions: the local witness
that lets a reload reconcile or replay a displayed send
([send lifecycle][send]). `owner.ts` is the sole owner of writer rows, attempts,
recovery status and draft transfer; a second presentation owner lets panes
disagree about one row.

- Bind with `setUser(accountId)` only. Another account reads nothing, and
  switching accounts away and back keeps the first account's records.
- Persist the exact validated authoring snapshot (blocks, references, skills,
  creation inputs). Replaying from text alone loses references.

Contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md).

[send]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/composer/send-lifecycle.md
