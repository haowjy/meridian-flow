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
 * Returns `null` when the value doesn't look like an image payload — callers
 * use that signal to skip image rendering.
 */
export function parseImageBlockContent(raw: unknown): ImageBlockContent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const url = obj.url;
  if (typeof url !== "string" || url.length === 0) return null;
  const alt = typeof obj.alt === "string" ? obj.alt : undefined;
  const caption = typeof obj.caption === "string" ? obj.caption : undefined;
  return { url, alt, caption };
}
