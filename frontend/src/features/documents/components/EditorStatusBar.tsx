'use client'

import { EditorStatusInfo } from './EditorStatusInfo'
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'
import type { Editor } from '@tiptap/react'

interface EditorStatusBarProps {
  editor: Editor
  status: SaveStatus
  lastSaved: Date | null
  readOnly: boolean
  className?: string
}

export function EditorStatusBar({ editor, status, lastSaved, readOnly, className }: EditorStatusBarProps) {
  // Hide in read-only mode (status appears in toolbar instead)
  if (readOnly) return null

  const wordCount = editor.storage.characterCount?.words() ?? 0

  return (
    <EditorStatusInfo
      wordCount={wordCount}
      status={status}
      lastSaved={lastSaved}
      className={className}
    />
  )
}
