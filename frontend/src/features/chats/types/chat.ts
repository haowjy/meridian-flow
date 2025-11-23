export interface Chat {
  id: string
  projectId: string
  title: string
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
  createdAt: Date
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
}
