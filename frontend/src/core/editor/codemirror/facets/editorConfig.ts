import type { Facet } from '@codemirror/state'
import { Facet as FacetClass } from '@codemirror/state'

/**
 * Editor-wide configuration facet.
 * Multiple extensions can contribute to this configuration,
 * and the values are combined automatically.
 *
 * This follows OCP - new configuration options can be added
 * without modifying existing code.
 */
export interface EditorConfig {
  /** Show line numbers */
  lineNumbers?: boolean
  /** Enable line wrapping */
  lineWrapping?: boolean
  /** Tab size for indentation */
  tabSize?: number
  /** Use spaces instead of tabs */
  indentWithSpaces?: boolean
}

/**
 * Facet for editor configuration.
 * Combines multiple contributions by merging objects.
 */
export const editorConfigFacet = FacetClass.define<EditorConfig, EditorConfig>({
  combine: (configs) => {
    // Merge all config objects, later values override earlier
    return configs.reduce(
      (acc, config) => ({ ...acc, ...config }),
      {
        // Defaults
        lineNumbers: false,
        lineWrapping: true,
        tabSize: 2,
        indentWithSpaces: true,
      }
    )
  },
})

/**
 * Get the current editor configuration from state.
 */
export function getEditorConfig(state: { facet: <T>(facet: Facet<EditorConfig, T>) => T }): EditorConfig {
  return state.facet(editorConfigFacet)
}
