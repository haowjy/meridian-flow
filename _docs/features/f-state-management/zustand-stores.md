---
stack: frontend
status: complete
feature: "Zustand Stores"
---

# Zustand Stores

**5 Zustand stores for state management.**

## Status: ✅ Complete

---

## Stores

**useProjectStore** (persist middleware)
- Selected project, project list
- `frontend/src/core/stores/useProjectStore.ts`

**useTreeStore** (no persist)
- Folder/document tree, expanded folders
- `frontend/src/core/stores/useTreeStore.ts`

**useChatStore** (persist, but turns excluded)
- Chat list, active chat, turns (not persisted)
- `frontend/src/core/stores/useChatStore.ts`

**useUIStore** (persist middleware)
- UI state (panel visibility, etc.)
- `frontend/src/core/stores/useUIStore.ts`

**useEditorStore** (no persist)
- Editor instances (LRU cache)
- `frontend/src/core/stores/useEditorStore.ts`

---

## Persistence

**LocalStorage** (via persist middleware):
- Projects, UI state, chat metadata

**Not Persisted**:
- Tree state, editor instances, turn data

---

## Related

- See [indexeddb-caching.md](indexeddb-caching.md) for long-term caching
