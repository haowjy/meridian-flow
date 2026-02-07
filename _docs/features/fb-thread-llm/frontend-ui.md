---
stack: frontend
status: complete
feature: "Thread Frontend UI"
---

# Thread Frontend UI

**Thread interface, message rendering, and user interactions.**

## Status: ✅ Complete

---

## Layout

**3-panel**: Thread list | Active thread | Document tree

**File**: `frontend/src/features/threads/components/ActiveThreadView.tsx`

---

## Message Rendering

**Block Renderer**: `frontend/src/features/threads/components/blocks/BlockRenderer.tsx`

**Block Components**:
- TextBlock - Streamdown markdown rendering
- ThinkingBlock - Collapsible `<details>` element
- ToolInteractionBlock - Tool use + result with expand/collapse

---

## User Controls

**Thread Input**: Enter to send, Shift+Enter for newline

**References / Context**:
- Desktop composer supports `@` mention picker and `+` dropdown selector for inline references.
- Mobile composer uses the same `+` dropdown selector flow as desktop.
- Editable composer pills are caret-first on edge click; clear interior single-click opens.
- Read-only turn viewer pills open on single click.
- Reference spacing is preserved from `ContentBlock[]` exactly; composer insertion adds one trailing separator only when needed.
- Copy/cut uses shared CM clipboard extension (`createMeridianClipboardExtension`) across:
  - chat input composer
  - chat bubble viewer
  - document wiki-link editor
- Meridian custom clipboard payload is v2 (`elements[]`), with v1 `references[]` parsing support.
- New inline element types plug in via codec registration (`ClipboardCodecRegistry`) without changing per-surface clipboard plumbing.
- Paste supports:
  - Meridian payload (chat -> chat, doc editor -> chat)
  - Plain wiki-link text (converts to pills when path resolves)
- Ambiguous filename-only wiki-links are kept as plaintext on paste (no silent wrong-doc binding).

**Model Selection**: Dropdown with provider grouping on desktop and mobile, default: Kimi K2 Thinking

**Reasoning Level**: Low/Medium/High dropdown with brain icon

**Web Search Toggle**: Globe icon, only enabled for Anthropic

**Stop Button**: Shows during streaming, cancels turn

---

## Turn Action Bar

**Features**: Sibling nav (prev/next arrows), turn counter (2/3), edit turn, regenerate

**File**: `frontend/src/features/threads/components/TurnActionBar.tsx`

---

## Thread List

**Features**: Scrollable list, active thread highlighting, new thread button (-> cold start), empty state

**File**: `frontend/src/features/threads/components/ThreadList.tsx`

---

## Cold Start

**UX**: When no thread is selected, shows input at bottom with welcome message.

**Atomic Creation**: Thread created with first message via `POST /api/turns` - no empty threads.

**File**: `frontend/src/features/threads/components/ActiveThreadView.tsx`

---

## Known Gaps

❌ **System prompt input** - No UI field (backend supports it)

---

## Related

- See [turn-branching.md](turn-branching.md) for navigation UX
- See [../fb-streaming/frontend-streaming.md](../fb-streaming/frontend-streaming.md) for streaming UI
