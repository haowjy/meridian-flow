/** Work addresses and item-level command feedback shared by review surfaces. */
export type DraftRef = { projectId: string; ownerKey: string; documentId: string; itemKey: string };
export type ServerRefusal = {
  serverCode?: string;
  serverReason?: string;
};
export type CommandRefusal = {
  code:
    | "apply-refused"
    | "unapply-refused"
    | "discard-refused"
    | "discard-unknown"
    | "review-failed";
} & ServerRefusal;
export type BranchCommandFailure =
  | CommandRefusal
  /** Ctrl+Z dropped a Discard whose text was edited since: `leftOut` of its changes stay discarded. */
  | { code: "undo-left-out"; leftOut: number };
