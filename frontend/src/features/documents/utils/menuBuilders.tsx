import { FileText, Folder, Upload, Pencil, Trash2, BookOpen } from 'lucide-react'
import type { ContextMenuItemConfig } from '@/shared/components/TreeItemWithContextMenu'

/**
 * Menu builder utilities for document tree context menus.
 * Centralized menu logic following SOLID principles.
 * Icons are included to ensure consistent UI across ContextMenu and DropdownMenu.
 */

interface DocumentMenuHandlers {
  onRename?: () => void
  onDelete?: () => void
  onAddAsReference?: () => void
}

interface FolderMenuHandlers {
  onCreateDocument?: () => void
  onCreateFolder?: () => void
  onImport?: () => void
  onRename?: () => void
  onDelete?: () => void
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
): ContextMenuItemConfig[] {
  const items: ContextMenuItemConfig[] = []

  if (handlers.onAddAsReference) {
    items.push({
      id: 'add-reference',
      label: 'Add as reference',
      icon: <BookOpen className="size-3.5" />,
      onSelect: handlers.onAddAsReference,
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
 * - Import Documents
 * - --- separator ---
 * - Rename
 * - --- separator ---
 * - Delete (destructive)
 */
export function createFolderMenuItems(
  handlers: FolderMenuHandlers
): ContextMenuItemConfig[] {
  const items: ContextMenuItemConfig[] = []

  const hasCreateActions = handlers.onCreateDocument || handlers.onCreateFolder || handlers.onImport

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

  if (handlers.onRename) {
    items.push({
      id: 'rename',
      label: 'Rename',
      icon: <Pencil className="size-3.5" />,
      onSelect: handlers.onRename,
      separator: hasCreateActions ? 'before' : undefined,
    })
  }

  if (handlers.onDelete) {
    items.push({
      id: 'delete',
      label: 'Delete',
      icon: <Trash2 className="size-3.5" />,
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
 * - Import Documents
 */
export function createRootMenuItems(
  handlers: RootMenuHandlers
): ContextMenuItemConfig[] {
  const items: ContextMenuItemConfig[] = []

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
