/** Canonical decoding of catalog-visible document metadata. */
import { readStoredDocumentProperties, type StoredDocumentProperties } from "@meridian/contracts";
export function documentAliases(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const aliases = (metadata as { aliases?: unknown }).aliases;
  if (!Array.isArray(aliases)) return [];
  return aliases.filter((alias): alias is string => typeof alias === "string");
}

/**
 * Where a copied document came from (D24): the source's URI, the version the
 * copy read and that version's revision. It is `documents.metadata.copiedFrom`.
 */
export interface CopiedFrom {
  uri: string;
  version: "draft" | "live";
  revision: string | null;
}

/** Metadata a document is created with. */
export interface DocumentCreationMetadata {
  copiedFrom?: CopiedFrom;
  properties?: StoredDocumentProperties;
  aliases?: string[];
}

/** What a copy inherits from its source: imported properties and aliases, when it has them. */
export function documentMetadataFacts(metadata: unknown): {
  properties?: StoredDocumentProperties;
  aliases?: string[];
} {
  const properties = readStoredDocumentProperties(metadata);
  const aliases = documentAliases(metadata);
  return {
    ...(properties ? { properties } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}
