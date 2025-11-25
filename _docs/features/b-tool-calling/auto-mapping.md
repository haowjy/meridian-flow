---
stack: backend
status: complete
feature: "Tool Auto-Mapping"
---

# Tool Auto-Mapping

**Minimal definitions automatically map to provider-specific implementations.**

## Status: ✅ Complete

---

## How It Works

**Minimal Definition** (client sends):
```json
{"name": "tavily_web_search"}
```

**Mapped To** (sent to LLM):
```json
{
  "type": "function",
  "function": {
    "name": "web_search",
    "description": "Search the web for current information...",
    "parameters": {
      "query": {...},
      "max_results": {...},
      "topic": {...}
    }
  },
  "ExecutionSide": "server"  // Backend executes via Tavily
}
```

---

## Detection Logic

**File**: `backend/internal/domain/models/llm/tool_definition.go:ToLibraryTool()`

```
if tool has Function field:
    → Custom tool (pass through as-is)
elif tool has Name field:
    if isWebSearchVariant(Name):  // tavily_web_search, brave_web_search, etc.
        → Create custom web_search tool with ExecutionSide: Server
    else:
        → Auto-map to built-in via MapToolByName()
else:
    → Error (invalid tool definition)
```

---

## Supported Mappings

**Web Search** (backend-executed via external APIs):
- `tavily_web_search` → Custom `web_search` tool (Tavily)
- `brave_web_search` → Custom `web_search` tool (Brave, future)
- `serper_web_search` → Custom `web_search` tool (Serper, future)
- `exa_web_search` → Custom `web_search` tool (Exa, future)

**Editor Tools** (provider-specific, not implemented):
- `bash` or `code_exec` → `bash_20250305`
- `text_editor` or `file_edit` → `text_editor_20250305`

---

## Mixed Usage

**Can mix built-in and custom**:
```json
{
  "tools": [
    {"name": "tavily_web_search"},  // Auto-mapped to custom web_search
    {"type": "function", "function": {"name": "my_tool", ...}}  // Custom tool
  ]
}
```

---

## Related

- See [builtin-tools.md](builtin-tools.md) for tool details
- See [custom-tools.md](custom-tools.md) for custom tools
