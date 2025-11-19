import { createContext, useContext, useRef, useEffect, ComponentType } from 'react'
import { Button } from '@/shared/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface CollapsiblePanelContextValue {
  CollapseButton: ComponentType
  collapsed: boolean
  toggle: () => void
}

const CollapsiblePanelContext = createContext<CollapsiblePanelContextValue | null>(null)

/**
 * Hook to access collapse button and state from parent CollapsiblePanel.
 * Use this in children to render the collapse button in a custom position.
 *
 * @throws Error if used outside CollapsiblePanelProvider
 *
 * @example
 * ```tsx
 * function MyPanelHeader() {
 *   const { CollapseButton } = useCollapsiblePanel()
 *   return (
 *     <header>
 *       <h2>My Panel</h2>
 *       <CollapseButton />
 *     </header>
 *   )
 * }
 * ```
 */
export function useCollapsiblePanel(): CollapsiblePanelContextValue {
  const context = useContext(CollapsiblePanelContext)
  if (!context) {
    throw new Error('useCollapsiblePanel must be used within CollapsiblePanelProvider')
  }
  return context
}

interface CollapsiblePanelProviderProps {
  children: React.ReactNode
  collapsed: boolean
  onToggle: () => void
  side: 'left' | 'right'
  onButtonRendered?: () => void
}

/**
 * Provider for CollapsiblePanel context.
 * Supplies CollapseButton component and state to descendants.
 *
 * @internal Used by CollapsiblePanel component
 */
export function CollapsiblePanelProvider({
  children,
  collapsed,
  onToggle,
  side,
  onButtonRendered,
}: CollapsiblePanelProviderProps) {
  const buttonRenderedRef = useRef(false)

  // CollapseButton component that children can render
  const CollapseButton: ComponentType = () => {
    // Mark button as rendered on first mount
    useEffect(() => {
      if (!buttonRenderedRef.current) {
        buttonRenderedRef.current = true
        onButtonRendered?.()
      }
    }, [])

    const Icon = side === 'left' ? ChevronLeft : ChevronRight
    const ExpandIcon = side === 'left' ? ChevronRight : ChevronLeft
    const panelLabel = `${side} panel`
    const ariaLabel = collapsed ? `Expand ${panelLabel}` : `Collapse ${panelLabel}`

    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggle}
        className="size-8 flex-shrink-0"
        aria-label={ariaLabel}
        aria-expanded={!collapsed}
        title={ariaLabel}
      >
        {collapsed ? <ExpandIcon className="size-4" /> : <Icon className="size-4" />}
      </Button>
    )
  }

  const contextValue: CollapsiblePanelContextValue = {
    CollapseButton,
    collapsed,
    toggle: onToggle,
  }

  return (
    <CollapsiblePanelContext.Provider value={contextValue}>
      {children}
    </CollapsiblePanelContext.Provider>
  )
}
