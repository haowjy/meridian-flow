import { create } from 'zustand'

/**
 * Minimal navigation history store for document-to-document navigation.
 * Tracks only document IDs to skip tree visits when using custom back/forward.
 *
 * NOT persisted (session-only) - history clears on page reload.
 * Reusable across all document contexts (sidebar, full-screen, future modes).
 */
interface NavigationStore {
  /**
   * Navigation history - array of document IDs.
   * @default []
   */
  history: string[]

  /**
   * Current position in history (0-indexed).
   * @default -1 (no history)
   */
  currentIndex: number

  /**
   * Can navigate backward.
   * @returns true if currentIndex > 0
   */
  canGoBack: boolean

  /**
   * Can navigate forward.
   * @returns true if currentIndex < history.length - 1
   */
  canGoForward: boolean

  /**
   * Adds document to history.
   * - Truncates forward history if navigating from middle
   * - Skips if same as current document (prevents duplicates)
   *
   * @param documentId - Document ID to add
   */
  push: (documentId: string) => void

  /**
   * Navigates backward in history.
   * @returns Previous document ID or null if at beginning
   */
  back: () => string | null

  /**
   * Navigates forward in history.
   * @returns Next document ID or null if at end
   */
  forward: () => string | null

  /**
   * Clears all history.
   * Use when switching projects.
   */
  clear: () => void
}

export const useNavigationStore = create<NavigationStore>((set, get) => ({
  history: [],
  currentIndex: -1,
  canGoBack: false,
  canGoForward: false,

  push: (documentId) => {
    const { history, currentIndex } = get()

    // Skip if same as current document
    const currentDocId = history[currentIndex]
    if (currentDocId === documentId) {
      return
    }

    // Truncate forward history if in middle of stack
    const newHistory = history.slice(0, currentIndex + 1)

    // Add new document
    newHistory.push(documentId)

    const newIndex = newHistory.length - 1

    set({
      history: newHistory,
      currentIndex: newIndex,
      canGoBack: newIndex > 0,
      canGoForward: false,
    })
  },

  back: () => {
    const { history, currentIndex } = get()

    if (currentIndex <= 0) {
      return null
    }

    const newIndex = currentIndex - 1
    const documentId = history[newIndex]

    set({
      currentIndex: newIndex,
      canGoBack: newIndex > 0,
      canGoForward: true,
    })

    return documentId
  },

  forward: () => {
    const { history, currentIndex } = get()

    if (currentIndex >= history.length - 1) {
      return null
    }

    const newIndex = currentIndex + 1
    const documentId = history[newIndex]

    set({
      currentIndex: newIndex,
      canGoBack: true,
      canGoForward: newIndex < history.length - 1,
    })

    return documentId
  },

  clear: () => {
    set({
      history: [],
      currentIndex: -1,
      canGoBack: false,
      canGoForward: false,
    })
  },
}))
