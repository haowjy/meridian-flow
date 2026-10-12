/** Lossless stored document frontmatter (verbatim YAML) shared by import and export. */
export type StoredDocumentProperties = { format: "yaml"; text: string };

export function readStoredDocumentProperties(metadata: unknown): StoredDocumentProperties | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).properties;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const properties = value as Record<string, unknown>;
  return Reflect.ownKeys(properties).length === 2 &&
    Object.hasOwn(properties, "format") &&
    Object.hasOwn(properties, "text") &&
    properties.format === "yaml" &&
    typeof properties.text === "string"
    ? (value as StoredDocumentProperties)
    : null;
}
