# Stop and hand-back probes

Written steps for nine pure rows of Stop's decision rule (design A, section 3) that no longer have
a unit case in `runtime/loop/stop-rule.test.ts`. Each step names what still pins the row's risk
automatically. Row numbers are the design's. A step is not a claim that it passed on the current
commit: record the commit, date, provider and evidence path after each run, in the active work
directory.

## Setup

Follow [Runtime probes](runtime-probes.md#setup-and-evidence): a disposable worktree, `MODEL_PROVIDER=mock pnpm dev`,
`pnpm portless:list`, routes that carry this worktree's prefix, `MF_APP_URL` and `MF_SERVER_URL` passed
explicitly, and `E` set to a directory under the work item's `evidence/`. Create the probe Agent and a
thread `T` as there. Every step below uses a fresh thread.

Helpers (existing routes, no new verbs). `seen` reads what the writer saw from the run-state record in the
raw snapshot (`thread view --json` prints the app's chat rows, which carry no run-state record). `stop`
takes `seenThrough`, then `seenExecutionId` (a quoted id or `null`), then `mine` (a JSON array):

```bash
seen() { ./mf api GET "/api/threads/$T/snapshot" | jq -c '.liveState.runState | {seenThrough:.sentThrough, seenExecutionId:(.execution.executionId // null)}'; }
stop() { # $1 = seenThrough, $2 = "\"<executionId>\"" or null, $3 = mine (JSON array)
  ./mf api POST "/api/threads/$T/stop" --json --data "{\"requestId\":\"$(node -p 'crypto.randomUUID()')\",\"seenThrough\":$1,\"seenExecutionId\":${2:-null},\"mine\":${3:-[]}}"
}
# S=$(seen); stop "$(jq .seenThrough <<<"$S")" "$(jq .seenExecutionId <<<"$S")"
```

Hold a reply open with a delayed mock script, send writer messages behind it (they queue, `Queued` in
the app), then press Stop:

```bash
./mf thread send "$T" first --mock '[{"text":"A long reply.","delayMs":20000}]' --json > "$E/first.ndjson" & FIRST=$!
for i in $(seq 20); do sleep 1; seen | grep -q '"seenExecutionId":"' && break; done   # the reply is streaming
```

`--mock` scripts match the thread's latest user message and are removed when the send settles. A script
queued with `./mf mock script '<steps>' --match '<text>'` stays until `./mf mock clear`; run that after
a step that queued one. An error step is `{"error":{"status":400,"message":"boom"}}`.

SQL reads (`psql "$DATABASE_URL"` for this worktree's database): the inbox rows with their hand-back
mark, the open execution, and the turns.

```sql
SELECT seq, provenance->>'kind' AS prov, delivered_at IS NOT NULL AS delivered, delivered_by_turn_id, handed_back_by FROM thread_inbox_messages WHERE thread_id = '<T>' ORDER BY seq;
SELECT id, role, status, execution_id FROM turns WHERE thread_id = '<T>' ORDER BY created_at;
```

Substitute the thread id for `<T>`. `DATABASE_URL` is the one in the dev server's environment
(`/proc/<pid>/environ` of the `run-state.server` owner), not necessarily the shell's. A handed-back row has
`delivered` true (it left the queue), `delivered_by_turn_id` null and `handed_back_by` set; a message a
run answered has `delivered_by_turn_id` set. Join every background `send` with `wait`, but do not use its
exit code or result as evidence: it runs unattended and a Stop races it. After a Stop a queued `send`
reports `handed_back` or `cancelled` (exit 5), not `timeout`. Read the `turns` rows.

For each step, confirm in the browser last: open the thread, repeat the action with the Stop button, and
check that the composer and the rows match `thread view --json`.

The composer has one button (owner ruling). With the box empty and a reply running it is Stop (Stopping
is its spinning ring; a failed Stop is the red "Couldn't stop the reply." card above the box with Try again, which
re-posts the same request and stays until the Stop is confirmed; once its reply ends, a Stop that had queued messages reads "Couldn't move your
queued message to the message box.", plural for several, and a refused one reads "Couldn't move your queued
message." with Dismiss; a Stop with nothing queued shows no card, and the button is no longer failed); once you type it is Send with the
running ring, the card stays, and clearing the text brings Stop back. Escape stops only while Stop shows. After a
Stop hands a steer back, the box holds it and the button is Send.

## SB-31: a failed Stop with nothing queued is moot once its reply ends

- **Setup:** a slow mock reply (`--mock '[{"text":"Slow.","delayMs":30000}]'`) streaming in the browser. In
  `agent-browser`, make `POST /api/threads/<id>/stop` fail (`network route ... --abort`).
- **Action:** press Stop with nothing queued; let the reply end (or `./mf thread stop` it from elsewhere).
- **Expect:** while the reply runs, the red "Couldn't stop the reply." card with Try again. After it ends, no
  card, and the button is no longer failed. Repeat with one queued message and a *lost response*
  (the request reaches the server, then rejects, as in QC-05) instead of an aborted request: the card stays,
  now "Couldn't move your queued message to the message box." with Try again, and the live region follows
  the card's new sentence. With an aborted request the server never took the message, so the next reply
  answers it and the card goes.
- **Pinned by:** the `operation.test.ts` case "a failed Stop with nothing queued".

## SB-26: a send in flight at the press is untouched (row 26)

- **Setup:** idle thread (no execution). Send M1 and let it settle. Read `seen`: `seenThrough` is M1's seq.
- **Action:** send M2 with `--no-wait` (its seq is above the watermark), then `stop` with the **old**
  `seenThrough` and `seenExecutionId: null`, as a press from a screen that had not yet shown M2.
- **Expect:** `handedBack`, `answered` and `gone` are all empty, `cancelledExecutionId` is null. M2 is
  answered normally, and no row has `handed_back_by` set.
- **Still pins it:** DB rows 7 and 8 (a send committing after the press keeps its place, a batch prepared
  before the press is re-selected) and browser item 4 (two tabs).

## SB-20: a child report wake is not the execution the writer saw (row 20)

- **Setup:** queue a delayed reply for the wake, then spawn a background child from M1:

  ```bash
  ./mf mock script '[{"text":"Wake reply.","delayMs":25000}]' --match 'finished (succeeded)'
  ./mf thread send "$T" 'Spawn a check' --mock '[{"toolCalls":[{"name":"spawn","args":{"prompt":"Inspect","name":"Check","mode":"background"}}]},{"text":"Started."}]' --json
  ```

  The child's report (`finished (succeeded)`) opens execution E3 with only that report in its receipt,
  and the delayed reply keeps E3 open (`turns` shows it `streaming`, and the inbox has a `child` row).
  `seen` now names E3. M1's seq, from the inbox read, is the earlier `seenThrough`, with
  `seenExecutionId: null`.
- **Action:** `stop <M1 seq> null`, as from a screen that had not yet shown E3.
- **Expect:** `cancelledExecutionId` is null; E3 keeps running; `handedBack`, `answered` and `gone` are
  all empty. M1 is delivered, but not by E3 and not handed back, so the press names it nowhere (it is
  not in `answered`). A press that names E3 in `seenExecutionId` cancels it instead.
- **Why a probe:** the unit case fed prefiltered writer facts, so it never checked that the receipt's
  child provenance is dropped. Only the real adapter can show that.
- **Still pins it:** DB row 34 (a wake that adopts the message answers it and hands nothing back).

## SB-27: Stop on an idle chat decides nothing (row 27)

- **Setup:** idle thread, nothing waiting, nothing running.
- **Action:** `stop 0 null`.
- **Expect:** 200 with empty `handedBack`, `answered`, `gone`; `cancelledExecutionId` null. `thread events`
  shows no new record for this press beyond the unchanged run-state; the inbox and turns reads are
  unchanged. A replay of the same `requestId` returns the same body.
- **Still pins it:** DB row 36 (replay answers the stored decision) and browser item 11 (the control state
  after a press).

## SB-28: an empty lease no turn carries is not E (row 28)

- **Setup:** make the lease exist without a turn: start a reply whose model request is delayed by the
  mock before any turn is reserved, or, after a crash probe (see RP-5/RP-8 in
  [Runtime probes](runtime-probes.md)), the claim a dead holder left. Queue M2 behind it.
- **Action:** read `seen` (`seenExecutionId` is null because no turn carries the lease), then `stop`.
- **Expect:** M2 is in `handedBack` with its content; `cancelledExecutionId` is null; the lease is not
  reported as a cancelled execution; M2 has `handed_back_by` set and no reply starts for it.
- **Why a probe:** the unit input matched row 2's decision shape with other IDs. The distinction is in the
  adapter, where the lease row is read without a turn.
- **Still pins it:** DB row 24 (a dead holder's reply keeps its message and the press hands the waiting
  one back) and row 3 (no reply starts).

## SB-30: Stop on a running Retry (row 30)

- **Setup:** make a reply fail (`./mf thread send "$T" hi --mock '[{"error":{"status":400,"message":"boom"}}]'`; the last assistant
  turn in `turns` is `<failed>`), then start Retry with a delayed script:

  ```bash
  ./mf mock script '[{"text":"Retried.","delayMs":20000}]' --match hi
  ./mf api POST "/api/threads/$T/turns/<failed>/retry" --data "{\"id\":\"$(node -p 'crypto.randomUUID()')\"}" --json
  ```

  Read `seen`: the Retry's execution is open.
- **Action:** `stop` with that `seenThrough` and `seenExecutionId`.
- **Expect:** `cancelledExecutionId` is the Retry's execution; the Retry reply settles cancelled; nothing
  is handed back. In the browser, the stand-in retires and the failed reply does not return.
- **Still pins it:** browser item 7 (Stop a running Retry) and the row 22 unit case, which shares the
  decision input (an open execution the writer saw, nothing waiting).

## SB-01: Stop on a streaming reply (row 1)

- **Setup:** `first` streaming (the hold above), M1 adopted into it by the reply's receipt.
- **Action:** `stop` with the `seen` values.
- **Expect:** `cancelledExecutionId` is the open execution; `answered` holds M1; `handedBack` is empty.
  The reply is cancelled with its partial text kept; M1 stays in the chat, answered by the cancelled
  reply. `first`'s send reports `timeout`; its `turns` row is `cancelled`.
- **Still pins it:** DB rows 23 and 24 (the live holder cancels, a dead holder's reply keeps its message)
  and browser item 1 (Stop a streaming reply, desktop and phone).

## SB-02: a waiting message with no execution (row 2)

- **Setup:** make M1 wait with no lease. Two ways: the usage-blocked variant from
  [Saved messages waiting for usage](usage-waiting.md) (the message waits, nothing runs), and a message
  that waits after an applied switch (browser item 2).
- **Action:** `stop` with the `seen` values (`seenExecutionId: null`).
- **Expect:** M1 is in `handedBack` with its content; `cancelledExecutionId` null; M1 has `handed_back_by`
  set and is in no conversation read (`thread context --all --view raw --json`). No reply starts. In the
  browser, the text is in the composer.
- **Still pins it:** DB rows 3 and 7 (no reply starts after the hand-back).

## SB-04: a successor reservation before the press (row 4)

- **Setup:** an assistant reply E1 is streaming; send M2. Wait until the wake reserves reply B for M2
  (`turns` shows B with E2's execution id, and `seen` names E2).
- **Action:** `stop` naming the **older** execution E1 in `seenExecutionId` and M2's seq as
  `seenThrough`.
- **Expect:** E2 is cancelled; `answered` holds M2; nothing is handed back.
- **Still pins it:** DB row 6 (cancelling an adopted press-set message).

## SB-12: a later steer already adopted (row 12)

- **Setup:** reply E1 streaming; send M1, then M3, both adopted into the open execution's receipt.
  `seenThrough` for the press is M1's seq.
- **Action:** `stop` with M1's seq and E1.
- **Expect:** `cancelledExecutionId` is null: E1 keeps running because it took on M3, which is above the
  watermark; `answered` holds M1; nothing handed back. E1 later answers both.
- **Still pins it:** DB rows 5 and 9 (a mixed batch the press only half covers keeps running; a press
  that waits on the wake's lock finds M3 taken on).

## Remaining pure rows

Rows 10, 13, 15, 17, 18, 19, 21, 22, 25a, 25b, 25c and 29 keep their unit cases.
