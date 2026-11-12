import { type RefObject, useEffect, useRef } from "react";

import { announce } from "@/client/stores";

import type { ComposerHandle } from "@/components/app/composer";
import { usePanePlace } from "@/features/project/pane-place";

/**
 * Announce thread navigation and focus main's composer when {@link threadId} changes. The side's
 * chat follows main without the writer choosing it, so it doesn't take focus. Neither a later title
 * change (a rename, a generated title) nor the chat moving between main and the side is
 * navigation: neither must pull focus from wherever the writer is, such as a reopened rename field.
 */
export function useThreadNavigationAnnounce(
  threadId: string,
  pageTitle: string,
  composerRef: RefObject<ComposerHandle | null>,
): void {
  const title = useRef(pageTitle);
  title.current = pageTitle;
  const main = useRef(false);
  main.current = usePanePlace() === "main";
  useEffect(() => {
    announce(title.current);
    if (main.current) composerRef.current?.focus();
  }, [threadId, composerRef]);
}
