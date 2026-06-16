/**
 * Agent mark initials — same visual family as AccountMenu avatars. Derives at
 * most two letters from a display name so agent chips stay consistent with
 * account chrome without importing user-specific name/email fields.
 */

/** Derive at most two-letter initials from an agent display name. */
export function initialsFromAgentName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "·";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0]?.[0];
    const b = parts[1]?.[0];
    if (a || b) return `${a ?? ""}${b ?? ""}`.toUpperCase();
  }
  const word = parts[0] ?? trimmed;
  if (word.length >= 2) return word.slice(0, 2).toUpperCase();
  return word[0]?.toUpperCase() ?? "·";
}
