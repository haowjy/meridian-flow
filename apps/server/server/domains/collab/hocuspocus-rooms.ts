/** Helpers for managing generated Hocuspocus rooms. */
import type { Document, Hocuspocus } from "@hocuspocus/server";
import { draftRoomName, parseYjsRoomName, WS_CLOSE } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";

/** After commit: close the draft's stable room, even if it is still loading. */
export function closeDraftRooms(hocuspocus: Hocuspocus | null, draftId: string): void {
  if (!hocuspocus) return;
  const name = draftRoomName(draftId);
  const document = hocuspocus.documents.get(name);
  if (document) closeRoom(hocuspocus, document);
  void hocuspocus.loadingDocuments.get(name)?.then(
    (loaded) => closeRoom(hocuspocus, loaded),
    () => {},
  );
}

/** Close a terminal draft room and unload it. Removal uses `4208` instead. */
export function closeRoom(
  hocuspocus: Hocuspocus,
  document: Document,
  close: { code: number; reason: string } = WS_CLOSE.DRAFT_CLOSED,
): void {
  if (hocuspocus.documents.get(document.name) !== document) return;
  for (const connection of document.getConnections()) {
    // Hocuspocus's protocol CLOSE loses the code (the provider reports 1000).
    connection.context.closeTransport?.(close);
    connection.close(close);
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

/**
 * After commit only: retire the whole removal batch, including rooms still loading. Draft rooms
 * close by exact draft id (a closed draft stays closed). A live room closes only if `stillRemoved`,
 * read once after every matching load settled, still holds its document's record: a Work Restore
 * that committed since makes that room's new connections valid. A failed read counts as still
 * removed: closing a restored room costs one reconnect (the client recovers a stale 4208), while
 * closing nothing would leave every room of the batch open. Outside database locks.
 */
export async function closeRemovedDocumentRooms(
  hocuspocus: Hocuspocus | null,
  documentIds: readonly string[],
  draftIds: readonly string[],
  stillRemoved: (documentIds: readonly DocumentId[]) => Promise<ReadonlyMap<DocumentId, unknown>>,
): Promise<void> {
  if (!hocuspocus) return;
  const live = new Set(documentIds);
  const drafts = new Set(draftIds);
  const names = new Set([...hocuspocus.documents.keys(), ...hocuspocus.loadingDocuments.keys()]);
  const matching = [...names].filter((name) => {
    const room = parseYjsRoomName(name);
    return live.has(name) || (room?.kind === "draft" && drafts.has(room.draftId));
  });
  await Promise.all(
    matching.map((name) => hocuspocus.loadingDocuments.get(name)?.catch(() => undefined)),
  );
  const liveNames = matching.filter((name) => live.has(name) && hocuspocus.documents.has(name));
  const standing: ReadonlyMap<DocumentId, unknown> = liveNames.length
    ? await stillRemoved(liveNames as DocumentId[]).catch(
        () => new Map(liveNames.map((name) => [name as DocumentId, null])),
      )
    : new Map();
  const closing = matching.flatMap((name) => {
    const document = hocuspocus.documents.get(name);
    if (!document || (live.has(name) && !standing.has(name as DocumentId))) return [];
    for (const connection of document.getConnections()) {
      // Hocuspocus's protocol CLOSE loses the code (the provider reports 1000).
      // Send the transport close first, as Work access revocation does.
      connection.context.closeTransport?.(WS_CLOSE.DOCUMENT_DELETED);
      connection.close(WS_CLOSE.DOCUMENT_DELETED);
    }
    return [document];
  });
  await Promise.all(closing.map((document) => hocuspocus.unloadDocument(document)));
}
