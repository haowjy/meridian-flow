# Thread Scroll & Virtualization

Concerns for the thread-level container that holds multiple turns/ActivityBlocks. Not applicable to the ActivityBlock refactor (which renders a bounded item list inside a card).

## V1 Patterns

### Scroll Controller (`useChatScroller.ts`)

Three concurrent concerns:

1. **Initial positioning** — content gating (opacity-0) while waiting for layout stability (RAF polling up to 240 frames), then scroll to bookmarked turn, then reveal.
2. **Streaming follow** — ResizeObserver on content wrapper auto-scrolls to bottom. User scroll-up pauses follow. Scroll back to bottom (50px threshold) resumes.
3. **Composer resize** — ResizeObserver on composer reports height to parent, which applies dynamic `paddingBottom` on the content wrapper. Composer is outside scroll container so no anchor displacement.

### V1 Limitations

- **No virtualization** — all turns rendered unconditionally. Server-driven pagination (100 turns/request) handles initial load. No auto-pagination on scroll-to-edge.
- **No scroll position history** — thread always scrolls to bookmarked turn on open, no per-thread scroll offset saved.
- **Layout stability timeout** — gives up after ~4 seconds. If content still unstable (slow network, large initial load), scroll may land wrong.
- **No `content-visibility`** — no viewport culling for off-screen turns.
- **No lazy image loading** — potential layout shift from images.

## V2 Considerations

### Virtualization

V1 works without virtualization because typical threads are < 200 turns. If v2 needs to handle longer threads (1000+ turns with tool-heavy activity blocks):

- `@tanstack/react-virtual` or `react-virtuoso` for windowed rendering
- Must handle variable-height items (collapsed vs expanded ActivityBlocks)
- Streaming content in the last turn complicates windowing (height changes continuously)
- Collapsible expansion anywhere in the list changes heights unpredictably

### Scroll Jump Prevention

- **Content gating on thread switch** — v1 pattern works well, carry forward
- **Stable React keys** — prevent remount/collapse on data refresh (v1 uses `blockIdentity.ts`)
- **ResizeObserver-based follow** — proven pattern, preferable to scroll-event-based approaches
- **Intersection observer for pagination** — v1 doesn't auto-paginate, v2 should consider it

### Height Change Sources (from ActivityBlock)

When items inside an ActivityBlock expand/collapse, the block height changes. The thread scroll controller must handle this:
- If streaming (follow mode): auto-scroll to new bottom
- If user scrolled up: no scroll, preserve position
- Collapsible expansion shouldn't trigger follow-mode scroll

### Composer Resize

V1's pattern (outside scroll container + dynamic padding) is clean. Carry forward.
