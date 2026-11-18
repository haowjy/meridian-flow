/**
 * Frontier room labels (M1 decision 8): what a call's room copy was read from and a save
 * committed into. A Work draft is `draft:<workDraftId>`; a live document is
 * `live:<documentId>:<authorityGeneration>`, so a version restore starts a new room. Never a
 * thread peer, never a draft generation.
 */
export function draftRoom(workDraftId: string): string {
  return `draft:${workDraftId}`;
}

/**
 * What a purged draft's frontier rows are rewritten to: the model's observation stays, marked
 * superseded, with the cut itself dropped. A write that finds it as the model's latest view
 * knows the view was of a closed draft that can no longer be read.
 */
export function supersededRoom(documentId: string): string {
  return `superseded:${documentId}`;
}

export function liveRoom(documentId: string, generation: bigint): string {
  return `live:${documentId}:${generation}`;
}
