/** Identity projection for upload authorization and existing document consumers. */
import type { Filetype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { uploadIntakes } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { LIVE_TREE, visibleDocumentFields, visibleDocuments } from "../tree/tree-view.js";

export interface UploadIdentity {
  intakeId: string | null;
  documentId: string;
  name: string;
  extension: string;
  fileType: Filetype;
  mimeType: string | null;
  sizeBytes: number | null;
  storageUrl: string | null;
  updatedAt: string;
  uri: string;
  locationRevision: string;
}

export interface UploadIdentityPort {
  lookupUpload(documentId: string): Promise<UploadIdentity | null>;
  lookupDocument(documentId: string): Promise<UploadIdentity | null>;
  lookupDocuments(documentIds: readonly string[]): Promise<UploadIdentity[]>;
}

export function createDrizzleUploadIdentityPort(db: Database): UploadIdentityPort {
  const query = async (ids: readonly string[], uploadsOnly: boolean) => {
    if (ids.length === 0) return [];
    const rows = await db
      .select({ document: visibleDocumentFields(liveDocuments), intake: uploadIntakes })
      .from(liveDocuments)
      .leftJoin(uploadIntakes, eq(liveDocuments.id, uploadIntakes.documentId))
      .where(
        and(
          inArray(liveDocuments.id, [...ids] as never[]),
          uploadsOnly ? eq(uploadIntakes.state, "finalized") : undefined,
        ),
      );
    return rows.map(
      ({ document, intake }): UploadIdentity => ({
        intakeId: intake?.intakeId ?? null,
        documentId: document.id,
        name: document.name,
        extension: document.extension,
        fileType: document.fileType as Filetype,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        storageUrl: document.storageUrl,
        updatedAt: document.updatedAt.toISOString(),
        uri: intake?.canonicalUri ?? "",
        locationRevision: intake?.locationRevision ?? "",
      }),
    );
  };
  return {
    async lookupUpload(documentId) {
      return (await query([documentId], true))[0] ?? null;
    },
    async lookupDocument(documentId) {
      return (await query([documentId], false))[0] ?? null;
    },
    lookupDocuments: (documentIds) => query(documentIds, false),
  };
}

const liveDocuments = visibleDocuments(LIVE_TREE);
