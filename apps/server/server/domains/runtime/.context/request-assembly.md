# Request assembly and the frozen prefix

What the model is sent on each call: the bound Agent, the frozen system prompt
and tool list, the rendered history, and the cache hints. The rule this file
protects:

**A thread's cached request prefix (system prompt, advertised tools, and
history) is fixed except at named prompt-epoch boundaries and image-removal
breaks.** Rationale lives in the KB:
[A Thread's Request Prefix Changes Only at Named Epochs][kb-frozen-prefix].

| File | Role |
|---|---|
| `tools/agent-thread-context.ts` | Reads the immutable thread binding: persona, tools, effort, and diagnostic Agent identity. |
| `loop/turn-context-assembly.ts` | Resolves the retained Agent and bake, then projects active compaction history with `thread.ref` (through `projectActiveHistoryWithBakes`, see [compaction](compaction.md)) before stable image inclusion and `buildContext`. Old pre-cut images stay out of the rebuilt request, and un-compacted requests stay byte-identical. Preview shares this assembly without persisting. |
| `loop/composed-system-prompt.ts` | Assembles the first system prompt in a fixed layer order (below). |
| `loop/begin-prompt-epoch.ts` | `beginPromptEpoch`, the one rebake operation. |
| `loop/context-builder.ts` | Builds `Message[]` + `Tool[]` from the bake's system bytes and every persisted turn, including durable notices, skill bodies, and subagent updates. |
| `loop/system-instructions/` | Model-facing prompt assets independent of any Agent body. `document-dialect.ts` is the short "Meridian Markdown" card (links, HTML tables, `<Layout>`, images): only what the model cannot already know. `runtime-uris.ts` is a short list of context URI schemes. Tool descriptions stay brief; per-command guidance lives in each command variant's schema `.describe()`. |
| `loop/prefix-cache-state.ts` | Predicted cache warmth (below). |
| `loop/prompt-cache-marks.ts` | Provider-neutral cache breakpoints (below). |

## Bound Agent

`agent-thread-context.ts` reads the immutable thread binding. The Agent body is
always the retained revision's `systemPrompt` (or the host-owned empty default
for an agent-less child); a spawn-time `appendSystemPrompt` is a separate
additive layer, never a replacement. Tools and effort come from the bound
configuration, never definition metadata. `mapAgentEffortToReasoning` (with
`EFFORT_TO_REASONING`) is the single bridge from canonical `AgentEffort` to the
gateway's provider-neutral `GenerateRequest.reasoning`. A missing binding fails
before a gateway call. Catalog removal or advancement leaves continued
execution on its retained revision. The model comes from conversation-owned
resolved configuration, including a frozen default when the source omits it.

Forks keep the source's bound Agent and inherit `bakeAt` the cutoff on the
owning thread; a fork cannot select a different Agent. Only a handoff changes
the Agent, and a different-Agent handoff starts unbaked
([handoff](handoff.md)).

## Composed system prompt

`composed-system-prompt.ts` layers, in order: the immutable Agent body, the
invocation overlay's additive `appendSystemPrompt`, frozen Work context,
available skill slugs (name when it differs) and descriptions, the bodies of
preloaded (`skills.load`) skills, the named
subagent roster (slug, name, description), the core document dialect, the
runtime URI instruction, and, for subagent threads only, the mandatory closing
report instruction (`SUBAGENT_GUIDANCE`) as the last layer. An empty or absent
append adds nothing.

Prompt bake lists the thread's own bound `skills.available` only, by slug
(name when it differs) with the description from the retained `SKILL.md`,
dropping `model-invocable: false`; the model loads one with the `skill` tool
(D58). Subagent threads read their own binding the same way as primaries;
nothing falls back to the parent's or the writer's skills. Account installs
never join the prompt or `skills://`. `skills.load` bodies are baked into the
first prompt (rendered like a slash activation, headed by `skill`'s result
header when the model can read the skill) regardless of `model-invocable`,
which only governs what `skills://` shows. The first-bake
CAS persists the Agent-available slugs (`[]` when the list is empty). Skills
that join slash after freeze do not rewrite the prompt or its skill list, and
display slugs do not guard freezing. Named spawn targets come from the
binding's roster, baked into the prompt like available skills (not listed on
the spawn tool); an omitted or empty `agent` selects the agent-less generic
subagent.

The slash catalog is separate. Slash (`/` and Send `activatedSkillSlugs`) lists
every user-invocable `skills/<slug>/SKILL.md` from system and owner package
installations (each walked with `retainedPackageSkillMaps`) plus account
installs; the first installed package file wins a slug collision, and package
files win over account rows. The bound Agent package is not the slash catalog.

## Prompt lifetime

The system and advertised-tool bytes come from an immutable `prompt_bakes`
row. First assembly inserts a bake and wins the thread's write-once
`initialPromptBakeId` (the freeze sentinel); concurrent first attempts use the
row lock and all receive the winner. The first bake commits with a
successfully prepared run start, before model execution; a later gateway
failure or cancellation leaves it in place. Later turns send
`PromptBake.composedSystemPrompt` and `PromptBake.bakedTools` verbatim.

`agent-thread-context.ts` still re-derives `advertiseTools(baseTools, policy)`
(plus the spawn description and, for a subagent thread, `return_result`) every
turn. Live policy from the immutable binding gates execution every turn:
freezing pins what the model is *told* it can call, never what dispatch and
the permission gate allow. A frozen advertised tool missing from the live
registry returns an ordinary `Tool not found` tool result
(`tools/tool-executor.ts`), because dispatch is by name against the live
registry.

A code deploy, Agent revision update, model change, or idle/cache-TTL timer
never rebakes a live thread. `beginPromptEpoch` is the named transactional
operation for a reserved boundary: it hashes composed live parts, reuses the
current row when the bytes match, and completes the turn through
`persistAndAppendEvents`. Its caller is the compaction successor commit (`compaction-successor.ts`). `bakeAt` and
`bakeInEffect` use complete owner-local boundary turns in write-once
`turns.position` order. Positions are assigned under the thread mutation lock,
and fork-local turns begin after their cutoff.

A change the model must learn about mid-thread is a durable conversation turn,
never a prompt or tool-list change. Work refreshes, notices, child results,
and invoked skill bodies all enter that way; see [delivery](delivery.md).

## History rendering

`context-builder.ts` emits every persisted system-role history turn in place
as a user message wrapped once in `<system_update>`. Only the thread's system
prompt uses the provider system field; adapters merge adjacent user messages
as Anthropic requires. Child-provenance text carries a compact exact
`thread_report` call, never the report body. Assistant custom blocks stay
UI-only to preserve `tool_use`→`tool_result` adjacency.

Canonical history projection preserves persisted `tool_use` intent and
synthesizes transient error results for calls missing results in the
immediately following tool-role group. Repairs are never persisted and never
rerun tools.

## Cache state and cache hints

`derivePrefixCacheState` is pure; `createPrefixCacheStateService`'s
`prefixCacheStateFor({ threadId, model, now })` gathers the latest response
through `findLatestByThread`, with model and descriptor from the assembly's
resolved registry model. The prediction is made before `Gateway.stream()`,
recorded on `model_responses` in the same transaction as usage, and not
recomputed after retry waits. Warmth follows the shared
`threads/domain/prompt-epochs.ts` `bakeIdAt` rule, complete compaction
boundaries, and the `system_update`/`image_inclusion` codec; first-sight image
notices append without breaking the sent prefix. Forks resolve their cutoff
owner's history and bake until their first local response. Cache age is
anchored on the previous response's `model_responses.request_started_at` (the
successful gateway attempt's wall-clock invocation time); a missing start is
`cold/facts_unavailable`. Only assistant responses supply a reusable prefix or
token baseline; summary rows on C or a handoff seed never do. Rationale:
[Prefix Cache Warmth Is Predicted From Durable Facts][kb-cache-state].

`ContentPart.cacheBreakpoint?: true` is provider-neutral intent. The loop sets
up to three marks only for a registry model with `promptCache.kind ===
"explicit"`. `GenerateRequest.promptCacheKey` is an unconditional routing
hint: ordinary threads use their own ID, forks use the ID of the thread that
owns their cutoff turn. Adapter wire shapes, TTLs, and the model descriptor
live in the [gateway context](../gateway/.context/CONTEXT.md).

[kb-frozen-prefix]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/request-prefix/frozen-request-prefix.md
[kb-cache-state]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/agents/request-prefix/prefix-cache-state.md
