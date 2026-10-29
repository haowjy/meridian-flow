# Request assembly and the frozen prefix

This context covers the Agent, system prompt, history, and cache hints sent to a
model. A thread's cached prefix (system prompt, advertised tools, and history)
changes only at named prompt epochs, image-removal breaks, and the one `skill`
tool join after a user's first `/skill`.
Rationale: the [frozen-prefix decision][kb-frozen-prefix], which also covers
cache warmth.

## Bound Agent and prompt

The immutable thread binding supplies the retained Agent body, resolved model,
tools, effort, and invocation overlay. A spawn-time `appendSystemPrompt` is
additive, never a replacement. Missing binding fails before gateway dispatch;
catalog removal or advancement cannot change a retained binding. Forks keep the
source binding and cutoff bake; only handoff selects a different Agent and
starts unbaked.

The composed prompt layers the Agent body, additive overlay, frozen Work
context, available skills/descriptions, preloaded skill bodies, named spawn
roster, document dialect, runtime URI guidance, and the subagent report
instruction last. Bound `skills.load` bodies are baked into the first prompt;
model-invocable availability controls `skills://` visibility, not preloading.
Slash inventory is separate from the bound Agent package and includes eligible
system/owner package files plus account installs.

## Prompt lifetime

The first assembly writes an immutable `prompt_bakes` row and wins the thread's
write-once `initialPromptBakeId` under the row lock. A later gateway failure or
cancellation does not remove it. The first bake commits with a successfully
prepared run start before the model call. Later turns reuse system and tool bytes
verbatim, except that the live `skill` tool may be appended once after its
first invocation. Live policy still gates execution each turn; freezing pins
what the model is told, not what dispatch can execute. A missing frozen tool
returns an ordinary tool result.

`beginPromptEpoch` is the named transactional rebake operation, used by the
compaction successor. It hashes live parts, reuses the row when bytes match,
and commits the epoch with the turn. Deploys, Agent revision changes, model
changes, and cache timers never rebake a live thread. Mid-thread Work refreshes,
notices, child results, and skill bodies are durable conversation turns instead.

Request preparation loads Agent, prefix, history and reference state once, then
can render the prepared context again with the optional Scratch-update marker.
The run installs the prepared context and continuation only after the boundary
commits; a losing prepare attempt changes no in-process continuation state.

## History and cache

`context-builder.ts` renders persisted system turns as user messages wrapped in
`<system_update>`, preserves tool-call adjacency, and synthesizes transient
missing-tool results without persisting repairs. Child reports remain body-free;
the model reads them through `thread_report`.

Prefix warmth is predicted from durable facts: the resolved registry model,
previous successful assistant response, prompt-epoch bake, complete compaction
boundaries, image decisions, and cutoff lineage. Summary rows and handoff seeds
never supply warmth or a token baseline. Cache age uses the previous response's
request-start time against the TTL the thread kind requests (primary long,
subagent short); missing time is cold/unknown. A thread's first request
predicts cold even when the provider serves shared leading bytes from cache, and
the first request after a compaction is cold because only an assistant turn's
response counts as a reusable prefix. A fork routes its cache key to the thread
that owns its cutoff turn. Prediction columns are non-null so the audited
summarizer decision always stores one.

`ContentPart.cacheBreakpoint` is provider-neutral intent. The loop marks only
models with explicit cache descriptors, while adapter TTLs and wire shape live
in the [gateway context](../gateway/.context/CONTEXT.md).

No Work context explains bare Scratch as the chat lineage's notes, shared by
forks/subagents at the first-chat handle. Named-Work Scratch remains the
Work's. A writer rebind writes a Work-switch notice and never moves notes or
rebakes the prompt.

[kb-frozen-prefix]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/request-prefix/frozen-request-prefix.md
