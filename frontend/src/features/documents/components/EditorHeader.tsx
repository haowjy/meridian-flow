import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { buildBreadcrumbs } from '@/core/lib/breadcrumbBuilder'
import type { Document } from '@/features/documents/types/document'
import { DocumentHeaderBar } from './DocumentHeaderBar'
import { DocumentStatus } from './DocumentStatus'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { SidebarToggle } from '@/shared/components/layout/SidebarToggle'
import { MobileNavButton } from '@/shared/components/layout/MobileNavButton'
import { CompactBreadcrumb, type BreadcrumbSegment } from '@/shared/components/ui/CompactBreadcrumb'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'

interface EditorHeaderProps {
  document: Document
  wordCount?: number
  status?: SaveStatus
  lastSaved?: Date | null
}

/**
 * Compact editor header with breadcrumb and view toggle.
 * Layout: [Project / ... / Last Folder / File] | [Read/Edit Toggle]
 * Consistent style with explorer; no muted background in read-only.
 */
export function EditorHeader({ document, wordCount, status, lastSaved }: EditorHeaderProps) {
  const folders = useTreeStore((state) => state.folders)
  // Toggle moved into EditorToolbar pill
  const projectName = useProjectStore((s) =>
    s.projects.find((p) => p.id === document.projectId)?.name || s.currentProject()?.name || 'Project'
  )

  // Build full folder path; we'll display as: Project / ... / Last Folder / File.ext
  const fullFolderPath = buildBreadcrumbs(document.folderId, folders, 99)
  const fullPathTitle = [projectName, ...fullFolderPath.map((s) => s.name), document.filename].join(' / ')

  // User requested to show only the document filename to save space.
  // We still build the full path for the tooltip.
  const segments: BreadcrumbSegment[] = [
    { label: document.filename }
  ]

  const handleBackClick = () => {
    // Only swap the right panel back to the tree view.
    // URL remains on the document route so browser history is untouched.
    const store = useUIStore.getState()
    store.setRightPanelState('documents')
  }

  const handleBackToChat = () => {
    const store = useUIStore.getState()
    store.setMobileActivePanel('activeThread')
  }

  return (
    <DocumentHeaderBar
      leading={
        <div className="flex items-center">
          {/* Mobile: Back to thread (leftmost for quick access) */}
          <MobileNavButton
            icon="thread"
            onClick={handleBackToChat}
          />
          {/* Back to document tree */}
          <Button
            variant="ghost"
            size="icon"
            className="-ml-2 md:ml-0"
            onClick={handleBackClick}
            aria-label="Back to documents"
          >
            <ChevronLeft className="size-4.5" />
          </Button>
        </div>
      }
      title={
        <div title={fullPathTitle}>
          <CompactBreadcrumb segments={segments} />
        </div>
      }
      ariaLabel={`Breadcrumb: ${fullPathTitle}`}
      showDivider={false}
      trailing={
        <div className="flex items-center gap-3">
          {status && (
            <DocumentStatus
              wordCount={wordCount ?? 0}
              status={status}
              lastSaved={lastSaved ?? null}
            />
          )}
          <SidebarToggle side="right" />
        </div>
      }
    />
  )
}
