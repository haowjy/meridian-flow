---
stack: frontend
status: complete
feature: "TipTap Integration"
---

# TipTap Integration

**TipTap rich text editor with LRU caching for instant document switching.**

## Status:  Complete

---

## Implementation

**File**: `/Users/jimmyyao/gitrepos/meridian/frontend/src/features/documents/components/EditorPanel.tsx`

**Editor Hook**: `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/hooks/useEditorCache.ts`

**Extensions Config**: `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/editor/extensions.ts`

---

## LRU Cache

**Purpose**: Avoid expensive editor re-initialization when switching documents

**Capacity**: 5 editors cached

**Strategy**:
- Most recently used editors kept in memory
- Least recently used evicted when cache full
- Editor instance includes TipTap editor + all extensions

**Benefits**:
- Instant document switching (no load time)
- Preserves editor state (cursor position, selection)
- Reduces CPU usage

---

## Editor Configuration

**Extensions**:
- StarterKit (basic editing)
- Markdown (markdown parsing)
- CharacterCount (word/character count)
- Placeholder (empty state text)
- Highlight (text highlighting)
- Typography (smart quotes, dashes)
- Underline (underline formatting)

**Content Type**: Markdown (native)

---

## Document Loading

**Flow**:
1. Request document from cache/server
2. Check if editor exists in LRU cache
3. If cached: Restore editor, set content
4. If not cached: Create new editor instance
5. Load markdown content via `editor.commands.setContent(markdown, { contentType: 'markdown' })`

**Read-only during load**: Editor locked while fetching from server

---

## Performance Characteristics

**Cold start** (no cached editor):
- ~200-300ms to initialize TipTap + extensions
- Noticeable delay

**Warm start** (cached editor):
- ~10-20ms to restore from cache
- Instant from user perspective

---

## Memory Management

**LRU Eviction**:
- When 6th document opened, oldest editor destroyed
- Editor cleanup: `editor.destroy()`
- Garbage collection handles memory

**Typical Usage**: Users rarely have >5 documents open simultaneously

---

## Related

- See [rich-text-features.md](rich-text-features.md) for toolbar/extensions
- See [markdown-conversion.md](markdown-conversion.md) for content format
