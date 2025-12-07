/**
 * Document Status
 *
 * Compact display of word count and save status for the editor header.
 */

import { SaveStatusIcon } from './SaveStatusIcon'
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'

interface DocumentStatusProps {
  wordCount: number
  status: SaveStatus
  lastSaved: Date | null
}

export function DocumentStatus({ wordCount, status, lastSaved }: DocumentStatusProps) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground select-none">
      <span>
        {wordCount} {wordCount === 1 ? 'word' : 'words'}
      </span>
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground/80">
        <SaveStatusIcon status={status} className="size-3.5" />
        {lastSaved && (
          <span aria-label="Last saved timestamp">
            {lastSaved.toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  )
}
