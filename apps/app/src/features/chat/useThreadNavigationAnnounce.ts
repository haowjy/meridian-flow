import { type RefObject, useEffect } from "react";

import { announce } from "@/client/stores";

import type { ComposerHandle } from "./Composer";

/** Announce thread navigation and focus the composer when {@link threadId} changes. */
export function useThreadNavigationAnnounce(
  threadId: string,
  pageTitle: string,
  composerRef: RefObject<ComposerHandle | null>,
): void {
  useEffect(() => {
    announce(pageTitle);
    composerRef.current?.focus();
  }, [threadId, pageTitle, composerRef]);
}
