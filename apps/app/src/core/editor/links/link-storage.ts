/**
 * Where an editor keeps its link runtime: the surface store, the resolution
 * cache, and the one requester every rendered link and picture asks through,
 * read by everything that acts on a link in that editor.
 */

import type { Editor } from "@tiptap/core";

import type { LinkRequester } from "./link-requester";
import type { LinkAnswerCache } from "./link-resolution";
import type { LinkSurface } from "./link-surface";

export const LINK_SURFACE_NAME = "meridianLinkSurface";

/** What a link or picture view needs: the answers, and the asker for its key. */
export type MountedLinks = { resolution: LinkAnswerCache; requester: LinkRequester };

export type LinkSurfaceStorage = MountedLinks & { surface: LinkSurface };

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
 * The cache and requester for a view built while its editor is constructing,
 * when `isDestroyed` still reads true: a mark or node view must watch its key
 * at mount, or a link already in the document is never asked about.
 */
export function mountedLinks(editor: Editor): MountedLinks | null {
  const storage = editor.storage[LINK_SURFACE_NAME];
  return storage ? { resolution: storage.resolution, requester: storage.requester } : null;
}
