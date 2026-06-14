// @ts-nocheck
/**
 * Shared project-repository helpers: the default title constant and slug
 * derivation used by both the drizzle and in-memory adapters so naming behavior
 * stays identical across them.
 */
export const DEFAULT_PROJECT_TITLE = "Untitled Project";

/** Slugify a title into a URL-safe base slug, falling back to `project`. */
function slugifyTitle(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "project";
}

/**
 * Derive a per-owner-unique slug. The slug is internal (not surfaced on the
 * Project contract), so a short id suffix guarantees uniqueness without a
 * collision-retry loop.
 */
export function deriveSlug(title: string, id: string): string {
  return `${slugifyTitle(title)}-${id.slice(0, 8)}`;
}
