/** Shared token-valued palette for live cursors and settled peer marks. */
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

/** Stable identity hash shared by cursor-like marks and their popovers. */
export function collaborationColorFor(identity: string): string {
  let hash = 0;
  for (const character of identity) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return COLLABORATION_CURSOR_COLORS[hash % COLLABORATION_CURSOR_COLORS.length];
}
