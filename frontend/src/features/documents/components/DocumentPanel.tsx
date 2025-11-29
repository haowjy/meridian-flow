import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/core/stores/useUIStore'
import { DocumentTreeContainer } from './DocumentTreeContainer'
import { EditorPanel } from './EditorPanel'

interface DocumentPanelProps {
  projectId: string
}

/**
 * View switcher for document experience.
 * Shows either document tree (for browsing) or editor (for editing).
 * View determined by UIStore.rightPanelState.
 */
export function DocumentPanel({ projectId }: DocumentPanelProps) {
  const { rightPanelState, activeDocumentId } = useUIStore(useShallow((s) => ({
    rightPanelState: s.rightPanelState,
    activeDocumentId: s.activeDocumentId,
  })))

  // Editor view: Show editor with active document
  if (rightPanelState === 'editor' && activeDocumentId) {
    return <EditorPanel documentId={activeDocumentId} />
  }

  // Default view: Show document tree
  return <DocumentTreeContainer projectId={projectId} />
}
