/** Document ids to canonical URIs, answered by the one document-address owner (L32). */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { currentDocumentAddress, loadDocumentAddresses } from "./adapters/document-address.js";

/** Where a document lives now; null when it is deleted there or unspellable. */
export type DocumentUriResolver = (documentId: string) => Promise<string | null>;

/** The address a document last held, with whether it is deleted there; null when unspellable. */
export type DocumentLastAddress = (
  documentId: DocumentId,
) => Promise<{ uri: string; deleted: boolean } | null>;

export function createDocumentUriResolver(db: Database): DocumentUriResolver {
  return async (documentId) =>
    (await currentDocumentAddress(db, documentId as DocumentId))?.uri ?? null;
}

export function createDocumentLastAddress(db: Database): DocumentLastAddress {
  return async (documentId) => (await loadDocumentAddresses(db, { ids: [documentId] }))[0] ?? null;
}

/** Resolve a draft list through the shared address owner in one batch. */
export function createDocumentUrisResolver(db: Database) {
  return async (documentIds: readonly string[]): Promise<ReadonlyMap<string, string | null>> => {
    const addresses = await loadDocumentAddresses(db, { ids: documentIds });
    const result = new Map<string, string | null>(documentIds.map((id) => [id, null]));
    for (const address of addresses)
      if (!address.deleted) result.set(address.documentId, address.uri);
    return result;
  };
}
