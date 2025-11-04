import { FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Document } from '../types/document'

interface DocumentTreeItemProps {
  document: Document
  isActive: boolean
  onClick: () => void
}

/**
 * Clickable document leaf node in tree.
 * Highlights when active, shows document icon.
 */
export function DocumentTreeItem({ document, isActive, onClick }: DocumentTreeItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        isActive && 'bg-accent font-medium text-accent-foreground'
      )}
      aria-label={`Open document: ${document.name}`}
      aria-current={isActive ? 'page' : undefined}
    >
      <FileText className="h-4 w-4 flex-shrink-0" />
      <span className="truncate">{document.name}</span>
    </button>
  )
}
