---
stack: backend
status: complete
feature: "Chat Backend Architecture"
---

# Chat Backend Architecture

**Turn management, block types, and conversation tree structure.**

## Status: ✅ Complete

---

## Schema

**Tables**:
- `chats` - Chat metadata, system prompts, last_viewed_turn_id
- `turns` - Individual turns (user/assistant), tree structure via `prev_turn_id`
- `turn_blocks` - Content blocks (text, thinking, tool_use, etc.)

**Files**: `backend/migrations/00001_initial_schema.sql`

---

## Turn Management

**Tree Structure**: Each turn links to previous turn via `prev_turn_id`
- Allows branching conversations
- Multiple children possible (edit, regenerate create new branches)

**Turn Status**: `pending`, `streaming`, `complete`, `cancelled`, `error`

**Files**: `backend/internal/service/llm/conversation/`

---

## Block Types

**User**: text, image, reference, partial_reference, tool_result
**Assistant**: text, thinking, tool_use, web_search_use, web_search_result

**Storage**: JSONB with provider-specific data preservation

---

## API Endpoints

- `POST /api/chats/{id}/turns` - Create user turn + trigger LLM
- `POST /api/turns` - Create turn with atomic chat creation (cold start)
- `GET /api/chats/{id}/turns` - Paginated turn history
- `GET /api/turns/{id}/path` - Conversation path to root
- `GET /api/turns/{id}/siblings` - Sibling turns (branching)
- `GET /api/turns/{id}/blocks` - Completed blocks (reconnection)
- `POST /api/turns/{id}/interrupt` - Cancel streaming

---

## Related

- See [turn-branching.md](turn-branching.md) for navigation
- See `/_docs/technical/backend/chat/` for detailed docs
