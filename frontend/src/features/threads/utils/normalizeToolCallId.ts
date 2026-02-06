/**
 * Normalizes toolCallId/tool_use_id values for correlation.
 *
 * Providers sometimes include leading/trailing whitespace in tool call IDs.
 * We treat these IDs as opaque identifiers, but trim to avoid subtle pairing
 * bugs across streaming state, persisted blocks, and render grouping.
 */
export function normalizeToolCallId(id: string): string {
  return id.trim();
}
