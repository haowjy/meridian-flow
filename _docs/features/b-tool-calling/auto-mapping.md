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
{"name": "web_search"}
```

**Mapped To** (provider receives):
```json
{
  "type": "web_search_20250305",
  "name": "web_search",
  ...provider-specific fields...
}
```

---

## Detection Logic

**File**: `backend/internal/service/llm/adapters/conversion.go:convertTools()`

```
if tool.Type == "custom":
    → Pass through (user-provided custom tool)
elif tool has only Name:
    → Auto-map to built-in via MapToolByName()
else:
    → Pass through (already fully defined)
```

---

## Supported Mappings

- `web_search` or `search` → `web_search_20250305`
- `bash` or `code_exec` → `bash_20250305`
- `text_editor` or `file_edit` → `text_editor_20250305`

---

## Mixed Usage

**Can mix custom and minimal**:
```json
{
  "tools": [
    {"name": "web_search"},  // Auto-mapped
    {"type": "custom", "name": "my_tool", ...}  // Bypass
  ]
}
```

---

## Related

- See [builtin-tools.md](builtin-tools.md) for tool details
- See [custom-tools.md](custom-tools.md) for custom tools
