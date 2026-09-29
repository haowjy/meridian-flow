# Runtime protocol probes

These back up the automated control, compaction, undo, handoff, and history
contracts. They do not replace the project checks. `C` means a compaction turn;
`B` an assistant continuation; `S` a handoff seed. Only `compact` and
`compaction_undo` are inbox controls; the handoff brief runs outside the inbox.

## Setup and evidence

Use a disposable worktree. `pnpm bootstrap` provisions its database if needed.
Migration 0021 is edited in place; reset existing worktree dev and test databases
that already applied it with `pnpm db:reset` before running migrations or probes.
Start `MODEL_PROVIDER=mock pnpm dev --no-tailscale`, then `pnpm portless:list`.
Use only that worktree's routes. All commands below run from its checkout.
Set `E` to a directory under the active work item's `evidence/`, not the repo.
UUIDs can be generated with `node -p 'crypto.randomUUID()'`.

Publish a private probe Agent and create a thread (the response uses `threadId`):

```bash
./mf api POST /api/agents --data '{"slug":"runtime-probe","content":"---\nname: Runtime Probe\nmode: primary\nmodel: mock-llm-v1\nautocompact: 100000\n---\nFollow the writer."}' --json > "$E/agent.json"
./mf thread create --agent runtime-probe --work @/ --title 'Runtime probe' --json > "$E/thread.json"
T=$(jq -r .threadId "$E/thread.json")
```

For a compactable thread, send tens of thousands of characters of distinctive
history, then another writer/reply pair. The newer pair is retained; the older
history must exceed the manual compaction floor. A short thread should refuse
with `nothing_to_compact`, not call the summarizer. Use `send --mock` for replies:

```bash
./mf thread send "$T" "$(python3 -c 'print("The silver gate opens only for the keeper. " * 1400)')" \
  --mock '[{"text":"The keeper remembers the silver gate."}]' --json > "$E/history.ndjson"
./mf thread send "$T" 'Remember the keeper.' --mock '[{"text":"The keeper waits."}]' --json > "$E/tail.ndjson"
```

The snippets use these shell helpers. They use existing API routes, not new CLI verbs:

```bash
compact() {
  K=$(node -p 'crypto.randomUUID()')
  ./mf api POST "/api/threads/$T/controls" \
    --data "{\"id\":\"$K\",\"control\":{\"kind\":\"compact\"}}" --json
}
undo() {
  U=$(node -p 'crypto.randomUUID()')
  ./mf api POST "/api/threads/$T/controls" \
    --data "{\"id\":\"$U\",\"control\":{\"kind\":\"compaction_undo\",\"compactionTurnId\":\"$C\"}}" --json
}
```

If the snapshot is already terminal, do not start a fresh `thread tail`: it
may wait for an event that already happened. Poll `thread view --json` with a
bounded deadline and check the control UUID and terminal status; use
`thread tail --until-idle --timeout 60s` only while a run is active. During races,
inspect `thread view` until the intended turn is pending/streaming before taking
the next action; a sleep alone does not prove the race window was reached.
Join every background `send` with `wait`. Cancelled sends exit 5 and failed sends
exit 1; record those outcomes rather than masking them as successful runs.

For every probe save `thread view --json`, `thread context --all --view raw
--json`, `log --thread "$T" --json`, and the control responses. Compare the
serialized **message prefix**, not request IDs, timestamps, usage, or the newly
appended writer message. Preserve the compared message arrays and their hashes.

Worked examples: [C6a command transcript][c6a] and [merge-gate report][merge].
The first merge-gate report explicitly failed real-provider scenarios because
of billing settlement; its mock and crash successes are not evidence of real
cache warmth. Historical run dates below come from timestamps in the saved JSON events
and snapshots, not file modification times. The current catalog has not been run
end-to-end as one suite.

## RP-1: Failed replies need explicit Retry

- **Protects:** a failed reply consumes its adopted messages once, stays failed,
  and is not restarted by release wakes or the 30-second sweep. Retry is an
  ordinary no-input run with normal history; replaying its client ID returns
  that turn. Pending non-control inbox rows do not block Retry.
- **Stack:** mock, real wall clock.
- **Steps:** install a sticky provider failure, send a message, and record the
  failed assistant ID. Leave the thread idle for one sweep interval, then Retry
  the failed turn twice with the same client-minted ID:

  ```bash
  ./mf mock script '[{"error":{"status":500,"message":"RP1 provider unavailable"}}]' --json > "$E/error-script.json"
  ./mf thread send "$T" 'RP1 failed reply' --json > "$E/send.ndjson"
  FAILED=$(tail -n 1 "$E/send.ndjson" | jq -r .turnId)
  ./mf thread view "$T" --json > "$E/failed.json"
  sleep 30
  ./mf log --thread "$T" --json > "$E/idle.json"
  RETRY=$(node -p 'crypto.randomUUID()')
  ./mf api POST "/api/threads/$T/turns/$FAILED/retry" --data "{\"id\":\"$RETRY\"}" --json > "$E/retry.json"
  ./mf api POST "/api/threads/$T/turns/$FAILED/retry" --data "{\"id\":\"$RETRY\"}" --json > "$E/retry-replay.json"
  ```

- **Expect:** no provider call during the idle interval; the first Retry returns
  201 with a new failed assistant after the unchanged original; the replay
  returns 200 with the same turn. A queued compact runs immediately after a
  failure rather than waiting behind failed messages.
- **Evidence:** failed and retried snapshots, timeline of gateway and turn
  events, both response statuses, and no extra request during the idle interval.
- **Last run:** not recorded for this exact wall-clock recipe. Automated
  sweep-boundary coverage is not a substitute for running it.

## RP-9: Production signals drain; dev signals recover as crashes

- **Protects:** production Nitro runs the bounded signal drain, while upstream
  Nitro dev terminates its worker promptly and exercises crash repair.
- **Stack:** mock provider, real process signals; run separately in dev and
  production preview/start.
- **Steps:** use the mock `cancel billing` response, which emits partial text
  and usage before it stalls. Send a writer message, wait until the assistant
  is streaming, record the server PID and send it SIGTERM; repeat with SIGINT
  on a fresh thread. After each process exits, inspect the durable thread and
  billing rows from a newly started server.
- **Expect (production):** exit occurs after the in-flight paid response is
  persisted and debited once; the reply is `error` with `This response failed.`
  and internal shutdown reason, its adopted inbox message is acknowledged,
  no successor starts during shutdown, and Retry works after restart.
- **Expect (dev):** Ctrl+C and SIGTERM exit promptly. After restart, orphan
  repair marks the reply failed with generic copy and the internal `orphaned`
  reason and
  acknowledges every message named by its receipt. Those messages are not
  answered automatically; only never-adopted queued-behind messages remain in
  the inbox. Retry re-answers explicitly.
- **Evidence:** signal and exit timestamps, process log showing signal-handler
  ordering, settled reply and response rows, ledger debit, empty pending inbox,
  and post-restart Retry result.

## RP-2: Compact waits for the end of the queue

- **Protects:** commands wait until messages are answered; Esc runs the command
  first with its waiting messages pinned (`control-protocol`).
- **Stack:** mock.
- **Steps:** after setup, start a delayed reply and wait until streaming. Enqueue
  compact, then send `hi2`. Repeat with `hi1` queued before compact and a second
  message after it. For the Esc variant on a fresh thread, queue compact and a
  message during a delayed reply, then use Stop (Esc) before the reply ends.

  ```bash
  ./mf thread send "$T" hi --mock '[{"text":"reply to hi","delayMs":5000}]' --json > "$E/hi.ndjson" & SEND=$!
  ./mf thread view "$T" --json
  ./mf mock script '[{"text":"Earlier context summary."}]' --json
  compact > "$E/compact.json"
  ./mf thread send "$T" hi2 --mock '[{"text":"reply to hi2"}]' --json > "$E/hi2.ndjson"
  wait "$SEND"
  ```

  For the Esc variant, repeat on a fresh compactable thread. Start another
  delayed reply, wait until streaming, and read its live assistant turn id from
  `thread view --json`, then:

  ```bash
  ./mf thread send "$T" hi --mock '[{"text":"reply to hi","delayMs":5000}]' --json > "$E/esc-hi.ndjson" & SEND=$!
  ./mf thread view "$T" --json
  # Set RUNNING_TURN_ID from the active assistant in the view.
  compact > "$E/compact.json"
  ./mf thread send "$T" 'Keep this message after Esc.' --json > "$E/waiting.ndjson" & WAITING=$!
  ./mf thread cancel "$T" --turn "$RUNNING_TURN_ID" --json
  ./mf thread tail "$T" --until-idle --timeout 60s --json
  wait "$WAITING"
  wait "$SEND"
  ```

- **Expect:** normal variants answer every queued message before C; the command
  stays queued until the messages finish and never runs at a tool boundary. If
  automatic compaction occurs first, the command is not absorbed; it runs at the
  end of the queue and either compacts new history or refuses with
  `nothing_to_compact`. On Stop, the stamped command runs
  first, the waiting message appears verbatim among C's pinned requests, and
  the message is answered after C. No message is lost or answered twice.
- **Evidence:** admitted messages, control UUID, final roles and request messages.
- **Last run:** not recorded for the end-of-queue and Esc variants.

## RP-3: Withdraw only before the command starts

- **Protects:** withdrawal/start ownership and replay outcomes
  (`control-protocol`: `withdrawn` before start; `already_started` after).
- **Stack:** mock.
- **Steps:** use RP-2's delayed active reply, enqueue compact, and withdraw it
  twice while queued. Repeat on a compactable idle thread with a delayed
  summary, waiting until C is pending before withdrawing:

  ```bash
  ./mf thread send "$T" 'Hold the reply open.' --mock '[{"text":"Working","delayMs":5000}]' --json > "$E/withdraw-hi.ndjson" & SEND=$!
  # Wait until streaming, then enqueue and withdraw the same control twice.
  compact > "$E/withdrawn-compact.json"
  ./mf api POST "/api/threads/$T/controls/$K/withdraw" --json > "$E/withdraw.json"
  ./mf api POST "/api/threads/$T/controls/$K/withdraw" --json > "$E/withdraw-replay.json"
  wait "$SEND"

  # On a compactable idle thread, poll until C is pending after reservation.
  ./mf mock script '[{"text":"Delayed summary","delayMs":10000}]' --json
  compact > "$E/compact.json"
  ./mf thread view "$T" --json
  ./mf api POST "/api/threads/$T/controls/$K/withdraw" --json > "$E/withdraw.json"
  ./mf thread tail "$T" --until-idle --timeout 60s --json
  ```

- **Expect:** withdrawal before start returns `withdrawn`, including on replay,
  and creates no C. Withdrawal after C records the control id returns
  `already_started`; it does not stop C, which completes normally.
- **Evidence:** pre-withdraw snapshot, withdrawal outcome, terminal turn statuses.
- **Last run:** not recorded for the `already_started` outcome.

## RP-4: Proactive autocompaction and byte-stable continuation

- **Protects:** C/B successor protocol, arrival order, frozen request prefix
  (`compaction-protocol`).
- **Stack:** mock for structure; real provider separately for cache-read evidence.
- **Steps:** publish a second Agent using setup's API with slug `runtime-probe-auto`
  and `autocompact: 12000`. Create its thread. Send large replies with `--mock`
  until the next send triggers C. Save context before the trigger, immediately
  after C/B, and after one further short send:

  ```bash
  ./mf thread context "$T" --all --view raw --json > "$E/before.json"
  ./mf mock script '[{"text":"Short earlier context."},{"text":"Continue after C."}]' --json
  ./mf thread send "$T" 'Continue the story' --json > "$E/trigger.ndjson"
  ./mf thread context "$T" --all --view raw --json > "$E/after.json"
  ./mf thread send "$T" 'And then?' --mock '[{"text":"Next beat."}]' --json
  ./mf thread context "$T" --all --view raw --json > "$E/following.json"
  ```

- **Expect:** C then B in the same run; summary plus retained tail in the next
  request. The following request extends the identical serialized prefix.
- **Evidence:** C metadata, before/after/following requests, prefix comparison;
  real-provider variant also records usage, cache reads and actual spend.
- **Last run:** merge-gate §13–16 mock PASS; original real run FAIL (billing
  settlement), 2026-09-28 (source commit not recorded in that report). Do not mark real PASS
  from the mock result.

## RP-5: Kill the server mid-summary

- **Protects:** dead lease repair, consumed-at-start commands, and waiting
  message delivery (`control-protocol` interrupted summary).
- **Stack:** mock, isolated owned server process, real Postgres.
- **Steps:** queue a 30-second summary, compact, and send a message while C is
  pending. Save the pre-kill snapshot. Resolve this worktree's server wrapper
  with `pnpm portless:list`, inspect its Nitro child and `/proc/<pid>/cwd`, then
  `kill -9 <verified-owned-nitro-pid>`. Never kill Postgres or another stack.
  Restart with `MODEL_PROVIDER=mock pnpm dev --restart --no-tailscale`; inspect.
  Do not re-enqueue the compact command after restart.

  ```bash
  ./mf thread tail "$T" --until-idle --timeout 120s --json
  ./mf thread view "$T" --json
  ./mf log --thread "$T" --json
  ```

- **Expect:** dead C is error with interrupted/recovery metadata; its consumed
  command is not redelivered. The queued message remains pending and is
  delivered after C. This is queued-behind work, not an adopted reply input: if
  a reply itself crashes, repair acknowledges its adopted receipt and shows one
  generically failed reply rather than answering those inputs automatically. No stuck
  placeholders.
- **Evidence:** PID/cwd ownership, kill result, pre/post snapshots, recovery
  events, command id and final turn statuses.
- **Last run:** not recorded for no-redelivery behavior.

## RP-6: Manual compact then Undo restores request bytes

- **Protects:** restored bake, undo without provider generation (`compaction-undo`).
- **Stack:** mock.
- **Steps:** save setup's last request. Queue a summary, compact, and wait idle.
  Set `C` to the complete compaction turn ID from `thread view --json`. Then:

  ```bash
  undo > "$E/undo.json"
  ./mf thread tail "$T" --until-idle --timeout 60s --json
  ./mf thread send "$T" 'After undo' --mock '[{"text":"Restored."}]' --json
  ./mf thread context "$T" --all --view raw --json > "$E/restored.json"
  ```

- **Expect:** U completes with the pre-C bake. No summary/provider request for U;
  the next reply's request extends the byte-identical pre-C message prefix.
- **Evidence:** pre-C and restored message arrays/hashes, C/U metadata, provider call log.
- **Last run:** 2026-09-28, this test-hygiene worktree at base `22f2989bc`
  plus test/doc edits, PASS. `evidence/test-hygiene/probe-prefix-assertion.json`
  records 8 equal messages (70,510 bytes). Earlier merge-gate §10–11 also PASS.

## RP-7: Refused Undo reports `would_recompact`

- **Protects:** advisory and execution use the same fit rule (`compaction-undo`).
- **Stack:** mock, low-threshold Agent from RP-4.
- **Steps:** obtain an auto C with over-threshold pre-C context. Read the snapshot
  advisory, set `C`, enqueue Undo even if the UI would not offer it, then inspect:

  ```bash
  ./mf api GET "/api/threads/$T/snapshot" --json > "$E/advisory.json"
  undo > "$E/undo.json"
  ./mf thread tail "$T" --until-idle --timeout 60s --json
  ./mf thread view "$T" --json
  ./mf thread context "$T" --all --view raw --json
  ```

- **Expect:** advisory `would_recompact`; U errors with that reason and no block.
  The active compacted prefix is unchanged.
- **Evidence:** advisory, marker blocks/metadata, before/after context.
- **Last run:** merge-gate §31 PASS for advisory; executing the refused control
  is not recorded there. Full recipe not yet recorded.

## RP-8: Handoff brief, Stop, Retry, failure and source isolation

- **Protects:** destination run-claim ownership, detached launch, Stop, Retry,
  release wake, and orphan repair (`handoff/brief-service`).
- **Stack:** mock; a real provider is required to compare predicted cache state
  with actual cache use.
- **Steps:** choose a settled reply ID `CUT` from source `T`, allocate `DEST`,
  and use the exact selection returned by setup (do not guess a revision). Delay
  the brief so the destination claim remains held:

  ```bash
  DEST=$(node -p 'crypto.randomUUID()')
  jq --arg id "$DEST" --arg cut "$CUT" '{id:$id,originTurnId:$cut,agentSelection:.selection}' "$E/agent.json" > "$E/handoff-body.json"
  ./mf mock script '[{"text":"Brief: keep the silver gate secret.","delayMs":5000}]' --json
  ./mf api POST "/api/threads/$T/handoff" --data @"$E/handoff-body.json" --json
  S=$(./mf thread view "$DEST" --json | jq -r '.turns[0].id')
  ./mf thread send "$DEST" hi --mock '[{"text":"Hello from the destination."}]' --json > "$E/queued-hi.ndjson" & SEND=$!
  ./mf api POST "/api/threads/$DEST/handoff/brief" --data "{\"id\":\"$(node -p 'crypto.randomUUID()')\"}" --json > "$E/retry-while-pending.json"
  ./mf thread view "$DEST" --json
  ./mf thread cancel "$DEST" --turn "$S" --json
  ./mf mock script '[{"text":"Retried brief."}]' --json
  S2=$(node -p 'crypto.randomUUID()')
  ./mf api POST "/api/threads/$DEST/handoff/brief" --data "{\"id\":\"$S2\"}" --json > "$E/retry.json"
  ./mf api POST "/api/threads/$DEST/handoff/brief" --data "{\"id\":\"$S2\"}" --json > "$E/retry-replay.json"
  wait "$SEND"
  ./mf thread context "$DEST" --all --view raw --json
  ```

- **Expect:** POST handoff returns before the brief ends. While it runs,
  `thread.status` is `awake/generating` with no running turn id, queued work is
  not answered, and Retry returns 409 `handoff_retry_unavailable`. Stop settles
  S cancelled; claim release starts the queued reply. Retry after Stop appends
  S2 and returns before its brief ends; replaying S2 returns the same seed with
  200. Destination context contains the brief/source ref, never source transcript
  text. The brief has no fallback: a failed attempt shows `No brief is
  available.` and Retry is the next attempt.
- **Crash variant:** start a second delayed handoff, kill the app process while
  its brief is in flight, restart it, and wait one orphan-repair interval. S
  settles with generic failure copy, internal `interrupted` reason, an
  unavailable card, and a history read line; thread
  status returns idle and a queued destination message is answered. No brief is
  relaunched. That destination message was never adopted while S held the claim;
  adopted inputs of a crashed reply instead fail once with that reply. A focused
  PostgreSQL test covers ending-transaction failure: S
  remains pending, the claim releases, and the next run repairs it.
- **Evidence:** request status and response timing, source sentinel and source
  lease before/after, destination queue and transcript, Retry HTTP status/code,
  S/S2 states and card blocks. For real-provider runs also capture summary
  path/cache metrics for recent and older cutoffs.
- **Last run:** merge-gate §21–24 mock PASS; original real warm/cold run blocked
  by billing settlement. 2026-09-28 (source commit not recorded).

## RP-9: Fork prefix remains frozen as source grows and compacts

- **Protects:** inherited cutoff/bake ownership (`compaction-protocol`, `compaction-undo`).
- **Stack:** mock.
- **Steps:** choose settled `CUT`, allocate `FORK`, and fork. Send on the fork and
  save context, then grow and compact the source via RP-6. Send on the fork again:

  ```bash
  FORK=$(node -p 'crypto.randomUUID()')
  ./mf api POST "/api/threads/$T/fork" --data "{\"id\":\"$FORK\",\"originTurnId\":\"$CUT\"}" --json
  ./mf thread send "$FORK" 'Fork before source growth' --mock '[{"text":"Fork reply."}]' --json
  ./mf thread context "$FORK" --all --view raw --json > "$E/fork-before.json"
  # Grow and compact source T, then:
  ./mf thread send "$FORK" 'Fork after source compaction' --mock '[{"text":"Still independent."}]' --json
  ./mf thread context "$FORK" --all --view raw --json > "$E/fork-after.json"
  ```

- **Expect:** inherited prefix bytes do not change; later source turns/C/U do not
  appear in the fork's inherited transcript.
- **Evidence:** source and fork snapshots plus inherited-prefix arrays/hashes.
- **Last run:** merge-gate §8–12 PASS; 2026-09-28 (source commit not recorded).

## RP-10: Compaction elides stale document text

- **Protects:** frozen revision elisions, not stale prose (`compaction-protocol` C5).
- **Stack:** mock.
- **Steps:** create a sentinel chapter and read it through a model tool call. Add
  enough older history to compact, overwrite the document, compact and send again:

  ```bash
  ./mf doc put manuscript://rp10.md --text 'RP10_OLD_SENTINEL' --json
  ./mf thread send "$T" 'Read the chapter' --mock '[{"toolCalls":[{"name":"write","args":{"command":"read","path":"manuscript://rp10.md"}}]},{"text":"Read."}]' --json
  ./mf doc put manuscript://rp10.md --text 'RP10_NEW_SENTINEL' --overwrite --json
  ./mf mock script '[{"text":"Earlier planning context."}]' --json
  compact
  ./mf thread tail "$T" --until-idle --timeout 60s --json
  ./mf thread send "$T" 'Continue' --mock '[{"text":"Continued."}]' --json
  ./mf thread context "$T" --all --view raw --json
  ```

- **Expect:** the post-C request excludes `RP10_OLD_SENTINEL`; retained stale
  reads use the re-read stub. Historical debug captures may still contain old
  text: inspect the successor request, not every captured request concatenated.
- **Evidence:** read result, document overwrite, elision metadata, successor request.
- **Last run:** exact C5 recipe not recorded. Merge-gate §20 demonstrates related
  stale-read/history inspection, not this complete compaction sequence.

## RP-11: `from` spawn and inspection filters

- **Protects:** reference-only spawning, scope checks, explicit history inspection
  (`handoff-protocol` C9 and `history-tools`).
- **Stack:** mock, parent Agent with a configured foreground subagent target
  (publish a subagent with setup's API, `mode: subagent`, and mock model).
  The worked merge-gate script uses the default target; no new CLI verb is required.
- **Steps:** seed a distinctive source sentinel, then script a foreground spawn:

  ```bash
  ./mf thread send "$T" 'Spawn a reference check' --mock '[{"toolCalls":[{"name":"spawn","args":{"prompt":"Inspect the referenced chat","description":"Reference check","from":"current","mode":"foreground"}}]},{"text":"Child answer."},{"text":"Parent answer."}]' --json
  ./mf thread view "$T" --json
  ./mf thread context "$CHILD" --all --view raw --json
  ```

  Extract `CHILD` from the spawn result. Repeat with `from` set to a chat ref
  outside the connected lineage, a trashed ref, and malformed input. Save thread
  lists before/after. For inspection set `REF` to the source chat's public ref:

  ```bash
  ./mf thread send "$T" 'Inspect history' --mock "[{\"toolCalls\":[{\"name\":\"thread_ls\",\"args\":{\"depth\":1}},{\"name\":\"thread_ls\",\"args\":{\"depth\":2}},{\"name\":\"thread_ls\",\"args\":{\"depth\":3}},{\"name\":\"thread_history\",\"args\":{\"ref\":\"$REF\",\"order\":\"newest_first\",\"limit\":200}},{\"name\":\"thread_history\",\"args\":{\"ref\":\"$REF\",\"order\":\"oldest_first\",\"limit\":200,\"include\":[\"tool_args\",\"tool_results\",\"system_messages\",\"system_prompt\"]}}]},{\"text\":\"Inspection complete.\"}]" --json
  ```

  Follow returned cursors where the history exceeds one page. Repeat on the
  compacted/undone source and fork from RP-6/RP-9.
- **Expect:** child's first request has the reference/read instruction without
  source history. Invalid `from` fails before creating a child or charging a
  child run. Default inspection omits hidden tool payloads; explicit includes
  reveal them once, with labelled origins and stale-read stubs.
- **Evidence:** parent/child requests, tool results, before/after child list and
  model-response usage, inspection cursors and filter inputs.
- **Last run:** merge-gate §18–20 PASS for current/from-outside and inspection;
  trashed/malformed variants not recorded there. 2026-09-28 (source commit not recorded).

[c6a]: https://github.com/haowjy/meridian-flow-docs/blob/683395ca9b084cee0196ec9c9070755930d38329/work/agents-milestone-4/evidence/c6a-probe/report.md
[merge]: https://github.com/haowjy/meridian-flow-docs/blob/a4b1dddbd615bbab334dc6fa7b700245f768d288/work/agents-milestone-4/evidence/merge-gate/REPORT.md
