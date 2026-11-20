# Lock-free drafts: seam probes

These probes keep the failure seams of [lock-free drafts][lock-free]
reproducible. Each runs production collab and Work adapters against a scratch
database, drives one exact PostgreSQL interleaving, and asserts the durable
outcome and observed locks. CI runs them after the DB suite (`pnpm test:probes`, see
[the probe index](../../../../../../docs/qa/README.md#script-backed-checks)); they are not part of `pnpm test:all`.

## Run

```bash
pnpm exec tsx tools/qa/probes/drafts-lock-free/run.mts
pnpm exec tsx tools/qa/probes/drafts-lock-free/run.mts f1-inverse-grant d23-archived-draft-rebases
```

The runner creates `lfd_probe_<pid>_<stamp>` on local dev Postgres (or a CI runner's own), applies the
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
| `live-duplicate-frame` | A sequential duplicate live frame is stored once, a concurrent one at most twice with the text single, and a frame ahead of its predecessor is refused. | Admit duplicate, concurrent, delete-only, and missing-predecessor updates. |
| `f1-inverse-grant` | Undo locks its grant's Work before its other locks. | Run Archive from the inverse confirmation and run inverse from the Archive boundary. |
| `f1-inverse-deadlock` | Undo and a journal append do not deadlock. | Hold the document lock in Undo while a rival append starts for the same Work. |
| `d22-concurrent-undo` | Two Undos of one edit land once; one answers `success`, the other `cant_undo_changed` (its commit took nothing). | Hold two independent Undo operations at `inverse.beforeCommitScope`, for live and Work destinations. |
| `d23-archived-draft-rebases` | An archived Work draft opened read-only shows current text and gets pushes while open; an unopened one is left alone; its writer stays frozen. | Archive, commit a live edit, push with no room open (draft unchanged), open it (catch-up lands), commit another edit and push, write to the draft, then unarchive. |
| `two-process-frames` | Two coordinators store one insert per frame. | Two stores and rooms commit frames over one database, then read each draft as a tab handshake does. |
| `two-process-fold` | A content rebase's catch-up delivers another process's committed row. | Pause A before append, commit `FOREIGN` from B, let A incorporate it, then type. |
| `two-process-compaction` | Background compaction's catch-up delivers the row it folds. | Pause A's 512-row rewrite while B commits `FOREIGN`, then complete compaction and type. B's own compaction is stopped, so A's fold is the only one. |
| `two-process-compaction-moved` | A fold that lost the row to another process's fold pushes nothing; the next connection's catch-up brings the text in. | Same, but B's fold commits first. A's is dropped, room A lacks `FOREIGN` after A's next keystroke, and has it after a catch-up. |
| `cold-load-commit` | A room loading across a commit is caught up by its first connection. | Pause the load after its PostgreSQL read, commit `COMMITTED`, resume, connect, and type. |
| `missed-catch-up` | A frame typed into a room behind its draft is stored; the room heals at the next connection, not at a frame. | Drop the first catch-up, commit `LIVE` during the pull, type, then connect. |
| `read-only-connect` | A read-only tab's connection catches an older room up, and the room's broadcast reaches the tab. | Drop a catch-up, join a stale read connection, run SyncStep1/2, then its `connected` hook. |
| `append-tail-order` | A fold's `checkpoint_seq` is a complete prefix. | Hold A's append while B rebases, then fold; also insert a low id while a higher row commits. |
| `archive-in-flight-append` | Only a key whose `UPDATE` started before Archive can land. | Hold a frame while Archive runs, queue a second frame (it lands), then send a post-Archive frame (refused). |
| `effect-projection` | The pending badge follows appends through the projection job. | Type, delete all, type from two processes during one debounce, and write under `lockWorks` alone, as agent-edit's `lockOwners` does. The old "key after Apply staging" arm is gone: it set a journal row status and column that frozen Apply removed. |
| `effect-watermark-sweep` | The watermark repairs stale judgements in a finite sweep. | Sweep an unjobbed key, a compaction, and 51 stale drafts while one Work is held. |
| `client-resync` | A draft tab reconnects without terminal resync failure. | Drop sockets around a held append, partial acknowledgement, server restart, offline reload, and a raw dependent update built from the draft's own durable state (a draft's seed is not under live's client id). |

The former Work-first pull and pull-recapture probes are retired: Work rebases
are unfenced server appends. Work-draft fixtures persist live edits through the
live journal and catch the draft up through the production content-rebase service; they never merge
live Yjs items into a Work draft.

## Timing in a probe

These run in CI on two cores, so a probe never reads once after a fixed sleep. A
delivery that a post-commit step, a timer or another process makes (a compaction's
update to the other process's room, the projection's badge) is waited for: on the
room's own update event where there is one (`roomHolds`), else by polling to a
deadline that fails naming what it waited for (`within`, `deadline`). A room's catch-up
after a commit runs after the commit's `await` returns (`two-process-fold` waits on the room).
Wall-clock numbers are reported, not asserted, unless they
are the requirement itself (the projection's 1 s max wait, a lock timeout); those
bounds keep slack for a loaded runner.

## When a probe fails

A `FAIL` prints the assertion and observations before exiting. A timeout waiting
for a lock waiter means the second operation did not block; read the Guard
contract before changing the probe. Probes use their own Works and documents;
with `--keep`, drop only the named scratch database.

[lock-free]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-store-concurrency.md#keystrokes-append-without-a-revision-fence
[probes]: ../../../../../../../tools/qa/probes/drafts-lock-free
[collab-context]: ../CONTEXT.md#transaction-and-lock-contracts
