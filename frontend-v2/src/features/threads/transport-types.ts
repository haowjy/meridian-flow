// ═══════════════════════════════════════════════════════════════════
// Transport types — store interface + raw backend response shapes
//
// Defines the contract between the thread store and consumers.
// Two data paths: REST for paginated history, plus streaming state.
//
// BackendTurn / BackendTurnBlock are camelCase JSON shapes after
// fetchAPI normalization, before mapping through turn-mapper.ts.
// ═══════════════════════════════════════════════════════════════════

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

