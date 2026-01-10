import { useUIStore } from '@/core/stores/useUIStore'
import type { useNavigate } from '@tanstack/react-router'
import { makeLogger } from '@/core/lib/logger'

const logger = makeLogger('panel-helpers')

type NavigateFunction = ReturnType<typeof useNavigate>

/**
 * Panel coordination helpers for managing workspace state.
 * These functions orchestrate routing and ensure panels stay in sync
 * when switching between threads, documents, and editor.
 *
 * Navigation:
 * - URLs use path-based slugs (/projects/my-novel/documents/characters/heroes/aria)
 * - Browser back/forward handles all navigation (standard behavior)
 * - UI state synced by WorkspaceLayout when URL changes
 */

/**
 * Opens a document in the editor.
 * - Directly sets UI state to show editor (handles same-document clicks)
 * - Navigates to document URL via navigate()
 * - WorkspaceLayout effect will also sync if URL actually changes
 *
 * @param documentId - The UUID of the document to open (for UI state)
 * @param documentSlug - The path-based slug of the document (e.g., "characters/heroes/aria")
 * @param projectSlug - The project slug (for URL)
 * @param navigate - TanStack Router navigate function from useNavigate()
 */
export function openDocument(
  documentId: string,
  documentSlug: string,
  projectSlug: string,
  navigate: NavigateFunction
) {
  const store = useUIStore.getState()

  // Set UI state directly (needed when clicking current document after manual toggle)
  logger.debug('openDocument:', documentId, 'slug:', documentSlug)
  store.setActiveDocument(documentId)
  store.setRightPanelState('editor')
  store.setRightPanelCollapsed(false)

  // Mobile: swap to document panel
  store.setMobileActivePanel('document')

  // Navigate to document URL using path-based slug (updates browser history)
  // Splat route captures all segments: /documents/characters/heroes/aria
  // If URL is already this document, router won't navigate, but state is already set above
  navigate({
    to: '/projects/$slug/documents/$',
    params: { slug: projectSlug, _splat: documentSlug },
  })
}

/**
 * Closes the editor and returns to document tree view.
 * - Directly sets UI state to show tree
 * - Navigates to project tree URL via navigate()
 * - WorkspaceLayout effect will also sync if URL actually changes
 *
 * @param projectSlug - The project slug (for URL)
 * @param navigate - TanStack Router navigate function from useNavigate()
 */
export function closeEditor(projectSlug: string, navigate: NavigateFunction) {
  const store = useUIStore.getState()

  // Set UI state directly
  logger.debug('closeEditor')
  store.setActiveDocument(null)
  store.setRightPanelState('documents')

  // Navigate to tree URL using slug (updates browser history)
  navigate({
    to: '/projects/$slug',
    params: { slug: projectSlug },
  })
}

/**
 * Switches to a different thread in the active thread panel.
 * - Sets the active thread ID
 * - Does not affect panel collapse states
 *
 * @param threadId - The ID of the thread to switch to
 */
export function switchThread(threadId: string) {
  const store = useUIStore.getState()

  store.setActiveThread(threadId)
}
