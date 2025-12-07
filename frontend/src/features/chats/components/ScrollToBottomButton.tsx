import { ArrowDown } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/lib/utils'

interface ScrollToBottomButtonProps {
  visible: boolean
  onClick: () => void
  className?: string
}

/**
 * Floating button to scroll to bottom of chat during streaming.
 *
 * Shows when user has scrolled up during streaming.
 * Clicking scrolls to bottom and enables auto-scroll.
 */
export function ScrollToBottomButton({
  visible,
  onClick,
  className,
}: ScrollToBottomButtonProps) {
  return (
    <Button
      variant="outline"
      size="icon"
      onClick={onClick}
      aria-label="Scroll to bottom"
      className={cn(
        'scroll-to-bottom-button',
        visible ? 'visible' : '',
        className
      )}
    >
      <ArrowDown className="size-4" />
    </Button>
  )
}
