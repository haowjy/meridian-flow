/**
 * Avatar-initials derivation for the account chrome (AccountMenu). Single
 * source so the fallback chain — name initials → email initial → "·"
 * placeholder — can't drift between surfaces.
 */

/**
 * Derive at most two-letter initials from a user's name,
 * falling back to the first character of their email, then "·".
 */
export function initialsFromName(
  first?: string | null,
  last?: string | null,
  email?: string | null,
) {
  const a = first?.trim()?.[0];
  const b = last?.trim()?.[0];
  if (a || b) return `${a ?? ""}${b ?? ""}`.toUpperCase();
  return email?.trim()?.[0]?.toUpperCase() ?? "·";
}
