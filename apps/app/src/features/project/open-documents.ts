/**
 * The open-document interface the v1 shell codes against (work/ux-overhaul/plan/open-document-interface.md).
 *
 * An adapter over today's tab store and routes: `tab`, `key`, `selected`, `review`, `outOfScope`,
 * `hasDraftInScope`, `select`, `open` and `close` are derived from them. `preview` and `view` live
 * only in `useAdapterState` below. PR 2a replaces the internals; the names stay.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { useWorkBranchDrafts } from "@/client/query/useWorkBranchDrafts";
import {
  type ContextTab,
  getContextTabs,
  isDraftOnly,
  isEditorContextTab,
  reviewEntriesOf,
  reviewEntryOf,
  useContextTabs,
} from "@/client/stores";
import { useContextRemovalCoordinator } from "@/features/project/context/account-feature-context";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { useContextRemovalProject } from "@/features/project/context/use-context-removal-project";
import { settleWriterClose } from "@/features/project/context/use-follow-open-document-placement";
import type { ReviewAddress } from "@/features/project/presented-document";
import { useOpenContextRoute } from "@/features/project/routing/ProjectNavigationContext";
import { openDocumentInEditor } from "@/features/project/routing/use-open-document-in-editor";

/** Which version of the document a tab paints. Per tab; a Work switch keeps it. */
export type TabView = {
  version: "draft" | "live";
  showChanges: boolean;
};

export type OpenDocumentTab = {
  key: string;
  tab: ContextTab;
  preview: boolean;
  review: ReviewAddress | null;
  outOfScope: { workId: string } | null;
  hasDraftInScope: boolean;
  view: TabView;
};

export type OpenTarget =
  | { kind: "document"; documentId: string; review?: ReviewAddress }
  | { kind: "tab"; tab: ContextTab; review?: ReviewAddress };

const DEFAULT_VIEW: TabView = { version: "draft", showChanges: true };

/** Adapter-only state: no counterpart in today's store, lost on reload. */
const useAdapterState = create<{
  /** The one preview tab per project, by document id (the key is unknown until the tab installs). */
  previewDocumentByProject: Record<string, string | undefined>;
  viewByKey: Record<string, TabView>;
}>(() => ({ previewDocumentByProject: {}, viewByKey: {} }));

function tabKey(tab: ContextTab): string {
  return tab.tabInstanceId ?? tab.documentId;
}

export function useOpenDocuments(projectId: string): {
  tabs: readonly OpenDocumentTab[];
  selected: OpenDocumentTab | null;
} {
  const slice = useContextTabs(projectId);
  const { activeWorkId } = useContextRemovalProject(projectId);
  const drafts = useWorkBranchDrafts(projectId, activeWorkId);
  const previewDocumentId = useAdapterState((s) => s.previewDocumentByProject[projectId]);
  const viewByKey = useAdapterState((s) => s.viewByKey);

  return useMemo(() => {
    const tabs = slice.tabs.filter(isEditorContextTab).map((tab): OpenDocumentTab => {
      const key = tabKey(tab);
      const entry = activeWorkId ? reviewEntryOf(tab, activeWorkId) : undefined;
      const heldBy = Object.keys(reviewEntriesOf(tab))[0];
      // Another Work's scratch, or a draft-only tab none of whose entries is the scoped Work's.
      const ownerWorkId = tab.kind === "new" ? undefined : tab.workId;
      const foreign =
        isDraftOnly(tab) && !entry
          ? heldBy
          : ownerWorkId && ownerWorkId !== activeWorkId
            ? ownerWorkId
            : undefined;
      return {
        key,
        tab,
        preview: tab.documentId === previewDocumentId,
        review: entry && activeWorkId ? { workId: activeWorkId, itemKey: entry.itemKey } : null,
        outOfScope: foreign ? { workId: foreign } : null,
        hasDraftInScope: drafts.fileForDocument(tab.documentId)?.draft.hasDraft === true,
        view: viewByKey[key] ?? DEFAULT_VIEW,
      };
    });
    const selectedDocumentId = activeWorkId ? slice.selectedTabIdByWork[activeWorkId] : undefined;
    return {
      tabs,
      selected: tabs.find((t) => t.tab.documentId === selectedDocumentId) ?? null,
    };
  }, [slice, activeWorkId, drafts.fileForDocument, previewDocumentId, viewByKey]);
}

export function useOpenDocumentActions(projectId: string): {
  select(key: string): void;
  open(target: OpenTarget): void;
  openPreview(target: OpenTarget): void;
  keep(key: string): void;
  close(key: string): void;
  setView(key: string, view: Partial<TabView>): void;
} {
  const openRoute = useOpenContextRoute();
  const openDocument = useOpenProjectDocument(projectId);
  const coordinator = useContextRemovalCoordinator();
  const { activeWorkId } = useContextRemovalProject(projectId);

  return useMemo(() => {
    const findTab = (key: string) => getContextTabs(projectId).tabs.find((t) => tabKey(t) === key);

    const close = (key: string) => {
      const tab = findTab(key);
      if (!tab) return;
      settleWriterClose(coordinator.writerClose(projectId, tab));
    };

    /** The strip's click path (`handleSelectTab`), aimed at the Work the tab belongs to. */
    const openStored = async (tab: ContextTab, review?: ReviewAddress | null) => {
      if (!openRoute) return;
      const entries = reviewEntriesOf(tab);
      const reviewWorkId =
        activeWorkId && entries[activeWorkId] ? activeWorkId : Object.keys(entries)[0];
      const reviewed =
        review ??
        (reviewWorkId ? { workId: reviewWorkId, itemKey: entries[reviewWorkId].itemKey } : null);
      if (tab.kind === "new" || tab.rootThreadId || reviewed) {
        await openDocumentInEditor(openRoute, tab, { review: reviewed });
        return;
      }
      const workId = tab.workId ?? activeWorkId ?? undefined;
      await openRoute(
        { scheme: tab.scheme, path: tab.path, workId, documentId: tab.documentId },
        { tab },
      );
    };

    const open = async (target: OpenTarget): Promise<ContextTab | undefined> => {
      const documentId = target.kind === "document" ? target.documentId : target.tab.documentId;
      const existing = getContextTabs(projectId).tabs.find((t) => t.documentId === documentId);
      const stored = existing ?? (target.kind === "tab" ? target.tab : undefined);
      if (target.kind === "tab" && !existing) {
        if (openRoute) await openDocumentInEditor(openRoute, target.tab, { review: target.review });
      } else if (stored) {
        await openStored(stored, target.review);
      } else {
        await openDocument({ documentId, workId: activeWorkId ?? undefined });
      }
      return getContextTabs(projectId).tabs.find((t) => t.documentId === documentId);
    };

    const setPreview = (documentId: string | undefined) =>
      useAdapterState.setState((s) => ({
        previewDocumentByProject: { ...s.previewDocumentByProject, [projectId]: documentId },
      }));

    return {
      select: (key) => {
        const tab = findTab(key);
        if (tab) void openStored(tab);
      },
      open: (target) => {
        void open(target);
      },
      // A normal tab that replaces the previous preview tab; a document already open stays as it is.
      openPreview: (target) => {
        const documentId = target.kind === "document" ? target.documentId : target.tab.documentId;
        const previous = useAdapterState.getState().previewDocumentByProject[projectId];
        const alreadyOpen = getContextTabs(projectId).tabs.some((t) => t.documentId === documentId);
        void open(target).then((tab) => {
          if (!tab) return;
          if (alreadyOpen && previous !== documentId) return;
          setPreview(documentId);
          const stale =
            previous && previous !== documentId
              ? getContextTabs(projectId).tabs.find((t) => t.documentId === previous)
              : undefined;
          if (stale) close(tabKey(stale));
        });
      },
      keep: (key) => {
        const tab = findTab(key);
        if (
          tab &&
          useAdapterState.getState().previewDocumentByProject[projectId] === tab.documentId
        )
          setPreview(undefined);
      },
      close: (key) => {
        const tab = findTab(key);
        if (
          tab &&
          useAdapterState.getState().previewDocumentByProject[projectId] === tab.documentId
        )
          setPreview(undefined);
        close(key);
      },
      setView: (key, view) =>
        useAdapterState.setState((s) => ({
          viewByKey: { ...s.viewByKey, [key]: { ...(s.viewByKey[key] ?? DEFAULT_VIEW), ...view } },
        })),
    };
  }, [projectId, openRoute, openDocument, coordinator, activeWorkId]);
}
