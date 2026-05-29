// ═══════════════════════════════════════════════════════════════════
// Transport types — store interface + raw backend response shapes
//
// Defines the contract between the thread store and consumers.
// Two data paths: REST for paginated history, plus streaming state.
//
// BackendTurn / BackendTurnBlock are camelCase JSON shapes after
// fetchAPI normalization, before mapping through turn-mapper.ts.
// ═══════════════════════════════════════════════════════════════════

import type { ThreadTurn } from "./types"

// --- Raw backend response types (camelCase from REST API) ---

/**
 * Raw turn block from the backend API (after fetchAPI camelCase conversion).
 */
export type BackendTurnBlock = {
  id: string
  turnId: string
  blockType: string
  sequence: number
  textContent?: string | null
  content?: Record<string, unknown> | null
  provider?: string | null
  providerData?: unknown | null
  executionSide?: string | null
  status: string
  collapsedContent?: string | null
  createdAt: string
  updatedAt?: string | null
}

/**
 * Raw turn from the backend API (after fetchAPI camelCase conversion).
 */
export type BackendTurn = {
  id: string
  threadId: string
  prevTurnId?: string | null
  role: string
  status: string
  error?: string | null
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  createdAt: string
  completedAt?: string | null
  requestParams?: Record<string, unknown> | null
  stopReason?: string | null
  responseMetadata?: Record<string, unknown> | null
  blocks?: BackendTurnBlock[] | null
  siblingIds?: string[] | null
}

/**
 * Paginated turns response from GET /api/threads/{id}/turns.
 */
export type PaginatedTurnsResponse = {
  turns: BackendTurn[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

// --- Thread store state ---

export type ThreadStoreState = {
  /** Active-path turns, ordered oldest → newest */
  turns: ThreadTurn[]
  /** Lookup by turn ID for O(1) access */
  turnById: Record<string, ThreadTurn>
  /** Currently streaming turn */
  activeTurnId: string | null
  /** Can paginate backwards (older turns exist) */
  hasMoreBefore: boolean
  /** Can paginate forwards (newer turns exist) */
  hasMoreAfter: boolean
  /** Streaming is active */
  isStreaming: boolean
}

// --- Thread store interface ---

/**
 * Store contract for thread data.
 *
 * Core data operations:
 * - paginated history (loadThread, paginateBefore/After, switchSibling)
 * - streaming state exposure via ThreadStoreState
 *
 * Implementations: production (real data), Storybook (in-memory mock).
 */
export type ThreadStoreInterface = {
  // REST — paginated turn history
  loadThread(threadId: string, fromTurnId?: string): Promise<void>
  paginateBefore(): Promise<void>
  paginateAfter(): Promise<void>
  /** Navigate to a different sibling turn. The thread reloads the path from this turn forward. */
  switchSibling(targetTurnId: string): Promise<void>

  // State
  readonly state: ThreadStoreState
}
