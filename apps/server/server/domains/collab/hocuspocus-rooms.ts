/** Helpers for managing generated Hocuspocus rooms. */
import type { Hocuspocus } from "@hocuspocus/server";
import { WS_CLOSE } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";

/**
 * After commit only: close the removed documents' rooms, including rooms still loading. A room
 * closes only if `stillRemoved`, read once after every matching load settled, still holds its
 * document's record: a Work Restore that committed since makes that room's new connections valid. A failed read counts as still
 * removed: closing a restored room costs one reconnect (the client recovers a stale 4208), while
 * closing nothing would leave every room of the batch open. Outside database locks.
 */
export async function closeRemovedDocumentRooms(
  hocuspocus: Hocuspocus | null,
  documentIds: readonly string[],
  stillRemoved: (documentIds: readonly DocumentId[]) => Promise<ReadonlyMap<DocumentId, unknown>>,
): Promise<void> {
  if (!hocuspocus) return;
  const live = new Set(documentIds);
  const names = new Set([...hocuspocus.documents.keys(), ...hocuspocus.loadingDocuments.keys()]);
  const matching = [...names].filter((name) => live.has(name));
  await Promise.all(
    matching.map((name) => hocuspocus.loadingDocuments.get(name)?.catch(() => undefined)),
  );
  const liveNames = matching.filter((name) => hocuspocus.documents.has(name));
  const standing: ReadonlyMap<DocumentId, unknown> = liveNames.length
    ? await stillRemoved(liveNames as DocumentId[]).catch(
        () => new Map(liveNames.map((name) => [name as DocumentId, null])),
      )
    : new Map();
  const closing = matching.flatMap((name) => {
    const document = hocuspocus.documents.get(name);
    if (!document || !standing.has(name as DocumentId)) return [];
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
