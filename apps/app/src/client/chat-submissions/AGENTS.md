# client/chat-submissions

The account-stamped durable journal of unresolved chat submissions: the local
witness that lets a reload reconcile or replay a displayed send. It is not a
thread replica and never stores assistant turns. `owner.ts` is the sole owner
of writer rows, attempts, recovery status and draft transfer; don't build a
second presentation owner on top of it.

- Every epoch, record and retirement is fenced to the account bound with
  `setUser(accountId)`. Another account reads nothing, and switching accounts
  away and back keeps the first account's records.
- Persist the exact validated authoring snapshot (blocks, references, skills,
  creation inputs). Replaying from text alone loses references.
- Only a durable server rejection proves rejection. A refused lookup or
  retirement is ambiguity: keep the witness and retry on mount, reconnect,
  online or snapshot refresh. A local write failure exposes Retry but never
  authorizes Edit or a re-mint.
- Failure belongs on the writer row.
- Refused storage may duplicate the writer's words, never lose them.

Contracts (keys, ordering, retry identity, switches, deletion):
[`.context/CONTEXT.md`](.context/CONTEXT.md).
