# Runtime protocol probes

These back up the automated control, compaction, undo, handoff, and history
contracts. They do not replace the project checks. `C` means a compaction turn;
`B` an assistant continuation; `S` a handoff seed. A control is an inbox entry,
not a chat message.

## Setup and evidence

Use a disposable worktree. `pnpm bootstrap` provisions its database if needed.
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
cache warmth. Historical dates not recorded in those reports are marked unknown
below, not inferred from file timestamps. The current catalog has not been run
end-to-end as one suite.

## RP-1: Failed controls do not hot-loop

- **Protects:** failed message/summary retries remain sweep-paced, not immediate
  self-wakes (`control-protocol`: failed successor with absorbed compact).
- **Stack:** mock, real wall clock.
- **Steps:** prepare a compactable thread. Install a sticky failure, then send a
  message and enqueue compact while it is active:

  ```bash
  ./mf mock script '[{"error":{"status":500,"message":"RP1 provider unavailable"}}]' --json > "$E/error-script.json"
  ./mf thread send "$T" 'RP1 M' --json > "$E/send.ndjson" & SEND=$!
  compact > "$E/compact.json"
  sleep 30
  ./mf log --thread "$T" --json > "$E/pace.json"
  wait "$SEND"
  ```

- **Expect:** no unbounded `turn.error` stream or immediate re-adoption. Group
  gateway retries by logical call ID: SDK/gateway retry attempts are not new
  orchestrator calls. Before the next sweep, one failed generation and at most
  one summary; subsequent attempts must align with sweep/lease eligibility.
- **Evidence:** timestamped gateway and turn events for the entire 30 seconds,
  pending control snapshots, script ID (clear only that ID afterward).
- **Last run:** not recorded for this exact wall-clock recipe. Automated
  sweep-boundary coverage is not a substitute for running it.

## RP-2: Compact is a barrier during a streaming reply

- **Protects:** writer order and retained messages (`control-protocol`: writer
  order during A, notice before compact).
- **Stack:** mock.
- **Steps:** after setup, start a delayed reply, wait until streaming, enqueue
  compact, then send `hi2`. Repeat on a fresh thread with `hi1` queued before
  compact (the bent ordering variant).

  ```bash
  ./mf thread send "$T" hi --mock '[{"text":"reply to hi","delayMs":5000}]' --json > "$E/hi.ndjson" & SEND=$!
  ./mf thread view "$T" --json
  ./mf mock script '[{"text":"Earlier context summary."}]' --json
  compact > "$E/compact.json"
  ./mf thread send "$T" hi2 --mock '[{"text":"reply to hi2"}]' --json > "$E/hi2.ndjson"
  wait "$SEND"
  ```

- **Expect:** suffix roles `user, assistant, user, compaction, assistant` in
  the behind-barrier case. `hi2` remains pinned after the summary in its request;
  no message is lost or answered twice. The bent case preserves `hi1`, too.
- **Evidence:** admitted messages, control UUID, final roles and request messages.
- **Last run:** C6a §4 PASS at `e48c032cd`; date not recorded in report.

## RP-3: Withdraw before execution and during summary

- **Protects:** withdrawal/reservation ownership (`control-protocol`, handoff withdrawal).
- **Stack:** mock.
- **Steps:** use RP-2's delayed active reply, enqueue compact, and withdraw it
  while queued. Repeat on a fresh compactable idle thread with a delayed summary:

  ```bash
  ./mf mock script '[{"text":"Delayed summary","delayMs":10000}]' --json
  compact > "$E/compact.json"
  ./mf thread view "$T" --json
  ./mf api POST "/api/threads/$T/controls/$K/withdraw" --json > "$E/withdraw.json"
  ./mf thread send "$T" 'Answer after withdrawal' --mock '[{"text":"Still answered."}]' --json
  ```

- **Expect:** queued withdrawal returns `withdrawn` and creates no C. During
  summary, outcome is `stopping`, C becomes cancelled, and the queued message
  still gets a reply. A late withdrawal may instead return `already_finished`;
  that does not prove the during-summary case.
- **Evidence:** pre-withdraw snapshot, withdrawal outcome, terminal turn statuses.
- **Last run:** C6a §5–6 PASS at `e48c032cd`; date unknown. Merge-gate §26
  also records queued Withdraw and Stop.

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
  settlement), date/commit not recorded in that report. Do not mark real PASS
  from the mock result.

## RP-5: Kill the server mid-summary

- **Protects:** dead lease repair, exactly-once redelivery and row-owned seeds
  (`control-protocol` interrupted summary, handoff scan after crash).
- **Stack:** mock, isolated owned server process, real Postgres.
- **Steps:** queue a 30-second summary, compact, and send a message while C is
  pending. Save the pre-kill snapshot. Resolve this worktree's server wrapper
  with `pnpm portless:list`, inspect its Nitro child and `/proc/<pid>/cwd`, then
  `kill -9 <verified-owned-nitro-pid>`. Never kill Postgres or another stack.
  Restart with `MODEL_PROVIDER=mock pnpm dev --restart --no-tailscale`; inspect:

  ```bash
  ./mf thread tail "$T" --until-idle --timeout 120s --json
  ./mf thread view "$T" --json
  ./mf log --thread "$T" --json
  ```

  Repeat during handoff briefing. For a subagent variant also inspect the parent report.
- **Expect:** dead C is error with interrupted/recovery metadata, followed by one
  recovered control execution; queued message is delivered after C. Handoff
  resumes the same row-owned S, not a duplicate seed. No stuck placeholders.
  A dead child execution settles one failed/orphaned report.
- **Evidence:** PID/cwd ownership, kill result, pre/post snapshots, recovery events,
  parent report for the child variant.
- **Last run:** merge-gate §29–30 and §33 PASS for C and S; C6a §8 PASS at
  `e48c032cd`. Child variant not recorded. Dates unknown.

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

- **Protects:** seed ownership, binding and fallback (`handoff-protocol`).
- **Stack:** mock; real provider required to verify warm-cache versus cold briefing.
- **Steps:** choose a settled reply ID `CUT` from the source `T`, allocate `DEST`,
  and use the exact selection returned by setup (do not guess a revision):

  ```bash
  DEST=$(node -p 'crypto.randomUUID()')
  jq --arg id "$DEST" --arg cut "$CUT" '{id:$id,originTurnId:$cut,agentSelection:.selection}' "$E/agent.json" > "$E/handoff-body.json"
  ./mf mock script '[{"text":"Brief: keep the silver gate secret.","delayMs":5000}]' --json
  ./mf api POST "/api/threads/$T/handoff" --data @"$E/handoff-body.json" --json
  ./mf thread cancel "$DEST" --json
  ./mf mock script '[{"text":"Retried brief."}]' --json
  ./mf api POST "/api/threads/$DEST/controls" --data "{\"id\":\"$(node -p 'crypto.randomUUID()')\",\"control\":{\"kind\":\"handoff_brief\"}}" --json
  ./mf thread send "$DEST" hi --mock '[{"text":"Hello from the destination."}]' --json
  ./mf thread context "$DEST" --all --view raw --json
  ```

  In separate destinations, let the first brief complete, or fail it with a
  sticky mock error; clear that script ID before sending `hi`. Send another
  Retry while one is pending to check 409. For real warm/cold variants compare
  recent latest-cut versus older-cut summary calls and capture cache usage.
- **Expect:** destination contains the brief/source ref, never source transcript
  text. Stop cancels S without blocking messages. Retry creates a new leaf seed;
  duplicate pending Retry conflicts. Failed brief uses `No brief is available.`
  and ordinary messages still run.
- **Evidence:** source sentinel, destination requests, S/control statuses, 409,
  summary path/cache metrics for the real variant.
- **Last run:** merge-gate §21–24 mock PASS; original real warm/cold run blocked
  by billing settlement. Date/commit unknown.

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
- **Last run:** merge-gate §8–12 PASS; date/commit unknown.

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
  trashed/malformed variants not recorded there. Date/commit unknown.

[c6a]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/agents-milestone-4/evidence/c6a-probe/report.md
[merge]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/agents-milestone-4/evidence/merge-gate/REPORT.md
