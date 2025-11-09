import { Eye, Pencil } from 'lucide-react'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { buildBreadcrumbs } from '@/core/lib/breadcrumbBuilder'
import type { Document } from '@/features/documents/types/document'
import { SegmentedIconToggle } from '@/shared/components/SegmentedIconToggle'
import { DocumentHeaderBar } from './DocumentHeaderBar'
import { useProjectStore } from '@/core/stores/useProjectStore'

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
  const editorReadOnly = useUIStore((state) => state.editorReadOnly)
  const setEditorReadOnly = useUIStore((state) => state.setEditorReadOnly)
  const projectName = useProjectStore((s) =>
    s.projects.find((p) => p.id === document.projectId)?.name || s.currentProject()?.name || 'Project'
  )

  // Build full folder path; we'll display as: Project / ... / Last Folder / File
  const fullFolderPath = buildBreadcrumbs(document.folderId, folders, 99)
  const hasFolders = fullFolderPath.length > 0
  const hasDeepFolders = fullFolderPath.length > 1
  const lastFolderName = hasFolders ? fullFolderPath[fullFolderPath.length - 1]!.name : null
  const fullPathTitle = [projectName, ...fullFolderPath.map((s) => s.name), document.name].join(' / ')

  const handleProjectClick = () => {
    // Toggle view to show tree without touching URL/history or panel collapsed state
    const store = useUIStore.getState()
    store.setRightPanelState('documents')
  }

  return (
    <DocumentHeaderBar
      title={
        <div className="flex min-w-0 items-center gap-1 text-sm" title={fullPathTitle}>
          <button
            type="button"
            onClick={handleProjectClick}
            aria-label="Show document tree"
            title={projectName}
            className="font-semibold hover:underline truncate focus-visible:underline focus:outline-none"
          >
            {projectName}
          </button>
          <span className="mx-1 text-muted-foreground" aria-hidden="true">/</span>
          {hasDeepFolders && (
            <>
              <span className="text-muted-foreground">...</span>
              <span className="mx-1 text-muted-foreground" aria-hidden="true">/</span>
            </>
          )}
          {lastFolderName && (
            <>
              <span className="truncate text-muted-foreground" title={lastFolderName}>
                {lastFolderName}
              </span>
              <span className="mx-1 text-muted-foreground" aria-hidden="true">/</span>
            </>
          )}
          <span className="truncate" title={document.name}>
            {document.name}
          </span>
        </div>
      }
      trailing={
        <SegmentedIconToggle
          value={editorReadOnly ? 0 : 1}
          onChange={(v) => setEditorReadOnly(v === 0)}
          leftIcon={<Eye className="h-4 w-4" />}
          rightIcon={<Pencil className="h-4 w-4" />}
          leftTitle="Read-only"
          rightTitle="Edit"
        />
      }
      ariaLabel={`Breadcrumb: ${fullPathTitle}`}
      showDivider={false}
    />
  )
}
