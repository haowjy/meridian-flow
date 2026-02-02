import { Star } from 'lucide-react'
import { Project } from '../types/project'
import { ProjectFeaturedCardList } from './ProjectFeaturedCardList'
import { ProjectSectionHeader } from './ProjectSectionHeader'

interface FavoritesSectionProps {
  projects: Project[]
  onFavoriteToggle?: (id: string) => void
}

export function FavoritesSection({ projects, onFavoriteToggle }: FavoritesSectionProps) {
  // Don't render if no favorites
  if (projects.length === 0) {
    return null
  }

  // Sort favorites alphabetically by name for stable ordering
  const sortedFavorites = [...projects].sort((a, b) =>
    a.name.localeCompare(b.name)
  )

  return (
    <section className="min-w-0">
      <ProjectSectionHeader
        icon={<Star className="size-4.5 text-favorite" fill="currentColor" />}
        title="Favorites"
        count={projects.length}
      />
      <ProjectFeaturedCardList
        projects={sortedFavorites}
        onFavoriteToggle={onFavoriteToggle}
        scrollable
        ariaLabel="favorites"
      />
    </section>
  )
}
