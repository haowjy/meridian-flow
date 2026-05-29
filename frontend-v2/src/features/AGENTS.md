# Features

## What Lives Here

Feature directories — each a colocated unit with components, stories,
types, hooks, and mock data.

| Feature | Directory | Key characteristic |
|---|---|---|
| Activity Stream | `activity-stream/` | Agent tool activity viewer (35 files, 10 example scenarios) |
| Threads | `threads/` | Conversation threads with branching + composer (23 files) |
| Chat Scroll | `chat-scroll/` | `FloatingScrollLayout` (sophisticated scroll container) |
| Docs | `docs/` | `DocWsProvider` (WS connection context for document sync) |

## Feature-Colocation Principle

Everything a feature needs lives in its own directory. This includes:
- Components (`.tsx`)
- Stories (`.stories.tsx`)
- Types (`.ts`)
- Hooks (`.ts`)
- Utilities (`.ts`)
- **Shared mock factories** (one set of factories used by all stories in
  the feature — never duplicate mock data across stories)

A feature directory is self-contained: you can read it top-to-bottom and
understand the feature's data model, visual treatment, and test scenarios
without leaving the directory.

## Story Development Rules

### Stories go alongside the component by default

```
features/activity-stream/ActivityBlock.tsx
features/activity-stream/ActivityBlock.stories.tsx
```

Move to a `stories/` subdirectory when stories need helpers, multiple
files, or shared test utilities:

```
features/activity-stream/stories/
features/activity-stream/stories/helpers/
```

### Modify the component, not the story

When a story reveals a problem — wrong behavior, missing variant, bad
styling — fix the **underlying component**. Stories are test harnesses,
not the product. If you find yourself adding logic, wrappers, or
overrides inside a story to make it look right, that's a signal the
component needs work.

### Stories share the component's mock data

Each feature directory should have shared mock factories used by all its
stories. Never create parallel mock data in individual story files — when
the component changes, parallel mocks drift and stories silently stop
reflecting reality.

```tsx
// BAD: parallel mock, different shape from other stories
const mockTool = { name: "Bash", input: { cmd: "ls" }, output: "..." }

// GOOD: shared factory imported by all stories
function bashTool(id: string, command: string, status: ToolItem["status"] = "done"): ToolItem { ... }
```

### Test through the real component tree

If a component is always rendered inside a parent (e.g., tool details
inside ActivityBlock), stories should test it through that parent.
Isolated stories that bypass the real rendering path don't catch
integration issues and create a maintenance burden when the parent's API
changes.

**Exception:** a component with its own complex API that genuinely works
standalone (e.g., `FloatingScrollLayout`).

### When refactoring a component, update its stories in the same pass

Stories that compile but show stale behavior are worse than stories that
break — they give false confidence. When you change a component's props,
state management, or rendering behavior, update every story that touches
it before moving on.

### Component self-containment over story wrappers

If every story wraps a component in the same `<div>` with the same
padding/layout, that wrapper belongs inside the component (or as a
`className` prop). The component should "just work" when imported.

## Streaming-First Data Models

Features that display real-time data from WebSocket streams follow a
streaming-first pattern:

### ToolStatus (Activity Stream)

Discriminated union: `streaming-args` → `executing` → `done` | `error`.
Progressive summary extraction via `partial-json`. Tool classification
by name segments (file-system, web-search, etc.).

### ThreadTurn (Threads)

Discriminated union on `role`: `assistant` | `user` | `system`.
Tree structure via `parentId` + `siblingIds` + `siblingIndex`.

### Streaming Yield-Between-Chunks Rule

Streaming consumers (activity stream, thread rendering) must:
1. **Batch chunks** — buffer incoming tokens; flush at natural boundaries
2. **Yield to the main thread** between batches — do not block interaction
3. **Never perform synchronous reflow-reads after writes** in the same
   task — this forces synchronous reflow and jank
4. **Keep stale content visible** while the next chunk loads — use
   `useDeferredValue` / `useTransition`

See `_docs/design/foundations/motion.md` §Streaming Text: Yield-Between-
Chunks Rule.

### Mobile Streaming

On Phone, streaming text uses **phrase/sentence-chunk batching** (not
token-by-token). Tool groups and agent detail open as bottom sheets.
Send/Stop are **never shown simultaneously** — the button toggles state.
See `_docs/design/interaction/threads-and-tools.md` §Mobile Chat Surface.

## Proposals Review Integration

When a feature displays or triggers proposal review, it must route
through the canonical review flow:

- **"Keep / Edit / Discard"** — the canonical action language
- Review is **document-scoped** — all pending hunks for the active
  document are visible regardless of originating thread
- Undo is **document-level** (the editor's undo stack, not per-thread)
- See `_docs/design/interaction/proposals-review.md`

## Design Spec Pointers

| Concern | Canonical doc |
|---|---|
| Turn rendering, tool activity, streaming display, branch navigation, mobile chat | `_docs/design/interaction/threads-and-tools.md` |
| Proposals review (hunks, lifecycle, review flow, touch review) | `_docs/design/interaction/proposals-review.md` |
| Streaming yield rules, INP budget, `content-visibility` | `_docs/design/foundations/motion.md` |
| Mobile/responsive behavior for chat surfaces | `_docs/design/interaction/threads-and-tools.md` §Mobile Chat Surface |
| Editor interaction (formatting toolbar, proposals decorations) | `_docs/design/interaction/editor.md` |
| Composer component spec | `_docs/design/components.md` §Composer |
| ChatMessage / Turn component spec | `_docs/design/components.md` §ChatMessage |
| Keyboard map (thread navigation, send, stop streaming) | `_docs/design/interaction/navigation.md` |
