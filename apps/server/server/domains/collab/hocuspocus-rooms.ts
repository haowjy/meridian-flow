/** Helpers for managing generated Hocuspocus rooms. */
import type { Hocuspocus } from "@hocuspocus/server";
import { parseYjsRoomName, WS_CLOSE } from "@meridian/contracts/protocol";

/** Closes the branch's rooms; with `olderThan`, only those of an earlier generation. */
export function closeBranchRooms(
  hocuspocus: Hocuspocus | null,
  branchId: string,
  olderThan?: number,
): void {
  if (!hocuspocus) return;
  for (const [roomName, document] of [...hocuspocus.documents.entries()]) {
    const room = parseYjsRoomName(roomName);
    if (room?.kind !== "branch" || room.branchId !== branchId) continue;
    if (olderThan !== undefined && room.generation >= olderThan) continue;
    for (const connection of document.getConnections()) {
      connection.close(WS_CLOSE.BRANCH_GENERATION_STALE);
    }
    void hocuspocus.unloadDocument(document);
  }
}
