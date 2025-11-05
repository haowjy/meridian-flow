import Dexie, { Table } from 'dexie'
import { Document } from '@/features/documents/types/document'
import { Chat, Message } from '@/features/chats/types'

export class MeridianDB extends Dexie {
  documents!: Table<Document & { content: string }, string>
  chats!: Table<Chat, string>
  messages!: Table<Message, string>

  constructor() {
    super('meridian')

    // Version 1: Initial schema (documents + syncQueue)
    this.version(1).stores({
      documents: 'id, projectId, folderId, updatedAt',
      syncQueue: '++id, documentId, createdAt',
    })

    // Version 2: Add chats and messages, upgrade syncQueue
    this.version(2).stores({
      documents: 'id, projectId, folderId, updatedAt',
      chats: 'id, projectId, createdAt',
      messages: 'id, chatId, createdAt',
      syncQueue: '++id, entityType, entityId, timestamp, retryCount',
    })

    // Version 3: Remove syncQueue (moved to in-memory retry system)
    this.version(3).stores({
      documents: 'id, projectId, folderId, updatedAt',
      chats: 'id, projectId, createdAt',
      messages: 'id, chatId, createdAt',
      syncQueue: null, // Delete the table
    })

    // Version 4: Add lastAccessedAt to messages for future eviction
    this.version(4).stores({
      documents: 'id, projectId, folderId, updatedAt',
      chats: 'id, projectId, createdAt',
      messages: 'id, chatId, createdAt, lastAccessedAt',
    })
  }
}

export const db = new MeridianDB()
