# History tools and lineage scope

`thread_ls`, `thread_history`, `thread_report` and `spawn.from`. Inputs, limits and
error codes are the public contract in
[thread tools](../../../../../../docs/api/thread-tools.md). Policy is in
[connected history][kb-connected] and [`spawn.from` frozen references][kb-from].

`resolveReadableThread` is the sole scope check for those tools and the report
route. `thread_message` has its own authority (`authorizeThreadMessage`).

## The model never reads a failure

A tool's return, failure included, is the model's; every other failure is for the
writer and for diagnostics. A turn prints only what it kept: its text, and the tool
calls and results it recorded. `thread_history` has no `error:` or `failure reason:`
line and no failed-turn heading, and a failed turn with nothing kept is skipped. Stop
is the writer's decision, not a failure, so a cancelled turn keeps its `cancelled`
marker. The same holds in `expand`.

A failed or cancelled subagent reaches its parent through the `spawn` return and
`thread_report`'s `outcome`, which are tool returns and aren't built from history
lines. The synthetic result for a tool call a failed turn never finished says the
call "did not finish", never that an error interrupted it. Requests and summary
inputs are built from blocks, never from `turn.error`.

## Guidance follows the bake

Model-visible guidance to call `thread_history` is frozen in prompt bytes.
`bakeHasHistoryTool` and `historyReadableAt` resolve it against the bake in effect,
including for a compaction summary or settled handoff seed, so a later registry
change can't rewrite an old summary's sentence.

[kb-connected]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/agents/conversations.md
[kb-from]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/agents/conversations.md
