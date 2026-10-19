# Runtime protocol probes

These back up the automated control, compaction, handoff, history and link identity
contracts. They do not replace the project checks. `C` means a compaction turn;
`B` an assistant continuation; `S` a handoff seed. Only `compact` is an inbox control; the handoff brief runs outside the inbox.

## Setup and evidence

Use a disposable worktree. `pnpm bootstrap` provisions its database if needed.
M4 migrations now follow main’s Work migrations as 0014–0024. If this
worktree’s dev database applied them under their old 0010–0020 numbers, reset it
with `pnpm db:reset`. DB tests provision their own fresh databases.
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
history, then another writer/reply pair. The newer pair is normally retained. A short thread still compacts, using the minimal safe tail. Use `send --mock` for replies:

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
# Add `instructions` beside `kind` to probe `/compact <instructions>`.
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
- **Provider-declined variant:** repeat with a sticky 404 error (`"message":
  "RP1 retired model"`). In the chat, expect "The AI provider turned this
  request down." and Retry on the latest failed reply. Clear that script with
  `./mf mock clear --id <script-id>` (read the ID from `error-script.json`),
  then click Retry. Expect a new reply without retyping; the old failure is not
  drawn, and a failed reply that a later message follows shows no failure line
  (a row with no text is gone). Before this fix, the current
  provider-declined reply had no Retry. An inherited read-only failure must
  still have no Retry.
- **Forgetting variant (a failed attempt is one stored fact):** with a sticky
  failure matched to a marker, check four cases in a browser and read
  `./mf thread view` and `thread context` after each. (1) Moving on: send the
  marker, then another message. The failed exchange and its message are gone
  from the screen, the view and the next request, and the journal has
  `turns.forgotten` with reason `forgotten`. (2) Retry: the writer's message
  stays and appears once in the next request, with no failure trace
  (reason `retried`). (3) `/compact` after an empty failure with an earlier
  reply: the summary and context lack the abandoned message, and the next
  reply works. (4) Forks: a fork cut before the failure holds nothing from it;
  a fork cut after the move-on inherits the forgetting. A failed reply that
  made a tool call, or one carried into a continuation, stays.
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
  persisted and debited once. Its partial text means the reply draws something,
  so a later message does not forget it. The reply is `error` with `This response failed.`
  and internal shutdown reason, its adopted inbox message is acknowledged,
  no successor starts during shutdown, and Retry works after restart.
- **Expect (dev):** Ctrl+C and SIGTERM exit promptly. After restart, orphan
  repair marks the reply failed with generic copy and the internal `orphaned`
  reason and
  acknowledges every message named by its receipt. Those messages are not
  answered automatically; only never-adopted queued-behind messages remain in
  the inbox. Recovery also deletes the stale `thread_run_leases` row and publishes
  `meridian.thread.status` with `status.kind: asleep` after commit. A resumed
  subscription/snapshot reads asleep, with no running turn. Send a new message
  immediately after repair, before the old lease expiry, and confirm its reply
  starts without waiting. Retry re-answers explicitly.
- **Evidence:** signal and exit timestamps, process log showing signal-handler
  ordering, settled reply and response rows, ledger debit, empty pending inbox,
  post-restart Retry result, resumed snapshot, idle status frame, lease rows
  before/after repair, and new-message start time relative to the old expiry.

### Terminal compaction failure crash boundary

The production-adapter DB regression in
`runtime/adapters/drizzle-loop-ports.db.test.ts` captures a pending compaction
candidate, calls `failCompactionSuccessor`, then runs orphan recovery without
failure-close or run-session cleanup. The compaction and successor are failed,
the adopted inbox is empty, and the thread is asleep with no lease row. The
in-memory parity case lives in `runtime/loop/__tests__/inbox-drain.test.ts`.
Run with `pnpm test:db`; these are adapter regressions, not a live process
restart smoke check.

## RP-2: Commands wait for messages

- **Protects:** `[A][/compact][B]` adopts A and B at the next tool boundary,
  then compacts after the turn. Without another boundary, the next run answers
  B before compacting. Stop uses the same message-first rule.
- **Stack:** mock.
- **Steps:** during a delayed reply, enqueue A, compact, then B and let the model
  cross a tool boundary. Repeat without a later boundary, and repeat with Stop.
  Enqueue compact alone and Stop. Withdraw a queued compact while B waits.
- **Expect:** the tool-boundary request ends with B and C follows the reply. In
  the other message cases the successor request ends with B and C follows it.
  Compact alone runs after Stop. Withdrawal leaves the messages unaffected.
- **Evidence:** pending snapshots, complete request message arrays, C metadata,
  and durable turn positions proving the chain matches writer-visible order.
- **Last run:** not recorded for this exact recipe.

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
  and `autocompact: 12000`. Create its thread, then send the large writer
  message from setup with its short scripted reply. Mock input usage now grows
  with the received request, so the next send enters notes without a fixture.
  Save context before the trigger, immediately
  after C/B, and after one further short send:

  ```bash
  ./mf thread context "$T" --all --view raw --json > "$E/before.json"
  ./mf mock script '[{"text":"Notes done."},{"text":"Short earlier context."},{"text":"Continue after C."}]' --json
  ./mf thread send "$T" 'Continue the story' --json > "$E/trigger.ndjson"
  ./mf thread context "$T" --all --view raw --json > "$E/after.json"
  ./mf thread send "$T" 'And then?' --mock '[{"text":"Next beat."}]' --json
  ./mf thread context "$T" --all --view raw --json > "$E/following.json"
  ```

- **Expect:** an eligible automatic decision first runs notes, then C and B in
  the same run. Manual, overflow, ineligible room/iterations, or an attempted
  marker in this cycle skip notes. Summary plus retained tail in the next
  request. The following request extends the identical serialized prefix.
- **Evidence:** C metadata, before/after/following requests, prefix comparison;
  real-provider variant also records usage, cache reads and actual spend.
- **Last run:** 2026-10-19 stock mock PASS after request-derived input usage:
  notes/C/B followed by a short send preserved B's full 12-message prefix.
  Earlier: merge-gate §13–16 mock PASS; original real run FAIL (billing
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
  text. The brief has no fallback: a failed attempt is a card on the
  brief ("This handoff brief couldn't be generated. Try again.", the server's `turn.error`) and the
  header's Retry is the next attempt. A failed Stop on a generating brief is a second card on it
  ("Couldn't stop the brief." with Try again), and a refused or lost Retry is a card too
  ("Couldn't retry." / "Couldn't start a new brief."); see [failure cards](failure-cards.md).
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

## RP-18: Fork prefix remains frozen as source grows and compacts

- **Protects:** inherited cutoff/bake ownership (`compaction-protocol`).
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

- **Expect:** inherited prefix bytes do not change; later source turns/C do not
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
  ./mf thread send "$T" 'Read the chapter' --mock '[{"toolCalls":[{"name":"read","args":{"path":"manuscript://rp10.md"}}]},{"text":"Read."}]' --json
  ./mf doc put manuscript://rp10.md --text 'RP10_NEW_SENTINEL' --overwrite --json
  ./mf mock script '[{"text":"Earlier planning context."}]' --json
  compact
  ./mf thread tail "$T" --until-idle --timeout 60s --json
  ./mf thread send "$T" 'Continue' --mock '[{"text":"Continued."}]' --json
  ./mf thread context "$T" --all --view raw --json
  ```

- **Expect:** the second `doc put --overwrite --json` reports `previousDocumentId`
  equal to the first put's `documentId`; the post-C request excludes `RP10_OLD_SENTINEL`; retained stale
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
  ./mf thread send "$T" 'Spawn a reference check' --mock '[{"toolCalls":[{"name":"spawn","args":{"prompt":"Inspect the referenced chat","name":"Reference check","from":"current","mode":"foreground"}}]},{"text":"Child answer."},{"text":"Parent answer."}]' --json
  ./mf thread view "$T" --json
  ./mf thread context "$CHILD" --all --view raw --json
  ```

  Extract `CHILD` from the spawn result. Repeat with `from` set to a chat ref
  outside the connected lineage, a trashed ref, and malformed input. Save thread
  lists before/after. For inspection set `REF` to the source chat's public ref:

  ```bash
  ./mf thread send "$T" 'Inspect history' --mock "[{\"toolCalls\":[{\"name\":\"thread_ls\",\"args\":{\"depth\":1}},{\"name\":\"thread_ls\",\"args\":{\"depth\":2}},{\"name\":\"thread_ls\",\"args\":{\"depth\":3}},{\"name\":\"thread_history\",\"args\":{\"ref\":\"$REF\",\"order\":\"newest_first\",\"limit\":200}},{\"name\":\"thread_history\",\"args\":{\"ref\":\"$REF\",\"order\":\"oldest_first\",\"limit\":200,\"include\":[\"tool_results\",\"system_messages\",\"system_prompt\"]}}]},{\"text\":\"Inspection complete.\"}]" --json
  ```

  Follow returned cursors where the history exceeds one page. Repeat on the
  compacted source and fork from RP-18.
- **Expect:** child's first request has the reference/read instruction without
  source history. Invalid `from` fails before creating a child or charging a
  child run. Default inspection omits hidden tool payloads; explicit includes
  reveal them once, with labelled origins and stale-read stubs.
- **Evidence:** parent/child requests, tool results, before/after child list and
  model-response usage, inspection cursors and filter inputs.
- **Last run:** merge-gate §18–20 PASS for current/from-outside and inspection;
  trashed/malformed variants not recorded there. 2026-09-28 (source commit not recorded).

## RP-12: Link identity

- **Protects:** stored links name documents (`doc:` and `ahead:` refs); every read
  spells the current path; a rename or move writes nothing into documents that
  link to the moved one; a deleted target stays gone; the model never sees an id
  (#729, #730).
- **Stack:** mock for steps 1 to 6, then the real provider once. The scripts live
  in the [link identity probe scripts][link-probes]; copy them anywhere and run
  them from this checkout. Set the evidence directory `E` in each script's header
  and the database name `DB` in `729-730-V-lib.py` to this worktree's database.
- **Steps:**
  1. Concurrent edit during a move. Run `729-730-V-app.py` with each of
     `prefix`, `unlink`, `inside` and `adjacent`: the holder has
     `[Target](final) waits.`, the thread's draft edits the label, unlinks it,
     edits inside it or edits the suffix, then the target moves twice and is
     renamed to `merged-729-730`.
  2. Ahead ref: `729-730-V-ahead.py`. The model writes `[Next](ch9)`; create
     `ch9`, rename it to `ch10`, then create a new `ch9`.
  3. Stale path: `729-730-V-stale.py`. The model reads four holders, the target
     is renamed, then block edits spell the old path with and without `.md`,
     plus a `find` of the old spelling.
     Typed `[Next](ch9.md)` must also read back `[Next](ch9)`. Create prose
     `outline` beside `outline.json`: `[Outline](outline)` must prefer the prose
     document. Delete the prose document: that path must reach the JSON file.
     Inspect `ls` (prose, JSON and a folder), `search`, and a missing-name `read`;
     their paths, receipts and errors show no prose extension. Load a skill from
     a source `SKILL.md`: the header and `ls` show `SKILL`, and either typed
     spelling loads it. Published path descriptions teach `Chapter 13`, not a
     prose suffix. Old probe scripts that assert added prose suffixes need their
     assertions updated to this contract before use.
  4. Gone and restore: `729-730-V-gone.py` (delete, resolver, a new document at
     the old path) and `729-730-V-restore.py` (a Work-owned `scratch://` target:
     delete the Work, restore it).
  5. Move note: `729-730-V-movenote.py` (rename and folder move, counts, journals).
  6. Gone link in the Editor: with `agent-browser`, open a chapter that links a
     deleted document and a missing one; capture rest, hover, right-click and
     click. Make a chat `@` reference through the composer picker, delete its
     document and reload.
  7. Real model: restart without `MODEL_PROVIDER=mock` with the provider key
     exported. `729-730-V-real-a.py <tag>` seeds and runs turn 1; remove the
     second link occurrence in the browser editor (right-click, Remove link);
     `729-730-V-real-b.py <tag> before|inflight [delay]` moves the chapter, asks
     for the label change and reads back.
- **Expect:** every read, preview and receipt shows the new path. Label edits and
  unlinks stay what was written (`[Renamed target](merged-729-730) waits.`,
  `Target waits.`, `[Tar drafted get](merged-729-730) waits.`,
  `[Target](merged-729-730) returns.`); the suffix is never linked. Holder
  journals (updates, checkpoints, head sequence, state vector, draft
  journal rows) are identical before and after every move. `ch9` reads `ch9`
  then `ch10` and ignores the later `ch9`. Stale-path block edits keep the
  document. A deleted target answers `gone` with no location from
  `POST /api/projects/:id/links/resolve`, is not captured by a new document at
  its path, and revives on Work restore. `linkUpdate.links` counts incoming
  occurrences and `documents` counts holders; a moved document's own links are
  not counted. The gone link is dashed, unfollowable and says
  `No longer available` with no Open link; a missing one says
  `Doesn't exist yet` and offers Create. No `doc:`, `ahead:` or UUID appears in
  `thread context --all --view raw`.
- **Evidence:** the `729-730-V-*-result.json` files (preview, live, journal
  fingerprints, resolver answers, SQL rows), model transcripts, `thread context`
  captures, chip screenshots and DOM extracts.
- **Known limit:** a `find` quoting a link's old spelling after a move returns
  `not_found` with a re-sync hint; one re-read recovers. `./mf doc put
  --overwrite` is delete plus create, so it is not a writer edit.
- **Last run:** 2026-10-09 on `7495b8d58`, mock then DeepSeek, all steps passed
  (report: `impl-729-730/evidence/729-730-V-probes.md` in the same work item).

## RP-13: Apply one change row, then Discard all, moves no prose

- **Protects:** applying a single change row changes exactly that row's prose, and
  a following Discard all closes the branch without touching the document again,
  including when the row list is filtered and the applied row was never opened.
  This replaces the deleted `WorkChanges` unit case, which drove the same claim
  through the client's row component.
- **Stack:** mock, real wall clock.
- **Precondition:** a project with one Work, a document in it, and a chat bound to
  that Work so the model's write lands as a draft on the Work rather than live.
- **Steps:** script one mock write of a known sentence, send it, and wait for the
  draft to settle. Then read the Work's branch list and keep the document before
  and after each command:

  ```bash
  ./mf mock script '[{"text":"RP13 first draft sentence."}]' --json > "$E/script.json"
  ./mf thread send "$T" 'RP13 write' --json > "$E/send.ndjson"
  ./mf doc read "$DOC" --json > "$E/before.json"
  ./mf api GET "/api/projects/$P/works/$W/branches" --json > "$E/branches.json"

  BRANCH=$(jq -r '.items[0].branchId' "$E/branches.json")
  ITEM=$(jq -r '.items[0].itemKey' "$E/branches.json")
  TOKEN=$(jq -r '.items[0].tokens.locationToken' "$E/branches.json")
  APPLY=$(node -p 'crypto.randomUUID()')

  ./mf api POST "/api/projects/$P/works/$W/branches/apply" \
    --data "{\"branchId\":\"$BRANCH\",\"commandId\":\"$APPLY\",\"items\":[{\"itemKey\":\"$ITEM\",\"locationToken\":\"$TOKEN\"}]}" \
    --json > "$E/apply.json"
  ./mf doc read "$DOC" --json > "$E/after-apply.json"

  DISCARD=$(node -p 'crypto.randomUUID()')
  ./mf api POST "/api/projects/$P/works/$W/branches/discard" \
    --data "{\"branchId\":\"$BRANCH\",\"commandId\":\"$DISCARD\"}" --json > "$E/discard.json"
  ./mf doc read "$DOC" --json > "$E/after-discard.json"
  ./mf api GET "/api/projects/$P/works/$W/branches" --json > "$E/branches-after.json"
  ```

- **Expect:** `apply` answers `completed` and moves only the applied row's text;
  `discard` answers `{"status":"discarded"}`; `after-discard.json` is byte-identical
  to `after-apply.json` (Discard never writes prose, whatever the row filter shows);
  and the branch list afterwards does not report that branch as active. A `stale` or
  `gone` apply status means the tokens from `branches.json` were already superseded, and
  the run must be restarted rather than interpreted.
- **Evidence:** the four document reads, `apply.json`, `discard.json`, the branch list
  before and after, and the mock script id.
- **Last run:** not recorded.

## RP-14: Work archive and delete are durable, reversible and idempotent

- **Protects:** archiving a Work stamps `archivedAt` and advances `entityRevision`
  by one; unarchiving clears it; deleting sets `deletedAt` as a tombstone that
  keeps the row in the catalogue, and repeating the delete changes nothing.
  This replaces the deleted `WorkCollection` unit cases for archive and delete
  durability. The Undo affordance itself stays a browser check, because undo is
  client-side.
- **Stack:** mock, real wall clock. No model call.
- **Steps:**

  ```bash
  ./mf api GET  "/api/projects/$P/works"                > "$E/works-before.json"
  ./mf api POST "/api/works/$W/archive"                 > "$E/archive.json"
  ./mf api GET  "/api/projects/$P/works"                > "$E/works-archived.json"
  ./mf api POST "/api/works/$W/unarchive"               > "$E/unarchive.json"
  ./mf api GET  "/api/projects/$P/works"                > "$E/works-restored.json"
  ./mf api DELETE "/api/works/$W"                       > "$E/delete.json"
  ./mf api GET  "/api/projects/$P/works"                > "$E/works-deleted.json"
  ./mf api DELETE "/api/works/$W"                       > "$E/delete-again.json"
  ./mf api GET  "/api/projects/$P/works"                > "$E/works-after-twice.json"
  ```

- **Expect:** archive sets a non-null `archivedAt` on that row, leaves every other
  row alone, and moves `entityRevision` from 1 to 2 on a fresh Work; unarchive
  returns `archivedAt` to `null` (revision 3); `DELETE` answers with an empty body
  and sets `deletedAt` while the row **stays in the catalogue**, so assert on
  `deletedAt` and never on presence; the second `DELETE` leaves `deletedAt` and
  `entityRevision` unchanged (revision 4 both times). Compare the Work row, not the
  whole payload: the transport envelope carries a fresh `requestId` per request, so
  two byte-identical documents are not expected. Use a Work created for this probe,
  never one holding a document worth keeping.
- **Evidence:** the six snapshots and every command status.
- **Last run:** 2026-10-14 on `e0ba565c6` (worktree `test-trim`), mock, all steps
  passed after two expectations were corrected by the run: delete is a tombstone
  that keeps the row listed, and the envelope's `requestId` makes whole-payload
  comparison wrong. Evidence: `/tmp/opencode/probe-rp14/`.

## RP-15: `send` proves its own message's fate

- **Protects:** `./mf thread send` follows its reply through the shared `messageFate`
  over one snapshot, and names what became of its own message: answered (by which
  reply, with the chain's last reply as the result), handed back, or unproven. This
  replaces the deleted interim-follow cases in `tools/mf` for steer, queued switch and
  unrelated starts, whose risks are now `message-fate.test.ts`.
- **Stack:** mock. Use `--match` on each scripted reply, and `./mf mock clear` at the end.
- **Steps:** (`T` is a fresh thread per case; `E` holds the evidence)

  ```bash
  # 1. Plain send
  ./mf thread send "$T" 'c1 plain' --mock '[{"text":"Plain reply."}]' --json > "$E/1.ndjson"
  # 2. Steer into a held reply: the result is the successor's own text
  ./mf mock script '[{"text":"Held first reply.","delayMs":6000}]' --match 'c2 first'
  ./mf mock script '[{"text":"Steer successor reply."}]' --match 'c2 steer'
  ./mf thread send "$T" 'c2 first' --no-wait --json
  ./mf thread send "$T" 'c2 steer' --json > "$E/2.ndjson"
  # 3. Queued behind a held reply, then the chat's Stop
  ./mf mock script '[{"text":"Held.","delayMs":30000}]' --match 'c3 first'
  ./mf thread send "$T" 'c3 first' --no-wait --json
  ./mf thread send "$T" 'c3 queued' --json > "$E/3.ndjson" & sleep 8
  ./mf thread stop "$T" --json > "$E/3-stop.json"; wait
  # 4. A scripted failing successor
  ./mf mock script '[{"text":"Earlier reply text.","delayMs":5000}]' --match 'c4 first'
  ./mf mock script '[{"error":{"status":400,"message":"scripted successor failure"}}]' --match 'c4 steer'
  ./mf thread send "$T" 'c4 first' --no-wait --json
  ./mf thread send "$T" 'c4 steer' --json > "$E/4.ndjson"
  # 5. After each case
  ./mf thread view "$T"; ./mf mock clear
  ```

- **Expect:** 1 exits 0 with `userTurnId`, `answeredBy` and `finalText` of that reply. 2 exits 0 with `turnId`
  the successor and its text only. 3: `stop` exits 0 and its `handedBack` names the queued
  message's id; the queued `send` exits 5 with `outcome: "handed_back"`, `turnId: null`;
  the message is absent from `thread view`. 4 exits 1 with `turnId` the failed successor
  and no text from the earlier reply. In every case `thread view` agrees with the claim.
  A claim that `view` contradicts is a failure of the probe, not of the view.
  Every `--json` run ends in exactly one `result` record, after its `message.delta` and
  `message.completed` records (record order), and `./mf mock list` is empty after case 1 (`--mock`
  removes its own script) and after the final `./mf mock clear`. The `tools/mf` cases deleted in L1c
  (usage-block, failed-successor, NDJSON shape, `--mock` cleanup, idle `tail`) have their risks here and in
  `message-fate.test.ts`.
- **Evidence:** each command, stdout, stderr and exit code, and the `thread view` after it.
- **Last run:** 2026-10-16 on `1bfd1e703` (`feat/thread-sync-mf`, L1c's code, `./mf` on `ThreadSync`), mock;
  all four cases passed, one `result` record each, `./mf mock list` empty after each. `liveView`: case 1
  `matches`, case 2 `not_observed` `rewritten`, case 3 `not_observed` `no_turn` (handed back), case 4
  `matches`. Earlier run: 2026-10-15 on `fa1040e86` (`feat/mf-send-fate`, B6), all four passed. Evidence:
  `work/mf-client-unification/evidence/L1c/live/` in the docs repository.

## RP-17: `./mf` beside the browser

- **Protects:** `./mf thread send` and `thread tail --until-idle` follow a chat through the same
  `createThreadSync` the app runs, and never claim more than they proved. A `./mf` run is evidence for the
  sync's rules (join, read application, frame order, the end-of-turn check), not for what the browser paints.
- **Stack:** mock, an owned worktree stack with the browser showing the chat (`agent-browser`, one named session).
- **Steps:** (`T` is a fresh thread per case; `E` holds the evidence)

  ```bash
  S='[{"text":"Part one.","toolCalls":[{"name":"thread_ls","args":{"depth":1}}]},{"delayMs":4000,"text":"Part two."}]'
  # SY-01 setup: open the chat in the browser, then follow it from ./mf
  ./mf thread send "$T" 'rp17 follow' --mock "$S" --json > "$E/sy01.ndjson"
  # SY-04 setup: the browser has the chat open; a second send from ./mf
  ./mf thread send "$T" 'rp17 other client' --mock '[{"text":"Reply to the other client."}]' --json > "$E/sy04.ndjson"
  # SY-05 setup: stop a streaming reply while tailing
  ./mf thread send "$T" 'rp17 stop' --no-wait --mock '[{"text":"Held.","delayMs":30000}]' --json
  ./mf thread tail "$T" --until-idle --json > "$E/sy05.ndjson" & sleep 4
  ./mf thread stop "$T" --json; wait
  # Checkpoint step: the tail joins while the reply is still waiting to call its tool, so the tool's
  # frames and the text arrive after the join, with reads landing between them
  ./mf thread send "$T" 'rp17 checkpoint' --no-wait --mock '[{"delayMs":3000,"toolCalls":[{"name":"thread_ls","args":{"depth":1}}]},{"delayMs":3000,"text":"Hello there"}]' --json
  ./mf thread tail "$T" --until-idle --json > "$E/checkpoint.ndjson"
  ```

- **Expect:** every claim is as the scenario says (complete, handed back or cancelled, with the exit code), and
  `thread view "$T"` agrees with each claim. The checkpoint run prints one `tool.started`, one
  `tool.completed` and one `message.completed` whose text is the whole text, on one socket. (A tail that
  joins after the tool finished replays nothing of it: the read holds it. Staged against committed writes
  is `tools/mf`'s `names staged and committed writes honestly`.) Record every `liveView` and, for
  each `not_observed`, its reason: `matches` is the expected case; `not_observed` is acceptable when its
  reason holds (a rewritten turn, a turn a read ended first, a gap); a `differs` is classified (a true
  disagreement is a defect in the shared rules, filed with its `liveDiff`; a false one is a defect in the check).
  `liveView` is a diagnostic over client state: it never changes the claim or the exit code.
- **Evidence:** each command, stdout, stderr and exit code, the `thread view`, the browser's chat text, and the
  table of `liveView` records with their classes.
- **Last run:** 2026-10-16 on `1bfd1e703` (`feat/thread-sync-mf`, L1c's code), mock, desktop browser beside
  it; every claim and exit as expected, `thread view` agreed with each. `liveView` records: `send` with a
  live browser, `matches`; `tail --until-idle` joining a reply with durable text already in its read (SY-01)
  and a Stopped reply (SY-05), `not_observed` `rewritten`; the checkpoint run, `matches`. No `differs`.
  Evidence: `work/mf-client-unification/evidence/L1c/` in the docs repository.

## RP-16: Every failure is logged once where it is classified and once where it ends

- **Protects:** the server's `failure.recorded` and `failure.ended` records
  (`loop/failure-detection.ts`), one pair per occurrence, each carrying the same occurrence id.
  Also that the model never reads a failure. Run it on the first check of any change to a
  terminal writer, the append primitive, or the usage block.
- **Stack:** mock. A usage block needs a thread's owner at zero credits.
- **Steps:** make `mk() { ./mf thread create --agent runtime-probe --work @/ --title "$1" --json | jq -r .threadId; }`
  and read each result with `./mf log --thread "$X" --name failure. --full --since 2m`.

  ```bash
  FAIL='[{"error":{"status":500,"message":"RP16 failure"}}]'
  # 1. retried: a failed reply, then Retry
  ./mf mock script "$FAIL"; ./mf thread send "$A" 'a1'; ./mf mock clear
  ./mf mock script '[{"text":"ok"}]'
  ./mf api POST "/api/threads/$A/turns/$FAILED/retry" --data "{\"id\":\"$(node -p 'crypto.randomUUID()')\"}"
  # 2. forgotten: an empty failure, then another message
  ./mf mock script "$FAIL"; ./mf thread send "$B" 'b1'; ./mf mock clear
  ./mf thread send "$B" 'b2' --mock '[{"text":"ok"}]'
  # 3. moved_on: a failure that kept a tool call, then another message
  ./mf mock script '[{"toolCalls":[{"name":"ls","args":{"path":"manuscript://"}}]},{"error":{"status":500,"message":"RP16"}}]'
  ./mf thread send "$D" 'd1'; ./mf mock clear; ./mf thread send "$D" 'd2' --mock '[{"text":"ok"}]'
  # 3b. a kept failure is ended once: a kept-tool failure A, Retry into another failure B, Retry again
  ./mf mock script '[{"toolCalls":[{"name":"ls","args":{"path":"manuscript://"}}]},{"error":{"status":500,"message":"RP16"}}]'
  ./mf thread send "$G" 'g1'; ./mf mock clear
  ./mf mock script "$FAIL"   # Retry from A (id $A_ID) fails as B; then Retry from B (id $B_ID), which succeeds
  # 4. carried: a slow failure while a second message is admitted
  ./mf mock script '[{"delayMs":6000,"error":{"status":500,"message":"RP16"}}]'
  ./mf thread send "$E" 'e1' & sleep 2; ./mf thread send "$E" 'e2' --mock '[{"text":"ok"}]'; wait
  # 5. a failed compaction, then another message (forgotten)
  ./mf thread send "$F" 'f1' --mock '[{"text":"ok"}]'; ./mf mock script "$FAIL"
  ./mf api POST "/api/threads/$F/controls" --data "{\"id\":\"$(node -p 'crypto.randomUUID()')\",\"control\":{\"kind\":\"compact\"}}"
  ./mf mock clear; ./mf thread send "$F" 'f2' --mock '[{"text":"ok"}]'
  # 6. a failed handoff brief with no Retry (moved_on), then one with Retry (retried): see RP-8
  # 7. usage: zero the owner's credit lots, send, restore them, wait one sweep (30 s)
  ```

- **Expect:** one `failure.recorded` per failed turn, whose `occurrenceId` is the turn id, then
  exactly one `failure.ended` with the same id: `retried` (1; `byTurnId` is the Retry's turn),
  `forgotten` (2 and 5; `byTurnId` is the writer's message), `moved_on` (3 and the no-Retry
  brief; `byTurnId` is the message), and `retried` for the brief's Retry seed. A kept-tool failure
  that two later Retries walk (3b) has exactly one `failure.ended` for A (`moved_on` by the first
  Retry), never a second one by the second. The carried case
  (4) writes both records in the same millisecond with `moved_on`. Usage writes
  `usage:<threadId>:<episode>` twice, `recorded` on the block and `ended { resolved }` on the
  clear, with the same episode. Payload values read as text, never `[redacted]`. Then
  `./mf thread context "$X" --all` shows no `turn.error` text, and
  `thread_history` has no `error:` line.
- **Evidence:** the `log` output of each case, with the occurrence ids.
- **Last run:** 2026-10-16 on `feat/failure-model-server`, mock, all seven passed. The mock
  cannot script partial text followed by an error, or `max_tokens`, so the `max_tokens` and
  partial-text cases are covered by the `thread_history` contract test and the classifier test.

## RP-19: Observation frontiers survive a restart and a fork finds them

- **Protects:** observation frontiers ([runtime document text](../../apps/server/server/domains/runtime/.context/document-text.md#observation-frontiers)). Each read or write result
  the model receives records at most one row, keyed by that result block; `room_key` is
  `draft:<workDraftId>` (the `document_drafts` row of kind `work_draft`, never the thread
  peer) or `live:<documentId>:<authorityGeneration>`; `unshown` lists block ids that changed
  since the previous frontier and were not shown in full. Lookup is the latest `recorded_seq`
  among the conversation's blocks. A fork finds inherited rows with no copy. A staged write
  records nothing; the step's save records on the write's block. An undo records in the version
  its inverse ran on. Host-only: the model request carries no frontier text.
- **Stack:** mock, owned fresh database. A gate run uses a detached checkout pinned to the
  commit under test (`docs/qa/README.md`), not another lane's stack.
- **SQL:** `tools/qa/probes/observation-frontiers.sh` dumps `observation_frontiers` joined to
  `turn_blocks` and `turns`. Optional argument: a thread UUID, or a `live:` / `draft:` prefix.
  `recorded_seq` is an identity: a replaced row leaves a gap.
- **Seed:** write the chapter to a file and pass `--text @file`. A shell `$'\n'` is dash-literal
  and becomes one heading whose text contains `\n`. Partial reads use 1-based `in` (heading is 1).

  ```bash
  printf '%s\n' '# M1 Probe Chapter' '' 'The mountain stood above the mist.' '' \
    'The river cut through the valley.' '' 'The sky held a single hawk.' > "$E/chapter.md"
  ./mf doc put 'manuscript://M1 Chapter' --text @"$E/chapter.md" --json > "$E/doc.json"
  ./mf thread create --work @/ --title 'M1 frontier auto-apply' --json > "$E/thread.json"
  T=$(jq -r .threadId "$E/thread.json")
  eval "$(pnpm exec tsx tools/dev/print-worktree-env.ts)"
  ```

- **Steps:**

  1. Auto-apply full read:

     ```bash
     ./mf thread send "$T" 'Read the whole chapter.' \
       --mock '[{"toolCalls":[{"name":"read","args":{"path":"manuscript://M1 Chapter"}}]},{"text":"I have the whole chapter."}]' \
       --json > "$E/cell1-send.ndjson"
     # Capture the step-after-read request before any restart (in-memory ring).
     ./mf thread context "$T" --all --view raw --json > "$E/cell6-context-raw.json"
     tools/qa/probes/observation-frontiers.sh "$T"
     ```

  2. Restart, then partial-read paragraph 3 on `$T`. Control: the same partial read in a fresh thread.

     ```bash
     MODEL_PROVIDER=mock pnpm dev:restart --no-tailscale
     PARTIAL='[{"toolCalls":[{"name":"read","args":{"path":"manuscript://M1 Chapter","in":3}}]},{"text":"The river paragraph."}]'
     ./mf thread send "$T" 'Read paragraph 3 only.' --mock "$PARTIAL" --json > "$E/cell2-same-send.ndjson"
     ./mf thread create --work @/ --title 'M1 frontier control' --json > "$E/cell2-control-thread.json"
     CT=$(jq -r .threadId "$E/cell2-control-thread.json")
     ./mf thread send "$CT" 'Read paragraph 3 only.' --mock "$PARTIAL" --json > "$E/cell2-control-send.ndjson"
     tools/qa/probes/observation-frontiers.sh live:
     ```

  3. Fork `$T` at the settled partial-read reply. Count rows by `source_block_id` before and after
     the fork (before the fork's own read). Then partial-read paragraph 3 on the fork.

     ```bash
     CUT=$(jq -r 'select(.type=="result").turnId' "$E/cell2-same-send.ndjson")
     tools/qa/probes/observation-frontiers.sh > "$E/cell3-before.txt"
     FORK=$(node -p 'crypto.randomUUID()')
     ./mf api POST "/api/threads/$T/fork" --data "{\"id\":\"$FORK\",\"originTurnId\":\"$CUT\"}" --json > "$E/cell3-fork.json"
     tools/qa/probes/observation-frontiers.sh > "$E/cell3-after-fork.txt"
     ./mf thread send "$FORK" 'Read paragraph 3 only.' --mock "$PARTIAL" --json > "$E/cell3-fork-send.ndjson"
     tools/qa/probes/observation-frontiers.sh "$FORK"
     ```

  4. Draft mode: a Work, a draft-mode thread (`./mf thread create` has no write-mode flag), a write
     to create the `work_draft`, then a read.

     ```bash
     P=$(jq -r .projectId "$E/thread.json")
     ./mf api POST "/api/projects/$P/works" --data '{"name":"M1 Draft Work"}' --json > "$E/work.json"
     W=$(jq -r .id "$E/work.json")
     ./mf api GET "/api/agents?projectId=$P&limit=100" --json | jq '.agents[] | select(.slug=="general").selection' > "$E/agent-selection.json"
     jq -n --arg p "$P" --arg w "$W" --arg id "$(node -p 'crypto.randomUUID()')" \
       --argjson sel "$(cat "$E/agent-selection.json")" \
       '{id:$id,projectId:$p,title:"M1 frontier draft mode",agentSelection:$sel,workId:$w,aiWriteMode:"draft"}' \
       > "$E/cell4-create-body.json"
     ./mf api POST /api/threads --data @"$E/cell4-create-body.json" --json > "$E/cell4-thread.json"
     DT=$(jq -r .id "$E/cell4-thread.json")
     ./mf thread send "$DT" 'Change the last paragraph in the draft.' \
       --mock '[{"toolCalls":[{"name":"write","args":{"command":"replace","path":"manuscript://M1 Chapter","in":4,"content":"The sky held a single hawk over the draft."}}]},{"text":"Drafted a sky change."}]' \
       --json > "$E/cell4-write-send.ndjson"
     ./mf thread send "$DT" 'Read the chapter.' \
       --mock '[{"toolCalls":[{"name":"read","args":{"path":"manuscript://M1 Chapter"}}]},{"text":"Read the draft chapter."}]' \
       --json > "$E/cell4-read-send.ndjson"
     tools/qa/probes/observation-frontiers.sh "$DT"
     # Compare room_key to document_drafts.id for kind work_draft vs thread_peer on this document.
     ```

  5. Staged write: a fresh auto-apply thread, one model step that reads then replaces. After the
     step settles, the write's block has one frontier row whose `recorded_seq` is higher than the
     read's, and the sequence advanced by exactly two (no staging insert). Repeat with the write
     before the read in the same step: the read records from the reply's lease, the save still
     records last on the write's block.

     ```bash
     printf '%s\n' '# Write Probe' '' 'Alpha paragraph.' '' 'Beta paragraph.' '' 'Gamma paragraph.' > "$E/write-chapter.md"
     ./mf doc put 'manuscript://M1 Write' --text @"$E/write-chapter.md" --json > "$E/cell5-doc.json"
     ./mf thread create --work @/ --title 'M1 frontier staged write' --json > "$E/cell5-thread.json"
     WT=$(jq -r .threadId "$E/cell5-thread.json")
     ./mf thread send "$WT" 'Read the chapter then rewrite the last paragraph.' \
       --mock '[{"toolCalls":[{"name":"read","args":{"path":"manuscript://M1 Write"}},{"name":"write","args":{"command":"replace","path":"manuscript://M1 Write","in":4,"content":"Gamma paragraph, rewritten."}}]},{"text":"Rewrote gamma."}]' \
       --json > "$E/cell5-send.ndjson"
     tools/qa/probes/observation-frontiers.sh "$WT"
     printf '%s\n' '# Write Reverse' '' 'Alpha paragraph.' '' 'Beta paragraph.' '' 'Gamma paragraph.' > "$E/write-reverse.md"
     ./mf doc put 'manuscript://M1 Write Reverse' --text @"$E/write-reverse.md" --json > "$E/cell5b-doc.json"
     ./mf thread create --work @/ --title 'M1 frontier staged write reverse' --json > "$E/cell5b-thread.json"
     WTB=$(jq -r .threadId "$E/cell5b-thread.json")
     ./mf thread send "$WTB" 'Rewrite the last paragraph then read the chapter.' \
       --mock '[{"toolCalls":[{"name":"write","args":{"command":"replace","path":"manuscript://M1 Write Reverse","in":4,"content":"Gamma paragraph, rewritten first."}},{"name":"read","args":{"path":"manuscript://M1 Write Reverse"}}]},{"text":"Wrote then read."}]' \
       --json > "$E/cell5b-send.ndjson"
     tools/qa/probes/observation-frontiers.sh "$WTB"
     ```

  6. No model-visible change: inspect `$E/cell6-context-raw.json` (captured in step 1). The second
     request is the step after the read.

  7. Undo: on `$WT` (live, `manuscript://M1 Write`) and `$DT` (draft, `manuscript://M1 Chapter`).

     ```bash
     ./mf thread send "$WT" 'Undo the last write.' \
       --mock '[{"toolCalls":[{"name":"write","args":{"command":"undo","path":"manuscript://M1 Write"}}]},{"text":"Undid the live write."}]' \
       --json > "$E/cell7-live-send.ndjson"
     ./mf thread send "$DT" 'Undo the last write.' \
       --mock '[{"toolCalls":[{"name":"write","args":{"command":"undo","path":"manuscript://M1 Chapter"}}]},{"text":"Undid the draft write."}]' \
       --json > "$E/cell7-draft-send.ndjson"
     tools/qa/probes/observation-frontiers.sh "$WT"
     tools/qa/probes/observation-frontiers.sh "$DT"
     ```

- **Expect:**
  1. One `live:<documentId>:1` row, `unshown: []`, `blocks: 4` in the read result.
  2. Same-thread partial read after restart: `unshown: []`, `blocks: 1 of 4`. Control thread:
     `unshown` lists the other three block ids (`client:clock`).
  3. Fork copies no rows (same count and `source_block_id` set before vs after). Fork partial read:
     `unshown: []`.
  4. Read's `room_key` is `draft:<work_draft.id>`, not `draft:<thread_peer.id>`. Result `version: draft`.
  5. Write block: one row, `recorded_seq` greater than the same-step read, in both orders, with no
     seq consumed by the staged write. `tool.completed` then `tool.settled`.
  6. Raw request text contains none of `frontier`, `snapshot`, `unshown`.
  7. Each undo block records one row: `live:<documentId>:<generation>` on `$WT`, and on `$DT`
     `draft:<work_draft.id>` (the draft the inverse ran on), never the thread peer.
- **Evidence:** each send NDJSON, the SQL dumps, the fork body, `document_drafts` ids next to
  `room_key`, seq occupancy 1..last_value, and the captured model requests.
- **Last run:** 2026-10-19 on `689678a032` (`feat/m1-frontier` revision 4), mock, detached checkout
  `p13652-m1-probe` (prefix `detached-689678a032-p13652-m1-probe-17a578e6`, database
  `meridian_detached-689678a032-p13652-m1-probe`), all seven cells passed. Evidence:
  `work/concurrent-edit-design/m1/probe/p13652/` in the docs repository. Browser: none
  (no writer-visible change). Recipe change this run: step 5 now includes the write-then-read
  commands; step 7 has the undo send commands. Steps 5 and 7 passed again on `77667d7e1b`
  (the save derives its room; a live undo reads its generation before the call), on the branch
  worktree's own stack; evidence `work/concurrent-edit-design/m1/probe/r3-fix-cells-5-7.md`.

## RP-20: A write into a changed passage is refused once, with its current text; every result lists what changed

- **Protects:** the region check and the one listing ([write architecture](../../packages/agent-edit/.context/write-architecture.md#the-region-check)).
  A write whose passage (targets ±1 block) changed by more than 10 words since the model saw it,
  holds a block the model never saw in full, or lands in a room where the model has no frontier
  is refused as `region_changed` with the passage's current text, records a frontier, and the
  next attempt lands. Creating a document or filling an empty one is never refused. Every
  result that shows document text lists, under `concurrent edits:`, blocks changed since the
  model's frontier that it doesn't show; a full read lists nothing; past 8 KB the rest is a
  count; removed blocks are one line of hashes. Compaction restarts credit unless the
  document is re-shown; a fork cut before the compaction counts the earlier read again.
- **Stack:** mock. The writer's concurrent edits need a Yjs client, so steps 1 to 3 are API
  steps without a writer (compaction, draft first write); the writer-edit cases run in the
  browser recipe [#871 cells](871-cells.md) and, at the API level, as the throwaway in-process
  probe kept in the docs repository (`work/concurrent-edit-design/m2/probe/w2-inprocess/`).
- **Seed:**

  ```bash
  printf '%s\n' '# C10 Chapter' '' 'Alpha stood at the gate.' '' 'Beta waited by the river.' '' \
    'Gamma held the forest.' > "$E/ch.md"
  for d in C10-Target C10-Reshown C10-Fork W2-Draft; do
    ./mf doc put "manuscript://$d" --text @"$E/ch.md" --overwrite --json > /dev/null
  done
  for i in 1 2 3; do
    printf 'Filler %s text.\n' $i > "$E/f$i.md"
    ./mf doc put "manuscript://C10-Filler$i" --text @"$E/f$i.md" --overwrite --json > /dev/null
  done
  readmock() { echo "[{\"toolCalls\":[{\"name\":\"read\",\"args\":{\"path\":\"manuscript://$1\"}}]},{\"text\":\"Read.\"}]"; }
  writemock() { echo "[{\"toolCalls\":[{\"name\":\"write\",\"args\":{\"command\":\"replace\",\"path\":\"manuscript://$1\",\"find\":\"Beta waited\",\"content\":\"Beta paced\"}}]},{\"text\":\"Wrote.\"}]"; }
  ```

  `compact <thread>` is the helper from [Setup](#setup-and-evidence), followed by
  `./mf thread tail "$T" --until-idle --timeout 120s`.
- **Steps:**

  1. Compaction without a re-show: in a fresh No Work thread read `C10-Target`, then read
     `C10-Filler1` to `C10-Filler3` in three sends (the target falls out of the 3 recent
     documents). Before compacting, set the summary mock to return a summary ending with
     `## Documents to keep open` and no URIs, so the target is not model-listed either.
     Compact, then send `writemock C10-Target` twice.
  2. Compaction with a re-show: a fresh thread reads `C10-Reshown`, compacts, then sends
     `writemock C10-Reshown` once.
  3. Fork before the compaction: a fresh thread reads `C10-Fork` (keep the send's result
     `turnId` as `CUT`), reads the three fillers, compacts with the same empty keep-open list as step 1,
     sends `writemock C10-Fork`; then
     fork at `CUT` (`POST /api/threads/$T/fork` with `originTurnId`) and send `writemock C10-Fork`
     on the fork.
  4. First draft-mode write after a live read: a draft-mode thread on a new Work (body as in
     RP-19 step 4) sends one reply that reads `W2-Draft`, then writes `Beta waited` →
     `Beta paced` twice in two steps.
- **Expect:**
  1. The first write is `status: region_changed` with "Not applied: this passage changed since
     you last saw it. Current text:" and the three paragraphs; the second lands (`write: w1`).
  2. The write lands at once.
  3. The write on the compacted thread is refused with current text; the same write on the fork
     lands.
  4. The read says `version: draft` with no Work draft yet (it read live); the first write is
     `region_changed` with current text, the second `success` staged and settled as
     `draft (@<work>)`; `./mf doc read` still shows live unchanged.
- **Evidence:** each send NDJSON (`tool.completed` and `tool.settled` lines).
- **Last run:** 2026-10-19 on `f8e5f62b94` (M2 W2; the tree that commit holds), the branch
  worktree's own mock stack. All four passed. Evidence:
  `work/concurrent-edit-design/m2/probe/w2-c10/` in the docs repository; the in-process
  writer-edit exercises are in `m2/probe/w2-inprocess/results-raw.md`.

[c6a]: https://github.com/haowjy/meridian-flow-docs/blob/683395ca9b084cee0196ec9c9070755930d38329/work/agents-milestone-4/evidence/c6a-probe/report.md
[merge]: https://github.com/haowjy/meridian-flow-docs/blob/a4b1dddbd615bbab334dc6fa7b700245f768d288/work/agents-milestone-4/evidence/merge-gate/REPORT.md
[link-probes]: https://github.com/haowjy/meridian-flow-docs/tree/6934bec3c8771d80ae9014ccc5a93b61da74f8b1/work/model-tool-surface/experiments

## RP-21: M2c re-shows every listed document that fits, most important first

- **Protects:** owner rulings C12/C13. No listed-document count cap or fixed token
  budget; the only budget is half the compacted request's headroom under the
  auto-compaction trigger, less 1,000 tokens of estimator slack. The budget
  includes the list the server writes back into the summary. Without a trigger it
  is unlimited.
- **Stack:** mock, using the Agent and `compact` helper from Setup.
- **Steps:**
  1. Create 12 small documents with distinct URIs and show all 12 through `read`.
     Queue a summary with narrative followed by `## Documents to keep open`
     and all 12 URIs, one per line in a deliberately chosen priority order
     (not their read-recency order). Compact, then send a continuation.
  2. Inspect `thread context --all --view raw --json` and
     `thread view --blocks --json`. The summary has sequence 0; re-shown
     blocks have sequences 1 through 12 in exactly the listed order. The first
     listed URI is the first block after the summary, not the last.
  3. Compact that thread again with narrative and an empty keep-open section,
     without any intervening document reads. Exactly the first three documents
     from the previous re-show are selected, in that same order: among
     documents on one compaction turn, earlier means more recent.
  4. In a fresh thread read a document larger than half the available headroom,
     plus four small documents. List the oversized document first, then the
     small documents. Compact and continue. The large document is skipped
     whole, the small documents appear in listed order, and the stored
     summary's `## Documents to keep open` names only the small URIs. The
     successor's `tokensAfter` is below the trigger. Expand the compaction
     divider in the browser: the Documents group shows exactly those small
     documents, and the large one has no row.
  5. For a genuinely spent budget, use enough fitting documents to consume all
     available room after the reserved list. The picker must stop reading
     further candidates once remaining room reaches zero (not read every
     candidate merely because the list is now unbounded). To hit exact zero
     cheaply, invoke the picker in a throwaway script with 1,000 candidates and
     a budget of the estimated worst-case list plus the first rendered read;
     count reader calls and require exactly one. Keep no test from this script.
     Oversized candidates
     while room remains are skipped, not truncated, so later small ones can fit.
- **Evidence:** captured successor requests, persisted block sequences, divider
  summary and `tokensAfter`, plus the browser screenshot. Compare the warm
  summary request against its source: only the appended summary instruction
  changes (its old “at most 10” clause is gone); tools, messages, system and
  cache key otherwise stay identical.

- **Last run:** 2026-10-19, C13 amendment after `d18594b1b0`, this branch's mock
  stack. All 12 listed documents appeared in order (sequences 1–12); the next
  empty-list compaction picked documents 1, 2, 3. An oversized first candidate
  was omitted whole while four small candidates fit in order; `tokensAfter`
  was 8,238 against the 100,000 trigger. The exact-zero picker probe read only
  one of 1,000 candidates. Browser: expanded normal and omission dividers both
  matched their stored summaries. Evidence: docs repository
  `work/concurrent-edit-design/m2c/probe/c13/` (report and screenshots); raw
  request captures remain at `/tmp/m2c-c13-probe/`.

## C14: Working notes across compaction

- **Protects:** bounded notes before eligible automatic compaction, committed-only
  continuation ownership, canonical own-folder admission, and ordinary save/Undo.
- **Stack:** owned mock stack and database. Use `./mf mock script` to queue the
  whole notes/summary/successor sequence globally. `send --mock` matches that
  writer text, which a rolling summary replaces, so it cannot script the summary.
  Stock mock estimates input usage from received messages, tools and response
  format using the planner's three-byte heuristic. No baseline override or
  provider fixture is needed. This proves control flow, never provider cache
  behavior or billing.
- **Repeatable smoke:** publish the RP-4 Agent (`autocompact: 12000`) and create
  a fresh thread `T`. Send setup's 1,400-repeat keeper message with its short
  `--mock` reply, then use this unscoped script. Do not insert setup's second
  send: the first completed response already carries input usage above T.

  ```bash
  ./mf mock script '[
    {"toolCalls":[{"name":"write","args":{"command":"create","path":"scratch://$THREAD/one.md","content":"The keeper opens the silver gate."}}]},
    {"delayMs":15000,"toolCalls":[
      {"name":"write","args":{"command":"create","path":"scratch://$THREAD/two.md","content":"The gate leads north."}},
      {"name":"write","args":{"command":"create","path":"manuscript://notes-held.md","content":"Must not exist."}},
      {"name":"search","args":{"query":"keeper"}},
      {"name":"spawn","args":{"agent":"writer-helper","prompt":"Must not run."}}
    ]},
    {"text":"Notes done."},
    {"text":"Working notes are one.md and two.md in this chat notes folder. The keeper opens the silver gate, which leads north."},
    {"text":"Continue after C: the keeper walks north."}
  ]' --json
  ./mf thread send "$T" 'Continue the story' --json > "$E/notes.ndjson"
  ./mf thread context "$T" --all --view raw --json > "$E/notes-context.json"
  ./mf thread view "$T" --full --json > "$E/notes-view.json"
  ```

  Open the chat in the browser before sending. During the delay, capture the
  first saved edit and active reply; afterwards expand the steps and capture
  two edits, three neutral held rows, the automatic divider and continued task.
  Confirm the manuscript path is absent, spawn created no child, and all three
  results contain `{refusal:"notes_step"}` with `isError:false`. Inspect B's
  actual request for both current note texts. Send RP-4's short follow-up and
  compare B's entire message array with the start of the following request.
  Reload and compare the same receipts, held rows and divider.

  For **Stop mid-step**, create another fresh thread with the same Agent and
  large opening pair. Queue a first write to `scratch://$THREAD/stop.md`, then
  `{"delayMs":60000,"text":"Must not finish."}`. Send “Continue the story”
  from the browser. Wait for the first write to settle and for the next request
  to be captured with the notes marker, then press the browser's Stop.
  Expect a cancelled assistant, saved note/receipt and marker, no C and no
  active execution. Clear only this probe's remaining script by its returned
  id. No source edits or throwaway provider fixture belong in either run.
- **Entry:** assemble a compactable older pair and small retained suffix. Calibrate
  the actual automatic decision, not just a token threshold. At T and above T,
  expect one hidden system marker `section: "compaction_notes"`, followed by an
  ordinary assistant. Below T, no marker. No model response after latest complete
  C, one slot remaining, manual `/compact`, forced overflow, and insufficient room
  skip entry. For U usable input and E full estimate, check admission at
  `U-E-4000 = 4000`, one above and one below. The marker render must fit too.
- **Happy path:** queue two `write create` responses to
  `scratch://$THREAD/one.md` and `two.md`, then `Notes done.` with no calls,
  summary listing the echoed canonical note paths first, then ordinary B. Expect
  two saved ordinary receipts, one marker and one C. Inspect the actual successor
  request: the saved current note text is re-shown first. No-tools text remains
  on its assistant and never closes/releases the reply before compaction.
- **Bounds:** queue four tool responses and distinguish the summary from the
  fourth. Only three ordinary notes generations run, then fresh compaction and
  one ordinary successor slot remains. With two total slots left, exactly one
  notes generation precedes C/B; with one, C/B directly. At zero, no new C. Grow
  a whole note/tool group beyond allowance A, then separately beyond U-4000;
  every call/result/save settles before the next boundary exits notes. A fresh
  warm branch above U rolls before a paid branch. Crossing the reserve alone
  need not overflow the branch's actual measured suffix.
- **Gate:** in both named Work and No Work, exercise own canonical/variable paths,
  nonexistent create, nested paths, inverse writes and in-folder copy. Other
  thread/owner-root/manuscript/skills paths, out-of-folder `from.path`, omitted
  `ls.path`/`search.scope`, malformed addresses and all non-file calls are held.
  Include spawn, ask_user, thread_message and child return_result: no child,
  interrupt or report; each gets `{ refusal: "notes_step" }`, `isError: false`,
  exact held notice and no permission event. Confirm admitted paths still reach
  ordinary Agent/file denials. Existing files outside the folder stay unchanged.
  Inspect held `spawn`, `ask_user` and `return_result` before reloading as well
  as after reload: all three stay neutral process rows, never reports or cards.
- **Lifecycle:** check run-start and mid-loop entry. Late input spends existing
  room, never resets E/A/count. Discard a proposal on moved leaf and failed
  commit; only the winning marker/request/count installs. If late pins destroy
  the cut, preserve below-U generation/no-fit failure rather than a stale C.
  Check exhausted credits and tree budget after a compact-eligible response:
  neither may reserve/pay C; summary spend is checked again before B. Repeat at
  run start with exhausted tree-turn/tree-cost budgets and denied continuation
  credit, at iteration 32 with a terminal response plus late input, and after
  forced provider overflow. No new marker/C is reserved and no summary runs.
  Initial failures retain `credits_exhausted`, `turn_budget_exceeded` or
  `cost_budget_exceeded` in assistant metadata, terminal event code/reason and
  admitted child reports (including `thread_report` and the parent spawn result).
  Credit failures record source `usage`, not `bug`; canonical event source stays
  `system`. Preparation faults still use `request_preparation_failed`.
  A terminal response without pending input still completes in debt. Late input
  continues this execution's iteration budget, not an implicit fresh budget. Check
  queue-switch yield and Stop precedence, both retaining saved notes/marker.
  A later run sees the marker but does not resume run-local notes counters.
- **Prefix exception:** while notes is active, break an included image or join
  an activated skill at a late boundary. Inspect actual requests: one resolution
  per attempt, image update before marker when simultaneous, no extra notes-only
  prefix mutation. Ordinary image/skill changes can change the prefix. Without
  them compare the second notes request's prefix/cache marks to the first.
- **Cycle:** raw-history dedup resets only after complete C, even when an old
  marker survives in projected tail. Failed/incomplete C and Stop do not reset.
  Over-trigger B gets one ordinary response before the next automatic decision.
  Large listed notes use ordinary C13 room: skipped notes are named as not
  re-shown, receive no frontier credit from C, and must be read before writing.
- **Summary recovery:** return text plus calls on warm and rolling paths;
  expect text kept and no tool execution. Repeat mixed text/tool output with
  OpenAI `length`, Responses `incomplete/max_output_tokens`, filter and failure
  terminations: reject the summary, keep each attempted usage row, and never
  commit its partial text as C. Successful mixed output still completes.
  On the warm path return only two
  calls with reasoning, then text. Expect the retry to preserve its original
  request and exact assistant content, then append one non-error tool-result
  message per deduplicated call id saying "Tools are unavailable while the summary
  is written. Write the summary now, as text." Check the Anthropic, OpenAI Responses
  and compatible request mappers each send an answer for every id. Both paid
  response rows settle on C.
  Repeat with a second call-only response: expect `tool_use` and both rows
  settled. Rolling call-only output fails `tool_use` with one row. Stop
  during the retry settles both attempted rows on cancelled C.
- **Summary fit:** compose the complete branch (instruction, changed documents,
  writer directions and retained-scope suffix) before measuring it with the thread
  tokenizer, no carried baseline. A warm payload exactly at usable input `U` may
  branch; one above `U` rolls without a paid branch. After tool-only output,
  measure the exact assistant replay plus every result notice before retrying.
  Make the retry exceed `U`: the next request must be tool-less rolling, not the
  oversized retry. The paid branch row remains alongside every rolling row on
  completion, failure and Stop. Repeat on handoff S, preserving its unanswered
  writer instruction and settlement owner. A provider rejection of a measured-fit
  branch remains final; it is not a general fallback.
- **Cache evidence:** stock mock has cache `none` and cannot script cache usage.
  An owned temporary automatic-cache descriptor can prove branch/retry selection,
  never paid cache reuse or billing. Remove it before committing. For real cache
  comparisons, exclude an ordinary image break or first skill-tool join between
  compared requests; notes/summary introduce no additional prefix mutations.
- **Browser:** the marker has no bubble. Expand/reload ordinary write receipts
  and Undo; inspect each held-tool kind's neutral “Not run during the notes step”
  row (no success/error/action card), one reply through splits, the divider and
  re-show omission list, continued task, Stop, Copy and Fork. Capture before C,
  after C, and after reload.
- **Evidence:** raw turns and positions, complete request messages and tool
  definitions, re-shown file blocks, response rows and debits, and screenshots.
- **Last run:** 2026-10-19, owned `c14-notes` stock mock stack after rebase onto
  `320d9a0c4`: the fixture-free smoke above saved two notes, held manuscript
  write/search/spawn, completed C/B and preserved the next request prefix. A
  fresh browser send entered notes and Stop retained its saved note with no C.
  Earlier on the same date: two saved notes and
  re-show order, nine held call kinds, three-generation bound, Stop/resume,
  named-Work copy, manual compact, late-room/no-fit fallback and queue-switch
  yield exercised through `./mf`; neutral rows and expanded saved receipts/divider
  checked in the browser, including reload. Exact room/trigger equalities,
  credit/tree/iteration exhaustion and active image-prefix exception used a
  disposable component harness. Paid-provider cache/billing, complete failed-commit
  proposal races and the full remaining design matrix are **not certified**.
  Evidence: docs repository `work/concurrent-edit-design/compaction-build/phase2-verification.md`.

## RP-22: Selected keep-open reads after compaction (D4, D7)

- **Protects:** selected re-show scope, fresh frontier credit, whole-only tail
  duplicate elision, fallback, ranking and exact pricing. This extends RP-4, RP-21 and
  C14 (bounded notes); it does not replace their lifecycle checks.
- **Setup:** use this page's owned mock stack, Agent and `compact` helper. Keep
  raw captures outside synced work artifacts (for example `E=/tmp/keep-open-probe`).
  Seed at least three heading sections and 100 numbered paragraphs. Use the
  canonical `uri` returned by `doc put`, not its display filename (`.md` is
  normally omitted). Ordinary tool arguments use `path`, not `file`.

  ```bash
  python3 - <<'PY' > "$E/chapter.md"
  print('# Arrival\n\nOUTSIDE arrival.\n\n# The Duel\n\nDUEL selected body.\n\n# Departure\n\nOUTSIDE departure.')
  print('\n\n'.join(f'Numbered paragraph {i} distinctive.' for i in range(1, 101)))
  PY
  ./mf doc put manuscript://SelectorProbe.md --text @"$E/chapter.md" --json > "$E/doc.json"
  URI=$(jq -r .uri "$E/doc.json")
  ./mf thread send "$T" 'Read the whole chapter.' --mock \
    "[{\"toolCalls\":[{\"name\":\"read\",\"args\":{\"path\":\"$URI\"}}]},{\"text\":\"Read complete.\"}]" --json > "$E/read.ndjson"
  ./mf thread send "$T" 'Keep the full copy in the tail.' --ref "$URI" \
    --mock '[{"text":"Tail complete."}]' --json > "$E/tail.ndjson"
  # Manual compaction has no notes step and need not reserve an assistant continuation.
  jq -n --arg uri "$URI" '[{text:("## Objective\nContinue revising.\n\n## Documents to keep open\n"+$uri+"#the-duel")}]' > "$E/summary.json"
  ./mf mock script @"$E/summary.json" --json
  compact > "$E/compact.json"
  # Poll snapshot until THIS control's C completes; do not accept an older complete C.
  ./mf api GET "/api/threads/$T/snapshot" --json > "$E/snapshot.json"
  ./mf thread send "$T" 'Continue after selected compaction.' \
    --mock '[{"text":"Selected continuation."}]' --json > "$E/continue.ndjson"
  ./mf thread context "$T" --all --view raw --json > "$E/requests.json"
  eval "$(pnpm exec tsx tools/dev/print-worktree-env.ts)"
  tools/qa/probes/observation-frontiers.sh "$T" > "$E/frontiers.txt"
  ```

- **Heading/full tail/M2:** C contains one reference `read.selector.fragment`
  `the-duel`, only the heading and its body. The actual successor request names
  that selector and keeps the unchanged full tail read; `metadata.elisions`
  must not mark that identity `reshown`. The C reference frontier has outside
  block IDs in `unshown`; only its ID is credited for this document, never the
  retained tail. A fresh null frontier initially has no `changed` listing.
  After C, insert distinctive writer text in Arrival through the browser editor
  (a writer Yjs session, not another AI tool). Script a `write replace` outside
  the selection. Inspect the actual tool result/concurrent listing, receipt and
  final document: the writer insertion survives without approval/refusal gates.
  The baseline may still refuse an unseen passage with `region_changed`; record
  that as a concurrent-policy discrepancy, not a no-refusal/M2 pass.
  Repeat with enough large changed outside blocks that the target falls beyond
  the concurrent-listing byte cap, exercising unseen-projection planning (M2).
- **Selectors:** on fresh compactable cycles repeat `in: 4`, `in: 40..95`,
  `in: <blockhash>`, `in: <startHash>..<endHash>`, `#<blockhash>` and
  `#<headingHash>`, using hashes from the ordinary read. Compare exact bodies
  and block IDs; the numeric range persists `[40,95]`, not a string. Reload,
  send again and compare persisted-selector projection to its priced heading.
- **Fallback/rank:** missing heading/hash and `in: 9000` each retry whole once.
  A fitting fallback persists no selector and permits whole duplicate elision;
  failed selections leave no frontier. List two sections for one document, then
  whole/selected in both orders: exactly one C read, first-ranked wins. Repeat
  compaction with no list: recent identities are whole, not inherited selectors.
- **Exact names:** seed names with parentheses and punctuation; list them wrapped
  in backticks/angles or with list markers. Use the matcher seam for literal
  ` in: 40..95` or fragment-looking names the real filename grammar rejects.
  Exact shown filenames win across decoration layers before selector parsing.
  Unknown near-prefixes/extensions and malformed/mixed selectors stay unknown,
  never arbitrary document resolution. A literal fragment-looking filename can
  be checked at the matcher seam if the real filename grammar disallows it.
- **Budget:** use a second Agent with a lower `autocompact` trigger and a large
  document containing one tiny heading section. Calibrate with the same
  `estimateModelPartTokens` and tokenizer: room is
  `max(0,floor((trigger-base)/2)-1000)`, with all requested selector-bearing
  omission lines reserved first. Show selected success where whole fails;
  missing selector with oversized whole fallback must keep the requested line
  in `Documents not re-shown`, record no frontier, and still admit a later small
  candidate. Oversized selected successes must not expand to whole. Check zero
  room, skipped-large then small, and more than three listed identities (no
  count cap). Exact equality fits, one token less omits; isolate those two
  arithmetic boundaries in a disposable seam driver if live estimation cannot
  target them cheaply. Compare the full rendered envelope, selected heading and
  final `tokensAfter`, never a truncated body.
- **Automatic/draft:** repeat the heading case under RP-4/C14 automatic
  compaction, explicitly queue notes responses, summary, then B in that order.
  Run draft-mode and auto-apply threads: C uses the same effective version as an
  ordinary read. Capture both a selected C and its next compaction after reload;
  C10 resets credit each time. Check ordinary mentions and whole keep-open too.
- **Retry/Stop:** delay the summary, enqueue late writer input and verify only
  winning preparation blocks/frontiers persist. Stop while summary/preparation
  is outstanding: cancellation must not become whole fallback or commit late
  evidence. Use the existing compaction-protocol transaction harness for a
  precise discarded-read window that the mock cannot hold reliably.
- **Browser (separate prober):** inspect selected continuation, omission divider
  and concurrent-write receipt, confirm writer text in the editor, reload and
  take screenshots on these same owned routes. CLI captures do not certify UI.
- **Evidence:** exact commands and expected/actual results, control UUID, raw C
  blocks and elisions, request captures, frontier rows, credited IDs, writer
  mutation and final document. Report unreachable windows explicitly. Stop only
  this stack with `pnpm dev --stop`; retain fixture IDs for the browser prober.
- **Last run:** see the work item's `compaction-build/phase4-verification.md`;
  this recipe is not a claim that every case passed.
