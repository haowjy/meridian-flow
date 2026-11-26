import type { Editor } from "@tiptap/core";
import { useMemo, useSyncExternalStore } from "react";

import { getLinkAnswerCache, type LinkKey, type LinkResolutionEntry } from "@/core/editor/links";

const NO_SUBSCRIPTION = () => () => {};
const NOTHING = () => null;

export function useLinkResolution(
  editor: Editor | null,
  link: LinkKey | null,
): LinkResolutionEntry | null {
  const resolution = useMemo(() => getLinkAnswerCache(editor), [editor]);
  const ref = link?.ref ?? null;
  const href = link?.href ?? null;
  return useSyncExternalStore(
    resolution?.subscribe ?? NO_SUBSCRIPTION,
    () => (resolution && href ? resolution.read({ ref, href }) : null),
    NOTHING,
  );
}
