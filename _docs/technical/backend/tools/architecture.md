---
detail: standard
audience: developer | claude
---

# Tool System Architecture

## Overview

The tool system follows SOLID principles with clean separation of concerns:

**Core Components:**
- `ToolExecutor` interface - Single method: `Execute(ctx, input) (result, error)`
- `ToolRegistry` - Thread-safe tool registration and execution
- `ToolConfig` - Centralized configuration (replaces magic numbers)
- `PathResolver` - Shared folder path resolution logic
- `ToolRegistryBuilder` - Fluent API for building tool registries

**Tool Types:**
1. **Document Tools** (internal): `str_replace_based_edit_tool`, `doc_search`
2. **Web Search Tools** (external): `web_search` (requires API key)

## Adding New Tools

**Using the Builder (Recommended):**
```go
registry := tools.NewToolRegistryBuilder().
    WithDocumentTools(projectID, documentRepo, folderRepo).
    WithWebSearch(searchClient). // Optional
    Build()
```

**Creating Custom Tools:**
1. Implement `ToolExecutor` interface
2. Add to builder via new `With*()` method
3. Define schema in `tool_definition.go`

## External API Tools

- `external.SearchClient` interface - Provider abstraction
- `external.TavilyClient` - Tavily implementation
- Future: BraveClient, SerperClient, etc.

**Provider-Specific Tool Names:**

Frontend sends provider-specific tool name, Claude sees generic `web_search`:

```json
// Frontend specifies provider
{"tools": [{"name": "tavily_web_search"}]}
```

Backend resolves to `web_search` tool that Claude calls.

**Supported Providers:**
- `tavily_web_search` - Tavily AI (implemented)
- `brave_web_search` - Brave Search (future)
- `serper_web_search` - Serper.dev (future)
- `exa_web_search` - Exa AI (future)

**Configuration:**
```bash
SEARCH_API_KEY=tvly-your-key
SEARCH_API_PROVIDER=tavily
```

**Wiring** (request-based in streaming service):
- Frontend sends `tavily_web_search` in tools array
- If `SEARCH_API_KEY` is set, backend registers Tavily
- Logs include `web_search_enabled` and `web_search_provider` fields

## Tool Auto-Mapping

The backend automatically maps minimal tool definitions to provider-specific implementations.

**Minimal definition (auto-map to built-in):**
```json
{"tools": [{"name": "web_search"}, {"name": "bash"}, {"name": "text_editor"}]}
```
-> Library resolves to provider's built-in tools (e.g., Anthropic's `web_search_20250305`)

**Custom tool (bypass auto-mapping):**
```json
{"tools": [{"type": "custom", "name": "make_file", "description": "...", "input_schema": {...}}]}
```
-> Used as-is, no mapping

**Supported Built-in Tools:**
- `web_search` (or `search`) - Web search (server-executed)
- `text_editor` (or `file_edit`) - Text editor (client-executed)
- `bash` (or `code_exec`) - Bash command execution (client-executed)

**Detection Logic:**
```
if tool.Type == "custom" -> Pass through as-is
elif tool has only Name  -> Auto-map via MapToolByName()
else                     -> Pass through as-is (already fully defined)
```

**Implementation:** See `backend/internal/service/llm/adapters/conversion.go:convertTools()`

## SOLID Compliance

- **SRP** (9/10): PathResolver extracts duplicate logic
- **OCP** (8/10): Builder pattern allows extension without modification
- **LSP** (10/10): All tools are perfectly substitutable
- **ISP** (10/10): Minimal ToolExecutor interface
- **DIP** (9/10): External API abstraction added
