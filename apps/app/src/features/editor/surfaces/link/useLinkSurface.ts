import type { Editor } from "@tiptap/core";
import { useMemo, useSyncExternalStore } from "react";

import { getLinkSurface, type LinkSurface, type LinkSurfaceState } from "@/core/editor/links";

const NO_SURFACE: LinkSurfaceState = {
  hint: null,
  form: null,
  menu: null,
  folder: null,
  follow: null,
};
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
