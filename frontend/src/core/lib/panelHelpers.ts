import { useUIStore } from '@/core/stores/useUIStore'
import { useNavigationStore } from '@/core/stores/useNavigationStore'
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'

/**
 * Panel coordination helpers for managing workspace state.
 * These functions orchestrate routing and ensure panels stay in sync
 * when switching between chats, documents, and editor.
 *
 * Uses hybrid navigation:
 * - URL reflects document state (shareable, bookmarkable, refresh-safe)
 * - Custom navigation history for document-to-document navigation (skips tree)
 * - Browser back/forward includes tree visits (standard behavior)
 * - UI state synced by WorkspaceLayout when URL changes
 */

/**
 * Opens a document in the editor.
 * - Navigates to document URL via router.push()
 * - Tracks in custom navigation history (unless fromHistory is true)
 * - UI state will be synced by WorkspaceLayout when URL changes
 *
 * @param documentId - The ID of the document to open
 * @param projectId - The current project ID
 * @param router - Next.js router instance from useRouter()
 * @param fromHistory - If true, skip adding to navigation history (used by back/forward)
 */
export function openDocument(
  documentId: string,
  projectId: string,
  router: AppRouterInstance,
  fromHistory = false
) {
  // Navigate to document URL (updates browser history)
  router.push(`/projects/${projectId}/documents/${documentId}`)

  // Track in custom navigation history unless this is a history navigation
  if (!fromHistory) {
    useNavigationStore.getState().push(documentId)
  }

  // Note: UI state will be synced by WorkspaceLayout when URL changes
}

/**
 * Closes the editor and returns to document tree view.
 * - Navigates to project tree URL via router.push()
 * - UI state will be synced by WorkspaceLayout when URL changes
 *
 * @param projectId - The current project ID
 * @param router - Next.js router instance from useRouter()
 */
export function closeEditor(projectId: string, router: AppRouterInstance) {
  // Navigate to tree URL (updates browser history)
  router.push(`/projects/${projectId}`)

  // Note: UI state will be synced by WorkspaceLayout when URL changes
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

/**
 * Navigates backward in custom document history.
 * - Uses custom navigation stack (skips tree visits)
 * - Opens previous document in editor
 * - Does nothing if already at beginning of history
 *
 * @param projectId - The current project ID
 * @param router - Next.js router instance from useRouter()
 */
export function navigateBack(projectId: string, router: AppRouterInstance) {
  const navStore = useNavigationStore.getState()
  const prevDocId = navStore.back()

  if (prevDocId) {
    openDocument(prevDocId, projectId, router, true)
  }
}

/**
 * Navigates forward in custom document history.
 * - Uses custom navigation stack (skips tree visits)
 * - Opens next document in editor
 * - Does nothing if already at end of history
 *
 * @param projectId - The current project ID
 * @param router - Next.js router instance from useRouter()
 */
export function navigateForward(projectId: string, router: AppRouterInstance) {
  const navStore = useNavigationStore.getState()
  const nextDocId = navStore.forward()

  if (nextDocId) {
    openDocument(nextDocId, projectId, router, true)
  }
}
