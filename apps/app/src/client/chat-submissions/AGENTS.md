# client/chat-submissions

Durable, account-stamped journal of unresolved chat-submission intents (P3).
It is the local witness that lets a reload reconcile or replay a displayed send.
It is not a thread replica: no assistant turns, no cursors, no rendered rows.

- One record per `(accountId, submissionId)`, keyed
  `meridian:chat-submissions:v1:<accountId>:<submissionId>`. Enumeration matches
  `prefix + accountId + ":"`, so an account id that is a string prefix of
  another never leaks the longer account's records.
- One key per submission is deliberate. A tab can only clobber the record it
  owns, so no whole-record read-modify-write race and no Web Lock. Account
  switch never deletes another account's keys, so A→B→A preserves A's intents.
- `setUser(accountId)` is the only bind; `epoch` bumps on every rebind. Every
  record/retire takes an explicit `accountId` and is refused when it is not the
  current bind. Reads for a non-current account return nothing.
- Store the exact dispatch fingerprint fields (text, blocks, references,
  activatedSkillSlugs). A replay with the same `submissionId` but different
  payload trips the server's `idempotency_conflict`. Never persist the TipTap
  draft snapshot.
- Lifecycle: record before dispatch; retire on acknowledgement or definitive
  rejection; keep on ambiguous. The owning hook (`features/chat`) decides which
  outcome occurred; this module only stores and retires.
- Codec discards a wrong `schemaVersion`, a foreign `accountId`, and corrupt
  JSON without throwing. Storage errors degrade to "no intents", never a crash.
