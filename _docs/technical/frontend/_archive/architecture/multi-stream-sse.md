---
detail: comprehensive
audience: architect
---

# Multi-Stream SSE (Frontend) — Problems, Why, and Target Architecture

Meridian’s thread UI is moving from **one active SSE stream** (“the currently streaming assistant turn”) to **multiple concurrent SSE streams** (main assistant + tool/subagent streams + future agent threads).

This doc:
- Defines the **current problems** (with concrete code references)
- Defines the **future state** and **why** we’re doing this
- Proposes a SOLID-aligned frontend architecture for **concurrent streaming**

See also:
- `_docs/technical/llm/streaming/README.md` (backend SSE + streaming concepts)
- `_docs/technical/frontend/thread-rendering-guide.md` (how blocks render in chat)

---

## Current Problems (What’s broken / fragile today)

### 1) Runtime crash: SSE `STREAM_SWITCH` handler expects actions that aren’t wired

We already have interjection events (`INTERJECTION_UPDATED`, `STREAM_SWITCH`) and handlers for them:
- `frontend/src/features/threads/hooks/sse/eventHandlers/interjectionEventHandlers.ts:18` (`INTERJECTION_UPDATED`)
- `frontend/src/features/threads/hooks/sse/eventHandlers/interjectionEventHandlers.ts:36` (`STREAM_SWITCH`)

Those handlers call:
- `actions.setInterjectionContent(...)` (line 28)
- `actions.applyStreamSwitch(...)` (line 48)
- `ctx.ctrl.abort()` (line 60)

But the `actions` object constructed inside `useThreadSSE()` does **not** include `setInterjectionContent` or `applyStreamSwitch`:
- `frontend/src/features/threads/hooks/sse/useSSEConnection.ts:30` (`useThreadSSE`)
- `frontend/src/features/threads/hooks/sse/useSSEConnection.ts:104` (actions object construction)

This mismatch is explicitly visible in the type contract:
- `frontend/src/features/threads/hooks/sse/types.ts:36` (`SSEStoreActions` requires `setInterjectionContent` + `applyStreamSwitch`)

Result: the frontend receives `STREAM_SWITCH` data, logs `sse:stream_switch`, then throws:
`TypeError: actions.applyStreamSwitch is not a function`

### 2) Misleading error logs hide handler failures

`dispatchSSEEvent(...)` wraps the entire dispatch (parse + handler execution) in one `try/catch` and logs everything as `parse_error`:
- `frontend/src/features/threads/hooks/sse/SSEEventDispatcher.ts:197`

This makes handler wiring bugs look like malformed JSON.

### 3) Single-stream state is baked into the thread store

The thread store encodes a single active stream:
- `streamingTurnId`, `streamingUrl` inferred via `detectStreamingState(...)`:
  - `frontend/src/core/stores/useThreadStore.ts:131`
- Global “clear the stream” operation:
  - `frontend/src/core/stores/useThreadStore.ts:617`

This cannot represent:
- Main assistant streaming **and** tool/subagent streaming simultaneously
- Multiple agent threads streaming at once

It also forces unrelated UIs to fight over the singleton state:
- If tool streaming wants “its own stream”, it can only hijack `streamingTurnId` today.

### 4) Cleanup logic is not scoped (race-prone even with stream switching)

Even before multi-stream, stream switching introduces races (old stream ends while new one starts). Today, cleanup paths clear global state unconditionally:

Connection lifecycle cleanup:
- `onclose()` clears global streaming state:
  - `frontend/src/features/threads/hooks/sse/useSSEConnection.ts:185` -> `clearStreamingStream()` at line 200
- `onerror()` clears global streaming state:
  - `frontend/src/features/threads/hooks/sse/useSSEConnection.ts:211` -> `clearStreamingStream()` at line 218

Event lifecycle cleanup:
- `RUN_FINISHED` clears global streaming state:
  - `frontend/src/features/threads/hooks/sse/eventHandlers/lifecycleEventHandlers.ts:94` -> `clearStreamingStream()` at line 120
- `RUN_ERROR` clears global streaming state:
  - `frontend/src/features/threads/hooks/sse/eventHandlers/lifecycleEventHandlers.ts:159` -> `clearStreamingStream()` at line 190

In a multi-stream world (or even during `STREAM_SWITCH`), stale close/terminal events from Stream A can erase Stream B’s state unless cleanup is scoped.

### 5) Shared mutable refs assume “one connection at a time”

`useThreadSSE()` uses shared refs intended for a single stream:
- `currentTurnIdRef`:
  - `frontend/src/features/threads/hooks/sse/useSSEConnection.ts:58`
- One `AbortController` ref (`ctrlRef`):
  - `frontend/src/features/threads/hooks/sse/useSSEConnection.ts:59`
- One `BlockTracker` ref (`trackerRef`):
  - `frontend/src/features/threads/hooks/sse/useSSEConnection.ts:62`

This is fundamentally incompatible with N concurrent connections.

---

## Future State (WHY we’re doing this)

We need to support **multiple concurrent, independent streams**:

- **Main assistant stream** (thread chat response)
- **Tool/subagent streams** (a tool may spawn a subagent that streams progress output)
- **Agent threads** (multiple assistants/agents streaming in parallel)

User-facing reasons:
- Tool-driven agents can stream status/progress without blocking the main assistant.
- Multiple parallel agents reduce latency (“plan while researching”, “draft while searching”).
- Better UX: each stream has its own UI and lifecycle.

Engineering reasons:
- Avoid “singleton state fights” and hard-to-debug races.
- Make correctness obvious: event -> state update is scoped to one stream.
- Make extensibility cheap: adding a new stream kind should not require reworking the main thread streaming pipeline.

---

## Target Architecture (SOLID-aligned, multi-stream-first)

### Architecture overview

```mermaid
flowchart TB
  UI[UI Panels<br/>(Thread, Tool, Agent)] -->|open/close| StreamStore[useStreamStore<br/>connection state keyed]

  StreamStore --> Manager[SSEConnectionManager<br/>renders one connection per StreamKey]

  Manager --> Conn1[SSEConnection<br/>StreamKey=main:thread]
  Manager --> Conn2[SSEConnection<br/>StreamKey=tool:callId]
  Manager --> Conn3[SSEConnection<br/>StreamKey=agent:threadId]

  Conn1 --> Dispatch1[Dispatcher + Handlers]
  Conn2 --> Dispatch2[Dispatcher + Handlers]
  Conn3 --> Dispatch3[Dispatcher + Handlers]

  Dispatch1 -->|Main adapters| ThreadStore[useThreadStore<br/>turn graph + blocks]
  Dispatch2 -->|Tool adapters| ToolStore[useToolStreamStore<br/>tool UI state]
  Dispatch3 -->|Agent adapters| AgentStore[useAgentStore<br/>agent thread state]

```

Key properties:
- Each stream has a unique **StreamKey**
- Each connection has its own controller/tracker/buffer (no shared refs)
- Event handling uses **adapters** so handlers don’t import stores directly (DIP)
- Cleanup is **scoped** (a stream can only clear itself)

---

## Core Concepts

### StreamKey (explicit identity)

`StreamKey` is a stable identifier for a *connection + UI surface*, not necessarily a turn.

Examples:
- `main:<threadId>` — main assistant stream for a thread view
- `tool:<toolCallId>` — a tool-specific substream panel
- `agent:<agentThreadId>` — a subagent thread’s streaming panel

Guideline:
- StreamKey should be stable across reconnections, and human-debuggable.

### StreamDescriptor (connection state only) — SRP

A `StreamDescriptor` represents “what to connect to” + “what is its lifecycle”.

Suggested fields:
- `streamKey: StreamKey`
- `url: string | null`
- `turnId: string | null` (assistant turn currently producing this stream)
- `status: 'idle' | 'connecting' | 'open' | 'closed' | 'error'`
- `lastError?: string`
- optional: `startedAt`, `lastEventAt`, `retryCount`

This belongs in a dedicated store (recommended: `useStreamStore`), *not* the thread store.

### StreamController (per-connection runtime state)

Each SSE connection owns:
- `AbortController`
- `BlockTracker` (sequence tracking)
- streaming delta buffer (e.g., 50ms flush)
- logger bound to `streamKey`

This state should not live in Zustand; it’s ephemeral per connection instance.

### Action adapters (store updates) — DIP + ISP

Instead of one giant `SSEStoreActions` that every stream must implement, use adapters per capability:

- **Text block updates**: “append delta to block N for turnId”
- **Lifecycle cleanup**: “mark stream ended, cleanup if current”
- **Interjection**: “apply stream switch”, “set interjection content”
- **Tool UI**: “update tool call args/result UI state”

Reason:
- Tool streams should not be forced to implement interjection actions.
- Agent streams may not want to refresh the main thread turn blocks.

This is the core SOLID move:
- Handlers depend on small interfaces, not a monolith (ISP).
- Connection code depends on an abstract adapter, not Zustand stores (DIP).

---

## Event Scoping & Cleanup Rules (Concurrency Safety)

### Rule 1: Cleanup must be scoped to (StreamKey, TurnID)

Replace global cleanup (`clearStreamingStream()`) with a scoped guard:

**Concept:** “Only clear if I’m still the active stream for this StreamKey.”

Pseudo API:
- `clearStreamIfCurrent(streamKey, expectedTurnId)`

This prevents:
- Old main stream close/finish clearing a new main stream after a switch
- Tool stream finish clearing the main stream
- Agent stream finish clearing other agent streams

### Rule 2: Terminal events should not assume they own “the app streaming state”

In the current system, `RUN_FINISHED`/`RUN_ERROR` always clear the singleton stream state:
- `frontend/src/features/threads/hooks/sse/eventHandlers/lifecycleEventHandlers.ts:117` (runCleanup)
- `frontend/src/features/threads/hooks/sse/eventHandlers/lifecycleEventHandlers.ts:188` (RUN_ERROR cleanup)

In multi-stream, these must become:
- “cleanup for my connection only”
- plus optional domain refresh for the associated turn/thread (if applicable to that stream kind)

### Rule 3: `STREAM_SWITCH` is a “main stream only” event

Stream switching changes which assistant turn is the “current producer” for the main thread. It should:
- Update the thread store (merge turns)
- Update the main StreamDescriptor (`main:<threadId>`) to point to the new `{turnId, url}`
- Abort only the main connection (so manager reconnects)

Tool streams and agent streams should ignore it (or treat it as unsupported).

---

## Proposed Module Layout (implementation-oriented)

Suggested new/updated modules:

### Connection state
- `frontend/src/features/streams/stores/useStreamStore.ts`
  - Owns `streamsByKey`
  - Provides `openStream`, `closeStream`, `clearStream`, `setError`

### Connection manager + connection component
- `frontend/src/features/streams/components/SSEConnectionManager.tsx`
  - Reads active `streamsByKey`
  - Renders `<SSEConnection streamKey={k} />` per active stream
  - This avoids “hooks in loops” by moving `useSSEConnection` into a component.

- `frontend/src/features/streams/components/SSEConnection.tsx`
  - Calls `useSSEConnection(streamKey)`

- `frontend/src/features/streams/hooks/useSSEConnection.ts`
  - Generic connection lifecycle hook (not thread-specific)
  - Creates per-connection controller/buffer/tracker
  - Calls dispatcher with stream-scoped `ctx`

### Dispatcher + handler interfaces
- `frontend/src/features/streams/sse/dispatchSSEEvent.ts`
  - Should separate JSON parsing failures vs handler execution failures
  - Should always log `streamKey` + `turnId` in errors

### Action adapters
- `frontend/src/features/streams/sse/createSSEActions.ts`
  - `createSSEActions(streamKey): { lifecycle: ..., blocks: ..., interjection?: ..., tools?: ... }`
  - Chooses adapter implementations based on stream kind (`main/tool/agent`)

---

## Migration Plan (from today -> multi-stream)

This plan keeps the refactor incremental while immediately fixing the current `STREAM_SWITCH` crash.

### Phase 0 — Fix the current crash (wiring) without changing architecture
Goal: Stop runtime handler failures today.
- Ensure `useThreadSSE` passes `applyStreamSwitch` and `setInterjectionContent` into `actions` (per `frontend/src/features/threads/hooks/sse/types.ts:58`).
- Improve dispatcher logging (`parse_error` vs `handler_error`) to make failures obvious.

### Phase 1 — Introduce multi-stream primitives with only one stream active
Goal: Put the structure in place without changing UX.
- Add `useStreamStore` + `main:<threadId>` stream descriptor.
- Replace `useThreadStore.streamingTurnId/streamingUrl` usage with `useStreamStore` for the main stream.
- Build `SSEConnectionManager` that runs exactly one stream at first.

### Phase 2 — Split actions into adapters and scope cleanup
Goal: Make concurrency safe.
- Replace global cleanup with `clearStreamIfCurrent(streamKey, expectedTurnId)` everywhere:
  - connection `onclose/onerror`
  - lifecycle handlers `RUN_FINISHED/RUN_ERROR`
- Remove `currentTurnIdRef` pattern in favor of per-connection immutable `turnId` capture.

### Phase 3 — Add tool streams
Goal: Enable tool/subagent streaming panels.
- Define a backend event contract to “start a tool stream” (or a polling discovery mechanism).
- Open `tool:<toolCallId>` streams in `useStreamStore`.
- Route tool stream events to `useToolStreamStore` (or a new dedicated agent/tool store) via adapters.

### Phase 4 — Add agent thread streams
Goal: Multiple concurrent agent threads.
- Introduce `useAgentStore` (or similar) keyed by agent thread id.
- Render agent panels that open `agent:<agentThreadId>` streams.

---

## Acceptance Criteria (what “done” looks like)

- Receiving `STREAM_SWITCH` never throws, always reconnects the main stream.
- Closing/finishing Stream A cannot clear Stream B.
- The UI can show:
  - main assistant stream
  - at least one tool stream
  - at least one agent stream
  simultaneously, with independent lifecycle.
- Adding a new SSE event type requires:
  - adding the handler
  - adding the adapter method (if needed)
  - and TypeScript fails compilation if wiring is incomplete.

