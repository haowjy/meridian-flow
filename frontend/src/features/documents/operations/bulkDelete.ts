import { Trash } from 'lucide-react'
import { createElement } from 'react'
import type { TreeNode } from '@/core/lib/treeBuilder'
import type { BulkOperation, OperationContext, OperationResult } from './types'

/**
 * Bulk delete operation for documents and folders.
 * Follows SRP: only handles delete logic.
 * Follows OCP: implements BulkOperation interface.
 */
export class BulkDeleteOperation implements BulkOperation {
  id = 'delete'
  label = 'Delete'
  icon = createElement(Trash, { className: 'size-3.5' })
  variant = 'destructive' as const

  canExecute(selectedItems: TreeNode[]): boolean {
    return selectedItems.length > 0
  }

  async execute(
    selectedItems: TreeNode[],
    { deleteDocument, deleteFolder, onProgress }: OperationContext
  ): Promise<OperationResult> {
    let successCount = 0
    let failedCount = 0
    const errors: string[] = []

    for (let i = 0; i < selectedItems.length; i++) {
      const item = selectedItems[i]!
      onProgress?.(i + 1, selectedItems.length)

      try {
        if (item.type === 'document') {
          await deleteDocument(item.id)
        } else {
          await deleteFolder(item.id)
        }
        successCount++
      } catch (error) {
        failedCount++
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        errors.push(`Failed to delete ${item.name}: ${errorMessage}`)
      }
    }

    return {
      success: failedCount === 0,
      successCount,
      failedCount,
      errors: errors.length > 0 ? errors : undefined,
    }
  }
}
