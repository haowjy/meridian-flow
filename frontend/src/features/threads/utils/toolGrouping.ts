import type { ToolBlockContent, TurnBlock } from '@/features/threads/types'
import { normalizeToolCallId } from '@/features/threads/utils/normalizeToolCallId'

export type AssistantRenderItem =
  | { kind: 'block'; block: TurnBlock }
  | { kind: 'toolInteraction'; toolUse: TurnBlock | null; toolResult: TurnBlock | null }

/**
 * Extract toolUseId from a block, normalized for consistent comparison.
 */
function getToolUseId(block: TurnBlock): string | null {
  if (!block.content) return null
  const value = (block.content as ToolBlockContent).toolUseId
  return typeof value === 'string' ? normalizeToolCallId(value) : null
}

/**
 * Groups tool_use + tool_result blocks with matching tool_use_id into a single
 * render item while leaving all other blocks untouched.
 *
 * Uses a two-pass algorithm to handle blocks arriving in any order
 * (result may arrive before use in streaming scenarios).
 *
 * This is a view-level grouping only – it does not mutate underlying data.
 */
export function buildAssistantRenderItems(blocks: TurnBlock[]): AssistantRenderItem[] {
  const items: AssistantRenderItem[] = []
  const consumedResultIndices = new Set<number>()

  // SOLID O: Pre-build lookup map for O(1) access regardless of order.
  // This allows matching tool_result to tool_use even if result arrives first.
  const toolResultIdToIndex = new Map<string, number>()

  // First pass: build result lookup map
  blocks.forEach((block, index) => {
    if (!block) return
    if (block.blockType !== 'tool_result') return
    const id = getToolUseId(block)
    if (!id) return
    // Only store the first result for each id (in case of duplicates)
    if (!toolResultIdToIndex.has(id)) {
      toolResultIdToIndex.set(id, index)
    }
  })

  // Second pass: group items
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block) continue

    if (block.blockType === 'tool_use') {
      const toolUseId = getToolUseId(block)
      if (!toolUseId) {
        items.push({ kind: 'block', block })
        continue
      }

      // Find matching result (may be before OR after in array)
      const resultIndex = toolResultIdToIndex.get(toolUseId)
      let matchedResult: TurnBlock | null = null
      if (resultIndex !== undefined && !consumedResultIndices.has(resultIndex)) {
        matchedResult = blocks[resultIndex] ?? null
        consumedResultIndices.add(resultIndex)
      }

      items.push({
        kind: 'toolInteraction',
        toolUse: block,
        toolResult: matchedResult,
      })
      continue
    }

    if (block.blockType === 'tool_result') {
      if (consumedResultIndices.has(i)) {
        // Already paired with a tool_use
        continue
      }

      // Result without a visible tool_use: render as a standalone interaction
      items.push({
        kind: 'toolInteraction',
        toolUse: null,
        toolResult: block,
      })
      continue
    }

    items.push({ kind: 'block', block })
  }

  return items
}
