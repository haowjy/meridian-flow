import { FolderOpen } from 'lucide-react'
import { Project } from '../types/project'
import { ProjectRowCompact } from './ProjectRowCompact'
import { ProjectSortDropdown } from './ProjectSortDropdown'
import { useUIStore, type ProjectSortOrder } from '@/core/stores/useUIStore'
import { useMemo } from 'react'
import { ProjectSectionHeader } from './ProjectSectionHeader'

interface AllProjectsSectionProps {
  projects: Project[]
  onFavoriteToggle?: (id: string) => void
  onRename?: (project: Project) => void
  onDelete?: (project: Project) => void
}

function sortProjects(projects: Project[], sortOrder: ProjectSortOrder): Project[] {
  const sorted = [...projects]

  switch (sortOrder) {
    case 'updated':
      return sorted.sort((a, b) =>
        new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
      )
    case 'name-asc':
      return sorted.sort((a, b) => a.name.localeCompare(b.name))
    case 'name-desc':
      return sorted.sort((a, b) => b.name.localeCompare(a.name))
    case 'created-newest':
      return sorted.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
    case 'created-oldest':
      return sorted.sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      )
    default:
      return sorted
  }
}

export function AllProjectsSection({
  projects,
  onFavoriteToggle,
  onRename,
  onDelete,
}: AllProjectsSectionProps) {
  const sortOrder = useUIStore((state) => state.projectSortOrder)

  const sortedProjects = useMemo(
    () => sortProjects(projects, sortOrder),
    [projects, sortOrder]
  )

  return (
    <section>
      <ProjectSectionHeader
        icon={<FolderOpen className="size-4 text-muted-foreground" />}
        title="All Projects"
        count={projects.length}
        right={<ProjectSortDropdown />}
      />

      {/* Content */}
      {sortedProjects.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="type-body">No projects found</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
          {sortedProjects.map((project) => (
            <ProjectRowCompact
              key={project.id}
              project={project}
              onFavoriteToggle={onFavoriteToggle}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </section>
  )
}
