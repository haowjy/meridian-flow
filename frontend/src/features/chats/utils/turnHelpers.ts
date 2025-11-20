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

/**
 * Checks if a turn has any content blocks.
 *
 * @param turn - The turn to check
 * @returns True if turn has at least one block
 */
export function hasTurnContent(turn: Turn): boolean {
  return turn.blocks.length > 0
}

/**
 * Checks if a turn has a specific block type.
 *
 * @param turn - The turn to check
 * @param blockType - The block type to look for (e.g., 'text', 'thinking', 'tool_use')
 * @returns True if turn has at least one block of the specified type
 */
export function hasTurnBlockType(turn: Turn, blockType: string): boolean {
  return turn.blocks.some((b) => b.blockType === blockType)
}

/**
 * Gets all blocks of a specific type from a turn.
 *
 * @param turn - The turn to filter
 * @param blockType - The block type to filter for
 * @returns Array of blocks matching the type
 */
export function getTurnBlocksByType(turn: Turn, blockType: string): TurnBlock[] {
  return turn.blocks.filter((b) => b.blockType === blockType)
}
