import { Clock } from 'lucide-react'
import { Project } from '../types/project'
import { ProjectFeaturedCardList } from './ProjectFeaturedCardList'
import { ProjectSectionHeader } from './ProjectSectionHeader'

interface ContinueWorkingSectionProps {
  projects: Project[]
  onFavoriteToggle?: (id: string) => void
}

export function ContinueWorkingSection({
  projects,
  onFavoriteToggle,
}: ContinueWorkingSectionProps) {
  const sortedByActivity = [...projects]
    .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())

  if (sortedByActivity.length === 0) {
    return null
  }

  return (
    <section>
      <ProjectSectionHeader
        icon={<Clock className="size-4.5 text-muted-foreground" />}
        title="Continue Working"
      />
      <ProjectFeaturedCardList
        projects={sortedByActivity}
        onFavoriteToggle={onFavoriteToggle}
        ariaLabel="continue working projects"
      />
    </section>
  )
}
