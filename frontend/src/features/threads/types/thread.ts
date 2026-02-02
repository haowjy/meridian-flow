export interface Thread {
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

/**
 * DTO matching backend response (snake_case).
 * Used in SSE event handlers when receiving data from the server.
 */
export interface ToolBlockContentDto {
  tool_use_id?: string
  tool_name?: string
  input?: Record<string, unknown>
  is_error?: boolean
  [key: string]: unknown
}

/**
 * Internal type (camelCase) for frontend usage.
 * All component code should use this type.
 */
export interface ToolBlockContent {
  toolUseId?: string
  toolName?: string
  input?: Record<string, unknown>
  isError?: boolean
  [key: string]: unknown
}

/**
 * Maps backend DTO to internal camelCase type.
 * Call this in SSE event handlers when receiving tool block content.
 */
export function fromToolBlockContentDto(dto: ToolBlockContentDto): ToolBlockContent {
  // Spread to copy any additional properties, then override with camelCase versions
  const { tool_use_id, tool_name, is_error, ...rest } = dto
  return {
    ...rest,
    toolUseId: tool_use_id,
    toolName: tool_name,
    isError: is_error,
  }
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
  threadId: string
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
  /** Response metadata from the LLM provider (upstream_provider, stop_reason, cache tokens, etc.) */
  responseMetadata?: Record<string, unknown>
}

/**
 * Response from POST /api/turns
 * If a new thread was created (cold start), thread field is populated
 */
export interface SendTurnResponse {
  thread?: Thread // Only populated on cold start (new thread created)
  userTurn: Turn
  assistantTurn: Turn
  streamUrl: string
}
