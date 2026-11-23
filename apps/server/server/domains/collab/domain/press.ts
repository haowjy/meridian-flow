/**
 * A press's cut as the route decoded it: per list, the list's id and the version vector
 * the review list read. A scope left out is the server's own cut.
 */
export type TreeCut = {
  project?: { list: string; vector: Uint8Array };
  account?: { list: string; vector: Uint8Array };
};
