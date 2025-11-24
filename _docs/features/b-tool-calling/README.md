---
stack: backend
status: complete
feature: "Tool Calling"
---

# Tool Calling

**Tool calling system with auto-mapping and read-only document access.**

## Status: ✅ Complete (Backend Only)

---

## Features

**Auto-Mapping** - `{"name": "web_search"}` → provider-specific implementation
- See [auto-mapping.md](auto-mapping.md)

**Built-in Tools** - web_search (server), bash (client), text_editor (client)
- See [builtin-tools.md](builtin-tools.md)

**Custom Read-Only Tools** - doc_view, doc_tree, doc_search
- See [custom-tools.md](custom-tools.md)

**Tool Continuation** - Multi-turn tool use until `end_turn`
- See [continuation.md](continuation.md)

---

## Implementation

**Files**: `backend/internal/service/llm/tools/`, `backend/internal/service/llm/adapters/conversion.go`

---

## Known Gaps

❌ **Write tools** - No doc_create, doc_update, doc_delete
❌ **Extended chaining** - Basic continuation works, no advanced patterns

---

## Related

- See `/_docs/technical/backend/llm-integration.md` for tool architecture
