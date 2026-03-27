# Streaming Service

Orchestrates LLM turn creation, SSE streaming, tool execution, and billing settlement. Deep dive: `.meridian/fs/backend/streaming/`.

## Cleanup Contract

Every exit path (success, error, cancel, credit exhaustion) MUST execute all 6 steps:

1. Remove executor from `ExecutorRegistry`
2. Clear interjection from `InterjectionRegistry`
3. Finalize tokens via `TokenFinalizer`
4. Settle or defer billing via `CreditSettler`
5. Mark turn status terminal (`complete`/`cancelled`/`error`/`credit_limited`)
6. Release `UserStreamTracker` slot via `onCleanup`

Missing any step causes resource leaks or phantom streams.

## StreamingDeps (Constructor)

Nested sub-structs grouping ~30 dependencies by concern. Each sub-struct has its own `Validate()`.

| Sub-struct | Contents |
|------------|----------|
| `PersistenceDeps` | TurnWriter, TurnReader, TurnNavigator, ThreadRepo, ProjectRepo, TxManager |
| `ServiceDeps` | DocumentSvc, FolderSvc, NamespaceSvc, SkillService, Validator, Authorizer, MutationStrategy |
| `PipelineDeps` | ProviderGetter, Registry, SystemPromptResolver, MessageBuilder, CapabilityRegistry, FormatterRegistry |
| `BillingDeps` | ToolLimitResolver, TokenFinalizer, CreditAdmissionChecker, CreditSettler, SettlementMode |
| `InfraDeps` | Config, JobQueue, Logger |

Defined in `service.go:70-202`. All validated via `ozzo-validation` at construction time.

## TurnStatus

Always use `llm.TurnStatus*` typed enum constants. The streaming service is the primary producer of status transitions:
- `pending` -> `streaming` (on stream start)
- `streaming` -> `complete` | `cancelled` | `error` | `credit_limited`

## Key Types

- `ExecutorRegistry` (`service.go`): Thread-safe `sync.Map` tracking `StreamExecutor` by turn ID for interrupt handling.
- `UserStreamTracker` (`user_stream_tracker.go`): Per-user concurrent stream limiter (free: 3, paid: 10).
- `StreamExecutor` (`stream_executor.go`): Core execution loop -- provider streaming, block processing, tool execution.

## Cancellation

Two modes based on model capability `supports_streaming_cancel`:
- **Hard cancel** (Anthropic): Stop provider immediately, use token count API for accurate billing.
- **Soft cancel** (OpenRouter): Provider continues for accurate metadata, but stop persisting content.

See `cancel_handler.go` for implementation.
