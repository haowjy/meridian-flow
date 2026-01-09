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

**Status**: ✅ Backend-side execution (Tavily)
**Provider**: Tavily AI (via backend)
**Execution**: Backend executes Tavily API, results in `tool_result` blocks
**Parameters**:
- `query` (required) - Search query string
- `max_results` (optional) - Max results (default: 5, max: 10)
- `topic` (optional) - Search category: "general" (default), "news", "finance"

**Provider Variants**:
- `tavily_web_search` - Tavily AI (implemented)
- `brave_web_search` - Brave Search (future)
- `serper_web_search` - Serper.dev (future)
- `exa_web_search` - Exa AI (future)

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

Built-in tools auto-map from minimal definitions:
- `{"name": "tavily_web_search"}` → Custom `web_search` tool with `ExecutionSide: Server`
- `{"name": "bash"}` → `bash_20250305` (provider-specific)
- `{"name": "text_editor"}` → `text_editor_20250305` (provider-specific)

---

## Related

- See [auto-mapping.md](auto-mapping.md) for mapping logic
- See [custom-tools.md](custom-tools.md) for server-executed tools
