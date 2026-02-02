import { FileText, Folder, Upload, Pencil, Trash2, Info } from 'lucide-react'
import type { TreeMenuItemConfig } from '@/shared/components/TreeItemWithContextMenu'

/**
 * Menu builder utilities for document tree context menus.
 * Centralized menu logic following SOLID principles.
 * Icons are included to ensure consistent UI across ContextMenu and DropdownMenu.
 */

interface DocumentMenuHandlers {
  onRename?: () => void
  onDelete?: () => void
  onDetails?: () => void
}

interface FolderMenuHandlers {
  onCreateDocument?: () => void
  onCreateFolder?: () => void
  onImport?: () => void
  onRename?: () => void
  onDelete?: () => void
  onDetails?: () => void
}

interface RootMenuHandlers {
  onCreateDocument?: () => void
  onCreateFolder?: () => void
  onImport?: () => void
}

/**
 * Creates context menu items for document tree items.
 * Menu structure:
 * - Add as reference (if provided)
 * - Rename
 * - --- separator ---
 * - Delete (destructive)
 */
export function createDocumentMenuItems(
  handlers: DocumentMenuHandlers
): TreeMenuItemConfig[] {
  const items: TreeMenuItemConfig[] = []

  if (handlers.onDetails) {
    items.push({
      id: 'details',
      label: 'Details',
      icon: <Info className="size-3.5" />,
      onSelect: handlers.onDetails,
      separator: 'after',
    })
  }

  if (handlers.onRename) {
    items.push({
      id: 'rename',
      label: 'Rename',
      icon: <Pencil className="size-3.5" />,
      onSelect: handlers.onRename,
    })
  }

  if (handlers.onDelete) {
    items.push({
      id: 'delete',
      label: 'Delete',
      icon: <Trash2 className="size-3.5" />,
      onSelect: handlers.onDelete,
      variant: 'destructive',
    })
  }

  return items
}

/**
 * Creates context menu items for folder tree items.
 * Menu structure:
 * - New Document
 * - New Folder
 * - Import Documents
 * - --- separator ---
 * - Rename
 * - --- separator ---
 * - Delete (destructive)
 */
export function createFolderMenuItems(
  handlers: FolderMenuHandlers
): TreeMenuItemConfig[] {
  const items: TreeMenuItemConfig[] = []

  const hasCreateActions =
    handlers.onCreateDocument || handlers.onCreateFolder || handlers.onImport
  const hasBottomActions = handlers.onRename || handlers.onDelete

  if (handlers.onDetails) {
    items.push({
      id: 'details',
      label: 'Details',
      icon: <Info className="size-3.5" />,
      onSelect: handlers.onDetails,
      separator: hasCreateActions || hasBottomActions ? 'after' : undefined,
    })
  }

  const createItems: TreeMenuItemConfig[] = []

  if (handlers.onCreateDocument) {
    createItems.push({
      id: 'new-document',
      label: 'New Document',
      icon: <FileText className="size-3.5" />,
      onSelect: handlers.onCreateDocument,
    })
  }

  if (handlers.onCreateFolder) {
    createItems.push({
      id: 'new-folder',
      label: 'New Folder',
      icon: <Folder className="size-3.5" />,
      onSelect: handlers.onCreateFolder,
    })
  }

  if (handlers.onImport) {
    createItems.push({
      id: 'import-documents',
      label: 'Import Documents',
      icon: <Upload className="size-3.5" />,
      onSelect: handlers.onImport,
    })
  }

  if (createItems.length > 0) {
    const lastIndex = createItems.length - 1
    createItems[lastIndex]!.separator = hasBottomActions ? 'after' : undefined
    items.push(...createItems)
  }

  if (handlers.onRename) {
    items.push({
      id: 'rename',
      label: 'Rename',
      icon: <Pencil className="size-3.5" />,
      onSelect: handlers.onRename,
    })
  }

  if (handlers.onDelete) {
    items.push({
      id: 'delete',
      label: 'Delete',
      icon: <Trash2 className="size-3.5" />,
      onSelect: handlers.onDelete,
      variant: 'destructive',
    })
  }

  return items
}

/**
 * Creates context menu items for root-level (tree panel background).
 * Menu structure:
 * - New Document
 * - New Folder
 * - Import Documents
 */
export function createRootMenuItems(
  handlers: RootMenuHandlers
): TreeMenuItemConfig[] {
  const items: TreeMenuItemConfig[] = []

  if (handlers.onCreateDocument) {
    items.push({
      id: 'new-document',
      label: 'New Document',
      icon: <FileText className="size-3.5" />,
      onSelect: handlers.onCreateDocument,
    })
  }

  if (handlers.onCreateFolder) {
    items.push({
      id: 'new-folder',
      label: 'New Folder',
      icon: <Folder className="size-3.5" />,
      onSelect: handlers.onCreateFolder,
    })
  }

  if (handlers.onImport) {
    items.push({
      id: 'import-documents',
      label: 'Import Documents',
      icon: <Upload className="size-3.5" />,
      onSelect: handlers.onImport,
    })
  }

  return items
}
