import type { DraftId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { draftTreeNodes } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../shared/drizzle-transaction.js";
import { currentDocumentAddress } from "./adapters/document-address.js";
import { loadDocumentAddresses } from "./tree/tree-addresses.js";

export type DocumentUriResolver = (documentId: string) => Promise<string | null>;

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

export function createDocumentUrisResolver(db: Database) {
  return async (documentIds: readonly string[]): Promise<ReadonlyMap<string, string | null>> => {
    const addresses = await loadDocumentAddresses(db, { ids: documentIds });
    const result = new Map<string, string | null>(documentIds.map((id) => [id, null]));
    for (const address of addresses)
      if (!address.deleted) result.set(address.documentId, address.uri);
    return result;
  };
}
