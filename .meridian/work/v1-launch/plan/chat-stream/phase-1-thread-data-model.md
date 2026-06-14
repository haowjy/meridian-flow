# Phase 1: Thread Data Model + Transport Layer

## Scope
Define the frontend thread/turn types and store interface that bridge the backend Turn+TurnBlock model to the UI component tree. This is the foundation — all other phases depend on these types.

Critically, the store interface must match the real data flow: **REST for history, SSE for active turn**. The Storybook simulator can mock both, but the interface must be production-shaped.

## Files to Create
- `frontend-v2/src/features/threads/types.ts` — Thread, ThreadTurn, ActivePath types
- `frontend-v2/src/features/threads/turn-mapper.ts` — Backend Turn+TurnBlocks → ThreadTurn view model
- `frontend-v2/src/features/threads/transport-types.ts` — Store interface matching real REST+SSE data flow

## Key Design Decisions

### ThreadTurn uses blocks, not flat strings
User turns can contain image, reference, partial_reference, and tool_result blocks — not just text. System turns include compaction and collapse_marker bookmarks. All turns use the same block-based representation.

```ts
type TurnRole = "user" | "assistant" | "system"
type TurnStatus = "pending" | "streaming" | "waiting_subagents" | "complete" | "cancelled" | "error" | "credit_limited"

type ThreadTurn = {
  id: string
  threadId: string
  parentId: string | null          // prevTurnId — tree structure
  role: TurnRole
  status: TurnStatus
  siblingIds: string[]
  siblingIndex: number
  createdAt: Date

  // Content — block-based for all roles
  // Assistant turns: full activity block data (tools, thinking, content)
  activity?: ActivityBlockData
  // User turns: blocks (text, images, references, tool_results)
  blocks?: TurnBlock[]
  // System turns: blocks (compaction markers, collapse markers, prompt)
  systemBlocks?: TurnBlock[]

  // Metadata
  model?: string
  inputTokens?: number
  outputTokens?: number
  error?: string
  childThreadId?: string           // for agent tool calls linking to nested thread
}

// Mirrors backend TurnBlock — normalized frontend representation
type TurnBlock = {
  id: string
  blockType: BlockType
  sequence: number
  textContent?: string
  content?: Record<string, unknown>
  status?: "complete" | "partial"
}

type BlockType =
  | "text" | "thinking" | "tool_use" | "tool_result"
  | "image" | "reference" | "partial_reference"
  | "web_search_use" | "web_search_result"
```

### Store interface matches real data flow
The thread store exposes two data paths:

```ts
interface ThreadStoreInterface {
  // REST — paginated turn history
  loadThread(threadId: string, fromTurnId?: string): Promise<void>
  paginateBefore(): Promise<void>
  paginateAfter(): Promise<void>
  switchSibling(turnId: string): Promise<void>

  // SSE — active streaming turn
  connectStream(threadId: string, turnId: string): void
  disconnectStream(): void

  // State
  turns: ThreadTurn[]              // active path, ordered
  turnById: Record<string, ThreadTurn>
  activeTurnId: string | null      // currently streaming turn
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  isStreaming: boolean
}
```

The Storybook simulator mocks this interface with in-memory data + timeline playback. Production implements it with real fetch + EventSource.

### Turn mapper
```ts
// Maps backend Turn+TurnBlocks → ThreadTurn
// For assistant turns: groups tool_use + tool_result blocks into ToolItems,
//   maps text/thinking blocks to ContentItem/ThinkingItem → ActivityBlockData
// For user turns: preserves blocks as TurnBlock[] (text, image, reference, tool_result)
// For system turns: preserves blocks as systemBlocks[]
function mapTurnToViewModel(turn: BackendTurn): ThreadTurn
```

### Status metadata
ThreadTurn carries the full TurnStatus enum from the backend. ActivityBlockData gains status-derived fields set by the mapper or stream adapter:
- `error` / `isCancelled` (already added)
- `status` field on ThreadTurn drives rendering decisions in TurnRow/Phase 4

## Dependencies
- Requires: existing ActivityBlockData, ActivityItem types
- Independent of: all other phases

## Verification Criteria
- [ ] `pnpm exec tsc --noEmit` passes
- [ ] ThreadTurn can represent all backend TurnStatus values
- [ ] User turns with image/reference blocks are representable (not just string)
- [ ] System turns with compaction markers are representable
- [ ] Mapper correctly pairs tool_use + tool_result blocks by tool_use_id
- [ ] Store interface has both REST (pagination) and SSE (streaming) paths
- [ ] Store interface doesn't leak Storybook-only concepts (no USER_MESSAGE event)
