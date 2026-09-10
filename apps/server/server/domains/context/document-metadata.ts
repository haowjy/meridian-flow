/** Canonical decoding of catalog-visible document metadata. */
export function documentAliases(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const aliases = (metadata as { aliases?: unknown }).aliases;
  if (!Array.isArray(aliases)) return [];
  return aliases.filter((alias): alias is string => typeof alias === "string");
}
