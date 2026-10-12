/** Verbatim YAML properties stored beside document content. */
export type StoredDocumentProperties = { format: "yaml"; text: string };
export function readStoredDocumentProperties(metadata: unknown): StoredDocumentProperties | null {
  if (!metadata || typeof metadata !== "object" || !("properties" in metadata)) return null;
  const value = metadata.properties;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 2 &&
    "format" in value &&
    value.format === "yaml" &&
    "text" in value &&
    typeof value.text === "string"
    ? { format: "yaml", text: value.text }
    : null;
}
