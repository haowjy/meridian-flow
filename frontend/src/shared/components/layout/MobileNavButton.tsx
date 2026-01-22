import { List, MessageSquare, FileText } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { useIsMobile } from '@/core/hooks/useIsMobile'

/** Icon types for mobile navigation */
type MobileNavIcon = 'threads' | 'thread' | 'document'

interface MobileNavButtonProps {
  /** Icon to display */
  icon: MobileNavIcon
  /** Click handler for navigation */
  onClick: () => void
  /** Additional CSS classes */
  className?: string
}

/** Map icon names to lucide-react components */
const iconMap = {
  threads: List,
  thread: MessageSquare,
  document: FileText,
} as const

/** Aria labels for accessibility */
const ariaLabelMap = {
  threads: 'Go to thread list',
  thread: 'Go to thread',
  document: 'Go to documents',
} as const

/**
 * Icon-only navigation button for mobile layouts.
 * Only renders on mobile viewports (< 768px).
 * Used in headers for panel switching.
 */
export function MobileNavButton({
  icon,
  onClick,
  className,
}: MobileNavButtonProps) {
  const isMobile = useIsMobile()

  // Only render on mobile
  if (!isMobile) return null

  const Icon = iconMap[icon]
  const ariaLabel = ariaLabelMap[icon]

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      className={className}
      aria-label={ariaLabel}
    >
      <Icon />
    </Button>
  )
}
