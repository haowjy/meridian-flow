/**
 * The frontier room label: what a call's room copy was read from and a save committed into.
 * `live:<documentId>`.
 */
export function liveRoom(documentId: string): string {
  return `live:${documentId}`;
}
