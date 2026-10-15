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
  compacted source and fork from RP-9.
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
  journals (updates, checkpoints, head sequence, state vector, draft branch
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
  a following Discard all closes the draft without touching the document again,
  including when the row list is filtered and the applied row was never opened.
  This replaces the deleted `WorkChanges` unit case, which drove the same claim
  through the client's row component.
- **Stack:** mock, real wall clock.
- **Precondition:** a project with one Work, a document in it, and a chat bound to
  that Work so the model's write lands as a draft on the Work rather than live.
- **Steps:** script one mock write of a known sentence, send it, and wait for the
  draft to settle. Then read the Work's whole draft and keep the document before
  and after each command:

  ```bash
  ./mf mock script '[{"text":"RP13 first draft sentence."}]' --json > "$E/script.json"
  ./mf thread send "$T" 'RP13 write' --json > "$E/send.ndjson"
  ./mf doc read "$DOC" --json > "$E/before.json"
  ./mf api GET "/api/projects/$P/works/$W/drafts" --json > "$E/draft.json"

  DRAFT=$(jq -r '.drafts[0].id' "$E/draft.json")
  ITEM=$(jq -r '.drafts[0].items[0].itemKey' "$E/draft.json")
  TOKEN=$(jq -r '.drafts[0].items[0].locationToken' "$E/draft.json")
  APPLY=$(node -p 'crypto.randomUUID()')

  ./mf api POST "/api/projects/$P/works/$W/drafts/apply" \
    --data "{\"draftId\":\"$DRAFT\",\"commandId\":\"$APPLY\",\"items\":[{\"itemKey\":\"$ITEM\",\"locationToken\":\"$TOKEN\"}]}" \
    --json > "$E/apply.json"
  ./mf doc read "$DOC" --json > "$E/after-apply.json"

  DISCARD=$(node -p 'crypto.randomUUID()')
  ./mf api POST "/api/projects/$P/works/$W/drafts/discard" \
    --data "{\"draftId\":\"$DRAFT\",\"commandId\":\"$DISCARD\"}" --json > "$E/discard.json"
  ./mf doc read "$DOC" --json > "$E/after-discard.json"
  ./mf api GET "/api/projects/$P/works/$W/drafts" --json > "$E/drafts-after.json"
  ```

- **Expect:** `apply` answers `completed` and moves only the applied row's text;
  `discard` answers `{"status":"discarded"}`; `after-discard.json` is byte-identical
  to `after-apply.json` (Discard never writes prose, whatever the row filter shows);
  and the draft read afterwards does not report that draft as active. A `stale` or
  `gone` apply status means the tokens from `draft.json` were already superseded, and
  the run must be restarted rather than interpreted.
- **Evidence:** the four document reads, `apply.json`, `discard.json`, the draft read
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
- **Evidence:** each command, stdout, stderr and exit code, and the `thread view` after it.
- **Last run:** 2026-10-15 on the `feat/mf-send-fate` branch, mock; all four cases passed.
  Evidence: `work/mf-client-unification/evidence/B1/` in the docs repository.

[c6a]: https://github.com/haowjy/meridian-flow-docs/blob/683395ca9b084cee0196ec9c9070755930d38329/work/agents-milestone-4/evidence/c6a-probe/report.md
[merge]: https://github.com/haowjy/meridian-flow-docs/blob/a4b1dddbd615bbab334dc6fa7b700245f768d288/work/agents-milestone-4/evidence/merge-gate/REPORT.md
[link-probes]: https://github.com/haowjy/meridian-flow-docs/tree/6934bec3c8771d80ae9014ccc5a93b61da74f8b1/work/model-tool-surface/experiments
