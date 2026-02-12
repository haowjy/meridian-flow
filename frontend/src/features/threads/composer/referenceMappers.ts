import type { ReferenceElementData } from "./inlineElements";

export interface MentionReferenceResult {
  id: string;
  name: string;
  path: string;
  refType: string;
}

/**
 * Normalize mention search results into composer inline reference data.
 */
export function mentionResultToReferenceElementData(
  result: MentionReferenceResult,
): ReferenceElementData {
  return {
    type: "reference",
    documentId: result.id,
    refType: result.refType,
    displayName: result.name,
    documentPath: result.path,
  };
}
