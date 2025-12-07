import { globalRendererRegistry } from '../registry'
import { headingRenderer } from './heading'
import { emphasisRenderer } from './emphasis'
import { linkRenderer } from './link'
import { inlineCodeRenderer, codeBlockRenderer } from './code'

// Export individual renderers for testing/customization
export { headingRenderer } from './heading'
export { emphasisRenderer } from './emphasis'
export { linkRenderer } from './link'
export { inlineCodeRenderer, codeBlockRenderer } from './code'

/**
 * Register all built-in renderers with the global registry.
 * Called once at module initialization.
 */
export function registerBuiltinRenderers(): void {
  // P0: Core formatting
  globalRendererRegistry.register(headingRenderer)
  globalRendererRegistry.register(emphasisRenderer)

  // P1: Links and code
  globalRendererRegistry.register(linkRenderer)
  globalRendererRegistry.register(inlineCodeRenderer)
  globalRendererRegistry.register(codeBlockRenderer)

  // P2: Lists, blockquotes - to be added
  // P3: Tables - deferred
}

// Auto-register on module load
registerBuiltinRenderers()
