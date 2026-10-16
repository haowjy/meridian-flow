/** Grammar-validated value used only in persisted and wire Work-slug fields. */

declare const workSlugBrand: unique symbol;

export type WorkSlug = string & { readonly [workSlugBrand]: "WorkSlug" };

/** A Work as the model sees it: `@[tea-notes]`, or `@/` for No Work. The one spelling of a Work reference. */
export function formatWorkRef(slug: string | null): string {
  return slug ? `@[${slug}]` : "@/";
}

/** Read a Work reference the model wrote: `@[arc]`, `[arc]`, `@arc` or `arc`. Null when no slug is left. */
export function parseWorkRef(raw: string): string | null {
  const trimmed = raw.trim().replace(/^@/, "");
  const inner = /^\[(.*)\]$/.exec(trimmed)?.[1] ?? trimmed;
  return inner.trim() || null;
}

/** Decode the ordinary Work-slug grammar. UUID-shaped values are valid slugs. */
export function decodeWorkSlug(value: unknown): WorkSlug | null {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value)
    ? (value as WorkSlug)
    : null;
}
