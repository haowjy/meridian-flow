import type { EditorState } from '@codemirror/state'

/**
 * Cached editor state with scroll position.
 */
interface CachedEditor {
  state: EditorState
  scrollTop: number
  scrollLeft: number
  lastAccess: number
}

const MAX_CACHED_EDITORS = 5

/**
 * Editor state cache.
 * Stores EditorState + scroll position for instant document switching.
 *
 * SRP: This class ONLY manages the cache. No view creation, no DOM handling.
 */
class EditorCache {
  private cache = new Map<string, CachedEditor>()

  /**
   * Get cached editor state for document.
   */
  get(documentId: string): CachedEditor | undefined {
    const cached = this.cache.get(documentId)
    if (cached) {
      // Update last access time
      cached.lastAccess = Date.now()
    }
    return cached
  }

  /**
   * Cache editor state for document.
   */
  set(
    documentId: string,
    state: EditorState,
    scrollTop: number = 0,
    scrollLeft: number = 0
  ): void {
    this.cache.set(documentId, {
      state,
      scrollTop,
      scrollLeft,
      lastAccess: Date.now(),
    })

    // Evict oldest if over limit
    this.evictIfNeeded()
  }

  /**
   * Update just the state (preserves scroll).
   */
  updateState(documentId: string, state: EditorState): void {
    const cached = this.cache.get(documentId)
    if (cached) {
      cached.state = state
      cached.lastAccess = Date.now()
    }
  }

  /**
   * Update scroll position.
   */
  updateScroll(documentId: string, scrollTop: number, scrollLeft: number): void {
    const cached = this.cache.get(documentId)
    if (cached) {
      cached.scrollTop = scrollTop
      cached.scrollLeft = scrollLeft
    }
  }

  /**
   * Check if document is cached.
   */
  has(documentId: string): boolean {
    return this.cache.has(documentId)
  }

  /**
   * Remove document from cache.
   */
  delete(documentId: string): void {
    this.cache.delete(documentId)
  }

  /**
   * Clear all cached editors.
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Evict least recently used editors if over limit.
   */
  private evictIfNeeded(): void {
    while (this.cache.size > MAX_CACHED_EDITORS) {
      let oldestId: string | null = null
      let oldestTime = Infinity

      for (const [id, cached] of this.cache) {
        if (cached.lastAccess < oldestTime) {
          oldestTime = cached.lastAccess
          oldestId = id
        }
      }

      if (oldestId) {
        this.cache.delete(oldestId)
      }
    }
  }

  /**
   * Get cache stats (for debugging).
   */
  getStats(): { size: number; documentIds: string[] } {
    return {
      size: this.cache.size,
      documentIds: Array.from(this.cache.keys()),
    }
  }
}

// Singleton instance
export const editorCache = new EditorCache()
