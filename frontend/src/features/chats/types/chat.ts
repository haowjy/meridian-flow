export interface Chat {
  id: string
  projectId: string
  title: string
  createdAt: Date
  updatedAt: Date
}

export interface TurnBlock {
  id: string
  turnId: string
  blockType: string
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
  // Convenience: derived plain-text content from text blocks (legacy UI expects this)
  content: string
  lastAccessedAt?: Date
}
