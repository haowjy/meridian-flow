import type { Editor } from "@tiptap/core";

import type { LinkRequester } from "./link-requester";
import type { LinkAnswerCache } from "./link-resolution";
import type { LinkSurface } from "./link-surface";

export const LINK_SURFACE_NAME = "meridianLinkSurface";

export type MountedLinks = { resolution: LinkAnswerCache; requester: LinkRequester };

export type LinkSurfaceStorage = MountedLinks & { surface: LinkSurface };

declare module "@tiptap/core" {
  interface Storage {
    meridianLinkSurface: LinkSurfaceStorage;
  }
}

export function getLinkSurface(editor: Editor | null | undefined): LinkSurface | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[LINK_SURFACE_NAME]?.surface ?? null;
}

export function getLinkAnswerCache(editor: Editor | null | undefined): LinkAnswerCache | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[LINK_SURFACE_NAME]?.resolution ?? null;
}

export function mountedLinks(editor: Editor): MountedLinks | null {
  const storage = editor.storage[LINK_SURFACE_NAME];
  return storage ? { resolution: storage.resolution, requester: storage.requester } : null;
}
