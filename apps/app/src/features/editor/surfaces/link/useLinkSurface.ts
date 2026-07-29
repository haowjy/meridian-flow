/**
 * React's view of the link store.
 *
 * One `useSyncExternalStore` reading, so the hint, the menu, and the form can
 * never disagree about which link the writer is working on. A component that
 * held its own copy would drift the moment a keystroke opened the form from
 * somewhere else.
 */

import type { Editor } from "@tiptap/core";
import { useMemo, useSyncExternalStore } from "react";

import { getLinkSurface, type LinkSurface, type LinkSurfaceState } from "@/core/editor/links";

const NO_SURFACE: LinkSurfaceState = { hint: null, form: null, menu: null };
const NO_SUBSCRIPTION = () => () => {};

export function useLinkSurface(editor: Editor | null): LinkSurface | null {
  return useMemo(() => getLinkSurface(editor), [editor]);
}

export function useLinkSurfaceState(editor: Editor | null): LinkSurfaceState {
  const surface = useLinkSurface(editor);
  return useSyncExternalStore(
    surface ? surface.subscribe : NO_SUBSCRIPTION,
    () => surface?.state ?? NO_SURFACE,
    () => NO_SURFACE,
  );
}
