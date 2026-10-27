/** Shared authoritative row-to-file mapping for catalog and project availability. */

import { type DocumentId, hasDisplayableProperties } from "@meridian/contracts";
import {
  type CanonicalContextAuthority,
  type ContextUriScheme,
  canonicalContextUri,
} from "@meridian/contracts/context-uri";
import type { CatalogFileEntry, CatalogScope, Filetype } from "@meridian/contracts/protocol";
import { classifyFiletype } from "@meridian/contracts/protocol";
import { decodeWorkHandle, type ResolvedWorkAuthority } from "@meridian/contracts/works";
import { documentAliases } from "../document-metadata.js";

/** The stored file types whose bytes live in object storage (one definition, SQL included). */
export const BINARY_FILE_TYPES: ReadonlySet<string> = new Set(["docx", "image", "pdf", "binary"]);

/** Bytes in object storage rather than a Yjs document. */
export function isStorageBackedDocument(document: {
  fileType: string;
  storageUrl: string | null;
}): boolean {
  return document.storageUrl !== null || BINARY_FILE_TYPES.has(document.fileType);
}

export type CatalogFileRow = {
  id: string;
  contextSourceId: string;
  folderId: string | null;
  name: string;
  extension: string;
  fileType: string;
  storageUrl: string | null;
  mimeType: string | null;
  metadata: unknown;
  provisionalName: boolean;
  rank: string | null;
  locationVersion?: bigint;
  /** Ids a device's create forwarded into this document (a join). */
  joinedFrom?: readonly string[];
};

export function catalogSourceAuthority(
  scheme: ContextUriScheme,
  workId: string | null,
  workHandle: string | null,
  /** The ref of the thread that owns a lineage Scratch or chat uploads source. */
  ownerThreadRef?: string | null,
  /** A chat-owned source: its address is the chat's, or bare until the chat row exists. */
  chatOwned = false,
): CanonicalContextAuthority {
  if (scheme !== "scratch" && scheme !== "uploads") return { kind: "contextual" };
  if (chatOwned)
    return ownerThreadRef ? { kind: "chat", chatRef: ownerThreadRef } : { kind: "contextual" };
  if (scheme === "scratch" && ownerThreadRef)
    return { kind: "lineage", rootThreadRef: ownerThreadRef };
  if (!workId) throw new Error("Work-scoped catalog row is missing Work id");
  if (workHandle === null) return { workId, workHandle: null } as ResolvedWorkAuthority;
  const decoded = decodeWorkHandle(workHandle);
  if (!decoded) throw new Error("Persisted Work authority is inconsistent");
  return { workId, workHandle: decoded } as ResolvedWorkAuthority;
}

export function mapAuthoritativeFile(input: {
  document: CatalogFileRow;
  observationVersion: string;
  scope: CatalogScope;
  scheme: ContextUriScheme;
  workId: string | null;
  workHandle: string | null;
  parentPath: readonly string[];
  ownerThreadRef?: string | null;
  chatOwned?: boolean;
  /** A chat upload's intake facts; absent for every other file. */
  upload?: { attachedAt: Date; consumed: boolean; intakeId: string; locationRevision: string };
}): CatalogFileEntry {
  const { document, scope, scheme } = input;
  const filename = document.extension ? `${document.name}.${document.extension}` : document.name;
  const path = [...input.parentPath, filename];
  const classification = classifyFiletype(document.fileType);
  const storageBacked = isStorageBackedDocument(document);
  const persistedClassification =
    !storageBacked && classification.kind === "tracked"
      ? {
          editable: true as const,
          filetype: document.fileType as Filetype,
          schemaType: classification.schemaType,
        }
      : classification.kind === "custom"
        ? {
            editable: false as const,
            disposition: "custom" as const,
            fileType: classification.fileType,
            mimeType: document.mimeType,
            filetype: document.fileType as Filetype,
          }
        : {
            editable: false as const,
            disposition: "binary" as const,
            fileType:
              document.fileType === "docx" ||
              document.fileType === "image" ||
              document.fileType === "pdf" ||
              document.fileType === "binary"
                ? document.fileType
                : classification.kind === "binary"
                  ? classification.fileType
                  : ("binary" as const),
            mimeType: document.mimeType,
          };
  return {
    kind: "file",
    observationVersion: input.observationVersion,
    ...(document.locationVersion !== undefined
      ? { locationVersion: document.locationVersion.toString() }
      : {}),
    entryId: document.id,
    scope,
    sourceId: document.contextSourceId,
    parentId: document.folderId ?? document.contextSourceId,
    name: filename,
    aliases: documentAliases(document.metadata),
    hasProperties: hasDisplayableProperties(document.metadata),
    path,
    uri: canonicalContextUri(
      scheme,
      path.join("/"),
      catalogSourceAuthority(
        scheme,
        input.workId,
        input.workHandle,
        input.ownerThreadRef,
        input.chatOwned,
      ),
    ),
    ...persistedClassification,
    provisionalName: document.provisionalName,
    rank: document.rank,
    ...(input.upload
      ? {
          upload: {
            attachedAt: input.upload.attachedAt.toISOString(),
            used: input.upload.consumed,
            intakeId: input.upload.intakeId,
            locationRevision: input.upload.locationRevision,
          },
        }
      : {}),
    ...(document.joinedFrom?.length ? { joinedFrom: document.joinedFrom as DocumentId[] } : {}),
  };
}
