# Tool System Overview

The tool layer builds per-request tool registries from service interfaces and executes calls with deterministic ordering and provenance context.

## Registry

`ToolRegistry` is a `sync.RWMutex`-guarded `map[string]ToolWithMetadata` where each tool bundles executor logic and prompt metadata.

Single-call execution uses `Execute`, parallel execution uses goroutines in `ExecuteParallel`, and result order is preserved by writing into a pre-sized index-aligned slice.

`Prune` removes tools after registration so persona policy can enforce least privilege without changing registration code.

## Builder Composition

`ToolRegistryBuilder` composes a context-specific registry because work-item scope, skill availability, and external integrations vary by thread.

| Stage | Method | Gate condition |
| --- | --- | --- |
| Namespace routing | `WithNamespaceService` | Always |
| Mutation strategy | `WithMutationStrategy` | Always (tool construction panics if nil) |
| Work item isolation | `WithWorkItemSlug` | Work item slug exists for request |
| Document tools | `WithEnabledDocumentTools` | Frontend enable-list includes each tool |
| Web search | `WithWebSearch` | Non-nil `SearchClient` |
| Spawn tool | `WithSpawnTool` | `spawnInvoker != nil` and `workItemID != ""` |
| Skill tools | `WithEnabledSkillTools` | Non-nil `SkillResolver` |
| Persona filter | `WithPersonaToolFilter` | Persona allow/deny policy configured |

The tools package depends on service-layer interfaces and keeps repository types out of tool wiring.

## Web Search and Thread Context

`web_search` is provider-agnostic through `external.SearchClient` and currently has a Tavily implementation.

The tool accepts topic filters `general`, `news`, and `finance` and forwards validated options to the search client.

Streaming injects `threadID`, `turnID`, and `userID` into context before parallel execution so mutation strategies can attribute edits.

`doc_search` blocks `.meridian/` and `.session/` folders to keep internal and ephemeral namespaces out of tool-based reads.

## File References

| Area | File references |
| --- | --- |
| Registry structure + metadata | `backend/internal/service/llm/tools/registry.go:37`, `backend/internal/service/llm/tools/registry.go:49` |
| Parallel execution ordering | `backend/internal/service/llm/tools/registry.go:198`, `backend/internal/service/llm/tools/registry.go:207`, `backend/internal/service/llm/tools/registry.go:231` |
| Tool pruning | `backend/internal/service/llm/tools/registry.go:148`, `backend/internal/service/llm/tools/registry.go:151` |
| Builder and service-layer boundary | `backend/internal/service/llm/tools/builder.go:10`, `backend/internal/service/llm/tools/builder.go:17` |
| Composition stage methods | `backend/internal/service/llm/tools/builder.go:33`, `backend/internal/service/llm/tools/builder.go:60`, `backend/internal/service/llm/tools/builder.go:86`, `backend/internal/service/llm/tools/builder.go:97`, `backend/internal/service/llm/tools/builder.go:125`, `backend/internal/service/llm/tools/builder.go:158` |
| Web search tool | `backend/internal/service/llm/tools/web_search.go:21`, `backend/internal/service/llm/tools/web_search.go:46`, `backend/internal/service/llm/tools/web_search.go:78` |
| Search client interface + Tavily implementation | `backend/internal/service/llm/tools/external/client.go:8`, `backend/internal/service/llm/tools/external/tavily_client.go:20`, `backend/internal/service/llm/tools/external/tavily_client.go:50` |
| Thread context injection/extraction | `backend/internal/service/llm/tools/thread_context.go:14`, `backend/internal/service/llm/tools/thread_context.go:25` |
| Streaming context propagation | `backend/internal/service/llm/streaming/tool_executor.go:118`, `backend/internal/service/llm/streaming/tool_executor.go:123` |
| `doc_search` namespace guard | `backend/internal/service/llm/tools/search.go:80`, `backend/internal/service/llm/tools/search.go:88` |
