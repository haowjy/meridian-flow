# Crash and resend, and two servers on one database

Two lock-free drafts probes. **P5** stops the server between a branch write's
`COMMIT` and its acknowledgement and checks the resend lands once. **P6** runs two
server processes on one database, with a tab on each typing into the same draft.
Both run on an owned mock stack (`MODEL_PROVIDER=mock pnpm dev`) and read
durable state with `tools/qa/draft-readback.ts`. Record the commit, date, stack
and evidence path for each run, as the [catalog](README.md) asks.

## Tools

- `pnpm exec tsx tools/qa/draft-readback.ts <draftId> [--db <url>]` prints a
  branch's `revision`, `checkpointRevision`, `checkpointSeq`, generation, tail
  rows with their client ids, materialized `text` and `stateSha256`. Without
  `--db` it reads this checkout's database.
- `pnpm exec tsx tools/qa/shared-db-server.ts <database-url> <prefix>.server.meridian`
  starts a second server on `<database-url>`, set verbatim, and an app paired with
  it. The tab URL is `https://<prefix>.app.meridian.localhost`. The tool refuses
  any target but the local dev Postgres and refuses this checkout's own route
  prefix. Before booting it prints a `db-identity` line:
  `current_database()`, `inet_server_addr()` and `inet_server_port()`. Ctrl-C
  stops the server and the app. The tab needs an app of its own because the
  app's Vite proxy sends every `/ws/yjs` upgrade to one `MERIDIAN_API_ORIGIN`,
  whatever host the tab uses.
- The crash controller: start the stack with `COLLAB_CRASH_AT=<hook point>` and
  `COLLAB_CRASH_ARM=<file>`, then `touch <file>` to arm it. At the point, the
  server deletes the file and exits with 137. Nitro's dev server restarts its
  worker on its own (`Restarting dev worker...` in `logs/portless.log`), and the
  restarted worker finds no arm file. The hook points are
  `draft.append.beforeCommit` (rows and receipts written, the branch row held,
  nothing committed), `draft.append.afterCommit` and
  `draft.rewrite.beforeCommit`
  (`apps/server/server/domains/collab/domain/collab-test-hooks.ts`).
- `collab.branch.rewrite_committed` reports each rewrite (`checkpoint`,
  `compact`, `pull`, `reset`) with `holdMs` and `tailRows`. `holdMs` runs from
  the branch row's `FOR UPDATE` to `COMMIT`.

For about 30 seconds after a crash, the JSONL mirror (`logs/events/`) drops
events, because the dead worker's directory lock is still live until it goes
stale. During that window, read the server's stdout in `logs/portless.log`.

## Setup

Seed a document, create a named Work, create a thread on it with
`aiWriteMode: "draft"` in the `POST /api/threads` body (`./mf api`), and make a
draft with a scripted mock `write` (`./mf thread send <thread> ... --mock`).
`./mf api GET /api/projects/<project>/works/<work>/branches` names the draft. Its
branch id is the `draftId` on the draft's rows.

## P5: crash between the append's commit and its ack

1. Run `pnpm dev --stop`, then start the stack armed for the append:
   `COLLAB_CRASH_AT=draft.append.afterCommit COLLAB_CRASH_ARM=/tmp/<run>-arm MODEL_PROVIDER=mock pnpm dev:local`.
   Read `branch-readback` for the draft branch.
2. Open the draft in the Editor in a named `agent-browser` session. `touch` the
   arm file and type one word.
3. The server exits after the row commits, so the frame gets no ack. The
   client reconnects to the restarted worker and resends.
   PASS:
   - The arm file is gone.
   - `branch-readback` shows exactly one new tail row for the word.
   - Its `text` matches the editor.
   - After a reload, the editor and `stateSha256` are unchanged.
   - Typing again with no arm file does not crash.
4. Repeat with `COLLAB_CRASH_AT=draft.append.beforeCommit` (phase 4). Count
   the draft's receipts first:
   `select count(*) from document_edit_parts where placement->>'draftId' = '<draftId>'`
   with `psql "$db"`. Arm the file and type one word. The server exits after
   the append inserted its rows and receipts and before `COMMIT`, so nothing of
   that frame is durable; the client reconnects and its handshake's SyncStep2
   carries the word.
   PASS:
   - The arm file is gone.
   - `branch-readback` shows exactly one new tail row for the word, not two:
     the crashed attempt left no row.
   - The receipt count grew by exactly one: the crashed attempt left no receipt.
   - Its `text` matches the editor, and the reload check of step 3 holds.
   - No `1008` or `4207` close in the tab's `/ws/yjs` frames.
5. Repeat with `COLLAB_CRASH_AT=draft.rewrite.beforeCommit`. Arm the file,
   then drive a live-to-draft pull. A live write from a No Work thread followed
   by a read from the draft thread pulls.
   PASS:
   - The arm file is gone.
   - Before the rerun, `revision`, `checkpointSeq` and the tail are unchanged.
   - The pull runs once more and commits: `revision` + 1, and the text carries
     the live edit.
   - `logs/portless.log` shows one `rewrite_committed` with `rewrite: "pull"`
     for that branch after `Restarting dev worker...`.

## P6: two servers on one database

1. With the mock stack running, read its database URL from its server process,
   then start the second server and its app:

   ```bash
   pid=$(pnpm -s exec portless list | grep "<stack-prefix>.server.meridian" | grep -o 'pid [0-9]*' | cut -d' ' -f2)
   db=$(tr '\0' '\n' < /proc/$pid/environ | sed -n 's/^DATABASE_URL=//p')
   MODEL_PROVIDER=mock pnpm exec tsx tools/qa/shared-db-server.ts "$db" p6b.server.meridian
   ```

   The second server inherits this shell's environment. Without
   `MODEL_PROVIDER=mock` it re-syncs the shared database's Agents to real
   models, and seeding a thread fails with `Agent "general" is unavailable`.

   Run the same `select current_database(), host(inet_server_addr()), inet_server_port()`
   with `psql "$db"`. PASS: it equals the tool's `db-identity` line.
2. Sign in on `https://p6b.app.meridian.localhost` (dev login) and on the
   stack's own app URL, each in its own named `agent-browser` session. Open the
   same draft in both. Each tab's `/ws/yjs` reaches only its own server: with
   the second server's process stopped (`kill -STOP`), its tab's upgrade hangs
   while the other tab's succeeds.
3. Each tab types 40 unique tokens (`A01` to `A40`, `B01` to `B40`) on a 200 ms
   cadence. Log each key's send time, its ack or `1008` close, and reconnects.
4. PASS:
   - All 80 tokens are in `branch-readback`'s text, in each tab's order.
   - All 80 tokens are in both editors after a reload.
   - Every key is acked, with no `1008` close and no reconnect: each
     process's room takes the other's committed rows before it judges a frame.
     The headless form of this step is the `two-process-frames` probe, and
     `two-process-fold` and `two-process-compaction` cover a pull or compaction
     folding the other process's row ([seam probes](drafts-lock-free-probes.md)).
   - No frame is judged twice: appends are sequenced by the branch row's lock,
     so neither process emits a `DraftCasConflictError` for a frame. Read
     `collab.branch.append_committed` (debug) for each key's `waitMs` and `holdMs`.
   - A live edit pulled by both processes lands once; the loser sees `moved`.
   - Equal hashes after the reload are not enough on their own.
   The second server mirrors events to `logs/events-p6b.server.meridian/`.
5. Stop the second server with Ctrl-C, close only your browser sessions, and run
   `pnpm dev --stop`.
