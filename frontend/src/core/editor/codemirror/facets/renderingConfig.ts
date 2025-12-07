import type { Facet } from '@codemirror/state'
import { Facet as FacetClass } from '@codemirror/state'

/**
 * Live preview rendering configuration facet.
 * Controls how markdown elements are rendered in the editor.
 *
 * This follows OCP - new rendering options can be added
 * without modifying existing code.
 */
export interface RenderingConfig {
  /** Enable live preview mode (Obsidian-style WYSIWYG) */
  livePreview?: boolean
  /** Hide syntax when cursor is not on element */
  hideInactiveSyntax?: boolean
  /** Render links as clickable */
  clickableLinks?: boolean
  /** Maximum document size for full rendering (chars) */
  viewportOnlyThreshold?: number
}

/**
 * Facet for rendering configuration.
 * Combines multiple contributions by merging objects.
 */
export const renderingConfigFacet = FacetClass.define<RenderingConfig, RenderingConfig>({
  combine: (configs) => {
    return configs.reduce(
      (acc, config) => ({ ...acc, ...config }),
      {
        // Defaults
        livePreview: true,
        hideInactiveSyntax: true,
        clickableLinks: true,
        viewportOnlyThreshold: 100000, // ~50k words
      }
    )
  },
})

/**
 * Get the current rendering configuration from state.
 */
export function getRenderingConfig(state: { facet: <T>(facet: Facet<RenderingConfig, T>) => T }): RenderingConfig {
  return state.facet(renderingConfigFacet)
}
