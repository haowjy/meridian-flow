/** Document ids to canonical URIs, answered by the one document-address owner (L32). */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { branchTreeNodes } from "@meridian/database/schema";
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
  branchId?: DraftId,
) => Promise<{ uri: string; deleted: boolean } | null>;

export function createDocumentUriResolver(db: Database): DocumentUriResolver {
  return async (documentId) =>
    (await currentDocumentAddress(db, documentId as DocumentId))?.uri ?? null;
}

export function createDocumentLastAddress(db: Database): DocumentLastAddress {
  return async (documentId, branchId) => {
    const [live] = await loadDocumentAddresses(db, { ids: [documentId] });
    if (live) return live;
    // A caller that knows the Work's branch reads that one; otherwise any branch that placed it.
    const placedIn =
      branchId ??
      (
        await currentDrizzleDb(db)
          .select({ branchId: branchTreeNodes.branchId })
          .from(branchTreeNodes)
          .where(eq(branchTreeNodes.id, documentId))
          .orderBy(branchTreeNodes.branchId)
          .limit(1)
      )[0]?.branchId;
    if (!placedIn) return null;
    const view = { kind: "branch", branchId: placedIn } as const;
    return (await loadDocumentAddresses(db, { ids: [documentId] }, view))[0] ?? null;
  };
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
