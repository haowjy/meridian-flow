/**
 * Tree utility functions for selection and traversal operations.
 */

import type { TreeNode } from './treeBuilder'

/**
 * Returns canonical selection: items where no ancestor is also selected.
 *
 * When a folder and its children are both selected, we only want the folder
 * (deleting it will delete children automatically). This prevents double-counting
 * and 404 errors when bulk deleting.
 *
 * @param tree - The tree structure to traverse
 * @param selectedIds - Set of selected node IDs
 * @returns Array of TreeNodes representing canonical selection
 */
export function canonicalizeSelection(
  tree: TreeNode[],
  selectedIds: Set<string>
): TreeNode[] {
  const result: TreeNode[] = []

  const collect = (nodes: TreeNode[], ancestorSelected: boolean) => {
    for (const node of nodes) {
      const isSelected = selectedIds.has(node.id)

      // Only include if selected AND no ancestor is selected
      if (isSelected && !ancestorSelected) {
        result.push(node)
      }

      // Recurse into folder children
      if (node.type === 'folder' && node.children) {
        collect(node.children, ancestorSelected || isSelected)
      }
    }
  }

  collect(tree, false)
  return result
}

/**
 * Get all descendant document IDs within a folder (recursive).
 *
 * Used for cleanup before folder deletion - we need to cancel pending retries
 * and clear IndexedDB cache for all documents that will be cascade-deleted.
 *
 * @param tree - The tree structure to search
 * @param folderId - The folder ID to find descendants for
 * @returns Array of document IDs
 */
export function getDescendantDocumentIds(
  tree: TreeNode[],
  folderId: string
): string[] {
  const documentIds: string[] = []

  // First, find the folder node
  const findFolder = (nodes: TreeNode[]): TreeNode | null => {
    for (const node of nodes) {
      if (node.type === 'folder') {
        if (node.id === folderId) {
          return node
        }
        if (node.children) {
          const found = findFolder(node.children)
          if (found) return found
        }
      }
    }
    return null
  }

  const folder = findFolder(tree)
  if (!folder || folder.type !== 'folder') {
    return documentIds
  }

  // Collect all document IDs recursively from the folder's children
  const collectDocuments = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.type === 'document') {
        documentIds.push(node.id)
      } else if (node.type === 'folder' && node.children) {
        collectDocuments(node.children)
      }
    }
  }

  if (folder.children) {
    collectDocuments(folder.children)
  }

  return documentIds
}
