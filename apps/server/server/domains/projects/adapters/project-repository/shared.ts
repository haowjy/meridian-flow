/** Project-owned readable handle allocation shared by persistence adapters. */
const MAX_SLUG_BASE_LENGTH = 80;

export const DEFAULT_PROJECT_TITLE = "Untitled Project";

export function nextProjectSlug(title: string, existingSlugs: Iterable<string>): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/\p{Mark}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SLUG_BASE_LENGTH)
      .replace(/-+$/g, "") || "project";
  const taken = new Set(existingSlugs);
  if (!taken.has(base)) return base;
  // With N reserved values, one of the first N + 1 candidates is free.
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
