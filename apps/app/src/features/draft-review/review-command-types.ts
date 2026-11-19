/** Work addresses and item-level command feedback shared by review surfaces. */
export type DraftRef = { projectId: string; ownerKey: string; documentId: string; itemKey: string };
export type ServerRefusal = {
  serverCode?: string;
};
export type BranchCommandFailure = {
  code: "apply-refused" | "discard-refused";
} & ServerRefusal;
