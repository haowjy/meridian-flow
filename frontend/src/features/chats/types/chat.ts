export interface Chat {
  id: string
  projectId: string
  title: string
  createdAt: Date
  updatedAt: Date
}

export interface Turn {
  id: string
  chatId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  lastAccessedAt?: Date // For cache eviction (future feature)
}
