# Request assembly and the frozen prefix

This context covers the Agent, system prompt, history, and cache hints sent to a
model. A thread's cached prefix (system prompt, advertised tools, and history)
changes only at named prompt epochs, image-removal breaks, and the one `skill`
tool join after a user's first `/skill`.
Rationale: the [frozen prefix][kb-frozen-prefix], which also covers
cache warmth.

## Bound Agent and prompt

A chat can run on another model and at another reasoning setting than its Agent's:
`threads.model_override` and `threads.effort_override`, set together by the `thread_set_overrides`
command and never part of the binding, so a compaction's binding refresh keeps them.
`turnGatewayParams` (turn-context-assembly) resolves it per request: the override while the gateway
lists it, else the Agent's model, else the default. An id the gateway no longer lists runs on the
Agent's model, and `turns.model` records what ran; a client tells "fell back" from "chosen" by
comparing the override with the newest turn's model, or with `GET /api/models` (`available`) for the
turn about to run. The effort override always replaces the Agent's effort; the server never drops it. The
gateway's `resolveReasoning` clamps whichever runs to the nearest level the resolved model accepts,
as it does for the Agent's own level. Every reader of the chat's model goes through `threadModelId`,
which takes the gateway. There is one vocabulary, Mars's ladder (`effortLevels()` in
`@meridian-flow/mars-schema`: none, minimal, low, medium, high, xhigh, max), and the gateway is built with it
(`reasoningLevels`). An Agent file's `effort` (checked where Mars reads the file), a chat's override and the request's
`reasoning` are the level's name, unchanged: `xhigh` stays `xhigh`, `none` is off where the model lists it. `auto` and a
missing `effort` store nothing, the model's own default. Flow does not use mars-schema's `meridian-flow` host set. The
gateway's `resolveReasoning` runs a level the model does not list at the nearest one it does on the ladder, a tie going
up; a name off the ladder runs at the model's default.
`LIVE_TEST_MODEL` redirects at the gateway, so an override cannot bypass it. A change costs a
cache rebuild, already predicted as `model_changed`.

The immutable thread binding supplies the retained Agent body, resolved model,
tools, effort, and invocation overlay. A spawn-time `appendSystemPrompt` is
additive, never a replacement. Missing binding fails before gateway dispatch;
catalog removal or advancement cannot change a retained binding, except at a compaction:
there the successor's bake and first request read the newest saved Agent
(`agentCatalog.refreshBinding`, computed in preparation), and the binding row is
replaced in the compaction's transaction just before `beginPromptEpoch`. No
other boundary refreshes it, and compaction writes no notice line. Only a
top-level chat refreshes (no parent): a subagent's
configuration was built with its parent's overrides and is never rebuilt. An
automatic compaction in the middle of a long reply continues that reply as the
successor (`continuingTask`), so the rest of the reply runs on the new
definition: prompt, tools, permission and model can change partway through
what the writer sees as one reply. Forks keep the
source binding and cutoff bake; only handoff selects a different Agent and
starts unbaked.

The composed prompt layers the Agent body, additive overlay, frozen Work
context, available skills/descriptions, preloaded skill bodies, named spawn
roster, the connections' catalogue (only when the thread's policy has `mcp_call`; its
connections are saved in the bake as `bakedConnections`, and a subagent takes its parent's bake in
effect), document dialect, runtime URI guidance, and the subagent report
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
subagent short); missing time is cold/unknown, and so is a provider that documents
no lifetime (Gemini). A thread's first request
predicts cold even when the provider serves shared leading bytes from cache, and
the first request after a compaction is cold because only an assistant turn's
response counts as a reusable prefix. A fork routes its cache key to the thread
that owns its cutoff turn. Prediction columns are non-null so the audited
summarizer decision always stores one.

The loop places no cache breakpoints. The Anthropic adapter marks the wire
request itself (system, and the two latest user turns) for explicit-cache
offerings; see the [gateway context](../../../lib/gateway/.context/CONTEXT.md).

No Work context explains bare Scratch as the chat lineage's notes, shared by
forks/subagents at the first-chat handle. Named-Work Scratch remains the
Work's. A writer rebind writes a Work-switch notice and never moves notes or
rebakes the prompt.

[kb-frozen-prefix]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/agents/request-prefix.md
