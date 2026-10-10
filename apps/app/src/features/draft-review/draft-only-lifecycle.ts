/** One draft-only lifecycle across Editor membership and the dock slot. */
import { useMemo } from "react";
import type { DraftRef } from "@/client/query/draft-command-record";
import { type ContextTab, getContextTabs, useContextTabsStore } from "@/client/stores";
import {
  useContextRemovalCoordinator,
  useOptionalAccountEpochSignal,
} from "@/features/project/context/account-feature-context";
import { useDockDocumentStore } from "@/features/project/dock/dock-document-store";

export type DraftOnlyPresentation = DraftRef & { container: "editor" | "dock"; token: string };
export interface DraftOnlyContainer {
  presentations(projectId: string): readonly DraftOnlyPresentation[];
  subscribe(listener: () => void): () => void;
  promote(draft: DraftRef): Promise<boolean>;
  remove(draft: DraftRef): void;
}

function presentation(projectId: string, tab: ContextTab, container: "editor" | "dock") {
  return tab.kind === "tracked" &&
    tab.draftOnly &&
    tab.reviewWorkId &&
    tab.reviewDraftId &&
    tab.tabInstanceToken
    ? {
        projectId,
        documentId: tab.documentId,
        workId: tab.reviewWorkId,
        draftId: tab.reviewDraftId,
        token: tab.tabInstanceToken,
        container,
      }
    : null;
}
function matches(tab: ContextTab, draft: DraftRef) {
  return (
    tab.kind === "tracked" &&
    tab.draftOnly &&
    tab.documentId === draft.documentId &&
    tab.reviewWorkId === draft.workId &&
    tab.reviewDraftId === draft.draftId &&
    Boolean(tab.tabInstanceToken)
  );
}

/** Exact occupant identity fences replacement instances; settlement never claims. */
function settleDock(draft: DraftRef, promote: boolean): boolean {
  const occupant = useDockDocumentStore.getState().occupant;
  if (!occupant || occupant.projectId !== draft.projectId || !matches(occupant.tab, draft))
    return false;
  const {
    draftOnly: _,
    reviewWorkId: __,
    reviewDraftId: ___,
    tabInstanceToken: ____,
    ...tab
  } = occupant.tab as Extract<ContextTab, { kind: "tracked" }>;
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
        const editor = getContextTabs(project).tabs.flatMap((tab) => {
          const value = presentation(project, tab, "editor");
          return value ? [value] : [];
        });
        const occupant = useDockDocumentStore.getState().occupant;
        const dock =
          occupant?.projectId === project ? presentation(project, occupant.tab, "dock") : null;
        return dock ? [...editor, dock] : editor;
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
        const tab = getContextTabs(draft.projectId).tabs.find((tab) => matches(tab, draft));
        const editor =
          tab?.kind === "tracked"
            ? removal.promoteAppliedDraft(draft.projectId, tab)
            : Promise.resolve(false);
        const dock = settleDock(draft, true);
        return (await editor) || dock;
      },
      remove: (draft) => {
        if (epoch?.aborted) return;
        removal.discardDraft(draft.projectId, draft.workId, draft.documentId, draft.draftId);
        settleDock(draft, false);
      },
    }),
    [removal, epoch, projectId],
  );
}
