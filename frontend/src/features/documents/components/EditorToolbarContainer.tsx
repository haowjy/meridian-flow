"use client"

import type { Editor as TiptapEditor } from "@tiptap/react"
import { useUIStore } from "@/core/stores/useUIStore"
import { EditorToolbar } from "./EditorToolbar"

interface EditorToolbarContainerProps {
  editor: TiptapEditor | null
  disabled?: boolean
}

/**
 * Container that wires UI store to the presentational EditorToolbar.
 * Keeps state management out of the view for SOLID/DIP.
 */
export function EditorToolbarContainer({ editor, disabled }: EditorToolbarContainerProps) {
  const readOnly = useUIStore((s) => s.editorReadOnly)
  const setEditorReadOnly = useUIStore((s) => s.setEditorReadOnly)

  return (
    <EditorToolbar
      editor={editor}
      readOnly={readOnly}
      onModeChange={(ro) => setEditorReadOnly(ro)}
      disabled={disabled}
    />
  )
}

