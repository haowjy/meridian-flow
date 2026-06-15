/**
 * Pure utility for parsing image block content from domain block payloads.
 *
 * Extracted to a separate module so it can be tested in a node environment
 * without pulling in React or browser-only UI imports.
 *
 * `ImageBlock.tsx` re-exports `parseImageBlockContent` from here;
 * chat `block-kind.ts` imports from `@/rich-content/ImageBlock`.
 */

export type ImageBlockContent = {
  url: string;
  alt?: string;
  caption?: string;
};

/**
 * Coerce a `Block.content` payload into an `ImageBlockContent`.
 *
 * The image content travels inside a `tool_result` block (the orchestrator
 * always boxes tool output that way) so we read it out of `content.output`
 * when present, falling back to the top-level shape for direct callers.
 *
 * Returns `null` when the value doesn't look like an image payload — callers
 * use that signal to skip image rendering.
 */
export function parseImageBlockContent(raw: unknown): ImageBlockContent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const nested =
    "output" in obj && obj.output && typeof obj.output === "object"
      ? (obj.output as Record<string, unknown>)
      : obj;
  const url = nested.url;
  if (typeof url !== "string" || url.length === 0) return null;
  const alt = typeof nested.alt === "string" ? nested.alt : undefined;
  const caption = typeof nested.caption === "string" ? nested.caption : undefined;
  return { url, alt, caption };
}
