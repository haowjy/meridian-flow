/** Canonical decoding of catalog-visible document metadata. */
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
}
