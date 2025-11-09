import { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface ToolbarButtonGroupProps {
  children: ReactNode
  gap?: 'tight' | 'normal'
  className?: string
}

/**
 * Simple layout container for toolbar buttons.
 * Provides configurable gap spacing for visual grouping.
 *
 * - `tight`: For related format buttons (Bold/Italic, H1/H2, etc.)
 * - `normal`: For mode toggles or standalone buttons
 */
export function ToolbarButtonGroup({
  children,
  gap = 'tight',
  className,
}: ToolbarButtonGroupProps) {
  const gapClass = gap === 'tight' ? '' : 'gap-1'

  return (
    <div className={cn('flex items-center', gapClass, className)}>
      {children}
    </div>
  )
}
