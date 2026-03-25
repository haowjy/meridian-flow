# Base Refactors

Prerequisites that must land before feature work begins. These change existing code structure to create extension points that multiple features depend on.

## Why These Come First

The current `CreateTurn` (929 lines) and `systemPromptResolver` (224 lines) have no extension points for personas, work items, or context management. Every Layer 1+ feature needs to hook into these two files. Refactoring them first avoids N parallel branches all conflicting in the same functions.

## R1: Cold-Start Reorder

**Problem**: Currently, system prompt is resolved BEFORE the thread is created on cold start. This means:
- No thread ID available for context variable injection (`$MERIDIAN_THREAD_ID`)
- No work item can be attached before prompt building
- Tool registry is built twice (once with empty project context, once with real context)

**Current flow** (turn_creation.go):
```
1. resolveThreadContext()          — determines if cold start
2. Build temp tool registry        — for system prompt section
3. resolveSystemPromptForParams()  — threadID="" on cold start
4. ExecTx: create thread + turns   — thread exists NOW
5. Build real tool registry        — with thread.ProjectID
```

**Target flow**:
```
1. resolveThreadContext()          — determines if cold start
2. ExecTx: create thread (if cold start)  — thread exists NOW
3. Resolve work context (work item, env vars)
4. Build tool registry             — once, with full context
5. Resolve system prompt           — with threadID, persona, work context
6. Create turns in same or next tx
```

**Files changed**:
- `streaming/turn_creation.go` — restructure `CreateTurn`

**Risk**: CRITICAL. This is the core entry point. Must preserve all existing behavior.

**Verification**: All existing streaming tests pass. Debug endpoint produces identical provider requests for same inputs.

## R2: System Prompt Extension Points

**Problem**: `systemPromptResolver.Resolve()` has a fixed 5-part concatenation with no way to inject persona body, work context, or other future sections without modifying the function each time.

**Current signature**:
```go
func (r *systemPromptResolver) Resolve(
    ctx context.Context,
    threadID string,
    projectID string,
    userID string,
    userSystem *string,
    selectedSkills []string,
    toolSection string,
) (*string, error)
```

**Target**: Accept a `PromptContext` struct that carries all optional sections:

```go
type PromptContext struct {
    ThreadID       string
    ProjectID      string
    UserID         string
    UserSystem     *string
    SelectedSkills []string
    ToolSection    string
    // New extension points:
    PersonaBody    *string          // nil = no persona; pre-rendered markdown body (avoids domain/llm → domain/agents coupling)
    PersonaModel   *string          // nil = no model override
    WorkContext    *WorkContext      // nil = no work item
}

type WorkContext struct {
    WorkDir    string // ".meridian/work/<slug>/"
    FSDir      string // ".meridian/fs/"
    ThreadID   string
    WorkItem   string // slug
}
```

**Prompt composition order** (7 positions, stable for cache — canonical source, also in streaming-integration.md):
1. Base identity (stable)
2. Tool section (stable per tool set)
3. Work session context (stable per work item)
4. Project system prompt (stable per project)
5. Thread system prompt (stable per thread)
6. Skills content (stable per persona)
7. Persona body (changes on switch — last position minimizes cache miss)

Note: "user-provided system prompt" from the existing API's `request_params.system` is folded into position 5 (thread system prompt). The existing code treats it as an override — for v1, it maps to the thread-level prompt slot.

**Files changed**:
- `domain/llm/system_prompt.go` — interface change
- `streaming/system_prompt_resolver.go` — implementation
- `streaming/turn_creation.go` — caller update

**Risk**: MEDIUM. Interface change requires updating all callers.

## R3: Token Counting Library API

**Problem**: Token counting currently only works for interrupted streams (output tokens). There's no way to:
- Estimate tokens for a full request BEFORE sending it (dry-run)
- Count tokens in the system prompt + message history
- Compare current usage to the model's context window
- Know when to trigger autocollapse/autocompact

**Current state**:
- `TokenCounter` interface exists but only does `CountOutputTokens`
- `CapabilityRegistry` has `ContextWindow` and `MaxOutput` per model
- No input token counting
- No dry-run estimation

**What's needed** (new package or extension to existing):

```go
// In meridian-llm-go or backend token package

type TokenEstimate struct {
    SystemTokens   int
    MessageTokens  int
    ToolTokens     int
    TotalInput     int
    ContextWindow  int
    RemainingInput int  // ContextWindow - TotalInput - MaxOutput
    UsagePercent   float64
}

type TokenEstimator interface {
    // EstimateRequest estimates token usage for a request without sending it.
    // Uses provider-specific counting APIs where available (Anthropic count_tokens),
    // falls back to tiktoken-based estimation for others.
    EstimateRequest(ctx context.Context, req EstimateRequest) (*TokenEstimate, error)

    // EstimateText estimates tokens for a raw text string.
    EstimateText(ctx context.Context, model string, text string) (int, error)

    SupportsModel(model string) bool
}
```

**Provider-specific approaches**:

| Provider | Token counting method | Accuracy |
|----------|----------------------|----------|
| Anthropic | `POST /v1/messages/count_tokens` API | Exact |
| OpenRouter | No counting API; use tiktoken-go with cl100k_base | Approximate (~5% variance) |
| Any | Fallback: character-based heuristic (chars/4) | Rough |

**Why this is a base refactor**: Context management (autocollapse/autocompact) needs token estimation to know when to trigger. Billing needs it for pre-action cost estimates. The persona system needs it to warn when a persona's system prompt is too large.

**Files**:
- `backend/internal/service/llm/tokens/estimator.go` — new interface + registry
- `backend/internal/service/llm/tokens/anthropic_estimator.go` — Anthropic count_tokens API
- `backend/internal/service/llm/tokens/tiktoken_estimator.go` — tiktoken-go fallback
- `meridian-llm-go` — may need provider-level `CountTokens` method on the Provider interface

**Risk**: MEDIUM. New capability, but no existing code changes. The provider API integration needs careful error handling (rate limits on counting endpoint).

## Execution Order

```
R3 (token counting) — independent, start immediately
R2 (prompt extension) — independent, start immediately
R1 (cold-start reorder) — most complex, start immediately but takes longest

All three are independent of each other and can run in parallel.
Layer 1 features can start once R1 + R2 land (A3, A4 don't need R3).
Token budget tracking (Layer 1) needs R3.
```

## What NOT To Refactor

- `StreamingDeps` 30+ deps — ugly but functional, not blocking any feature. Refactor post-v1.
- `stream_executor.go` tool loop — adding spawn tool is additive, doesn't need restructuring.
- Billing settlement — already done, works, don't touch.
