import { useState, ReactNode, DragEvent } from 'react'
import { FileText, Folder, Plus, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { TreeItemWithContextMenu } from '@/shared/components/TreeItemWithContextMenu'
import { createRootMenuItems } from '../utils/menuBuilders'
import { DocumentHeaderBar } from './DocumentHeaderBar'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'
import { CompactBreadcrumb } from '@/shared/components/ui/CompactBreadcrumb'

interface DocumentTreePanelProps {
  children: ReactNode
  onCreateDocument: () => void
  onCreateFolder?: () => void
  onImport?: () => void
  onFileDrop?: (files: File[]) => void
  onSearch?: (query: string) => void
  isEmpty?: boolean
  title?: string
}

/**
 * Document tree presentation component.
 * Shows header, search bar, scrollable tree, and empty state.
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
  title,
}: DocumentTreePanelProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)

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

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <DocumentHeaderBar
        title={<CompactBreadcrumb segments={[{ label: title ?? 'Project', title }]} singleSegmentVariant="nonLast" />}
        ariaLabel="Documents explorer header"
        showDivider={false}
        trailing={<SidebarToggle side="right" />}
      />

      {/* Search Bar */}
      <div className="px-3 py-1.5">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Input
              type="search"
              placeholder="Search documents..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className=""
              aria-label="Search documents by name"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" aria-label="Create new item">
                <Plus className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onCreateDocument}>
                <FileText className="mr-1 size-4" />
                New document
              </DropdownMenuItem>
              {onCreateFolder && (
                <DropdownMenuItem onClick={onCreateFolder}>
                  <Folder className="mr-1 size-4" />
                  New folder
                </DropdownMenuItem>
              )}
              {onImport && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onImport}>
                    <Upload className="mr-1 size-4" />
                    Import...
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Tree Content */}
      {isEmpty ? (
        <div className="flex-1 flex flex-col items-center px-4 pt-4 gap-4">
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
        <ScrollArea className="flex-1 min-h-0">
          <TreeItemWithContextMenu menuItems={rootMenuItems}>
            <div className="space-y-0.5 px-2 pt-2 pb-[50vh]">{children}</div>
          </TreeItemWithContextMenu>
        </ScrollArea>
      )}
    </div>
  )
}
