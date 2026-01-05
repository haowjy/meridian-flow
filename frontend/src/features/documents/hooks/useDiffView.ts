/**
 * useDiffView - Diff view extension management and hunk navigation.
 *
 * This hook handles:
 * - CodeMirror compartment for diff extension (always-on for timing safety)
 * - Focus sync between React store and CM6 state
 * - Cursor navigation to focused hunk
 * - Hunk clamping when hunks are removed
 * - Navigation and bulk operation callbacks
 *
 * Designed for reuse with comment annotations (with different marker types).
 */

import { useEffect, useRef, useMemo, useCallback } from 'react'
import { Compartment, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEditorStore } from '@/core/stores/useEditorStore'
import { extractHunks, hasAnyMarker, type MergedHunk } from '@/core/lib/mergedDocument'
import {
  createDiffViewExtension,
  acceptAll,
  rejectAll,
  setFocusedHunkIndexEffect,
} from '@/core/editor/codemirror/diffView'
import type { CodeMirrorEditorRef } from '@/core/editor/codemirror'

/**
 * Content attribute extension that adds a class to .cm-content when diff mode is active.
 * Used for scroll padding so user can scroll past the floating AIHunkNavigator.
 */
const diffModeContentClass = EditorView.contentAttributes.of({ class: 'cm-diff-mode-active' })

// =============================================================================
// TYPES
// =============================================================================

export interface UseDiffViewOptions {
  documentId: string
  localDocument: string
  editorRef: React.MutableRefObject<CodeMirrorEditorRef | null>
  isEditorReady: boolean
  setHasUserEdit: (value: boolean) => void
}

export interface UseDiffViewResult {
  // State
  hunks: MergedHunk[]
  hasAISuggestions: boolean

  // Extensions (for CodeMirrorEditor)
  initialExtensions: Extension[]

  // Navigation callbacks
  handlePrevHunk: () => void
  handleNextHunk: () => void

  // Bulk operations
  handleAcceptAll: () => void
  handleRejectAll: () => void
}

// =============================================================================
// HOOK
// =============================================================================

export function useDiffView({
  documentId,
  localDocument,
  editorRef,
  isEditorReady,
  setHasUserEdit,
}: UseDiffViewOptions): UseDiffViewResult {
  // ---------------------------------------------------------------------------
  // STORE STATE
  // ---------------------------------------------------------------------------
  const {
    focusedHunkIndex,
    setFocusedHunkIndex,
    navigateHunk,
  } = useEditorStore()

  // ---------------------------------------------------------------------------
  // COMPARTMENT STATE
  // ---------------------------------------------------------------------------

  // Compartment for diff view extension.
  // CRITICAL: We must create a NEW compartment when the document changes because
  // CodeMirror Compartment's `of()` method creates an Extension that can only be
  // used once per editor instance. When documentId changes, CodeMirrorEditor
  // remounts (via key={documentId}), but this hook persists. Reusing the same
  // compartment.of() result with a new editor causes reconfigure to fail silently.
  const diffCompartmentRef = useRef<Compartment | null>(null)
  const compartmentDocIdRef = useRef<string | null>(null)

  // Reset compartment when document changes to ensure fresh extension for new editor
  if (compartmentDocIdRef.current !== documentId) {
    diffCompartmentRef.current = new Compartment()
    compartmentDocIdRef.current = documentId
  }

  const diffCompartment = diffCompartmentRef.current!

  // ---------------------------------------------------------------------------
  // DERIVED STATE
  // ---------------------------------------------------------------------------

  // Computed hunks from current document
  const hunks = useMemo(() => extractHunks(localDocument), [localDocument])

  // Diff mode active = markers exist (NOT based on aiVersion from server)
  const hasAISuggestions = hasAnyMarker(localDocument)

  // Initial extension array - ALWAYS include diff view extensions.
  // The plugin handles empty documents gracefully (no markers = no decorations).
  // This eliminates timing issues with dynamic enable/disable via reconfigure.
  const initialExtensions = useMemo(
    () => [diffCompartment.of([
      createDiffViewExtension(),
      diffModeContentClass,
    ])],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- diffCompartment is reset when documentId changes
    [documentId]
  )

  // ---------------------------------------------------------------------------
  // CALLBACKS
  // ---------------------------------------------------------------------------

  // Navigation callbacks
  const handlePrevHunk = useCallback(() => {
    navigateHunk('prev', hunks.length)
  }, [navigateHunk, hunks.length])

  const handleNextHunk = useCallback(() => {
    navigateHunk('next', hunks.length)
  }, [navigateHunk, hunks.length])

  // Bulk operations (via CM6 transactions)
  const handleAcceptAll = useCallback(() => {
    const view = editorRef.current?.getView()
    if (!view) return

    acceptAll(view)
    setHasUserEdit(true)
    setFocusedHunkIndex(0)
  }, [editorRef, setHasUserEdit, setFocusedHunkIndex])

  const handleRejectAll = useCallback(() => {
    const view = editorRef.current?.getView()
    if (!view) return

    rejectAll(view)
    setHasUserEdit(true)
    setFocusedHunkIndex(0)
  }, [editorRef, setHasUserEdit, setFocusedHunkIndex])

  // ---------------------------------------------------------------------------
  // EFFECTS
  // ---------------------------------------------------------------------------

  // No enable/disable effect needed - diff extension is always on.
  // The plugin handles empty documents gracefully (no markers = no decorations).

  // Sync focused hunk index to CM6 for decoration highlighting.
  // This SHOULD run on hunks change (decorations need current hunk positions).
  useEffect(() => {
    if (!isEditorReady || hunks.length === 0) return
    const view = editorRef.current?.getView()
    if (!view) return

    view.dispatch({
      effects: setFocusedHunkIndexEffect.of(focusedHunkIndex),
    })
  }, [focusedHunkIndex, hunks, isEditorReady, editorRef])

  // Navigate cursor to focused hunk (only on index change, not on typing).
  // Intentionally omits hunks from deps to prevent cursor jump on every keystroke.
  useEffect(() => {
    if (!isEditorReady) return
    const view = editorRef.current?.getView()
    if (!view) return

    const hunk = hunks[focusedHunkIndex]
    if (hunk) {
      view.dispatch({
        selection: { anchor: hunk.from },
        effects: EditorView.scrollIntoView(hunk.from, { y: 'center' }),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit hunks to prevent cursor jump on typing
  }, [focusedHunkIndex, isEditorReady, editorRef])

  // Clamp focusedHunkIndex when hunks are removed
  useEffect(() => {
    if (hunks.length === 0) {
      if (focusedHunkIndex !== 0) {
        setFocusedHunkIndex(0)
      }
    } else if (focusedHunkIndex >= hunks.length) {
      setFocusedHunkIndex(hunks.length - 1)
    }
  }, [hunks.length, focusedHunkIndex, setFocusedHunkIndex])

  // ---------------------------------------------------------------------------
  // RETURN
  // ---------------------------------------------------------------------------

  return {
    hunks,
    hasAISuggestions,
    initialExtensions,
    handlePrevHunk,
    handleNextHunk,
    handleAcceptAll,
    handleRejectAll,
  }
}
