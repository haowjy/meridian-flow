import { useMemo } from 'react'
import DiffMatchPatch from 'diff-match-patch'
import { Button } from '@/shared/components/ui/button'
import { Check, Undo2 } from 'lucide-react'
import type { DiffHunk } from '../hooks/useAIDiff'

// Diff operation types from diff-match-patch
const DIFF_DELETE = -1
const DIFF_INSERT = 1
// const DIFF_EQUAL = 0  // Not used in this component

interface DiffHunkDisplayProps {
  /** The diff hunk to display */
  hunk: DiffHunk
  /** Called when user clicks "Keep" (accept AI suggestion) */
  onKeep: () => void
  /** Called when user clicks "Undo" (reject AI suggestion) */
  onUndo: () => void
  /** Whether an action is in progress */
  isLoading?: boolean
}

// Singleton for inline diff computation
const dmp = new DiffMatchPatch()

/**
 * Displays a single diff hunk with inline word-level changes.
 * Shows strikethrough for removed text and highlight for added text.
 */
export function DiffHunkDisplay({ hunk, onKeep, onUndo, isLoading }: DiffHunkDisplayProps) {
  // Compute word-level diff for inline display
  const inlineDiff = useMemo(() => {
    const diffs = dmp.diff_main(hunk.userText, hunk.aiText)
    dmp.diff_cleanupSemantic(diffs)
    return diffs
  }, [hunk.userText, hunk.aiText])

  return (
    <span className="ai-hunk inline-flex items-baseline gap-1 bg-emerald-50/50 dark:bg-emerald-950/20 rounded px-1 py-0.5">
      <span className="ai-hunk-content">
        {inlineDiff.map(([op, text], i) => {
          if (op === DIFF_DELETE) {
            return (
              <del key={i} className="ai-removed text-muted-foreground line-through opacity-70">
                {text}
              </del>
            )
          }
          if (op === DIFF_INSERT) {
            return (
              <ins key={i} className="ai-added bg-emerald-200/60 dark:bg-emerald-800/40 text-emerald-800 dark:text-emerald-200 no-underline rounded-sm px-0.5">
                {text}
              </ins>
            )
          }
          return <span key={i}>{text}</span>
        })}
      </span>
      <span className="ai-hunk-actions inline-flex gap-0.5 ml-1">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onKeep}
          disabled={isLoading}
          title="Keep (accept AI suggestion)"
          className="size-5 text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-900/50"
        >
          <Check className="size-3" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onUndo}
          disabled={isLoading}
          title="Undo (reject AI suggestion)"
          className="size-5 text-muted-foreground hover:bg-muted"
        >
          <Undo2 className="size-3" />
        </Button>
      </span>
    </span>
  )
}

interface DiffDisplayProps {
  /** Array of diff hunks to display */
  hunks: DiffHunk[]
  /** Called when user clicks "Keep" on a hunk */
  onKeep: (hunk: DiffHunk) => void
  /** Called when user clicks "Undo" on a hunk */
  onUndo: (hunk: DiffHunk) => void
  /** ID of hunk currently being processed */
  loadingHunkId?: string
}

/**
 * Displays all diff hunks in a list format.
 * Used for showing suggestions outside the editor (e.g., in a panel).
 */
export function DiffDisplay({ hunks, onKeep, onUndo, loadingHunkId }: DiffDisplayProps) {
  if (hunks.length === 0) return null

  return (
    <div className="ai-diff-list space-y-2 p-2">
      {hunks.map((hunk) => (
        <div key={hunk.id} className="ai-diff-item">
          <DiffHunkDisplay
            hunk={hunk}
            onKeep={() => onKeep(hunk)}
            onUndo={() => onUndo(hunk)}
            isLoading={loadingHunkId === hunk.id}
          />
        </div>
      ))}
    </div>
  )
}
