import type { NoticeSurface } from "./draft-notices";
/** Work addresses and item-level command feedback shared by review surfaces. */
export type DraftRef = {
  projectId: string;
  ownerKey: string;
  documentId: string;
  itemKey: string;
  /** The surface that sent the command: a closed-Work bounce shows there only. */
  surface?: NoticeSurface["kind"];
};
export type ServerRefusal = {
  serverCode?: string;
  serverReason?: string;
};
export type BranchCommandFailure = {
  code:
    | "apply-refused"
    | "unapply-refused"
    | "discard-refused"
    | "discard-unknown"
    | "review-failed";
} & ServerRefusal;
