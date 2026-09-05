/** Shared Work naming and stable-handle rules used by both repository adapters. */
import { decodeWorkSlug, type WorkSlug } from "@meridian/contracts/works";
export const DEFAULT_WORK_NAME = "Untitled Work";

export function workSlugBase(name: string): WorkSlug {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "work";
  const decoded = decodeWorkSlug(slug);
  if (!decoded) throw new Error(`Generated invalid Work slug: ${slug}`);
  return decoded;
}

export function nextWorkSlug(name: string, existingSlugs: Iterable<string>): WorkSlug {
  const base = workSlugBase(name);
  const taken = new Set(existingSlugs);
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) {
      const decoded = decodeWorkSlug(candidate);
      if (!decoded) throw new Error(`Generated invalid Work slug: ${candidate}`);
      return decoded;
    }
  }
}
