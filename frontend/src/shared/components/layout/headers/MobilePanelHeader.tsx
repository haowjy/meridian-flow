import { ReactNode } from 'react'
import { Menu } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { HeaderGradientFade } from './HeaderGradientFade'

interface MobilePanelHeaderProps {
  /** Content to display after hamburger button (e.g., ThreadSelector) */
  leading?: ReactNode
  /** Title text - centered if centerTitle is true */
  title?: string
  /** Content for right side (e.g., action buttons) */
  trailing?: ReactNode
  /** Center the title between hamburger and trailing */
  centerTitle?: boolean
  /** Callback when hamburger menu is clicked */
  onMenuOpen: () => void
  /** Show gradient fade below header (default: true) */
  showGradient?: boolean
}

/**
 * Mobile-only header component with consistent hamburger positioning.
 *
 * Specs:
 * - Height: h-14 (56px)
 * - Horizontal padding: px-3 (12px)
 * - Gap: gap-2 (8px)
 * - Hamburger: size="icon" with size-5 icon
 */
export function MobilePanelHeader({
  leading,
  title,
  trailing,
  centerTitle = false,
  onMenuOpen,
  showGradient = true,
}: MobilePanelHeaderProps) {
  return (
    <div className="md:hidden flex items-center gap-2 px-3 h-14 bg-background shrink-0 relative">
      {/* Hamburger menu button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={onMenuOpen}
        aria-label="Open menu"
        className="shrink-0"
      >
        <Menu className="size-5" />
      </Button>

      {centerTitle ? (
        <>
          {/* Centered title layout */}
          <div className="flex-1 flex justify-center">
            {title && (
              <span className="font-medium text-sm truncate">{title}</span>
            )}
          </div>
          {/* Trailing or spacer for balance */}
          {trailing ? (
            <div className="shrink-0">{trailing}</div>
          ) : (
            <div className="size-10" /> // Match hamburger button size
          )}
        </>
      ) : (
        <>
          {/* Leading content after hamburger */}
          {leading && (
            <div className="min-w-0 flex-1">{leading}</div>
          )}
          {/* Title if no leading */}
          {!leading && title && (
            <span className="font-medium text-sm truncate">{title}</span>
          )}
          {/* Spacer when no leading content */}
          {!leading && !title && <div className="flex-1" />}
          {/* Trailing content */}
          {trailing && (
            <div className="shrink-0 flex items-center gap-1">{trailing}</div>
          )}
        </>
      )}

      {showGradient && <HeaderGradientFade />}
    </div>
  )
}
