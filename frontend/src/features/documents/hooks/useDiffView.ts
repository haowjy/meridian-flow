/**
 * useDiffView - Diff view extension management and hunk navigation.
 *
 * This hook handles:
 * - CodeMirror compartment for diff extension
 * - Enable/disable diff decorations based on marker presence
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

// =============================================================================
// TYPES
// =============================================================================

export interface UseDiffViewOptions {
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

  // Compartment for diff view extension
  const diffCompartmentRef = useRef<Compartment | null>(null)
  if (!diffCompartmentRef.current) {
    diffCompartmentRef.current = new Compartment()
  }
  const diffCompartment = diffCompartmentRef.current
  const diffEnabledRef = useRef(false)

  // ---------------------------------------------------------------------------
  // DERIVED STATE
  // ---------------------------------------------------------------------------

  // Computed hunks from current document
  const hunks = useMemo(() => extractHunks(localDocument), [localDocument])

  // Diff mode active = markers exist (NOT based on aiVersion from server)
  const hasAISuggestions = hasAnyMarker(localDocument)

  // Initial extension array (empty diff compartment)
  const initialExtensions = useMemo(() => [diffCompartment.of([])], [diffCompartment])

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

  // Enable/disable diff extension when hasAISuggestions changes
  useEffect(() => {
    if (!isEditorReady) return
    const view = editorRef.current?.getView()
    if (!view) return

    const shouldEnable = hasAISuggestions

    if (shouldEnable && !diffEnabledRef.current) {
      view.dispatch({
        effects: diffCompartment.reconfigure(createDiffViewExtension()),
      })
      diffEnabledRef.current = true
    } else if (!shouldEnable && diffEnabledRef.current) {
      view.dispatch({
        effects: diffCompartment.reconfigure([]),
      })
      diffEnabledRef.current = false
    }
  }, [isEditorReady, hasAISuggestions, diffCompartment, editorRef])

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
