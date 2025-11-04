import type { Folder } from '@/features/folders/types/folder'
import type { Document } from '@/features/documents/types/document'
import type { FolderDto, DocumentDto } from '@/types/api'

/**
 * Hierarchical tree node for rendering folder/document structure.
 * Folders have children (recursive), documents are leaf nodes.
 *
 * This is a discriminated union - TypeScript can narrow the type based on the `type` field:
 * - if (node.type === 'folder') → node.data is Folder, node.children exists
 * - if (node.type === 'document') → node.data is Document, node.children is undefined
 */
export type TreeNode =
  | {
      type: 'folder'
      id: string
      name: string
      children?: TreeNode[]
      data: Folder
    }
  | {
      type: 'document'
      id: string
      name: string
      data: Document
    }

/**
 * Converts nested backend structure to TreeNode format.
 * Backend returns folders with nested folders/documents already built.
 *
 * @param foldersDto - Nested folders from backend /tree endpoint
 * @param documentsDto - Documents at this level
 * @returns TreeNode array ready for rendering
 */
export function convertNestedToTreeNodes(
  foldersDto: FolderDto[],
  documentsDto: DocumentDto[]
): TreeNode[] {
  const nodes: TreeNode[] = []

  // Convert folders (with their nested children)
  for (const folderDto of foldersDto) {
    const folder: Folder = {
      id: folderDto.id,
      projectId: folderDto.project_id,
      parentId: folderDto.parent_id,
      name: folderDto.name,
      createdAt: new Date(folderDto.created_at),
    }

    // Recursively convert nested children
    const children = convertNestedToTreeNodes(
      folderDto.folders || [],
      folderDto.documents || []
    )

    nodes.push({
      type: 'folder',
      id: folder.id,
      name: folder.name,
      data: folder,
      children: children.length > 0 ? children : undefined,
    })
  }

  // Convert documents at this level
  for (const docDto of documentsDto) {
    const document: Document = {
      id: docDto.id,
      projectId: docDto.project_id,
      folderId: docDto.folder_id,
      name: docDto.name,
      content: docDto.content,
      wordCount: docDto.word_count,
      updatedAt: new Date(docDto.updated_at),
    }

    nodes.push({
      type: 'document',
      id: document.id,
      name: document.name,
      data: document,
    })
  }

  // Sort: folders first, then documents, alphabetically within each type
  return nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/**
 * Builds hierarchical tree structure from flat folder/document arrays.
 *
 * Algorithm:
 * 1. Start with root items (parentId/folderId === null)
 * 2. Recursively find children for each folder
 * 3. Attach documents to their folders
 * 4. Sort: folders before documents, then alphabetically
 *
 * Performance: O(n) for typical flat structures
 *
 * @param folders - Flat array of folders from backend
 * @param documents - Flat array of documents from backend
 * @returns Nested tree structure ready for rendering
 */
export function buildTree(folders: Folder[], documents: Document[]): TreeNode[] {
  /**
   * Recursively find and build children for a given parent.
   * @param parentId - Folder ID to find children for, or null for root
   */
  function findChildren(parentId: string | null): TreeNode[] {
    // Find child folders
    const childFolders = folders
      .filter((folder) => folder.parentId === parentId)
      .map((folder) => ({
        type: 'folder' as const,
        id: folder.id,
        name: folder.name,
        data: folder,
        children: findChildren(folder.id), // Recursive call
      }))

    // Find documents in this folder
    const childDocuments = documents
      .filter((doc) => doc.folderId === parentId)
      .map((doc) => ({
        type: 'document' as const,
        id: doc.id,
        name: doc.name,
        data: doc,
      }))

    // Combine and sort: folders first, then alphabetically by name
    const combined = [...childFolders, ...childDocuments]

    return combined.sort((a, b) => {
      // Folders before documents
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1
      }
      // Alphabetical by name
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  }

  // Start at root level (parentId/folderId === null)
  return findChildren(null)
}

/**
 * Filters tree nodes by search query (case-insensitive name matching).
 * Folders are included if they contain matching documents or subfolders.
 *
 * @param tree - Tree structure to filter
 * @param query - Search query string
 * @returns Filtered tree (empty if no matches)
 */
export function filterTree(tree: TreeNode[], query: string): TreeNode[] {
  if (!query.trim()) {
    return tree
  }

  const lowerQuery = query.toLowerCase()

  function filterNode(node: TreeNode): TreeNode | null {
    // Documents: match by name
    if (node.type === 'document') {
      return node.name.toLowerCase().includes(lowerQuery) ? node : null
    }

    // Folders: match if name matches OR has matching children
    const filteredChildren = node.children
      ? node.children.map(filterNode).filter((n): n is TreeNode => n !== null)
      : []

    const nameMatches = node.name.toLowerCase().includes(lowerQuery)

    // Include folder if name matches OR has matching children
    if (nameMatches || filteredChildren.length > 0) {
      return {
        ...node,
        children: filteredChildren,
      }
    }

    return null
  }

  return tree.map(filterNode).filter((n): n is TreeNode => n !== null)
}
