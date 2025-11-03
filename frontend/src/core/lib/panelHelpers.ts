import { useUIStore } from '@/core/stores/useUIStore'

/**
 * Panel coordination helpers for managing workspace state.
 * These functions orchestrate multiple state updates to ensure
 * panels stay in sync when switching between chats, documents, and editor.
 */

/**
 * Opens a document in the editor.
 * - Sets the active document ID
 * - Switches right panel to 'editor' mode
 * - Expands right panel if currently collapsed
 *
 * @param documentId - The ID of the document to open
 */
export function openDocument(documentId: string) {
  const store = useUIStore.getState()

  store.setActiveDocument(documentId)
  store.setRightPanelState('editor')

  if (store.rightPanelCollapsed) {
    store.setRightPanelCollapsed(false)
  }
}

/**
 * Closes the editor and returns to document tree view.
 * - Clears the active document ID
 * - Switches right panel back to 'documents' mode
 * - Keeps panel expanded/collapsed state as-is
 */
export function closeEditor() {
  const store = useUIStore.getState()

  store.setActiveDocument(null)
  store.setRightPanelState('documents')
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
