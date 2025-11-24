import type { ContextMenuItemConfig } from '@/shared/components/TreeItemWithContextMenu'

/**
 * Menu builder utilities for document tree context menus.
 * Centralized menu logic following SOLID principles.
 */

interface DocumentMenuHandlers {
  onRename?: () => void
  onDelete?: () => void
  onAddAsReference?: () => void
}

interface FolderMenuHandlers {
  onCreateDocument?: () => void
  onCreateFolder?: () => void
  onRename?: () => void
  onDelete?: () => void
}

interface RootMenuHandlers {
  onCreateDocument?: () => void
  onCreateFolder?: () => void
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
): ContextMenuItemConfig[] {
  const items: ContextMenuItemConfig[] = []

  if (handlers.onAddAsReference) {
    items.push({
      id: 'add-reference',
      label: 'Add as reference',
      onSelect: handlers.onAddAsReference,
      separator: 'after',
    })
  }

  if (handlers.onRename) {
    items.push({
      id: 'rename',
      label: 'Rename',
      onSelect: handlers.onRename,
    })
  }

  if (handlers.onDelete) {
    items.push({
      id: 'delete',
      label: 'Delete',
      onSelect: handlers.onDelete,
      variant: 'destructive',
      separator: 'before',
    })
  }

  return items
}

/**
 * Creates context menu items for folder tree items.
 * Menu structure:
 * - New Document
 * - New Folder
 * - --- separator ---
 * - Rename
 * - --- separator ---
 * - Delete (destructive)
 */
export function createFolderMenuItems(
  handlers: FolderMenuHandlers
): ContextMenuItemConfig[] {
  const items: ContextMenuItemConfig[] = []

  const hasCreateActions = handlers.onCreateDocument || handlers.onCreateFolder

  if (handlers.onCreateDocument) {
    items.push({
      id: 'new-document',
      label: 'New Document',
      onSelect: handlers.onCreateDocument,
    })
  }

  if (handlers.onCreateFolder) {
    items.push({
      id: 'new-folder',
      label: 'New Folder',
      onSelect: handlers.onCreateFolder,
    })
  }

  if (handlers.onRename) {
    items.push({
      id: 'rename',
      label: 'Rename',
      onSelect: handlers.onRename,
      separator: hasCreateActions ? 'before' : undefined,
    })
  }

  if (handlers.onDelete) {
    items.push({
      id: 'delete',
      label: 'Delete',
      onSelect: handlers.onDelete,
      variant: 'destructive',
      separator: 'before',
    })
  }

  return items
}

/**
 * Creates context menu items for root-level (tree panel background).
 * Menu structure:
 * - New Document
 * - New Folder
 */
export function createRootMenuItems(
  handlers: RootMenuHandlers
): ContextMenuItemConfig[] {
  const items: ContextMenuItemConfig[] = []

  if (handlers.onCreateDocument) {
    items.push({
      id: 'new-document',
      label: 'New Document',
      onSelect: handlers.onCreateDocument,
    })
  }

  if (handlers.onCreateFolder) {
    items.push({
      id: 'new-folder',
      label: 'New Folder',
      onSelect: handlers.onCreateFolder,
    })
  }

  return items
}
