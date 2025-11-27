---
stack: frontend
status: complete
feature: "Chat Frontend UI"
---

# Chat Frontend UI

**Chat interface, message rendering, and user interactions.**

## Status: ✅ Complete

---

## Layout

**3-panel**: Chat list | Active chat | Document tree

**File**: `frontend/src/features/chats/components/ActiveChatView.tsx`

---

## Message Rendering

**Block Renderer**: `frontend/src/features/chats/components/blocks/BlockRenderer.tsx`

**Block Components**:
- TextBlock - Streamdown markdown rendering
- ThinkingBlock - Collapsible `<details>` element
- ToolInteractionBlock - Tool use + result with expand/collapse

---

## User Controls

**Chat Input**: Enter to send, Shift+Enter for newline

**Model Selection**: Dropdown with provider grouping, default: Kimi K2 Thinking

**Reasoning Level**: Low/Medium/High dropdown with brain icon

**Web Search Toggle**: Globe icon, only enabled for Anthropic

**Stop Button**: Shows during streaming, cancels turn

---

## Turn Action Bar

**Features**: Sibling nav (prev/next arrows), turn counter (2/3), edit turn, regenerate

**File**: `frontend/src/features/chats/components/TurnActionBar.tsx`

---

## Chat List

**Features**: Scrollable list, active chat highlighting, new chat button (→ cold start), empty state

**File**: `frontend/src/features/chats/components/ChatList.tsx`

---

## Cold Start

**UX**: When no chat is selected, shows input at bottom with welcome message.

**Atomic Creation**: Chat created with first message via `POST /api/turns` - no empty chats.

**File**: `frontend/src/features/chats/components/ActiveChatView.tsx`

---

## Known Gaps

❌ **System prompt input** - No UI field (backend supports it)

---

## Related

- See [turn-branching.md](turn-branching.md) for navigation UX
- See [../fb-streaming/frontend-streaming.md](../fb-streaming/frontend-streaming.md) for streaming UI
