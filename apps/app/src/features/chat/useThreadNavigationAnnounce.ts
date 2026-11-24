import { type RefObject, useEffect, useRef } from "react";

import { announce } from "@/client/stores";

import type { ComposerHandle } from "@/components/app/composer";
import { mainTabStripHasFocus, usePanePlace } from "@/features/project/pane-place";

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
    if (main.current && !mainTabStripHasFocus()) composerRef.current?.focus();
  }, [threadId, composerRef]);
}
