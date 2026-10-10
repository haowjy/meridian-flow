/** One project lifecycle owner settles remote dispositions for every Work with draft-only presentations. */
import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { DraftRef } from "@/client/query/draft-command-record";
import { draftCommandPendingIn, useDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { contextCatalogScope, projectCatalogView } from "@/client/query/useContextCatalog";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import { useOptionalAccountResourceReplica } from "@/features/project/context/account-feature-context";
import { type DraftOnlyContainer, useDraftOnlyLifecycle } from "./draft-only-lifecycle";

export function DraftOnlySettlement({ projectId }: { projectId: string }) {
  const lifecycle = useDraftOnlyLifecycle(projectId);
  // Primitive snapshot: a fresh presentation array is not an external-store change.
  useSyncExternalStore(
    lifecycle.subscribe,
    () => JSON.stringify(lifecycle.presentations(projectId)),
    () => "",
  );
  const presentations = lifecycle.presentations(projectId);
  const works = new Set(presentations.map((draft) => draft.workId));
  return [...works].map((workId) => (
    <WorkSettlement
      key={workId}
      projectId={projectId}
      workId={workId}
      lifecycle={lifecycle}
      membership={JSON.stringify(presentations.filter((draft) => draft.workId === workId))}
    />
  ));
}

function WorkSettlement({
  projectId,
  workId,
  lifecycle,
  membership,
}: {
  projectId: string;
  workId: string;
  lifecycle: DraftOnlyContainer;
  membership: string;
}) {
  const queryClient = useQueryClient();
  const resources = useOptionalAccountResourceReplica();
  const drafts = useWorkDrafts(projectId, workId);
  const records = useDraftCommandRecords();
  const disposing = draftCommandPendingIn(records, { projectId, workId });
  // A draft-only tab whose draft left the active list was disposed of
  // elsewhere. The list cannot say how, so the catalog decides: a document
  // that now exists was applied, otherwise the draft was discarded.
  useEffect(() => {
    if (!resources || !projectId || !workId || disposing) return;
    if (drafts.status !== "ready" && drafts.status !== "empty") return;
    const isOrphan = (draft: DraftRef, activeDrafts: readonly ThreadDraftListItem[]) =>
      draft.workId === workId && !activeDrafts.some((row) => row.draftId === draft.draftId);
    const activeDrafts = drafts.drafts ?? [];
    if (!lifecycle.presentations(projectId).some((draft) => isOrphan(draft, activeDrafts))) return;

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
        for (const draft of lifecycle.presentations(projectId)) {
          if (!isOrphan(draft, currentDrafts)) continue;
          if (catalog.findDocument(draft.documentId)) void lifecycle.promote(draft);
          else lifecycle.remove(draft);
        }
      })
      // A failed membership check must leave the tab intact rather than guess
      // that a remotely applied document was discarded.
      .catch(() => undefined);
    return () => attempt.abort();
  }, [
    lifecycle,
    disposing,
    membership,
    drafts.drafts,
    drafts.status,
    projectId,
    queryClient,
    resources,
    workId,
  ]);

  return null;
}
