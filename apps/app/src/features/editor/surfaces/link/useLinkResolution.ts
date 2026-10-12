/**
 * React's view of what an internal link points at.
 *
 * One reading per link (its ref and href), straight from the link lane's resolution store, so the
 * hint and the click can never disagree about whether a document exists. The
 * store is already the editor's cache; this adds no request of its own.
 */

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
