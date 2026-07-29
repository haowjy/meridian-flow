/**
 * React's view of what an internal link points at.
 *
 * One reading per href, straight from the link lane's resolution store, so the
 * hint and the click can never disagree about whether a document exists. The
 * store is already the editor's cache; this adds no request of its own.
 */

import type { Editor } from "@tiptap/core";
import { useMemo, useSyncExternalStore } from "react";

import { getLinkResolution, type LinkResolutionEntry } from "@/core/editor/links";

const NO_SUBSCRIPTION = () => () => {};
const NOTHING = () => null;

export function useLinkResolution(
  editor: Editor | null,
  href: string | null,
): LinkResolutionEntry | null {
  const resolution = useMemo(() => getLinkResolution(editor), [editor]);
  return useSyncExternalStore(
    resolution?.subscribe ?? NO_SUBSCRIPTION,
    () => (resolution && href ? resolution.read(href) : null),
    NOTHING,
  );
}
