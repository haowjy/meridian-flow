---
stack: both
status: complete
feature: "Thread/LLM System"
---

# Thread/LLM System

**Multi-turn thread with branching conversations and multiple LLM providers.**

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
- Thread interface (3-panel layout)
- Message rendering (text, thinking, tools with markdown)
- Turn branching/navigation (sibling arrows, edit, regenerate)
- Model selection, reasoning levels, web search toggle
- Proposal review handoff to editor supports chunk-level edit-before-accept in unified diff mode
- See [frontend-ui.md](frontend-ui.md)

---

## Key Capabilities

**Turn Branching** - Tree structure, sibling navigation
- See [turn-branching.md](turn-branching.md)

**Providers** - Anthropic (Claude), OpenRouter (multi-provider), Lorem (testing)
- See [providers.md](providers.md)

**Model Capabilities** - YAML-based registry
- See [model-capabilities.md](model-capabilities.md)

**System Prompts** - Hierarchy: Request -> Thread -> Project -> None
- See [system-prompts.md](system-prompts.md)

---

## Known Gaps

❌ **System prompt UI** - Backend supports, no frontend input field
❌ **OpenAI/Gemini providers** - Code stubs only, not implemented
❌ **Collaborative editing** - Single-user only

---

## Files

**Backend**: `backend/internal/{handler,service,repository}/*/llm/`
**Frontend**: `frontend/src/features/threads/`

---

## Related

- See [../fb-streaming/](../fb-streaming/) for SSE implementation
- See [../fb-tool-calling/](../fb-tool-calling/) for tool integration
