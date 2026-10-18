/** One draft-only lifecycle across Editor membership and the dock slot. */

import { useMemo } from "react";
import type { DraftRef } from "@/client/query/branch-command-record";
import {
  type ContextTab,
  getContextTabs,
  isDraftOnly,
  matchesReviewItem,
  useContextTabsStore,
} from "@/client/stores";
import {
  useContextRemovalCoordinator,
  useOptionalAccountEpochSignal,
} from "@/features/project/context/account-feature-context";
import { useDockDocumentStore } from "@/features/project/dock/dock-document-store";
import type { ContextUri } from "@/lib/context-uri";

export type DraftOnlyPresentation = DraftRef & {
  container: "editor" | "dock";
  token: string;
  contextLocation: Pick<ContextUri, "scheme" | "path">;
};
export interface DraftOnlyContainer {
  presentations(projectId: string): readonly DraftOnlyPresentation[];
  subscribe(listener: () => void): () => void;
  /** Document-wide: every Work's entry clears, and each container keeps the review it showed. */
  promote(draft: DraftRef): Promise<boolean>;
  remove(draft: DraftRef): void;
}

function presentations(projectId: string, tab: ContextTab, container: "editor" | "dock") {
  if (tab.kind !== "tracked") return [];
  return Object.entries(tab.reviews ?? {}).map(([workId, entry]) => ({
    projectId,
    documentId: tab.documentId,
    workId,
    itemKey: entry.itemKey,
    token: entry.tabInstanceToken,
    container,
    contextLocation: { scheme: tab.scheme, path: tab.path },
  }));
}

/**
 * The dock holds one review (its admission kept a single entry). Discard is that
 * review's address alone; becoming live is document-wide and keeps the dock's
 * chosen review. Exact occupant identity fences replacement instances.
 */
function settleDock(draft: DraftRef, promote: boolean): boolean {
  const occupant = useDockDocumentStore.getState().occupant;
  if (!occupant || occupant.projectId !== draft.projectId || occupant.tab.kind !== "tracked")
    return false;
  const holds = promote
    ? isDraftOnly(occupant.tab) && occupant.tab.documentId === draft.documentId
    : matchesReviewItem(occupant.tab, { reviewWorkId: draft.workId, reviewItemKey: draft.itemKey });
  if (!holds) return false;
  const { reviews: _, ...tab } = occupant.tab;
  useDockDocumentStore.setState((state) =>
    state.occupant === occupant ? { occupant: promote ? { ...occupant, tab } : null } : state,
  );
  return true;
}

export function useDraftOnlyLifecycle(projectId: string): DraftOnlyContainer {
  const epoch = useOptionalAccountEpochSignal();
  const removal = useContextRemovalCoordinator();
  return useMemo(
    () => ({
      presentations: (project) => {
        if (epoch?.aborted) return [];
        const editor = getContextTabs(project).tabs.flatMap((tab) =>
          presentations(project, tab, "editor"),
        );
        const occupant = useDockDocumentStore.getState().occupant;
        const dock =
          occupant?.projectId === project ? presentations(project, occupant.tab, "dock") : [];
        return [...editor, ...dock];
      },
      subscribe: (listener) => {
        const stopEditor = useContextTabsStore.subscribe(listener);
        const stopDock = useDockDocumentStore.subscribe(listener);
        return () => {
          stopEditor();
          stopDock();
        };
      },
      promote: async (draft) => {
        if (epoch?.aborted) return false;
        // The document becomes live once, whichever Work's draft supplied the evidence.
        const tab = getContextTabs(draft.projectId).tabs.find(
          (tab) => tab.documentId === draft.documentId && isDraftOnly(tab),
        );
        const editor =
          tab?.kind === "tracked"
            ? removal.promoteAppliedDraft(draft.projectId, tab)
            : Promise.resolve(false);
        const dock = settleDock(draft, true);
        return (await editor) || dock;
      },
      remove: (draft) => {
        if (epoch?.aborted) return;
        removal.discardDraft(draft.projectId, draft.workId, draft.itemKey);
        settleDock(draft, false);
      },
    }),
    [removal, epoch, projectId],
  );
}
