---
stack: backend
status: complete
feature: "System Prompts"
---

# System Prompts

**Hierarchical system prompt resolution.**

## Status: ✅ Backend Complete, ❌ Frontend UI Missing

---

## Backend Resolution Hierarchy

1. Request params `system`
2. Chat-specific `system_prompt`
3. Project-level `system_prompt`
4. Default: None

**File**: `backend/internal/service/llm/streaming/system_prompt_resolver.go`

**Storage**: `request_params.system` JSONB field

---

## Frontend

❌ **No UI** - No input field for system prompts

**Workaround**: Can set via project or chat creation (if API exposed)

---

## Related

- See [backend-architecture.md](backend-architecture.md) for schema
