# Pre-Migration Refactoring Proposal

Structural cleanup to reduce entropy before the WebSocket streaming migration begins. Each proposal is scoped to be independently executable and verifiable — no proposal depends on another unless explicitly noted.

## Context

The WS migration introduces:
- A new `wsutil` framework replacing collab handler infrastructure
- Thread WS and Doc WS replacing SSE handler and project WS
- Transport-neutral interfaces (`ActiveTurnHandle`, `InterjectionRouter`, `TurnStreamStarter`) replacing concrete deps
- `InterjectionForwarder` replacing the current interjection buffer pattern

The existing code has accumulated structural debt that would either block the migration, force the migration to build on top of mess, or cause unnecessary merge conflicts. This proposal targets the highest-leverage cleanups.

---

## R1: Consolidate Auth into Reusable Primitives

**Problem**: Auth is duplicated between project WS and document WS handlers. Project WS uses `bootstrapProjectAuth()` (collab_authenticator.go:122-148) which delegates to `bootstrapAuth()` (collab_authenticator.go:56-117). Document WS (collab_document_handler.go:149-211) does its own inline JWT/ownership flow — reading from `coder/websocket`, verifying tokens, checking identity blocking, parsing UUIDs — reimplementing what `bootstrapAuth` already does, but against a different WS library's API.

The new `wsutil` framework needs a single `Authenticator` interface (framework.md §auth.go). If auth logic is scattered across two incompatible patterns, the wsutil auth implementation will either pick one and leave the other as dead code, or try to abstract over both and end up messy.

**What Changes**:

| File | Lines | Change |
|------|-------|--------|
| `backend/internal/handler/collab_authenticator.go` | 56-117 | Extract core auth logic (JWT verify → identity check → UUID parse → expiry capture) into a library-agnostic helper that takes `token string` instead of `*websocket.Conn` |
| `backend/internal/handler/collab_authenticator.go` | 122-148 | `bootstrapProjectAuth` calls the new helper + project access check |
| `backend/internal/handler/collab_document_handler.go` | 149-211 | Replace inline auth with call to the new helper + document ownership check |

**Specific refactor**:

1. Extract `authenticateToken(token string) (*collabAuthResult, error)` from `bootstrapAuth()`. This method does JWT verification, identity blocking, UUID parsing, and expiry capture — everything except reading from the wire. The current `bootstrapAuth` becomes: read token from `x/net/websocket` → call `authenticateToken`.

2. Document handler's inline auth (lines 167-191) becomes: read token from `coder/websocket` → call `authenticateToken` → do document-specific checks.

3. The new `wsutil.Authenticator` can then call `authenticateToken` with the token extracted from the WS auth envelope, and the document Yjs WS continues to call `authenticateToken` the same way.

**Why before migration**: The wsutil framework auth (framework.md §auth.go) needs a clean token-verification primitive to build on. If we extract it now, the wsutil auth implementation is a thin adapter. If we wait, the migration either copies the inline logic a third time or does this extraction mid-migration, creating a larger, harder-to-review diff.

**Risk**: Low. The extraction is mechanical — same logic, different call site. Both paths are well-tested by existing integration tests.

---

## R2: Remove Dead Inbound Command Path in Project WS

**Problem**: `collab_project.go:130-150` (`handleProjectTextMessage`) has a switch statement that only handles `heartbeat`. The default case silently drops all other message types with a comment about "forward compatibility." The design doc (doc-ws.md §What the Current Project WS Does) explicitly identifies dead inbound command code — proposal accept/reject/requestUpdate was planned but never implemented server-side.

Additionally, the `projectWSConnection` adapter (lines 16-22) wraps the old `websocketDocumentConnection` to satisfy the `ProjectConnection` interface. This naming is confusing (a "document connection" used for a project socket).

**What Changes**:

| File | Lines | Change |
|------|-------|--------|
| `backend/internal/handler/collab_project.go` | 130-150 | Add comment clarifying the default case is intentional dead-code-free forward compat (already clean, just clarify) |
| `backend/internal/handler/collab_project.go` | 15-22 | Rename `projectWSConnection` internal field from `wsConn *websocketDocumentConnection` — or leave as-is since the whole file gets replaced by doc WS |

**Why before migration**: Minimal value. The project WS is being replaced entirely. **Recommendation: Skip this — do it during migration when the file is deleted.** The dead code is in a file that's about to be removed.

**Risk**: N/A (skip).

---

## R3: Extract Transport-Neutral Auth Error Mapping

**Problem**: Both `handleProjectSocket` (collab_project.go:72-87) and the document handler have inline error-code mapping logic that converts domain errors (`ErrAuthFailed`, `ErrAuthExpired`, `ErrForbidden`) to wire codes (`AUTH_FAILED`, `AUTH_EXPIRED`, `FORBIDDEN`, `INTERNAL_ERROR`). The wsutil framework needs the same mapping for its auth error responses.

**What Changes**:

| File | Lines | Change |
|------|-------|--------|
| `backend/internal/handler/collab_authenticator.go` | new | Add `func authErrorToCodeAndMessage(err error) (code string, message string)` |
| `backend/internal/handler/collab_project.go` | 72-87 | Replace inline switch with `authErrorToCodeAndMessage(authErr)` call |
| `backend/internal/handler/collab_document_handler.go` | 153-206 | Could use same mapping, but document auth has more granular error points (timeout, binary message, etc.) |

**Why before migration**: The wsutil auth module (framework.md line 3: `auth.go — JWT bootstrap + heartbeat re-auth`) will need this same mapping. Extracting it now means the wsutil module imports it rather than duplicating.

**Risk**: Low. Mechanical extraction of a pure function.

---

## R4: Extract `InterjectionRouter` Interface from Concrete Dependencies

**Problem**: The streaming service layer uses concrete `mstream.InterjectionBuffer` and `mstream.InterjectionRegistry` directly:
- `deps.go:104`: `ServiceDeps.InterjectionRegistry *mstream.InterjectionRegistry`
- `stream_executor.go:125`: `interjectionBuffer mstream.InterjectionBuffer`
- `stream_runtime.go:28`: `interjectionRegistry *mstream.InterjectionRegistry`
- `interjection.go:23-37`: Service methods use `s.interjectionRegistry.GetOrCreate()`, `buffer.Replace()`, `buffer.Append()`

The design calls for an `InterjectionRouter` interface (thread-ws.md §Service Layer Interfaces, interjection-forwarder.md §InterjectionRouter Interface) that wraps the forwarder. Both the HTTP interjection handler and the WS interjection message handler call `Route()`.

**What Changes**:

| File | Lines | Change |
|------|-------|--------|
| `backend/internal/service/llm/streaming/deps.go` | 104 | Change `InterjectionRegistry *mstream.InterjectionRegistry` to `InterjectionRouter InterjectionRouter` (interface) |
| `backend/internal/service/llm/streaming/stream_runtime.go` | 28, 152 | Change `interjectionRegistry *mstream.InterjectionRegistry` field and `GetOrCreate` call to use router interface |
| `backend/internal/service/llm/streaming/interjection.go` | 23, 120, 139 | Change service methods to use router interface (Route for upsert, read-through for get/clear) |
| `backend/internal/service/llm/streaming/stream_executor.go` | 125-126 | Change `interjectionBuffer mstream.InterjectionBuffer` + `streamRuntime *StreamRuntime` to `interjectionRouter InterjectionRouter` |
| `backend/internal/service/llm/streaming/tool_executor.go` | 210-272 | Replace `se.interjectionBuffer.DrainAndClear()` + `se.streamRuntime.SwitchStream()` with `se.interjectionRouter.BeginDrain()` / `CompleteDrain()` / `Rollback()` |
| `backend/internal/service/llm/streaming/completion_handler.go` | 98-165 | Same pattern as tool_executor.go |
| new file | — | Define `InterjectionRouter` interface matching design doc |

**Why before migration**: This is the **highest-leverage single refactoring**. The two interjection drain points (tool_executor.go:210-272, completion_handler.go:98-165) are the exact code that the InterjectionForwarder replaces. If we introduce the interface now with a thin adapter over the current `InterjectionBuffer` + `InterjectionRegistry`, the migration becomes: swap the adapter implementation for `InterjectionForwarder`. Without this, the migration must simultaneously introduce the interface, change all call sites, and implement the forwarder — a much larger, riskier diff.

**Implementation note**: The initial `InterjectionRouter` implementation wraps the existing `InterjectionRegistry` + `InterjectionBuffer`:
- `Route()` → `registry.GetOrCreate(turnID)` then `buffer.Append/Replace`
- `BeginDrain()` → `buffer.DrainAndClear()` (returns epoch=0, no real epoch fencing yet)
- `CompleteDrain()` → no-op (no pending buffer yet)
- `Rollback()` → no-op (no pending buffer yet)

This gives the interface its shape without implementing the forwarder logic. The forwarder implementation replaces this adapter during migration.

**Risk**: Medium. Changes call sites in two critical paths (interjection points A and B). Requires careful testing that interjection buffering and stream switching still work. The refactoring is behavior-preserving — same operations, behind an interface.

---

## R5: Extract `ActiveTurnHandle` Interface from `ExecutorRegistry`

**Problem**: `ExecutorRegistry` (deps.go:20-64) exposes `*StreamExecutor` directly:
- `Get(turnID) *StreamExecutor`
- `GetByThread(threadID) *StreamExecutor`

External consumers (interjection.go:19, cancel handler, spawn service) reach into `StreamExecutor` fields and methods directly. The design calls for `ActiveTurnHandle` (thread-ws.md §Service Layer Interfaces) that exposes only `RequestSoftCancel()`, `RequestHardCancel()`, `State()`, `ThreadID()`, `TurnID()`.

**What Changes**:

| File | Lines | Change |
|------|-------|--------|
| new file or `deps.go` | — | Define `ActiveTurnHandle` interface and `ActiveTurnRegistry` interface |
| `backend/internal/service/llm/streaming/deps.go` | 20-64 | `ExecutorRegistry` implements `ActiveTurnRegistry` with methods returning `ActiveTurnHandle` |
| `backend/internal/service/llm/streaming/stream_executor.go` | — | `StreamExecutor` implements `ActiveTurnHandle` (it already has these methods) |
| `backend/internal/service/llm/streaming/interjection.go` | 19 | Change `s.executorRegistry.Get()` to use `ActiveTurnRegistry` where appropriate |

**Why before migration**: The thread WS handler (thread-ws.md) depends on `ActiveTurnRegistry` for state queries and cancellation. Introducing the interface now means the handler can be written against it from the start. But this is lower priority than R4 because the handler is new code — it doesn't need to change existing call sites.

**Recommendation**: Do during Phase 1 of migration, not before. The interface is simple and the handler is new. Extract it when the first consumer needs it.

**Risk**: Low (when done). The interface is a subset of existing methods.

---

## R6: Extract `TurnStreamStarter` Interface from `StreamRuntime`

**Problem**: `StreamRuntime` (stream_runtime.go) is a concrete struct with `Launch()` and `SwitchStream()` methods. The design calls for a `TurnStreamStarter` interface (thread-ws.md §Service Layer Interfaces) with transport-neutral signatures — `SwitchResult` returns turn IDs instead of `StreamURL`.

Current `StreamSwitchResult` (stream_runtime.go:98-102) includes `StreamURL string` which is SSE-specific. The design's `SwitchResult` has no StreamURL — transport discovers streams via Registry.

**What Changes**:

| File | Lines | Change |
|------|-------|--------|
| `backend/internal/service/llm/streaming/stream_runtime.go` | 97-102 | Remove `StreamURL` from `StreamSwitchResult`; return typed turns instead of `any` |
| `backend/internal/service/llm/streaming/stream_runtime.go` | 220 | Remove `streamURL := fmt.Sprintf("/api/turns/%s/stream", ...)` from `Launch()` |
| `backend/internal/domain/llm/streaming_service.go` | 91, 107 | Remove `StreamURL` from `CreateTurnResponse` and `UpsertInterjectionResponse` |
| `backend/internal/service/llm/streaming/tool_executor.go` | 254-268 | Remove `result.StreamURL` from `EmitStreamSwitch` call |
| `backend/internal/service/llm/streaming/completion_handler.go` | 146-160 | Same |
| `backend/internal/service/llm/streaming/interjection.go` | 104 | Remove `StreamURL` from response |
| `backend/internal/service/llm/streaming/agui/events.go` | 148, 165 | Remove `StreamURL` from `StreamSwitchEvent` |
| Handler that returns StreamURL to frontend | — | Construct URL at the HTTP handler layer, not the service layer |

**Why before migration**: `StreamURL` is SSE-specific. The WS transport doesn't use URLs — clients subscribe via the WS protocol. If we leave `StreamURL` in the service layer, the migration must carry it as dead weight or do this extraction mid-migration. Removing it now makes the service layer transport-neutral, which is the prerequisite for both the `TurnStreamStarter` interface and clean WS handler implementation.

**Risk**: Medium. `StreamURL` is returned to the frontend in create-turn and interjection responses. The HTTP handler layer needs to construct the URL from the turn ID before returning. This requires a coordinated change across handler + frontend, but the URL construction is trivial (`/api/turns/{id}/stream`).

**Recommendation**: Do this before migration. It's a clean boundary cleanup that makes the service layer transport-neutral.

---

## R7: Remove `StateSize` TODO and Token Monitor Forward-Compat Field

**Problem**: Two pieces of dead/incomplete code add noise:

1. `collab_document_handler.go:243`: `StateSize: 0, // TODO(ws-stage-3): populate with encoded state size for bootstrap lane heuristics.` — hardcoded zero with a TODO referencing a stage that doesn't exist.

2. `token_monitor.go:62`: `capRegistry *capabilities.Registry // retained for forward-compat; currently unused directly` — field stored but never read. The comment says "forward-compat" but the monitor only uses `estimator`.

**What Changes**:

| File | Lines | Change |
|------|-------|--------|
| `backend/internal/handler/collab_document_handler.go` | 239-243 | Remove `StateSize` from the connected message. If it's needed later, add it then. |
| `backend/internal/service/llm/streaming/token_monitor.go` | 62, 67, 70 | Remove `capRegistry` field from `TokenMonitor` struct and constructor |

**Why before migration**: Minor noise reduction. The `StateSize` TODO references "ws-stage-3" which is the WS migration itself — the migration should add it properly if needed, not inherit a hardcoded zero. The `capRegistry` field causes confusion about whether `TokenMonitor` depends on capability data.

**Risk**: Very low. Pure deletion of unused code.

---

## R8: Consolidate SSE Event Rendering (Not Worth It)

**Problem**: SSE event formatting appears in three places:
1. `sse_handler.go:168-192` (catchup) and `sse_handler.go:227-244` (live) — identical formatting in the handler
2. `meridian-stream-go/handler.go:101-129` (`writeSSEEvent`) — in the mstream library

The entropy explorer flagged this as duplication between handler-level code and mstream.

**Assessment**: The SSE handler (`sse_handler.go`) and the entire `sse/` package are being **deleted** during migration (overview.md §What Gets Removed). The mstream `handler.go` / `StreamSSE` / nethttp adapter are also being removed (overview.md: "nethttp adapter from mstream"). There is no surviving consumer of SSE event rendering after migration.

**Recommendation: Skip.** Consolidating code that's about to be deleted wastes effort. The only value would be if the SSE handler needed to live alongside the WS handler during a transition period, but the design specifies "no SSE fallback, no v1 compat" (D21).

**Risk**: N/A (skip).

---

## R9: Loosen `StreamRuntime` ↔ `StreamExecutor` Coupling

**Problem**: `StreamRuntime.Launch()` (stream_runtime.go:127-227) creates a `StreamExecutor` with 22 positional constructor arguments:

```go
executor := NewStreamExecutor(
    input.AssistantTurn.ID,   // 1
    input.ThreadID,           // 2
    input.UserID,             // 3
    input.ProjectID,          // 4
    input.Model,              // 5
    input.Provider,           // 6
    r.executorDeps.TurnWriter,  // 7
    r.executorDeps.TurnReader,  // 8
    r.executorDeps.TurnNavigator, // 9
    llmProvider,              // 10
    input.ToolRegistry,       // 11
    r.executorDeps.MessageBuilder, // 12
    r.logger,                 // 13
    r.executorDeps.CreditAdmissionChecker, // 14
    r.executorDeps.CreditSettler,          // 15
    input.SettlementMode,     // 16
    toolRoundLimit,           // 17
    r.config.Server.Debug,    // 18
    r.executorDeps.TokenFinalizer, // 19
    r.executorDeps.JobQueue,       // 20
    r.config.LLM.SoftCancelTimeoutSeconds, // 21
    interjectionBuffer,       // 22
    r,                        // 23 (self-reference!)
)
```

This is a maintenance hazard — adding or reordering parameters is error-prone. The self-reference (`r` as `*StreamRuntime` passed to executor as `streamRuntime`) creates a circular dependency.

**What Changes**:

| File | Lines | Change |
|------|-------|--------|
| `backend/internal/service/llm/streaming/stream_executor.go` | constructor | Change `NewStreamExecutor` to accept a config struct (`StreamExecutorConfig`) instead of 22+ positional args |
| `backend/internal/service/llm/streaming/stream_runtime.go` | 154-178 | Build config struct and pass it |

**Why before migration**: The migration adds new fields to `StreamExecutor` (WS-aware notification hooks, interjection router instead of buffer). Every new field means another positional argument, making the constructor worse. Converting to a config struct now means the migration adds fields cleanly.

**Risk**: Low-medium. Mechanical refactoring of constructor signature. Requires updating all `NewStreamExecutor` call sites (only one: `Launch()`). Tests that create executors directly also need updating.

---

## R10: Make `SwitchStream` Atomic (DB Transaction Fix)

**Problem**: `SwitchStream` (stream_runtime.go:266-343) performs two separate DB operations:
1. `UpdateTurnStatus` (line 288) — marks current turn complete
2. `persistSwitchTurns` (line 296) — creates successor turns in a transaction

If step 1 succeeds but step 2 fails, the current turn is marked complete but no successor exists — the conversation is stuck. The design doc (interjection-forwarder.md §SwitchStream Atomicity Fix) calls for wrapping both in a single transaction with reversed order (create successor first, then update old turn with `successor_turn_id`).

**What Changes**:

| File | Lines | Change |
|------|-------|--------|
| `backend/internal/service/llm/streaming/stream_runtime.go` | 288-299 | Move `UpdateTurnStatus` inside `persistSwitchTurns`'s transaction, after successor creation. Add `successor_turn_id` to response_metadata. |

**Why before migration**: This is a correctness fix, not just structural cleanup. The race window exists today under any transport. The migration doesn't change SwitchStream's internals — it changes how interjections reach the drain points. Fixing atomicity before migration means the migration can focus on the transport layer without worrying about data integrity.

**Risk**: Low-medium. The fix is well-specified in the design doc with exact before/after code. Requires testing that the transaction rollback correctly restores state on successor creation failure.

---

## Priority Order

Ordered by leverage (impact on migration cleanliness ÷ effort):

| Priority | ID | Description | Effort | Impact |
|----------|----|-------------|--------|--------|
| **1** | R4 | Extract `InterjectionRouter` interface | Medium | **Critical** — unblocks clean forwarder implementation |
| **2** | R6 | Remove `StreamURL` from service layer | Medium | **High** — makes service layer transport-neutral |
| **3** | R10 | SwitchStream atomicity fix | Low-Medium | **High** — correctness fix that exists independent of migration |
| **4** | R1 | Consolidate auth into reusable primitives | Low | **Medium** — clean foundation for wsutil auth |
| **5** | R3 | Extract auth error code mapping | Very Low | **Medium** — prevents third copy during migration |
| **6** | R9 | StreamExecutor constructor → config struct | Low-Medium | **Medium** — reduces migration merge conflicts |
| **7** | R7 | Remove StateSize TODO + capRegistry field | Very Low | **Low** — noise reduction |
| — | R2 | Dead project WS command code | Skip | — (file being deleted) |
| — | R5 | `ActiveTurnHandle` interface | During migration | — (new consumer, introduce with consumer) |
| — | R8 | SSE event rendering consolidation | Skip | — (code being deleted) |

## Remaining Structural Debt (Not Addressed)

These were identified but are out of scope for pre-migration cleanup:

1. **Two WebSocket libraries**: Project WS uses `golang.org/x/net/websocket`, document WS uses `coder/websocket`. The design standardizes on `coder/websocket` via the wsutil framework. No pre-migration action needed — the old library usage dies when project WS is replaced.

2. **Heartbeat loop duplication**: `collab.go:runHeartbeatLoop` and `collab_document_handler.go:runDocumentHeartbeatLoop` implement similar logic against different WS libraries. The wsutil framework replaces both. No pre-migration action.

3. **Rate limiter divergence**: Message loop uses custom sliding window (`collabInboundRateTracker`), document handler uses `golang.org/x/time/rate`. The wsutil framework implements its own rate limiting. No pre-migration action.

4. **`ProjectConnectionRegistry` and `ProjectBroadcaster`**: Replaced by wsutil's built-in connection registry and `DocNotifier`. No pre-migration action.

5. **mstream library bugs (C1, H1-H7)**: The 7 bugs listed in thread-ws.md §mstream Library Fixes Required are implementation work for the migration, not pre-migration refactoring. They should be fixed in the mstream library as part of Phase 1 WS implementation.

6. **`ExecutorRegistry.GetByThread()` linear scan**: Acceptable for bounded active executor count. Not worth indexing pre-migration.

7. **`StreamSwitchResult.UserTurn` and `.AssistantTurn` typed as `any`** (stream_runtime.go:99-100): Should be `*domainllm.Turn`. Could be fixed during R6 when touching this struct.
