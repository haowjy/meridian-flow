import type { Turn, TurnBlock } from '@/features/chats/types'

/**
 * Extracts plain text content from a turn's blocks.
 *
 * This filters for text blocks and concatenates their content.
 * Used for:
 * - Copy-to-clipboard functionality
 * - Edit dialog initial content
 * - Fallback display for legacy components
 *
 * @param turn - The turn to extract content from
 * @returns Plain text content, or empty string if no text blocks
 */
export function extractTextContent(turn: Turn): string {
  return extractTextFromBlocks(turn.blocks)
}

/**
 * Extracts plain text from an array of blocks.
 *
 * @param blocks - Array of turn blocks
 * @returns Plain text content, or empty string if no text blocks
 */
export function extractTextFromBlocks(blocks: TurnBlock[]): string {
  return blocks
    .filter((b) => b.blockType === 'text')
    .map((b) => b.textContent ?? '')
    .join('\n\n')
}
