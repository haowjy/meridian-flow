/**
 * Focused Hunk State
 *
 * SRP: Manages focused hunk index in CM6 state.
 * Pattern follows blockedEditEffect.ts conventions.
 *
 * This enables React store → CM6 synchronization:
 * - React store holds focusedHunkIndex (source of truth)
 * - EditorPanel dispatches setFocusedHunkIndexEffect to sync with CM6
 * - DiffViewPlugin reads focusedHunkIndexField to render focused state
 */

import { StateEffect, StateField } from '@codemirror/state'

// =============================================================================
// STATE EFFECT
// =============================================================================

/**
 * Effect to sync React focusedHunkIndex → CM6.
 *
 * Dispatched by EditorPanel when useEditorStore.focusedHunkIndex changes.
 *
 * @example
 * ```typescript
 * // In EditorPanel useEffect:
 * view.dispatch({
 *   effects: setFocusedHunkIndexEffect.of(focusedHunkIndex)
 * })
 * ```
 */
export const setFocusedHunkIndexEffect = StateEffect.define<number>()

// =============================================================================
// STATE FIELD
// =============================================================================

/**
 * StateField tracking focused hunk index within CM6.
 *
 * - Initialized to 0 (first hunk)
 * - Updated when setFocusedHunkIndexEffect is dispatched
 * - Read by DiffViewPluginClass.buildDecorations() to apply focus styling
 */
export const focusedHunkIndexField = StateField.define<number>({
  create: () => 0,
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setFocusedHunkIndexEffect)) {
        return e.value
      }
    }
    return value
  },
})
