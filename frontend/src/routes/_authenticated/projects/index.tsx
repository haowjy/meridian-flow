import { createFileRoute } from '@tanstack/react-router'
import { useState, useMemo, useCallback } from 'react'
import {
  CreateProjectDialog,
  FavoritesSection,
  ContinueWorkingSection,
  AllProjectsSection,
} from '@/features/projects'
import { Project } from '@/features/projects/types/project'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { useLoadingView } from '@/core/hooks'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { EmptyState } from '@/shared/components/EmptyState'
import { MobileTopHeader } from '@/shared/components/layout'
import { FileText, Plus } from 'lucide-react'
import { RenameProjectDialog } from '@/features/projects/components/RenameProjectDialog'
import { DeleteProjectDialog } from '@/features/projects/components/DeleteProjectDialog'
import { Button } from '@/shared/components/ui/button'

export const Route = createFileRoute('/_authenticated/projects/')({
  component: ProjectsPage,
})

function ProjectsPage() {
  const { projects, status, error, toggleFavorite, deleteProject, updateProject } = useProjectStore()

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [renameProject, setRenameProject] = useState<Project | null>(null)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null)

  // Derive loading view state (skeleton shows immediately on cold start)
  const view = useLoadingView({ status, hasData: projects.length > 0 })

  // Separate favorites from non-favorites
  const favoriteProjects = useMemo(
    () => projects.filter((p) => p.isFavorite),
    [projects]
  )

  // Handler callbacks
  const handleFavoriteToggle = useCallback((id: string) => {
    toggleFavorite(id)
  }, [toggleFavorite])

  const handleRename = useCallback((project: Project) => {
    setRenameProject(project)
  }, [])

  const handleDelete = useCallback((project: Project) => {
    setDeleteProjectTarget(project)
  }, [])

  const handleRenameSubmit = useCallback(async (name: string) => {
    if (renameProject) {
      await updateProject(renameProject.id, { name })
      setRenameProject(null)
    }
  }, [renameProject, updateProject])

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteProjectTarget) {
      await deleteProject(deleteProjectTarget.id)
      setDeleteProjectTarget(null)
    }
  }, [deleteProjectTarget, deleteProject])

  // Show empty container for cold loads (no cached data)
  if (view === 'skeleton') {
    return (
      <div className="container mx-auto max-w-6xl px-6 py-8">
        {/* Empty during load - GlobalHeader provides context */}
      </div>
    )
  }

  // Only show full error panel when we have no cached projects to display
  if (view === 'error') {
    return (
      <div className="container mx-auto max-w-6xl px-6 py-8">
        <ErrorPanel
          title="Failed to load projects"
          message={error || 'Unknown error'}
          onRetry={() => useProjectStore.getState().loadProjects()}
        />
      </div>
    )
  }

  // New Project button shown in section header
  const newProjectButton = (
    <Button onClick={() => setCreateDialogOpen(true)} size="sm">
      <Plus className="size-4" />
      <span className="hidden sm:inline">New Project</span>
      <span className="sm:hidden">New</span>
    </Button>
  )

  return (
    <div className="relative flex flex-col h-full">
      <MobileTopHeader inWorkspace={false} />
      <div className="flex-1 overflow-y-auto">
        <div className="container mx-auto max-w-6xl px-6 py-8">
        {/* Empty state when no projects at all */}
        {projects.length === 0 ? (
          <EmptyState
            title="Your workspace is empty"
            description="Create your first project to get started!"
            action={{
              label: 'Create your first project',
              onClick: () => setCreateDialogOpen(true),
            }}
            icon={<FileText className="size-12 text-muted-foreground" />}
          />
        ) : (
          <div className="space-y-8">
            <ContinueWorkingSection
              projects={projects}
              onFavoriteToggle={handleFavoriteToggle}
              action={newProjectButton}
            />
            <FavoritesSection
              projects={favoriteProjects}
              onFavoriteToggle={handleFavoriteToggle}
            />
            <AllProjectsSection
              projects={projects}
              onFavoriteToggle={handleFavoriteToggle}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          </div>
        )}
        </div>
      </div>

      {/* Dialogs */}
      <CreateProjectDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      <RenameProjectDialog
        project={renameProject}
        open={!!renameProject}
        onOpenChange={(open) => !open && setRenameProject(null)}
        onSubmit={handleRenameSubmit}
      />

      <DeleteProjectDialog
        project={deleteProjectTarget}
        open={!!deleteProjectTarget}
        onOpenChange={(open) => !open && setDeleteProjectTarget(null)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  )
}
