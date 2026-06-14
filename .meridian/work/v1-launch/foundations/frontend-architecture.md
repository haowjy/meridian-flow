# Frontend Architecture Principles

Architectural rules for all v1 frontend work. Clean separation between data, state, and presentation.

## Layers

```
core/                → shared infrastructure (API client, auth, CM6 extensions, theme)
features/<name>/     → feature modules (self-contained, own state + components + hooks)
shared/components/   → pure presentational components (no business logic, no data fetching)
shared/hooks/        → shared hooks (not feature-specific)
```

## Feature Module Structure

Each feature is a self-contained module:

```
features/threads/
├── components/          → React components (presentation + composition)
├── hooks/               → Feature-specific hooks (useThreadStore, useOptimisticSend)
├── stores/              → Zustand stores (state + actions)
├── services/            → API calls, sync logic, data transforms
├── types.ts             → Feature-local types
└── index.ts             → Public API (only export what other features need)
```

**Import rule:** Features import from other features only through their `index.ts` public API. Never reach into another feature's internals.

## State Architecture

### Zustand Stores — One Store Per Domain

Each domain gets exactly one store. Stores own state and actions. Components subscribe to stores.

```typescript
// ✅ Store owns business logic
const useThreadStore = create<ThreadState>((set, get) => ({
  threads: [],
  activeThreadId: null,

  sendMessage: async (content: string) => {
    const tempId = crypto.randomUUID()
    // Optimistic: render immediately
    set(state => ({ messages: [...state.messages, { id: tempId, content, status: 'pending' }] }))
    // Fire POST + Dexie write concurrently
    const [serverResult] = await Promise.all([
      threadService.sendMessage(content),
      dexie.threads.put({ id: tempId, content, status: 'pending' })
    ])
    // Reconcile
    set(state => ({
      messages: state.messages.map(m =>
        m.id === tempId ? { ...serverResult, status: 'confirmed' } : m
      )
    }))
  },
}))

// ❌ Component contains business logic
function ThreadInput() {
  const addMessage = useThreadStore(s => s.addMessage)
  const onClick = async () => {
    addMessage({ content, status: 'pending' })  // optimistic
    const result = await fetch('/api/messages', { ... })  // API call in component
    addMessage(result)  // reconcile in component
  }
}
```

### Optimistic Universal Flow

Every mutation follows the same pattern:

```
1. Update store state (triggers React render — immediate)
2. Fire concurrently:
   a. Dexie write (local persistence)
   b. POST to server (remote persistence)
3. Reconcile on server response (update store with authoritative data)
4. On failure: revert optimistic state, surface error via notification store
```

This flow lives in the **store's action**, not in components or hooks.

### Data Ownership

| Data | Store | Persistence | Authority |
|------|-------|-------------|-----------|
| Documents (content) | Y.Doc (Yjs) | y-indexeddb | Local-first |
| Documents (metadata) | `useDocumentStore` | Dexie | Server |
| Project tree | `useTreeStore` | Dexie | Server |
| Threads/Messages | `useThreadStore` | Dexie (cache only) | Server |
| UI state | `useUIStore` | localStorage | Local |
| Editor state | `useEditorStore` | Memory (LRU) | Local |

## Component Architecture

### Pure Presentation (shared/components/)

No data fetching, no store access, no side effects. Props in, JSX out.

```typescript
// ✅ Pure presentational
function Button({ variant, size, children, onClick }: ButtonProps) {
  return <button className={cn(variants[variant], sizes[size])} onClick={onClick}>{children}</button>
}

// ❌ Fetches data
function Button({ documentId }) {
  const doc = useDocumentStore(s => s.documents[documentId])  // store access in shared component
}
```

### Feature Components (features/<name>/components/)

Compose shared components with feature-specific state. This is where stores and hooks connect to UI.

```typescript
// ✅ Feature component wires store to presentation
function ThreadMessageList() {
  const messages = useThreadStore(s => s.messages)
  const activeThreadId = useThreadStore(s => s.activeThreadId)
  return <MessageList messages={messages} threadId={activeThreadId} />
}
```

### Hooks

- **Feature hooks** (`features/<name>/hooks/`) — encapsulate feature-specific logic (subscriptions, side effects, computed state)
- **Shared hooks** (`shared/hooks/`) — cross-cutting (useMediaQuery, useLocalStorage, useDebounce)

Hooks never import from `handler/` or `repository/` equivalents — they go through stores or services.

## Service Layer (features/<name>/services/)

API calls, WebSocket management, data transforms. Analogous to backend's repository layer.

```typescript
// ✅ Service handles API + data transform
export const threadService = {
  async sendMessage(threadId: string, content: string): Promise<Message> {
    const response = await api.post(`/threads/${threadId}/messages`, { content })
    return transformMessage(response.data)
  },

  subscribeToStream(threadId: string, onEvent: (event: StreamEvent) => void): () => void {
    const source = new EventSource(`/threads/${threadId}/stream`)
    source.onmessage = (e) => onEvent(JSON.parse(e.data))
    return () => source.close()
  },
}
```

Services are called by stores, not by components directly.

## Import Rules

```
shared/components/  → imports nothing from features/ or stores
shared/hooks/       → may import from shared/components/, never from features/
features/<name>/    → imports from shared/, core/, and other features' index.ts
core/               → imports nothing from features/ or shared/
```

Feature-to-feature imports go through the public API:

```typescript
// ✅ Import through public API
import { useTreeStore } from '@/features/explorer'

// ❌ Reach into internals
import { useTreeStore } from '@/features/explorer/stores/treeStore'
```

## CM6 Architecture

CodeMirror 6 extensions follow the same layering:

```
core/cm6/extensions/     → shared (theme, keybindings) — no feature imports
core/cm6/editor/         → editor-specific extensions (live preview, block rendering)
core/cm6/chat/           → chat-specific extensions (submit-on-enter, compact mode)
features/collab/cm6/     → collab decorations (hunk marks, review toolbar)
features/prose/cm6/      → prose analysis decorations
```

Each decoration producer is a separate `ViewPlugin` with an explicit layer number. Higher layers render on top.

## Testing

- **Shared components:** Storybook stories (visual) + unit tests (props → output)
- **Feature components:** Storybook with mock stores
- **Stores:** unit tests with mock services
- **Services:** unit tests with mock API responses
- **Integration:** Playwright for full user flows
