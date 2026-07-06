/** Helpers for managing generated Hocuspocus rooms. */
import type { Hocuspocus } from "@hocuspocus/server";

export function closeBranchRooms(hocuspocus: Hocuspocus | null, branchId: string): void {
  if (!hocuspocus) return;
  const roomPrefix = `branch:${branchId}:gen:`;
  for (const roomName of [...hocuspocus.documents.keys()].filter((name) =>
    name.startsWith(roomPrefix),
  )) {
    hocuspocus.closeConnections(roomName);
    const document = hocuspocus.documents.get(roomName);
    if (document) void hocuspocus.unloadDocument(document);
  }
}
