# Future Optimizations

Potential performance and reliability improvements for post-MVP production hardening.

---

## 1. Parallel Tool Execution

**Current**: Tools execute after stream completes
```
LLM Stream → tool_use blocks → Stream completes → Execute tools → Stream results
```

**Optimized**: Execute tools immediately upon collection
```
LLM Stream → tool_use blocks → Execute in background ⎤
                                                       ⎬ → Stream completes → Stream results
Stream continues...                                   ⎦
```

**Impact**: Reduces total latency by overlapping tool execution with provider streaming.

**Location**: `backend/internal/service/llm/streaming/mstream_adapter.go:217-219` (TODO comment exists)

---

## 2. Context Cancellation Resilience

**Current**: Persist operations use parent context (may block on slow DB)
```go
// Even if ctx.Done(), we persist to avoid data loss
se.turnRepo.CreateTurnBlock(ctx, block)  // Uses parent context
```

**Issue**: If DB is slow + context cancelled → goroutine blocks indefinitely

**Solution**: Use separate timeout context for persistence
```go
persistCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
se.turnRepo.CreateTurnBlock(persistCtx, block)
```

**Location**: `backend/internal/service/llm/streaming/mstream_adapter.go:226-239`

---

## 3. Request Size Limits

**Risk**: Large inputs → memory exhaustion, slow parsing, DB bloat

**Solution**: Add middleware-level body size limit (10MB recommended for MVP)

**Priority**: Medium (low risk for family/friends, critical for public launch)

**Location**: `backend/cmd/server/main.go` (add middleware before handlers)

---

## 4. Formatter Registry Initialization Logging

**Current**: Silent no-op if `formatterRegistry == nil`
```go
if s.formatterRegistry == nil {
    return  // Hides initialization bugs
}
```

**Solution**: Log warning when registry is unexpectedly nil
```go
if s.formatterRegistry == nil {
    s.logger.Warn("formatter registry is nil, skipping tool result formatting")
    return
}
```

**Location**: `backend/internal/service/llm/streaming/service.go:472-478`

---

## Implementation Priority

1. **Pre-public launch**: Request size limits (#3)
2. **High value**: Parallel tool execution (#1) - significant latency reduction
3. **Production hardening**: Context resilience (#2), Registry logging (#4)
