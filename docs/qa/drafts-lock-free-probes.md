# Lock-free drafts: seam probes

These probes keep the failure seams of [lock-free drafts][lock-free] reproducible. Drafts
take no process mutex, so these failures live where two writes meet in PostgreSQL. Each
probe runs the production collab and Work adapters against a scratch database, sets up its
own Work, draft and documents, drives one exact interleaving (a hook pause, an independent
connection, a forced revision miss), and asserts the durable outcome and the locks it
observed. They are not part of `pnpm test:all`. Two seams are DB tests instead, beside
`apps/server/server/domains/collab/adapters/response-helper-revocation.db.test.ts`: item and
whole Discard inside an ambient root retire nothing before the root commits, nothing after it
rolls back, and once after it commits. They are cheap to run, and a regression there
cannot be undone.

## Run

```bash
pnpm exec tsx tools/qa/probes/drafts-lock-free/run.mts            # every probe
pnpm exec tsx tools/qa/probes/drafts-lock-free/run.mts f1-inverse-grant d23-archived-draft-rebases
```

The runner creates `lfd_probe_<pid>_<stamp>` on the local dev Postgres (`pnpm dev:infra`,
port 54422), applies the committed migration chain, runs the probes in order, and drops the
database. `--keep` leaves it for inspection (drop it with `pnpm dev:gc-dbs`); `--db <url>`
reuses a migrated `lfd_probe_*` database. Each probe prints its observations and `PASS` or
`FAIL`, and the exit code is the number that failed. Nothing else runs: no dev stack, socket
or browser.

## Probes

A probe's name prefix is the label it was filed under while the change was built; the Guards
column says what it protects, and the [collab contracts][collab-context] state each rule.
Sources are under [`tools/qa/probes/drafts-lock-free/`][probes].

| Probe | Guards | Interleaving | Expected output |
|---|---|---|---|
| `d12-pull-before-archive` | Work-first order through the Works boundary | A live→draft pull pauses at `branch.rewrite.beforeCommit`, holding its Work and branch rows; Archive starts on another connection. | `archive held off` names Archive's `update "works"` waiting on a lock; `pull: "pulled"`, `archive: true`, the branch reads `archived` with the pulled text; `nextPull: "pulled"` (an archived Work's draft keeps rebasing). |
| `d12-create-during-archive` | A branch created while its Work archives is fenced | Archive pauses inside its transaction after fencing the Work's branches; a branch ensure for a new document starts. | `archived: false` while paused; `ensure held off` names the ensure's Work-row read waiting; the new branch is `archived`, its writer frame is refused (`BranchStaleUpdateError`), durable revision 0 with the original text. |
| `d13-recapture-releases-row` | A missed attempt releases its rows before recapture | A pull's first attempt misses because an independent pull moved the checkpoint; at the second capture another connection takes the branch row and the Work row `NOWAIT`. Root-per-attempt and savepoint-in-ambient-root arms. | Both arms: `outcomes: ["rival pulled","moved","committed"]`, `recapture: "branch and Work rows available"`, `result: "pulled"`. |
| `d13-candidate-disposal` | A missed attempt disposes every candidate | One attempt prepares two catch-ups; the first persists, an independent pull moves the second's branch, the second misses. | `outcome: "missed: BranchCasConflictError"`, `destroyed: {first: true, second: true}`, the first branch's revision unchanged (its write rolled back). |
| `d18-sampled-discard` | A sampled member list never proves `gone` | Pure review functions: a 502-member Discard sent as a 500-key even sample omitting the last member, after the draft re-forked away the sampled members and grew the survivor's class. | `sampleOmitsSurvivor: true`; `sampledIncomplete: "stale"`, `complete: "stale"`, `completeAllGone: "gone"`. |
| `d20-blocked-settlement-pull` | Only a pending settlement re-arms a pull | A live→draft pull flushed on a document whose settlement batch is `pending`, then on one whose batch is terminally `blocked`, with a 10 ms debounce observed for 250 ms. | `pending` captures keep growing (the pull re-arms); `blocked: {"captures":1}`; revision 0 in both. Before the fix the blocked arm re-armed like the pending one. |
| `f1-inverse-grant` | An Undo locks its grant's Work before its other locks | A model Undo of a live-only (Scratch-like) write with a grant naming its Work. Lifecycle first: Archive commits at `inverse.beforeCommitScope`. Inverse first: Archive starts from inside the grant's confirmation. | Lifecycle first: the confirmation refuses (`Grant refused: Work … is archived`), `kinds: ["write"]`, live text keeps ` agent`. Inverse first: `archiveWaitedOn` names Archive's `update "works"`, `archivedWhileHeld: false`, `undo: "success"`, `archivedAfter: true`, one confirmation, `kinds: ["write","undo"]`. |
| `f1-inverse-deadlock` | An Undo and a journal append cannot deadlock | The Undo's nested journal seam asks its grant to cover the document while it holds the document lock; a rival journal append bound to the same Work starts there. | `rivalWaitedOn` names the rival's Work-row read; the Undo and the rival both succeed. Before the fix the rival waited on `pg_advisory_xact_lock` and failed `40P01`. |
| `d22-concurrent-undo` | Captured fences order two Undos of one edit | Two model Undos of the same write on independent connections, both held at `inverse.beforeCommitScope` until both planned; a live-destination arm and a Work-draft arm. | Both arms: `statuses: ["nothing_to_undo","success"]`, `kinds: ["write","undo"]`, the text back to `Base`. With the live head check disabled the live arm records two Undos: the captured fences, not an inverse lock, order them. |
| `d22-retracted-peer-pull` | A branch gone mid-pull answers `closed` | A thread-peer pull captures its branches; before its commit, another connection retracts the created draft branch and its peer inside the Work boundary. | `retraction: "retracted"`, `outcomes: ["closed"]`, the pull rejects `ThreadPeerPullLost`. Before the fix it rejected a plain `Error("Draft branch not found")`. |
| `d23-archived-draft-rebases` | An archived Work's draft keeps rebasing on live; its writer stays frozen | Archive, a live edit, a flushed background pull; a writer frame on the archived draft; then unarchive. | `archived` with the live edit in its text; the writer frame rejects `BranchStaleUpdateError`; `unarchived` reads the same text and checkpoint revision (nothing to catch up), without the refused frame's text. |
| `two-process-frames` | A room learns rows another process committed | Two coordinators, each with its own store and room, over one database (two server processes without sockets); a frame typed into each room every round, 20 rounds, both in flight together; then each process reads the branch as a tab's SyncStep1 handshake does. | `frames: {"admitted":40,"failures":{}}`, `tokens: {"durable":40,"rooms":{"A":40,"B":40}}`. Before the fix: 2 admitted, 38 `BranchStaleUpdateError` from the first attempt's room fence, 2 durable. |
| `two-process-fold` | A pull that folds another process's row delivers it (D25) | Two processes with a room each; A's live pull pauses before its rewrite, B commits ` FOREIGN`, the pull's rewrite folds it under the branch lock and commits; then A types. | `pull: {..."pulled":"pulled",...}` with `FOREIGN` in `durable` and in A's `room`; `next: {"ok":true,"value":{"admitted":true}}`. Before D25 the room lacked `FOREIGN` and `next` was `BranchStaleUpdateError`. |
| `two-process-compaction` | The background compaction delivers the row it folds (D25) | As above, with 511 tail rows and a triggering frame; A's 512-row compaction pauses before its rewrite while B commits ` FOREIGN`. | `compaction: {"foreign":true,"tail":0,"durableHasForeign":true,"roomHasForeign":true}`; `next` admitted. Before D25 `roomHasForeign` was false and `next` was `BranchStaleUpdateError`. |
| `cold-load-commit` | A room loading across a commit enrolls it (D26) | Real gateway hooks and Hocuspocus lifecycle (`createDocument`, the socket path's call); the room's load read pauses after PostgreSQL answers, a pull commits ` COMMITTED`, the read resumes, then the tab types through `admitWriterSync`. | `load: {..."registered":"<paragraph>Base</paragraph>","enrolled":"<paragraph>Base COMMITTED</paragraph>"...}`; `next: {"ok":true,"closes":[]}`; `reconciled: ["enrollment"]`. Before D26 the room stayed at `Base` and `next` closed `1008`. |
| `cold-load-reset` | A room loading across a reset is closed (D26) | As above, with a fold reset to generation 2 and a read of it during the paused generation-1 load; then a generation-2 room loads and the tab types. | `reset: {"reset":true,"registered":true,"afterEnrollment":false,"generation":2}`; `next: {"ok":true,"closes":[]...}` with `RESET NEXT` durable. Before D26 the generation-1 room stayed registered. |
| `dropped-delivery` | A frame reconciles a room that missed a delivery (D26) | One gateway whose first room delivery is dropped on purpose; a pull commits ` LIVE`, then the tab types. | `drop: {..."behind":"<paragraph>Base</paragraph>"...}`; `next: {"ok":true,"closes":[]...}` with the room equal to `durable`; one `reconciled` entry with `"trigger":"frame"`. Before D26 `next` closed `1008`. |
| `read-only-handshake` | A read-only tab's handshake reconciles its room (D27) | As `dropped-delivery`, then a tab holding the room's older state joins on a read connection: SyncStep1 and its SyncStep2 answer run through Hocuspocus's `MessageReceiver` and the gateway's `beforeSync` hook. No keystroke anywhere. | `drop: {..."behind":{"room":"<paragraph>Base</paragraph>","tab":"<paragraph>Base</paragraph>"}...}`; `joined: {"room":"<paragraph>Base LIVE</paragraph>","tab":"<paragraph>Base LIVE</paragraph>"}`; `reconciled: ["handshake"]`. Before D27 both stayed at `Base` with no repair. |

## When a probe fails

A `FAIL` prints the assertion and the observations before it. A probe that times out
waiting for a lock waiter (`No probe connection waited on a lock matching …`) means the
second operation did not block: the lock order it guards is gone, so read the rule its Guards
column names in the [collab contracts][collab-context] before changing the probe. Probes use their own Works and documents and leave the scratch
database to the runner; with `--keep`, nothing else needs cleaning.

[lock-free]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/drafts-without-locks.md
[probes]: ../../tools/qa/probes/drafts-lock-free/
[collab-context]: ../../apps/server/server/domains/collab/.context/CONTEXT.md#transaction-and-lock-contracts
