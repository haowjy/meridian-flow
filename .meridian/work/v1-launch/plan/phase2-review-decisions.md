# Phase 2 Review Decisions

## Reviewer: p556 (gpt-5.4)

### Item 1: SpawnInvokerRef — APPROVED
No issues found. Callback pattern is clean, `WithSpawnTool` already handles nil invoker.

### Item 3: Shared Prompt Helpers — FIX APPLIED

**Finding (HIGH):** `buildConversationMessages` runs reference transformation inside the helper, but debug.go appends a hypothetical user message AFTER calling the helper. This means `@`-references in the debug request's `TurnBlocks` would not be transformed — diverging from the production flow where the user turn is persisted and included in the path before transformation.

**Decision:** Fix immediately. Split `buildConversationMessages` into:
- `loadConversationHistory(ctx, turnID)` — path + blocks + BuildMessages (no transformation)
- `transformMessageReferences(ctx, messages, userID, projectID)` — reference expansion
- `buildConversationMessages` — convenience wrapper that calls both

debug.go now uses the split helpers: load history → append hypothetical message → transform references. `startStreamingExecution` uses the convenience wrapper (unchanged behavior since user turn is in the path).

**Verification:** `go build ./...` and `go vet ./...` pass after fix.

## Round 2: SOLID Audit (p562) + Long-term Direction (p563)

### SOLID #1 (HIGH): SpawnInvokerRef is still post-construction mutation

Reviewer says the closure captures a nil variable that's assigned after construction — still temporal coupling.

**Decision: Accept as-is.** The circular dependency (SpawnService ↔ StreamingService) is structural. Pure constructor injection is impossible without restructuring service boundaries, which is Phase 3 territory. The old pattern (anonymous type assertion) was fragile and could silently fail. The new pattern (typed closure) is explicit, captured at the call site, and the builder already handles nil. The design doc explicitly calls this out as a local indirection. Phase 3's ToolRegistryFactory will absorb this.

### SOLID #2 (HIGH): prompt_helpers.go is not a coherent SRP unit

Reviewer says it mixes skill loading, turn-history, reference transformation, and tool-registry composition — all hanging off the god object.

**Decision: Accept as transitional.** The helpers are explicitly stepping stones for Phase 3. Each one maps to a planned collaborator:
- `loadAvailableSkills` → ToolRegistryFactory
- `loadConversationHistory` + `transformMessageReferences` → StreamRequestBuilder
- `buildTempToolRegistry` → ToolRegistryFactory

Splitting into 3+ files now would add churn that Phase 3 immediately reverses. The file is coherent as "extracted shared logic from god object, organized by future owner."

### SOLID #3 + Direction #1 (MEDIUM/HIGH): Tool-registry divergence

Both reviewers converge: temp registry (`buildTempToolRegistry`) and production registry (`buildProductionToolRegistry`) share builder setup but diverge. The next tool-policy change requires edits in both.

**Decision: Defer to Phase 3.** This is exactly what Phase 3's ToolRegistryFactory collaborator solves — one owner for common builder setup with prompt/execution variants. Introducing a half-baked ToolRegistryContext now creates a third abstraction that Phase 3 replaces. The current separation is honest about the divergence.

### Direction #2 (LOW): Stale comment in spawn_service.go

References `SetSpawnService` which no longer exists.

**Decision: Fix now.** Updated to reference `SpawnInvokerRef closure in StreamingDeps`.

### Direction positive: Conversation helpers are good Phase 3 seams

The long-term reviewer explicitly approved the conversation message extraction as a good precursor to StreamRequestBuilder.
