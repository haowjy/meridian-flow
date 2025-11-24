---
stack: both
status: complete
feature: "Chat/LLM System"
---

# Chat/LLM System

**Multi-turn chat with branching conversations and multiple LLM providers.**

## Status: ✅ Complete (Backend + Frontend)

---

## Features Overview

### Backend
- Turn management (branching tree structure)
- Block types (text, thinking, tool_use, tool_result)
- 3 providers working: Anthropic, OpenRouter, Lorem (mock)
- Token tracking, system prompts
- See [backend-architecture.md](backend-architecture.md)

### Frontend
- Chat interface (3-panel layout)
- Message rendering (text, thinking, tools with markdown)
- Turn branching/navigation (sibling arrows, edit, regenerate)
- Model selection, reasoning levels, web search toggle
- See [frontend-ui.md](frontend-ui.md)

---

## Key Capabilities

**Turn Branching** - Tree structure, sibling navigation
- See [turn-branching.md](turn-branching.md)

**Providers** - Anthropic (Claude), OpenRouter (multi-provider), Lorem (testing)
- See [providers.md](providers.md)

**Model Capabilities** - YAML-based registry
- See [model-capabilities.md](model-capabilities.md)

**System Prompts** - Hierarchy: Request → Chat → Project → None
- See [system-prompts.md](system-prompts.md)

---

## Known Gaps

❌ **System prompt UI** - Backend supports, no frontend input field
❌ **OpenAI/Gemini providers** - Code stubs only, not implemented
❌ **Collaborative editing** - Single-user only

---

## Files

**Backend**: `backend/internal/{handler,service,repository}/*/llm/`
**Frontend**: `frontend/src/features/chats/`

---

## Related

- See [../fb-streaming/](../fb-streaming/) for SSE implementation
- See [../b-tool-calling/](../b-tool-calling/) for tool integration
