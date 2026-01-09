---
stack: backend
status: complete
feature: "Tool Continuation"
---

# Tool Continuation

**Multi-turn tool use until `end_turn` stop reason.**

## Status: ✅ Complete

---

## How It Works

**Flow**:
1. LLM returns tool_use blocks + `stop_reason: "tool_use"`
2. Backend executes backend-side tools (doc_search, web_search via Tavily)
3. Backend creates follow-up assistant turn with tool results
4. Sends to LLM again
5. Repeat until `stop_reason: "end_turn"`

**File**: `backend/internal/service/llm/streaming/mstream_adapter.go:272`
**Check**: `block.IsBackendSideTool()` determines which tools to execute

---

## Examples

**Example 1: Document Search**
**Turn 1** (user): "Search for dragons in my docs"
**Turn 2** (assistant): `[tool_use: doc_search(query="dragons")]` + `stop_reason: "tool_use"`
**Backend**: Executes doc_search
**Turn 3** (assistant): `[tool_result: {...}]` sent to LLM
**Turn 4** (assistant): "I found 3 documents about dragons..." + `stop_reason: "end_turn"`

**Example 2: Web Search (Tavily)**
**Turn 1** (user): "What's the latest AI news?"
**Turn 2** (assistant): `[tool_use: web_search(query="latest AI news", topic="news")]` + `stop_reason: "tool_use"`
**Backend**: Executes Tavily search
**Turn 3** (assistant): `[tool_result: {...}]` sent to LLM
**Turn 4** (assistant): "Recent AI developments include..." + `stop_reason: "end_turn"`

---

## Related

- See [custom-tools.md](custom-tools.md) for tool implementations
- See `/_docs/technical/backend/llm-integration.md` for architecture
