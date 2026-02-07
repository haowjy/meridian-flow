import type {
  Turn,
  TurnBlock,
  ContentBlock,
  DocumentReference,
} from "@/features/threads/types";
import type { ReferenceElementData } from "@/features/threads/composer";
import { useTreeStore } from "@/core/stores/useTreeStore";

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
  return extractTextFromBlocks(turn.blocks);
}

/**
 * Extracts plain text from an array of blocks.
 *
 * @param blocks - Array of turn blocks
 * @returns Plain text content, or empty string if no text blocks
 */
export function extractTextFromBlocks(blocks: TurnBlock[]): string {
  return blocks
    .filter((b) => b.blockType === "text")
    .map((b) => b.textContent ?? "")
    .join("\n\n");
}

/**
 * Extracts reference blocks from a turn and converts to ReferenceElementData[]
 * for pre-populating the composer with existing references when editing a turn.
 *
 * Uses useTreeStore.getState() to resolve display names from document IDs.
 */
export function extractReferenceData(turn: Turn): ReferenceElementData[] {
  return turn.blocks
    .filter((b) => b.blockType === "reference" && b.content?.refId)
    .map((b) => {
      const refId = b.content!.refId as string;
      const refType = (b.content!.refType as string) ?? "document";
      const state = useTreeStore.getState();

      if (refType === "folder") {
        const folder = state.folders.find((f) => f.id === refId);
        return {
          type: "reference" as const,
          documentId: refId,
          refType,
          displayName: folder?.name ?? "Unknown folder",
          documentPath: undefined,
        };
      }

      const doc = state.documents.find((d) => d.id === refId);
      return {
        type: "reference" as const,
        documentId: refId,
        refType,
        displayName: doc?.name ?? "Unknown document",
        documentPath: doc?.path,
      };
    });
}

// =============================================================================
// ContentBlock utilities
// =============================================================================

/** Concatenate text blocks into a single string (for interjections, regeneration). */
export function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Extract DocumentReference[] from ContentBlock[] (for legacy API paths). */
export function blocksToReferences(
  blocks: ContentBlock[],
): DocumentReference[] {
  return blocks
    .filter(
      (b): b is ContentBlock & { type: "reference" } => b.type === "reference",
    )
    .map((b) => ({ documentId: b.documentId, refType: b.refType }));
}

/**
 * Reconstruct ContentBlock[] from a Turn's TurnBlock[] (sorted by sequence).
 * Resolves display names from useTreeStore for reference blocks.
 */
export function turnToContentBlocks(turn: Turn): ContentBlock[] {
  const sorted = [...turn.blocks].sort((a, b) => a.sequence - b.sequence);
  const blocks: ContentBlock[] = [];

  for (const tb of sorted) {
    if (tb.blockType === "text") {
      blocks.push({ type: "text", text: tb.textContent ?? "" });
    } else if (tb.blockType === "reference" && tb.content?.refId) {
      const refId = tb.content.refId as string;
      const refType = (tb.content.refType as string) ?? "document";
      const state = useTreeStore.getState();

      if (refType === "folder") {
        const folder = state.folders.find((f) => f.id === refId);
        blocks.push({
          type: "reference",
          documentId: refId,
          refType,
          displayName: folder?.name ?? "Unknown folder",
          documentPath: undefined,
        });
      } else {
        const doc = state.documents.find((d) => d.id === refId);
        blocks.push({
          type: "reference",
          documentId: refId,
          refType,
          displayName: doc?.name ?? "Unknown document",
          documentPath: doc?.path,
        });
      }
    }
    // Skip other block types (thinking, tool_use, etc.) — not user content
  }

  return blocks;
}
