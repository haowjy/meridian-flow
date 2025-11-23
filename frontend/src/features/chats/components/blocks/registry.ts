import React from 'react'
import type { TurnBlock } from '@/features/chats/types'
import { TextBlock } from './TextBlock'
import { ThinkingBlock } from './ThinkingBlock'

/**
 * Block renderer function type.
 * Each renderer receives a block and returns a React element.
 */
export type BlockRendererFn = (block: TurnBlock) => React.ReactElement

/**
 * Registry of block type to renderer function.
 *
 * This allows easy extension of new block types without modifying existing code.
 * Simply register a new block type and its renderer here.
 */
const BLOCK_RENDERERS: Record<string, BlockRendererFn> = {
  text: (block) => React.createElement(TextBlock, { block }),
  thinking: (block) => React.createElement(ThinkingBlock, { block }),
  // citation: (block) => React.createElement(CitationBlock, { block }),
  // image: (block) => React.createElement(ImageBlock, { block }),
}

/**
 * Get the renderer function for a given block type.
 * Returns TextBlock renderer as fallback for unknown block types.
 */
export function getBlockRenderer(blockType: string): BlockRendererFn {
  return BLOCK_RENDERERS[blockType] ?? BLOCK_RENDERERS.text!
}

/**
 * Register a custom block renderer.
 * Useful for plugins or custom block types.
 *
 * @example
 * ```ts
 * registerBlockRenderer('custom', (block) => <CustomBlock block={block} />)
 * ```
 */
export function registerBlockRenderer(
  blockType: string,
  renderer: BlockRendererFn
): void {
  BLOCK_RENDERERS[blockType] = renderer
}

/**
 * Get all registered block types.
 * Useful for debugging or listing available block types.
 */
export function getRegisteredBlockTypes(): string[] {
  return Object.keys(BLOCK_RENDERERS)
}
