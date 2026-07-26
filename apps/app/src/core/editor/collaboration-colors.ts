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
  return resolveCollaborationColor(
    COLLABORATION_CURSOR_COLORS[hash % COLLABORATION_CURSOR_COLORS.length],
  );
}

/** Resolve a theme token before it crosses the awareness JSON boundary. */
export function resolveCollaborationColor(token: string): string {
  if (typeof document === "undefined") return token;
  const match = /^var\((--[^)]+)\)$/.exec(token);
  if (!match?.[1]) return token;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
  if (!resolved) return token;
  return sixDigitHex(resolved) ?? resolved;
}

/** y-prosemirror accepts only legacy six-digit RGB, while the palette uses OKLCH. */
function sixDigitHex(color: string): string | null {
  if (/^#[\da-f]{6}$/i.test(color)) return color;

  if (/^rgba?\(/i.test(color)) {
    const channels = color
      .match(/\d+(?:\.\d+)?/g)
      ?.slice(0, 3)
      .map(Number);
    if (channels?.length === 3) return hexFromChannels(channels);
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    return alpha === 0 ? null : hexFromChannels([red, green, blue]);
  } catch {
    return null;
  }
}

function hexFromChannels(channels: number[]): string {
  return `#${channels
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
