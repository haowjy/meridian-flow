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
| `spawn/thread-history.ts`, `spawn/thread-history-contract.ts`, `spawn/history-item.ts` | `thread_history` and its per-item projection. |
| `spawn/read-thread-report.ts` | `thread_report`. |
| `tools/inspection-tools.ts` | Registers `thread_ls` and `thread_history` with repository and tokenizer ports at composition, not privileged run-loop callbacks. |
| `thread-reference.ts` | `threadReferenceText` and `threadReferenceBlock`, the frozen pointer shared by spawn seeds and handoff briefs. |
| `loop/history-tool-availability.ts` | Whether history guidance may name `thread_history` (below). |

## Scope: one authority

`resolveReadableThread` admits a ref only when it parses, names a live thread
in the caller's project owned by the caller's user, and shares the caller's
lineage (`sameLineage`: same project and `rootThreadId`, forks and handoffs
included). An unknown or foreign ref is `thread_not_found`; an unconnected one
is `thread_not_connected`. `threads.root_thread_id` is `NOT NULL`, so every
thread has a lineage root. Its callers are `thread_ls`, `thread_history`,
`thread_report`, `spawn.from` (`child-run-coordinator.ts`), and the
writer-facing report route. New readers reuse it; never reimplement the check.
`thread_message` is a write and has its own authorization
([spawn](spawn.md#thread_message)).

Domain refusals leave handlers through `toolFailureResult`, keeping their code:
a caller whose bound model the gateway does not list gets `model_unavailable`,
not a generic `tool_error`.

## `thread_history`

History projects the shared `readTranscriptPageForProjection` and bounded
expansion read (threads domain); there is no second fork walker. Tool pairs
load once per raw page, keyed by turn and tool-call ID, including partners
outside the page. `history-item.ts` filters and elides document copies before
token trimming, using each tool's `history` treatment
([document text](document-text.md)). Pages cap scan work at 2,000 raw items
and carry the settled anchor forward when trimming. Opt-in prompts
(`include: ["system_prompt"]`) appear only when a cursor opens a segment; a
segment header otherwise names the Agent and bake.

## `thread_report`

`thread_report({ ref, run? })` reads a child's saved report. An omitted `run`
defaults to the latest finished report; an explicit 1-based `run` reads an
earlier one. The read runs in one root repeatable-read snapshot. A `run` with
no matching finished report, or one whose outcome, source, or summary never
finalized, is `unavailable`, the only non-success status. The separate
writer-facing `GET .../reports/[childThreadId]/[execution]` route also returns
`not_ready` for an execution still running; it resolves `execution` to a
`run` index itself and is not the model tool. Report admission and publication
are in [spawn](spawn.md#reports).

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

[kb-connected]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/connected-history-read.md
[kb-from]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/spawn-from-reference.md
