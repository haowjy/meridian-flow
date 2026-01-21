import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, useMemo, useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  CreateProjectDialog,
  ProjectSearchInput,
  FavoritesSection,
  ContinueWorkingSection,
  AllProjectsSection,
} from '@/features/projects'
import { Project } from '@/features/projects/types/project'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useLoadingView } from '@/core/hooks'
import { useUserProfile, useAuthActions, UserMenuButton } from '@/features/auth'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { Logo } from '@/shared/components'
import { Link } from '@tanstack/react-router'
import { EmptyState } from '@/shared/components/EmptyState'
import { FileText, Plus, Search } from 'lucide-react'
import { RenameProjectDialog } from '@/features/projects/components/RenameProjectDialog'
import { DeleteProjectDialog } from '@/features/projects/components/DeleteProjectDialog'
import { Button } from '@/shared/components/ui/button'

export const Route = createFileRoute('/_authenticated/projects/')({
  component: ProjectsPage,
})

/**
 * Get time-based greeting
 */
function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function ProjectsPage() {
  const navigate = useNavigate()
  const { projects, status, error, loadProjects, toggleFavorite, deleteProject, updateProject } = useProjectStore()
  const { profile, status: profileStatus } = useUserProfile()
  const { signOut } = useAuthActions()
  const projectSearchQuery = useUIStore((state) => state.projectSearchQuery)
  const setProjectSearchQuery = useUIStore((state) => state.setProjectSearchQuery)

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [renameProject, setRenameProject] = useState<Project | null>(null)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null)
  const [isSearchOpen, setIsSearchOpen] = useState(false)

  // Derive loading view state (skeleton shows immediately on cold start)
  const view = useLoadingView({ status, hasData: projects.length > 0 })

  useEffect(() => {
    loadProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // If the user has an active query (e.g. after a refresh), ensure the search UI is visible.
  useEffect(() => {
    if (projectSearchQuery.trim()) {
      setIsSearchOpen(true)
    }
  }, [projectSearchQuery])

  // Filter projects by search query
  const filteredProjects = useMemo(() => {
    if (!projectSearchQuery.trim()) {
      return projects
    }
    const query = projectSearchQuery.toLowerCase()
    return projects.filter((p) =>
      p.name.toLowerCase().includes(query)
    )
  }, [projects, projectSearchQuery])

  // Separate favorites from non-favorites
  const favoriteProjects = useMemo(
    () => filteredProjects.filter((p) => p.isFavorite),
    [filteredProjects]
  )

  // All projects (including favorites) for the list
  const allFilteredProjects = filteredProjects

  // Handler callbacks
  const handleFavoriteToggle = useCallback((id: string) => {
    toggleFavorite(id)
  }, [toggleFavorite])

  const handleSearchOpen = useCallback(() => {
    setIsSearchOpen(true)
  }, [])

  const handleSearchClose = useCallback(() => {
    setProjectSearchQuery('')
    setIsSearchOpen(false)
  }, [setProjectSearchQuery])

  const handleRename = useCallback((project: Project) => {
    setRenameProject(project)
  }, [])

  const handleDelete = useCallback((project: Project) => {
    setDeleteProjectTarget(project)
  }, [])

  const handleRenameSubmit = useCallback(async (name: string) => {
    if (renameProject) {
      await updateProject(renameProject.id, name)
      setRenameProject(null)
    }
  }, [renameProject, updateProject])

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteProjectTarget) {
      await deleteProject(deleteProjectTarget.id)
      setDeleteProjectTarget(null)
    }
  }, [deleteProjectTarget, deleteProject])

  // Get first name for greeting
  const firstName = profile?.name?.split(' ')[0] ?? ''
  const greeting = getGreeting()
  const isSearching = projectSearchQuery.trim().length > 0

  // Show empty container for cold loads (no cached data)
  if (view === 'skeleton') {
    return (
      <div className="container mx-auto max-w-6xl px-6 py-8">
        <div className="mb-8">
          <Link to="/projects">
            <Logo size={40} />
          </Link>
        </div>
        {/* Empty during load */}
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
          onRetry={() => loadProjects()}
        />
      </div>
    )
  }

  return (
    <div className="relative min-h-screen">
      <div className="container mx-auto max-w-6xl px-6 py-8">
        {/* Header */}
        <header className="flex items-start justify-between gap-4 mb-8">
          <div>
            <Link to="/projects">
              <Logo size={40} />
            </Link>
            {/* Personalized greeting */}
            {profileStatus === 'authenticated' && firstName && (
              <h1 className="mt-6 type-display text-foreground">
                {greeting}, {firstName}
              </h1>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button onClick={() => setCreateDialogOpen(true)} size="sm">
              <Plus className="size-4" />
              <span className="hidden sm:inline">New Project</span>
              <span className="sm:hidden">New</span>
            </Button>

            {/* User menu */}
            {profileStatus === 'authenticated' && profile && (
              <UserMenuButton
                profile={profile}
                onSettings={() => navigate({ to: '/settings' })}
                onSignOut={signOut}
                menuSide="bottom"
                showName={false}
              />
            )}
          </div>
        </header>

        {/* Search */}
        <div className="mb-8">
          {isSearchOpen || isSearching ? (
            <div className="flex items-center gap-2">
              <ProjectSearchInput
                autoFocus={isSearchOpen && !isSearching}
                onRequestClose={handleSearchClose}
              />
              <Button variant="ghost" size="sm" onClick={handleSearchClose}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={handleSearchOpen}>
              <Search className="size-4" />
              Search
            </Button>
          )}
        </div>

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
          <>
            {/* No results state when searching */}
            {filteredProjects.length === 0 && projectSearchQuery.trim() ? (
              <div className="text-center py-16">
                <p className="type-section text-muted-foreground mb-2">
                  No projects match "{projectSearchQuery}"
                </p>
                <p className="type-body text-muted-foreground">
                  Try a different search term
                </p>
              </div>
            ) : (
              <>
                {/* Quick access is hidden while searching to keep the UI focused. */}
                <div className="space-y-8">
                  {!isSearching && (
                    <>
                      <ContinueWorkingSection
                        projects={filteredProjects}
                        onFavoriteToggle={handleFavoriteToggle}
                      />
                      <FavoritesSection
                        projects={favoriteProjects}
                        onFavoriteToggle={handleFavoriteToggle}
                      />
                    </>
                  )}

                  {/* All Projects Section */}
                  <AllProjectsSection
                    projects={allFilteredProjects}
                    onFavoriteToggle={handleFavoriteToggle}
                    onRename={handleRename}
                    onDelete={handleDelete}
                  />
                </div>
              </>
            )}
          </>
        )}
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
