# LLM Domain

Types and interfaces for LLM conversation management and streaming. Import: `meridian/internal/domain/llm`. Deep dive: `.meridian/fs/backend/streaming/`.

## Key Concepts

- **TurnStatus typed enum**: `type TurnStatus string` with constants `TurnStatusPending`, `TurnStatusStreaming`, `TurnStatusWaitingSubagents`, `TurnStatusComplete`, `TurnStatusCancelled`, `TurnStatusError`, `TurnStatusCreditLimited`. Never use bare strings.
- **ISP splits**: Turn access split into `TurnReader` (5 methods), `TurnWriter` (10 methods), `TurnNavigator` (tree traversal). Composite `TurnStore` embeds all three.
- **Streaming**: `StreamingService` interface orchestrates turn creation, SSE streaming, tool execution, interjection, and cancellation. Implementation in `internal/service/llm/streaming/`.
- **Provider abstraction**: `LLMProvider` interface supports Anthropic + OpenRouter. Capability interfaces (`GenerationStatsQuerier`, `GenerationCanceller`) for provider-specific features.
- **Branching conversations**: Turns form a tree via `PrevTurnID`. `TurnNavigator` handles tree traversal.

## Interfaces

| Interface | Purpose | File |
|-----------|---------|------|
| `TurnReader` | Read turns + blocks | `turn_reader.go` |
| `TurnWriter` | Create/update turns, atomic token accumulation | `turn_writer.go` |
| `TurnNavigator` | Tree traversal (ancestors, siblings) | `turn_navigator.go` |
| `TurnStore` | Composite: Reader + Writer + Navigator | `turn.go` |
| `ThreadStore` | Thread CRUD | `thread_store.go` |
| `StreamingService` | Turn creation, streaming orchestration, cancel, interjection | `streaming_service.go` |
| `ThreadService` | Thread session management | `thread_service.go` |
| `ThreadHistoryService` | Read thread history | `thread_history_service.go` |
| `LLMProvider` | Provider abstraction (generate, stream) | `provider.go` |
| `GenerationStatsQuerier` | Provider-specific generation metadata | `provider.go` |
| `GenerationCanceller` | Provider-specific cancel | `provider.go` |
| `SystemPromptResolver` | Build system prompts | `system_prompt.go` |
| `MessageBuilder` | Build provider messages from turns | `message_builder.go` |
| `SpawnInvoker` | Spawn lifecycle (create, status, cancel) — breaks streaming↔spawn circular dep | `spawn.go` |
| `ToolLimitResolver` | Tool round limits (tier-ready) | `tool_limits.go` |

## Conventions

- `AccumulateTokensAndUpdateMetadata` is atomic -- single DB call for token + metadata update.
- `StreamEvent` is a union type: check `Delta`, `Block`, `Metadata`, `Error`, etc. fields.
- `ProviderResolver` routes to the correct `LLMProvider` by model name.
