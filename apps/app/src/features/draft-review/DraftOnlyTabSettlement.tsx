/** One project lifecycle owner settles remote dispositions for every Work with draft-only tabs. */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { draftCommandPendingIn, useDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { contextCatalogScope, projectCatalogView } from "@/client/query/useContextCatalog";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import { type ContextTab, getContextTabs, useContextTabs } from "@/client/stores";
import {
  useContextRemovalCoordinator,
  useOptionalAccountResourceReplica,
} from "@/features/project/context/account-feature-context";

export function DraftOnlyTabSettlement({ projectId }: { projectId: string }) {
  const tabs = useContextTabs(projectId).tabs;
  const works = new Map<string, ContextTab[]>();
  for (const tab of tabs) {
    if (tab.kind !== "tracked" || !tab.draftOnly || !tab.reviewWorkId) continue;
    const owned = works.get(tab.reviewWorkId) ?? [];
    owned.push(tab);
    works.set(tab.reviewWorkId, owned);
  }
  return [...works].map(([workId, ownedTabs]) => (
    <WorkSettlement key={workId} projectId={projectId} workId={workId} ownedTabs={ownedTabs} />
  ));
}

function WorkSettlement({
  projectId,
  workId,
  ownedTabs,
}: {
  projectId: string;
  workId: string;
  ownedTabs: readonly ContextTab[];
}) {
  const queryClient = useQueryClient();
  const resources = useOptionalAccountResourceReplica();
  const contextRemoval = useContextRemovalCoordinator();
  const drafts = useWorkDrafts(projectId, workId);
  const records = useDraftCommandRecords();
  const disposing = draftCommandPendingIn(records, { projectId, workId });
  // A draft-only tab whose draft left the active list was disposed of
  // elsewhere. The list cannot say how, so the catalog decides: a document
  // that now exists was applied, otherwise the draft was discarded.
  useEffect(() => {
    if (!resources || !projectId || !workId || disposing) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    const isOrphan = (tab: ContextTab, activeDrafts: readonly ThreadDraftListItem[]) =>
      tab.kind === "tracked" &&
      tab.draftOnly &&
      tab.reviewWorkId === workId &&
      !activeDrafts.some((draft) => draft.draftId === tab.reviewDraftId);
    const activeDrafts = drafts.drafts ?? [];
    if (!getContextTabs(projectId).tabs.some((tab) => isOrphan(tab, activeDrafts))) return;

    const scope = contextCatalogScope(projectId, "manuscript", { workId: null }) ?? {
      kind: "project" as const,
      projectId,
    };
    const attempt = new AbortController();
    // A catalog observation that starts now: joining an older in-flight one
    // could report the pre-Apply tree and misread a remote Apply as a Discard.
    void resources
      .acquireCatalogAfter(projectId, scope)
      .then((view) => {
        if (attempt.signal.aborted) return;
        queryClient.setQueryData(projectQueryKeys.contextCatalog(projectId, scope), view);
        const catalog = projectCatalogView(projectId, "manuscript", view);
        const currentDrafts =
          queryClient.getQueryData<ThreadDraftListItem[]>(
            projectQueryKeys.workDrafts(projectId, workId),
          ) ?? [];
        for (const tab of getContextTabs(projectId).tabs) {
          if (tab.kind !== "tracked" || !isOrphan(tab, currentDrafts)) continue;
          if (catalog.findDocument(tab.documentId)) {
            void contextRemoval.promoteAppliedDraft(projectId, tab);
            continue;
          }
          const draftId = tab.reviewDraftId;
          if (!draftId) continue;
          contextRemoval.discardDraft(projectId, workId, tab.documentId, draftId);
        }
      })
      // A failed membership check must leave the tab intact rather than guess
      // that a remotely applied document was discarded.
      .catch(() => undefined);
    return () => attempt.abort();
  }, [
    contextRemoval,
    disposing,
    ownedTabs,
    drafts.drafts,
    drafts.status,
    projectId,
    queryClient,
    resources,
    workId,
  ]);

  return null;
}
