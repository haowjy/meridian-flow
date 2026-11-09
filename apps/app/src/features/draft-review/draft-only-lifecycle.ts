/** One draft-only lifecycle across the open tabs. */

import { useMemo } from "react";
import {
  type ContextTab,
  getContextTabs,
  isDraftOnly,
  useContextTabsStore,
} from "@/client/stores";
import {
  useContextRemovalCoordinator,
  useOptionalAccountEpochSignal,
  useOptionalRemovedNotices,
} from "@/features/project/context/account-feature-context";
import type { ContextUri } from "@/lib/context-uri";
import type { DraftRef } from "./review-command-types";

export type DraftOnlyPresentation = DraftRef & {
  container: "editor";
  /** A created document the draft alone holds; Discard removes it. */
  draftOnly: boolean;
  token: string;
  contextLocation: Pick<ContextUri, "scheme" | "path">;
};
export interface DraftOnlyContainer {
  presentations(projectId: string): readonly DraftOnlyPresentation[];
  subscribe(listener: () => void): () => void;
  /** Document-wide: every Work's entry clears, and each container keeps the review it showed. */
  promote(draft: DraftRef): Promise<boolean>;
  /**
   * Closes the discarded review wherever it shows. A created document's
   * container reports it to its removed-documents notice, which stays silent
   * for this tab's own Discard.
   */
  remove(draft: DraftRef): void;
}

function presentations(projectId: string, tab: ContextTab, container: "editor") {
  if (tab.kind !== "tracked") return [];
  return Object.entries(tab.reviews ?? {}).map(([workId, entry]) => ({
    projectId,
    documentId: tab.documentId,
    workId,
    itemKey: entry.itemKey,
    draftOnly: isDraftOnly(tab),
    token: entry.tabInstanceToken,
    container,
    contextLocation: { scheme: tab.scheme, path: tab.path },
  }));
}

export function useDraftOnlyLifecycle(projectId: string): DraftOnlyContainer {
  const epoch = useOptionalAccountEpochSignal();
  const removal = useContextRemovalCoordinator();
  const notices = useOptionalRemovedNotices();
  return useMemo(
    () => ({
      presentations: (project) => {
        if (epoch?.aborted) return [];
        return getContextTabs(project).tabs.flatMap((tab) => presentations(project, tab, "editor"));
      },
      subscribe: (listener) => useContextTabsStore.subscribe(listener),
      promote: async (draft) => {
        if (epoch?.aborted) return false;
        // The document becomes live once, whichever Work's draft supplied the evidence.
        const tab = getContextTabs(draft.projectId).tabs.find(
          (tab) => tab.documentId === draft.documentId && isDraftOnly(tab),
        );
        return tab?.kind === "tracked"
          ? await removal.promoteAppliedDraft(draft.projectId, tab)
          : false;
      },
      remove: (draft) => {
        if (epoch?.aborted) return;
        const editor = removal.discardDraft(draft.projectId, draft.workId, draft.itemKey);
        if (editor.kind !== "noop")
          notices?.presentedRemoved(draft.projectId, "editor", editor.removed);
      },
    }),
    [removal, notices, epoch, projectId],
  );
}
