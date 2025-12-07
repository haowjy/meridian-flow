import type { CodeMirrorEditorRef } from '@/core/editor/codemirror'
import { EditorToolbar } from "./EditorToolbar"
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'

interface EditorToolbarContainerProps {
  editor: CodeMirrorEditorRef | null
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
