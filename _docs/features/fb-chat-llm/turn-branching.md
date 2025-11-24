---
stack: both
status: complete
feature: "Turn Branching"
---

# Turn Branching

**Conversation tree structure with sibling navigation.**

## Status: ✅ Complete

---

## Backend

**Tree Structure**: `turns.prev_turn_id` references parent turn

**Sibling Query**: `GET /api/turns/{id}/siblings` - Returns all turns with same `prev_turn_id`

**Path Query**: `GET /api/turns/{id}/path` - Returns conversation path from turn to root

**Files**: `backend/internal/service/llm/conversation/`

---

## Frontend

**Navigation UI**: Prev/next arrows in TurnActionBar

**Turn Counter**: Shows "2/3" (current/total siblings)

**Edit Turn**: Creates new branch at that point

**Regenerate**: Creates sibling turn (new response to same input)

**Server-Driven Pagination**: Backend provides `siblingIds` array

**Files**: `frontend/src/features/chats/components/TurnActionBar.tsx`

---

## Related

- See [backend-architecture.md](backend-architecture.md) for schema
- See [frontend-ui.md](frontend-ui.md) for UI implementation
