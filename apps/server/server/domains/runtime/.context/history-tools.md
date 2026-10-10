# History tools and lineage scope

How a model finds and reads prior conversations: `thread_ls` lists connected
threads, `thread_history` reads one, `thread_report` reads a child's report,
and `spawn.from` points a new child at one. Tool inputs, limits, and error
codes are the HTTP-facing contract in
[docs/api/thread-tools.md](../../../../../../docs/api/thread-tools.md).
Rationale: [Models Read Connected Conversations by Lineage][kb-connected] and
[`spawn.from` Seeds a Frozen Reference][kb-from].

| File | Role |
|---|---|
| `spawn/resolve-readable-thread.ts` | `resolveReadableThread`, the one authority for which thread a model may read. |
| `spawn/thread-ls.ts`, `spawn/thread-ls-contract.ts` | `thread_ls`. |
| `spawn/thread-history.ts`, `spawn/thread-history-contract.ts` | `thread_history`: the page walk, turn numbering, saved reports and `expand`. |
| `spawn/history-item.ts` | Turn labels and the per-block projection: the visibility inputs, document elision, display indexes. |
| `spawn/history-result.ts` | `HistoryResult`, the structured result, and its pure text renderer. |
| `spawn/model-thread-report.ts`, `spawn/read-thread-report.ts` | `thread_report` (latest report, `running`), over the execution-addressed reader the app route also uses. |
| `tools/inspection-tools.ts` | Registers `thread_ls` and `thread_history` with repository and tokenizer ports at composition, not privileged run-loop callbacks. |
| `thread-reference.ts` | `threadReferenceText` and `threadReferenceBlock`, the frozen pointer shared by spawn seeds and handoff briefs. |
| `loop/history-tool-availability.ts` | Whether history guidance may name `thread_history` (below). |

## Scope: one authority

`resolveReadableThread` admits a ref only when it parses, names a live thread
in the caller's project owned by the caller's user, and is connected: either
it shares the caller's lineage (`sameLineage`: same project and `rootThreadId`;
forks and subagents are in it) or is its direct handoff/source counterpart. `areThreadsConnected`
checks the handoff's `originTurnId` owner in either direction, one hop only:
no source ancestors, siblings, or descendants are admitted through that edge.
A handoff still roots a new lineage; Scratch, credits, results, and
`thread_ls` descendant scope remain separate. An unknown or foreign ref is
`thread_not_found`; an unconnected one
is `thread_not_connected`. `threads.root_thread_id` is `NOT NULL`, so every
thread has a lineage root. Its callers are `thread_ls`, `thread_history`,
`thread_report`, `spawn.from` (`child-run-coordinator.ts`), and the
writer-facing report route. New readers reuse it; never reimplement the check.
`thread_message` shares `areThreadsConnected` for background delivery; foreground
delivery still requires the caller's subtree
([spawn](spawn.md#thread_message)).

Domain refusals leave handlers through `toolFailureResult`, keeping their code:
a caller whose bound model the gateway does not list gets `model_unavailable`,
not a generic `tool_error`.

## `thread_ls`

Every listed row is followed, when available, by an indented `last asked`
snippet from its newest local requester turn. Primary chats, forks, and
handoffs use a user-origin request; subagents use their parent agent's spawn
prompt, steer, or message. The bounded row set is loaded in one repository
query, never one query per thread. Snippets include only text blocks, collapse
whitespace, use JSON quoting, and truncate near 100 characters on a word
boundary. A derived primary with no local turn has no snippet; inherited
source history is intentionally not a fallback.

## `thread_history`

History projects the shared `readTranscriptPageForProjection` (threads
domain); there is no second fork walker. The handler returns a
`HistoryResult` and the registration's `renderResult` turns it into text (D8);
nothing parses the text back. Tool pairs load once per raw page, keyed by turn
and tool-call ID, including partners outside the page. `history-item.ts`
elides document copies before token trimming, using each tool's `history`
treatment ([document text](document-text.md)). Component blocks use their
model text when they define it; raw component props are never serialized.

- **Numbers.** Only conversation turns are numbered, with no gaps.
  `isConversationTurn` (threads domain: role, origin and `metadata.kind`)
  is the one rule; the walk, `countConversationTurns` (in SQL, the same
  predicate) and `findConversationTurnByOrdinal` all apply it, so they can't
  drift. The count before the page's first walked turn gives the base; the
  walk covered a contiguous run, so the rest follow. System turns get no
  number and can't be expanded. Cursors
  still encode storage keys; storage `position.sequence` never reaches the
  model.
- **Visibility.** One classifier reads the registration's `historyKind`
  (`"routine"`, or a function of the input for `work`), never tool-name
  strings. Absent means a receipt line. A routine call that failed, or that a
  settled turn never finished, still shows.
- **Paging.** `limit` counts shown turns; every consumed row advances the
  cursor, so hidden rows neither repeat nor count. A page stops at a new turn
  past the limit, at the 8k budget (possibly mid-turn), at a prompt-epoch
  boundary, or after scanning 2,000 raw rows.
- **Reports.** On a subagent's history, finished reports attach to the turn
  their `terminalTurnId` names, on the page that holds the turn's last row.
- **Call lines** (D48). `spawn/history-call-line.ts` writes each call as
  `name({json args}) → summary`, long strings shortened inside the JSON and
  keys in the tool's input-schema order (`orderLikeSchema`; `jsonb` loses
  the order the model sent);
  `historySummary` reads the summary from the typed result, and a failure's
  status or code comes from `failureCode` in `history-item.ts`. One form on a
  page, under `routine_calls` and in `expand: N`; `expand: "N.k"` adds the
  full arguments and result. A shown write line carries edit evidence.
- **Handles.** Display indexes (`N.k`) count a turn's blocks in order, a tool
  result sharing its call's index. The page computes them only for truncated
  items, from the turn's blocks.

Opt-in prompts (`include: ["system_prompt"]`) appear only when a cursor opens
a segment. Internal bake hashes are not model-facing.

## `thread_report`

`thread_report({ ref })` reads a child's latest finished report through
`readModelThreadReport`, which calls the unchanged `readThreadReport` (one
root repeatable-read snapshot) and then checks `listLatestByChildren`: an
admitted execution with no terminal truth means the child is running again,
reported as `running: true` with a line. `unavailable` says to wait for the
completion notice. `renderThreadReportOutput` turns the typed result into the
model's text with the same `renderReportBlock` history uses; nothing parses
it back. History summaries read the resolved `ref` from typed results
(`thread_ls` returns `{ ref, listing }`). The writer-facing
`GET .../reports/[childThreadId]/[execution]` route resolves `execution` to a
`run` index and calls `readThreadReport` with it; that execution-addressed
path is not on the model tool (D17). Report admission and publication are in
[spawn](spawn.md#reports).

## `spawn.from`

`spawn.from` accepts one connected ref or `current`. The coordinator resolves
it through `resolveReadableThread` before creating or driving the child, so a
bad ref leaves no stranded child or paid run. The source becomes a frozen
`thread-reference` custom block (`threadReferenceBlock`), not Agent
configuration or inherited history. `PreparedChild.seedBlocks` reaches the
runtime run input; `persistWriterTurn` assigns its owning user turn and
sequences it after the writer blocks. Writer admission and `UserMessageBlock`
do not accept these seeds. `userTurnContentParts` (`context-builder.ts`)
replays `props.text`, never live source metadata, so a retitle cannot change
the child's prefix. The invocation card's durable props (`fromThreadId`,
`fromThreadTitle`) carry the source for the parent's card;
`agent.spawn.fromThreadId` is a live hint only.

## History guidance follows the bake

Model-visible text that tells the model to call `thread_history` is frozen
into bytes, so it must follow the prompt epoch it lands in, not today's
registry or the destination's current binding. The rule is
`bakeHasHistoryTool`: the bake's frozen tool list advertises `thread_history`.
`historyReadableAt` applies it to the bake in effect at a turn, falling back to
tool registration only when the thread has no bake yet. Two places use it:

- the compaction summary's history-read sentence, resolved against C's own
  bake by `projectActiveHistoryWithBakes`
  ([compaction](compaction.md#one-projection-authority)), so a later registry change never rewrites an old summary;
- a settled handoff seed's read line, `threadReferenceText` appended inside
  `<system_update>` when `historyReadableAt(S)` holds, from the independent
  brief service's terminal seed projection
  ([handoff](handoff.md)).

A runtime composed without a registered-tool reader (tests, a tool-less
runtime) freezes no read line.

[kb-connected]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/conversations/connected-history-read.md
[kb-from]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/spawn-from-reference.md
