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
 * - URLs use document path with extension (/projects/my-novel/documents/Characters/Heroes/Aria.md)
 * - Path segments are URL-encoded to handle special characters (spaces, etc.)
 * - Browser back/forward handles all navigation (standard behavior)
 * - UI state synced by WorkspaceLayout when URL changes
 */

/**
 * Encodes a document path for use in URLs.
 * Returns path as-is - TanStack Router handles URL encoding automatically.
 * (Previously we encoded here, causing double-encoding since router also encodes.)
 * Example: "Chapter 1/Scene 2.md" → "Chapter 1/Scene 2.md" (router encodes to "Chapter%201/Scene%202.md")
 */
export function encodeDocumentPath(path: string): string {
  return path
}

/**
 * Decodes a URL path back to a document path.
 * Handles both single-encoded (%20) and double-encoded (%2520) URLs.
 * Double-encoding can occur from legacy bookmarks or manual URL construction.
 * Example: "Chapter%201/Scene%202.md" → "Chapter 1/Scene 2.md"
 * Example: "Chapter%25201/Scene%25202.md" → "Chapter 1/Scene 2.md"
 */
export function decodeDocumentPath(urlPath: string): string {
  let decoded = urlPath.split('/').map(decodeURIComponent).join('/')
  // Handle double-encoded URLs (legacy bookmarks) - decode again if encoded chars remain
  if (/%[0-9A-Fa-f]{2}/.test(decoded)) {
    decoded = decodeURIComponent(decoded)
  }
  return decoded
}

/**
 * Opens a document in the editor.
 * - Directly sets UI state to show editor (handles same-document clicks)
 * - Navigates to document URL via navigate()
 * - WorkspaceLayout effect will also sync if URL actually changes
 *
 * @param documentId - The UUID of the document to open (for UI state)
 * @param documentPath - The display path of the document (e.g., "Characters/Heroes/Aria.md")
 * @param projectSlug - The project slug (for URL)
 * @param navigate - TanStack Router navigate function from useNavigate()
 */
export function openDocument(
  documentId: string,
  documentPath: string,
  projectSlug: string,
  navigate: NavigateFunction
) {
  const store = useUIStore.getState()

  // Set UI state directly (needed when clicking current document after manual toggle)
  logger.debug('openDocument:', documentId, 'path:', documentPath)
  store.setActiveDocument(documentId)
  store.setRightPanelState('editor')
  store.setRightPanelCollapsed(false)

  // Navigate to document URL using path (updates browser history)
  // Splat route captures all segments: /documents/Characters/Heroes/Aria.md
  // Path is URL-encoded to handle special characters (spaces, etc.)
  // If URL is already this document, router won't navigate, but state is already set above
  navigate({
    to: '/projects/$slug/documents/$',
    params: { slug: projectSlug, _splat: encodeDocumentPath(documentPath) },
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
 * Opens a skill in the editor.
 * - Directly sets UI state to show editor (handles same-skill clicks)
 * - Navigates to skill URL via navigate()
 * - WorkspaceLayout effect will also sync if URL actually changes
 *
 * @param skillId - The UUID of the skill to open (for UI state)
 * @param skillName - The skill name identifier (e.g., "writing-coach") for URL
 * @param projectSlug - The project slug (for URL)
 * @param navigate - TanStack Router navigate function from useNavigate()
 */
export function openSkill(
  skillId: string,
  skillName: string,
  projectSlug: string,
  navigate: NavigateFunction
) {
  const store = useUIStore.getState()

  // Set UI state directly (needed when clicking current skill after manual toggle)
  logger.debug('openSkill:', skillId, 'name:', skillName)
  store.setActiveSkill(skillId) // Already clears activeDocumentId for mutual exclusivity
  store.setRightPanelState('editor')
  store.setRightPanelCollapsed(false)

  // Navigate to skill URL using name identifier
  // If URL is already this skill, router won't navigate, but state is already set above
  navigate({
    to: '/projects/$slug/skills/$skillName',
    params: { slug: projectSlug, skillName },
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
