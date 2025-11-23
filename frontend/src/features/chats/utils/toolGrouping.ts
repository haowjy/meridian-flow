import type { ToolBlockContent, TurnBlock } from '@/features/chats/types'

export type AssistantRenderItem =
  | { kind: 'block'; block: TurnBlock }
  | { kind: 'toolInteraction'; toolUse: TurnBlock | null; toolResult: TurnBlock | null }

/**
 * Groups tool_use + tool_result blocks with matching tool_use_id into a single
 * render item while leaving all other blocks untouched.
 *
 * This is a view-level grouping only – it does not mutate underlying data.
 */
export function buildAssistantRenderItems(blocks: TurnBlock[]): AssistantRenderItem[] {
  const items: AssistantRenderItem[] = []
  const consumedResultIndices = new Set<number>()

  const getToolUseId = (block: TurnBlock): string | null => {
    if (!block.content) return null
    const value = (block.content as ToolBlockContent).tool_use_id
    return typeof value === 'string' ? value : null
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]

    if (block.blockType === 'tool_use') {
      const toolUseId = getToolUseId(block)
      if (!toolUseId) {
        items.push({ kind: 'block', block })
        continue
      }

      // Look ahead for the first matching tool_result that hasn't been consumed yet.
      let matchedResult: TurnBlock | null = null
      for (let j = i + 1; j < blocks.length; j++) {
        const candidate = blocks[j]
        if (candidate.blockType !== 'tool_result') continue
        if (consumedResultIndices.has(j)) continue
        const candidateId = getToolUseId(candidate)
        if (candidateId && candidateId === toolUseId) {
          matchedResult = candidate
          consumedResultIndices.add(j)
          break
        }
      }

      items.push({
        kind: 'toolInteraction',
        toolUse: block,
        toolResult: matchedResult,
      })
      continue
    }

    if (block.blockType === 'tool_result') {
      const idx = blocks.indexOf(block)
      if (consumedResultIndices.has(idx)) {
        // Already paired with a previous tool_use
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
