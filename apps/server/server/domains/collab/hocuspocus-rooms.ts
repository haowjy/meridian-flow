/** Helpers for managing generated Hocuspocus rooms. */
import type { Document, Hocuspocus } from "@hocuspocus/server";
import { parseYjsRoomName, WS_CLOSE } from "@meridian/contracts/protocol";

/** Closes the draft's rooms; with `olderThan`, only those of an earlier generation. */
export function closeDraftRooms(
  hocuspocus: Hocuspocus | null,
  draftId: string,
  olderThan?: number,
): void {
  if (!hocuspocus) return;
  for (const [roomName, document] of [...hocuspocus.documents.entries()]) {
    const room = parseYjsRoomName(roomName);
    if (room?.kind !== "draft" || room.draftId !== draftId) continue;
    if (olderThan !== undefined && room.generation >= olderThan) continue;
    closeRoom(hocuspocus, document);
  }
}

/** Closes one room on a generation its draft has left, and unloads it. */
export function closeRoom(hocuspocus: Hocuspocus, document: Document): void {
  if (hocuspocus.documents.get(document.name) !== document) return;
  for (const connection of document.getConnections()) {
    connection.close(WS_CLOSE.DRAFT_GENERATION_STALE);
  }
  void hocuspocus.unloadDocument(document);
}

/**
 * Resolves once Hocuspocus has registered `document` as its room: true, or false when its load
 * failed or another document holds the name. Called from a load hook, while the room is only
 * in `loadingDocuments`: Hocuspocus 4.3's `createDocument` attached the continuation that
 * registers it (`documents.set`) to the load promise before any hook ran, so this one, attached
 * later, runs after it.
 */
export function whenRoomRegistered(hocuspocus: Hocuspocus, document: Document): Promise<boolean> {
  const registered = () => hocuspocus.documents.get(document.name) === document;
  const loading = hocuspocus.loadingDocuments.get(document.name);
  if (!loading) return Promise.resolve(registered());
  return loading.then(registered, () => false);
}
