# client/chat-submissions — contracts

The current implementation of the submission journal: storage keys, ordering,
retry identity, cross-tab behavior and deleted-chat recovery. The invariants
these serve are in [`../AGENTS.md`](../AGENTS.md).

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
- Retry reuses the same ID unless the server durably rejected it. Every message
  and control is marked `posted` under the chat lock before its first POST; an
  absent mark is the durable cross-tab proof that the server cannot hold it.
  Edit fences a posted record before transferring its structured draft ahead of
  newer writing. A failed, unposted fork or handoff returns only that send to its
  existing box locally, preserving the derivation intent and Retry. A
  never-created chat transfers its records and unsent writing to New chat and
  retires the cohort, queued switches included, in one step. Edit stores a
  tab-local receipt so reload cannot prepend twice.
- A write-mode switch is also a journal record (`control: { kind: "write_mode", mode }`,
  `recordId` = control id), posted to the controls route in `seq` order with
  surrounding messages. Marked `posted` before its first request; transient
  failure keeps the id, refusal holds later records until Stop or admitted
  Retry, and `withdrawControl` drops only never-posted or refused records. On
  server response the driver stamps `answer: { seq, mode, pending, at }` rather
  than deleting immediately (pruned after 60 s), so every tab reads the answer
  through `switches[].answer` while `useSwitchView` decides presentation.
- A journal record carries its failure occurrence (`requestId`, `attempt`). The
  driver saves a new occurrence before replay or Retry; the idempotent submission
  id is separate and can stay unchanged. A fresh request identity prevents a
  failed local save from colliding with a later attempt after reload. Restored
  failures read the saved occurrence, never allocate one while projecting.
  Storage events that change only occurrence metadata rebuild the view but never
  wake another replay; command additions, removals or state changes can wake it.
  Another tab starting an attempt is not evidence that the attempt failed.
  Unsaved switches retain their mode, order and occurrence in the owner until
  retried or withdrawn; these facts cannot survive refused browser storage.
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
- Edit and deletion receipts are per tab, not a cross-tab transaction. If journal removal is
  refused after Edit, another tab can still Retry that record; two tabs on one
  deleted chat may clear each other's failed rows before learning of deletion.

The shared browser-record envelope, the v1→v2 codec and rewrite, the owner
facade, projection errors and deleted-chat probing are described in their source
headers.

Deferred work: [TODO](TODO).
