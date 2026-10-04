# Connected conversation tools

These model-facing tools are sequential, read-only, and advertised at the next
prompt bake. Existing bakes keep their frozen tools. They accept project-local
`cN` and `pN` refs, never internal IDs. Omitted `ref` means the caller.

All three readers use the same authorization: a live target in the caller's
project, owned by the same writer, with the same lineage root. Spawn, fork and
handoff edges connect a lineage. A trashed target is not readable directly;
a fork still reads the inherited prefix of a trashed source.

## `thread_ls`

Input: `{ ref?, depth?: 1 | 2 | 3, cursor? }`. Default depth is 1.

The typed result is `{ ref, listing }`: the resolved conversation and the
listing the model reads. The listing includes the path to the root (up to 16 hops), current thread,
and up to 50 descendant nodes. Trashed path hops are labelled; trashed nodes
are omitted. Spawn edges use the parent. Fork and handoff edges use the cutoff
turn's owner, including inherited cutoffs. Nodes are selected newest first per
level and displayed beneath their parent. Status is `awake` or `asleep` from
the run lease; subagents also show their saved spawn outcome.

Each row may be followed by an indented `last asked: "…"` line. It is the
latest local request from the user in a primary conversation, or from the
parent agent in a subagent. Whitespace is collapsed, JSON string quoting is
used, and long text is cut near 100 characters on a word boundary. The line is
absent when the conversation has no local request; inherited fork or handoff
history is never used as a fallback.

An own-child overflow supplies a cursor for the same ref. Deeper overflows
name the parent and remaining count. Cursors preserve PostgreSQL microsecond
precision and are bound to their target ref.

## `thread_history`

Input:

```ts
{
  ref?: string;
  order?: "newest_first" | "oldest_first"; // default newest_first
  cursor?: string;
  limit?: number; // default 40 turns, max 200; hidden calls don't count
  include?: ("routine_calls" | "tool_results" | "thinking" |
             "system_messages" | "system_prompt" | "timestamps")[];
  expand?: number | string; // turn number 4 (or "4"), or "4.7" for item 7 of turn 4
}
```

The handler returns a structured `HistoryResult` (`spawn/history-result.ts`):
`ref`, `view` (`page`, `turn` or `item`), finished `turns`, the live
`inProgress` tail and, when more pages exist, `next.call`. The model reads a
text rendering of it; the typed result is kept beside the text on the tool
result.

```text
Conversation c2

[1] user
pizza

[2] assistant
I looked around to see what "pizza" might point at, ...
(10 routine tool calls hidden; list them with thread_history({"ref":"c2","expand":2}))

[3] user
can u test a subagent using from and ask it to summarize the conversation so far

In progress
[4] spawn({"agent":"general","name":"Summarize conversation test"}) → running
```

- **Call lines** (D48). Every tool call, on a page, under `routine_calls` and
  in `expand: N`, is one line: the tool name and the arguments as the model
  sent them, as compact JSON, then ` → ` and a short result. Postgres `jsonb`
  drops key order, so keys follow the tool's input schema (the matching
  `oneOf` variant), with keys it doesn't name last:

  ```text
  read({"path":"manuscript://chapter-11.md","format":"outline"}) → 5 of 62 blocks
  write({"command":"replace","path":"ch3.md","content":"The moon was low over the ridge…(212 words)","find":"The moon was"}) → w4, 212 words, version: draft (@rewrite)
  read({"path":"skill://story-review/resources/developmental-edit.md"}) → failed: document_not_found
  spawn({"agent":"critic","prompt":"Load the story-review skill…(310 words)","name":"Pacing review"}) → p8
  ```

  `spawn/history-call-line.ts` shortens long strings inside the JSON, at any
  depth: a string over 60 characters keeps its first 40 (backed off to a word
  break) and a size note, `…(212 words)` (`…(N chars)` for one word). A call
  still over 300 characters drops the prefix to 16, then 0; keys are never
  dropped. The result after the arrow comes from the typed result through the
  registration's `historySummary` (`tools/history-summaries.ts`): a write's
  handle, words sent and drafted Work, a read's block count, a spawn's child
  ref, a Work. A failure is `→ failed: <status or code>`, a call still running
  `→ running`, one a settled turn never finished `→ cancelled`. With nothing
  to say there is no arrow. A child's `return_result` is written
  `return_result(…)`: its saved report stands in for its arguments.

- **Turn numbers** count conversation turns only (writer and agent requests
  and assistant replies), from 1, with no gaps (D10). One count query gives
  the page's first number; the walk numbers the rest by the same rule. A
  number never changes across pages, `order` or compaction, so an `expand`
  written earlier still names the same turn. System turns (completion
  notices, Work updates, seeds, compaction) have no number; with
  `system_messages` they show under their label and can't be expanded.
- **Visibility** comes from each registration's `historyKind`. Routine calls
  (`read`, `ls`, `search`, `work` list/show, `thread_ls`, `thread_history`,
  `thread_report`, `skill`, and a child's `return_result`) are hidden and
  counted behind a copyable `expand` call. Changes (`write`, `work` changes,
  `spawn`, `thread_message`) are one receipt line. Errors and calls a settled
  turn never finished always show. Thinking, system messages, the prompt and
  timestamps are opt-in.
- **Saved reports.** On a subagent's own history, each finished report
  (`listFinishedByChild`, keyed by `terminalTurnId`) renders on its terminal
  turn as `Report (<outcome>)`, its reason, and the saved summary cut to 20
  lines with an `expand` handle. The `return_result` arguments never render.
- **`expand: N`** lists each item of turn N on one line, numbered `N.k` in
  display order (a tool result shares its call's line), with result sizes;
  messages show up to the item cap while the expansion budget lasts.
  **`expand: "N.k"`** shows one item in full: its call line, the whole
  arguments (a write's as a dated edit record), then the result.
- **Compaction** renders `[earlier turns summarized]` above the first turn of
  a compacted segment. Pages stop at prompt epoch boundaries; `More:` reaches
  the earlier turns. The composed prompt is opt-in, once when a cursor opens a
  segment.
- The first newest-first page may show running work under `In progress`. It
  is outside the stable settled-prefix cursor chain. Inherited turns name
  their source (`(from c1)`).

Item expansion exposes dated edit records, not current documents. A write's
call line quotes its (shortened) inputs, so any view that shows one carries
the write's edit evidence with null revisions, and compaction clears it. Document copies never render: read results, search excerpts,
reference reads and write echoes become pointers, in every view. `isError`
results remain verbatim. Nested history results are omitted. Missing
call/registration evidence produces a result stub instead of an unknown copy.

The caller's model tokenizer determines size estimates, including CJK rates.
Page items are capped at 2,000 estimated tokens, pages at 8,000, and
expansions at 16,000. A truncated item gives an `"N.k"` handle. A page scans at
most 2,000 raw items; hidden-only stretches return a progress cursor rather
than holding an unbounded snapshot. Opt-in prompts reserve at most 4,000 tokens
of the page.

Result metadata always records `documentRevisions`: an explicit empty list
without quoted edits, or null revision evidence for quoted edits. Null evidence
is already stale and is not sent for current-revision lookup. Thus compaction
clears quoted edits but preserves a history result that contains no edits.

## `thread_report`

Input: `{ ref: string }`. The ref must resolve to a subagent. The result is the
child's latest finished report: `ref` (the child's own `pN`, even for
`"current"`), `outcome`, `summary`, and when present `payload`, `artifacts`,
`reason`, `partial: true` and a non-default `source`. It has no run number.
When a newer run is in progress the result adds `running: true` and a
`message`: "p3 is running again; this report is from its previous run.
You'll be notified when it finishes." With no finished report it is
`{ ref, status: "unavailable", message }`, telling the model to wait for the
completion notice instead of calling `thread_report` again. Both promises
appear only when the child's latest run reports back to this caller
(background delivery with this caller, as after its own spawn or background
re-task). Otherwise, for example a run the writer started in the child or a
sibling reading the report, the line ends "You won't be notified when it
finishes."

The model reads a text rendering of that typed result (D8), never JSON: the
report as history shows it (`Report (completed)`, a `reason:` line when there
is one, then the summary with real newlines, `payload:` and `artifact:`
lines), then the running-again line; an unavailable result is just its line.
Refusals from the thread tools render as `<message> (<code>)`.

The app's report route (`GET .../reports/[childThreadId]/[execution]`) keeps
addressing one execution through `readThreadReport`, so each spawn card shows
its own run's report.

## Errors

Domain readers return `{ ok: false, error: MeridianError }`. Tool registrations
project these into canonical error results (`isError: true` with the structured
`MeridianError` as output). Codes include
`thread_not_found`, `thread_not_connected`, `invalid_cursor`, `item_not_found`,
and `invalid_run` (the report route only). The report HTTP route maps authorization
failures to HTTP 404/403 instead of returning a successful report response.

The writer's [transcript route][transcript] remains raw and unchanged by these
model-only projections.

[transcript]: thread-transcript.md

## `spawn` context: `from`

`spawn({ prompt, from?: "current" | string, ... })` accepts one prior-conversation
ref. `current` resolves to the caller. The same live owner/project/lineage check
runs before creating the child. Invalid, trashed and disconnected targets return
structured tool errors without a child, run or debit. Error codes are
`invalid_from` for a non-string value, `thread_not_found` for a malformed,
missing or trashed ref, and `thread_not_connected` for another lineage.

The child's first user turn holds the task prompt followed by a
`thread-reference` custom block. Its source ref, title, Agent, last activity and
read instructions are frozen at spawn. No source history is copied; the child
can call `thread_history` and `thread_ls` on the reference. Retitling the source
does not change the child's request prefix. When present, the parent's durable
invocation card also freezes `fromThreadId`, `fromThreadRef`, and
`fromThreadTitle` in `InvocationCardProps`; the live `agent.spawn.fromThreadId`
event remains an additional UI hint.

`./mf thread view` shows the reference and its frozen fields (`--json`);
`./mf thread context --all` shows the actual model input. Spawn events in
`./mf thread send --json` / `events --json` carry `fromThreadId`.
New handoff briefs use the same read instruction when the bake in effect at S
advertises history. Only when S has no bake does tool registration decide. Earlier
briefs retain their frozen text.
