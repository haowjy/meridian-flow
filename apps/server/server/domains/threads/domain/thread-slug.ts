/** Stable thread-handle slugification and per-project collision suffixing. */
const MAX_SLUG_BASE_LENGTH = 80;

export function threadSlugBase(title: string | null | undefined): string | null {
  if (!title?.trim()) return null;
  const slug = title
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_BASE_LENGTH)
    .replace(/-+$/g, "");
  return slug || "thread";
}

export function uniqueThreadSlug(
  title: string | null | undefined,
  existingSlugs: Iterable<string>,
): string | null {
  const base = threadSlugBase(title);
  if (!base) return null;
  const existing = new Set(existingSlugs);
  if (!existing.has(base)) return base;

  let counter = 2;
  while (existing.has(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}
