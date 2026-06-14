# Phase 2: Thread Scrubber Story

## Scope
Build the thread-level streaming demo in Storybook. A full conversation plays through with a timeline scrubber — play/pause/step/rewind/slider. Uses ThreadScenarioBuilder for event generation.

The simulator mocks the Phase 1 store interface (REST history + SSE streaming), not a fake event model. User turns arrive as pre-loaded history, assistant turns stream via the existing per-turn reducer.

## Files to Create
- `frontend-v2/src/features/threads/components/UserBubble.tsx` — User message renderer (block-based, not just text)
- `frontend-v2/src/features/threads/components/TurnRow.tsx` — Routes user/assistant turns, adds sibling nav
- `frontend-v2/src/features/threads/components/SiblingNav.tsx` — ← 2/3 → sibling navigation widget
- `frontend-v2/src/features/threads/components/TurnList.tsx` — Renders active path as a list of TurnRows
- `frontend-v2/src/features/threads/hooks/use-thread-simulator.ts` — Mocks the store interface for Storybook
- `frontend-v2/src/features/threads/ThreadView.stories.tsx` — Scrubber story with full controls
- `frontend-v2/src/features/activity-stream/examples/thread-walkthrough.ts` — Full conversation scenario

## Dependencies
- Requires: Phase 1 types + store interface
- Requires: ThreadScenarioBuilder (done), ActivityBlock (done), FloatingScrollLayout (done)

## Thread Simulator Hook
Mocks the Phase 1 store interface. Two-phase playback:

1. **Pre-load history** — User turns and completed assistant turns appear instantly (simulating REST pagination response)
2. **Stream active turn** — Last assistant turn streams via AG-UI events through the existing per-turn reducer

The scrubber controls the playback position across both phases.

**No `USER_MESSAGE` stream event.** User turns are data, not events. The simulator pre-populates them in the turn list, matching how the real store works (REST loads history, SSE streams the active turn).

```ts
type ThreadSimulatorConfig = {
  // Pre-loaded turns (user messages, completed assistant turns)
  history: ThreadTurn[]
  // Streaming timeline for the active assistant turn
  activeTimeline: TimelineEntry[]
}
```

## Scrubber UI
- Timeline slider: drag to any event position
- Turn markers on the slider (visual dots at turn boundaries)
- Play/Pause/Step forward/backward
- Speed control (0.1x - 4x)
- Event counter: "Event 42/180"
- Phase indicator: "Loading history..." → "Streaming turn 3"

## UserBubble Component
Block-based, not just text. Handles the common case (text-only) simply, but supports images and references when present.

```tsx
function UserBubble({ turn }: { turn: ThreadTurn }) {
  // Most user turns are just text — render simply
  // If blocks contain images/references, render those too
  return (
    <div className="flex justify-end">
      <article className="max-w-[80%] rounded-xl border bg-card px-4 py-3">
        {turn.blocks?.map(block => <UserBlock key={block.id} block={block} />)}
      </article>
    </div>
  )
}
```

## TurnRow Component
Routes by role + adds sibling nav when siblings exist:

```tsx
function TurnRow({ turn }: { turn: ThreadTurn }) {
  return (
    <div>
      {turn.siblingIds.length > 1 && <SiblingNav current={turn.siblingIndex} total={turn.siblingIds.length} />}
      {turn.role === "user"
        ? <UserBubble turn={turn} />
        : turn.role === "assistant"
          ? <ActivityBlock activity={turn.activity} />
          : null  /* system turns hidden by default */
      }
    </div>
  )
}
```

## Verification Criteria
- [ ] Full conversation plays through with realistic timing
- [ ] User turns appear as pre-loaded history (not streamed events)
- [ ] Active assistant turn streams via existing per-turn reducer
- [ ] Scrubber can rewind to any point and replay
- [ ] User bubbles render on the right, assistant turns on the left
- [ ] User bubbles support text blocks (images/references deferred to Phase 5)
- [ ] Sibling nav shows when turn has siblings (static mock for now)
- [ ] FloatingScrollLayout auto-scrolls during streaming
- [ ] Simulator matches the Phase 1 store interface shape
