# client/chat-submissions

Durable, account-stamped journal of unresolved chat-submission intents (P3).
It is the local witness that lets a reload reconcile or replay a displayed send.
It is not a thread replica: no assistant turns or rendered rows.

- One record per `(accountId, recordId)`, keyed
  `meridian:chat-submissions:v2:<accountId>:<recordId>`. Enumeration matches
  `prefix + accountId + ":"`, so an account id that is a string prefix of
  another never leaks the longer account's records.
- One key per submission is deliberate: a write touches one record, not a
  whole-journal read-modify-write. New records need no Web Lock; transitions
  of existing records run under the per-account/thread driver lock, including
  takeover by another tab. Account
  switch never deletes another account's keys, so A→B→A preserves A's intents.
- `setUser(accountId)` is the only bind; `epoch` bumps on every rebind. Every
  record/retire takes an explicit `accountId` and is refused when it is not the
  current bind. Reads for a non-current account return nothing.
- Store the exact dispatch fingerprint fields (text, blocks, references,
  activatedSkillSlugs) for every record, a new chat's first send included: a
  replay rebuilt from text alone would drop its `@` references. A replay with
  the same `submissionId` but different payload trips the server's
  `idempotency_conflict`. All composer sends also retain their
  validated structured authoring snapshot until settlement. The
  displayed writer row is built from the same blocks (`appendUserTurn`), so a
  live or recovered row keeps each reference's document like the snapshot does.
- The journal owns every displayed unadmitted writer message. `creation` carries
  create-or-get inputs on every record until the server confirms the chat.
  `ChatSubmissionDriver` serializes requests in `createdAt` order under
  `meridian:chat-submissions:<accountId>:<threadId>`. Derivation waits stay outside
  that lock. Account/lifetime cancellation abandons work without presenting failure;
  each request has a timeout so a departed owner cannot block takeover.
- Acceptance bridges the optimistic row, then retires its record. A refusal is
  stored as `state: "rejected"` and never re-driven automatically. Ambiguity is
  tab-local: the unresolved journal record is re-driven on mount, online,
  snapshot refresh and socket reconnect. Failure appears only on the writer row.
- Retry looks up the same submission id first. Acceptance bridges without a POST;
  not-seen posts the same id; only a durable rejection re-mints the id in the same
  record key. Edit fences an existing chat's submission before transferring its
  structured draft ahead of newer writing. Never-created chat Edit transfers all
  its journal drafts and this tab's unsent writing to New chat before retirement.
- Browser envelopes use the shared `client/storage/browser-record.ts` boundary.
- Codec discards a wrong envelope version, a foreign `accountId`, and corrupt
  JSON without throwing. Storage errors degrade to "no intents", never a crash.

`creation` carries first-send inputs; `draft` retains the composer snapshot.
Account bind rewrites v1 records to v2 before removing their old keys. The
bounded rewrite removal trigger is in `.context/TODO`.

Record/retire notify in-tab subscribers; cross-tab localStorage events forward
to the same listeners. `useIsThreadPendingCreation` synchronously combines
journal `creation` with the provider-scoped pending flag through
`useSyncExternalStore`, so uncreated journal destinations never query snapshots.
