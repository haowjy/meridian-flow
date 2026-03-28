# Decision Log

Decisions made during v1-launch refactoring, with rationale. Organized by phase.

---

## Phase 1: Correctness + Quick Wins

### ParseUUID length guard (FIX)
**Context:** Reviewer found `uuid.Parse` accepts non-standard formats (urn:uuid:, braces, raw hex).
**Decision:** Added `len(value) != 36` guard. Practical risk was low (path params never use urn: format), but the fix was trivial and makes the contract explicit.

### UUID validation scoped to 3 handlers, not all (DEFER)
**Context:** Thread handlers still pass raw path IDs without UUID validation.
**Decision:** Deferred. Design spec intentionally scoped item 15 to context_budget, spawn, and work_item handlers. Thread handlers use a different resolution pattern. The `ParseUUID` helper is ready when we get there.

### Status filter not integration-tested (DEFER)
**Context:** Store tests only exercise the empty status path.
**Decision:** Deferred. SQL is mechanically correct (dynamic param numbering verified by reviewer). Integration tests need a running DB. Not blocking for a simple additive change.

### Slug methods not transactional (ACCEPT)
**Context:** Slug-based methods do GetBySlug then delegate to UUID-based mutation — two-step, not wrapped in a transaction.
**Decision:** Accepted. Same atomicity as the old handler flow. Slugs are immutable, so no wrong-row mutation risk.

### Write codec must preserve unknown frontmatter fields (FIX)
**Context:** Reviewer found `skillMDFrontmatter` write struct didn't include `Version`, so updating/reordering a skill would silently strip it.
**Decision:** Fixed. Added `Version *string` to struct. Created `parseSkillDocumentFull` (returns raw frontmatter + body) so update/reorder paths round-trip through the same struct. Principle: if the read path parses a field, the write path must preserve it.

### ISP narrowing complete (ACCEPT)
**Context:** Reviewer found no additional reader-only consumers of DocumentStore beyond the 5 narrowed.
**Decision:** Accepted. All reader-only consumers now use `DocumentReader`.

---

## Phase 2: Shared Foundations

### Debug reference transformation ordering (FIX)
**Context:** `buildConversationMessages` helper ran reference transformation inside the helper, but debug.go appends a hypothetical user message after calling the helper. This meant `@`-references in the debug request wouldn't be transformed — diverging from production where the user turn is part of the path.
**Decision:** Fixed by splitting into `loadConversationHistory` (no transformation) + `transformMessageReferences` (transformation only) + `buildConversationMessages` (convenience wrapper). Debug.go uses the split: load history -> append user message -> transform. Production uses the wrapper.

### SpawnInvokerRef is still post-construction mutation (ACCEPT)
**Context:** SOLID reviewer flagged that the closure captures a nil variable assigned after construction — still temporal coupling, not pure constructor injection.
**Decision:** Accepted. The circular dependency (SpawnService <-> StreamingService) is structural — pure constructor injection is impossible without restructuring service boundaries, which is Phase 3. The closure is strictly better than the old anonymous type assertion: it's typed, explicit, captured at the call site, and the builder already handles nil. Phase 3's ToolRegistryFactory will absorb this.
**Why not fix now:** Eliminating the temporal coupling requires extracting tool registration from the streaming service, which is the ToolRegistryFactory collaborator — that's Phase 3 work.

### prompt_helpers.go mixes concerns (ACCEPT AS TRANSITIONAL)
**Context:** SOLID reviewer flagged that the file mixes skill loading, turn-history hydration, reference transformation, and tool-registry composition — all hanging off the god object.
**Decision:** Accepted as transitional. Each helper maps 1:1 to a planned Phase 3 collaborator:
- `loadAvailableSkills` -> ToolRegistryFactory
- `loadConversationHistory` + `transformMessageReferences` -> StreamRequestBuilder
- `buildTempToolRegistry` -> ToolRegistryFactory

**Why not split now:** Creating 3 files for 5 helpers that Phase 3 immediately moves to different collaborators adds churn without value. The file is coherent as "extracted shared logic, organized by future owner."

### Temp vs production tool registry still diverge (DEFER TO PHASE 3)
**Context:** Both reviewers (SOLID + direction) converged on this: `buildTempToolRegistry` and `buildProductionToolRegistry` share builder setup but diverge in extras (spawn tool, web search). Next tool-policy change requires edits in both.
**Decision:** Deferred to Phase 3. This is exactly what the ToolRegistryFactory collaborator solves — one owner for common builder setup with prompt/execution variants on top.
**Why not fix now:** Introducing a `ToolRegistryContext` abstraction now creates a third thing (alongside the two builder paths) that Phase 3 replaces. The current separation is honest about the divergence without adding indirection.

### Conversation helpers are good Phase 3 seams (POSITIVE)
**Context:** Long-term direction reviewer explicitly approved `loadConversationHistory` + `transformMessageReferences` as clean precursors to `StreamRequestBuilder`.
**Decision:** Confirmed. These decompose cleanly into the planned collaborator.

### Stale comment references removed method (FIX)
**Context:** `spawn_service.go` comment referenced `SetSpawnService` which was removed by Item 1.
**Decision:** Fixed. Updated to reference `SpawnInvokerRef closure in StreamingDeps`.
