import { ChevronLeft, ChevronRight, Eye, FolderOpen, Pencil } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/lib/utils'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useNavigationStore } from '@/core/stores/useNavigationStore'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { navigateBack, navigateForward } from '@/core/lib/panelHelpers'
import { buildBreadcrumbs, formatBreadcrumbs } from '@/core/lib/breadcrumbBuilder'
import type { Document } from '@/features/documents/types/document'
import { SegmentedIconToggle } from '@/shared/components/SegmentedIconToggle'

interface EditorHeaderProps {
  document: Document
}

/**
 * Compact editor header with navigation and folder breadcrumbs.
 * Layout: [Back] | [Folder Breadcrumbs] | [Read/Edit Toggle] | [Close]
 * Note: Document name now shown separately in EditorTitle component
 */
export function EditorHeader({ document }: EditorHeaderProps) {
  const router = useRouter()
  const folders = useTreeStore((state) => state.folders)
  const editorReadOnly = useUIStore((state) => state.editorReadOnly)
  const setEditorReadOnly = useUIStore((state) => state.setEditorReadOnly)
  const canGoBack = useNavigationStore((state) => state.canGoBack)
  const canGoForward = useNavigationStore((state) => state.canGoForward)
  const currentProjectId = useProjectStore((state) => state.currentProjectId)

  // Build folder breadcrumbs (document name shown separately now)
  const breadcrumbSegments = buildBreadcrumbs(document.folderId, folders, 3)
  const breadcrumbPath = formatBreadcrumbs(breadcrumbSegments) || 'Project Root'

  const handleExploreDocuments = () => {
    // Just toggle view to show tree without navigating URL or affecting history
    useUIStore.getState().setRightPanelState('documents')
  }

  const handleNavigateBack = () => {
    if (currentProjectId) {
      navigateBack(currentProjectId, router)
    }
  }

  const handleNavigateForward = () => {
    if (currentProjectId) {
      navigateForward(currentProjectId, router)
    }
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

      {/* Custom navigation buttons (back/forward, skips tree visits) */}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleNavigateBack}
          disabled={!canGoBack}
          aria-label="Navigate to previous document"
          className="h-8 w-8"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleNavigateForward}
          disabled={!canGoForward}
          aria-label="Navigate to next document"
          className="h-8 w-8"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

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
