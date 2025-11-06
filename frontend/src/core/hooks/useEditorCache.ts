import { useRef, useCallback, useEffect, useState } from 'react'
import { makeLogger } from '@/core/lib/logger'
import { Editor } from '@tiptap/react'
import type { Extensions, EditorOptions } from '@tiptap/core'

interface CachedEditor {
  editor: Editor
  lastAccessed: Date
  lastContent: string // Track to detect content changes
}

// Global editor cache (persists across component mounts)
// Cleared manually via clearEditorCache() when switching projects
const globalEditorCache = new Map<string, CachedEditor>()
const log = makeLogger('editor-cache')

interface UseEditorCacheOptions extends Partial<EditorOptions> {
  documentId: string
  content: string
  extensions: Extensions
  maxCacheSize?: number
  // TipTap React option to avoid SSR hydration mismatch
  immediatelyRender?: boolean
}

interface UseEditorCacheResult {
  editor: Editor | null
  isFromCache: boolean // True if editor was retrieved from cache (has existing content/state)
}

/**
 * Hook to maintain an LRU cache of TipTap editor instances.
 *
 * Problem: Creating new editor instances on every document switch is slow (50-200ms)
 * because setContent() has to parse HTML and rebuild ProseMirror state.
 *
 * Solution: Keep last N editors in memory, instantly switch between them.
 *
 * Benefits:
 * - Instant document switching for recently viewed docs
 * - Preserves undo history across switches
 * - Preserves cursor position
 *
 * Trade-offs:
 * - Increased memory usage (~5-10MB per editor, 25-50MB for 5 editors)
 * - Complexity of cache management
 *
 * @example
 * ```tsx
 * const { editor, isFromCache } = useEditorCache({
 *   documentId: 'doc-123',
 *   content: '<p>Hello</p>',
 *   extensions: [StarterKit, ...],
 *   editable: true,
 *   onUpdate: ({ editor }) => { ... }
 * })
 * ```
 */
export function useEditorCache(options: UseEditorCacheOptions): UseEditorCacheResult {
  const { documentId, content, extensions, maxCacheSize = 5, ...editorOptions } = options

  // Expose cache-hit status and current editor through React state so callers re-render
  const [isFromCache, setIsFromCache] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)

  // Evict least recently used editor when cache is full
  const evictLRU = useCallback(() => {
    if (globalEditorCache.size < maxCacheSize) return

    log.debug('cache full', `${globalEditorCache.size}/${maxCacheSize}`, 'evicting LRU')

    // Find least recently used
    let lruKey: string | null = null
    let lruTime = new Date()

    for (const [key, value] of globalEditorCache.entries()) {
      if (value.lastAccessed < lruTime) {
        lruTime = value.lastAccessed
        lruKey = key
      }
    }

    if (lruKey) {
      const lruEditor = globalEditorCache.get(lruKey)
      if (lruEditor) {
        log.debug('destroying editor for', lruKey)
        lruEditor.editor.destroy()
        globalEditorCache.delete(lruKey)
      }
    }
  }, [maxCacheSize])

  // Create new editor instance
  const createEditor = useCallback(
    (): Editor => {
      log.debug('creating new editor for', documentId)

      // Evict before creating to ensure we don't exceed limit
      evictLRU()

      // CRITICAL: Create editor with EMPTY content to avoid stale data
      // EditorPanel will initialize it with correct content after loadDocument completes
      const editor = new Editor({
        ...editorOptions,
        extensions,
        content: '', // Start empty, will be set by EditorPanel sync effect
      })

      // Cache it globally
      globalEditorCache.set(documentId, {
        editor,
        lastAccessed: new Date(),
        lastContent: '', // Track as empty initially
      })

      return editor
    },
    [documentId, extensions, editorOptions, evictLRU]
  )

  // Keep a ref mirror to avoid re-creating option listeners on every render
  const editorRef = useRef<Editor | null>(null)

  // Get or create editor when documentId changes (NOT on option/content changes)
  useEffect(() => {
    const cached = globalEditorCache.get(documentId)

    if (cached) {
      // Cache hit!
      log.debug('cache hit for', documentId)
      setIsFromCache(true)

      // Update last accessed time (for LRU)
      cached.lastAccessed = new Date()

      editorRef.current = cached.editor
      setEditor(cached.editor)
    } else {
      // Cache miss - create new empty editor
      // EditorPanel will initialize it with proper content
      log.debug('cache miss for', documentId)
      setIsFromCache(false)

      const created = createEditor()
      editorRef.current = created
      setEditor(created)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]) // Only re-run when document changes, NOT content/options

  // REMOVED: Content update effect
  // Reason: This was overwriting cached editors with stale localContent
  // Now EditorPanel handles content sync with proper cache awareness

  // Update editor options when they change (editable, callbacks, etc.)
  useEffect(() => {
    if (!editor) return

    // Update editable state
    if (editorOptions.editable !== undefined) {
      editor.setEditable(editorOptions.editable)
    }

    // Update onUpdate callback if provided
    // Remove old listener and add new one to avoid stale closures
    if (editorOptions.onUpdate) {
      editor.off('update')
      editor.on('update', editorOptions.onUpdate)
    }

    return () => {
      // Cleanup listeners on unmount or when options change
      if (editorOptions.onUpdate) {
        editor.off('update', editorOptions.onUpdate)
      }
    }
  }, [editor, editorOptions.editable, editorOptions.onUpdate])

  return {
    editor,
    isFromCache,
  }
}

/**
 * Utility to manually clear the editor cache.
 * Call this when switching projects or logging out to prevent memory leaks
 * and ensure stale editors don't persist.
 *
 * @example
 * ```tsx
 * // In ProjectStore or logout handler:
 * import { clearEditorCache } from '@/core/hooks/useEditorCache'
 *
 * setCurrentProject: (project) => {
 *   clearEditorCache() // Clear editors from previous project
 *   set({ currentProjectId: project?.id })
 * }
 * ```
 */
export function clearEditorCache() {
  log.info('clearing cache', `(${globalEditorCache.size} editors)`) 

  // Destroy all editors to free memory
  for (const { editor } of globalEditorCache.values()) {
    editor.destroy()
  }

  // Clear the cache
  globalEditorCache.clear()

  log.info('cache cleared')
}
