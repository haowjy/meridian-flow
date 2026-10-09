/**
 * Where an editor keeps its link runtime: the surface store and the
 * resolution cache, read by everything that acts on a link in that editor.
 */

import type { Editor } from "@tiptap/core";

import type { LinkAnswerCache } from "./link-resolution";
import type { LinkSurface } from "./link-surface";

export const LINK_SURFACE_NAME = "meridianLinkSurface";

export type LinkSurfaceStorage = { surface: LinkSurface; resolution: LinkAnswerCache };

declare module "@tiptap/core" {
  interface Storage {
    meridianLinkSurface: LinkSurfaceStorage;
  }
}

/** The link runtime for this editor, or null on one that never mounted it. */
export function getLinkSurface(editor: Editor | null | undefined): LinkSurface | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[LINK_SURFACE_NAME]?.surface ?? null;
}

/**
 * Where this editor's internal links point, or null on one that never mounted
 * the lane. Separate from the surface store because it answers a different
 * question: the surface knows which link the writer is working on, and this
 * knows what any of them addresses.
 */
export function getLinkAnswerCache(editor: Editor | null | undefined): LinkAnswerCache | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[LINK_SURFACE_NAME]?.resolution ?? null;
}

/**
 * The same cache for a view built while its editor is constructing, when
 * `isDestroyed` still reads true: a mark or node view must subscribe at
 * mount, or a picture already in the document never hears its answer.
 */
export function mountedLinkAnswerCache(editor: Editor): LinkAnswerCache | null {
  return editor.storage[LINK_SURFACE_NAME]?.resolution ?? null;
}
