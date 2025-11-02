/**
 * Chat domain types (camelCase, Date objects).
 */

export interface Chat {
  id: string
  projectId: string
  title: string
  createdAt: Date
  updatedAt: Date
}

export interface Message {
  id: string
  chatId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
}
