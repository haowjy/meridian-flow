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
        title={<h2 className="truncate text-sm font-semibold" title={title}>{title}</h2>}
        trailing={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={onCreateDocument}
              aria-label="Create new document"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        }
        ariaLabel="Documents explorer header"
        showDivider={false}
      />

      {/* Search Bar */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search documents..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-9"
            aria-label="Search documents by name"
          />
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
          <div className="space-y-1 p-4">{children}</div>
        </ScrollArea>
      )}
    </div>
  )
}
