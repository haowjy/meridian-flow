/**
 * Where an editor keeps its link runtime: the surface store and the
 * resolution cache, read by everything that acts on a link in that editor.
 */

import type { Editor } from "@tiptap/core";

import type { LinkResolution } from "./link-resolution";
import type { LinkSurface } from "./link-surface";

export const LINK_SURFACE_NAME = "meridianLinkSurface";

export type LinkSurfaceStorage = { surface: LinkSurface; resolution: LinkResolution };

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
export function getLinkResolution(editor: Editor | null | undefined): LinkResolution | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[LINK_SURFACE_NAME]?.resolution ?? null;
}
