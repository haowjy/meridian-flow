export const COLLABORATION_CURSOR_COLORS = [
  "var(--color-collab-cursor-1)",
  "var(--color-collab-cursor-2)",
  "var(--color-collab-cursor-3)",
  "var(--color-collab-cursor-4)",
  "var(--color-collab-cursor-5)",
  "var(--color-collab-cursor-6)",
  "var(--color-collab-cursor-7)",
  "var(--color-collab-cursor-8)",
] as const;

export function resolveCollaborationColor(token: string): string {
  if (typeof document === "undefined") return token;
  const match = /^var\((--[^)]+)\)$/.exec(token);
  if (!match?.[1]) return token;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
  return resolved || token;
}
