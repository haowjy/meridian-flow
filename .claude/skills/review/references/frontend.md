# Frontend Patterns (React + Zustand)

Common patterns LLMs get wrong in this codebase. Check every frontend diff against these.

## Show Content First, Not Spinners

**Why**: This is a writing app. Writers open it to *write*, not to watch spinners. Every loading spinner is a moment where the writer loses focus. The product philosophy is "writer-first" — the UI should feel like opening a notebook, not loading a web app. Cached content from IndexedDB/Zustand is available in milliseconds; blocking on a network round-trip to show a spinner wastes that advantage.

**The pattern**:
- If cached/stale data exists, show it immediately — refresh in the background
- For brief transitions (document switches, tab changes), use a blank placeholder — not a spinner. Spinners for sub-200ms waits create visual noise
- Only show a loading indicator when there is genuinely no data and the wait will be noticeable
- An empty editor is better than a loading spinner for an empty document

`hasData ? <Content /> : isInitialLoad ? <Skeleton /> : <EmptyState />`

## Async Operations Must Be Cancellation-Safe

**Why**: Writers navigate fast — switching between documents, threads, and branches in rapid succession. Every async operation (fetch, WebSocket sync, IndexedDB read) can complete *after* the user has already moved on. Without staleness guards, stale responses overwrite the new context: the wrong document appears, the wrong thread's turns render, loading flags get stuck permanently. We've had bugs where a slow fetch from document A overwrote document B's editor content, and where an aborted request left `isLoading: true` forever, blocking the entire UI.

**The pattern**:
1. **Staleness**: verify the request is still relevant before writing (user may have navigated away)
2. **Abort**: handle AbortError gracefully (silent return, not unhandled rejection)
3. **Cleanup in ALL paths**: success, error, AND abort paths must clean up loading flags

When merging async results into existing state, use functional updates (`set((current) => ...)`) — never merge against a pre-await snapshot, which drops concurrent updates (e.g., streaming deltas that arrived while a paginate was in flight).

## Empty, Null, and Undefined Are Three Different Things

**Why**: JavaScript has no built-in way to distinguish these — and LLMs collapse them constantly. But they mean different things in this app:
- `undefined` = field was **never set** (omitted from response, not loaded yet)
- `null` = field was **explicitly cleared** (user set system prompt to null, document moved to root)
- `""` = field has a **valid empty value** (new empty document, cleared text field)

A writer creates a new document — it has content `""`. That's a real document they're about to type in, not missing state. If code checks `if (!content)` it treats that empty document as absent, triggering loading states, skipping saves, or dropping streaming deltas. JavaScript's falsy coercion (`""`, `0`, `false`, `null`, `undefined` all falsy) makes this easy to get wrong — the language doesn't distinguish "empty" from "absent" unless you're explicit.

The backend uses `optional.Optional[T]` for tri-state PATCH semantics. The frontend controls this via JSON serialization — `JSON.stringify` omits `undefined` fields and keeps `null` fields:

```typescript
JSON.stringify({ a: undefined, b: null, c: "" })
// → '{"b":null,"c":""}'
// a is omitted (don't change), b is null (clear), c is "" (set empty)
```

So when building PATCH request bodies: omit the field entirely to "don't change", set it to `null` to "clear", and set it to `""` to "set empty string". Don't accidentally collapse these — e.g., `value || null` turns `""` into `null`, which changes "set empty" into "clear."

**The pattern**:
- Use `??` not `||` for defaults (`""` triggers `||` fallback, `??` only triggers on `null`/`undefined`)
- Use `value == null` not `!value` for absence checks (`== null` catches both null and undefined)
- When building PATCH bodies, only include fields that changed — don't send every field
- An empty document should render an empty editor, not a "no content" state

## Use Shared UI Components

**Why**: Consistency is trust. If delete confirmations look different in every feature, the user can't build muscle memory. If some errors have retry buttons and others don't, the experience feels broken. Shared components enforce consistency automatically — you can't accidentally use the wrong pattern if there's only one way to do it.

**The pattern**:
- `ErrorPanel` for full-page load failures, `InlineError` for recoverable errors — not ad-hoc error text
- `DeleteConfirmationDialog` for destructive actions — not `window.confirm()`
- Check `shared/components/` before creating new UI primitives

## Zustand: Selectors Over Whole-Store

**Why**: Zustand re-renders every subscriber when any state field changes. A component that subscribes to the whole store re-renders on every keystroke, every streaming delta, every background refresh — even if it only reads `status`. In a writing app with real-time collab and streaming AI responses, this means hundreds of unnecessary re-renders per second. Selectors let React skip re-renders when the selected field hasn't changed.

**The pattern**:
- `useStore((s) => s.field)` or `useShallow` for object picks
- Never `const store = useStore()` — causes re-renders on any state change

## Guard Stale References Across Navigation

**Why**: React state updates are asynchronous and Zustand stores are global singletons. When a user navigates from document A to document B, the store's `activeDocument` doesn't update atomically — there's a window where hooks for document B are running but `activeDocument` still holds A's data. Reading `.content` or `.extension` without checking `.id === documentId` silently produces wrong data. We've had bugs where the editor loaded with document A's extension (wrong syntax highlighting) and where saves wrote content to document A's ID instead of B's.

**The pattern**: When hooks receive an entity ID (documentId, threadId), always verify that store state matches before using it: `if (activeDocument?.id !== documentId) return`.

## CodeMirror: Never Recreate the Editor

**Why**: The `EditorView` is created once with an empty dependency array. All dynamic changes go through **Compartments** — CM6's mechanism for hot-swapping extensions without destroying the view. Recreating the editor destroys undo history, cursor position, scroll state, selection, and any in-flight Yjs sync.

**The pattern**:
- `useEffect(() => { /* create EditorView */ }, [])` — empty deps, never recreate
- Dynamic changes use `compartment.reconfigure(newExtension)` (see `editableCompartment`, `themeCompartment`, `livePreviewCompartment` in `CodeMirrorEditor.tsx`)
- Callbacks the editor uses (like `onChange`) are stored in `useRef` to prevent extension recreation when callback identity changes
- New keymaps need explicit `Prec` priority (`Prec.highest` > `Prec.high` > default) — without it, they silently lose to existing bindings

**What goes wrong**: Adding a prop to the `useEffect` dependency array causes the editor to be destroyed and recreated on every change. Using `useMemo` or `useState` for callbacks causes extension churn.

## Zustand: Module-Level AbortControllers, Not Store State

**Why**: Request deduplication uses two patterns, both at **module level** (not in store state):
1. **Module-level AbortController**: One shared controller; new requests abort the previous (`useProjectStore.ts`)
2. **Monotonic request counter**: Each request captures `++requestId`; stale responses check and bail (`useTreeStore.ts`)

Module-level avoids polluting serializable store state with non-serializable controllers/timers.

**The pattern**:
- `let activeController: AbortController | null = null;` at module top
- Inside the action: `activeController?.abort(); activeController = new AbortController();`
- OR: `let requestId = 0;` then `const thisRequest = ++requestId;` with `if (thisRequest !== requestId) return;` after await

**What goes wrong**: Storing AbortController in Zustand state breaks serialization/persistence. Using `useRef` in a component ties cancellation to component lifecycle instead of store lifecycle.

## Zustand: Stale-While-Revalidate Pattern

**Why**: Tab switches fire `loadThreads()`, `loadTree()`, etc. on every mount. Without freshness checks, every switch triggers a network request and potential flicker. The codebase uses a consistent SWR pattern across stores.

**The pattern**:
```typescript
const hasCachedData = items.length > 0 && itemsProjectId === projectId;
const isFresh = hasCachedData && Date.now() - loadedAt < 30_000;
if (isFresh) return;                           // Skip if < 30s old
if (hasCachedData) { set({ isFetching: true }); }  // Background refresh (no skeleton)
else { set({ status: "loading" }); }            // Show skeleton (no data yet)
```

**What goes wrong**: Always showing a spinner on mount (flicker), never refreshing (stale forever), or not distinguishing "no cache → skeleton" from "has cache → silent background fetch".

## API: fetchAPI Is the Single Gateway

**Why**: `fetchAPI<T>()` handles auth token injection, `snake_case` → `camelCase` response conversion, error mapping to `AppError`, and retry logic. Bypassing it loses all of this.

**The pattern**:
- All API calls go through `fetchAPI()` — never raw `fetch()`
- Response keys are auto-converted from `snake_case` to `camelCase` — all DTO types use `camelCase` property names
- Only GET requests auto-retry on transient errors (POST/PATCH/DELETE never retry — they could duplicate mutations)

**What goes wrong**: Using `fetch()` directly (loses auth, case conversion, error handling). Defining DTO types with `snake_case` properties. Adding retry to mutation endpoints.

## TanStack Router: No Loaders, Store-Driven Loading

**Why**: Data loading happens in component effects that call Zustand store actions — NOT in TanStack Router `loader` functions. Route loaders would bypass the SWR cache and duplicate store loading logic.

**The pattern**:
- `beforeLoad` hooks are ONLY for auth guards (redirect to `/login`)
- Data loading is in `useEffect` within layout/page components
- Layout routes (files prefixed with `_`) provide `<Outlet />` wrappers and auth checks but add no URL path segment

**What goes wrong**: Adding a `loader` function to a route (bypasses store cache). Returning data from `beforeLoad` (only used for redirects here).

## Navigation: Two-Pronged (State + URL)

**Why**: Navigation always does two things: (1) direct store update via `getState()` for instant UI feedback, and (2) `navigate()` for browser history. Only updating the URL causes delayed feedback; only updating the store breaks back/forward.

**The pattern** (see `panelHelpers.ts`):
```typescript
// 1. Instant UI feedback
useUIStore.getState().setActiveDocument(documentId);
useUIStore.getState().setRightPanelState("editor");
// 2. Browser history
navigate({ to: "/projects/$slug/documents/$", params: { slug, _splat: path } });
```

**What goes wrong**: Only calling `navigate()` (UI waits for route resolution). Only updating the store (browser back/forward broken).

## Activity Navigation: Mount Everything, Show One

**Why**: Panel and tab switches must feel instant — no loading spinners, no lost scroll position, no destroyed editor state. The app mounts all views simultaneously (using `absolute inset-0` stacking) and uses React 19's `<Activity>` component to control which one is visible. Hidden activities have their effects paused and updates deferred, but their DOM and component state are fully preserved.

This is fundamentally different from conditional rendering (`{active && <Component />}`) which destroys and recreates components on every switch, and from CSS `display: none` which keeps effects running and doesn't defer updates.

**The pattern**:
```tsx
<Activity mode={activeView === "chat" ? "visible" : "hidden"}>
  <div className="absolute inset-0">{panels.activeThread}</div>
</Activity>
<Activity mode={activeView === "threads" ? "visible" : "hidden"}>
  <div className="absolute inset-0">{panels.threadList}</div>
</Activity>
```

- All views are mounted inside `absolute inset-0` containers (stacked on top of each other)
- `<Activity mode="visible">` makes the active view interactive; `"hidden"` pauses the rest
- Used in both `TwoPanelLayout` (desktop left panel: chat/threads/settings) and `MobileLayout` (all four tabs)
- Preserves: scroll position, editor state, WebSocket connections, Zustand subscriptions

**What goes wrong**: Using `{active && <Component />}` destroys component state on every tab switch — scroll resets, editors re-initialize, WebSocket reconnects. Using CSS `visibility: hidden` or `display: none` doesn't pause effects (hidden views keep fetching, streaming, running timers).

## CSS: Use cn() for Class Merging

**Why**: All conditional Tailwind classes must go through `cn()` (which is `clsx` + `twMerge`). This resolves utility conflicts — `cn("px-2", condition && "px-4")` outputs `px-4`, not both.

**The pattern**:
- `cn()` for all conditional/dynamic classes — never manual string concatenation or template literals
- Component heights use CSS variables (`--component-height-sm`, `--component-height-md`, etc.) not magic numbers
- Hover-only styles use `@media (hover: hover)` to prevent iOS tap-as-hover artifacts

**What goes wrong**: String concatenation produces `"px-2 px-4"` — both apply, nondeterministic result. Hardcoded heights diverge from the design system.
