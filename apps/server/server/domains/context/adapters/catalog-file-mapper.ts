/** Shared authoritative row-to-file mapping for catalog and project availability. */
import {
  type CanonicalContextAuthority,
  type ContextUriScheme,
  canonicalContextUri,
} from "@meridian/contracts/context-uri";
import type { CatalogFileEntry, CatalogScope, Filetype } from "@meridian/contracts/protocol";
import { classifyFiletype } from "@meridian/contracts/protocol";
import { decodeWorkSlug, type ResolvedWorkAuthority } from "@meridian/contracts/works";
import { documentAliases } from "../document-metadata.js";

const BINARY_FILE_TYPES = new Set(["docx", "image", "pdf", "binary"]);

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
};

export function catalogSourceAuthority(
  scheme: ContextUriScheme,
  workId: string | null,
  workSlug: string | null,
): CanonicalContextAuthority {
  if (scheme !== "scratch" && scheme !== "uploads") return { kind: "contextual" };
  if (!workSlug) return { kind: "none" };
  const decoded = decodeWorkSlug(workSlug);
  if (!decoded || !workId) throw new Error("Persisted Work authority is inconsistent");
  return { kind: "work", workId, workSlug: decoded } as ResolvedWorkAuthority;
}

export function mapAuthoritativeFile(input: {
  document: CatalogFileRow;
  scope: CatalogScope;
  scheme: ContextUriScheme;
  workId: string | null;
  workSlug: string | null;
  parentPath: readonly string[];
}): CatalogFileEntry {
  const { document, scope, scheme } = input;
  const filename = document.extension ? `${document.name}.${document.extension}` : document.name;
  const path = [...input.parentPath, filename];
  const classification = classifyFiletype(document.fileType);
  const storageBacked = document.storageUrl !== null || BINARY_FILE_TYPES.has(document.fileType);
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
    entryId: document.id,
    scope,
    sourceId: document.contextSourceId,
    parentId: document.folderId ?? document.contextSourceId,
    name: filename,
    aliases: documentAliases(document.metadata as never),
    path,
    uri: canonicalContextUri(
      scheme,
      path.join("/"),
      catalogSourceAuthority(scheme, input.workId, input.workSlug),
    ),
    ...persistedClassification,
    provisionalName: document.provisionalName,
  };
}
