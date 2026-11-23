/** useDraftReviewController — one host's Apply and Discard on its draft, for every review surface. */

import type { Work } from "@meridian/contracts/works";
import { useMemo } from "react";
import type { CommandOutcome } from "./draft-command-owner";
import { type CommandStart, usePressCommands, type WorkDraftCommands } from "./usePressCommands";

/** A document of a draft, as a press names it. */
export type DraftItemRef = { documentId: string; itemKey: string };

export type DraftReviewController = {
  projectId: string;
  draftId: string;
  /** Focused thread owning this review surface; threads Apply/Discard cache invalidation. */
  threadId: string | null;
  commandChange: WorkDraftCommands["commandChange"];
  /**
   * Every Apply and Discard control disables on this: there is no owner to press on, or no
   * command driver yet. Clicks during another change's command are accepted and queued.
   */
  dispositionLocked: boolean;
  startItem: (mode: "apply" | "discard", item: DraftItemRef) => CommandStart;
  /** One change of a document, named by any of its members. */
  startChange: (mode: "apply" | "discard", item: DraftItemRef, change: string) => CommandStart;
  apply: (documentId: string, itemKey: string) => Promise<CommandOutcome>;
  discard: (documentId: string, itemKey: string) => Promise<CommandOutcome>;
};

export function useDraftReviewController({
  projectId,
  work,
  draftId,
  threadId = null,
}: {
  projectId: string;
  /** The Work the draft belongs to, if any. */
  work: Work | null;
  /** The draft this surface reviews; "" scopes nothing. */
  draftId: string;
  threadId?: string | null;
}): DraftReviewController {
  const commands = usePressCommands({ projectId, work, draftId, threadId, surface: "band" });
  const { commandChange, dispositionLocked, startItem, startChange, apply, discard } = commands;
  return useMemo(
    () => ({
      projectId,
      draftId,
      threadId,
      commandChange,
      dispositionLocked,
      startItem,
      startChange,
      apply,
      discard,
    }),
    [
      projectId,
      draftId,
      threadId,
      commandChange,
      dispositionLocked,
      startItem,
      startChange,
      apply,
      discard,
    ],
  );
}
