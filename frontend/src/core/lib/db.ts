import Dexie, { Table } from 'dexie'
import { Document } from '@/features/documents/types/document'

export interface SyncQueueItem {
  id?: number
  operation: 'create' | 'update' | 'delete'
  documentId: string
  data: Record<string, unknown>  // Generic object for sync data
  retryCount: number
  createdAt: Date
}

export class MeridianDB extends Dexie {
  documents!: Table<Document & { content: string }, string>
  syncQueue!: Table<SyncQueueItem, number>

  constructor() {
    super('meridian')

    this.version(1).stores({
      documents: 'id, projectId, folderId, updatedAt',
      syncQueue: '++id, documentId, createdAt',
    })
  }
}

export const db = new MeridianDB()
