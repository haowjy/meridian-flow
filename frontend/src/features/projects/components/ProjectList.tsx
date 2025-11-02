'use client'

import { ProjectCard } from './ProjectCard'
import { Project } from '../types/project'
import { Button } from '@/shared/components/ui/button'
import { EmptyState } from '@/shared/components/EmptyState'
import { CardGrid } from '@/shared/components/CardGrid'
import { Plus } from 'lucide-react'

interface ProjectListProps {
  projects: Project[]
  onCreateClick: () => void
}

export function ProjectList({ projects, onCreateClick }: ProjectListProps) {
  if (projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        description="Create your first project to get started!"
        action={{
          label: 'Create Project',
          onClick: onCreateClick
        }}
        icon={<Plus className="h-12 w-12 text-muted-foreground" />}
      />
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold">Your Projects</h2>
        <Button onClick={onCreateClick}>
          <Plus className="mr-2 h-4 w-4" />
          Create Project
        </Button>
      </div>
      <CardGrid>
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </CardGrid>
    </div>
  )
}
