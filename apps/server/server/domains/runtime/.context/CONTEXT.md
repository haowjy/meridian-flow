# domains/runtime

The agentic execution engine. It takes a writer's message (or a subagent report,
a Work change, a queued control), streams the thread through an LLM with tool
use, persists every side effect through the threads repositories, and emits
`OrchestratorEvent`s that the threads domain fans out to clients.

| File | Concept |
|---|---|
| [run-loop.md](run-loop.md) | One run: the orchestrator, run session and claim, persistence ordering, finalization. |
| [delivery.md](delivery.md) | Writer admission, run state, hand-back, adoption, Work refreshes, images. |
| [request-assembly.md](request-assembly.md) | The bound Agent, composed system prompt, frozen prefix, history rendering, cache state. |
| [tools.md](tools.md) | Tool registry and executor, per-turn permissions, cost. |
| [spawn.md](spawn.md) | Lineage cancellation, the wake fence, multi-thread lock order. |
| [history-tools.md](history-tools.md) | `thread_history` failure rendering and bake-gated history guidance. |
| [document-text.md](document-text.md) | Document evidence in history and how compaction and `thread_history` replace copies. |
| [compaction.md](compaction.md) | The compaction transitions, projection authority, and late arrivals. |
| [controls.md](controls.md) | Queue order, the yield, applying a write-mode switch. |
| [handoff.md](handoff.md) | Handoff brief ownership of the destination run claim, Stop/Retry, release wake. |
| [summarizer.md](summarizer.md) | The shared summarizer port and paid-row settlement. |
| [recovery.md](recovery.md) | Placeholder repair, stale-lease settlement, process recovery lanes. |
| [gateway context](../gateway/.context/CONTEXT.md) | The provider-neutral gateway. |

Deferred work: [TODO](TODO) and [FUTURE](FUTURE).

Runtime reaches `domains/collab` and `domains/context` through ports the composition
root fills, apart from the `scratchOwnerFor` import in `loop/permissions/agent-chain.ts`;
compaction imports just the `DocumentRevisions` port type.
