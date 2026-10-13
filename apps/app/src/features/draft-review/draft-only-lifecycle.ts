/** One draft-only lifecycle across Editor membership and the dock slot. */

import { useMemo } from "react";
import type { DraftRef } from "@/client/query/draft-command-record";
import {
  type ContextTab,
  getContextTabs,
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
  promote(draft: DraftRef): Promise<boolean>;
  remove(draft: DraftRef): void;
}

function presentation(projectId: string, tab: ContextTab, container: "editor" | "dock") {
  return tab.kind === "tracked" &&
    tab.draftOnly &&
    tab.reviewWorkId &&
    tab.reviewItemKey &&
    tab.tabInstanceToken
    ? {
        projectId,
        documentId: tab.documentId,
        workId: tab.reviewWorkId,
        itemKey: tab.reviewItemKey,
        token: tab.tabInstanceToken,
        container,
        contextLocation: { scheme: tab.scheme, path: tab.path },
      }
    : null;
}
function matches(tab: ContextTab, draft: DraftRef) {
  return (
    tab.kind === "tracked" &&
    matchesReviewItem(tab, {
      reviewWorkId: draft.workId,
      reviewItemKey: draft.itemKey,
    }) &&
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
    reviewItemKey: ___,
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
        removal.discardDraft(draft.projectId, draft.workId, draft.itemKey);
        settleDock(draft, false);
      },
    }),
    [removal, epoch, projectId],
  );
}
