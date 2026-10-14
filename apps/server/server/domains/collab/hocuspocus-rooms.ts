/** Helpers for managing generated Hocuspocus rooms. */
import type { Hocuspocus } from "@hocuspocus/server";
import { branchRoomName, WS_CLOSE } from "@meridian/contracts/protocol";

export function closeBranchRooms(hocuspocus: Hocuspocus | null, branchId: string): void {
  if (!hocuspocus) return;
  const document = hocuspocus.documents.get(branchRoomName(branchId));
  if (!document) return;
  for (const connection of document.getConnections()) {
    connection.close(WS_CLOSE.BRANCH_CLOSED);
  }
  void hocuspocus.unloadDocument(document);
}
