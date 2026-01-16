import { FileText, FileType, Folder, FolderOpen, type LucideIcon } from 'lucide-react'
import type { TreeNode } from '@/core/lib/treeBuilder'

/**
 * Pure function to resolve file extension to icon.
 * Follows SRP: only handles icon mapping.
 * Follows OCP: easy to extend with new mappings without modifying tree items.
 *
 * @param extension - File extension (e.g., ".md", ".txt")
 * @returns Lucide icon component
 *
 * @example
 * const Icon = getFileIcon('.md')
 * <Icon className="size-3.5" />
 */
export function getFileIcon(extension: string): LucideIcon {
  const iconMap: Record<string, LucideIcon> = {
    '.md': FileText,
    '.txt': FileType,
    // Easy to extend with more file types:
    // '.json': FileCode,
    // '.pdf': FileType,
    // etc.
  }

  return iconMap[extension] || FileText // Default fallback
}

/**
 * Get icon for tree node (documents or folders).
 * Folders use dynamic icon based on expanded state.
 *
 * @param node - Tree node (document or folder)
 * @param isExpanded - Whether folder is expanded (only used for folders)
 * @returns Lucide icon component
 *
 * @example
 * // For document
 * const Icon = getTreeNodeIcon({ type: 'document', data: { extension: '.md', ... } })
 *
 * // For folder
 * const Icon = getTreeNodeIcon({ type: 'folder', ... }, isExpanded)
 */
export function getTreeNodeIcon(node: TreeNode, isExpanded?: boolean): LucideIcon {
  if (node.type === 'folder') {
    return isExpanded ? FolderOpen : Folder
  }
  return getFileIcon(node.data.extension)
}
