import { useProjectStore } from '@/core/stores/useProjectStore'
import { DocumentsToggle } from '@/shared/components/layout/DocumentsToggle'

interface ProjectHeaderProps {
  projectId: string
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
 */
export function ProjectHeader({ projectId }: ProjectHeaderProps) {
  // Get project name from store
  const projectName = useProjectStore((s) => {
    const project = s.projects.find((p) => p.id === projectId)
    return project?.name ?? 'Untitled Project'
  })

  return (
    <div
      role="region"
      aria-label="Project header"
      className="flex items-center gap-1 px-3 relative z-10 border-b border-border/50 bg-background"
      style={{ height: 'var(--panel-header-height)' }}
    >
      <div className="min-w-0 flex-1">
        <span className="font-medium text-sm truncate">
          {projectName}
        </span>
      </div>
      {/* Documents toggle - closes docs and returns to chat */}
      <DocumentsToggle direction="left" />
    </div>
  )
}
