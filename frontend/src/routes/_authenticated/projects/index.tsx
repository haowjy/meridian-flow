import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ProjectList, CreateProjectDialog } from '@/features/projects'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { useUserProfile, useAuthActions, UserMenuButton } from '@/features/auth'
import { CardSkeleton } from '@/shared/components/ui/card'
import { CardGrid } from '@/shared/components/CardGrid'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { LogoWordmark } from '@/shared/components/LogoWordmark'

export const Route = createFileRoute('/_authenticated/projects/')({
  component: ProjectsPage,
})

function ProjectsPage() {
  const navigate = useNavigate()
  const { projects, status, error, loadProjects } = useProjectStore()
  const { profile, status: profileStatus } = useUserProfile()
  const { signOut } = useAuthActions()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [showSkeleton, setShowSkeleton] = useState(false)

  useEffect(() => {
    loadProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Skeleton delay: only show skeleton after 150ms if still loading
  useEffect(() => {
    if (status === 'loading') {
      const timer = setTimeout(() => setShowSkeleton(true), 150)
      return () => clearTimeout(timer)
    } else {
      setShowSkeleton(false)
    }
  }, [status])

  // Show skeleton only for true cold loads (no cached data)
  if (status === 'loading' && showSkeleton) {
    return (
      <div className="container mx-auto max-w-6xl p-8">
        <div className="mb-4">
          <LogoWordmark className="h-6" />
          <p className="mt-1 type-body text-muted-foreground">File management for creative writers</p>
        </div>
        <CardGrid>
          {Array.from({ length: 3 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </CardGrid>
      </div>
    )
  }

  // Only show error when we have no cached projects to display
  if (status === 'error' && projects.length === 0) {
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
        <LogoWordmark className="h-6" />
        <p className="mt-1 type-body text-muted-foreground">File management for creative writers</p>
      </div>

      <ProjectList projects={projects} onCreateClick={() => setDialogOpen(true)} />

      <CreateProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  )
}
