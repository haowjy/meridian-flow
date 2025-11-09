import { useUIStore } from '@/core/stores/useUIStore'
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'

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
 * - Navigates to document URL via router.push()
 * - WorkspaceLayout effect will also sync if URL actually changes
 *
 * @param documentId - The ID of the document to open
 * @param projectId - The current project ID
 * @param router - Next.js router instance from useRouter()
 */
export function openDocument(
  documentId: string,
  projectId: string,
  router: AppRouterInstance
) {
  const store = useUIStore.getState()

  // Set UI state directly (needed when clicking current document after manual toggle)
  console.log('[panelHelpers] openDocument:', documentId)
  store.setActiveDocument(documentId)
  store.setRightPanelState('editor')
  store.setRightPanelCollapsed(false)

  // Navigate to document URL (updates browser history)
  // If URL is already this document, router won't navigate, but state is already set above
  router.push(`/projects/${projectId}/documents/${documentId}`)
}

/**
 * Closes the editor and returns to document tree view.
 * - Directly sets UI state to show tree
 * - Navigates to project tree URL via router.push()
 * - WorkspaceLayout effect will also sync if URL actually changes
 *
 * @param projectId - The current project ID
 * @param router - Next.js router instance from useRouter()
 */
export function closeEditor(projectId: string, router: AppRouterInstance) {
  const store = useUIStore.getState()

  // Set UI state directly
  console.log('[panelHelpers] closeEditor')
  store.setActiveDocument(null)
  store.setRightPanelState('documents')

  // Navigate to tree URL (updates browser history)
  router.push(`/projects/${projectId}`)
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
