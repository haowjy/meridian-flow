/**
 * The frontier room label: what a call's room copy was read from and a save committed into.
 * `live:<documentId>:<authorityGeneration>`.
 */
export function liveRoom(documentId: string, generation: bigint): string {
  return `live:${documentId}:${generation}`;
}
