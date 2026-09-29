/** Grammar-validated value used only in persisted and wire Work-slug fields. */

declare const workSlugBrand: unique symbol;

export type WorkSlug = string & { readonly [workSlugBrand]: "WorkSlug" };

/** Decode the ordinary Work-slug grammar. UUID-shaped values are valid slugs. */
export function decodeWorkSlug(value: unknown): WorkSlug | null {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value)
    ? (value as WorkSlug)
    : null;
}
