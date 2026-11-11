import { type RefObject, useEffect, useRef } from "react";

import { announce } from "@/client/stores";

import type { ComposerHandle } from "@/components/app/composer";

/**
 * Announce thread navigation and, when {@link focus}, focus the composer when
 * {@link threadId} changes. The side's chat follows main without the writer
 * choosing it, so it doesn't take focus. A later title change on the same thread (a rename, a generated
 * title) is not navigation: it must not pull focus from wherever the writer is,
 * such as a reopened rename field.
 */
export function useThreadNavigationAnnounce(
  threadId: string,
  pageTitle: string,
  composerRef: RefObject<ComposerHandle | null>,
  focus: boolean,
): void {
  const title = useRef(pageTitle);
  title.current = pageTitle;
  useEffect(() => {
    announce(title.current);
    if (focus) composerRef.current?.focus();
  }, [threadId, composerRef, focus]);
}
