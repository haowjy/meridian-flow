# Frontend Patterns

This document describes architectural patterns used in the Meridian frontend. Following these patterns ensures consistency and makes the codebase easier to understand for new contributors.

## Layer Structure

```
frontend/src/
├── core/           # Reusable infrastructure (NEVER imports from features/)
│   ├── components/ # Infrastructure components (SyncProvider)
│   ├── editor/     # CodeMirror 6 editor infrastructure
│   ├── hooks/      # Shared hooks (useAbortController, useDebounce)
│   ├── lib/        # Core utilities (api, cache, db, errors, sync)
│   ├── services/   # UI-free orchestration (documentSyncService)
│   ├── stores/     # Zustand stores
│   ├── supabase/   # Supabase client
│   └── theme/      # Theme system
├── features/       # Feature modules (can import from core/)
│   ├── auth/
│   ├── chats/
│   ├── documents/
│   ├── folders/
│   ├── projects/
│   └── workspace/
├── shared/         # Reusable UI components (layout, ui primitives)
└── types/          # Shared TypeScript types (DTOs, api types)
```

### Import Rules

```
core/ → NEVER imports from features/
features/ → can import from core/, shared/, types/
shared/ → can import from core/, types/
```

**Why**: Keeps `core/` as truly reusable infrastructure that can be used by any feature.

## State Management

### Zustand Stores

All stores use Zustand with these conventions:

```typescript
// Good: Explicit loading flags + race guards
const useExampleStore = create<ExampleStore>()((set, get) => ({
  data: null,
  isLoading: false,
  error: null,
  _activeId: null,  // Sentinel for race condition prevention

  loadData: async (id: string, signal?: AbortSignal) => {
    set({ _activeId: id, isLoading: true, error: null })

    try {
      const data = await api.fetch(id, { signal })

      // Guard against stale response
      if (get()._activeId !== id) return

      set({ data, isLoading: false })
    } catch (error) {
      if (isAbortError(error)) return  // Silent abort
      set({ error: getErrorMessage(error), isLoading: false })
    }
  }
}))
```

### Key Patterns

1. **Intent flags** (`_activeId`): Prevent stale responses from applying
2. **Module-level AbortControllers**: Cancel previous requests on new load
3. **Persist middleware**: For small UI state that should survive refresh
4. **`useShallow()`**: Prevent unnecessary re-renders

## Data Fetching

### Three Caching Strategies

| Strategy | Use Case | Example |
|----------|----------|---------|
| **Cache-First** | User edits are source of truth | Documents |
| **Network-First** | Server is source of truth | Chats, Projects |
| **Windowed** | Prevent unbounded growth | Messages (100 items) |

See `frontend/CLAUDE.md` for detailed implementation.

## CodeMirror 6 Patterns

### Extension Organization

```
core/editor/codemirror/
├── CodeMirrorEditor.tsx  # Main component
├── extensions/           # General extensions
├── commands/             # Formatting commands
├── livePreview/          # Obsidian-style preview
├── diffView/             # AI diff visualization
│   ├── index.ts          # Public API, extension bundling
│   ├── plugin.ts         # ViewPlugin for decorations
│   ├── transactions.ts   # Accept/reject operations
│   ├── focus.ts          # StateField + StateEffect
│   └── ...               # Other modules
└── keyHandlers/          # Custom key bindings
```

### Extension Bundling

Extensions are bundled in `index.ts` with ordered initialization:

```typescript
export function createDiffViewExtension(): Extension {
  return [
    hunkRegionsField,      // Must be first (live preview reads)
    focusedHunkIndexField, // Must be before plugin (plugin reads)
    diffViewPlugin,
    diffEditFilter,
    clipboardExtension,
    hunkHoverPlugin,
  ]
}
```

### StateField + StateEffect Pattern

For syncing React state with CM6:

```typescript
// Define effect
export const setFocusedHunkIndexEffect = StateEffect.define<number>()

// Define field
export const focusedHunkIndexField = StateField.define<number>({
  create: () => 0,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFocusedHunkIndexEffect)) {
        return effect.value
      }
    }
    return value
  },
})

// In React component
useEffect(() => {
  view.dispatch({
    effects: setFocusedHunkIndexEffect.of(focusedHunkIndex),
  })
}, [focusedHunkIndex])
```

### Interface Segregation (ISP)

Editor ref uses segregated interfaces:

```typescript
interface EditorRef {
  getContent(): string
  setContent(content: string, options?: SetContentOptions): void
  focus(): void
}

interface FormattingRef {
  toggleBold(): void
  toggleItalic(): void
  toggleHeading(level: 1 | 2 | 3): void
}

// Combined for components that need everything
interface CodeMirrorEditorRef extends EditorRef, FormattingRef, ListRef, ... {}
```

## Error Handling

### AppError Class

```typescript
class AppError<TResource = unknown> extends Error {
  constructor(
    public type: ErrorType,
    public message: string,
    public originalError?: Error,
    public resource?: TResource,  // For 409 conflicts
    public fieldErrors?: FieldError[]
  )
}
```

### Error Types

| Type | HTTP Status | Behavior |
|------|-------------|----------|
| `Network` | 5xx, timeout | Automatic retry |
| `Validation` | 400 | Show field errors |
| `NotFound` | 404 | Navigate away |
| `Unauthorized` | 401 | Redirect to login |
| `Conflict` | 409 | Include conflicting resource |

### Error Handling Flow

```typescript
try {
  await api.documents.get(id)
} catch (error) {
  if (isAbortError(error)) return  // Silent
  if (isNetworkError(error)) {
    // Automatic retry (3 attempts, jittered backoff)
  }
  handleApiError(error, 'Fallback message')  // Toast notification
}
```

## Component Patterns

### Container/Presenter Split

**Container** (smart): Accesses stores, coordinates data loading
**Presenter** (dumb): Pure functional, receives props, testable

### Callback Ref Pattern

For scroll containers that need to trigger effects:

```typescript
const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null)
return <div ref={setScrollContainer}>...</div>
```

**Why**: `useState` triggers re-render on element assignment (unlike `useRef`).

## Hook Conventions

### Naming

| Pattern | Use Case |
|---------|----------|
| `use{Feature}Lifecycle` | Mount/unmount/refresh logic |
| `use{Feature}Config` | Dynamic configuration |
| `use{Feature}Navigation` | Focus/selection state |

### Core Hooks

- `useAbortController(deps)` - Auto-abort on unmount or dependency change
- `useDebounce(value, delay)` - Debounce value changes
- `useLatestRef(value)` - Keep ref to latest value for closures
- `useOnlineStatus()` - Track browser online/offline

## Race Condition Prevention

### Pattern 1: Intent Flag

```typescript
set({ _activeDocumentId: documentId, isLoading: true })

// After async operation:
if (get()._activeDocumentId !== documentId) return  // Guard
```

### Pattern 2: AbortController at Module Level

```typescript
let loadController: AbortController | null = null

loadProjects: async () => {
  if (loadController) loadController.abort()
  loadController = new AbortController()
  // ...
}
```

### Pattern 3: Synchronous State Before Async

```typescript
cancelRetry(id)  // Sync: cancel pending
await db.update(...)  // Async: IndexedDB
await api.update(...)  // Async: API
```

## Type Conventions

### DTO Conversion

Backend returns snake_case, frontend uses camelCase:

```typescript
// API types (types/api.ts)
interface DocumentDto {
  ai_version?: string | null
  ai_version_rev?: number
}

// Domain types (features/documents/types/)
interface Document {
  aiVersion: string | null
  aiVersionRev: number
}

// Mapper (types/api.ts)
function fromDocumentDto(dto: DocumentDto): Document {
  return {
    aiVersion: dto.ai_version ?? null,
    aiVersionRev: dto.ai_version_rev,
  }
}
```

### Empty Content Handling

```typescript
// GOOD: Check for absence, not falsy
if (content !== undefined) { ... }

// BAD: Fails for empty strings
if (content) { ... }
```

## Future Improvements

### Hook Extraction from EditorPanel

EditorPanel (~650 LOC) handles multiple concerns. Future refactoring should extract:

1. `useDocumentContent` - Content loading, local state, dirty tracking
2. `useEditorSync` - Sync with server, retry, conflict handling
3. `useDiffView` - Compartment config, hunk navigation

These hooks could be reused for:
- Comment annotations (user/AI comments without direct doc modification)
- Preview editor boxes (like VSCode's "jump to definition")
