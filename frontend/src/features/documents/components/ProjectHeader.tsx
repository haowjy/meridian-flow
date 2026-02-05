import { useNavigate } from '@tanstack/react-router'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { DocumentsToggle } from '@/shared/components/layout/DocumentsToggle'
import { closeEditor } from '@/core/lib/panelHelpers'

interface ProjectHeaderProps {
  projectId: string
  projectSlug: string
}

/**
 * Project-level header displayed at the top of the document panel.
 * Shows project title and provides access to project settings (future).
 *
 * This creates a unified "document zone" feel by having a shared header
 * above both the tree sidebar and editor.
 *
 *
 * Design Philosophy:
 * - Documents toggle appears here (far right) when docs panel is expanded
 * - Clicking closes docs and returns focus to chat
 * - ProjectHeader only renders when docs panel is visible, so no conditional needed
 * - Clicking project name navigates to project home (clears active document)
 */
export function ProjectHeader({ projectId, projectSlug }: ProjectHeaderProps) {
  const navigate = useNavigate()

  // Get project name from store
  const projectName = useProjectStore((s) => {
    const project = s.projects.find((p) => p.id === projectId)
    return project?.name ?? 'Untitled Project'
  })

  const handleProjectClick = () => {
    closeEditor(projectSlug, navigate)
  }

  return (
    <div
      role="region"
      aria-label="Project header"
      className="flex items-center gap-1 px-3 relative z-10 border-b border-border/50 bg-background"
      style={{ height: 'var(--panel-header-height)' }}
    >
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={handleProjectClick}
          className="font-medium text-sm truncate hover:text-foreground/80 transition-colors"
        >
          {projectName}
        </button>
      </div>
      {/* Documents toggle - closes docs and returns to chat */}
      <DocumentsToggle direction="left" />
    </div>
  )
}
