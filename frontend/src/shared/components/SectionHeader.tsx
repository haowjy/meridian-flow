interface SectionHeaderProps {
  title: string
  subtitle?: string
  action?: React.ReactNode
}

export function SectionHeader({ title, subtitle, action }: SectionHeaderProps) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="type-display">{title}</h1>
          {subtitle && (
            <p className="mt-1 type-body text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  )
}
