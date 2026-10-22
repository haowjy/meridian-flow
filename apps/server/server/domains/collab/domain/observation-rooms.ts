/**
 * Frontier room labels (M1 decision 8): what a call's room copy was read from and a save
 * committed into. A Work draft is `draft:<workDraftId>`; a live document is
 * `live:<documentId>:<authorityGeneration>`, so a version restore starts a new room. Never a
 * thread peer, never a draft generation.
 */
export function draftRoom(workDraftId: string): string {
  return `draft:${workDraftId}`;
}

export function liveRoom(documentId: string, generation: bigint): string {
  return `live:${documentId}:${generation}`;
}
