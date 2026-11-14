# Runtime protocol probes

These checks cover runtime control, compaction, failure, handoff, history and
document-link behaviour that a database test cannot show. Use an owned
`MODEL_PROVIDER=mock pnpm dev --no-tailscale` stack and the routes from
`pnpm portless:list`.

## Setup

Set `E` to a directory under the active work item's `evidence/` and use the
same checkout for every command. Publish a private probe Agent and create a
thread:

```bash
./mf api POST /api/agents --data '{"slug":"runtime-probe","content":"---\nname: Runtime Probe\nmode: primary\nmodel: mock-llm-v1\n---\nFollow the writer."}' --json > "$E/agent.json"
./mf thread create --agent runtime-probe --title 'Runtime probe' --json > "$E/thread.json"
T=$(jq -r .threadId "$E/thread.json")
compact() { K=$(node -p 'crypto.randomUUID()'); ./mf api POST "/api/threads/$T/controls" --data "{\"id\":\"$K\",\"control\":{\"kind\":\"compact\"}}" --json; }
```

For compaction, send distinctive history and a short tail. Poll
`thread view --json` until the intended turn is pending or streaming before a
racing action; a sleep alone does not prove the race window. Join background
sends with `wait`. A cancelled send exits 5 and a failed send exits 1.

```bash
./mf thread send "$T" "$(python3 -c 'print("The silver gate opens only for the keeper. " * 1400)')" --mock '[{"text":"The keeper remembers the silver gate."}]' --json > "$E/history.ndjson"
./mf thread send "$T" 'Remember the keeper.' --mock '[{"text":"The keeper waits."}]' --json > "$E/tail.ndjson"
```

## RP-1: Failed replies need explicit Retry

Script a provider failure, send a message, wait through one sweep interval, and
retry the failed turn twice with the same client id:

```bash
./mf mock script '[{"error":{"status":500,"message":"RP1 provider unavailable"}}]' --json > "$E/error-script.json"
./mf thread send "$T" 'RP1 failed reply' --json > "$E/send.ndjson"
FAILED=$(tail -n 1 "$E/send.ndjson" | jq -r .turnId); sleep 30
RETRY=$(node -p 'crypto.randomUUID()')
./mf api POST "/api/threads/$T/turns/$FAILED/retry" --data "{\"id\":\"$RETRY\"}" --json
./mf api POST "/api/threads/$T/turns/$FAILED/retry" --data "{\"id\":\"$RETRY\"}" --json
```

Expect no provider call during the idle interval. The first Retry creates one
new failed assistant after the unchanged original; replay returns the same
turn. A queued compact runs after the failure. In the browser, a provider 404
shows “The AI provider turned this request down.” and Retry; a later message
removes the old failure line, while an inherited read-only failure has no Retry.

## RP-2: Commands wait for messages

During a delayed reply, enqueue A, compact, then B and let the model cross a
tool boundary. Repeat without a later boundary and with Send now. Separately
press chat Stop and withdraw a queued compact while B waits.

```bash
./mf thread send "$T" first --no-wait --mock '[{"text":"Before the boundary.","toolCalls":[{"name":"thread_ls","args":{"depth":1}}]},{"text":"Held.","delayMs":20000}]' --json & FIRST=$!
sleep 4; ./mf thread send "$T" A --no-wait --json; compact; ./mf thread send "$T" B --no-wait --json; wait "$FIRST"
```

Expect the tool-boundary request to end with B and the next request to compact.
Without a later boundary and with Send now, the successor request ends with B.
Stop hands B back to the composer before compaction; compact alone runs after
Stop, and withdrawing it leaves the running reply and messages unchanged.

## RP-3: Withdraw only before the command starts

Use a delayed active reply, enqueue compact, and withdraw the same control twice:

```bash
./mf thread send "$T" 'Hold the reply open.' --mock '[{"text":"Working","delayMs":20000}]' --json > "$E/withdraw-hi.ndjson" & SEND=$!
sleep 3; K=$(node -p 'crypto.randomUUID()')
./mf api POST "/api/threads/$T/controls" --data "{\"id\":\"$K\",\"control\":{\"kind\":\"compact\"}}" --json
./mf api POST "/api/threads/$T/controls/$K/withdraw" --json > "$E/withdraw.json"
./mf api POST "/api/threads/$T/controls/$K/withdraw" --json > "$E/withdraw-replay.json"; wait "$SEND"
```

Expect `withdrawn` on the first request and replay, with no compaction turn.
Repeat on an idle compactable thread, polling `thread view` until compaction is
pending before withdrawing. That withdrawal returns `already_started`; the
compaction continues normally.

## RP-4: Proactive autocompaction and byte-stable continuation

An Agent file has no compaction field, so the trigger is the default: 90% of the model's
usable input window (`loop/compaction/trigger.ts`; for `mock-llm-v1`, about 111,000 of its
128,000-token window). Cross it with history on the setup thread, then send two more
messages. An argument over about 128 KB fails (`Argument list too long`), so send the
history as several messages:

```bash
BIG=$(python3 -c 'print("A planning sentence. " * 5500)')
for i in 1 2 3 4 5 6; do ./mf thread send "$T" "$BIG" --mock '[{"text":"Short earlier context."}]' --json > /dev/null; done
./mf thread context "$T" --all --view raw --json > "$E/before.json"
./mf thread send "$T" 'Continue the story' --mock '[{"text":"Continue after C."}]' --json > "$E/trigger.ndjson"
./mf thread context "$T" --all --view raw --json > "$E/after.json"
./mf thread send "$T" 'And then?' --mock '[{"text":"Next beat."}]' --json
./mf thread context "$T" --all --view raw --json > "$E/following.json"
```

Expect `thread view --json` to show completed `compaction` rows by the third send, a summary
plus retained tail in the next request, and an identical serialized prefix between the last two
requests in `following.json` (every message of the earlier request is the start of the later
one). The mock run proves structure; cache-read and spend claims require a separate
real-model run.

## RP-5: Kill the server mid-summary

Queue a delayed summary, compact, and send a message while compaction is
pending. Verify the server wrapper and Nitro child belong to this checkout
through `pnpm portless:list` and `/proc/<pid>/cwd`, then kill only the verified
Nitro PID. Restart with `MODEL_PROVIDER=mock pnpm dev --restart --no-tailscale`.
Do not enqueue the compact again.

Expect the consumed compaction to fail with interrupted/recovery metadata and not
be redelivered. The queued message remains pending and is delivered after
recovery. If a reply itself crashes, its adopted receipt is acknowledged and
one generic failed reply is shown; queued-behind messages are not answered by
repair. There are no stuck placeholders.

## RP-8: Handoff brief, Stop, Retry, failure and source isolation

Choose a settled source turn `CUT`, allocate a destination, and use the exact
Agent selection returned by setup:

```bash
DEST=$(node -p 'crypto.randomUUID()')
jq --arg id "$DEST" --arg cut "$CUT" '{id:$id,originTurnId:$cut,agentSelection:.selection}' "$E/agent.json" > "$E/handoff-body.json"
./mf mock script '[{"text":"Brief: keep the silver gate secret.","delayMs":5000}]' --json
./mf api POST "/api/threads/$T/handoff" --data @"$E/handoff-body.json" --json
./mf thread send "$DEST" hi --no-wait --json > "$E/queued-hi.ndjson" & SEND=$!
./mf api POST "/api/threads/$DEST/handoff/brief" --data "{\"id\":\"$(node -p 'crypto.randomUUID()')\"}" --json
./mf thread view "$DEST" --json; wait "$SEND"
```

While the brief claim is held, the destination is awake without a running turn,
queued work is not answered, and a brief Retry returns
`handoff_retry_unavailable`. Cancel the seed with `./mf thread cancel "$DEST"
--turn <seed-turn-id>`, then retry the brief with one id twice; the first
appends one seed and the replay returns it. Destination context contains the
brief/source reference, not source transcript text. A failed brief has its own
card and Retry; it is not a fallback assistant reply. Repeat with a crashed
brief and confirm one generic failure, no relaunch, and the queued destination
message answered after repair.

## RP-10: Compaction elides stale document text

Create and read a sentinel, overwrite it, compact, and inspect the successor
request:

```bash
./mf doc put manuscript://rp10.md --text 'RP10_OLD_SENTINEL' --json
./mf thread send "$T" 'Read the chapter' --mock '[{"toolCalls":[{"name":"read","args":{"path":"manuscript://rp10.md"}}]},{"text":"Read."}]' --json
./mf doc put manuscript://rp10.md --text 'RP10_NEW_SENTINEL' --overwrite --json
./mf mock script '[{"text":"Earlier planning context."}]' --json; compact
./mf thread tail "$T" --until-idle --timeout 60s --json
./mf thread send "$T" Continue --mock '[{"text":"Continued."}]' --json
./mf thread context "$T" --all --view raw --json
```

Expect the overwrite to report the prior document id, the successor request to
exclude `RP10_OLD_SENTINEL`, and retained stale reads to use the re-read stub.

## RP-11: `from` spawn and inspection filters

Publish a subagent target (`mode: subagent`) and script a foreground spawn from
the current chat:

```bash
./mf thread send "$T" 'Spawn a reference check' --mock '[{"toolCalls":[{"name":"spawn","args":{"prompt":"Inspect the referenced chat","name":"Reference check","from":"current","mode":"foreground"}}]},{"text":"Child answer."}]' --json
./mf thread list --json
```

Extract the child id from the spawn result and inspect it with
`./mf thread context <child> --all --view raw --json`. Repeat with `from` set to
a chat outside the connected lineage, a trashed ref and malformed input. Invalid
`from` must fail before creating or charging a child. For the source chat's
public ref, script `thread_ls` at depths 1, 2 and 3 and `thread_history` with
`newest_first` and `oldest_first`, including tool results and system messages;
follow cursors past one page. Default inspection omits hidden tool payloads;
explicit includes reveal them once with labelled origins and stale-read stubs.

## RP-12: Link identity

Use current context routes and `./mf` rather than retired probe scripts. Create a
holder and target, read the holder through a model tool, then move the target:

```bash
./mf doc put manuscript://rp12-holder.md --text '[Target](rp12-target) waits.' --json
./mf doc put manuscript://rp12-target.md --text 'Target.' --json > "$E/target.json"
TARGET=$(jq -r .documentId "$E/target.json"); P=$(jq -r .projectId "$E/thread.json")
./mf api POST "/api/projects/$P/context/manuscript/move" --data "{\"operationId\":\"$(node -p 'crypto.randomUUID()')\",\"path\":\"rp12-target.md\",\"expected\":{\"kind\":\"file\",\"nodeId\":\"$TARGET\"},\"destinationScheme\":\"manuscript\",\"destinationFolderPath\":\"\",\"newName\":\"rp12-renamed.md\"}" --json
./mf thread send "$T" 'Read the holder and target' --mock '[{"toolCalls":[{"name":"read","args":{"path":"manuscript://rp12-holder.md"}},{"name":"read","args":{"path":"manuscript://rp12-renamed.md"}}]},{"text":"Done."}]' --json
```

Repeat with a stale old path, a deleted target and a new document at the old
path. Reads, previews and receipts must show the current path; a deleted target
is `gone` and is not captured by a new document at that path. No `doc:`, `ahead:`
or UUID appears in `thread context --all --view raw`.

## RP-15: `send` proves its own message's fate

Run these cases on a fresh thread, using `--match` scripts and clearing them
after each case:

```bash
./mf thread send "$T" plain --mock '[{"text":"Plain reply."}]' --json
./mf mock script '[{"text":"Held first.","delayMs":6000}]' --match first
./mf mock script '[{"text":"Successor."}]' --match steer
./mf thread send "$T" first --no-wait --json; ./mf thread send "$T" steer --json
./mf mock script '[{"text":"Held.","delayMs":30000}]' --match queued-first
./mf thread send "$T" queued-first --no-wait --json; ./mf thread send "$T" queued --json & SEND=$!
sleep 8; ./mf thread stop "$T" --json; wait "$SEND"
```

The plain send exits 0 with its writer turn, answer and final text. Stop hands
the queued message back, its send exits 5 with `outcome: "handed_back"`, and it
is absent from `thread view`. A failed successor exits 1 with its failed turn
and does not claim the earlier reply's text.

## RP-16: Every failure is logged once where it is classified and ends

Read `./mf log --thread "$T" --name failure. --full` after each case. Make
fresh threads `A` through `F` with `./mf thread create --agent runtime-probe`.

```bash
mk() { ./mf thread create --agent runtime-probe --title "$1" --json | jq -r .threadId; }
A=$(mk RP16-A); B=$(mk RP16-B); D=$(mk RP16-D); E=$(mk RP16-E); F=$(mk RP16-F)
FAIL='[{"error":{"status":500,"message":"RP16 failure"}}]'
./mf mock script "$FAIL"; A_SEND=$(./mf thread send "$A" a1 --json); ./mf mock clear
A_FAILED=$(jq -r '.turnId // .assistantTurnId' <<<"$A_SEND")
./mf mock script '[{"text":"ok"}]'; ./mf api POST "/api/threads/$A/turns/$A_FAILED/retry" --data "{\"id\":\"$(node -p 'crypto.randomUUID()')\"}"
./mf mock script "$FAIL"; ./mf thread send "$B" b1; ./mf mock clear; ./mf thread send "$B" b2 --mock '[{"text":"ok"}]'
./mf mock script '[{"toolCalls":[{"name":"ls","args":{"path":"manuscript://"}}]},{"error":{"status":500,"message":"RP16"}}]'; ./mf thread send "$D" d1; ./mf mock clear; ./mf thread send "$D" d2 --mock '[{"text":"ok"}]'
./mf mock script '[{"delayMs":6000,"error":{"status":500,"message":"RP16"}}]'; ./mf thread send "$E" e1 & P1=$!; sleep 2; ./mf thread send "$E" e2 --mock '[{"text":"ok"}]'; wait "$P1"
./mf thread send "$F" f1 --mock '[{"text":"ok"}]'; ./mf mock script "$FAIL"
FK=$(node -p 'crypto.randomUUID()'); ./mf api POST "/api/threads/$F/controls" --data "{\"id\":\"$FK\",\"control\":{\"kind\":\"compact\"}}"; ./mf mock clear
./mf thread send "$F" f2 --mock '[{"text":"ok"}]'
```

Each failure has one `failure.recorded` and one `failure.ended` with the same
occurrence id. The ending reason is `retried`, `forgotten` or `moved_on` based
on the next writer action. A carried failure records both events in one
millisecond. Usage block/clear adds one `usage:<threadId>:<episode>` record for
each phase. `thread context --all` and `thread_history` contain no failure text.

## RP-17: `./mf` beside the browser

With the browser showing `T`, run the shared-client checks below:

```bash
S='[{"text":"Part one.","toolCalls":[{"name":"thread_ls","args":{"depth":1}}]},{"delayMs":4000,"text":"Part two."}]'
./mf thread send "$T" 'rp17 follow' --mock "$S" --json
./mf thread send "$T" 'rp17 other client' --no-wait --mock '[{"text":"Reply to the other client."}]' --json
./mf thread send "$T" 'rp17 stop' --no-wait --mock '[{"text":"Held.","delayMs":30000}]' --json
./mf thread tail "$T" --until-idle --json > "$E/rp17-tail.ndjson" & TAIL=$!; sleep 4
./mf thread stop "$T" --json; wait "$TAIL"
./mf thread send "$T" checkpoint --no-wait --mock '[{"delayMs":3000,"toolCalls":[{"name":"thread_ls","args":{"depth":1}}]},{"delayMs":3000,"text":"Hello there"}]' --json
./mf thread tail "$T" --until-idle --json > "$E/rp17-checkpoint.ndjson"
```

Every claim and exit must agree with `thread view`. The checkpoint tail prints
one tool start, one tool completion and one complete message on one socket.
`liveView` is diagnostic only and never changes the exit-code claim.

## RP-18: Fork prefix remains frozen as source grows and compacts

Choose settled `CUT`, allocate `FORK`, and fork:

```bash
FORK=$(node -p 'crypto.randomUUID()')
./mf api POST "/api/threads/$T/fork" --data "{\"id\":\"$FORK\",\"originTurnId\":\"$CUT\"}" --json
./mf thread send "$FORK" 'Fork before source growth' --mock '[{"text":"Fork reply."}]' --json
./mf thread context "$FORK" --all --view raw --json > "$E/fork-before.json"
```

Grow and compact source `T`, then send on the fork again and capture context.
The inherited prefix bytes do not change; later source turns and compaction do
not appear in the fork transcript.

## RP-19: Observation frontiers survive a restart and a fork finds them

Seed a chapter with a heading and three paragraphs. Read it, restart the stack,
read paragraph 3 in the same and a fresh thread, then fork the original and
repeat the partial read. Dump the rows after each phase:

```bash
./mf doc put manuscript://rp19.md --text $'# Chapter\n\nOne.\n\nTwo.\n\nThree.' --json
./mf thread send "$T" read --mock '[{"toolCalls":[{"name":"read","args":{"path":"manuscript://rp19.md"}}]},{"text":"Read."}]' --json
tools/qa/probes/observation-frontiers.sh "$T"
```

In a draft Work, the room key must be `draft:<work_draft.id>`, . Read then write and write then read; the read and the write record once,
and an undo records a frontier in the room it
changed. `recorded_seq` gaps are identity, not an error. The raw model request
contains no frontier fields.

## RP-20: Writes merge onto changed or partly read text

Read a chapter, type into its target paragraph in the browser, then run a
scripted replace based on the old text. Repeat in a draft Work, after a partial
read, and from a second chat editing another block:

```bash
./mf thread send "$T" 'Change the paragraph' --mock '[{"toolCalls":[{"name":"write","args":{"command":"replace","path":"manuscript://rp19.md","find":"Two.","replace":"Two becomes three."}}]},{"text":"Written."}]' --json
./mf thread context "$T" --all --view raw --json
```

Writes land on the current Yjs room and show the resulting block plus
`the user changed <hash> after you last read it.` Draft writes stay in the Work draft and leave
live text unchanged. Missing targets return `not_found` and change no text.

## RP-21: Listed reads after compaction fit the budget, in listed order

Create 12 small documents and show them through `read`. Queue a summary whose
`## Documents to keep open` lists ordinary read JSON objects in a deliberate
priority order, compact, and send a continuation. The summary has sequence 0;
the re-shown blocks follow in listed order. Compact again with an empty section;
the first three previous documents are selected in that order. Then list one
document larger than half the headroom before four small documents: the large
read is skipped whole, the small reads fit in order, and the divider shows only
the small documents.

Preserve heading, `in`, string-hash, `around`, `format: "outline"`,
`format: "edits"`, `format: "full"`, and `version: "live"`/`"draft"` arguments
exactly. Missing headings or hashes, invalid positions and denied versions are
omitted and never retried as whole reads. A malformed object with a path
suppresses that identity's default read; malformed input without a path is
ignored. The first listed identity wins, and when the budget reaches zero the
picker stops rather than retrying or truncating candidates.

In the browser, expand the summary and selected/outline Read rows, continue and
reload. The same selected text remains visible, and writer text stays in the
editor.
