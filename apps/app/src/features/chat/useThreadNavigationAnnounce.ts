import { type RefObject, useEffect, useRef } from "react";

import { announce } from "@/client/stores";

import type { ComposerHandle } from "@/components/app/composer";

/**
 * Announce thread navigation and focus the composer when {@link threadId}
 * changes. A later title change on the same thread (a rename, a generated
 * title) is not navigation: it must not pull focus from wherever the writer is,
 * such as a reopened rename field.
 */
export function useThreadNavigationAnnounce(
  threadId: string,
  pageTitle: string,
  composerRef: RefObject<ComposerHandle | null>,
): void {
  const title = useRef(pageTitle);
  title.current = pageTitle;
  useEffect(() => {
    announce(title.current);
    composerRef.current?.focus();
  }, [threadId, composerRef]);
}
