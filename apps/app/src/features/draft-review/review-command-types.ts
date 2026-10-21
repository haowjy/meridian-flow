/** Work addresses and item-level command feedback shared by review surfaces. */
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
export type DraftRef = { projectId: string; workId: string; documentId: string; itemKey: string };
export type ServerRefusal = {
  serverCode?: string;
  serverReason?: string;
  removal?: DocumentRemovalRecord;
};
export type BranchCommandFailure = { code: string } & ServerRefusal;
