/** The row-to-file-entry mapping that project availability and recent documents answer with. */

import { hasDisplayableProperties } from "@meridian/contracts";
import {
  type CanonicalContextAuthority,
  type ContextUriScheme,
  canonicalContextUri,
} from "@meridian/contracts/context-uri";
import type { CatalogFileEntry, CatalogScope, Filetype } from "@meridian/contracts/protocol";
import { classifyFiletype } from "@meridian/contracts/protocol";
import { decodeWorkHandle, type ResolvedWorkAuthority } from "@meridian/contracts/works";
import { documentAliases } from "../document-metadata.js";

/** Bytes in object storage rather than a Yjs document: stored bytes, or a binary file type. */
export function isStorageBackedDocument(document: {
  fileType: string;
  storageUrl: string | null;
}): boolean {
  return document.storageUrl !== null || classifyFiletype(document.fileType).kind === "binary";
}

export type CatalogFileRow = {
  id: string;
  contextSourceId: string;
  folderId: string | null;
  /** The filename as the tree shows it, extension included. */
  name: string;
  extension: string;
  fileType: string;
  storageUrl: string | null;
  mimeType: string | null;
  metadata: unknown;
  rank: string | null;
  locationVersion?: bigint;
};

export function sourceAuthority(
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
  scope: CatalogScope;
  scheme: ContextUriScheme;
  workId: string | null;
  workHandle: string | null;
  parentPath: readonly string[];
  ownerThreadRef?: string | null;
  chatOwned?: boolean;
}): CatalogFileEntry {
  const { document, scope, scheme } = input;
  const filename = document.name;
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
              classification.kind === "binary" ? classification.fileType : ("binary" as const),
            mimeType: document.mimeType,
          };
  return {
    kind: "file",
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
      sourceAuthority(
        scheme,
        input.workId,
        input.workHandle,
        input.ownerThreadRef,
        input.chatOwned,
      ),
    ),
    extension: document.extension,
    ...persistedClassification,
    // No name is provisional: the list names every node when it is made.
    provisionalName: false,
    rank: document.rank,
  };
}
