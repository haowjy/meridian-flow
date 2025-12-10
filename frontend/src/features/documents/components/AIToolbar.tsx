import { Button } from '@/shared/components/ui/button'
import { Check, Undo2 } from 'lucide-react'

interface AIToolbarProps {
  /** Number of diff hunks currently displayed */
  hunkCount: number
  /** Called when user clicks "Keep All" */
  onKeepAll: () => void
  /** Called when user clicks "Undo All" */
  onUndoAll: () => void
  /** Whether an action is in progress */
  isLoading?: boolean
}

/**
 * Toolbar for AI suggestions - shows hunk count and Keep All / Undo All buttons.
 * Only renders when there are active suggestions (hunkCount > 0).
 */
export function AIToolbar({ hunkCount, onKeepAll, onUndoAll, isLoading }: AIToolbarProps) {
  if (hunkCount === 0) return null

  return (
    <div className="ai-toolbar flex items-center justify-between px-3 py-2 bg-emerald-50 dark:bg-emerald-950/30 border-b border-emerald-200 dark:border-emerald-800/50">
      <span className="text-sm text-emerald-700 dark:text-emerald-300">
        {hunkCount} change{hunkCount !== 1 ? 's' : ''} suggested
      </span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={onKeepAll}
          disabled={isLoading}
          className="bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          <Check className="size-3.5" />
          Keep All
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onUndoAll}
          disabled={isLoading}
        >
          <Undo2 className="size-3.5" />
          Undo All
        </Button>
      </div>
    </div>
  )
}
