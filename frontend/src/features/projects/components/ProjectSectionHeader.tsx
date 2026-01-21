import { type ReactNode } from 'react'

interface ProjectSectionHeaderProps {
  icon: ReactNode
  title: string
  count?: number
  right?: ReactNode
}

export function ProjectSectionHeader({ icon, title, count, right }: ProjectSectionHeaderProps) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="type-label uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {typeof count === 'number' && (
          <span className="type-meta text-muted-foreground">
            ({count})
          </span>
        )}
      </div>
      {right && (
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
          {right}
        </div>
      )}
    </div>
  )
}

