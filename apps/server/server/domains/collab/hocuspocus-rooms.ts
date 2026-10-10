/** Helpers for managing generated Hocuspocus rooms. */
import type { Hocuspocus } from "@hocuspocus/server";
import { WS_CLOSE } from "@meridian/contracts/protocol";

export function closeBranchRooms(hocuspocus: Hocuspocus | null, branchId: string): void {
  if (!hocuspocus) return;
  const roomPrefix = `branch:${branchId}:gen:`;
  for (const roomName of [...hocuspocus.documents.keys()].filter((name) =>
    name.startsWith(roomPrefix),
  )) {
    const document = hocuspocus.documents.get(roomName);
    if (!document) continue;
    for (const connection of document.getConnections()) {
      connection.close(WS_CLOSE.BRANCH_GENERATION_STALE);
    }
    void hocuspocus.unloadDocument(document);
  }
}
