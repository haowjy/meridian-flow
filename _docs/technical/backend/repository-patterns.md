---
detail: minimal
audience: developer
---

# Repository Patterns

## Conditional Updates with Pointer Semantics

**Problem:** How to update some fields while keeping others unchanged?

**Solution:** Use `nil` pointer to mean "skip update", non-nil to mean "update to this value".

### Example: Turn Token Updates

```go
// Domain type with pointer fields for optional updates
type TurnCompletionUpdate struct {
    Model      *string  // nil = keep existing, non-nil = update
    StopReason *string  // nil = keep existing, "" = intentional clear
    ResponseMetadata map[string]interface{}  // nil = skip merge
}

// Caller has full control
update := &TurnCompletionUpdate{
    Model:      &"claude-3.5-sonnet",  // Update model
    StopReason: nil,                    // Keep existing stop_reason
    ResponseMetadata: nil,              // Skip metadata merge
}
```

### SQL Implementation

Use `COALESCE` to preserve existing values when parameter is NULL:

```sql
UPDATE turns
SET model = COALESCE($4, model),              -- NULL param = keep existing
    stop_reason = COALESCE($5, stop_reason),  -- NULL param = keep existing
    response_metadata = COALESCE(response_metadata, '{}'::jsonb)
                        || COALESCE($6::jsonb, '{}'::jsonb)  -- NULL = skip merge
WHERE id = $1
```

### Benefits

- **Explicit intent:** Caller controls exactly what updates
- **Backward compatible:** Easy to add new optional fields
- **Self-documenting:** `nil` vs non-nil is clear at call site
- **Type-safe:** Compiler enforces pointer semantics

### Implementation Reference

See `internal/repository/postgres/llm/turn.go:452` (AccumulateTokensAndUpdateMetadata) for full implementation.

**Call sites demonstrating three patterns:**
- Pattern A (full update): `mstream_adapter.go:1275` - all fields populated
- Pattern B (partial update): `mstream_adapter.go:1291` - StopReason=nil keeps existing
- Pattern C (no merge): `enrich_generation.go:293` - ResponseMetadata=nil skips merge

### Why Document This?

- **Reusable pattern:** Not token-specific, applicable to any conditional update
- **SOLID principles:** Demonstrates OCP (easy to extend) and ISP (clients specify only what they need)
- **Future reference:** Next developer adding optional fields has clear example

**Note:** This pattern is the result of the SOLID refactor for `AccumulateTokensAndUpdateMetadata`, addressing audit findings about extensibility and SRP violations.
