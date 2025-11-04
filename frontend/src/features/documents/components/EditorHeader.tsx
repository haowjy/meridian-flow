import { ArrowLeft, Eye, Pencil } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/lib/utils'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useCollapsiblePanel } from '@/shared/components/layout/CollapsiblePanelContext'
import { closeEditor } from '@/core/lib/panelHelpers'
import { buildBreadcrumbs, formatBreadcrumbs } from '@/core/lib/breadcrumbBuilder'
import type { Document } from '@/features/documents/types/document'

interface EditorHeaderProps {
  document: Document
}

/**
 * Compact editor header with navigation and breadcrumbs.
 * Layout: [Back] | [Breadcrumbs / Document Name] | [Read/Edit Toggle] | [Close]
 */
export function EditorHeader({ document }: EditorHeaderProps) {
  const folders = useTreeStore((state) => state.folders)
  const editorReadOnly = useUIStore((state) => state.editorReadOnly)
  const toggleEditorReadOnly = useUIStore((state) => state.toggleEditorReadOnly)
  const { CollapseButton } = useCollapsiblePanel()

  // Build folder breadcrumbs
  const breadcrumbSegments = buildBreadcrumbs(document.folderId, folders, 3)
  const breadcrumbPath = formatBreadcrumbs(breadcrumbSegments)

  // Combine breadcrumbs with document name
  const fullPath = breadcrumbPath
    ? `${breadcrumbPath} / ${document.name}`
    : document.name

  const handleBack = () => {
    closeEditor()
  }

  const handleToggleMode = () => {
    toggleEditorReadOnly()
  }

  return (
    <div className={cn(
      "flex items-center gap-2 border-b px-2 py-2",
      editorReadOnly && "bg-muted/20"
    )}>
      {/* Back button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={handleBack}
        aria-label="Back to document tree"
        className="h-8 w-8 flex-shrink-0"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>

      {/* Breadcrumbs */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={fullPath}>
          {fullPath}
        </p>
      </div>

      {/* Read/Edit mode toggle */}
      <Button
        variant="ghost"
        size="sm"
        onClick={handleToggleMode}
        aria-label={editorReadOnly ? 'Switch to edit mode' : 'Switch to read-only mode'}
        className={editorReadOnly
          ? "h-8 gap-1.5 flex-shrink-0 bg-blue-100 text-blue-700 hover:bg-blue-200"
          : "h-8 gap-1.5 flex-shrink-0 bg-amber-100 text-amber-700 hover:bg-amber-200"
        }
      >
        {editorReadOnly ? (
          <>
            <Eye className="h-4 w-4" />
            <span className="text-xs font-medium">Read</span>
          </>
        ) : (
          <>
            <Pencil className="h-4 w-4" />
            <span className="text-xs font-medium">Edit</span>
          </>
        )}
      </Button>

      {/* Collapse button from panel context */}
      <CollapseButton />
    </div>
  )
}
