---
stack: backend
status: complete
feature: "Built-in Tools"
---

# Built-in Tools

**Three built-in tools: web_search, bash, text_editor.**

## Status: ✅ Definitions Complete, 🟡 Execution Varies

---

## web_search

**Status**: ✅ Server-side execution
**Provider**: Anthropic (built-in)
**Execution**: Provider executes, results in `web_search_result` blocks

---

## bash

**Status**: 🟡 Definition only
**Execution Side**: Client (frontend must execute)
**Backend**: Does NOT execute bash commands
**Result Handling**: Frontend sends `tool_result` blocks back

---

## text_editor

**Status**: 🟡 Definition only
**Execution Side**: Client (frontend must execute)
**Backend**: Does NOT perform file edits
**Result Handling**: Frontend sends `tool_result` blocks back

---

## Auto-Mapping

All three tools auto-map from minimal definitions:
- `{"name": "web_search"}` → Anthropic's `web_search_20250305`
- `{"name": "bash"}` → `bash_20250305`
- `{"name": "text_editor"}` → `text_editor_20250305`

---

## Related

- See [auto-mapping.md](auto-mapping.md) for mapping logic
- See [custom-tools.md](custom-tools.md) for server-executed tools
