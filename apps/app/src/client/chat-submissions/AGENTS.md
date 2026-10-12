# client/chat-submissions

Durable, account-stamped journal of unresolved chat-submission intents (P3).
It is the local witness that lets a reload reconcile or replay a displayed send.
It is not a thread replica: no assistant turns. One observable account/thread model owns writer rows, live session/id-fenced
attempts and the shared recovery eligibility/status snapshot for every mounted pane; views never enumerate persistence.

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
- Codec rejects wrong-version and foreign envelopes without throwing. Unreadable
  records and unavailable enumeration retain the last complete snapshot and never sweep rows.

`creation` carries first-send inputs; `draft` retains the composer snapshot.
Account bind rewrites v1 under the driver thread lock. A v2 copy is not
drivable or retirable until its v1 key is gone; failed deletion leaves words in v1. The
bounded rewrite removal trigger is in `.context/TODO`.

Record/retire notify in-tab subscribers; cross-tab localStorage events forward
to the same listeners. `useIsThreadPendingCreation` synchronously combines
journal `creation` with the provider-scoped pending flag through
`useSyncExternalStore`, so uncreated journal destinations never query snapshots.

`owner.ts` owns tab row identity, local failure/busy knowledge, durable Send handoff,
and draft transfer. Pane bindings subscribe to that model, not separate status caches. Each binding exposes
a command facade whose driver, lifetime, focus and navigation belong to the invoking pane;
the shared presentation contains no pane-bound callbacks.
Both first and existing Send use `recordAndProjectSubmission`;
the caller supplies the actual authoring scope, independently of creation metadata.
After commit, exact draft handoff precedes fallible projection. Subscriber/projection errors are reported through `reportError`, never
turned into a resubmittable composer failure. The driver chooses Edit's cohort under
its lock. Local write failure exposes Retry but never authorizes Edit or re-mint.

An empty journal is not a dissolve signal. An observer that last saw creation
confirms the server destination: 200 loads it, 404 permits dissolution unless
server-confirmed `thread_deleted` or `project_deleted` sends it to deleted-chat
cleanup instead, and an inconclusive response preserves the destination and last-known rows. Only this
tab's explicit Edit bypasses that check. Pane disposal fences only its recovery
session; account disposal, not unrelated pane teardown, invalidates admissions.

Edit saves stable record-id receipts atomically with the destination draft in
sessionStorage. A received record is moving, never retryable or editable; mount
and external wakes finish its journal retirement without another prepend/admission.
Receipts survive draft Send/clear and reload in the same tab. They are not shared
with other tabs: the receipt guarantee is tab-local, not a cross-tab transaction.
Lookup/retirement request refusal is ambiguity, never rejection proof, except
owner-attested deletion, which is the separate cleanup signal below.

Known limit (tech-lead scope ruling, 2026-10-11): Edit receipts are per tab; if removing
the journal record fails after Edit moves the words into that tab's message box,
another tab can still Retry the record. Draft write and removal run in one synchronous
step, so the only trigger is localStorage removal being refused when storage access
is denied altogether.

## Deleted chats

Only an owner-attested `thread_deleted` (without `projectDeleted`) moves words.
The attestation's `authenticatedUserId` must equal the bound account. The visible
Chat center, uncovered expanded dock, or phone chat transfers its shown unadmitted
rows and its tab-local box into the project's New chat ahead of existing writing.
The same tab-local draft stores the title/count notice and unique record-id
receipts atomically. Box text needs no receipt: transfer and source clear are
synchronous under the lock. Refused source storage can duplicate words, never lose them. Dismiss removes the notice;
Send clears it. Then every journal record and this tab's old box are cleared, and
the surface leaves the deleted chat. Hidden, collapsed, covered and index-warm
surfaces move nothing. Own Delete intent is published before its request, fenced
to account and bind epoch, and released when its confirmed cleanup returns
(finished or not), or cancelled on DELETE failure. While pending, all cleanup
for that chat only clears, like confirmed own Delete and project deletion.
`thread_not_found` and the never-created-chat (O4) lifecycle are unchanged.

Deletion runs under the existing submission lock, or inside that lock when the
driver reports it. No new lock or cross-tab transfer protocol exists. On account
bind, after journal rewrite readiness, a single pass probes off-screen journal and
session-draft destinations (four concurrent requests, each bounded to 15 seconds).
The URL chat and current project's remembered chat are excluded before panes mount;
off-screen eligibility is rechecked inside the lock. Those addressed panes report
their own deletion with the project id, even when hidden.
Only attested chat/project deletion clears them; other answers preserve them.
An unreadable journal or refused destination write is incomplete: retain source
words and stay. The driver shows Couldn't send and retries cleanup on Retry,
Edit or wake without admitting messages to a known-deleted chat.

Accepted rough edge: in two tabs on the same deleted chat, the first tab's journal
cleanup can remove the second tab's failed rows before it learns of deletion. Its
own per-tab box still moves when it learns. Receipts are per tab, not cross-tab.
