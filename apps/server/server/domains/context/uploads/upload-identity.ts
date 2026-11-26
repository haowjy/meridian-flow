import { canonicalContextUri } from "@meridian/contracts/context-uri";
import type { Filetype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { threads, uploadIntakes } from "@meridian/database/schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
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
  hasPreview: boolean;
  updatedAt: string;
  uri: string;
  ownerChatId: string | null;
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
      .select({
        document: visibleDocumentFields(liveDocuments),
        intake: uploadIntakes,
        chatRef: threads.ref,
      })
      .from(liveDocuments)
      .leftJoin(uploadIntakes, eq(liveDocuments.id, uploadIntakes.documentId))
      .leftJoin(threads, eq(threads.id, uploadIntakes.ownerThreadId))
      .where(
        and(
          inArray(liveDocuments.id, [...ids] as never[]),
          uploadsOnly
            ? and(eq(uploadIntakes.state, "finalized"), isNotNull(uploadIntakes.ownerThreadId))
            : undefined,
        ),
      );
    return rows.map(
      ({ document, intake, chatRef }): UploadIdentity => ({
        intakeId: intake?.intakeId ?? null,
        documentId: document.id,
        name: document.name,
        extension: document.extension,
        fileType: document.fileType as Filetype,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        storageUrl: document.storageUrl,
        hasPreview: document.hasPreview,
        updatedAt: document.updatedAt.toISOString(),
        uri: intake?.finalPath
          ? canonicalContextUri(
              "uploads",
              intake.finalPath,
              chatRef ? { kind: "chat", chatRef } : { kind: "contextual" },
            )
          : "",
        ownerChatId: intake?.ownerThreadId ?? null,
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
