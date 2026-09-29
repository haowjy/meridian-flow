/** Grammar-validated value used only in persisted and wire Work-slug fields. */

declare const workSlugBrand: unique symbol;

export type WorkSlug = string & { readonly [workSlugBrand]: "WorkSlug" };

/** Decode the ordinary Work-slug grammar. Reserved values still decode; they are only never generated. */
export function decodeWorkSlug(value: unknown): WorkSlug | null {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value)
    ? (value as WorkSlug)
    : null;
}

const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Browser Work routes spend `/works/new` and `/works/<uuid>` on creation, so generated slugs avoid them. */
export function isReservedWorkSlug(slug: string): boolean {
  return slug.toLowerCase() === "new" || UUID_SHAPED.test(slug);
}
