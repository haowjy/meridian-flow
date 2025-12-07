/**
 * Renderer Registration
 *
 * SOLID: Open/Closed - Registers all built-in renderers
 *
 * To add a new renderer:
 * 1. Create a new file in this directory
 * 2. Export a NodeRenderer
 * 3. Import and register it here
 */

import { registerRenderer } from '../plugin'
import { boldRenderer, italicRenderer } from './emphasis'
import { heading1Renderer, heading2Renderer, heading3Renderer } from './heading'
import { linkRenderer } from './link'
import { inlineCodeRenderer, fencedCodeRenderer } from './code'
import { listItemRenderer } from './list'
import { blockquoteRenderer } from './blockquote'
import { horizontalRuleRenderer } from './horizontalRule'
import { strikethroughRenderer } from './strikethrough'
import { tableRenderer } from './table'

/**
 * Register all built-in renderers
 */
export function registerBuiltinRenderers(): void {
  // Emphasis
  registerRenderer(boldRenderer)
  registerRenderer(italicRenderer)

  // Headings
  registerRenderer(heading1Renderer)
  registerRenderer(heading2Renderer)
  registerRenderer(heading3Renderer)

  // Links
  registerRenderer(linkRenderer)

  // Code
  registerRenderer(inlineCodeRenderer)
  registerRenderer(fencedCodeRenderer)

  // Lists
  registerRenderer(listItemRenderer)

  // Blockquotes
  registerRenderer(blockquoteRenderer)

  // Horizontal rules
  registerRenderer(horizontalRuleRenderer)

  // Strikethrough (GFM)
  registerRenderer(strikethroughRenderer)

  // Tables (GFM)
  registerRenderer(tableRenderer)
}

// Re-export individual renderers for testing/customization
export { boldRenderer, italicRenderer } from './emphasis'
export { heading1Renderer, heading2Renderer, heading3Renderer } from './heading'
export { linkRenderer } from './link'
export { inlineCodeRenderer, fencedCodeRenderer } from './code'
export { listItemRenderer } from './list'
export { blockquoteRenderer } from './blockquote'
export { horizontalRuleRenderer } from './horizontalRule'
export { strikethroughRenderer } from './strikethrough'
export { tableRenderer } from './table'
