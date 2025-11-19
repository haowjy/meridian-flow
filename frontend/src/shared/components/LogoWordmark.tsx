import { cn } from '@/lib/utils'

interface LogoWordmarkProps {
  secondaryLabel?: string
  className?: string
}

/**
 * Meridian wordmark used across front pages and workspace.
 *
 * Single responsibility:
 * - Render the brand "Meridian" with an optional secondary label
 *   (e.g., "Flow") in a layout-consistent way.
 */
export function LogoWordmark({ secondaryLabel, className }: LogoWordmarkProps) {
  return (
    <div className={cn('flex items-baseline gap-1.5 min-w-0 select-none', className)}>
      <p className="font-serif font-semibold text-base tracking-tight text-foreground">
        Meridian
      </p>
      {secondaryLabel ? (
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-sans font-medium">
          {secondaryLabel}
        </p>
      ) : null}
    </div>
  )
}

