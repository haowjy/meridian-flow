"use client"

import type { Editor as TiptapEditor } from "@tiptap/react"
import { useUIStore } from "@/core/stores/useUIStore"
import { EditorToolbar } from "./EditorToolbar"
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'

interface EditorToolbarContainerProps {
  editor: TiptapEditor | null
  disabled?: boolean
  status: SaveStatus
  lastSaved: Date | null
}

/**
 * Container that wires UI store to the presentational EditorToolbar.
 * Keeps state management out of the view for SOLID/DIP.
 */
export function EditorToolbarContainer({ editor, disabled, status, lastSaved }: EditorToolbarContainerProps) {
  return (
    <EditorToolbar
      editor={editor}
      disabled={disabled}
      status={status}
      lastSaved={lastSaved}
    />
  )
}

