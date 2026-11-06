# Lock-free drafts: seam probes

These probes keep the failure seams of [lock-free drafts][lock-free]
reproducible. Each runs production collab and Work adapters against a scratch
database, drives one exact PostgreSQL interleaving, and asserts the durable
outcome and observed locks. They are not part of `pnpm test:all`.

## Run

```bash
pnpm exec tsx tools/qa/probes/drafts-lock-free/run.mts
pnpm exec tsx tools/qa/probes/drafts-lock-free/run.mts f1-inverse-grant d23-archived-draft-rebases
```

The runner creates `lfd_probe_<pid>_<stamp>` on local dev Postgres, applies the
committed migrations, runs probes in order, and drops the database. `--keep`
leaves it for inspection; `--db <url>` reuses a migrated `lfd_probe_*` database.
Each probe prints its observations and `PASS` or `FAIL`; the exit code is the
number that failed. No dev stack, network socket, or browser is required.

## Probes

The [collab contracts][collab-context] define each guard. Sources are under
[`tools/qa/probes/drafts-lock-free/`][probes].

| Probe | Guard | Interleaving |
|---|---|---|
| `d12-create-during-archive` | A draft created while its Work archives is read as archived. | Archive pauses after its Work update; draft ensure starts and waits on the Work-row read. |
| `live-duplicate-frame` | A duplicate live frame is journaled once. | Admit duplicate, concurrent, delete-only, and missing-predecessor updates, then repeat with a 10,000-item tail. |
| `f1-inverse-grant` | Undo locks its grant's Work before its other locks. | Run Archive from the inverse confirmation and run inverse from the Archive boundary. |
| `f1-inverse-deadlock` | Undo and a journal append do not deadlock. | Hold the document lock in Undo while a rival append starts for the same Work. |
| `d22-concurrent-undo` | Captured fences order two Undos of one edit. | Hold two independent Undo operations at `inverse.beforeCommitScope`, for live and Work destinations. |
| `d23-archived-draft-rebases` | An archived Work draft keeps rebasing while its writer stays frozen. | Archive, commit a live edit, flush the background pull, write to the draft, then unarchive. |
| `two-process-frames` | Two coordinators deliver one sequence point per frame. | Two stores and rooms commit frames over one database, then read each draft as a tab handshake does. |
| `two-process-fold` | A content rebase delivers another process's committed row. | Pause A before append, commit `FOREIGN` from B, let A incorporate it, then type. |
| `two-process-compaction` | Background compaction delivers the row it folds. | Pause A's 512-row rewrite while B commits `FOREIGN`, then complete compaction and type. |
| `cold-load-commit` | A room loading across a commit enrolls the committed row. | Pause the load after its PostgreSQL read, commit `COMMITTED`, resume, and type. |
| `dropped-delivery` | A room reconciles after a dropped delivery. | Drop the first delivery, commit `LIVE` during the pull, then type. |
| `read-only-handshake` | A read-only handshake reconciles an older room. | Join a stale read connection after a dropped delivery and run SyncStep1/2. |
| `append-tail-order` | A fold's `checkpoint_seq` is a complete prefix. | Hold A's append while B rebases, then fold; also insert a low id while a higher row commits. |
| `append-between-rows` | One sequence point and receipts cover the committed prefix. | Hold A before `appendRows`, commit two B frames or a content rebase, then append A. |
| `append-novelty` | Novelty, receipts, and authorship are judged under the row lock. | Run contained, resend, prefix-missing, restoration, empty-part, transient-delete, and `4207` arms through the coordinator and gateway. |
| `append-rollback-scope` | A contained or prefix-missing append rolls back only its savepoint. | Resend at the root and inside an ambient transaction, then try an unknown-clock delete. |
| `archive-in-flight-append` | Only a key whose post-lock read preceded Archive can land. | Hold a frame while Archive runs, queue a second frame, then send a post-Archive frame. |
| `effect-projection` | The pending badge follows appends through the projection job. | Type, delete all, stage Apply, type again, and type from two processes during one debounce. |
| `effect-watermark-sweep` | The watermark repairs stale judgements in a finite sweep. | Sweep an unjobbed key, a compaction, and 51 stale drafts while one Work is held. |
| `migration-online` | Migration 0064 gives up rather than queueing readers. | Migrate a seeded 0063 database behind a held reader, a looping reader, and the old creator. |
| `client-resync` | A draft tab reconnects without terminal resync failure. | Drop sockets around a held append, partial acknowledgement, server restart, offline reload, and a raw dependent update. |

The former Work-first pull and pull-recapture probes are retired: Work rebases
are unfenced server appends. Work-draft fixtures persist live edits through the
live journal and flush the production content-rebase service; they never merge
live Yjs items into a Work draft.

## When a probe fails

A `FAIL` prints the assertion and observations before exiting. A timeout waiting
for a lock waiter means the second operation did not block; read the Guard
contract before changing the probe. Probes use their own Works and documents;
with `--keep`, drop only the named scratch database.

[lock-free]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/drafts-without-locks.md
[probes]: ../../../../../../../tools/qa/probes/drafts-lock-free
[collab-context]: ../CONTEXT.md#transaction-and-lock-contracts
