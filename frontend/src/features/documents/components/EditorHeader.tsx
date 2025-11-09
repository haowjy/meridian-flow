import { Eye, FolderOpen, Pencil } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/lib/utils'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { buildBreadcrumbs, formatBreadcrumbs } from '@/core/lib/breadcrumbBuilder'
import type { Document } from '@/features/documents/types/document'
import { SegmentedIconToggle } from '@/shared/components/SegmentedIconToggle'

interface EditorHeaderProps {
  document: Document
}

/**
 * Compact editor header with folder breadcrumbs and view toggle.
 * Layout: [Folder Icon] | [Folder Breadcrumbs] | [Read/Edit Toggle]
 * Note: Document name now shown separately in EditorTitle component
 */
export function EditorHeader({ document }: EditorHeaderProps) {
  const folders = useTreeStore((state) => state.folders)
  const editorReadOnly = useUIStore((state) => state.editorReadOnly)
  const setEditorReadOnly = useUIStore((state) => state.setEditorReadOnly)

  // Build folder breadcrumbs (document name shown separately now)
  const breadcrumbSegments = buildBreadcrumbs(document.folderId, folders, 3)
  const breadcrumbPath = formatBreadcrumbs(breadcrumbSegments) || 'Project Root'

  const handleExploreDocuments = () => {
    // Just toggle view to show tree without navigating URL or affecting history
    useUIStore.getState().setRightPanelState('documents')
  }

  return (
    <div className={cn(
      "flex items-center gap-2 border-b px-2 py-2",
      editorReadOnly && "bg-muted/20"
    )}>
      {/* Explore documents tree button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={handleExploreDocuments}
        aria-label="Explore document tree"
        className="h-8 w-8 flex-shrink-0"
      >
        <FolderOpen className="h-4 w-4" />
      </Button>

      {/* Folder breadcrumbs only (document name shown separately below) */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-muted-foreground" title={breadcrumbPath}>
          {breadcrumbPath}
        </p>
      </div>

      {/* Read/Edit segmented icon toggle */}
      <SegmentedIconToggle
        value={editorReadOnly ? 0 : 1}
        onChange={(v) => setEditorReadOnly(v === 0)}
        leftIcon={<Eye className="h-4 w-4" />}
        rightIcon={<Pencil className="h-4 w-4" />}
        leftTitle="Read-only"
        rightTitle="Edit"
      />

      {/* Sidebar collapse/expand is controlled from center panel toggles */}
    </div>
  )
}
