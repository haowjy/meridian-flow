export function initialsFromName(
  first?: string | null,
  last?: string | null,
  email?: string | null,
) {
  const a = first?.trim()?.[0];
  const b = last?.trim()?.[0];
  if (a || b) return `${a ?? ""}${b ?? ""}`.toUpperCase();
  return email?.trim()?.[0]?.toUpperCase() ?? "?";
}
