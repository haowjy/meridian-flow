/** Verbatim YAML properties stored beside document content. */
export type StoredDocumentProperties = { format: "yaml"; text: string };
export function readStoredDocumentProperties(metadata: unknown): StoredDocumentProperties | null {
  if (!metadata || typeof metadata !== "object" || !("properties" in metadata)) return null;
  const value = metadata.properties;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  return keys.length === 2 &&
    keys.includes("format") &&
    keys.includes("text") &&
    "format" in value &&
    value.format === "yaml" &&
    "text" in value &&
    typeof value.text === "string"
    ? (value as StoredDocumentProperties)
    : null;
}
