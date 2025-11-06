import { describe, it, expect, vi, beforeEach } from 'vitest'
import { documentSyncService } from '@/core/services/documentSyncService'
import { AppError, ErrorType } from '@/core/lib/errors'

// Mock db module (Dexie)
vi.mock('@/core/lib/db', () => {
  return {
    db: {
      documents: {
        update: vi.fn(async () => 1),
        put: vi.fn(async () => void 0),
      },
    },
  }
})

// Mock sync module (network)
vi.mock('@/core/lib/sync', async () => {
  return {
    syncDocument: vi.fn(async (id: string, content: string) => ({ id, projectId: 'p', folderId: null, name: 'n', content, updatedAt: new Date() })),
    addRetryOperation: vi.fn(),
    cancelRetry: vi.fn(),
  }
})

// Re-import with mocks bound
import { db } from '@/core/lib/db'
import { syncDocument, addRetryOperation, cancelRetry } from '@/core/lib/sync'

describe('DocumentSyncService.save', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('optimistically updates DB and applies server doc on success', async () => {
    const onServerSaved = vi.fn()
    await documentSyncService.save('d1', '<p>x</p>', { id: 'd1', projectId: 'p', folderId: null, name: 'n', content: '', updatedAt: new Date() }, { onServerSaved })

    expect(cancelRetry).toHaveBeenCalledWith('d1')
    expect(db.documents.update).toHaveBeenCalled()
    expect(syncDocument).toHaveBeenCalledWith('d1', '<p>x</p>')
    expect(onServerSaved).toHaveBeenCalled()
  })

  it('queues retry on network/server error and calls onRetryScheduled', async () => {
    ;(syncDocument as any).mockImplementationOnce(async () => {
      throw new AppError(ErrorType.ServerError, '5xx')
    })

    const onRetryScheduled = vi.fn()
    await documentSyncService.save('d2', '<p>y</p>', { id: 'd2', projectId: 'p', folderId: null, name: 'n', content: '', updatedAt: new Date() }, { onRetryScheduled })

    expect(addRetryOperation).toHaveBeenCalled()
    expect(onRetryScheduled).toHaveBeenCalled()
  })

  it('bubbles client errors (validation) to caller', async () => {
    ;(syncDocument as any).mockImplementationOnce(async () => {
      throw new AppError(ErrorType.Validation, 'bad')
    })

    await expect(
      documentSyncService.save('d3', '<p>z</p>', { id: 'd3', projectId: 'p', folderId: null, name: 'n', content: '', updatedAt: new Date() })
    ).rejects.toBeInstanceOf(AppError)
  })
})

