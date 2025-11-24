import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { buildBreadcrumbs } from '@/core/lib/breadcrumbBuilder'
import type { Document } from '@/features/documents/types/document'
import { DocumentHeaderBar } from './DocumentHeaderBar'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'
import { CompactBreadcrumb, type BreadcrumbSegment } from '@/shared/components/ui/CompactBreadcrumb'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'

interface EditorHeaderProps {
  document: Document
}

/**
 * Compact editor header with breadcrumb and view toggle.
 * Layout: [Project / ... / Last Folder / File] | [Read/Edit Toggle]
 * Consistent style with explorer; no muted background in read-only.
 */
export function EditorHeader({ document }: EditorHeaderProps) {
  const folders = useTreeStore((state) => state.folders)
  // Toggle moved into EditorToolbar pill
  const projectName = useProjectStore((s) =>
    s.projects.find((p) => p.id === document.projectId)?.name || s.currentProject()?.name || 'Project'
  )

  // Build full folder path; we'll display as: Project / ... / Last Folder / File
  const fullFolderPath = buildBreadcrumbs(document.folderId, folders, 99)
  const fullPathTitle = [projectName, ...fullFolderPath.map((s) => s.name), document.name].join(' / ')

  // User requested to show only the document name to save space.
  // We still build the full path for the tooltip.
  const segments: BreadcrumbSegment[] = [
    { label: document.name }
  ]

  const handleBackClick = () => {
    // Only swap the right panel back to the tree view.
    // URL remains on the document route so browser history is untouched.
    const store = useUIStore.getState()
    store.setRightPanelState('documents')
  }

  return (
    <DocumentHeaderBar
      leading={
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 -ml-1"
          onClick={handleBackClick}
          aria-label="Back to documents"
        >
          <ChevronLeft className="size-3" />
        </Button>
      }
      title={
        <div title={fullPathTitle}>
          <CompactBreadcrumb segments={segments} />
        </div>
      }
      ariaLabel={`Breadcrumb: ${fullPathTitle}`}
      showDivider={false}
      trailing={<SidebarToggle side="right" />}
    />
  )
}
