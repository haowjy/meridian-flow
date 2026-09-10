/** Identity projection for upload authorization and existing document consumers. */
import type { Filetype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, uploadIntakes } from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";

export interface UploadIdentity {
  intakeId: string | null;
  documentId: string;
  name: string;
  extension: string;
  fileType: Filetype;
  mimeType: string | null;
  sizeBytes: number | null;
  storageUrl: string | null;
  markdownProjection: string;
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
      .select({ document: documents, intake: uploadIntakes })
      .from(documents)
      .leftJoin(uploadIntakes, eq(documents.id, uploadIntakes.documentId))
      .where(
        and(
          inArray(documents.id, [...ids] as never[]),
          isNull(documents.deletedAt),
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
        markdownProjection: document.markdownProjection,
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
