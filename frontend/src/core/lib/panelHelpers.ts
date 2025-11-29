import { useUIStore } from '@/core/stores/useUIStore'
import type { useNavigate } from '@tanstack/react-router'
import { makeLogger } from '@/core/lib/logger'

const logger = makeLogger('panel-helpers')

type NavigateFunction = ReturnType<typeof useNavigate>

/**
 * Panel coordination helpers for managing workspace state.
 * These functions orchestrate routing and ensure panels stay in sync
 * when switching between chats, documents, and editor.
 *
 * Navigation:
 * - URL reflects document state (shareable, bookmarkable, refresh-safe)
 * - Browser back/forward handles all navigation (standard behavior)
 * - UI state synced by WorkspaceLayout when URL changes
 */

/**
 * Opens a document in the editor.
 * - Directly sets UI state to show editor (handles same-document clicks)
 * - Navigates to document URL via navigate()
 * - WorkspaceLayout effect will also sync if URL actually changes
 *
 * @param documentId - The ID of the document to open
 * @param projectId - The current project ID
 * @param navigate - TanStack Router navigate function from useNavigate()
 */
export function openDocument(
  documentId: string,
  projectId: string,
  navigate: NavigateFunction
) {
  const store = useUIStore.getState()

  // Set UI state directly (needed when clicking current document after manual toggle)
  logger.debug('openDocument:', documentId)
  store.setActiveDocument(documentId)
  store.setRightPanelState('editor')
  store.setRightPanelCollapsed(false)

  // Navigate to document URL (updates browser history)
  // If URL is already this document, router won't navigate, but state is already set above
  navigate({
    to: '/projects/$id/documents/$documentId',
    params: { id: projectId, documentId },
  })
}

/**
 * Closes the editor and returns to document tree view.
 * - Directly sets UI state to show tree
 * - Navigates to project tree URL via navigate()
 * - WorkspaceLayout effect will also sync if URL actually changes
 *
 * @param projectId - The current project ID
 * @param navigate - TanStack Router navigate function from useNavigate()
 */
export function closeEditor(projectId: string, navigate: NavigateFunction) {
  const store = useUIStore.getState()

  // Set UI state directly
  logger.debug('closeEditor')
  store.setActiveDocument(null)
  store.setRightPanelState('documents')

  // Navigate to tree URL (updates browser history)
  navigate({
    to: '/projects/$id',
    params: { id: projectId },
  })
}

/**
 * Switches to a different chat in the active chat panel.
 * - Sets the active chat ID
 * - Does not affect panel collapse states
 *
 * @param chatId - The ID of the chat to switch to
 */
export function switchChat(chatId: string) {
  const store = useUIStore.getState()

  store.setActiveChat(chatId)
}
