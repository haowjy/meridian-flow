# client/chat-submissions

Durable, account-stamped journal of unresolved chat-submission intents (P3).
It is the local witness that lets a reload reconcile or replay a displayed send.
It is not a thread replica: no assistant turns or rendered rows.

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
  activatedSkillSlugs) for every kind, a new chat's first send included: a
  replay rebuilt from text alone would drop its `@` references. A replay with
  the same `submissionId` but different payload trips the server's
  `idempotency_conflict`. Existing-thread composer sends also retain their
  validated structured authoring snapshot until settlement. The
  displayed writer row is built from the same blocks (`appendUserTurn`), so a
  live or recovered row keeps each reference's document like the snapshot does.
- Lifecycle: record before dispatch and hand off only the unchanged authoring
  snapshot. On acknowledgement retire the witness. A rejection fills an empty
  per-tab composer before retirement; otherwise its exact snapshot stays in a
  durable rejected entry. Rejected entries render failed rows in every tab and
  on reload, never trigger lookup or replay, and are resolved only by the writer.
  Retry remints the identity and sends the exact fingerprint, leaving newer
  authoring alone. Edit prepends the rejected structured document to any newer
  draft before retirement. Ambiguous entries keep Check / Start over.
- Browser envelopes use the shared `client/storage/browser-record.ts` boundary.
- Codec discards a wrong envelope version, a foreign `accountId`, and corrupt
  JSON without throwing. Storage errors degrade to "no intents", never a crash.
