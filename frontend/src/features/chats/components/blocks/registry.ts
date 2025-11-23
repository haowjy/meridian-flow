import React from 'react'
import type { TurnBlock } from '@/features/chats/types'
import { TextBlock } from './TextBlock'
import { ThinkingBlock } from './ThinkingBlock'

/**
 * Block renderer component type.
 * Each block renderer receives a block and renders it appropriately.
 */
export type BlockRendererComponent = React.ComponentType<{ block: TurnBlock }>

/**
 * Registry of block type to renderer component.
 *
 * This allows easy extension of new block types without modifying existing code.
 * Simply register a new block type and its renderer here.
 */
const BLOCK_RENDERERS: Record<string, BlockRendererComponent> = {
  text: TextBlock,
  thinking: ThinkingBlock,
  // citation: CitationBlock,
  // image: ImageBlock,
}

/**
 * Get the renderer component for a given block type.
 * Returns TextBlock as fallback for unknown block types.
 */
export function getBlockRenderer(blockType: string): BlockRendererComponent {
  return BLOCK_RENDERERS[blockType] ?? TextBlock
}

/**
 * Register a custom block renderer.
 * Useful for plugins or custom block types.
 *
 * @example
 * ```ts
 * registerBlockRenderer('custom', CustomBlock)
 * ```
 */
export function registerBlockRenderer(
  blockType: string,
  component: BlockRendererComponent
): void {
  BLOCK_RENDERERS[blockType] = component
}

/**
 * Get all registered block types.
 * Useful for debugging or listing available block types.
 */
export function getRegisteredBlockTypes(): string[] {
  return Object.keys(BLOCK_RENDERERS)
}
