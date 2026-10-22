/** Work addresses and item-level command feedback shared by review surfaces. */
export type DraftRef = { projectId: string; workId: string; documentId: string; itemKey: string };
export type ServerRefusal = {
  serverCode?: string;
  serverReason?: string;
};
export type BranchCommandFailure = {
  code: "apply-refused" | "discard-refused" | "discard-unknown" | "review-failed";
} & ServerRefusal;
