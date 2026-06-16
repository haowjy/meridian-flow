# Phase 3: FloatingScrollLayout Streaming Integration

## Scope
Add streaming awareness to FloatingScrollLayout so it works correctly during live assistant turns. Bridge the gaps between v2's current implementation and v1's battle-tested patterns.

**Runs in parallel with Phase 2** — can be developed with standalone stories, tested with thread view once Phase 2 lands.

## Files to Modify
- `frontend-v2/src/features/chat-scroll/FloatingScrollLayout.tsx` — Add isStreaming prop + behavior changes
- `frontend-v2/src/features/chat-scroll/FloatingScrollLayout.stories.tsx` — Add streaming demo story

## Changes

### 1. `isStreaming` prop
```ts
type FloatingScrollLayoutProps = {
  // ...existing...
  isStreaming?: boolean  // changes scroll behavior during streaming
}
```

### 2. Instant scroll during streaming
Currently uses `smooth` scroll always. During streaming, content changes too fast — smooth scroll lags behind.
- When `isStreaming && shouldStickToBottom`: use `behavior: "auto"` (instant)
- When `!isStreaming`: use `behavior: "smooth"` (existing)

### 3. Content gating (prevent layout flash on thread switch)
v1 pattern: hide content → scroll to target → reveal. Prevents the user seeing content at the wrong scroll position momentarily.

Add optional `resetKey` prop:
```ts
type FloatingScrollLayoutProps = {
  // ...existing...
  resetKey?: string  // thread ID — triggers content gating on change
}
```

On `resetKey` change:
1. Set `isContentReady = false` → `className="opacity-0 pointer-events-none"`
2. Wait for layout stability (RAF loop checking scrollHeight)
3. Scroll to bottom (or target position)
4. Set `isContentReady = true` → content reveals

### 4. Remove `children` from useEffect deps (line 188)
Currently triggers scroll check on every re-render when children identity changes. The ResizeObserver on contentRef (lines 148-175) already handles content size changes. Remove the children-triggered effect entirely.

### 5. Scroll-to-bottom button: behavior matches streaming state
```ts
const scrollBehavior: ScrollBehavior = isStreaming ? "auto" : "smooth"
```

## Dependencies
- Independent of: Phase 1 (no type changes needed)
- Benefits from: Phase 2 (thread view to test with, but standalone stories work)

## Verification Criteria
- [ ] Auto-scroll keeps up with fast token streaming (no visible lag)
- [ ] User scrolls up during streaming → auto-scroll detaches, button appears
- [ ] User scrolls back to bottom → auto-scroll re-engages, button disappears
- [ ] Scroll-to-bottom button click uses instant scroll during streaming, smooth otherwise
- [ ] Thread switch (resetKey change) → no layout flash (content gated)
- [ ] Removing children from useEffect deps doesn't break auto-scroll behavior
- [ ] Standalone streaming story demonstrates all behaviors without thread view
