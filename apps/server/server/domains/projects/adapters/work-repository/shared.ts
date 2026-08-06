/** Shared Work naming and stable-handle rules used by both repository adapters. */
export const DEFAULT_WORK_NAME = "Untitled Work";

export function workSlugBase(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "work"
  );
}

export function nextWorkSlug(name: string, existingSlugs: Iterable<string>): string {
  const base = workSlugBase(name);
  const taken = new Set(existingSlugs);
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
