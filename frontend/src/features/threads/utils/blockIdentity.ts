import type { ToolBlockContent, TurnBlock } from '@/features/threads/types'
import { normalizeToolCallId } from '@/features/threads/utils/normalizeToolCallId'

function getToolUseId(block: TurnBlock): string | null {
  const raw = (block.content as ToolBlockContent | undefined)?.toolUseId
  return typeof raw === 'string' ? normalizeToolCallId(raw) : null
}

/**
 * Stable, view-level identity for a TurnBlock.
 *
 * Why this exists:
 * - During streaming we synthesize blocks locally.
 * - On TURN_COMPLETE we refresh blocks from the server (different `block.id`s).
 * - If React keys (or reconciliation) depend on `block.id`, blocks remount and UI state resets
 *   (e.g., <details> closes, tool collapsibles collapse, scroll jumps).
 */
export function getTurnBlockIdentity(block: TurnBlock): string {
  // Tool blocks: prefer tool_use_id which is stable across tool_use/tool_result pairing.
  if (block.blockType === 'tool_use' || block.blockType === 'tool_result') {
    const toolUseId = getToolUseId(block)
    if (toolUseId) return `tool:${toolUseId}:${block.blockType}`
  }

  // Default: sequence+type is stable within a turn.
  return `seq:${block.sequence}:${block.blockType}`
}

export function getTurnBlockReactKey(block: TurnBlock): string {
  return `turn:${block.turnId}:${getTurnBlockIdentity(block)}`
}

export function getToolInteractionReactKey(
  turnId: string,
  toolUse: TurnBlock | null,
  toolResult: TurnBlock | null
): string {
  const source = toolUse ?? toolResult
  if (!source) return `tool:${turnId}:unknown`

  const toolUseId = getToolUseId(source)
  if (toolUseId) return `tool:${turnId}:${toolUseId}`

  return `tool:${turnId}:seq:${source.sequence}`
}

