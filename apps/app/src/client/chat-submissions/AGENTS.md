# client/chat-submissions

Account-stamped durable journal of unresolved chat-submission intents. It is the
local witness that lets a reload reconcile or replay a displayed send, not a
thread replica and never a store for assistant turns. `owner.ts` is the sole
owner of writer rows, attempts, recovery status, and draft transfer.

## Contracts

- Bind with `setUser(accountId)` only. Every epoch, record, and retirement is
  account-fenced; reads for another account are empty, and switching A→B→A
  preserves A's records. Enumeration must keep account IDs segment-safe.
- Keep one independently keyed record per submission (`meridian:chat-submissions:v3:<accountId>:<recordId>`).
  Existing-record transitions use the account/thread driver lock; new records
  need no journal read-modify-write. Requests are bounded so a departed tab
  cannot block takeover.
- Every record carries a monotonic per-chat `seq` (allocated from
  `meridian:chat-submission-seq:v1:<account>:<thread>` in `localStorage`) that
  orders drain, refusal barriers, and the switch fold across retirement.
  `forgetOrder` clears the counter with deleted-chat cleanup.
- Persist the exact validated authoring snapshot, including blocks, references,
  activated skills, and first-send creation inputs. Replaying from text alone
  loses references; a reused submission ID with a different payload is an
  idempotency conflict.
- Acceptance bridges the optimistic row and retires the record. A durable
  rejection stays rejected and is not auto-driven; ambiguity keeps the witness
  and retries on mount, reconnect, online, or snapshot refresh. Failure belongs
  on the writer row.
- Retry reuses the same ID unless the server durably rejected it. Edit fences
  the record, transfers its structured draft ahead of newer writing, and stores
  a tab-local receipt so reload cannot prepend twice. A never-created chat
  transfers its records and unsent writing to New chat and retires the cohort,
  queued switches included, in one step.
- A write-mode switch is also a journal record (`control: { kind: "write_mode", mode }`,
  `recordId` = control id), posted to the controls route in `seq` order with
  surrounding messages. Marked `posted` before its first request; transient
  failure keeps the id, refusal holds later records until Stop or admitted
  Retry, and `withdrawControl` drops only never-posted or refused records. On
  server response the driver stamps `answer: { seq, mode, pending, at }` rather
  than deleting immediately (pruned after 60 s), so every tab reads the answer
  through `switches[].answer` while `useSwitchView` decides presentation.
- Pane disposal fences only that pane's recovery session. Account disposal
  invalidates admissions. Deletion cleanup requires an authenticated,
  account-matching `thread_deleted` attestation; inconclusive checks preserve
  source words and records.
- Only a durable server rejection proves rejection. A refused lookup or
  retirement is ambiguity, and a local write failure exposes Retry but never
  authorizes Edit or a re-mint. An empty journal does not dissolve a
  never-created chat: the server must say 404 (or an attested deletion).
- Words move only for an owner-attested `thread_deleted` without
  `projectDeleted`. The writer's own Delete (published before its request,
  fenced to account and bind epoch) and project deletion only clear. On account
  bind, one pass probes off-screen journal destinations; only attested deletion
  clears them, any other answer preserves them.
- On attested chat deletion only the visible surface (center, uncovered dock,
  phone) moves its unadmitted rows and tab-local box into the project's New chat
  ahead of existing writing, with a notice. Hidden, collapsed, and covered
  surfaces move nothing. Refused storage may duplicate words, never lose them.
- Accepted limits (tech-lead scope ruling, 2026-10-11): Edit and deletion
  receipts are per tab, not a cross-tab transaction. If journal removal is
  refused after Edit, another tab can still Retry that record; two tabs on one
  deleted chat may clear each other's failed rows before learning of deletion.

The shared browser-record envelope and the v1→v2 codec/rewrite, owner facade,
projection errors, and deleted-chat probing live in the local context notes and
source headers. Do not turn those mechanics into a second presentation owner.

→ [.context/TODO](.context/TODO)
