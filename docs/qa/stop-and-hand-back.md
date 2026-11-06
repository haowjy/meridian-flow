# Stop and hand-back probes

These live checks cover Stop decisions that depend on the adapter's lease and
receipt state. Run each with a fresh thread and confirm the browser last.

## Setup

Follow [Runtime probes](runtime-probes.md#setup): use a disposable
worktree, `MODEL_PROVIDER=mock pnpm dev`, `pnpm portless:list`, and explicit
`MF_APP_URL` and `MF_SERVER_URL`. Set `E` to a directory under the work item's
`evidence/`.

```bash
seen() { ./mf api GET "/api/threads/$T/snapshot" | jq -c '.liveState.runState | {seenThrough:.sentThrough, seenExecutionId:(.execution.executionId // null)}'; }
stop() { ./mf api POST "/api/threads/$T/stop" --json --data "{\"requestId\":\"$(node -p 'crypto.randomUUID()')\",\"seenThrough\":$1,\"seenExecutionId\":${2:-null},\"mine\":${3:-[]}}"; }
```

Hold a reply open with a delayed mock, queue messages behind it, and read the
inbox and turns with `tools/dev/psql`. A handed-back row has
`delivered_at` set, no `delivered_by_turn_id`, and `handed_back_by` set. A row
answered by a run has `delivered_by_turn_id` set.

```bash
./mf thread send "$T" first --mock '[{"text":"A long reply.","delayMs":20000}]' --json > "$E/first.ndjson" & FIRST=$!
for i in $(seq 20); do sleep 1; seen | grep -q '"seenExecutionId":"' && break; done
```

Use these readbacks after every decision:

```sql
SELECT seq, provenance->>'kind' AS prov, delivered_at IS NOT NULL AS delivered,
  delivered_by_turn_id, handed_back_by
FROM thread_inbox_messages WHERE thread_id = '<T>' ORDER BY seq;
SELECT id, role, status, execution_id FROM turns
WHERE thread_id = '<T>' ORDER BY created_at;
```

Read the database through this worktree's `tools/dev/psql`; do not infer the
decision from a background `send` exit code. Join every background send with
`wait`. In the browser, repeat the same action with the Stop button and compare
the composer and rows with `./mf thread view --json`.

## SB-26: a send in flight at the press is untouched

Let M1 settle and read `seen`. Send M2 with `--no-wait`, then call `stop` with
the old `seenThrough` and `seenExecutionId: null`, as a screen that has not yet
seen M2 would.

Expect empty `handedBack`, `answered`, and `gone`, with no
`cancelledExecutionId`. M2 is answered normally and no row has
`handed_back_by`. Repeat in two browser tabs; the tab that has not seen M2 must
not remove it.

Capture the old values before dispatching M2:

```bash
S=$(seen); ./mf thread send "$T" M2 --no-wait --json & M2=$!
stop "$(jq .seenThrough <<<"$S")" "$(jq .seenExecutionId <<<"$S")"
wait "$M2"
```

## SB-28: an empty lease with no carried turn is not an execution

Create a lease without a turn by delaying a reply before its turn is reserved,
or by using the dead-holder state from [RP-5](runtime-probes.md#rp-5-kill-the-server-mid-summary).
Queue M2, read `seen` with no execution id, and call `stop`.

Expect M2 in `handedBack` with its content, `cancelledExecutionId: null`, a
`handed_back_by` value, and no reply for M2. The lease is not reported as a
cancelled execution.

## SB-30: Stop on a running Retry

Fail a reply, then start its Retry with a delayed mock script:

```bash
./mf thread send "$T" hi --mock '[{"error":{"status":400,"message":"boom"}}]' --json
FAILED=$(./mf thread view "$T" --json | jq -r '.turns | map(select(.role == "assistant" and .status == "error")) | last.id')
./mf mock script '[{"text":"Retried.","delayMs":20000}]' --match hi
./mf api POST "/api/threads/$T/turns/$FAILED/retry" --data "{\"id\":\"$(node -p 'crypto.randomUUID()')\"}" --json
```

Read `seen`, then call `stop` with its values. The Retry execution is cancelled,
the Retry reply settles as `cancelled`, nothing is handed back, and the browser
retires the stand-in without restoring the failed reply.

## SB-01: Stop on a streaming reply

With the delayed reply above streaming and its message adopted into the receipt,
call `stop` with the current `seen` values. Expect the open execution in
`cancelledExecutionId`, the adopted message in `answered`, nothing in
`handedBack`, and the reply's partial text preserved. The browser removes Stop,
keeps the partial text and shows the action row; `thread view` reports
`(cancelled)`.

## SB-12: a later steer is already adopted

While E1 streams, send M1 and M3 so both are adopted into its receipt. Use the
watermark for M1 with E1's execution id in `stop`.

Expect no `cancelledExecutionId`: E1 keeps running because it adopted M3 above
the watermark. M1 is handed back, M3 remains adopted, and E1 later answers M3.

Stop the owned stack with `pnpm dev --stop` after the browser checks.
