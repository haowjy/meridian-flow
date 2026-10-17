# Lock-free drafts: seam probes

These probes keep the failure seams of [lock-free drafts][lock-free] reproducible. Drafts
take no process mutex, so these failures live where two writes meet in PostgreSQL. Each
probe runs the production collab and Work adapters against a scratch database, sets up its
own Work, draft and documents, drives one exact interleaving (a hook pause, an independent
connection, a forced revision miss), and asserts the durable outcome and the locks it
observed. They are not part of `pnpm test:all`. Two seams are DB tests instead, beside
`apps/server/server/domains/collab/adapters/response-helper-revocation.db.test.ts`: item and
whole Discard inside an ambient root retire nothing before the root commits, nothing after it
rolls back, and once after it commits (D17). They are cheap to run, and a regression there
cannot be undone.

## Run

```bash
pnpm exec tsx tools/qa/probes/drafts-lock-free/run.mts            # every probe
pnpm exec tsx tools/qa/probes/drafts-lock-free/run.mts f1-inverse-grant d19-archived-pull
```

The runner creates `lfd_probe_<pid>_<stamp>` on the local dev Postgres (`pnpm dev:infra`,
port 54422), applies the committed migration chain, runs the probes in order, and drops the
database. `--keep` leaves it for inspection (drop it with `pnpm dev:gc-dbs`); `--db <url>`
reuses a migrated `lfd_probe_*` database. Each probe prints its observations and `PASS` or
`FAIL`, and the exit code is the number that failed. Nothing else runs: no dev stack, socket
or browser.

## Probes

D-numbers are the rulings of the [lock-free drafts decision][lock-free]'s implementation log;
F1 is the final-gate correctness finding (an Undo that committed after its Work archived). Sources are under [`tools/qa/probes/drafts-lock-free/`][probes].

| Probe | Decision | Interleaving | Expected output |
|---|---|---|---|
| `d12-pull-before-archive` | D12 | A live→draft pull pauses at `branch.rewrite.beforeCommit`, holding its Work and branch rows; Archive starts on another connection. | `archive held off` names Archive's `update "works"` waiting on a lock; `pull: "pulled"`, `archive: true`, the branch reads `archived` with the pulled text; `nextPull: "inactive"`. |
| `d12-create-during-archive` | D12 | Archive pauses inside its transaction after fencing the Work's branches; a branch ensure for a new document starts. | `archived: false` while paused; `ensure held off` names the ensure's Work-row read waiting; the new branch is `archived`, its writer frame is refused (`BranchStaleUpdateError`), durable revision 0 with the original text. |
| `d13-recapture-releases-row` | D13 | A pull's first attempt misses because an independent pull moved the checkpoint; at the second capture another connection takes the branch row and the Work row `NOWAIT`. Root-per-attempt and savepoint-in-ambient-root arms. | Both arms: `outcomes: ["rival pulled","moved","committed"]`, `recapture: "branch and Work rows available"`, `result: "pulled"`. |
| `d13-candidate-disposal` | D13 | One attempt prepares two catch-ups; the first persists, an independent pull moves the second's branch, the second misses. | `outcome: "missed: BranchCasConflictError"`, `destroyed: {first: true, second: true}`, the first branch's revision unchanged (its write rolled back). |
| `d18-sampled-discard` | D18 | Pure review functions: a 502-member Discard sent as a 500-key even sample omitting the last member, after the draft re-forked away the sampled members and grew the survivor's class. | `sampleOmitsSurvivor: true`; `sampledIncomplete: "stale"`, `complete: "stale"`, `completeAllGone: "gone"`. |
| `d19-archived-pull` | D19 | A pull into an archived Work's draft, then the same pull after unarchive. | Archived: `outcome: "inactive"` with revision and text unchanged; unarchived: `outcome: "pulled"` and the text catches up. |
| `f1-inverse-grant` | F1, D17 | A model Undo of a live-only (Scratch-like) write with a grant naming its Work. Lifecycle first: Archive commits at `inverse.beforeCommitScope`. Inverse first: Archive starts from inside the grant's confirmation. | Lifecycle first: the confirmation refuses (`Grant refused: Work … is archived`), `kinds: ["write"]`, live text keeps ` agent`. Inverse first: `archiveWaitedOn` names Archive's `update "works"`, `archivedWhileHeld: false`, `undo: "success"`, `archivedAfter: true`, one confirmation, `kinds: ["write","undo"]`. |
| `f1-inverse-deadlock` | F1, D17 | The Undo's nested journal seam asks its grant to cover the document while it holds the document lock; a rival journal append bound to the same Work starts there. | `rivalWaitedOn` names the rival's Work-row read; the Undo and the rival both succeed. Before the fix the rival waited on `pg_advisory_xact_lock` and failed `40P01`. |

## When a probe fails

A `FAIL` prints the assertion and the observations before it. A probe that times out
waiting for a lock waiter (`No probe connection waited on a lock matching …`) means the
second operation did not block: the lock order it guards is gone, so read the decision
before changing the probe. Probes use their own Works and documents and leave the scratch
database to the runner; with `--keep`, nothing else needs cleaning.

[lock-free]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/drafts-without-locks.md
[probes]: ../../tools/qa/probes/drafts-lock-free/
