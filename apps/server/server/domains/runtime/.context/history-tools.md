# History tools and lineage scope

This context covers `thread_ls`, `thread_history`, `thread_report`, and
`spawn.from`. Inputs, limits, and error codes are the public contract in
[thread tools](../../../../../../docs/api/thread-tools.md).
Rationale: [connected history][kb-connected] and
[`spawn.from` frozen references][kb-from].

## One readability authority

`resolveReadableThread` is the sole scope check. It requires a parsed live ref
owned by the caller in the same Project and either the same `rootThreadId`
(forks/subagents included) or the one direct handoff/source edge. Handoff
chains, source ancestors, siblings, and unrelated descendants do not extend
that edge. A handoff starts a new lineage even though its source remains
reachable through the direct edge.

`thread_ls`, `thread_history`, `thread_report`, `spawn.from`, the report route,
and background `thread_message` reuse this authority. Foreground
`thread_message` additionally requires the caller's subtree. Unknown/foreign
refs return `thread_not_found`; disconnected refs return
`thread_not_connected`. Domain refusals preserve their typed codes.

## `thread_ls` and `thread_history`

`thread_ls` lists a bounded repository result and may include a local requester
snippet; inherited source history is not a fallback. `thread_history` uses the
threads domain's shared transcript projector, not a second fork walker. It
numbers conversation turns only, never exposes storage sequence, and reads
history classification from the registration rather than tool-name strings.

Its cursor advances over every consumed row, so hidden rows neither repeat nor
count. A page is bounded by shown-turn count, prompt epoch, token budget, and
raw-row scan. Tool pairs are loaded for the raw page, including partners outside
the page; document copies are elided using their registered history treatment.
System turns are unnumbered, component props are not serialized, and display
handles count blocks only for truncated items.

**The model never reads a failure.** A tool's return (failure included) is the
model's; every other failure is for the writer and for diagnostics. A turn
prints only what it kept: its text, and the tool calls and results it recorded.
`thread_history` has no `error:` or `failure reason:` line and no failed-turn
heading, and a failed turn with nothing kept is skipped. Stop is the writer's
decision, not a failure, so a cancelled turn keeps its `cancelled` marker. The
same holds in `expand`. A failed or cancelled subagent reaches its parent through
the `spawn` return and `thread_report`'s `outcome`, which are tool returns and
are not built from history lines. The synthetic result for a tool call a failed
turn never finished says the call "did not finish", and never that an error
interrupted it. Requests and summary inputs are built from blocks, never from
`turn.error`.

History renders typed results directly. Call lines use the registration's
summary; `expand` may include typed arguments/results. Reports attach to the
turn named by `terminalTurnId`. Internal hashes and storage keys remain
non-model-facing.

## Reports and `spawn.from`

`thread_report({ ref })` reads the latest finished report from the execution-
addressed repository path. An admitted execution without terminal truth is
reported as running; an unavailable report tells the model to wait for its
completion notice. The model tool and writer route use different result shapes
but one contracts parser and report projection.

`spawn.from` accepts one connected ref or `current`. Resolution occurs before
child creation; a bad ref creates no child or paid run. The source becomes a
frozen `thread-reference` block with source identity and cutoff, never inherited
history or Agent configuration. The child's replay uses the frozen text, so a
source retitle cannot change its prefix.

## Guidance follows the bake

Model-visible guidance to call `thread_history` is frozen in prompt bytes.
`bakeHasHistoryTool` and `historyReadableAt` resolve it against the bake in
effect, including for a compaction summary or settled handoff seed. A later
registry change cannot rewrite an old summary's sentence. A runtime without a
registered history reader freezes no read line.

[kb-connected]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/conversations/connected-history-read.md
[kb-from]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/conversations/spawn-from-reference.md
