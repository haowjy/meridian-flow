import { useState, ReactNode, DragEvent } from 'react'
import { FileText, Folder, Plus, Upload, PanelLeft } from 'lucide-react'
import { HeaderGradientFade } from '@/core/components/HeaderGradientFade'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { useTreeSelection } from '../hooks/useTreeSelection'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { TreeItemWithContextMenu } from '@/shared/components/TreeItemWithContextMenu'
import { createRootMenuItems } from '../utils/menuBuilders'
import { BatchActionsBar } from './BatchActionsBar'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { BulkDeleteOperation } from '../operations/bulkDelete'
import type { TreeNode } from '@/core/lib/treeBuilder'
import { canonicalizeSelection } from '@/core/lib/treeUtils'
import type { BulkOperation } from '../operations/types'

interface DocumentTreePanelProps {
  children: ReactNode
  onCreateDocument: () => void
  onCreateFolder?: () => void
  onImport?: () => void
  onFileDrop?: (files: File[]) => void
  onSearch?: (query: string) => void
  isEmpty?: boolean
  projectId: string
  onBulkOperationComplete?: () => void
  // Safe delete callbacks from useResourceOperations
  // Handle navigation-away, cache cleanup, and retry cancellation
  deleteDocument: (id: string) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  // Mobile navigation: hamburger menu trigger (shown before "Documents" label on mobile)
  mobileMenuTrigger?: ReactNode
}

/**
 * Document tree presentation component.
 * Shows header with search/add, optional skills section, scrollable tree, and empty state.
 * Tree content passed as children (built by DocumentTreeContainer).
 */
export function DocumentTreePanel({
  children,
  onCreateDocument,
  onCreateFolder,
  onImport,
  onFileDrop,
  onSearch,
  isEmpty = false,
  projectId,
  onBulkOperationComplete,
  deleteDocument,
  deleteFolder,
  mobileMenuTrigger,
}: DocumentTreePanelProps) {
  const { selectedIds } = useTreeSelection()
  const tree = useTreeStore((s) => s.tree)
  const documentTreeCollapsed = useUIStore((s) => s.documentTreeCollapsed)
  const [searchQuery, setSearchQuery] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)
  const [pendingRootAction, setPendingRootAction] = useState<(() => void) | null>(null)

  // Get canonicalized selection: only items where no ancestor is also selected.
  // This prevents double-counting and 404 errors when bulk deleting a folder
  // and its contents (the folder delete will cascade to children).
  const getSelectedItems = (): TreeNode[] => {
    return canonicalizeSelection(tree, selectedIds)
  }

  // Register bulk operations
  const bulkOperations: BulkOperation[] = [
    new BulkDeleteOperation(),
    // Add more operations here as they're implemented
  ]

  const selectedItems = getSelectedItems()

  const handleSearchChange = (value: string) => {
    setSearchQuery(value)
    onSearch?.(value)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0 && onFileDrop) {
      onFileDrop(files)
    }
  }

  const rootMenuItems = createRootMenuItems({
    onCreateDocument,
    onCreateFolder,
    onImport,
  })

  const handleRootMenuOpenChange = (open: boolean) => {
    if (!open && pendingRootAction) {
      const action = pendingRootAction
      setPendingRootAction(null)
      action()
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Single scroll container - scrollbar extends to top */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        {/* Two-row sticky header: label+collapse top, search+create bottom */}
        <div className="sticky top-0 z-10 bg-background border-b border-border/50">
          {/* Row 1: Section label + collapse toggle (mobile: hamburger before label)
              Uses consistent h-14, px-3, gap-2 to match MobileHeader specs */}
          <div className="flex items-center h-14 px-3 gap-2 md:h-auto md:px-2 md:py-1.5">
            {/* Desktop collapse toggle on left - hidden on mobile */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => useUIStore.getState().toggleDocumentTree()}
              aria-label={documentTreeCollapsed ? 'Show file explorer' : 'Hide file explorer'}
              className="shrink-0 size-8 hidden md:flex"
            >
              <PanelLeft className="size-4" />
            </Button>

            <div className="flex items-center gap-2 md:gap-1">
              {/* Mobile hamburger menu trigger */}
              {mobileMenuTrigger && (
                <div className="md:hidden shrink-0">{mobileMenuTrigger}</div>
              )}
              <span className="font-medium text-sm">Documents</span>
            </div>
          </div>

          {/* Row 2: Search + action buttons (search → create flow) */}
          <div className="flex items-center gap-1.5 px-2 pb-1.5">
            <Input
              type="search"
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              size="sm"
              className="flex-1"
              aria-label="Search documents by name"
            />

            <DropdownMenu onOpenChange={handleRootMenuOpenChange}>
              <DropdownMenuTrigger asChild>
                <Button size="icon" aria-label="Create new item" className="shrink-0">
                  <Plus className="size-4 md:size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
                <DropdownMenuItem onClick={() => setPendingRootAction(() => onCreateDocument)}>
                  <FileText className="size-3.5 mr-2" />
                  New Document
                </DropdownMenuItem>
                {onCreateFolder && (
                  <DropdownMenuItem onClick={() => setPendingRootAction(() => onCreateFolder)}>
                    <Folder className="size-3.5 mr-2" />
                    New Folder
                  </DropdownMenuItem>
                )}
                {onImport && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setPendingRootAction(() => onImport)}>
                      <Upload className="size-3.5 mr-2" />
                      Import Files...
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <HeaderGradientFade />
        </div>

        {/* Tree Content */}
        {isEmpty ? (
          <div className="flex flex-col items-center px-4 pt-4 gap-4">
            {/* Dropzone */}
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={onImport}
              className={cn(
                'flex flex-col items-center justify-center gap-2 p-6 rounded-lg cursor-pointer transition-colors w-full',
                'border-2 border-dashed',
                isDragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30'
              )}
            >
              <Upload className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground text-center">
                Drop files to import
              </p>
            </div>

            {/* Divider with "or" */}
            <div className="flex items-center gap-3 w-full">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Create document button */}
            <Button variant="ghost" size="sm" onClick={onCreateDocument}>
              <FileText className="mr-2 size-4" />
              Create a document
            </Button>
          </div>
        ) : (
          <TreeItemWithContextMenu menuItems={rootMenuItems}>
            <div className="space-y-0.5 px-2 pt-2 pb-[50vh]">{children}</div>
          </TreeItemWithContextMenu>
        )}
      </div>

      {/* Batch Actions Bar - shown when items are selected */}
      {selectedItems.length > 0 && (
        <BatchActionsBar
          operations={bulkOperations}
          selectedItems={selectedItems}
          context={{
            projectId,
            deleteDocument,
            deleteFolder,
          }}
          onComplete={() => {
            onBulkOperationComplete?.()
          }}
        />
      )}
    </div>
  )
}
