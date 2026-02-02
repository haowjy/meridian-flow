import { PanelLeft } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { useUIStore } from '@/core/stores/useUIStore'
import { cn } from '@/lib/utils'

interface DocumentTreeToggleProps {
  className?: string
}

/**
 * Toggle button for document tree sidebar.
 * Shows when tree is collapsed, hides when expanded.
 * Uses PanelLeft icon to match SidebarToggle pattern.
 */
export function DocumentTreeToggle({ className }: DocumentTreeToggleProps) {
  const documentTreeCollapsed = useUIStore((s) => s.documentTreeCollapsed)
  const toggleDocumentTree = useUIStore((s) => s.toggleDocumentTree)

  const label = documentTreeCollapsed ? 'Show file explorer' : 'Hide file explorer'

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleDocumentTree}
      className={cn('hidden md:inline-flex', className)}
      aria-label={label}
      title={label}
    >
      <PanelLeft className="size-4" />
    </Button>
  )
}
