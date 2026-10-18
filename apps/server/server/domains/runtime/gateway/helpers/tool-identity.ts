/** Provider tool identities must be present; preserve their opaque bytes once validated. */
export function isNonBlankToolIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
