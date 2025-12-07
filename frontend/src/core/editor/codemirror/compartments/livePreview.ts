import { Compartment } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { livePreviewPlugin } from '../livePreview/plugin'

/**
 * Compartment for live preview mode.
 * Allows toggling live preview on/off at runtime.
 *
 * This follows ISP - live preview is separate from
 * other editor features and can be toggled independently.
 */
export const livePreviewCompartment = new Compartment()

/**
 * Get the live preview extension.
 * Returns the actual live preview plugin when enabled.
 */
export function getLivePreviewExtension(enabled: boolean = false): Extension {
  if (enabled) {
    return livePreviewPlugin
  }
  return []
}

/**
 * Get the compartment wrapper for live preview.
 */
export function getLivePreviewCompartment(enabled: boolean = false): Extension {
  return livePreviewCompartment.of(getLivePreviewExtension(enabled))
}

/**
 * Toggle live preview mode at runtime.
 */
export function setLivePreview(view: EditorView, enabled: boolean): void {
  view.dispatch({
    effects: livePreviewCompartment.reconfigure(getLivePreviewExtension(enabled)),
  })
}
