import { readStoredDocumentProperties, type StoredDocumentProperties } from "@meridian/contracts";
export function documentAliases(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const aliases = (metadata as { aliases?: unknown }).aliases;
  if (!Array.isArray(aliases)) return [];
  return aliases.filter((alias): alias is string => typeof alias === "string");
}

export interface CopiedFrom {
  uri: string;
  version: "draft" | "live";
  revision: string | null;
}

export interface DocumentCreationMetadata {
  copiedFrom?: CopiedFrom;
  properties?: StoredDocumentProperties;
  aliases?: string[];
}

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
