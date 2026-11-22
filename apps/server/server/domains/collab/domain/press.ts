/** What a press's route hands the command: its tree cut, and its answer when the server is behind. */

/**
 * A press's cut as the route decoded it: per list, the list's id and the version vector
 * the review list read. A scope left out is the server's own cut.
 */
export type TreeCut = {
  project?: { list: string; vector: Uint8Array };
  account?: { list: string; vector: Uint8Array };
};

/**
 * The press's cut is ahead of what the server holds (a tab's unacknowledged typing, or tree
 * records not synced yet): a 503, nothing stored, and the client resends the same command.
 */
export class PressUnsynced extends Error {}
