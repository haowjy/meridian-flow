/**
 * The open-document interface the v1 shell codes against (work/ux-overhaul/plan/open-document-interface.md).
 *
 * The tab store is the one owner of the open document: the tabs, one selection per project, and
 * each tab's view and review pin. This file reads them, resolves what a tab paints
 * (`showing`, `review`) from the tab, the Work scope and the scope's draft list, and offers the
 * commands. The route no longer decides what is shown: an address arriving is an open or select
 * command, and in Write the URL follows the selection.
 */
import { draftOwnerKey, type ThreadDraftListItem } from "@meridian/contracts/branches";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { projectReadEnabled } from "@/client/creation/project-read-gate";
import { unwrapListQuery } from "@/client/query/list-query";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { cachedOwnerDrafts, ownerDraftsQueryOptions } from "@/client/query/useOwnerDrafts";
import {
  type ContextTab,
  DEFAULT_TAB_VIEW,
  getContextTabs,
  isDraftOnly,
  isEditorContextTab,
  reviewEntryOf,
  reviewOwnerOfTab,
  type TabView,
  tabKey,
  useContextTabs,
  useContextTabsStore,
  useSelectedContextTab,
} from "@/client/stores";
import { useContextRemovalCoordinator } from "@/features/project/context/account-feature-context";
import { useOpenChatDocument } from "@/features/project/context/open-chat-document";
import { useContextRemovalProject } from "@/features/project/context/use-context-removal-project";
import { settleWriterClose } from "@/features/project/context/use-follow-open-document-placement";
import type { ReviewAddress } from "@/features/project/presented-document";
import {
  useOpenContextRoute,
  useProjectScreen,
} from "@/features/project/routing/ProjectNavigationContext";
import { openDocumentInEditor } from "@/features/project/routing/use-open-document-in-editor";

export { type TabView, useSelectedDocumentId } from "@/client/stores";

export type OpenDocumentTab = {
  /** Stable: `tabInstanceId ?? documentId`. */
  key: string;
  tab: ContextTab;
  /** The review this tab paints, derived from its view, the scope's drafts and an optional pin. */
  review: ReviewAddress | null;
  /** What the tab paints once resolved. `pending` is a paint hold: never Live first. */
  showing: "pending" | "draft" | "live";
  view: TabView;
};

export type OpenTarget =
  | { kind: "document"; documentId: string; review?: ReviewAddress }
  | { kind: "tab"; tab: ContextTab; review?: ReviewAddress };

type DraftRows = {
  status: "loading" | "ready";
  rows: readonly ThreadDraftListItem[];
  /** The list could not be read: it says nothing about which drafts exist. */
  failed?: true;
};

const NO_ROWS: readonly ThreadDraftListItem[] = [];
const READY_EMPTY: DraftRows = { status: "ready", rows: NO_ROWS };
const FAILED_EMPTY: DraftRows = { status: "ready", rows: NO_ROWS, failed: true };

/** An owner's draft list as the tabs read it: raw rows, no catalog labelling. */
function useScopeDraftRows(projectId: string, ownerKey: string | null): DraftRows {
  const list = unwrapListQuery(
    useQuery({
      ...ownerDraftsQueryOptions(projectId, ownerKey ?? ""),
      select: (response) => response.items,
      enabled: projectReadEnabled(ownerKey !== null),
    }),
  );
  return useMemo(
    () =>
      ownerKey === null || list.status === "disabled"
        ? READY_EMPTY
        : list.status === "error"
          ? FAILED_EMPTY
          : list.data === null
            ? { status: "loading", rows: NO_ROWS }
            : { status: "ready", rows: list.data },
    [ownerKey, list.status, list.data],
  );
}

/** The lists of the other owners that tabs pin reviews to. */
function usePinnedDraftRows(
  projectId: string,
  ownerKeys: readonly string[],
): ReadonlyMap<string, DraftRows> {
  return useQueries({
    queries: ownerKeys.map((ownerKey) => ({
      ...ownerDraftsQueryOptions(projectId, ownerKey),
      enabled: projectReadEnabled(true),
    })),
    combine: (results) =>
      new Map(
        results.map((result, index): [string, DraftRows] => [
          ownerKeys[index] as string,
          result.data === undefined
            ? result.isError
              ? FAILED_EMPTY
              : { status: "loading", rows: NO_ROWS }
            : { status: "ready", rows: result.data.items },
        ]),
      ),
  });
}

type ResolveScope = {
  /** The Work in scope; null while unresolved. */
  workId: string | null;
  /** The owner whose drafts a tab paints by default: the scoped Work's. */
  ownerKey: string | null;
  drafts: DraftRows;
};

/**
 * What a tab paints (shell-data-flow §3.2). `pinned` holds the lists of the owners that pins name
 * besides the scope.
 */
export function resolveTab(
  tab: ContextTab,
  scope: ResolveScope,
  pinned: ReadonlyMap<string, DraftRows>,
): Pick<OpenDocumentTab, "review" | "showing" | "view"> {
  const view = tab.view ?? DEFAULT_TAB_VIEW;
  const scopeRow = scope.drafts.rows.find((row) => row.documentId === tab.documentId);
  const draftOnly = isDraftOnly(tab);
  const heldBy = draftOnly ? reviewOwnerOfTab(tab, scope.workId) : undefined;
  const ownEntry = scope.ownerKey ? reviewEntryOf(tab, scope.ownerKey) : undefined;
  const drafted = (review: ReviewAddress) => ({ view, review, showing: "draft" as const });

  const pin = tab.reviewPin;
  if (pin) {
    const list = pin.ownerKey === scope.ownerKey ? scope.drafts : pinned.get(pin.ownerKey);
    if (!list || list.status === "loading") return { view, review: null, showing: "pending" };
    if (list.rows.some((row) => row.itemKey === pin.itemKey)) return drafted(pin);
  }
  if (draftOnly) {
    const ownerKey = ownEntry ? scope.ownerKey : heldBy;
    const entry = ownerKey ? reviewEntryOf(tab, ownerKey) : undefined;
    return entry && ownerKey
      ? drafted({ ownerKey, itemKey: entry.itemKey })
      : { view, review: null, showing: "live" };
  }
  if (view.version === "draft" && scope.ownerKey) {
    if (scope.drafts.status === "loading") return { view, review: null, showing: "pending" };
    if (scopeRow) return drafted({ ownerKey: scope.ownerKey, itemKey: scopeRow.itemKey });
  }
  return { view, review: null, showing: "live" };
}

function useResolveScope(projectId: string): ResolveScope {
  const { activeWorkId } = useContextRemovalProject(projectId);
  const ownerKey = activeWorkId ? draftOwnerKey({ kind: "work", workId: activeWorkId }) : null;
  const drafts = useScopeDraftRows(projectId, ownerKey);
  return useMemo(
    () => ({ workId: activeWorkId, ownerKey, drafts }),
    [activeWorkId, ownerKey, drafts],
  );
}

function pinOwnerKeys(tabs: readonly ContextTab[], scopeOwnerKey: string | null): string[] {
  return [
    ...new Set(
      tabs.flatMap((tab) => {
        const ownerKey = tab.reviewPin?.ownerKey;
        return ownerKey && ownerKey !== scopeOwnerKey ? [ownerKey] : [];
      }),
    ),
  ];
}

function openDocumentTab(
  tab: ContextTab,
  scope: ResolveScope,
  pinned: ReadonlyMap<string, DraftRows>,
): OpenDocumentTab {
  return {
    key: tabKey(tab),
    tab,
    ...resolveTab(tab, scope, pinned),
  };
}

export function useOpenDocuments(projectId: string): {
  tabs: readonly OpenDocumentTab[];
  selected: OpenDocumentTab | null;
} {
  const slice = useContextTabs(projectId);
  const scope = useResolveScope(projectId);
  const pinned = usePinnedDraftRows(projectId, pinOwnerKeys(slice.tabs, scope.ownerKey));
  // A pin names a draft. A cached list lacking the item may only be stale (the draft was made a
  // moment ago), so the pin goes only once a fresh read of the owner's list also lacks it: the
  // draft has ended (Applied, Discarded, or gone in another tab). A failed read clears nothing.
  // The address sync then drops `item=`. The effect keys on the pins that look missing, so its
  // own fetch cannot re-trigger it.
  const queryClient = useQueryClient();
  const missingPins = slice.tabs.flatMap(({ reviewPin: pin }) => {
    if (!pin) return [];
    const list = pin.ownerKey === scope.ownerKey ? scope.drafts : pinned.get(pin.ownerKey);
    return list?.status === "ready" &&
      !list.failed &&
      !list.rows.some((r) => r.itemKey === pin.itemKey)
      ? [JSON.stringify([pin.ownerKey, pin.itemKey])]
      : [];
  });
  const missingKey = [...new Set(missingPins)].join();
  useEffect(() => {
    for (const key of new Set(missingPins)) {
      const [ownerKey, itemKey] = JSON.parse(key) as [string, string];
      const queryKey = projectQueryKeys.ownerDrafts(projectId, ownerKey);
      void queryClient.refetchQueries({ queryKey }).then(() => {
        // A failed refetch keeps the old rows and sets status "error": it proves nothing.
        if (queryClient.getQueryState(queryKey)?.status !== "success") return;
        if (
          !cachedOwnerDrafts(queryClient, projectId, ownerKey)?.some((r) => r.itemKey === itemKey)
        )
          useContextTabsStore.getState().clearReviewPins(projectId, { ownerKey, itemKey });
      });
    }
  }, [projectId, queryClient, missingKey]);
  return useMemo(() => {
    const tabs = slice.tabs
      .filter(isEditorContextTab)
      .map((tab) => openDocumentTab(tab, scope, pinned));
    return { tabs, selected: tabs.find((t) => t.key === slice.selectedTabKey) ?? null };
  }, [slice, scope, pinned]);
}

/** The selected tab only: the document surface re-renders for its tab, not for the strip. */
export function useSelectedOpenDocument(projectId: string): OpenDocumentTab | null {
  const tab = useSelectedContextTab(projectId);
  const scope = useResolveScope(projectId);
  const pinned = usePinnedDraftRows(projectId, tab ? pinOwnerKeys([tab], scope.ownerKey) : []);
  return useMemo(() => (tab ? openDocumentTab(tab, scope, pinned) : null), [tab, scope, pinned]);
}

export function useOpenDocumentActions(projectId: string): {
  select(key: string): void;
  open(target: OpenTarget): void;
  close(key: string): void;
  setView(key: string, view: Partial<TabView>): void;
} {
  const screen = useProjectScreen();
  const openRoute = useOpenContextRoute();
  const openChatDocument = useOpenChatDocument(projectId);
  const coordinator = useContextRemovalCoordinator();
  const { activeWorkId } = useContextRemovalProject(projectId);

  const writing = screen === "context";

  const reviewOf = (tab: ContextTab, review?: ReviewAddress | null): ReviewAddress | null => {
    if (review) return review;
    if (tab.reviewPin) return tab.reviewPin;
    const ownerKey = reviewOwnerOfTab(tab, activeWorkId);
    const entry = ownerKey ? reviewEntryOf(tab, ownerKey) : undefined;
    return ownerKey && entry ? { ownerKey, itemKey: entry.itemKey } : null;
  };

  /** Write: one route command installs the tab, selects it and writes the URL. */
  const openInWrite = useCallback(
    async (tab: ContextTab, review: ReviewAddress | null) => {
      if (!openRoute) return;
      if (tab.kind === "new" || tab.rootThreadId || review) {
        await openDocumentInEditor(openRoute, tab, { review });
        return;
      }
      await openRoute(
        {
          scheme: tab.scheme,
          path: tab.path,
          workId: tab.workId ?? activeWorkId ?? undefined,
          documentId: tab.documentId,
        },
        { tab },
      );
    },
    [openRoute, activeWorkId],
  );

  return useMemo(() => {
    const store = () => useContextTabsStore.getState();
    const findTab = (key: string) => getContextTabs(projectId).tabs.find((t) => tabKey(t) === key);
    const findByDocument = (documentId: string) =>
      getContextTabs(projectId).tabs.find((t) => t.documentId === documentId);

    const close = (key: string) => {
      const tab = findTab(key);
      if (tab) settleWriterClose(coordinator.writerClose(projectId, tab));
    };

    /** The pin an explicit review address sets, once the tab exists. */
    const pinReview = (documentId: string, review: ReviewAddress | undefined) => {
      const tab = findByDocument(documentId);
      if (tab && review)
        store().setTabState(projectId, tabKey(tab), {
          reviewPin: review,
          view: { version: "draft" },
        });
    };

    const open = async (target: OpenTarget): Promise<ContextTab | undefined> => {
      const documentId = target.kind === "document" ? target.documentId : target.tab.documentId;
      const existing = findByDocument(documentId);
      const stored = existing ?? (target.kind === "tab" ? target.tab : undefined);
      if (writing) {
        if (stored) await openInWrite(stored, reviewOf(stored, target.review));
        else await openChatDocument({ documentId, workId: activeWorkId ?? undefined });
      } else if (existing) {
        await store().selectTab(projectId, documentId, existing);
      } else if (stored) {
        store().openTab(projectId, stored, undefined, undefined, { select: true });
      } else {
        // Beside the chat: the door's placement commits the tab into the store and selects it.
        await openChatDocument({ documentId, workId: activeWorkId ?? undefined });
      }
      pinReview(documentId, target.review);
      return findByDocument(documentId);
    };

    return {
      select: (key) => {
        const tab = findTab(key);
        if (!tab) return;
        if (writing) void openInWrite(tab, reviewOf(tab));
        else void store().selectTab(projectId, tab.documentId, tab);
      },
      open: (target) => void open(target),
      close,
      setView: (key, view) => store().setTabState(projectId, key, { view }),
    };
  }, [projectId, coordinator, writing, openInWrite, openChatDocument, activeWorkId]);
}
