/**
 * Block rendering system for turn content.
 *
 * This module provides an extensible system for rendering different types
 * of content blocks within chat turns (text, thinking, tool use, etc.).
 */

export { BlockRenderer } from './BlockRenderer'
export { TextBlock } from './TextBlock'
export { ThinkingBlock } from './ThinkingBlock'
export {
  getBlockRenderer,
  registerBlockRenderer,
  getRegisteredBlockTypes,
  type BlockRendererFn,
} from './registry'
