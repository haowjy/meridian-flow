'use client'

import { motion } from 'framer-motion'
import { SaveStatusIcon } from './SaveStatusIcon'
import { formatRelative } from '@/core/lib/formatDate'
import { cn } from '@/lib/utils'
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'

interface EditorStatusInfoProps {
  wordCount: number
  status: SaveStatus
  lastSaved: Date | null
  className?: string
}

export function EditorStatusInfo({
  wordCount,
  status,
  lastSaved,
  className
}: EditorStatusInfoProps) {
  return (
    <motion.div
      layoutId="editor-status"
      layout="position"
      transition={{ type: "tween", duration: 0.2 }}
      className={cn(
        'inline-flex items-center gap-2.5 text-xs rounded-lg bg-card/90 px-3.5 h-9 ring-1 ring-border/40 backdrop-blur',
        className
      )}
      style={{ boxShadow: 'var(--shadow-2)' }}
      aria-live="polite"
    >
      <div className="font-medium text-foreground">
        {wordCount} {wordCount === 1 ? 'word' : 'words'}
      </div>
      <div className="h-2.5 w-px bg-border/40" />
      <div className="inline-flex items-center gap-2 text-muted-foreground">
        <SaveStatusIcon status={status} />
        {status === 'saved' && lastSaved ? <span>Saved {formatRelative(lastSaved)}</span> : null}
        {status === 'saving' ? <span>Saving…</span> : null}
        {status === 'error' ? <span>Save failed</span> : null}
        {status === 'local' ? <span>Saved locally</span> : null}
      </div>
    </motion.div>
  )
}
