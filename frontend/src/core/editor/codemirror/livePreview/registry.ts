import type { MarkdownRenderer } from './types'

/**
 * Registry for markdown renderers.
 * Follows OCP - new renderers can be registered without modifying existing code.
 *
 * @example
 * ```ts
 * const registry = new RendererRegistry()
 * registry.register(headingRenderer)
 * registry.register(emphasisRenderer)
 *
 * // Later, get all renderers for a node type
 * const renderers = registry.getRenderers('ATXHeading1')
 * ```
 */
export class RendererRegistry {
  private renderers: MarkdownRenderer[] = []
  private nodeTypeMap: Map<string, MarkdownRenderer[]> = new Map()

  /**
   * Register a renderer.
   * Multiple renderers can handle the same node type.
   */
  register(renderer: MarkdownRenderer): void {
    this.renderers.push(renderer)

    // Index by node type for fast lookup
    for (const nodeType of renderer.nodeTypes) {
      const existing = this.nodeTypeMap.get(nodeType) || []
      existing.push(renderer)
      this.nodeTypeMap.set(nodeType, existing)
    }
  }

  /**
   * Get all renderers that handle the given node type.
   */
  getRenderers(nodeType: string): MarkdownRenderer[] {
    return this.nodeTypeMap.get(nodeType) || []
  }

  /**
   * Get all registered renderers.
   */
  getAllRenderers(): MarkdownRenderer[] {
    return this.renderers
  }

  /**
   * Check if any renderer handles the given node type.
   */
  hasRenderer(nodeType: string): boolean {
    return this.nodeTypeMap.has(nodeType)
  }
}

/**
 * Global renderer registry instance.
 * Renderers are registered here and used by the live preview plugin.
 */
export const globalRendererRegistry = new RendererRegistry()
