import { MessageSquare, FileText, List } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MobileActivePanel } from '@/core/stores/useUIStore'

interface MobileBottomNavProps {
  activePanel: MobileActivePanel
  onPanelChange: (panel: MobileActivePanel) => void
  className?: string
}

const tabs: { id: MobileActivePanel; label: string; icon: typeof MessageSquare }[] = [
  { id: 'chatList', label: 'Chats', icon: List },
  { id: 'activeChat', label: 'Chat', icon: MessageSquare },
  { id: 'document', label: 'Document', icon: FileText },
]

/**
 * Bottom tab navigation for mobile layout.
 * Switches between chat list, active chat, and document panels.
 */
export function MobileBottomNav({ activePanel, onPanelChange, className }: MobileBottomNavProps) {
  return (
    <nav
      className={cn(
        'flex items-stretch border-t border-border bg-background',
        // Safe area padding for notched devices
        'pb-[env(safe-area-inset-bottom)]',
        className
      )}
      role="tablist"
      aria-label="Main navigation"
    >
      {tabs.map((tab) => {
        const isActive = activePanel === tab.id
        const Icon = tab.icon
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            {...(isActive ? { 'aria-controls': `panel-${tab.id}` } : {})}
            onClick={() => onPanelChange(tab.id)}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-0.5 py-2',
              // Minimum touch target 44px
              'min-h-[56px]',
              'transition-colors',
              isActive
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-5 w-5" />
            <span className="text-xs font-medium">{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
