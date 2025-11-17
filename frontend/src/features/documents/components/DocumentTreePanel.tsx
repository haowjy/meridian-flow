import { useState, ReactNode } from 'react'
import { Plus, Search } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { EmptyState } from '@/shared/components/EmptyState'
import { DocumentHeaderBar } from './DocumentHeaderBar'

interface DocumentTreePanelProps {
  children: ReactNode
  onCreateDocument: () => void
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
  onSearch,
  isEmpty = false,
  title,
}: DocumentTreePanelProps) {
  const [searchQuery, setSearchQuery] = useState('')

  const handleSearchChange = (value: string) => {
    setSearchQuery(value)
    onSearch?.(value)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <DocumentHeaderBar
        title={<div className="truncate text-lg font-semibold" title={title}>{title}</div>}
        ariaLabel="Documents explorer header"
        showDivider={false}
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
          <Button
            size="icon"
            onClick={onCreateDocument}
            aria-label="Create new document"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Tree Content */}
      {isEmpty ? (
        <EmptyState
          title="No documents yet"
          description="Create your first document to get started"
          action={{ label: 'Create Document', onClick: onCreateDocument }}
        />
      ) : (
        <ScrollArea className="flex-1">
          <div className="space-y-0.5 px-2 py-2">{children}</div>
        </ScrollArea>
      )}
    </div>
  )
}
