import { Link } from '@tanstack/react-router'
import { Star } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { Project } from '../types/project'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { cn } from '@/lib/utils'

interface ProjectCardFeaturedProps {
  project: Project
  onFavoriteToggle?: (id: string) => void
  className?: string
}

export function ProjectCardFeatured({ project, onFavoriteToggle, className }: ProjectCardFeaturedProps) {
  const setCurrentProject = useProjectStore((state) => state.setCurrentProject)

  const handleClick = () => {
    setCurrentProject(project)
  }

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onFavoriteToggle?.(project.id)
  }

  const timeAgo = formatDistanceToNow(new Date(project.lastActivityAt), { addSuffix: true })

  return (
    <Link
      to={`/projects/${project.slug}`}
      onClick={handleClick}
      className={cn("group block cursor-pointer", className)}
    >
      <div className="relative h-[140px] rounded-lg border border-border bg-card p-5 transition-all duration-[--duration-fast] motion-safe:hover:scale-[1.02] hover:shadow-[var(--shadow-2)]"
        style={{ boxShadow: 'var(--shadow-1)' }}
      >
        {/* Favorite toggle button */}
        <button
          onClick={handleFavoriteClick}
          className={cn(
            'absolute top-3 right-3 p-1 rounded transition-colors',
            project.isFavorite
              ? 'text-accent hover:text-accent/80'
              : 'text-muted-foreground/40 hover:text-muted-foreground opacity-0 group-hover:opacity-100'
          )}
          aria-label={project.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Star
            className="size-4.5"
            fill={project.isFavorite ? 'currentColor' : 'none'}
          />
        </button>

        {/* Content */}
        <div className="flex flex-col h-full justify-between">
          <h3 className="type-section text-foreground line-clamp-2 pr-6">
            {project.name}
          </h3>
          <p className="type-meta text-muted-foreground">
            Updated {timeAgo}
          </p>
        </div>
      </div>
    </Link>
  )
}
