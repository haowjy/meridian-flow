import { cn } from '@/lib/utils'

interface LogoWordmarkProps {
  className?: string
}

/**
 * Meridian Flow wordmark used across front pages and workspace.
 *
 * Single responsibility:
 * - Render the brand "Meridian Flow" in a layout-consistent way.
 */
export function LogoWordmark({ className }: LogoWordmarkProps) {
  return (
    <div className={cn('flex items-baseline gap-1.5 min-w-0 select-none', className)}>
      <p className="font-serif font-semibold text-base tracking-tight text-foreground">
        Meridian
      </p>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-sans font-medium">
        Flow
      </p>
    </div>
  )
}

