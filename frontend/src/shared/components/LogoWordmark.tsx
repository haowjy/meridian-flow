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
    <div className={cn('min-w-0', className)}>
      <p className="type-display truncate">Meridian</p>
      {secondaryLabel ? (
        <p className="mt-0.5 type-meta tracking-wide">
          {secondaryLabel}
        </p>
      ) : null}
    </div>
  )
}

