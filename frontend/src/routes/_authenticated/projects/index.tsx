import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ProjectList, CreateProjectDialog } from '@/features/projects'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { useLoadingView } from '@/core/hooks'
import { useUserProfile, useAuthActions, UserMenuButton } from '@/features/auth'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { Logo } from '@/shared/components'

export const Route = createFileRoute('/_authenticated/projects/')({
  component: ProjectsPage,
})

function ProjectsPage() {
  const navigate = useNavigate()
  const { projects, status, error, loadProjects } = useProjectStore()
  const { profile, status: profileStatus } = useUserProfile()
  const { signOut } = useAuthActions()
  const [dialogOpen, setDialogOpen] = useState(false)

  // Derive loading view state (skeleton shows immediately on cold start)
  const view = useLoadingView({ status, hasData: projects.length > 0 })

  useEffect(() => {
    loadProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Show empty container for cold loads (no cached data)
  if (view === 'skeleton') {
    return (
      <div className="container mx-auto max-w-6xl p-8">
        <div className="mb-4">
          <Logo size={24} />
          <p className="mt-1 type-body text-muted-foreground">File management for creative writers</p>
        </div>
        {/* Empty during load */}
      </div>
    )
  }

  // Only show full error panel when we have no cached projects to display
  if (view === 'error') {
    return (
      <div className="container mx-auto max-w-6xl p-8">
        <ErrorPanel
          title="Failed to load projects"
          message={error || 'Unknown error'}
          onRetry={() => loadProjects()}
        />
      </div>
    )
  }

  return (
    <div className="relative container mx-auto max-w-6xl p-8">
      {/* User menu in top-right */}
      {profileStatus === 'authenticated' && profile && (
        <div className="absolute top-4 right-4">
          <UserMenuButton
            profile={profile}
            onSettings={() => navigate({ to: '/settings' })}
            onSignOut={signOut}
            menuSide="bottom"
            showName={false}
          />
        </div>
      )}

      <div className="mb-4">
        <Logo size={24} />
        <p className="mt-1 type-body text-muted-foreground">File management for creative writers</p>
      </div>

      <ProjectList projects={projects} onCreateClick={() => setDialogOpen(true)} />

      <CreateProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  )
}
