/** One draft-only lifecycle across Editor membership and the dock slot. */
import { useMemo } from "react";
import type { DraftRef } from "@/client/query/draft-command-record";
import { type ContextTab, getContextTabs, useContextTabsStore } from "@/client/stores";
import { useContextRemovalCoordinator } from "@/features/project/context/account-feature-context";
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

export function useDraftOnlyLifecycle(projectId: string): DraftOnlyContainer {
  const removal = useContextRemovalCoordinator();
  return useMemo(() => {
    const editor: DraftOnlyContainer = {
      presentations: (project) =>
        getContextTabs(project).tabs.flatMap((tab) => {
          const value = presentation(project, tab, "editor");
          return value ? [value] : [];
        }),
      subscribe: (listener) => useContextTabsStore.subscribe(listener),
      promote: async (draft) => {
        const tab = getContextTabs(draft.projectId).tabs.find((tab) => matches(tab, draft));
        return tab?.kind === "tracked" ? removal.promoteAppliedDraft(draft.projectId, tab) : false;
      },
      remove: (draft) => {
        removal.discardDraft(draft.projectId, draft.workId, draft.documentId, draft.draftId);
      },
    };
    const dock: DraftOnlyContainer = {
      presentations: (project) => {
        const occupant = useDockDocumentStore.getState().occupant;
        const value =
          occupant?.projectId === project ? presentation(project, occupant.tab, "dock") : null;
        return value ? [value] : [];
      },
      subscribe: (listener) => useDockDocumentStore.subscribe(listener),
      promote: async (draft) => {
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
        // Exact occupant identity fences replacement instances. Settlement never claims.
        useDockDocumentStore.setState((state) =>
          state.occupant === occupant ? { occupant: { ...occupant, tab } } : state,
        );
        return true;
      },
      remove: (draft) => {
        const occupant = useDockDocumentStore.getState().occupant;
        if (!occupant || occupant.projectId !== draft.projectId || !matches(occupant.tab, draft))
          return;
        useDockDocumentStore.setState((state) =>
          state.occupant === occupant ? { occupant: null } : state,
        );
      },
    };
    const containers = [editor, dock];
    return {
      presentations: (project) =>
        containers.flatMap((container) => container.presentations(project)),
      subscribe: (listener) => {
        const unsubscribe = containers.map((container) => container.subscribe(listener));
        return () => {
          for (const stop of unsubscribe) stop();
        };
      },
      promote: async (draft) =>
        (await Promise.all(containers.map((c) => c.promote(draft)))).some(Boolean),
      remove: (draft) => {
        for (const container of containers) container.remove(draft);
      },
    };
  }, [removal, projectId]);
}
