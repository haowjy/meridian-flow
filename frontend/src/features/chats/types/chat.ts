export interface Chat {
  id: string
  projectId: string
  title: string
  lastViewedTurnId: string | null
  createdAt: Date
  updatedAt: Date
}

// Normalized block types emitted by the backend.
export type BlockType =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'image'
  | 'reference'
  | 'partial_reference'
  | 'web_search_use'
  | 'web_search_result'

export interface ToolBlockContent {
  tool_use_id?: string
  tool_name?: string
  input?: Record<string, unknown>
  is_error?: boolean
  [key: string]: unknown
}

export interface TurnBlock {
  id: string
  turnId: string
  blockType: BlockType
  sequence: number
  textContent?: string
  content?: Record<string, unknown>
  status?: 'complete' | 'partial' // partial = interrupted during streaming
  createdAt: Date
  updatedAt?: Date
}

/**
 * Request parameters stored with each turn.
 * Used to restore original settings when editing/regenerating turns.
 */
export interface RequestParams {
  provider?: string
  model?: string
  temperature?: number
  max_tokens?: number
  thinking_enabled?: boolean
  thinking_level?: 'low' | 'medium' | 'high'
  // Additional params can be accessed via the Record type
  [key: string]: unknown
}

export interface Turn {
  id: string
  chatId: string
  prevTurnId: string | null
  role: 'user' | 'assistant'
  status: string
  error?: string | null
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  createdAt: Date
  completedAt?: Date | null
  siblingIds: string[]
  blocks: TurnBlock[]
  lastAccessedAt?: Date
  /** Original request params used for this turn (provider, model, thinking, etc.) */
  requestParams?: RequestParams | null
}

/**
 * Response from POST /api/turns
 * If a new chat was created (cold start), chat field is populated
 */
export interface SendTurnResponse {
  chat?: Chat // Only populated on cold start (new chat created)
  userTurn: Turn
  assistantTurn: Turn
  streamUrl: string
}
