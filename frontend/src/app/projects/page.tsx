'use client'

import { useEffect, useState } from 'react'
import { ProjectList, CreateProjectDialog } from '@/features/projects'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { CardSkeleton } from '@/shared/components/ui/card'
import { CardGrid } from '@/shared/components/CardGrid'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { SectionHeader } from '@/shared/components/SectionHeader'

export default function ProjectsPage() {
  const { projects, isLoading, error, loadProjects } = useProjectStore()
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    loadProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (isLoading) {
    return (
      <div className="container mx-auto max-w-6xl p-8">
        <SectionHeader
          title="Meridian"
          subtitle="File management for creative writers"
        />
        <CardGrid>
          {Array.from({ length: 3 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </CardGrid>
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto max-w-6xl p-8">
        <ErrorPanel
          title="Failed to load projects"
          message={error}
          onRetry={() => loadProjects()}
        />
      </div>
    )
  }

  return (
    <div className="container mx-auto max-w-6xl p-8">
      <SectionHeader
        title="Meridian"
        subtitle="File management for creative writers"
      />

      <ProjectList projects={projects} onCreateClick={() => setDialogOpen(true)} />

      <CreateProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  )
}
