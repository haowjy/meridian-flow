/** Document ids to canonical URIs, answered by the one document-address owner (L32). */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { draftTreeNodes } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../shared/drizzle-transaction.js";
import { currentDocumentAddress } from "./adapters/document-address.js";
import { loadDocumentAddresses } from "./tree/tree-addresses.js";

/** Where a document lives now; null when it is deleted there or unspellable. */
export type DocumentUriResolver = (documentId: string) => Promise<string | null>;

/**
 * The address a document last held, with whether it is deleted there; null when unspellable. A
 * document that never reached live is named where a Work's draft tree placed it.
 */
export type DocumentLastAddress = (
  documentId: DocumentId,
  draftId?: DraftId,
) => Promise<{ uri: string; deleted: boolean } | null>;

export function createDocumentUriResolver(db: Database): DocumentUriResolver {
  return async (documentId) =>
    (await currentDocumentAddress(db, documentId as DocumentId))?.uri ?? null;
}

export function createDocumentLastAddress(db: Database): DocumentLastAddress {
  return async (documentId, draftId) => {
    const [live] = await loadDocumentAddresses(db, { ids: [documentId] });
    if (live) return live;
    // A caller that knows the Work's draft reads that one; otherwise any draft that placed it.
    const placedIn =
      draftId ??
      (
        await currentDrizzleDb(db)
          .select({ draftId: draftTreeNodes.draftId })
          .from(draftTreeNodes)
          .where(eq(draftTreeNodes.id, documentId))
          .orderBy(draftTreeNodes.draftId)
          .limit(1)
      )[0]?.draftId;
    if (!placedIn) return null;
    const view = { kind: "draft", draftId: placedIn } as const;
    return (await loadDocumentAddresses(db, { ids: [documentId] }, view))[0] ?? null;
  };
}
