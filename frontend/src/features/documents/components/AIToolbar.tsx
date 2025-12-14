/**
 * AIToolbar Component
 *
 * Mode switcher for AI suggestion review (Original | Changes | AI Draft).
 * Appears when AI suggestions exist (aiVersion is present).
 *
 * Accept All / Reject All will be in the floating pill (AIHunkNavigator).
 *
 * @see `_docs/plans/ai-editing/inline-suggestions.md` for full UX spec
 */

import { useEditorStore, type AIEditorMode } from '@/core/stores/useEditorStore'
import { cn } from '@/lib/utils'

// ============================================================================
// MODE CONFIGURATION
// ============================================================================

/**
 * Mode configuration for the mode switcher.
 * Order determines button order in the UI.
 *
 * Why this order?
 * - Original first: Shows "before" state (reference point)
 * - Changes second: Default mode, shows inline diff
 * - AI Draft third: Shows "after" state (clean view)
 */
const modes: { value: AIEditorMode; label: string }[] = [
  { value: 'original', label: 'Original' },
  { value: 'changes', label: 'Changes' },
  { value: 'aiDraft', label: 'AI Draft' },
]

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Mode switcher toolbar for AI suggestions.
 * Allows switching between Original, Changes (diff), and AI Draft views.
 */
export function AIToolbar() {
  const aiEditorMode = useEditorStore((s) => s.aiEditorMode)
  const setAIEditorMode = useEditorStore((s) => s.setAIEditorMode)

  return (
    <div className="ai-toolbar flex items-center justify-center px-3 py-2 bg-background">
      {/* Mode Switcher - segmented control for Original/Changes/AI Draft */}
      <div className="flex gap-1 bg-muted rounded-md p-0.5 border border-border">
        {modes.map((m) => (
          <button
            key={m.value}
            onClick={() => setAIEditorMode(m.value)}
            className={cn(
              'px-2 py-1 text-xs rounded transition-colors',
              aiEditorMode === m.value
                ? 'bg-background shadow-sm font-medium'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  )
}
