import { CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { LinkCard } from '@/shared/components/LinkCard'
import { Project } from '../types/project'
import { format } from 'date-fns'
import { useProjectStore } from '@/core/stores/useProjectStore'

interface ProjectCardProps {
  project: Project
}

export function ProjectCard({ project }: ProjectCardProps) {
  const setCurrentProject = useProjectStore((state) => state.setCurrentProject)

  const handleClick = () => {
    setCurrentProject(project)
  }

  return (
    <LinkCard to={`/projects/${project.id}`} onClick={handleClick}>
      <CardHeader>
        <CardTitle>{project.name}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Created {format(new Date(project.createdAt), 'MMM d, yyyy')}
        </p>
      </CardContent>
    </LinkCard>
  )
}
